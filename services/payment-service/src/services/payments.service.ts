import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  OrderStatus,
  PAYMENT_TRANSITIONS,
  PaymentStatus,
  UserRole,
  isTransitionAllowed,
  KafkaProducerService,
  TOPICS,
  PaymentEventType,
  PaymentEvent,
  generateCorrelationId,
} from '@food-delivery/shared';
import { PaymentsRepository, isUniqueViolation } from '../repositories/payments.repository';
import { OrderServiceClient } from '../common/order-service.client';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { ProcessPaymentDto } from '../dto/process-payment.dto';
import { ACTIVE_PAYMENT_STATUSES, Payment, UQ_PAYMENTS_ACTIVE_ORDER } from '../entities/payment.entity';
import { v5 as uuidv5 } from 'uuid';

/**
 * Fixed namespace for deterministic payment event ids. Never change it: consumers
 * deduplicate by eventId, and a new namespace would make re-published events look new.
 */
export const PAYMENT_EVENT_NAMESPACE = '6f1c2b9e-6a4d-4f3e-9d7a-2f0b8c1e5a47';

/**
 * Side effects owed for each payment status. A status with no entry (PROCESSING,
 * REFUNDED) has no Kafka event or order update.
 */
/** Orders in these states no longer react to a payment outcome. */
const TERMINAL_ORDER_STATUSES: OrderStatus[] = [OrderStatus.FAILED, OrderStatus.CANCELLED, OrderStatus.DELIVERED];

const SIDE_EFFECTS: Partial<Record<PaymentStatus, { eventType: PaymentEventType; orderStatus: OrderStatus }>> = {
  [PaymentStatus.PENDING]: { eventType: PaymentEventType.CREATED, orderStatus: OrderStatus.PAYMENT_PENDING },
  [PaymentStatus.COMPLETED]: { eventType: PaymentEventType.COMPLETED, orderStatus: OrderStatus.CONFIRMED },
  [PaymentStatus.FAILED]: { eventType: PaymentEventType.FAILED, orderStatus: OrderStatus.FAILED },
};

/** How long a request may hold the side-effects lease before another retry can take over. */
export const SIDE_EFFECTS_LEASE_MS = 30_000;

/** What to do when side effects are owed but another request holds the lease. */
type OnBusy = 'return' | 'conflict';

