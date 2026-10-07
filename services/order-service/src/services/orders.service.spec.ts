import { DEFAULT_PRICING } from '../common/pricing';
import { OrdersService } from './orders.service';
import { OrdersRepository } from '../repositories/orders.repository';
import { CartServiceClient } from '../common/cart-service.client';
import { RestaurantServiceClient } from '../common/restaurant-service.client';
import { UserProfileDto, UserServiceClient } from '../common/user-service.client';
import {
  BadRequestError,
  DeliveryEventType,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  OrderEventType,
  OrderStatus,
  PaymentEventType,
  RestaurantStatus,
  UserRole,
  lifecycleEventId,
} from '@food-delivery/shared';

describe('OrdersService', () => {
  let service: OrdersService;
  let orders: jest.Mocked<OrdersRepository>;
  let cartClient: jest.Mocked<CartServiceClient>;
  let restaurantClient: jest.Mocked<RestaurantServiceClient>;
  let userClient: jest.Mocked<UserServiceClient>;
  let outbox: { kick: jest.Mock };
  let kafkaConsumer: { subscribe: jest.Mock; start: jest.Mock };

  const baseOrder = {
    id: 'order-1',
    customerId: 'customer-1',
    restaurantId: 'rest-1',
    status: OrderStatus.CREATED,
    totalAmount: '19.98',
    deliveryAddress: '1 Profile Street',
    deliveryNotes: null,
    deliveryLatitude: null,
    deliveryLongitude: null,
    cancelledBy: null,
    cancellationReason: null,
    paymentStatus: null,
    customerFirstName: null,
    subtotalAmount: '9.99',
    deliveryFee: '0.00',
    items: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  /**
   * The events the repository staged in the outbox: create/updateStatus call the event builder they
   * are given with the order they wrote, in the same transaction, only when the write succeeded (a lost
   * compare-and-set returns null and stages nothing).
   */
  async function staged(): Promise<Array<{ eventId: string; eventType: string; payload: Record<string, unknown> }>> {
    const recorded: Array<{ order: number; event: { eventId: string; eventType: string; payload: Record<string, unknown> } }> = [];
    const calls: Array<[jest.Mock, number]> = [
      [orders.create as unknown as jest.Mock, 6],
      [orders.updateStatus as unknown as jest.Mock, 3],
    ];
    for (const [mock, builderIndex] of calls) {
      for (const [i, args] of mock.mock.calls.entries()) {
        const written = await Promise.resolve(mock.mock.results[i]?.value).catch(() => null);
        const build = args[builderIndex];
        if (written && typeof build === 'function') recorded.push({ order: mock.mock.invocationCallOrder[i], event: build(written) });
      }
    }
    return recorded.sort((a, b) => a.order - b.order).map((r) => r.event);
  }

  beforeEach(() => {
    orders = {
      findById: jest.fn(),
      create: jest.fn(),
      updateStatus: jest.fn(),
      findByCustomer: jest.fn(),
      findFeeSplit: jest.fn(),
      recordPaymentStatus: jest.fn(),
      findByRestaurant: jest.fn(),
      findByCustomerAndIdempotencyKey: jest.fn(),
    } as unknown as jest.Mocked<OrdersRepository>;

    cartClient = {
      getCart: jest.fn(),
      clearCart: jest.fn(),
    } as unknown as jest.Mocked<CartServiceClient>;

    restaurantClient = {
      getRestaurant: jest.fn(),
      assertOwnership: jest.fn(),
    } as unknown as jest.Mocked<RestaurantServiceClient>;

    userClient = {
      getOwnProfile: jest.fn().mockResolvedValue({ id: 'customer-1', address: '1 Profile Street' }),
    } as unknown as jest.Mocked<UserServiceClient>;

    outbox = { kick: jest.fn() };
    kafkaConsumer = { subscribe: jest.fn(), start: jest.fn() };
    service = new OrdersService(
      orders,
      cartClient,
      restaurantClient,
      outbox as any,
      kafkaConsumer as any,
      userClient,
      { pricing: DEFAULT_PRICING } as any,
    );
  });

  describe('createFromCart', () => {
    it('throws BadRequestError when cart is empty', async () => {
      cartClient.getCart.mockResolvedValue({ userId: 'c1', restaurantId: null, items: [], total: 0 });
      await expect(service.createFromCart('customer-1', 'Bearer x')).rejects.toThrow(BadRequestError);
    });

    it('throws BadRequestError when restaurant is not OPEN', async () => {
      cartClient.getCart.mockResolvedValue({
        userId: 'c1',
        restaurantId: 'rest-1',
        items: [{ menuItemId: 'i1', name: 'Burger', price: 9.99, quantity: 1 }],
        total: 9.99,
      });
      restaurantClient.getRestaurant.mockResolvedValue({
        id: 'rest-1',
        name: 'X',
        status: RestaurantStatus.CLOSED,
      });

      await expect(service.createFromCart('customer-1', 'Bearer x')).rejects.toThrow(BadRequestError);
    });

    it('creates the order and clears the cart when everything is valid', async () => {
      cartClient.getCart.mockResolvedValue({
        userId: 'c1',
        restaurantId: 'rest-1',
        items: [{ menuItemId: 'i1', name: 'Burger', price: 9.99, quantity: 2 }],
        total: 19.98,
      });
      restaurantClient.getRestaurant.mockResolvedValue({
        id: 'rest-1',
        name: 'X',
        status: RestaurantStatus.OPEN,
      });
      orders.create.mockResolvedValue(baseOrder);

      const result = await service.createFromCart('customer-1', 'Bearer x');

      expect(result.id).toBe('order-1');
      expect(cartClient.clearCart).toHaveBeenCalledWith('Bearer x');
    });

    it('returns the original order when the same idempotency key is retried', async () => {
      const existing = { ...baseOrder, id: 'order-existing', customerId: 'customer-1' };
      orders.findByCustomerAndIdempotencyKey.mockResolvedValue(existing);

      const result = await (service as any).createFromCart('customer-1', 'Bearer x', 'key-1');

      expect(result.id).toBe('order-existing');
      expect(orders.create).not.toHaveBeenCalled();
      expect(cartClient.clearCart).not.toHaveBeenCalled();
    });

    it('replays a lost race with the same idempotency key after a unique-constraint conflict', async () => {
      const existing = { ...baseOrder, id: 'order-existing', customerId: 'customer-1' };
      cartClient.getCart.mockResolvedValue({
        userId: 'c1',
        restaurantId: 'rest-1',
        items: [{ menuItemId: 'i1', name: 'Burger', price: 9.99, quantity: 1 }],
        total: 9.99,
      });
      restaurantClient.getRestaurant.mockResolvedValue({
        id: 'rest-1',
        name: 'X',
        status: RestaurantStatus.OPEN,
      });
      orders.create.mockRejectedValueOnce(new Error('duplicate key'));
      orders.findByCustomerAndIdempotencyKey.mockResolvedValue(existing);

      const result = await (service as any).createFromCart('customer-1', 'Bearer x', 'key-1');

      expect(result.id).toBe('order-existing');
      expect(cartClient.clearCart).not.toHaveBeenCalled();
    });

    describe('delivery address snapshot', () => {
      beforeEach(() => {
        cartClient.getCart.mockResolvedValue({
          userId: 'c1',
          restaurantId: 'rest-1',
          items: [{ menuItemId: 'i1', name: 'Burger', price: 9.99, quantity: 1 }],
          total: 9.99,
        });
        restaurantClient.getRestaurant.mockResolvedValue({ id: 'rest-1', name: 'X', status: RestaurantStatus.OPEN });
        orders.create.mockResolvedValue(baseOrder);
      });

      /** The DeliveryAddress handed to the repository (last argument of create). */
      const persistedDelivery = () => orders.create.mock.calls[0][5];

      it('stores the address, notes and coordinates sent at checkout without reading the profile', async () => {
        await service.createFromCart('customer-1', 'Bearer x', undefined, {
          deliveryAddress: '9 Nile Corniche',
          deliveryNotes: 'Gate code 42',
          deliveryLatitude: 30.0444,
          deliveryLongitude: 31.2357,
        });

        expect(persistedDelivery()).toEqual({
          address: '9 Nile Corniche',
          notes: 'Gate code 42',
          latitude: 30.0444,
          longitude: 31.2357,
        });
        // The profile is read only for the first name now (#154); its address isn't used.
        expect(persistedDelivery().address).toBe('9 Nile Corniche');
      });

      it("falls back to the customer's profile address, read with the customer's own token", async () => {
        userClient.getOwnProfile.mockResolvedValue({ id: 'customer-1', address: '  742 Evergreen Terrace  ' });

        await service.createFromCart('customer-1', 'Bearer x', undefined, { deliveryNotes: 'Ring twice' });

        expect(userClient.getOwnProfile).toHaveBeenCalledWith('Bearer x');
        expect(persistedDelivery()).toEqual({ address: '742 Evergreen Terrace', notes: 'Ring twice', latitude: null, longitude: null });
      });

      it('falls back to the profile when no body is sent at all (existing clients)', async () => {
        await service.createFromCart('customer-1', 'Bearer x');
        expect(persistedDelivery().address).toBe('1 Profile Street');
      });

      it.each([
        ['no address field', { id: 'customer-1' }],
        ['null address', { id: 'customer-1', address: null }],
        ['blank address', { id: 'customer-1', address: '   ' }],
      ])('rejects checkout with no address anywhere (%s): 400, nothing created, cart kept', async (_label, profile) => {
        userClient.getOwnProfile.mockResolvedValue(profile as UserProfileDto);

        await expect(service.createFromCart('customer-1', 'Bearer x')).rejects.toThrow(
          'A delivery address is required',
        );
        expect(orders.create).not.toHaveBeenCalled();
        expect(cartClient.clearCart).not.toHaveBeenCalled();
        expect(await staged()).toHaveLength(0);
      });

      it('rejects coordinates without an address instead of pairing them with the profile address', async () => {
        await expect(
          service.createFromCart('customer-1', 'Bearer x', undefined, { deliveryLatitude: 30, deliveryLongitude: 31 }),
        ).rejects.toThrow(BadRequestError);
        expect(orders.create).not.toHaveBeenCalled();
      });

      it('reports an empty cart before looking up any address', async () => {
        cartClient.getCart.mockResolvedValue({ userId: 'c1', restaurantId: null, items: [], total: 0 });

        await expect(service.createFromCart('customer-1', 'Bearer x')).rejects.toThrow('Cart is empty');
        expect(userClient.getOwnProfile).not.toHaveBeenCalled();
      });

      it('does not re-read the address for an idempotent retry (the original snapshot stands)', async () => {
        orders.findByCustomerAndIdempotencyKey.mockResolvedValue({ ...baseOrder, deliveryAddress: 'original' });

        const result = await service.createFromCart('customer-1', 'Bearer x', 'key-1', { deliveryAddress: 'changed' });

        expect(result.deliveryAddress).toBe('original');
        expect(userClient.getOwnProfile).not.toHaveBeenCalled();
        expect(orders.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('getById', () => {
    it('throws NotFoundError when missing', async () => {
      orders.findById.mockResolvedValue(null);
      await expect(service.getById('missing', 'u1', UserRole.CUSTOMER)).rejects.toThrow(NotFoundError);
    });

    it('allows the owning customer', async () => {
      orders.findById.mockResolvedValue(baseOrder);
      const result = await service.getById('order-1', 'customer-1', UserRole.CUSTOMER);
      expect(result.id).toBe('order-1');
    });

    it('rejects a different customer', async () => {
      orders.findById.mockResolvedValue(baseOrder);
      await expect(service.getById('order-1', 'someone-else', UserRole.CUSTOMER)).rejects.toThrow(
        ForbiddenError,
      );
    });

    it('allows the restaurant owner after ownership check', async () => {
      orders.findById.mockResolvedValue(baseOrder);
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      const result = await service.getById('order-1', 'owner-1', UserRole.RESTAURANT_OWNER);
      expect(result.id).toBe('order-1');
      expect(restaurantClient.assertOwnership).toHaveBeenCalledWith('rest-1', 'owner-1');
    });

    it('rejects a foreign restaurant owner before returning the order', async () => {
      orders.findById.mockResolvedValue(baseOrder);
      restaurantClient.assertOwnership.mockRejectedValue(
        new ForbiddenError('You do not own this restaurant'),
      );

      await expect(service.getById('order-1', 'owner-2', UserRole.RESTAURANT_OWNER)).rejects.toThrow(
        ForbiddenError,
      );
    });
  });

  describe('updateStatus', () => {
    it('rejects an invalid state transition', async () => {
      orders.findById.mockResolvedValue({ ...baseOrder, status: OrderStatus.DELIVERED });
      await expect(
        service.updateStatus('order-1', 'admin-1', UserRole.ADMIN, { status: OrderStatus.CREATED }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('rejects a role not authorized for the target status', async () => {
      orders.findById.mockResolvedValue({ ...baseOrder, status: OrderStatus.PAYMENT_PENDING });
      await expect(
        service.updateStatus('order-1', 'customer-1', UserRole.CUSTOMER, {
          status: OrderStatus.CONFIRMED,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('allows the customer to cancel their own order', async () => {
      orders.findById.mockResolvedValue(baseOrder);
      orders.updateStatus.mockResolvedValue({ ...baseOrder, status: OrderStatus.CANCELLED });

      const result = await service.updateStatus('order-1', 'customer-1', UserRole.CUSTOMER, {
        status: OrderStatus.CANCELLED,
      });
      expect(result.status).toBe(OrderStatus.CANCELLED);
      expect(orders.updateStatus).toHaveBeenCalledWith('order-1', baseOrder.status, OrderStatus.CANCELLED, expect.any(Function), {
        cancelledBy: 'CUSTOMER',
        cancellationReason: 'You cancelled this order.',
      });
    });

    it("records the restaurant's reason when it cancels (#143)", async () => {
      orders.findById.mockResolvedValue({ ...baseOrder, status: OrderStatus.CONFIRMED });
      orders.updateStatus.mockResolvedValue({ ...baseOrder, status: OrderStatus.CANCELLED });

      await service.updateStatus('order-1', 'owner-1', UserRole.RESTAURANT_OWNER, { status: OrderStatus.CANCELLED, reason: 'Kitchen closed early' });

      expect(orders.updateStatus).toHaveBeenCalledWith('order-1', OrderStatus.CONFIRMED, OrderStatus.CANCELLED, expect.any(Function), {
        cancelledBy: 'RESTAURANT',
        cancellationReason: 'The restaurant cancelled this order: Kitchen closed early',
      });
    });

    it('records no outcome for a status that does not end the order', async () => {
      orders.findById.mockResolvedValue({ ...baseOrder, status: OrderStatus.CONFIRMED });
      orders.updateStatus.mockResolvedValue({ ...baseOrder, status: OrderStatus.PREPARING });

      await service.updateStatus('order-1', 'owner-1', UserRole.RESTAURANT_OWNER, { status: OrderStatus.PREPARING });

      expect(orders.updateStatus).toHaveBeenCalledWith('order-1', OrderStatus.CONFIRMED, OrderStatus.PREPARING, expect.any(Function), {});
    });

    it('rejects a customer cancelling someone else\'s order', async () => {
      orders.findById.mockResolvedValue(baseOrder);
      await expect(
        service.updateStatus('order-1', 'not-the-customer', UserRole.CUSTOMER, {
          status: OrderStatus.CANCELLED,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects a different customer before the same-status idempotent return', async () => {
      orders.findById.mockResolvedValue(baseOrder);

      await expect(
        service.updateStatus('order-1', 'not-the-customer', UserRole.CUSTOMER, {
          status: OrderStatus.CREATED,
        }),
      ).rejects.toThrow(ForbiddenError);

      expect(orders.updateStatus).not.toHaveBeenCalled();
    });

    it('allows ADMIN to force any valid transition', async () => {
      orders.findById.mockResolvedValue(baseOrder);
      orders.updateStatus.mockResolvedValue({ ...baseOrder, status: OrderStatus.PAYMENT_PENDING });

      const result = await service.updateStatus('order-1', 'admin-1', UserRole.ADMIN, {
        status: OrderStatus.PAYMENT_PENDING,
      });
      expect(result.status).toBe(OrderStatus.PAYMENT_PENDING);
    });

    it('checks restaurant ownership before letting an owner transition PREPARING', async () => {
      orders.findById.mockResolvedValue({ ...baseOrder, status: OrderStatus.CONFIRMED });
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      orders.updateStatus.mockResolvedValue({ ...baseOrder, status: OrderStatus.PREPARING });

      const result = await service.updateStatus('order-1', 'owner-1', UserRole.RESTAURANT_OWNER, {
        status: OrderStatus.PREPARING,
      });

      expect(restaurantClient.assertOwnership).toHaveBeenCalledWith('rest-1', 'owner-1');
      expect(result.status).toBe(OrderStatus.PREPARING);
    });

    it('rejects a foreign restaurant owner before mutating status', async () => {
      orders.findById.mockResolvedValue({ ...baseOrder, status: OrderStatus.CONFIRMED });
      restaurantClient.assertOwnership.mockRejectedValue(
        new ForbiddenError('You do not own this restaurant'),
      );

      await expect(
        service.updateStatus('order-1', 'owner-2', UserRole.RESTAURANT_OWNER, {
          status: OrderStatus.PREPARING,
        }),
      ).rejects.toThrow(ForbiddenError);
      expect(orders.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('payment events', () => {
    const withStatus = (status: OrderStatus) => ({ ...baseOrder, status });

    /** Registers the consumers and returns the handler subscribed to a payment event type. */
    async function handlerFor(eventType: PaymentEventType) {
      await service.onModuleInit();
      const call = kafkaConsumer.subscribe.mock.calls.find(([, type]) => type === eventType);
      return call![2] as (event: { payload: { orderId: string } }) => Promise<void>;
    }

    it('payment.failed moves a PAYMENT_PENDING order to FAILED (not CANCELLED) and publishes order.failed', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.PAYMENT_PENDING) as any);
      orders.updateStatus.mockResolvedValue(withStatus(OrderStatus.FAILED) as any);

      await (await handlerFor(PaymentEventType.FAILED))({ payload: { orderId: 'order-1' } });

      expect(orders.updateStatus).toHaveBeenCalledWith('order-1', OrderStatus.PAYMENT_PENDING, OrderStatus.FAILED, expect.any(Function), {
        cancelledBy: 'PAYMENT',
        cancellationReason: 'Your payment was declined, so the order was not placed.',
      });
      expect(orders.recordPaymentStatus).toHaveBeenCalledWith('order-1', 'FAILED');
      expect((await staged())[0].eventType).toBe(OrderEventType.FAILED);
    });

    it('records the payment status from each payment event, even when the order has moved on (#143)', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.CANCELLED) as any);

      await (await handlerFor(PaymentEventType.CREATED))({ payload: { orderId: 'order-1' } });
      await (await handlerFor(PaymentEventType.COMPLETED))({ payload: { orderId: 'order-1' } });

      expect(orders.recordPaymentStatus).toHaveBeenNthCalledWith(1, 'order-1', 'PENDING');
      expect(orders.recordPaymentStatus).toHaveBeenNthCalledWith(2, 'order-1', 'COMPLETED');
      expect(orders.updateStatus).not.toHaveBeenCalled();
    });

    it('payment.completed confirms the order', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.PAYMENT_PENDING) as any);
      orders.updateStatus.mockResolvedValue(withStatus(OrderStatus.CONFIRMED) as any);

      await (await handlerFor(PaymentEventType.COMPLETED))({ payload: { orderId: 'order-1' } });

      expect(orders.updateStatus).toHaveBeenCalledWith('order-1', OrderStatus.PAYMENT_PENDING, OrderStatus.CONFIRMED, expect.any(Function), {});
      expect((await staged())[0].eventType).toBe(OrderEventType.CONFIRMED);
    });

    it('a duplicate payment.failed (order already FAILED via the HTTP sync) is a no-op', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.FAILED) as any);

      await service.syncStatusFromEvent('order-1', OrderStatus.FAILED);

      expect(orders.updateStatus).not.toHaveBeenCalled();
      expect(await staged()).toHaveLength(0);
    });

    it('a late payment.failed after the customer cancelled is skipped instead of failing the consumer', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.CANCELLED) as any);

      await expect(service.syncStatusFromEvent('order-1', OrderStatus.FAILED)).resolves.toBeUndefined();
      expect(orders.updateStatus).not.toHaveBeenCalled();
    });

    it('a stale payment.created arriving after confirmation is skipped', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.CONFIRMED) as any);

      await service.syncStatusFromEvent('order-1', OrderStatus.PAYMENT_PENDING);

      expect(orders.updateStatus).not.toHaveBeenCalled();
    });

    it('ignores events for unknown orders', async () => {
      orders.findById.mockResolvedValue(null);
      await expect(service.syncStatusFromEvent('missing', OrderStatus.FAILED)).resolves.toBeUndefined();
    });

    it('stages order.confirmed once when two writers race to CONFIRMED (compare-and-set)', async () => {
      // Both writers read PAYMENT_PENDING; the database lets only the first update through.
      orders.findById
        .mockResolvedValueOnce(withStatus(OrderStatus.PAYMENT_PENDING) as any)
        .mockResolvedValueOnce(withStatus(OrderStatus.PAYMENT_PENDING) as any)
        .mockResolvedValue(withStatus(OrderStatus.CONFIRMED) as any);
      orders.updateStatus
        .mockResolvedValueOnce(withStatus(OrderStatus.CONFIRMED) as any)
        .mockResolvedValueOnce(null);

      await Promise.all([
        service.updateStatus('order-1', 'system', UserRole.ADMIN, { status: OrderStatus.CONFIRMED }),
        service.updateStatus('order-1', 'system', UserRole.ADMIN, { status: OrderStatus.CONFIRMED }),
      ]);

      const confirmed = (await staged()).filter((e) => e.eventType === OrderEventType.CONFIRMED);
      expect(confirmed).toHaveLength(1);
    });

    it('rejects when another writer moved the order somewhere else in between', async () => {
      orders.findById
        .mockResolvedValueOnce(withStatus(OrderStatus.PAYMENT_PENDING) as any)
        .mockResolvedValue(withStatus(OrderStatus.CANCELLED) as any);
      orders.updateStatus.mockResolvedValueOnce(null);

      await expect(
        service.updateStatus('order-1', 'system', UserRole.ADMIN, { status: OrderStatus.CONFIRMED }),
      ).rejects.toThrow(InvalidStateTransitionError);
      expect(await staged()).toHaveLength(0);
    });

    it('labels the PAYMENT_PENDING transition as order.payment_pending, not order.created', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.CREATED) as any);
      orders.updateStatus.mockResolvedValue(withStatus(OrderStatus.PAYMENT_PENDING) as any);

      await service.syncStatusFromEvent('order-1', OrderStatus.PAYMENT_PENDING);

      expect((await staged())[0].eventType).toBe(OrderEventType.PAYMENT_PENDING);
    });
  });

  describe('delivery events', () => {
    const withStatus = (status: OrderStatus) => ({ ...baseOrder, status });

    async function handlerFor(eventType: DeliveryEventType) {
      await service.onModuleInit();
      const call = kafkaConsumer.subscribe.mock.calls.find(([, type]) => type === eventType);
      return call![2] as (event: { payload: { orderId: string } }) => Promise<void>;
    }

    it('delivery.driver_assigned moves a READY_FOR_PICKUP order on (event arrived before the HTTP sync)', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.READY_FOR_PICKUP) as any);
      orders.updateStatus.mockResolvedValue(withStatus(OrderStatus.DRIVER_ASSIGNED) as any);

      await (await handlerFor(DeliveryEventType.DRIVER_ASSIGNED))({ payload: { orderId: 'order-1' } });

      expect(orders.updateStatus).toHaveBeenCalledWith(
        'order-1',
        OrderStatus.READY_FOR_PICKUP,
        OrderStatus.DRIVER_ASSIGNED, expect.any(Function), {});
    });

    it('delivery.completed after the HTTP sync already delivered the order is a no-op', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.DELIVERED) as any);

      await (await handlerFor(DeliveryEventType.COMPLETED))({ payload: { orderId: 'order-1' } });

      expect(orders.updateStatus).not.toHaveBeenCalled();
      expect(await staged()).toHaveLength(0);
    });

    it('a late delivery.driver_assigned once the order is picked up is skipped, not dead-lettered', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.PICKED_UP) as any);

      await expect(
        (await handlerFor(DeliveryEventType.DRIVER_ASSIGNED))({ payload: { orderId: 'order-1' } }),
      ).resolves.toBeUndefined();
      expect(orders.updateStatus).not.toHaveBeenCalled();
    });
  });

  describe('event identity', () => {
    it('uses a stable eventId per (order, event type), so a re-publish dedupes downstream', async () => {
      orders.findById.mockResolvedValue({ ...baseOrder, status: OrderStatus.CONFIRMED } as any);
      orders.updateStatus.mockResolvedValue({ ...baseOrder, status: OrderStatus.PREPARING } as any);

      await service.updateStatus('order-1', 'system', UserRole.ADMIN, { status: OrderStatus.PREPARING });

      expect((await staged())[0].eventId).toBe(
        lifecycleEventId('order-1', OrderEventType.PREPARING),
      );
    });
  });

  describe('listByRestaurant', () => {
    it('checks ownership before listing', async () => {
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      orders.findByRestaurant.mockResolvedValue([[baseOrder], 1]);

      const result = await service.listByRestaurant('rest-1', 'owner-1', 1, 20);
      expect(result.total).toBe(1);
      expect(restaurantClient.assertOwnership).toHaveBeenCalledWith('rest-1', 'owner-1');
    });

    it('rejects a foreign restaurant owner before listing orders', async () => {
      restaurantClient.assertOwnership.mockRejectedValue(
        new ForbiddenError('You do not own this restaurant'),
      );

      await expect(service.listByRestaurant('rest-1', 'owner-2', 1, 20)).rejects.toThrow(
        ForbiddenError,
      );
      expect(orders.findByRestaurant).not.toHaveBeenCalled();
    });
  });

  describe('listByCustomer filters (#143)', () => {
    it.each([
      ['completed', [OrderStatus.DELIVERED]],
      ['cancelled', [OrderStatus.CANCELLED, OrderStatus.FAILED]],
    ] as const)('maps %s to order statuses', async (filter, statuses) => {
      orders.findByCustomer.mockResolvedValue([[], 0]);
      await service.listByCustomer('customer-1', 2, 10, filter);
      expect(orders.findByCustomer).toHaveBeenCalledWith('customer-1', 2, 10, statuses);
    });

    it('lists every order without a filter', async () => {
      orders.findByCustomer.mockResolvedValue([[], 0]);
      await expect(service.listByCustomer('customer-1', 1, 20)).resolves.toMatchObject({ total: 0, totalPages: 1 });
      expect(orders.findByCustomer).toHaveBeenCalledWith('customer-1', 1, 20, null);
    });
  });

  describe('delivery fee (#145)', () => {
    it('prices the order at checkout: items + flat fee, with the split stored as a snapshot', async () => {
      cartClient.getCart.mockResolvedValue({
        userId: 'customer-1',
        restaurantId: 'restaurant-1',
        items: [{ menuItemId: 'i1', name: 'Burger', price: 100, quantity: 2 }],
        total: 200,
      } as any);
      restaurantClient.getRestaurant.mockResolvedValue({ id: 'restaurant-1', status: 'OPEN' } as any);
      orders.create.mockResolvedValue({ ...baseOrder, id: 'order-1', driverFeeShare: '12.50', platformFeeShare: '12.50', driverCancelFeeShare: '6.25' } as any);

      const created = await service.createFromCart('customer-1', 'Bearer x', undefined, { deliveryAddress: '1 Test Street' } as any);

      // The internal split never goes back to the customer.
      expect(Object.keys(created)).not.toEqual(expect.arrayContaining(['driverFeeShare']));
      expect(created).not.toHaveProperty('platformFeeShare');
      expect(created).not.toHaveProperty('driverCancelFeeShare');

      expect(orders.create.mock.calls[0][3]).toEqual({
        subtotalAmount: '200.00',
        deliveryFee: '25.00',
        totalAmount: '225.00',
        driverFeeShare: '12.50',
        platformFeeShare: '12.50',
        driverCancelFeeShare: '6.25',
      });
    });

    it('quotes the current cart with the same rules, without the internal split', async () => {
      cartClient.getCart.mockResolvedValue({ userId: 'customer-1', restaurantId: 'r', items: [{}], total: 19.98 } as any);
      await expect(service.quote('Bearer x')).resolves.toEqual({
        subtotalAmount: '19.98',
        deliveryFee: '25.00',
        totalAmount: '44.98',
        currency: 'EGP',
      });
    });

    it('quotes an empty cart as no items, fee still shown', async () => {
      cartClient.getCart.mockResolvedValue({ userId: 'customer-1', restaurantId: null, items: [], total: 0 } as any);
      await expect(service.quote('Bearer x')).resolves.toMatchObject({ subtotalAmount: '0.00', totalAmount: '25.00' });
    });

    it('reads the internal fee split for delivery-service, defaulting older orders to zero', async () => {
      orders.findFeeSplit.mockResolvedValueOnce({ id: 'order-1', deliveryFee: '25.00', driverFeeShare: '12.50', platformFeeShare: '12.50', driverCancelFeeShare: '6.25' } as any);
      await expect(service.getFeeSplit('order-1')).resolves.toEqual({
        orderId: 'order-1',
        deliveryFee: '25.00',
        driverFeeShare: '12.50',
        platformFeeShare: '12.50',
        driverCancelFeeShare: '6.25',
      });

      orders.findFeeSplit.mockResolvedValueOnce({ id: 'old', deliveryFee: null, driverFeeShare: null, platformFeeShare: null, driverCancelFeeShare: null } as any);
      await expect(service.getFeeSplit('old')).resolves.toMatchObject({ deliveryFee: '0.00', driverFeeShare: '0.00' });

      orders.findFeeSplit.mockResolvedValueOnce(null);
      await expect(service.getFeeSplit('nope')).rejects.toThrow(NotFoundError);
    });
  });

  describe('restaurant operations (#154)', () => {
    it.each([OrderStatus.PREPARING, OrderStatus.READY_FOR_PICKUP])('stops a restaurant rejecting an order once it is %s', async (status) => {
      orders.findById.mockResolvedValue({ ...baseOrder, status } as any);

      await expect(
        service.updateStatus('order-1', 'owner-1', UserRole.RESTAURANT_OWNER, { status: OrderStatus.CANCELLED, reason: 'Too late' }),
      ).rejects.toThrow('An order can only be rejected before you start preparing it.');
      expect(orders.updateStatus).not.toHaveBeenCalled();
    });

    it('carries the reason on the order.cancelled event', async () => {
      orders.findById.mockResolvedValue({ ...baseOrder, status: OrderStatus.CONFIRMED } as any);
      orders.updateStatus.mockImplementation(async (_id, _from, to, event, outcome) => {
        const changed = { ...baseOrder, status: to, ...outcome } as any;
        (orders as any).lastEvent = event(changed);
        return changed;
      });

      await service.updateStatus('order-1', 'owner-1', UserRole.RESTAURANT_OWNER, { status: OrderStatus.CANCELLED, reason: 'Out of falafel' });

      expect((orders as any).lastEvent.payload).toMatchObject({
        cancelledBy: 'RESTAURANT',
        cancellationReason: 'The restaurant cancelled this order: Out of falafel',
      });
    });

    it("snapshots only the customer's first name at checkout, and never fails checkout over it", async () => {
      cartClient.getCart.mockResolvedValue({ userId: 'customer-1', restaurantId: 'restaurant-1', items: [{ menuItemId: 'i1', name: 'Koshary', price: 45, quantity: 1 }], total: 45 } as any);
      restaurantClient.getRestaurant.mockResolvedValue({ id: 'restaurant-1', status: 'OPEN' } as any);
      orders.create.mockResolvedValue({ ...baseOrder } as any);
      userClient.getOwnProfile.mockResolvedValue({ id: 'customer-1', fullName: '  Mona Ahmed Ali ', address: 'x' } as any);

      await service.createFromCart('customer-1', 'Bearer x', undefined, { deliveryAddress: '1 Test Street' } as any);
      expect(orders.create.mock.calls[0][7]).toBe('Mona');

      userClient.getOwnProfile.mockRejectedValue(new Error('user-service down'));
      await service.createFromCart('customer-1', 'Bearer x', undefined, { deliveryAddress: '1 Test Street' } as any);
      expect(orders.create.mock.calls[1][7]).toBeNull();
    });

    it("reports today's summary only to the restaurant's owner", async () => {
      (orders as any).todaySummary = jest.fn().mockResolvedValue({ orders: 3, active: 1, delivered: 1, cancelled: 1, revenue: '90.00' });

      await expect(service.todaySummary('restaurant-1', 'owner-1')).resolves.toMatchObject({ orders: 3, revenue: '90.00', timezone: 'Africa/Cairo', currency: 'EGP' });
      expect(restaurantClient.assertOwnership).toHaveBeenCalledWith('restaurant-1', 'owner-1');
    });
  });
});
