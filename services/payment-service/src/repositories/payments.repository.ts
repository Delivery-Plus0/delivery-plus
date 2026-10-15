import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PaymentStatus } from '@food-delivery/shared';
import { ACTIVE_PAYMENT_STATUSES, Payment } from '../entities/payment.entity';
import { REFUND_PROVIDER_SIMULATED, Refund } from '../entities/refund.entity';

export type CreatePaymentData = Pick<Payment, 'orderId' | 'customerId' | 'amount'> & {
  idempotencyKey?: string | null;
};

@Injectable()
export class PaymentsRepository {
  constructor(
    @InjectRepository(Payment)
    private readonly repo: Repository<Payment>,
  ) {}

  findById(id: string): Promise<Payment | null> {
    return this.repo.findOne({ where: { id } });
  }

  /** Returns the most recent payment attempt for an order, if any. */
  findLatestByOrder(orderId: string): Promise<Payment | null> {
    return this.repo.findOne({ where: { orderId }, order: { createdAt: 'DESC' } });
  }

  /** Returns the order's active (PENDING/PROCESSING/COMPLETED) payment, if any. */
  findActiveByOrder(orderId: string): Promise<Payment | null> {
    return this.repo.findOne({
      where: { orderId, status: In([...ACTIVE_PAYMENT_STATUSES]) },
    });
  }

  findByIdempotencyKey(customerId: string, idempotencyKey: string): Promise<Payment | null> {
    return this.repo.findOne({ where: { customerId, idempotencyKey } });
  }

  /**
   * Inserts a new payment. Throws a unique-violation error (Postgres 23505) when
   * the order already has an active payment or the customer's idempotency key
   * was already used; callers must handle that — see `isUniqueViolation`.
   */
  create(data: CreatePaymentData): Promise<Payment> {
    return this.repo.save(this.repo.create(data));
  }

  /**
   * Atomic compare-and-set status change: only updates the row while it is
   * still in `from`. Returns true when this caller performed the transition,
   * false when another request changed the status first.
   */
  async transition(
    id: string,
    from: PaymentStatus,
    to: PaymentStatus,
    failureReason?: string,
  ): Promise<boolean> {
    const changes: Partial<Payment> = { status: to };
    if (failureReason !== undefined) changes.failureReason = failureReason;
    const result = await this.repo.update({ id, status: from }, changes);
    return (result.affected ?? 0) === 1;
  }

