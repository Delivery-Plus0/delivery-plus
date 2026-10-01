import { PaymentsService, paymentEventId } from './payments.service';
import { PaymentsRepository, CreatePaymentData } from '../repositories/payments.repository';
import { OrderServiceClient, OrderDto } from '../common/order-service.client';
import {
  ConflictError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  OrderStatus,
  PaymentEventType,
  PaymentStatus,
  UserRole,
  KafkaProducerService,
  TOPICS,
} from '@food-delivery/shared';
import {
  ACTIVE_PAYMENT_STATUSES,
  Payment,
  UQ_PAYMENTS_ACTIVE_ORDER,
  UQ_PAYMENTS_CUSTOMER_IDEMPOTENCY_KEY,
} from '../entities/payment.entity';

/** Builds an error shaped like TypeORM's QueryFailedError for a Postgres unique violation. */
function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    driverError: { code: '23505', constraint },
  });
}

/**
 * In-memory stand-in for PaymentsRepository that enforces the same rules as the
 * database: one active payment per order, unique (customerId, idempotencyKey),
 * and compare-and-set transitions. Every method is a jest.fn so calls can be asserted.
 */
class FakePaymentsRepository {
  rows = new Map<string, Payment>();
  private seq = 0;

  findById = jest.fn(async (id: string) => this.copy(this.rows.get(id)));

  findLatestByOrder = jest.fn(async (orderId: string) => {
    const list = [...this.rows.values()].filter((p) => p.orderId === orderId);
    return this.copy(list[list.length - 1]);
  });

  findActiveByOrder = jest.fn(async (orderId: string) =>
    this.copy([...this.rows.values()].find((p) => p.orderId === orderId && ACTIVE_PAYMENT_STATUSES.includes(p.status))),
  );

  findByIdempotencyKey = jest.fn(async (customerId: string, key: string) =>
    this.copy([...this.rows.values()].find((p) => p.customerId === customerId && p.idempotencyKey === key)),
  );

