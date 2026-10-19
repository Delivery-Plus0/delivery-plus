/**
 * Integration tests for the payment persistence layer against a real PostgreSQL.
 *
 * The race protection lives in database constraints (partial unique indexes) and
 * atomic UPDATE ... WHERE statements, which a mocked repository cannot prove.
 *
 * Opt-in: set PAYMENT_TEST_DATABASE_URL to a DISPOSABLE database (the schema is
 * dropped and recreated). Without it the suite is skipped so `npm test` works
 * without Postgres. Example with the docker-compose stack:
 *
 *   docker compose exec postgres psql -U postgres -c 'CREATE DATABASE payment_service_test'
 *   PAYMENT_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/payment_service_test \
 *     npm test -w services/payment-service
 */
import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Column, CreateDateColumn, DataSource, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { PaymentStatus, STRICT_WHERE_VALUES } from '@food-delivery/shared';
import { Payment, UQ_PAYMENTS_ACTIVE_ORDER, UQ_PAYMENTS_CUSTOMER_IDEMPOTENCY_KEY } from '../entities/payment.entity';
import { PaymentsRepository, isUniqueViolation } from './payments.repository';
import { Refund, RefundInitiator } from '../entities/refund.entity';
import { PaymentProcessingClaim1700000000003 } from '../database/migrations/004-processing-claim';
import { PaymentSideEffectsLeaseToken1700000000004 } from '../database/migrations/005-side-effects-lease-token';
import { randomUUID } from 'crypto';

const DATABASE_URL = process.env.PAYMENT_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const MIGRATION_SQL = join(__dirname, '..', '..', 'migrations', '20260917_payment_idempotency.sql');

/** The payments table exactly as it existed before issue #10 (used to test the migration). */
@Entity('payments')
class LegacyPayment {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column() orderId!: string;
  @Index() @Column() customerId!: string;
  @Column('decimal', { precision: 10, scale: 2 }) amount!: string;
  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING }) status!: PaymentStatus;
  @Column({ nullable: true }) failureReason?: string;
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

/** The same strict where-value rule as every service's DataSource (F8, #204). */
function dataSource(entities: Array<new () => object>, synchronize: boolean): DataSource {
  return new DataSource({
    type: 'postgres',
    url: DATABASE_URL,
    entities,
    synchronize,
    dropSchema: synchronize,
    poolSize: 10,
    invalidWhereValuesBehavior: STRICT_WHERE_VALUES,
  });
}