  /**
   * #18: claims a PENDING payment for processing (PENDING → PROCESSING), stamping the claim time
   * (database clock) and the claimant's token. True only for the one caller that made the change.
   */
  async claimProcessing(id: string, token: string): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Payment)
      .set({ status: PaymentStatus.PROCESSING, processingClaimedAt: () => 'now()', processingToken: token })
      .where('id = :id AND status = :pending', { id, pending: PaymentStatus.PENDING })
      .execute();
    return (result.affected ?? 0) === 1;
  }

  /**
   * #18: takes over a PROCESSING claim that is older than `timeoutMs` (or has no claim time: claimed
   * before it was recorded). Atomic, so of many concurrent takeovers exactly one wins; the previous
   * holder's token stops being able to settle.
   */
  async reclaimExpiredProcessing(id: string, token: string, timeoutMs: number): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Payment)
      .set({ processingClaimedAt: () => 'now()', processingToken: token })
      .where('id = :id AND status = :processing', { id, processing: PaymentStatus.PROCESSING })
      .andWhere(`("processingClaimedAt" IS NULL OR "processingClaimedAt" < now() - (:timeoutMs * interval '1 millisecond'))`, { timeoutMs })
      .execute();
    return (result.affected ?? 0) === 1;
  }

  /**
   * #18: settles a PROCESSING payment, but only for the current claim holder (fencing): a request
   * whose claim was taken over writes nothing. Clears the claim token.
   */
  async settleProcessing(id: string, token: string, to: PaymentStatus, failureReason?: string): Promise<boolean> {
    const changes: Partial<Payment> = { status: to, processingToken: null };
    if (failureReason !== undefined) changes.failureReason = failureReason;
    const result = await this.repo.update({ id, status: PaymentStatus.PROCESSING, processingToken: token }, changes);
    return (result.affected ?? 0) === 1;
  }

  /** #18: PROCESSING payments whose claim is older than `olderThanMs` (or unrecorded), oldest first. */
  findAbandonedProcessing(olderThanMs: number, limit: number): Promise<Payment[]> {
    return this.repo
      .createQueryBuilder('p')
      .where('p.status = :processing', { processing: PaymentStatus.PROCESSING })
      .andWhere(`(p."processingClaimedAt" IS NULL OR p."processingClaimedAt" < now() - (:olderThanMs * interval '1 millisecond'))`, { olderThanMs })
      .orderBy('p."processingClaimedAt"', 'ASC', 'NULLS FIRST')
      .limit(limit)
      .getMany();
  }

  /**
   * Atomically takes the side-effects lease if it is free or expired. Uses the
   * database clock so app-server clock skew cannot produce two holders.
   */
  async acquireSideEffectsLease(id: string, ttlMs: number): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Payment)
      .set({ sideEffectsLeaseUntil: () => `now() + (:ttlMs * interval '1 millisecond')` })
      .where('id = :id', { id })
      .andWhere('("sideEffectsLeaseUntil" IS NULL OR "sideEffectsLeaseUntil" < now())')
      .setParameters({ ttlMs })
      .execute();
    return (result.affected ?? 0) === 1;
  }

  async releaseSideEffectsLease(id: string): Promise<void> {
    await this.repo.update({ id }, { sideEffectsLeaseUntil: null });
  }

  async markEventPublished(id: string, status: PaymentStatus): Promise<void> {
    await this.repo.update({ id }, { publishedEventStatus: status });
  }

  async markOrderSynced(id: string, status: PaymentStatus): Promise<void> {
    await this.repo.update({ id }, { orderSyncedStatus: status });
  }

  /** The order's payment that collected money (COMPLETED) or already gave it back (REFUNDED), if any. */
  findCollectedByOrder(orderId: string): Promise<Payment | null> {
    return this.repo.findOne({
      where: { orderId, status: In([PaymentStatus.COMPLETED, PaymentStatus.REFUNDED]) },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Refunds the whole payment once (#56): locks the payment row, then writes the refund record and
   * moves the payment COMPLETED → REFUNDED in one transaction. Concurrent or repeated calls queue on
   * the lock and find REFUNDED ('already'); a payment that never completed is 'not-refundable'.
   */
  async refundOnce(id: string, details: RefundDetails): Promise<RefundOutcome> {
    return this.repo.manager.transaction(async (manager) => {
      const payment = await manager
        .getRepository(Payment)
        .createQueryBuilder('p')
        .setLock('pessimistic_write')
        .where('p.id = :id', { id })
        .getOne();
      if (!payment) return 'missing';
      if (payment.status === PaymentStatus.REFUNDED) return 'already';
      if (payment.status !== PaymentStatus.COMPLETED) return 'not-refundable';

      const refunds = manager.getRepository(Refund);
      await refunds.save(
        refunds.create({
          paymentId: payment.id,
          orderId: payment.orderId,
          customerId: payment.customerId,
          amount: payment.amount,
          currency: 'EGP',
          provider: REFUND_PROVIDER_SIMULATED,
          ...details,
        }),
      );
      await manager.getRepository(Payment).update({ id, status: PaymentStatus.COMPLETED }, { status: PaymentStatus.REFUNDED });
      return 'refunded';
    });
  }

  findRefundByPayment(paymentId: string): Promise<Refund | null> {
    return this.repo.manager.getRepository(Refund).findOne({ where: { paymentId } });
  }

  /**
   * Settled payments whose event or order update is still owed and that nobody is working on: the
   * request that owed them failed or crashed. Oldest first; `idleMs` keeps clear of requests in flight.
   */
  findWithOwedSideEffects(idleMs: number, limit: number): Promise<Payment[]> {
    return this.repo
      .createQueryBuilder('p')
      .where('p.status IN (:...settled)', {
        settled: [PaymentStatus.COMPLETED, PaymentStatus.FAILED, PaymentStatus.REFUNDED],
      })
      .andWhere(
        '(p."publishedEventStatus" IS DISTINCT FROM p.status::text OR p."orderSyncedStatus" IS DISTINCT FROM p.status::text)',
      )
      .andWhere('(p."sideEffectsLeaseUntil" IS NULL OR p."sideEffectsLeaseUntil" < now())')
      .andWhere(`p."updatedAt" < now() - (:idleMs * interval '1 millisecond')`, { idleMs })
      .orderBy('p."updatedAt"', 'ASC')
      .limit(limit)
      .getMany();
  }
}

/** The audit fields of a refund; the amount, currency and provider come from the payment. */
export type RefundDetails = Pick<Refund, 'initiatedBy' | 'requestedBy' | 'reason' | 'source'>;

export type RefundOutcome = 'refunded' | 'already' | 'not-refundable' | 'missing';

const PG_UNIQUE_VIOLATION = '23505';

/** Detects a Postgres unique-constraint violation, optionally for a specific constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; constraint?: string; driverError?: { code?: string; constraint?: string } };
  const code = e.driverError?.code ?? e.code;
  if (code !== PG_UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  return (e.driverError?.constraint ?? e.constraint) === constraint;
}