  create = jest.fn(async (data: CreatePaymentData) => {
    const rows = [...this.rows.values()];
    if (data.idempotencyKey && rows.some((p) => p.customerId === data.customerId && p.idempotencyKey === data.idempotencyKey)) {
      throw uniqueViolation(UQ_PAYMENTS_CUSTOMER_IDEMPOTENCY_KEY);
    }
    if (rows.some((p) => p.orderId === data.orderId && ACTIVE_PAYMENT_STATUSES.includes(p.status))) {
      throw uniqueViolation(UQ_PAYMENTS_ACTIVE_ORDER);
    }
    const now = new Date();
    const payment: Payment = {
      id: `pay-${++this.seq}`,
      orderId: data.orderId,
      customerId: data.customerId,
      amount: data.amount,
      status: PaymentStatus.PENDING,
      idempotencyKey: data.idempotencyKey ?? null,
      publishedEventStatus: null,
      orderSyncedStatus: null,
      sideEffectsLeaseUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(payment.id, payment);
    return this.copy(payment)!;
  });

  transition = jest.fn(async (id: string, from: PaymentStatus, to: PaymentStatus, failureReason?: string) => {
    const row = this.rows.get(id);
    if (!row || row.status !== from) return false;
    row.status = to;
    if (failureReason !== undefined) row.failureReason = failureReason;
    return true;
  });

  /** Lease state keyed by id; `now` is overridable to simulate expiry. */
  now = () => Date.now();

  acquireSideEffectsLease = jest.fn(async (id: string, ttlMs: number) => {
    const row = this.rows.get(id);
    if (!row) return false;
    if (row.sideEffectsLeaseUntil && row.sideEffectsLeaseUntil.getTime() >= this.now()) return false;
    row.sideEffectsLeaseUntil = new Date(this.now() + ttlMs);
    return true;
  });

  releaseSideEffectsLease = jest.fn(async (id: string) => {
    const row = this.rows.get(id);
    if (row) row.sideEffectsLeaseUntil = null;
  });

  markEventPublished = jest.fn(async (id: string, status: PaymentStatus) => {
    this.rows.get(id)!.publishedEventStatus = status;
  });

  markOrderSynced = jest.fn(async (id: string, status: PaymentStatus) => {
    this.rows.get(id)!.orderSyncedStatus = status;
  });

  /** Seeds a row directly, bypassing the constraints (for arranging state). */
  seed(overrides: Partial<Payment>): Payment {
    const now = new Date();
    const payment: Payment = {
      id: `pay-${++this.seq}`,
      orderId: 'order-1',
      customerId: 'customer-1',
      amount: '19.98',
      status: PaymentStatus.PENDING,
      idempotencyKey: null,
      publishedEventStatus: null,
      orderSyncedStatus: null,
      sideEffectsLeaseUntil: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    this.rows.set(payment.id, payment);
    return this.copy(payment)!;
  }

  private copy(p: Payment | undefined): Payment | null {
    return p ? { ...p } : null;
  }
}

describe('PaymentsService', () => {
  let service: PaymentsService;
  let payments: FakePaymentsRepository;
  let orderClient: jest.Mocked<OrderServiceClient>;
  let kafka: { publish: jest.Mock };

  const config = { paymentSuccessRate: 0.9 } as never;

  const order = (overrides: Partial<OrderDto> = {}): OrderDto => ({
    id: 'order-1',
    customerId: 'customer-1',
    restaurantId: 'r1',
    status: OrderStatus.CREATED,
    totalAmount: '19.98',
    ...overrides,
  });

  /** Seeds a payment whose own side effects are already done (the normal steady state). */
  const seedSynced = (status: PaymentStatus, overrides: Partial<Payment> = {}) =>
    payments.seed({ status, publishedEventStatus: status, orderSyncedStatus: status, ...overrides });

  const publishedEventTypes = () => kafka.publish.mock.calls.map(([, event]) => event.eventType);

  beforeEach(() => {
    payments = new FakePaymentsRepository();
    orderClient = {
      getOrder: jest.fn().mockResolvedValue(order()),
      getOrderAsSystem: jest.fn().mockResolvedValue(order()),
      updateOrderStatus: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<OrderServiceClient>;
    kafka = { publish: jest.fn().mockResolvedValue(undefined) };

    service = new PaymentsService(
      payments as unknown as PaymentsRepository,
      orderClient,
      config,
      kafka as unknown as KafkaProducerService,
    );
  });

  describe('createPayment', () => {
    it('creates a PENDING payment, publishes payment.created and moves the order to PAYMENT_PENDING', async () => {
      const result = await service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x', 'key-1');

      expect(result.status).toBe(PaymentStatus.PENDING);
      expect(result.idempotencyKey).toBe('key-1');
      expect(result.publishedEventStatus).toBe(PaymentStatus.PENDING);
      expect(result.orderSyncedStatus).toBe(PaymentStatus.PENDING);
      expect(kafka.publish).toHaveBeenCalledTimes(1);
      expect(kafka.publish).toHaveBeenCalledWith(
        TOPICS.PAYMENT_EVENTS,
        expect.objectContaining({
          eventId: paymentEventId(result.id, PaymentEventType.CREATED),
          eventType: PaymentEventType.CREATED,
          payload: { paymentId: result.id, orderId: 'order-1', amount: 19.98, status: PaymentStatus.PENDING },
        }),
      );
      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.PAYMENT_PENDING);
    });

    it('still works without an Idempotency-Key (backward compatible)', async () => {
      const result = await service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x');
      expect(result.status).toBe(PaymentStatus.PENDING);
      expect(result.idempotencyKey).toBeNull();
    });

    it('rejects when requester does not own the order', async () => {
      orderClient.getOrder.mockResolvedValue(order({ customerId: 'someone-else' }));
      await expect(
        service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x'),
      ).rejects.toThrow(ForbiddenError);
      expect(payments.create).not.toHaveBeenCalled();
    });

    it('rejects when order is not in CREATED status', async () => {
      orderClient.getOrder.mockResolvedValue(order({ status: OrderStatus.CONFIRMED }));
      await expect(
        service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x'),
      ).rejects.toThrow(ConflictError);
    });

    it('rejects when an active payment already exists for the order', async () => {
      seedSynced(PaymentStatus.PENDING);
      await expect(
        service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x'),
      ).rejects.toThrow(ConflictError);
    });

    it('allows a new payment when the previous one FAILED', async () => {
      seedSynced(PaymentStatus.FAILED);
      const result = await service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x');
      expect(result.status).toBe(PaymentStatus.PENDING);
      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.PAYMENT_PENDING);
    });

    describe('race: lost the insert to a concurrent request', () => {
      it('maps the active-order unique violation to ConflictError (lookup passed, insert rejected)', async () => {
        // Simulates the window between findLatestByOrder and create.
        payments.findLatestByOrder.mockResolvedValueOnce(null);
        seedSynced(PaymentStatus.PENDING);

        await expect(
          service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x'),
        ).rejects.toThrow(ConflictError);
        expect(kafka.publish).not.toHaveBeenCalled();
        expect(orderClient.updateOrderStatus).not.toHaveBeenCalled();
      });

      it('two concurrent creates for one order yield exactly one payment', async () => {
        // Both requests pass the pre-check before either inserts.
        payments.findLatestByOrder.mockResolvedValue(null);

        const results = await Promise.allSettled([
          service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x'),
          service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x'),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason).toBeInstanceOf(ConflictError);
        expect(payments.rows.size).toBe(1);
        expect(kafka.publish).toHaveBeenCalledTimes(1);
        expect(orderClient.updateOrderStatus).toHaveBeenCalledTimes(1);
      });

      it('two concurrent creates with the same key both return the same payment', async () => {
        payments.findLatestByOrder.mockResolvedValue(null);
        payments.findByIdempotencyKey.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

        const [a, b] = await Promise.all([
          service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x', 'key-1'),
          service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x', 'key-1'),
        ]);

        expect(a.id).toBe(b.id);
        expect(payments.rows.size).toBe(1);
      });
    });

    describe('duplicate retry with the same Idempotency-Key', () => {
      it('returns the original payment without creating, publishing or updating the order again', async () => {
        const first = await service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x', 'key-1');
        // After the first call the order is PAYMENT_PENDING; a retry must not trip the status check.
        orderClient.getOrder.mockResolvedValue(order({ status: OrderStatus.PAYMENT_PENDING }));
        jest.clearAllMocks();

        const second = await service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x', 'key-1');

        expect(second.id).toBe(first.id);
        expect(payments.create).not.toHaveBeenCalled();
        expect(orderClient.getOrder).not.toHaveBeenCalled();
        expect(kafka.publish).not.toHaveBeenCalled();
        expect(orderClient.updateOrderStatus).not.toHaveBeenCalled();
      });

      it('returns the payment in its current state when it has since been completed', async () => {
        const seeded = seedSynced(PaymentStatus.COMPLETED, { idempotencyKey: 'key-1' });
        const result = await service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x', 'key-1');
        expect(result.id).toBe(seeded.id);
        expect(result.status).toBe(PaymentStatus.COMPLETED);
        expect(kafka.publish).not.toHaveBeenCalled();
      });

      it('rejects reusing a key for a different order', async () => {
        seedSynced(PaymentStatus.PENDING, { idempotencyKey: 'key-1', orderId: 'order-1' });
        await expect(
          service.createPayment('customer-1', { orderId: 'order-2' }, 'Bearer x', 'key-1'),
        ).rejects.toThrow('Idempotency-Key was already used for a different order');
      });

      it('scopes keys per customer', async () => {
        seedSynced(PaymentStatus.FAILED, { idempotencyKey: 'key-1', customerId: 'customer-2', orderId: 'order-9' });
        const result = await service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x', 'key-1');
        expect(result.customerId).toBe('customer-1');
        expect(result.orderId).toBe('order-1');
      });
    });

    describe('dependency failure', () => {
      it('Kafka failure: the payment persists and a keyed retry finishes the side effects once', async () => {
        kafka.publish.mockRejectedValueOnce(new Error('broker down'));

        await expect(
          service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x', 'key-1'),
        ).rejects.toThrow('broker down');
        const [stored] = [...payments.rows.values()];
        expect(stored.status).toBe(PaymentStatus.PENDING);
        expect(stored.publishedEventStatus).toBeNull();
        expect(orderClient.updateOrderStatus).not.toHaveBeenCalled();

        const retried = await service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x', 'key-1');

        expect(retried.id).toBe(stored.id);
        expect(kafka.publish).toHaveBeenCalledTimes(2); // 1 failed + 1 successful
        expect(orderClient.updateOrderStatus).toHaveBeenCalledTimes(1);
        expect(retried.publishedEventStatus).toBe(PaymentStatus.PENDING);
        expect(retried.orderSyncedStatus).toBe(PaymentStatus.PENDING);
      });

      it('order-service failure: a keyed retry updates the order without republishing', async () => {
        orderClient.updateOrderStatus.mockRejectedValueOnce(new Error('order-service 503'));

        await expect(
          service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x', 'key-1'),
        ).rejects.toThrow('order-service 503');

        await service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x', 'key-1');

        expect(kafka.publish).toHaveBeenCalledTimes(1);
        expect(orderClient.updateOrderStatus).toHaveBeenCalledTimes(2);
      });

      it('rethrows non-constraint database errors unchanged', async () => {
        payments.create.mockRejectedValueOnce(new Error('connection reset'));
        await expect(
          service.createPayment('customer-1', { orderId: 'order-1' }, 'Bearer x', 'key-1'),
        ).rejects.toThrow('connection reset');
      });
    });
  });

  describe('processPayment', () => {
    it('throws NotFoundError when missing', async () => {
      await expect(service.processPayment('missing', 'customer-1', {})).rejects.toThrow(NotFoundError);
    });

    it('rejects a non-owner', async () => {
      const p = seedSynced(PaymentStatus.PENDING);
      await expect(service.processPayment(p.id, 'not-the-customer', {})).rejects.toThrow(ForbiddenError);
    });

    it('settles to COMPLETED, publishes payment.completed once and confirms the order', async () => {
      const p = seedSynced(PaymentStatus.PENDING);

      const result = await service.processPayment(p.id, 'customer-1', { simulateFailure: false });

      expect(result.status).toBe(PaymentStatus.COMPLETED);
      expect(publishedEventTypes()).toEqual([PaymentEventType.COMPLETED]);
      expect(kafka.publish.mock.calls[0][1].eventId).toBe(paymentEventId(p.id, PaymentEventType.COMPLETED));
      expect(orderClient.updateOrderStatus).toHaveBeenCalledTimes(1);
      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.CONFIRMED);
    });

    it('settles to FAILED and fails the order when forced to fail', async () => {
      const p = seedSynced(PaymentStatus.PENDING);

      const result = await service.processPayment(p.id, 'customer-1', { simulateFailure: true });

      expect(result.status).toBe(PaymentStatus.FAILED);
      expect(result.failureReason).toBe('Simulated payment decline');
      expect(publishedEventTypes()).toEqual([PaymentEventType.FAILED]);
      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.FAILED);
    });

    it('finishes a pending creation side effect before settling (order must be PAYMENT_PENDING first)', async () => {
      const p = payments.seed({ status: PaymentStatus.PENDING, publishedEventStatus: PaymentStatus.PENDING });

      await service.processPayment(p.id, 'customer-1', { simulateFailure: false });

      expect(orderClient.updateOrderStatus.mock.calls.map(([, s]) => s)).toEqual([
        OrderStatus.PAYMENT_PENDING,
        OrderStatus.CONFIRMED,
      ]);
    });

    describe('terminal retry', () => {
      it.each([PaymentStatus.COMPLETED, PaymentStatus.FAILED])(
        'reprocessing a %s payment returns it unchanged with no side effects',
        async (status) => {
          const p = seedSynced(status);

          const result = await service.processPayment(p.id, 'customer-1', { simulateFailure: status === PaymentStatus.COMPLETED });

          expect(result.status).toBe(status);
          expect(payments.transition).not.toHaveBeenCalled();
          expect(kafka.publish).not.toHaveBeenCalled();
          expect(orderClient.updateOrderStatus).not.toHaveBeenCalled();
        },
      );

      it('ignores simulateFailure on retry: the terminal outcome never flips', async () => {
        const p = seedSynced(PaymentStatus.COMPLETED);
        const result = await service.processPayment(p.id, 'customer-1', { simulateFailure: true });
        expect(result.status).toBe(PaymentStatus.COMPLETED);
      });

      it('processing twice in a row settles once', async () => {
        const p = seedSynced(PaymentStatus.PENDING);

        const first = await service.processPayment(p.id, 'customer-1', { simulateFailure: false });
        const second = await service.processPayment(p.id, 'customer-1', { simulateFailure: true });

        expect(second).toEqual(first);
        expect(publishedEventTypes()).toEqual([PaymentEventType.COMPLETED]);
        expect(orderClient.updateOrderStatus).toHaveBeenCalledTimes(1);
      });

      it('rejects processing a REFUNDED payment', async () => {
        const p = seedSynced(PaymentStatus.REFUNDED);
        await expect(service.processPayment(p.id, 'customer-1', {})).rejects.toThrow(InvalidStateTransitionError);
      });
    });

    describe('race', () => {
      it('returns 409 while another request holds the payment in PROCESSING', async () => {
        const p = seedSynced(PaymentStatus.PROCESSING);
        await expect(service.processPayment(p.id, 'customer-1', {})).rejects.toThrow(ConflictError);
      });

      it('concurrent process calls settle the payment exactly once', async () => {
        const p = seedSynced(PaymentStatus.PENDING);

        const results = await Promise.allSettled([
          service.processPayment(p.id, 'customer-1', { simulateFailure: false }),
          service.processPayment(p.id, 'customer-1', { simulateFailure: true }),
        ]);

        expect(payments.rows.get(p.id)!.status).toBe(PaymentStatus.COMPLETED);
        expect(results.filter((r) => r.status === 'fulfilled')).not.toHaveLength(0);
        for (const r of results) {
          if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(ConflictError);
          else expect(r.value.status).toBe(PaymentStatus.COMPLETED);
        }
        expect(publishedEventTypes()).toEqual([PaymentEventType.COMPLETED]);
        expect(orderClient.updateOrderStatus).toHaveBeenCalledTimes(1);
      });

      it('returns the settled result when the claim is lost to a request that already finished', async () => {
        const p = seedSynced(PaymentStatus.PENDING);
        payments.transition.mockImplementationOnce(async (id: string) => {
          Object.assign(payments.rows.get(id)!, {
            status: PaymentStatus.FAILED,
            publishedEventStatus: PaymentStatus.FAILED,
            orderSyncedStatus: PaymentStatus.FAILED,
          });
          return false;
        });

        const result = await service.processPayment(p.id, 'customer-1', { simulateFailure: false });

        expect(result.status).toBe(PaymentStatus.FAILED);
        expect(kafka.publish).not.toHaveBeenCalled();
      });
    });

    describe('side-effects lease', () => {
      it('a terminal retry returns the payment while another request is finishing its side effects', async () => {
        const p = payments.seed({
          status: PaymentStatus.COMPLETED,
          sideEffectsLeaseUntil: new Date(Date.now() + 10_000),
        });

        const result = await service.processPayment(p.id, 'customer-1', {});

        expect(result.status).toBe(PaymentStatus.COMPLETED);
        expect(kafka.publish).not.toHaveBeenCalled();
        expect(orderClient.updateOrderStatus).not.toHaveBeenCalled();
      });

      it('an expired lease (holder crashed) is taken over and the side effects are completed', async () => {
        const p = payments.seed({
          status: PaymentStatus.COMPLETED,
          sideEffectsLeaseUntil: new Date(Date.now() - 1),
        });

        const result = await service.processPayment(p.id, 'customer-1', {});

        expect(publishedEventTypes()).toEqual([PaymentEventType.COMPLETED]);
        expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.CONFIRMED);
        expect(result.sideEffectsLeaseUntil).toBeNull();
      });

      it('releases the lease when a side effect fails', async () => {
        const p = seedSynced(PaymentStatus.PENDING);
        kafka.publish.mockRejectedValueOnce(new Error('broker down'));

        await expect(service.processPayment(p.id, 'customer-1', { simulateFailure: false })).rejects.toThrow();

        expect(payments.rows.get(p.id)!.sideEffectsLeaseUntil).toBeNull();
      });

      it('returns 409 instead of settling while creation side effects are still being finished elsewhere', async () => {
        const p = payments.seed({
          status: PaymentStatus.PENDING,
          sideEffectsLeaseUntil: new Date(Date.now() + 10_000),
        });

        await expect(service.processPayment(p.id, 'customer-1', {})).rejects.toThrow(ConflictError);
        expect(payments.rows.get(p.id)!.status).toBe(PaymentStatus.PENDING);
      });
    });

    describe('dependency failure', () => {
      it('Kafka failure: payment stays COMPLETED, retry publishes once and confirms the order once', async () => {
        const p = seedSynced(PaymentStatus.PENDING);
        kafka.publish.mockRejectedValueOnce(new Error('broker down'));

        await expect(
          service.processPayment(p.id, 'customer-1', { simulateFailure: false }),
        ).rejects.toThrow('broker down');
        expect(payments.rows.get(p.id)!.status).toBe(PaymentStatus.COMPLETED);
        expect(orderClient.updateOrderStatus).not.toHaveBeenCalled();

        // The retry asks for a failure, but the committed outcome must win.
        const result = await service.processPayment(p.id, 'customer-1', { simulateFailure: true });

        expect(result.status).toBe(PaymentStatus.COMPLETED);
        expect(kafka.publish).toHaveBeenCalledTimes(2);
        const [first, second] = kafka.publish.mock.calls.map(([, e]) => e.eventId);
        expect(second).toBe(first); // same eventId → consumers deduplicate
        expect(orderClient.updateOrderStatus).toHaveBeenCalledTimes(1);
        expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.CONFIRMED);
      });

      it('order-service failure: retry confirms the order without republishing', async () => {
        const p = seedSynced(PaymentStatus.PENDING);
        orderClient.updateOrderStatus.mockRejectedValueOnce(new Error('order-service 503'));

        await expect(
          service.processPayment(p.id, 'customer-1', { simulateFailure: false }),
        ).rejects.toThrow('order-service 503');

        const result = await service.processPayment(p.id, 'customer-1', {});

        expect(result.orderSyncedStatus).toBe(PaymentStatus.COMPLETED);
        expect(publishedEventTypes()).toEqual([PaymentEventType.COMPLETED]);
        expect(orderClient.updateOrderStatus).toHaveBeenCalledTimes(2);
      });

      it('FAILED outcome with order-service failure is retried to FAILED, never CONFIRMED', async () => {
        const p = seedSynced(PaymentStatus.PENDING);
        orderClient.updateOrderStatus.mockRejectedValueOnce(new Error('order-service 503'));

        await expect(
          service.processPayment(p.id, 'customer-1', { simulateFailure: true }),
        ).rejects.toThrow('order-service 503');
        await service.processPayment(p.id, 'customer-1', { simulateFailure: false });

        expect(orderClient.updateOrderStatus.mock.calls.map(([, s]) => s)).toEqual([
          OrderStatus.FAILED,
          OrderStatus.FAILED,
        ]);
      });
    });
  });