/** Deterministic eventId: the same (payment, event type) always yields the same id. */
export function paymentEventId(paymentId: string, eventType: PaymentEventType): string {
  return uuidv5(`${paymentId}:${eventType}`, PAYMENT_EVENT_NAMESPACE);
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly payments: PaymentsRepository,
    private readonly orderClient: OrderServiceClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  /**
   * Creates the order's payment.
   *
   * - One active payment per order is enforced by the database
   *   (`UQ_payments_active_order`), so concurrent requests cannot both succeed.
   * - With an `Idempotency-Key`, repeating the request returns the original
   *   payment (and finishes any side effects a previous attempt left undone)
   *   instead of failing.
   */
  async createPayment(
    customerId: string,
    dto: CreatePaymentDto,
    authHeader: string,
    idempotencyKey?: string,
  ): Promise<Payment> {
    // Replay check first: after the first attempt the order is PAYMENT_PENDING,
    // so the order-status check below would reject a legitimate retry.
    if (idempotencyKey) {
      const prior = await this.payments.findByIdempotencyKey(customerId, idempotencyKey);
      if (prior) return this.replayCreate(prior, dto);
    }

    const order = await this.orderClient.getOrder(dto.orderId, authHeader);

    if (order.customerId !== customerId) {
      throw new ForbiddenError('You do not own this order');
    }
    if (order.status !== OrderStatus.CREATED) {
      throw new ConflictError(`Order ${dto.orderId} is not awaiting payment (status ${order.status})`);
    }

    // Fast path for a clear error. Not a guarantee: the unique index below is.
    const existing = await this.payments.findLatestByOrder(dto.orderId);
    if (existing && ACTIVE_PAYMENT_STATUSES.includes(existing.status)) {
      throw new ConflictError(`Order ${dto.orderId} already has an active payment`);
    }

    let payment: Payment;
    try {
      payment = await this.payments.create({
        orderId: dto.orderId,
        customerId,
        amount: order.totalAmount,
        idempotencyKey: idempotencyKey ?? null,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost a race. If it was a concurrent retry with the same key, return the winner.
      if (idempotencyKey) {
        const winner = await this.payments.findByIdempotencyKey(customerId, idempotencyKey);
        if (winner) return this.replayCreate(winner, dto);
      }
      if (isUniqueViolation(err, UQ_PAYMENTS_ACTIVE_ORDER) || !idempotencyKey) {
        throw new ConflictError(`Order ${dto.orderId} already has an active payment`);
      }
      throw new ConflictError('Idempotency-Key conflict, please retry');
    }

    return this.completeSideEffects(payment);
  }

  /**
   * Processes a payment. Safe to retry after a client timeout:
   * - PENDING → moves to PROCESSING via an atomic compare-and-set, so only one
   *   concurrent request settles the payment.
   * - PROCESSING → another request is settling it; 409 Conflict.
   * - COMPLETED / FAILED → returns the terminal result; only side effects that
   *   previously failed (Kafka publish, order update) are re-attempted.
   */
  async processPayment(paymentId: string, requesterId: string, dto: ProcessPaymentDto): Promise<Payment> {
    const payment = await this.findOrThrow(paymentId);

    if (payment.customerId !== requesterId) {
      throw new ForbiddenError('You do not own this payment');
    }

    if (this.isSettled(payment.status)) {
      return this.completeSideEffects(payment);
    }
    if (payment.status === PaymentStatus.PROCESSING) {
      throw new ConflictError(`Payment ${paymentId} is already being processed`);
    }

    this.assertTransition(payment.status, PaymentStatus.PROCESSING);

    // The order must be PAYMENT_PENDING before it can move to CONFIRMED/FAILED.
    // If creation's side effects failed earlier, finish them now; if another
    // request is finishing them, ask the client to retry rather than race it.
    const ready = await this.completeSideEffects(payment, 'conflict');
    if (this.hasOwedSideEffects(ready)) {
      throw new ConflictError(`Payment ${paymentId} is being finalized, please retry`);
    }

    const claimed = await this.payments.transition(paymentId, PaymentStatus.PENDING, PaymentStatus.PROCESSING);
    if (!claimed) {
      const current = await this.findOrThrow(paymentId);
      if (this.isSettled(current.status)) return this.completeSideEffects(current);
      if (current.status === PaymentStatus.PROCESSING) {
        throw new ConflictError(`Payment ${paymentId} is already being processed`);
      }
      throw new InvalidStateTransitionError('Payment', current.status, PaymentStatus.PROCESSING);
    }

    const succeeded = this.simulateOutcome(dto.simulateFailure);
    const target = succeeded ? PaymentStatus.COMPLETED : PaymentStatus.FAILED;
    this.assertTransition(PaymentStatus.PROCESSING, target);

    const settled = await this.payments.transition(
      paymentId,
      PaymentStatus.PROCESSING,
      target,
      succeeded ? undefined : 'Simulated payment decline',
    );
    if (!settled) {
      // Only the request that claimed PROCESSING may settle; anything else is a bug.
      const current = await this.findOrThrow(paymentId);
      throw new InvalidStateTransitionError('Payment', current.status, target);
    }

    return this.completeSideEffects(await this.findOrThrow(paymentId));
  }

  async getStatus(paymentId: string, requesterId: string, requesterRole: UserRole): Promise<Payment> {
    const payment = await this.findOrThrow(paymentId);
    if (requesterRole !== UserRole.ADMIN && payment.customerId !== requesterId) {
      throw new ForbiddenError('You do not have access to this payment');
    }
    return payment;
  }

  /**
   * Refunds are a support/admin action. Customers used to be able to refund their own COMPLETED
   * payment at any time, even after delivery, with no order-state policy. A customer-facing refund
   * needs such a policy (e.g. only for orders cancelled before preparation) before it is reopened.
   */
  async refund(paymentId: string, requesterId: string, requesterRole: UserRole): Promise<Payment> {
    if (requesterRole !== UserRole.ADMIN) {
      throw new ForbiddenError('Refunds can only be issued by support');
    }
    const payment = await this.findOrThrow(paymentId);

    this.assertTransition(payment.status, PaymentStatus.REFUNDED);
    const refunded = await this.payments.transition(paymentId, payment.status, PaymentStatus.REFUNDED);
    const current = await this.findOrThrow(paymentId);
    if (!refunded && current.status !== PaymentStatus.REFUNDED) {
      throw new InvalidStateTransitionError('Payment', current.status, PaymentStatus.REFUNDED);
    }
    return current;
  }

  /** Validates that a replayed idempotency key is being reused for the same order. */
  private replayCreate(prior: Payment, dto: CreatePaymentDto): Promise<Payment> {
    if (prior.orderId !== dto.orderId) {
      throw new ConflictError('Idempotency-Key was already used for a different order');
    }
    return this.completeSideEffects(prior);
  }

  /**
   * Performs the Kafka publish and order update owed for the payment's current
   * status, each at most once per status (tracked by `publishedEventStatus` /
   * `orderSyncedStatus`), under a short lease so concurrent retries don't both
   * perform them. If a step fails the error propagates, the payment keeps its
   * state, and the next retry resumes from the step that failed.
   *
   * When another request holds the lease: `onBusy: 'return'` returns the payment
   * as-is (its status is already final); `'conflict'` throws a retryable 409.
   */
  private async completeSideEffects(payment: Payment, onBusy: OnBusy = 'return'): Promise<Payment> {
    if (!this.hasOwedSideEffects(payment)) return payment;

    const leased = await this.payments.acquireSideEffectsLease(payment.id, SIDE_EFFECTS_LEASE_MS);
    if (!leased) {
      if (onBusy === 'conflict') {
        throw new ConflictError(`Payment ${payment.id} is being finalized, please retry`);
      }
      return payment;
    }

    try {
      // Re-read under the lease: a previous holder may have finished some steps.
      const current = await this.findOrThrow(payment.id);
      const effects = SIDE_EFFECTS[current.status];
      if (!effects) return current;

      if (current.publishedEventStatus !== current.status) {
        const event: PaymentEvent = {
          eventId: paymentEventId(current.id, effects.eventType),
          eventType: effects.eventType,
          timestamp: new Date().toISOString(),
          correlationId: generateCorrelationId(),
          payload: {
            paymentId: current.id,
            orderId: current.orderId,
            amount: parseFloat(current.amount),
            status: current.status,
          },
        };
        await this.kafkaProducer.publish(TOPICS.PAYMENT_EVENTS, event);
        await this.payments.markEventPublished(current.id, current.status);
      }

      if (current.orderSyncedStatus !== current.status) {
        await this.syncOrder(current, effects.orderStatus);
        await this.payments.markOrderSynced(current.id, current.status);
      }
    } finally {
      await this.payments.releaseSideEffectsLease(payment.id);
    }

    return this.findOrThrow(payment.id);
  }

  /**
   * Moves the order to the status this payment implies. order-service's payment.failed consumer
   * converges the order to the same FAILED status, and a same-status update is a no-op there, so
   * the two writers never disagree. The one legitimate conflict left: the customer cancelled the
   * order while the payment was still pending, then the payment was declined. The order is already
   * closed, so there is nothing to sync. A COMPLETED payment on a closed order is still an error:
   * that money needs a refund, and silently marking it synced would hide it.
   */
  private async syncOrder(payment: Payment, orderStatus: OrderStatus): Promise<void> {
    try {
      await this.orderClient.updateOrderStatus(payment.orderId, orderStatus);
    } catch (err) {
      if (!(err instanceof ConflictError) || payment.status !== PaymentStatus.FAILED) throw err;
      const order = await this.orderClient.getOrderAsSystem(payment.orderId);
      if (!TERMINAL_ORDER_STATUSES.includes(order.status)) throw err;
      this.logger.warn(
        `Payment ${payment.id} failed after order ${payment.orderId} was already ${order.status}; nothing to sync`,
      );
    }
  }

  private hasOwedSideEffects(payment: Payment): boolean {
    if (!SIDE_EFFECTS[payment.status]) return false;
    return payment.publishedEventStatus !== payment.status || payment.orderSyncedStatus !== payment.status;
  }

  private isSettled(status: PaymentStatus): boolean {
    return status === PaymentStatus.COMPLETED || status === PaymentStatus.FAILED;
  }

  private assertTransition(from: PaymentStatus, to: PaymentStatus): void {
    if (!isTransitionAllowed(PAYMENT_TRANSITIONS, from, to)) {
      throw new InvalidStateTransitionError('Payment', from, to);
    }
  }

  private simulateOutcome(forceFailure?: boolean): boolean {
    if (forceFailure === true) return false;
    if (forceFailure === false) return true;
    return Math.random() < this.config.paymentSuccessRate;
  }

  private async findOrThrow(id: string): Promise<Payment> {
    const payment = await this.payments.findById(id);
    if (!payment) {
      throw new NotFoundError(`Payment ${id} not found`);
    }
    return payment;
  }
}