describeDb('PaymentsRepository (PostgreSQL integration)', () => {
  jest.setTimeout(30_000);

  let ds: DataSource;
  let repo: PaymentsRepository;
  let seq = 0;
  const newOrderId = () => `order-${Date.now()}-${++seq}`;

  beforeAll(async () => {
    ds = await dataSource([Payment, Refund], true).initialize();
    repo = new PaymentsRepository(ds.getRepository(Payment));
  });

  afterAll(async () => {
    await ds?.destroy();
  });

  beforeEach(async () => {
    await ds.query('TRUNCATE refunds, payments');
  });

  it('schema is stable: synchronize (dev) leaves no pending changes', async () => {
    const pending = await ds.driver.createSchemaBuilder().log();
    expect(pending.upQueries).toEqual([]);
  });

  describe('one active payment per order', () => {
    it('concurrent inserts for the same order: exactly one succeeds, the rest hit UQ_payments_active_order', async () => {
      const orderId = newOrderId();

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => repo.create({ orderId, customerId: 'c1', amount: '10.00' })),
      );

      const ok = results.filter((r) => r.status === 'fulfilled');
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(failed).toHaveLength(9);
      for (const f of failed) expect(isUniqueViolation(f.reason, UQ_PAYMENTS_ACTIVE_ORDER)).toBe(true);
      expect(await ds.getRepository(Payment).count({ where: { orderId } })).toBe(1);
    });

    it.each([PaymentStatus.PROCESSING, PaymentStatus.COMPLETED])(
      'blocks a second payment while the first is %s',
      async (status) => {
        const orderId = newOrderId();
        const first = await repo.create({ orderId, customerId: 'c1', amount: '10.00' });
        await ds.getRepository(Payment).update({ id: first.id }, { status });

        const err = await repo.create({ orderId, customerId: 'c1', amount: '10.00' }).catch((e: unknown) => e);
        expect(isUniqueViolation(err, UQ_PAYMENTS_ACTIVE_ORDER)).toBe(true);
      },
    );

    it.each([PaymentStatus.FAILED, PaymentStatus.REFUNDED])(
      'allows a new payment once the previous one is %s',
      async (status) => {
        const orderId = newOrderId();
        const first = await repo.create({ orderId, customerId: 'c1', amount: '10.00' });
        await ds.getRepository(Payment).update({ id: first.id }, { status });

        const second = await repo.create({ orderId, customerId: 'c1', amount: '10.00' });
        expect(second.id).not.toBe(first.id);
        expect((await repo.findActiveByOrder(orderId))?.id).toBe(second.id);
      },
    );
  });

  describe('idempotency key', () => {
    it('concurrent inserts with the same key: one row, others hit a unique violation', async () => {
      const orderId = newOrderId();
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => repo.create({ orderId, customerId: 'c1', amount: '10.00', idempotencyKey: 'k1' })),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await repo.findByIdempotencyKey('c1', 'k1'))?.orderId).toBe(orderId);
    });

    it('rejects the same key for the same customer even on another order', async () => {
      await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00', idempotencyKey: 'k1' });
      const err = await repo
        .create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00', idempotencyKey: 'k1' })
        .catch((e: unknown) => e);
      expect(isUniqueViolation(err, UQ_PAYMENTS_CUSTOMER_IDEMPOTENCY_KEY)).toBe(true);
    });

    it('scopes keys per customer and allows many payments without a key', async () => {
      await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00', idempotencyKey: 'k1' });
      await repo.create({ orderId: newOrderId(), customerId: 'c2', amount: '10.00', idempotencyKey: 'k1' });
      await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });
      await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });
      expect(await ds.getRepository(Payment).count()).toBe(4);
    });
  });

  describe('compare-and-set transitions', () => {
    it('only one of many concurrent PENDING → PROCESSING claims wins', async () => {
      const p = await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });

      const claims = await Promise.all(
        Array.from({ length: 10 }, () => repo.transition(p.id, PaymentStatus.PENDING, PaymentStatus.PROCESSING)),
      );

      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await repo.findById(p.id))?.status).toBe(PaymentStatus.PROCESSING);
    });

    it('does not change a row that is no longer in the expected state', async () => {
      const p = await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });
      await repo.transition(p.id, PaymentStatus.PENDING, PaymentStatus.PROCESSING);
      await repo.transition(p.id, PaymentStatus.PROCESSING, PaymentStatus.COMPLETED);

      expect(await repo.transition(p.id, PaymentStatus.PROCESSING, PaymentStatus.FAILED, 'late')).toBe(false);
      const stored = await repo.findById(p.id);
      expect(stored?.status).toBe(PaymentStatus.COMPLETED);
      expect(stored?.failureReason).toBeNull();
    });
  });

  describe('side-effects lease', () => {
    it('only one of many concurrent acquirers gets the lease', async () => {
      const p = await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });
      const got = await Promise.all(Array.from({ length: 10 }, () => repo.acquireSideEffectsLease(p.id, 30_000)));
      expect(got.filter(Boolean)).toHaveLength(1);
    });

    it('can be re-acquired after release or expiry, each time with a new token', async () => {
      const p = await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });
      const first = await repo.acquireSideEffectsLease(p.id, 30_000);
      expect(first).toEqual(expect.any(String));
      expect(await repo.acquireSideEffectsLease(p.id, 30_000)).toBeNull();
      expect(await repo.releaseSideEffectsLease(p.id, first!)).toBe(true);
      const second = await repo.acquireSideEffectsLease(p.id, 1);
      await new Promise((r) => setTimeout(r, 20));
      const third = await repo.acquireSideEffectsLease(p.id, 30_000);
      expect(new Set([first, second, third]).size).toBe(3);
    });

    it('records published / synced status markers for the lease holder', async () => {
      const p = await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });
      const token = (await repo.acquireSideEffectsLease(p.id, 30_000))!;
      expect(await repo.markEventPublished(p.id, PaymentStatus.PENDING, token)).toBe(true);
      expect(await repo.markOrderSynced(p.id, PaymentStatus.PENDING, token)).toBe(true);
      const stored = await repo.findById(p.id);
      expect(stored?.publishedEventStatus).toBe(PaymentStatus.PENDING);
      expect(stored?.orderSyncedStatus).toBe(PaymentStatus.PENDING);
    });

    it('#19: a holder whose lease expired and was taken over can neither write the markers nor release the new lease', async () => {
      const p = await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });
      const stale = (await repo.acquireSideEffectsLease(p.id, 1))!;
      await new Promise((r) => setTimeout(r, 20));
      const current = (await repo.acquireSideEffectsLease(p.id, 30_000))!;

      expect(await repo.markEventPublished(p.id, PaymentStatus.PENDING, stale)).toBe(false);
      expect(await repo.markOrderSynced(p.id, PaymentStatus.PENDING, stale)).toBe(false);
      expect(await repo.releaseSideEffectsLease(p.id, stale)).toBe(false);

      const stored = await repo.findById(p.id);
      expect(stored).toMatchObject({ publishedEventStatus: null, orderSyncedStatus: null, sideEffectsLeaseToken: current });
      expect(stored?.sideEffectsLeaseUntil).not.toBeNull();
      expect(await repo.acquireSideEffectsLease(p.id, 30_000)).toBeNull(); // still held by the current holder
    });
  });

  describe('processing claims (#18)', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('a claim records when and by whom; a fresh claim cannot be taken over', async () => {
      const p = await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });

      expect(await repo.claimProcessing(p.id, randomUUID())).toBe(true);
      const claimed = await repo.findById(p.id);
      expect(claimed?.status).toBe(PaymentStatus.PROCESSING);
      expect(claimed?.processingClaimedAt).toBeInstanceOf(Date);
      expect(await repo.reclaimExpiredProcessing(p.id, randomUUID(), 60_000)).toBe(false);
    });

    it('of many concurrent takeovers of an expired claim exactly one wins, and the old holder can no longer settle', async () => {
      const p = await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });
      const oldToken = randomUUID();
      await repo.claimProcessing(p.id, oldToken);
      await sleep(20);

      const tokens = Array.from({ length: 10 }, () => randomUUID());
      const won = await Promise.all(tokens.map((token) => repo.reclaimExpiredProcessing(p.id, token, 10)));
      expect(won.filter(Boolean)).toHaveLength(1);

      expect(await repo.settleProcessing(p.id, oldToken, PaymentStatus.COMPLETED)).toBe(false);
      const winner = tokens[won.indexOf(true)];
      expect(await repo.settleProcessing(p.id, winner, PaymentStatus.COMPLETED)).toBe(true);
      expect(await repo.findById(p.id)).toMatchObject({ status: PaymentStatus.COMPLETED, processingToken: null });
    });

    it('a row stuck before claims were recorded is reclaimable and listed as abandoned', async () => {
      const p = await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });
      await ds.query(`UPDATE payments SET status = 'PROCESSING' WHERE id = $1`, [p.id]);

      expect((await repo.findAbandonedProcessing(60_000, 10)).map((x) => x.id)).toContain(p.id);
      expect(await repo.reclaimExpiredProcessing(p.id, randomUUID(), 60_000)).toBe(true);
      expect((await repo.findAbandonedProcessing(60_000, 10)).map((x) => x.id)).not.toContain(p.id);
    });
  });

  describe('undefined where values (F8, #204)', () => {
    it('a lookup by an undefined id throws instead of returning an arbitrary payment', async () => {
      await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });
      // Without the rule TypeORM drops `id: undefined` and returns the first row: this one.
      expect(Number((await ds.query('SELECT count(*) AS n FROM payments'))[0].n)).toBe(1);

      await expect(repo.findById(undefined as unknown as string)).rejects.toThrow(/Undefined value/);
      await expect(repo.findByIdempotencyKey('c1', undefined as unknown as string)).rejects.toThrow(/Undefined value/);
    });

    it('an update with an undefined criterion throws and changes nothing', async () => {
      const p = await repo.create({ orderId: newOrderId(), customerId: 'c1', amount: '10.00' });

      await expect(repo.transition(undefined as unknown as string, PaymentStatus.PENDING, PaymentStatus.FAILED)).rejects.toThrow(/Undefined value/);

      expect((await repo.findById(p.id))?.status).toBe(PaymentStatus.PENDING);
    });
  });

  describe('refunds (#56)', () => {
    const details = { initiatedBy: RefundInitiator.CUSTOMER, requestedBy: null, reason: 'You cancelled this order.', source: 'order.cancelled:e1' };

    async function completedPayment(): Promise<Payment> {
      const p = await repo.create({ orderId: randomUUID(), customerId: randomUUID(), amount: '225.00' });
      await repo.transition(p.id, PaymentStatus.PENDING, PaymentStatus.PROCESSING);
      await repo.transition(p.id, PaymentStatus.PROCESSING, PaymentStatus.COMPLETED);
      return p;
    }

    it('many concurrent refunds of one payment: one refund row, payment REFUNDED, the rest find it done', async () => {
      const p = await completedPayment();

      const outcomes = await Promise.all(Array.from({ length: 10 }, () => repo.refundOnce(p.id, details)));

      expect(outcomes.filter((o) => o === 'refunded')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'already')).toHaveLength(9);
      expect(await ds.getRepository(Refund).count({ where: { paymentId: p.id } })).toBe(1);
      expect((await repo.findById(p.id))?.status).toBe(PaymentStatus.REFUNDED);
      expect(await repo.findRefundByPayment(p.id)).toMatchObject({ amount: '225.00', currency: 'EGP', provider: 'SIMULATED', ...details });
    });

    it('refuses a payment that never completed and writes nothing', async () => {
      const p = await repo.create({ orderId: randomUUID(), customerId: randomUUID(), amount: '10.00' });

      expect(await repo.refundOnce(p.id, details)).toBe('not-refundable');
      expect(await ds.getRepository(Refund).count()).toBe(0);
      expect((await repo.findById(p.id))?.status).toBe(PaymentStatus.PENDING);
    });

    it('finds the collected payment of an order and the payments with owed side effects', async () => {
      const p = await completedPayment();
      expect((await repo.findCollectedByOrder(p.orderId))?.id).toBe(p.id);

      expect((await repo.findWithOwedSideEffects(0, 10)).map((x) => x.id)).toContain(p.id);
      const lease = (await repo.acquireSideEffectsLease(p.id, 30_000))!;
      await repo.markEventPublished(p.id, PaymentStatus.COMPLETED, lease);
      await repo.markOrderSynced(p.id, PaymentStatus.COMPLETED, lease);
      await repo.releaseSideEffectsLease(p.id, lease);
      expect((await repo.findWithOwedSideEffects(0, 10)).map((x) => x.id)).not.toContain(p.id);
    });
  });
});

