import { OrdersService } from './orders.service';
import { OrdersRepository } from '../repositories/orders.repository';
import { CartServiceClient } from '../common/cart-service.client';
import { RestaurantServiceClient } from '../common/restaurant-service.client';
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
  let kafkaProducer: { publish: jest.Mock };
  let kafkaConsumer: { subscribe: jest.Mock; start: jest.Mock };

  const baseOrder = {
    id: 'order-1',
    customerId: 'customer-1',
    restaurantId: 'rest-1',
    status: OrderStatus.CREATED,
    totalAmount: '19.98',
    items: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    orders = {
      findById: jest.fn(),
      create: jest.fn(),
      updateStatus: jest.fn(),
      findByCustomer: jest.fn(),
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

    kafkaProducer = { publish: jest.fn() };
    kafkaConsumer = { subscribe: jest.fn(), start: jest.fn() };
    service = new OrdersService(
      orders,
      cartClient,
      restaurantClient,
      kafkaProducer as any,
      kafkaConsumer as any,
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
        ownerId: 'owner-1',
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
        ownerId: 'owner-1',
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
        ownerId: 'owner-1',
        name: 'X',
        status: RestaurantStatus.OPEN,
      });
      orders.create.mockRejectedValueOnce(new Error('duplicate key'));
      orders.findByCustomerAndIdempotencyKey.mockResolvedValue(existing);

      const result = await (service as any).createFromCart('customer-1', 'Bearer x', 'key-1');

      expect(result.id).toBe('order-existing');
      expect(cartClient.clearCart).not.toHaveBeenCalled();
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

      expect(orders.updateStatus).toHaveBeenCalledWith('order-1', OrderStatus.PAYMENT_PENDING, OrderStatus.FAILED);
      expect(kafkaProducer.publish.mock.calls[0][1].eventType).toBe(OrderEventType.FAILED);
    });

    it('payment.completed confirms the order', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.PAYMENT_PENDING) as any);
      orders.updateStatus.mockResolvedValue(withStatus(OrderStatus.CONFIRMED) as any);

      await (await handlerFor(PaymentEventType.COMPLETED))({ payload: { orderId: 'order-1' } });

      expect(orders.updateStatus).toHaveBeenCalledWith('order-1', OrderStatus.PAYMENT_PENDING, OrderStatus.CONFIRMED);
      expect(kafkaProducer.publish.mock.calls[0][1].eventType).toBe(OrderEventType.CONFIRMED);
    });

    it('a duplicate payment.failed (order already FAILED via the HTTP sync) is a no-op', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.FAILED) as any);

      await service.syncStatusFromEvent('order-1', OrderStatus.FAILED);

      expect(orders.updateStatus).not.toHaveBeenCalled();
      expect(kafkaProducer.publish).not.toHaveBeenCalled();
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

    it('publishes order.confirmed once when two writers race to CONFIRMED (compare-and-set)', async () => {
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

      const confirmed = kafkaProducer.publish.mock.calls.filter(([, e]) => e.eventType === OrderEventType.CONFIRMED);
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
      expect(kafkaProducer.publish).not.toHaveBeenCalled();
    });

    it('labels the PAYMENT_PENDING transition as order.payment_pending, not order.created', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.CREATED) as any);
      orders.updateStatus.mockResolvedValue(withStatus(OrderStatus.PAYMENT_PENDING) as any);

      await service.syncStatusFromEvent('order-1', OrderStatus.PAYMENT_PENDING);

      expect(kafkaProducer.publish.mock.calls[0][1].eventType).toBe(OrderEventType.PAYMENT_PENDING);
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
        OrderStatus.DRIVER_ASSIGNED,
      );
    });

    it('delivery.completed after the HTTP sync already delivered the order is a no-op', async () => {
      orders.findById.mockResolvedValue(withStatus(OrderStatus.DELIVERED) as any);

      await (await handlerFor(DeliveryEventType.COMPLETED))({ payload: { orderId: 'order-1' } });

      expect(orders.updateStatus).not.toHaveBeenCalled();
      expect(kafkaProducer.publish).not.toHaveBeenCalled();
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

      expect(kafkaProducer.publish.mock.calls[0][1].eventId).toBe(
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
  });
});