  describe('failed payment vs. an order that already moved on', () => {
    it('a decline after the customer cancelled settles FAILED without erroring and marks the order synced', async () => {
      const p = seedSynced(PaymentStatus.PENDING);
      orderClient.updateOrderStatus.mockRejectedValueOnce(new ConflictError('Order order-1 cannot move to FAILED'));
      orderClient.getOrderAsSystem.mockResolvedValueOnce(order({ status: OrderStatus.CANCELLED }));

      const result = await service.processPayment(p.id, 'customer-1', { simulateFailure: true });

      expect(result.status).toBe(PaymentStatus.FAILED);
      expect(result.orderSyncedStatus).toBe(PaymentStatus.FAILED);
      expect(publishedEventTypes()).toEqual([PaymentEventType.FAILED]);
    });

    it('a repeated process call after that is a no-op', async () => {
      const p = seedSynced(PaymentStatus.PENDING);
      orderClient.updateOrderStatus.mockRejectedValueOnce(new ConflictError('conflict'));
      orderClient.getOrderAsSystem.mockResolvedValueOnce(order({ status: OrderStatus.CANCELLED }));
      await service.processPayment(p.id, 'customer-1', { simulateFailure: true });

      await service.processPayment(p.id, 'customer-1', { simulateFailure: true });

      expect(orderClient.updateOrderStatus).toHaveBeenCalledTimes(1);
      expect(kafka.publish).toHaveBeenCalledTimes(1);
    });

    it('still surfaces a conflict when the order is not terminal', async () => {
      const p = seedSynced(PaymentStatus.PENDING);
      orderClient.updateOrderStatus.mockRejectedValueOnce(new ConflictError('conflict'));
      orderClient.getOrderAsSystem.mockResolvedValueOnce(order({ status: OrderStatus.CONFIRMED }));

      await expect(service.processPayment(p.id, 'customer-1', { simulateFailure: true })).rejects.toThrow(ConflictError);
      expect(payments.rows.get(p.id)!.orderSyncedStatus).not.toBe(PaymentStatus.FAILED);
    });

    it('never hides a COMPLETED payment on a cancelled order (needs a refund)', async () => {
      const p = seedSynced(PaymentStatus.PENDING);
      orderClient.updateOrderStatus.mockRejectedValueOnce(new ConflictError('conflict'));
      orderClient.getOrderAsSystem.mockResolvedValueOnce(order({ status: OrderStatus.CANCELLED }));

      await expect(service.processPayment(p.id, 'customer-1', { simulateFailure: false })).rejects.toThrow(ConflictError);
      expect(orderClient.getOrderAsSystem).not.toHaveBeenCalled();
    });
  });