describeDb('migrations/20260917_payment_idempotency.sql', () => {
  jest.setTimeout(30_000);

  it('upgrades the legacy schema to exactly what the entity expects, backfilling side-effect markers', async () => {
    // 1. Legacy schema with existing data.
    const legacy = await dataSource([LegacyPayment], true).initialize();
    await legacy.query(
      `INSERT INTO payments ("orderId", "customerId", amount, status) VALUES
         ('o1', 'c1', 10, 'COMPLETED'), ('o2', 'c1', 10, 'PENDING'), ('o3', 'c1', 10, 'REFUNDED')`,
    );

    // 2. Apply the migration twice (it must be idempotent). CONCURRENTLY can't run
    //    inside a transaction block, so statements are sent one at a time.
    const statements = readFileSync(MIGRATION_SQL, 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (let run = 0; run < 2; run++) {
      for (const sql of statements) await legacy.query(sql);
    }
    // Later columns come from the TypeORM migrations (#18).
    await new PaymentProcessingClaim1700000000003().up(legacy.createQueryRunner());
    await new PaymentSideEffectsLeaseToken1700000000004().up(legacy.createQueryRunner());
    await legacy.destroy();

    // 3. TypeORM must see no pending schema changes against the current entity.
    const current = await dataSource([Payment], false).initialize();
    try {
      const pending = await current.driver.createSchemaBuilder().log();
      expect(pending.upQueries.map((q) => q.query)).toEqual([]);

      const rows: Array<{ orderId: string; publishedEventStatus: string | null; orderSyncedStatus: string | null }> =
        await current.query(`SELECT "orderId", "publishedEventStatus", "orderSyncedStatus" FROM payments ORDER BY "orderId"`);
      expect(rows).toEqual([
        { orderId: 'o1', publishedEventStatus: 'COMPLETED', orderSyncedStatus: 'COMPLETED' },
        { orderId: 'o2', publishedEventStatus: 'PENDING', orderSyncedStatus: 'PENDING' },
        { orderId: 'o3', publishedEventStatus: null, orderSyncedStatus: null },
      ]);
    } finally {
      await current.destroy();
    }
  });
});