  describe('getStatus', () => {
    it('allows the owning customer', async () => {
      const p = seedSynced(PaymentStatus.PENDING);
      const result = await service.getStatus(p.id, 'customer-1', UserRole.CUSTOMER);
      expect(result.id).toBe(p.id);
    });

    it('rejects a different customer', async () => {
      const p = seedSynced(PaymentStatus.PENDING);
      await expect(service.getStatus(p.id, 'someone-else', UserRole.CUSTOMER)).rejects.toThrow(ForbiddenError);
    });

    it('allows ADMIN regardless of ownership', async () => {
      const p = seedSynced(PaymentStatus.PENDING);
      const result = await service.getStatus(p.id, 'admin-1', UserRole.ADMIN);
      expect(result.id).toBe(p.id);
    });
  });

  describe('refund', () => {
    it('rejects refunding a non-COMPLETED payment', async () => {
      const p = seedSynced(PaymentStatus.PENDING);
      await expect(service.refund(p.id, 'admin-1', UserRole.ADMIN)).rejects.toThrow(InvalidStateTransitionError);
    });

    it('lets support (admin) refund a COMPLETED payment', async () => {
      const p = seedSynced(PaymentStatus.COMPLETED);
      const result = await service.refund(p.id, 'admin-1', UserRole.ADMIN);
      expect(result.status).toBe(PaymentStatus.REFUNDED);
    });

    it('no longer lets a customer refund their own completed payment (e.g. after delivery)', async () => {
      const p = seedSynced(PaymentStatus.COMPLETED);
      await expect(service.refund(p.id, 'customer-1', UserRole.CUSTOMER)).rejects.toThrow(ForbiddenError);
      expect(payments.rows.get(p.id)!.status).toBe(PaymentStatus.COMPLETED);
    });

    it('rejects restaurant owners and drivers too', async () => {
      const p = seedSynced(PaymentStatus.COMPLETED);
      await expect(service.refund(p.id, 'owner-1', UserRole.RESTAURANT_OWNER)).rejects.toThrow(ForbiddenError);
      await expect(service.refund(p.id, 'driver-1', UserRole.DRIVER)).rejects.toThrow(ForbiddenError);
    });
  });
});
