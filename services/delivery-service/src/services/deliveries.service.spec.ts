import { DeliveriesService } from './deliveries.service';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { OrderServiceClient } from '../common/order-service.client';
import { DriverServiceClient, DriverStatusRejectedError } from '../common/driver-service.client';
import { Delivery } from '../entities/delivery.entity';
import { RestaurantServiceClient } from '../common/restaurant-service.client';
import { OutboxRelayService } from '../common/outbox-relay.service';
import {
  BadRequestError,
  ConflictError,
  DeliveryEventType,
  DeliveryStatus,
  DriverStatus,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  OrderStatus,
  TOPICS,
  UserRole,
  lifecycleEventId,
} from '@food-delivery/shared';

/** order-service's view of order-1 at a given status. */
const orderAt = (status: OrderStatus) => ({ id: 'order-1', customerId: 'c1', restaurantId: 'r1', status });

/** A requester as the controller builds it from the JWT and Authorization header. */
const actor = (role: UserRole, userId = 'user-1') => ({ userId, role, authHeader: 'Bearer user' });

describe('DeliveriesService', () => {
  let service: DeliveriesService;
  let deliveries: jest.Mocked<DeliveriesRepository>;
  let orderClient: jest.Mocked<OrderServiceClient>;
  let driverClient: jest.Mocked<DriverServiceClient>;
  let outbox: { kick: jest.Mock };
  let restaurantClient: jest.Mocked<RestaurantServiceClient>;

  const baseDelivery = {
    id: 'delivery-1',
    orderId: 'order-1',
    driverId: undefined,
    status: DeliveryStatus.CREATED,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  /**
   * The [topic, event] pairs the repository staged in the outbox: create/transition call the event
   * builder they are given with the delivery they wrote, in the same transaction, only when the write
   * succeeded (a lost compare-and-set returns null and stages nothing).
   */
  async function staged(): Promise<Array<[string, { eventId: string; eventType: string; payload: Record<string, unknown> }]>> {
    const out: Array<[string, { eventId: string; eventType: string; payload: Record<string, unknown> }]> = [];
    const calls: Array<[jest.Mock, number]> = [
      [deliveries.create as unknown as jest.Mock, 2],
      [deliveries.transition as unknown as jest.Mock, 3],
    ];
    const recorded: Array<{ order: number; pair: [string, { eventId: string; eventType: string; payload: Record<string, unknown> }] }> = [];
    for (const [mock, builderIndex] of calls) {
      for (const [i, args] of mock.mock.calls.entries()) {
        const written = await Promise.resolve(mock.mock.results[i]?.value).catch(() => null);
        const build = args[builderIndex];
        if (written && typeof build === 'function') {
          recorded.push({ order: mock.mock.invocationCallOrder[i], pair: [TOPICS.DELIVERY_EVENTS, build(written)] });
        }
      }
    }
    recorded.sort((a, b) => a.order - b.order).forEach((r) => out.push(r.pair));
    return out;
  }

  beforeEach(() => {
    deliveries = {
      findById: jest.fn(),
      findByOrderId: jest.fn(),
      findActiveByDriverId: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      transition: jest.fn(),
    } as unknown as jest.Mocked<DeliveriesRepository>;

    orderClient = {
      getOrder: jest.fn().mockResolvedValue(orderAt(OrderStatus.READY_FOR_PICKUP)),
      assertReadableBy: jest.fn(),
      updateOrderStatus: jest.fn(),
    } as unknown as jest.Mocked<OrderServiceClient>;

    driverClient = {
      getDriver: jest.fn(),
      getOwnProfile: jest.fn(),
      findAvailableDriver: jest.fn(),
      updateDriverStatus: jest.fn(),
      releaseDriver: jest.fn(),
    } as unknown as jest.Mocked<DriverServiceClient>;

    outbox = { kick: jest.fn() };
    restaurantClient = { getRestaurant: jest.fn() } as unknown as jest.Mocked<RestaurantServiceClient>;
    service = new DeliveriesService(
      deliveries,
      orderClient,
      driverClient,
      outbox as unknown as OutboxRelayService,
      restaurantClient,
    );
  });

  describe('create', () => {
    it('rejects non-dispatch roles', async () => {
      await expect(
        service.create(actor(UserRole.CUSTOMER), { orderId: 'order-1' }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects when a delivery already exists for the order', async () => {
      deliveries.findByOrderId.mockResolvedValue(baseDelivery);
      await expect(
        service.create(actor(UserRole.ADMIN), { orderId: 'order-1' }),
      ).rejects.toThrow(ConflictError);
    });

    it('rejects when order is not READY_FOR_PICKUP', async () => {
      deliveries.findByOrderId.mockResolvedValue(null);
      orderClient.getOrder.mockResolvedValue({
        id: 'order-1',
        customerId: 'c1',
        restaurantId: 'r1',
        status: OrderStatus.PREPARING,
      });

      await expect(
        service.create(actor(UserRole.RESTAURANT_OWNER), { orderId: 'order-1' }),
      ).rejects.toThrow(BadRequestError);
    });

    it('creates a delivery when order is READY_FOR_PICKUP', async () => {
      deliveries.findByOrderId.mockResolvedValue(null);
      orderClient.getOrder.mockResolvedValue({
        id: 'order-1',
        customerId: 'c1',
        restaurantId: 'r1',
        status: OrderStatus.READY_FOR_PICKUP,
      });
      deliveries.create.mockResolvedValue(baseDelivery);

      const result = await service.create(actor(UserRole.ADMIN), { orderId: 'order-1' });
      expect(result.id).toBe('delivery-1');
    });

    it('answers 409 (not 500) when a concurrent create wins the unique orderId index', async () => {
      deliveries.findByOrderId.mockResolvedValue(null);
      deliveries.create.mockRejectedValue(Object.assign(new Error('duplicate key'), { driverError: { code: '23505' } }));

      await expect(service.create(actor(UserRole.ADMIN), { orderId: 'order-1' })).rejects.toThrow(ConflictError);
      expect(await staged()).toHaveLength(0);
    });

    it('does not mask other database errors', async () => {
      deliveries.findByOrderId.mockResolvedValue(null);
      deliveries.create.mockRejectedValue(new Error('connection lost'));

      await expect(service.create(actor(UserRole.ADMIN), { orderId: 'order-1' })).rejects.toThrow('connection lost');
    });
  });

  describe('assignDriver', () => {
    it('rejects when no driver is available', async () => {
      deliveries.findById.mockResolvedValue(baseDelivery);
      driverClient.findAvailableDriver.mockResolvedValue(null);

      await expect(service.assignDriver('delivery-1', actor(UserRole.ADMIN))).rejects.toThrow(
        ConflictError,
      );
    });

    it('assigns the driver, marks them BUSY, and updates the order', async () => {
      deliveries.findById.mockResolvedValue(baseDelivery);
      driverClient.findAvailableDriver.mockResolvedValue({
        id: 'driver-1',
        userId: 'user-1',
        status: DriverStatus.AVAILABLE,
      });
      deliveries.transition.mockResolvedValue({
        ...baseDelivery,
        driverId: 'driver-1',
        status: DeliveryStatus.DRIVER_ASSIGNED,
      });

      const result = await service.assignDriver('delivery-1', actor(UserRole.ADMIN));

      expect(driverClient.updateDriverStatus).toHaveBeenCalledWith('driver-1', DriverStatus.BUSY);
      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.DRIVER_ASSIGNED);
      expect(result.status).toBe(DeliveryStatus.DRIVER_ASSIGNED);
    });

    describe('when another assignment claims the same driver first', () => {
      const driverA = { id: 'driver-a', userId: 'user-a', status: DriverStatus.AVAILABLE };
      const driverB = { id: 'driver-b', userId: 'user-b', status: DriverStatus.AVAILABLE };

      beforeEach(() => {
        deliveries.findById.mockResolvedValue(baseDelivery);
        deliveries.transition.mockImplementation(async (_id, _from, data) => ({ ...baseDelivery, ...data }) as Delivery);
      });

      it('moves on to the next available driver', async () => {
        driverClient.findAvailableDriver.mockResolvedValueOnce(driverA).mockResolvedValueOnce(driverB);
        driverClient.updateDriverStatus
          .mockRejectedValueOnce(new DriverStatusRejectedError('driver-a', DriverStatus.BUSY))
          .mockResolvedValueOnce(undefined);

        const result = await service.assignDriver('delivery-1', actor(UserRole.ADMIN));

        expect(result.driverId).toBe('driver-b');
        expect(deliveries.transition).toHaveBeenCalledWith('delivery-1', DeliveryStatus.CREATED, {
          driverId: 'driver-b',
          status: DeliveryStatus.DRIVER_ASSIGNED,
        }, expect.any(Function));
        // The driver it lost is not "given back": it belongs to the assignment that won.
        expect(driverClient.releaseDriver).not.toHaveBeenCalled();
      });

      it('gives up with 409 after a bounded number of lost claims', async () => {
        driverClient.findAvailableDriver.mockResolvedValue(driverA);
        driverClient.updateDriverStatus.mockRejectedValue(new DriverStatusRejectedError('driver-a', DriverStatus.BUSY));

        await expect(service.assignDriver('delivery-1', actor(UserRole.ADMIN))).rejects.toThrow(
          'No available drivers to assign',
        );
        expect(driverClient.updateDriverStatus).toHaveBeenCalledTimes(3);
        expect(deliveries.transition).not.toHaveBeenCalled();
      });

      it('does not retry on other driver-service failures', async () => {
        driverClient.findAvailableDriver.mockResolvedValue(driverA);
        driverClient.updateDriverStatus.mockRejectedValue(new Error('driver-service down'));

        await expect(service.assignDriver('delivery-1', actor(UserRole.ADMIN))).rejects.toThrow('driver-service down');
        expect(driverClient.updateDriverStatus).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('getCurrentForDriver', () => {
    const me = { id: 'driver-1', userId: 'user-1', status: DriverStatus.BUSY };
    const assigned = { ...baseDelivery, driverId: 'driver-1', status: DeliveryStatus.DRIVER_ASSIGNED } as Delivery;
    const fullOrder = {
      ...orderAt(OrderStatus.DRIVER_ASSIGNED),
      totalAmount: '19.98',
      items: [{ name: 'Burger', quantity: 2, price: '9.99' }],
      deliveryAddress: '9 Nile Corniche',
      deliveryNotes: 'Gate 42',
      deliveryLatitude: 30.0444,
      deliveryLongitude: 31.2357,
    };

    beforeEach(() => {
      driverClient.getOwnProfile.mockResolvedValue(me);
      orderClient.getOrder.mockResolvedValue(fullOrder);
      restaurantClient.getRestaurant.mockResolvedValue({ id: 'r1', name: 'Burger Palace', address: '123 Main St' });
    });

    it('returns the assigned delivery with pickup, drop-off, order summary and the next action', async () => {
      deliveries.findActiveByDriverId.mockResolvedValue([assigned]);

      const current = await service.getCurrentForDriver('Bearer driver');

      expect(driverClient.getOwnProfile).toHaveBeenCalledWith('Bearer driver');
      expect(deliveries.findActiveByDriverId).toHaveBeenCalledWith('driver-1');
      expect(orderClient.getOrder).toHaveBeenCalledWith('order-1');
      expect(restaurantClient.getRestaurant).toHaveBeenCalledWith('r1');
      expect(current).toEqual({
        id: 'delivery-1',
        status: DeliveryStatus.DRIVER_ASSIGNED,
        orderId: 'order-1',
        createdAt: assigned.createdAt,
        updatedAt: assigned.updatedAt,
        pickup: { restaurantId: 'r1', name: 'Burger Palace', address: '123 Main St' },
        dropOff: { address: '9 Nile Corniche', notes: 'Gate 42', latitude: 30.0444, longitude: 31.2357 },
        order: { id: 'order-1', items: [{ name: 'Burger', quantity: 2 }], totalAmount: '19.98' },
        nextActions: ['pickup'],
      });
    });

    it.each([
      [DeliveryStatus.PICKED_UP, ['start']],
      [DeliveryStatus.IN_TRANSIT, ['complete']],
    ])('offers the next driver action for %s', async (status, actions) => {
      deliveries.findActiveByDriverId.mockResolvedValue([{ ...assigned, status }]);
      await expect(service.getCurrentForDriver('Bearer driver')).resolves.toMatchObject({ nextActions: actions });
    });

    it('returns null when the driver has no active delivery (terminal ones are excluded by the query)', async () => {
      deliveries.findActiveByDriverId.mockResolvedValue([]);

      await expect(service.getCurrentForDriver('Bearer driver')).resolves.toBeNull();
      expect(orderClient.getOrder).not.toHaveBeenCalled();
    });

    it('returns null when the user has no driver profile yet', async () => {
      driverClient.getOwnProfile.mockResolvedValue(null);

      await expect(service.getCurrentForDriver('Bearer driver')).resolves.toBeNull();
      expect(deliveries.findActiveByDriverId).not.toHaveBeenCalled();
    });

    it('returns the most recent one if drift ever leaves two active deliveries', async () => {
      const older = { ...assigned, id: 'older', updatedAt: new Date('2026-01-01') } as Delivery;
      const newer = { ...assigned, id: 'newer', updatedAt: new Date('2026-02-01') } as Delivery;
      deliveries.findActiveByDriverId.mockResolvedValue([older, newer]);

      await expect(service.getCurrentForDriver('Bearer driver')).resolves.toMatchObject({ id: 'newer' });
    });

    it('reports a null drop-off address for orders placed before addresses were stored', async () => {
      deliveries.findActiveByDriverId.mockResolvedValue([assigned]);
      orderClient.getOrder.mockResolvedValue(orderAt(OrderStatus.DRIVER_ASSIGNED));

      await expect(service.getCurrentForDriver('Bearer driver')).resolves.toMatchObject({
        dropOff: { address: null, notes: null, latitude: null, longitude: null },
        order: { items: [] },
      });
    });
  });

  describe('pickup', () => {
    it('rejects a driver who is not the assigned one', async () => {
      deliveries.findById.mockResolvedValue({
        ...baseDelivery,
        driverId: 'driver-1',
        status: DeliveryStatus.DRIVER_ASSIGNED,
      });
      driverClient.getDriver.mockResolvedValue({ id: 'driver-1', userId: 'user-1', status: DriverStatus.BUSY });

      await expect(
        service.pickup('delivery-1', 'someone-else', UserRole.DRIVER),
      ).rejects.toThrow(ForbiddenError);
    });

    it('allows the assigned driver to mark pickup and updates the order', async () => {
      deliveries.findById.mockResolvedValue({
        ...baseDelivery,
        driverId: 'driver-1',
        status: DeliveryStatus.DRIVER_ASSIGNED,
      });
      driverClient.getDriver.mockResolvedValue({ id: 'driver-1', userId: 'user-1', status: DriverStatus.BUSY });
      deliveries.transition.mockResolvedValue({
        ...baseDelivery,
        driverId: 'driver-1',
        status: DeliveryStatus.PICKED_UP,
      });

      const result = await service.pickup('delivery-1', 'user-1', UserRole.DRIVER);

      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.PICKED_UP);
      expect(result.status).toBe(DeliveryStatus.PICKED_UP);
    });

    it('rejects an invalid transition (e.g. pickup before assignment)', async () => {
      deliveries.findById.mockResolvedValue(baseDelivery); // status CREATED, no driver
      await expect(
        service.pickup('delivery-1', 'user-1', UserRole.DRIVER),
      ).rejects.toThrow(ConflictError); // no driver assigned yet
    });
  });

  describe('complete', () => {
    it('releases the driver back to AVAILABLE', async () => {
      deliveries.findById.mockResolvedValue({
        ...baseDelivery,
        driverId: 'driver-1',
        status: DeliveryStatus.IN_TRANSIT,
      });
      driverClient.getDriver.mockResolvedValue({ id: 'driver-1', userId: 'user-1', status: DriverStatus.BUSY });
      deliveries.transition.mockResolvedValue({
        ...baseDelivery,
        driverId: 'driver-1',
        status: DeliveryStatus.DELIVERED,
      });

      const result = await service.complete('delivery-1', 'user-1', UserRole.DRIVER);

      expect(driverClient.releaseDriver).toHaveBeenCalledWith('driver-1');
      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.DELIVERED);
      expect(result.status).toBe(DeliveryStatus.DELIVERED);
    });
  });

  describe('cancel', () => {
    it('rejects non-dispatch roles', async () => {
      await expect(service.cancel('delivery-1', actor(UserRole.DRIVER))).rejects.toThrow(ForbiddenError);
    });

    it('cancels and releases the driver if one was assigned', async () => {
      deliveries.findById.mockResolvedValue({
        ...baseDelivery,
        driverId: 'driver-1',
        status: DeliveryStatus.DRIVER_ASSIGNED,
      });
      deliveries.transition.mockResolvedValue({
        ...baseDelivery,
        driverId: 'driver-1',
        status: DeliveryStatus.CANCELLED,
      });

      const result = await service.cancel('delivery-1', actor(UserRole.ADMIN));

      expect(driverClient.releaseDriver).toHaveBeenCalledWith('driver-1');
      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.CANCELLED);
      expect(result.status).toBe(DeliveryStatus.CANCELLED);
    });
  });

  describe('delivery events', () => {
    const assignedDriver = { id: 'driver-1', userId: 'user-1', status: DriverStatus.BUSY };
    const at = (status: DeliveryStatus) => ({ ...baseDelivery, driverId: 'driver-1', status });

    /** Each transition, with the delivery it starts from and the event it must publish. */
    const transitions: Array<[string, DeliveryStatus, DeliveryStatus, DeliveryEventType, () => Promise<unknown>]> = [
      ['assignDriver', DeliveryStatus.CREATED, DeliveryStatus.DRIVER_ASSIGNED, DeliveryEventType.DRIVER_ASSIGNED,
        () => service.assignDriver('delivery-1', actor(UserRole.ADMIN))],
      ['pickup', DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.PICKED_UP, DeliveryEventType.PICKED_UP,
        () => service.pickup('delivery-1', 'user-1', UserRole.DRIVER)],
      ['start', DeliveryStatus.PICKED_UP, DeliveryStatus.IN_TRANSIT, DeliveryEventType.IN_TRANSIT,
        () => service.start('delivery-1', 'user-1', UserRole.DRIVER)],
      ['complete', DeliveryStatus.IN_TRANSIT, DeliveryStatus.DELIVERED, DeliveryEventType.COMPLETED,
        () => service.complete('delivery-1', 'user-1', UserRole.DRIVER)],
      ['cancel', DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.CANCELLED, DeliveryEventType.CANCELLED,
        () => service.cancel('delivery-1', actor(UserRole.ADMIN))],
    ];

    it.each(transitions)('%s stages %s → %s as its delivery event, in the same transaction', async (_name, from, to, eventType, run) => {
      deliveries.findById.mockResolvedValue(at(from));
      deliveries.transition.mockResolvedValue(at(to));
      driverClient.getDriver.mockResolvedValue(assignedDriver);
      driverClient.findAvailableDriver.mockResolvedValue({ ...assignedDriver, status: DriverStatus.AVAILABLE });

      await run();

      const events = await staged();
      expect(events).toHaveLength(1);
      const [topic, event] = events[0];
      expect(topic).toBe(TOPICS.DELIVERY_EVENTS);
      expect(event).toMatchObject({
        eventId: lifecycleEventId('delivery-1', eventType),
        eventType,
        payload: { deliveryId: 'delivery-1', orderId: 'order-1', driverId: 'driver-1', status: to },
      });
    });

    it('create stores the order\'s customer and stages delivery.created naming them (#5)', async () => {
      deliveries.findByOrderId.mockResolvedValue(null);
      orderClient.getOrder.mockResolvedValue({
        id: 'order-1',
        customerId: 'c1',
        restaurantId: 'r1',
        status: OrderStatus.READY_FOR_PICKUP,
      });
      deliveries.create.mockResolvedValue({ ...baseDelivery, customerId: 'c1' });

      await service.create(actor(UserRole.ADMIN), { orderId: 'order-1' });

      expect(deliveries.create).toHaveBeenCalledWith('order-1', 'c1', expect.any(Function));
      expect((await staged())[0][1]).toMatchObject({
        eventType: DeliveryEventType.CREATED,
        payload: { deliveryId: 'delivery-1', orderId: 'order-1', customerId: 'c1', status: DeliveryStatus.CREATED },
      });
    });

    it('later delivery events keep naming the customer stored on the delivery (#5)', async () => {
      deliveries.findById.mockResolvedValue({ ...at(DeliveryStatus.DRIVER_ASSIGNED), customerId: 'c1' });
      deliveries.transition.mockResolvedValue({ ...at(DeliveryStatus.PICKED_UP), customerId: 'c1' });
      driverClient.getDriver.mockResolvedValue(assignedDriver);

      await service.pickup('delivery-1', 'user-1', UserRole.DRIVER);

      expect((await staged())[0][1].payload).toMatchObject({ customerId: 'c1', status: DeliveryStatus.PICKED_UP });
    });

    it('commits the event with the write, so it is published even if the order sync then fails', async () => {
      deliveries.findById.mockResolvedValue(at(DeliveryStatus.IN_TRANSIT));
      deliveries.transition.mockResolvedValue(at(DeliveryStatus.DELIVERED));
      driverClient.getDriver.mockResolvedValue(assignedDriver);
      orderClient.getOrder.mockRejectedValue(new Error('order-service unavailable'));

      await expect(service.complete('delivery-1', 'user-1', UserRole.DRIVER)).rejects.toThrow('order-service unavailable');

      // order-service converges from delivery.completed, so the order still reaches DELIVERED.
      expect((await staged()).map(([, e]) => e.eventType)).toEqual([DeliveryEventType.COMPLETED]);
      expect(outbox.kick).toHaveBeenCalled();
    });

    it('publishes nothing when the transition is rejected', async () => {
      deliveries.findById.mockResolvedValue(at(DeliveryStatus.DRIVER_ASSIGNED));
      driverClient.getDriver.mockResolvedValue(assignedDriver);

      await expect(service.pickup('delivery-1', 'someone-else', UserRole.DRIVER)).rejects.toThrow(ForbiddenError);
      await expect(service.complete('delivery-1', 'user-1', UserRole.DRIVER)).rejects.toThrow(
        InvalidStateTransitionError,
      );
      expect(await staged()).toHaveLength(0);
    });
  });

  describe('retry safety: the driver is always released', () => {
    const assignedDriver = { id: 'driver-1', userId: 'user-1', status: DriverStatus.BUSY };
    const at = (status: DeliveryStatus) => ({ ...baseDelivery, driverId: 'driver-1', status });
    const completeAsDriver = () => service.complete('delivery-1', 'user-1', UserRole.DRIVER);

    beforeEach(() => {
      driverClient.getDriver.mockResolvedValue(assignedDriver);
      orderClient.getOrder.mockResolvedValue(orderAt(OrderStatus.PICKED_UP));
    });

    it('driver-service down during completion: the request fails, and the retry releases the driver', async () => {
      deliveries.findById.mockResolvedValueOnce(at(DeliveryStatus.IN_TRANSIT));
      deliveries.transition.mockResolvedValueOnce(at(DeliveryStatus.DELIVERED));
      driverClient.releaseDriver.mockRejectedValueOnce(new Error('driver-service unavailable'));

      await expect(completeAsDriver()).rejects.toThrow('driver-service unavailable');
      // The event committed with the write, before the release failed: it is published regardless.
      expect(await staged()).toHaveLength(1);

      // Retry: the delivery is already DELIVERED. Before the fix this was a 409 and the driver stayed BUSY.
      deliveries.findById.mockResolvedValueOnce(at(DeliveryStatus.DELIVERED));
      const result = await completeAsDriver();

      expect(result.status).toBe(DeliveryStatus.DELIVERED);
      expect(deliveries.transition).toHaveBeenCalledTimes(1); // not written twice
      expect(driverClient.releaseDriver).toHaveBeenCalledTimes(2);
      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.DELIVERED);
      // Staged once, by the first attempt's write; the retry doesn't write, so it stages nothing new.
      expect((await staged()).map(([, e]) => e.eventType)).toEqual([DeliveryEventType.COMPLETED]);
    });

    it('order-service down during completion: the driver is still released first', async () => {
      deliveries.findById.mockResolvedValue(at(DeliveryStatus.IN_TRANSIT));
      deliveries.transition.mockResolvedValue(at(DeliveryStatus.DELIVERED));
      orderClient.getOrder.mockRejectedValue(new Error('order-service unavailable'));

      await expect(completeAsDriver()).rejects.toThrow('order-service unavailable');
      expect(driverClient.releaseDriver).toHaveBeenCalledWith('driver-1');
    });

    it('a retried completion never frees a driver who is already on another delivery', async () => {
      deliveries.findById.mockResolvedValue(at(DeliveryStatus.DELIVERED));
      deliveries.findActiveByDriverId.mockResolvedValue([
        { ...baseDelivery, id: 'delivery-2', driverId: 'driver-1', status: DeliveryStatus.DRIVER_ASSIGNED },
      ]);

      await completeAsDriver();

      expect(driverClient.releaseDriver).not.toHaveBeenCalled();
      expect(await staged()).toHaveLength(0); // its event was staged with the original write
    });

    it('releases the driver even when the order was cancelled meanwhile (the order is not forced back)', async () => {
      deliveries.findById.mockResolvedValue(at(DeliveryStatus.IN_TRANSIT));
      deliveries.transition.mockResolvedValue(at(DeliveryStatus.DELIVERED));
      orderClient.getOrder.mockResolvedValue(orderAt(OrderStatus.CANCELLED));

      await completeAsDriver();

      expect(driverClient.releaseDriver).toHaveBeenCalledWith('driver-1');
      expect(orderClient.updateOrderStatus).not.toHaveBeenCalled();
    });

    it('catches up an order left behind by a failed pickup sync, step by step', async () => {
      deliveries.findById.mockResolvedValue(at(DeliveryStatus.IN_TRANSIT));
      deliveries.transition.mockResolvedValue(at(DeliveryStatus.DELIVERED));
      orderClient.getOrder.mockResolvedValue(orderAt(OrderStatus.DRIVER_ASSIGNED));

      await completeAsDriver();

      expect(orderClient.updateOrderStatus.mock.calls).toEqual([
        ['order-1', OrderStatus.PICKED_UP],
        ['order-1', OrderStatus.DELIVERED],
      ]);
    });

    it('start repairs the order status when the pickup sync had failed', async () => {
      deliveries.findById.mockResolvedValue(at(DeliveryStatus.PICKED_UP));
      deliveries.transition.mockResolvedValue(at(DeliveryStatus.IN_TRANSIT));
      orderClient.getOrder.mockResolvedValue(orderAt(OrderStatus.DRIVER_ASSIGNED));

      await service.start('delivery-1', 'user-1', UserRole.DRIVER);

      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.PICKED_UP);
    });

    it('complete losing a race to cancel neither releases nor publishes from the losing request', async () => {
      deliveries.findById
        .mockResolvedValueOnce(at(DeliveryStatus.IN_TRANSIT))
        .mockResolvedValueOnce(at(DeliveryStatus.CANCELLED));
      deliveries.transition.mockResolvedValue(null); // compare-and-set lost

      await expect(completeAsDriver()).rejects.toThrow(InvalidStateTransitionError);
      expect(driverClient.releaseDriver).not.toHaveBeenCalled();
      expect(await staged()).toHaveLength(0);
    });

    it('a retried cancel re-runs the release and the order sync', async () => {
      deliveries.findById.mockResolvedValue(at(DeliveryStatus.CANCELLED));

      await service.cancel('delivery-1', actor(UserRole.ADMIN));

      expect(deliveries.transition).not.toHaveBeenCalled();
      expect(driverClient.releaseDriver).toHaveBeenCalledWith('driver-1');
      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.CANCELLED);
    });

    it('assignDriver gives the claimed driver back when recording the assignment fails', async () => {
      deliveries.findById.mockResolvedValue(baseDelivery);
      driverClient.findAvailableDriver.mockResolvedValue({ ...assignedDriver, status: DriverStatus.AVAILABLE });
      deliveries.transition.mockRejectedValue(new Error('db down'));

      await expect(service.assignDriver('delivery-1', actor(UserRole.ADMIN))).rejects.toThrow('db down');
      expect(driverClient.updateDriverStatus).toHaveBeenCalledWith('driver-1', DriverStatus.BUSY);
      expect(driverClient.releaseDriver).toHaveBeenCalledWith('driver-1');
    });

    it('a retried assignDriver does not claim a second driver', async () => {
      deliveries.findById.mockResolvedValue(at(DeliveryStatus.DRIVER_ASSIGNED));
      orderClient.getOrder.mockResolvedValue(orderAt(OrderStatus.READY_FOR_PICKUP));

      await service.assignDriver('delivery-1', actor(UserRole.ADMIN));

      expect(driverClient.findAvailableDriver).not.toHaveBeenCalled();
      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.DRIVER_ASSIGNED);
    });
  });

  describe('dispatch ownership (restaurant owners)', () => {
    const readyOrder = { id: 'order-1', customerId: 'c1', restaurantId: 'rest-1', status: OrderStatus.READY_FOR_PICKUP };

    it("lets an owner create the delivery for their own restaurant's order", async () => {
      deliveries.findByOrderId.mockResolvedValue(null);
      orderClient.assertReadableBy.mockResolvedValue(undefined);
      orderClient.getOrder.mockResolvedValue(readyOrder as any);
      deliveries.create.mockResolvedValue(baseDelivery as any);

      await expect(service.create(actor(UserRole.RESTAURANT_OWNER, 'owner-1'), { orderId: 'order-1' })).resolves.toBeDefined();
      expect(orderClient.assertReadableBy).toHaveBeenCalledWith('order-1', 'Bearer user');
    });

    it("rejects an owner creating a delivery for another restaurant's order, before touching anything", async () => {
      orderClient.assertReadableBy.mockRejectedValue(new ForbiddenError('You do not have access to this order'));

      await expect(service.create(actor(UserRole.RESTAURANT_OWNER, 'other-owner'), { orderId: 'order-1' })).rejects.toThrow(
        ForbiddenError,
      );
      expect(deliveries.create).not.toHaveBeenCalled();
    });

    it("rejects an owner assigning a driver to another restaurant's delivery", async () => {
      deliveries.findById.mockResolvedValue(baseDelivery as any);
      orderClient.assertReadableBy.mockRejectedValue(new ForbiddenError('nope'));

      await expect(service.assignDriver('delivery-1', actor(UserRole.RESTAURANT_OWNER, 'other-owner'))).rejects.toThrow(
        ForbiddenError,
      );
      expect(driverClient.findAvailableDriver).not.toHaveBeenCalled();
      expect(driverClient.updateDriverStatus).not.toHaveBeenCalled();
    });

    it("rejects an owner cancelling another restaurant's delivery", async () => {
      deliveries.findById.mockResolvedValue(baseDelivery as any);
      orderClient.assertReadableBy.mockRejectedValue(new ForbiddenError('nope'));

      await expect(service.cancel('delivery-1', actor(UserRole.RESTAURANT_OWNER, 'other-owner'))).rejects.toThrow(ForbiddenError);
      expect(deliveries.transition).not.toHaveBeenCalled();
    });

    it('does not ask order-service for admins (they may dispatch anything)', async () => {
      deliveries.findById.mockResolvedValue(baseDelivery as any);
      deliveries.transition.mockResolvedValue({ ...baseDelivery, status: DeliveryStatus.CANCELLED } as any);

      await service.cancel('delivery-1', actor(UserRole.ADMIN));
      expect(orderClient.assertReadableBy).not.toHaveBeenCalled();
    });
  });

  describe('read access (getById)', () => {
    const reader = (role: UserRole, userId = 'user-1') => ({ userId, role, authHeader: 'Bearer user' });
    const assigned = { ...baseDelivery, driverId: 'driver-1', status: DeliveryStatus.DRIVER_ASSIGNED };

    it('throws NotFoundError when missing', async () => {
      deliveries.findById.mockResolvedValue(null);
      await expect(service.getById('missing', reader(UserRole.CUSTOMER))).rejects.toThrow(NotFoundError);
    });

    it("lets a customer read the delivery of their own order (checked with the customer's token)", async () => {
      deliveries.findById.mockResolvedValue(baseDelivery as any);
      orderClient.assertReadableBy.mockResolvedValue(undefined);

      await expect(service.getById('delivery-1', reader(UserRole.CUSTOMER))).resolves.toMatchObject({ id: 'delivery-1' });
      expect(orderClient.assertReadableBy).toHaveBeenCalledWith('order-1', 'Bearer user');
    });

    it("rejects a customer reading another customer's delivery", async () => {
      deliveries.findById.mockResolvedValue(baseDelivery as any);
      orderClient.assertReadableBy.mockRejectedValue(new ForbiddenError('You do not have access to this order'));

      await expect(service.getById('delivery-1', reader(UserRole.CUSTOMER, 'someone-else'))).rejects.toThrow(ForbiddenError);
    });

    it("delegates a restaurant owner's access to order-service's restaurant ownership rule", async () => {
      deliveries.findById.mockResolvedValue(baseDelivery as any);
      orderClient.assertReadableBy.mockRejectedValue(new ForbiddenError('nope'));

      await expect(service.getById('delivery-1', reader(UserRole.RESTAURANT_OWNER))).rejects.toThrow(ForbiddenError);
    });

    it('lets the assigned driver read it', async () => {
      deliveries.findById.mockResolvedValue(assigned as any);
      driverClient.getDriver.mockResolvedValue({ id: 'driver-1', userId: 'driver-user' } as any);

      await expect(service.getById('delivery-1', reader(UserRole.DRIVER, 'driver-user'))).resolves.toBeDefined();
      expect(orderClient.assertReadableBy).not.toHaveBeenCalled();
    });

    it('rejects a driver who is not assigned, or when no driver is assigned yet', async () => {
      deliveries.findById.mockResolvedValue(assigned as any);
      driverClient.getDriver.mockResolvedValue({ id: 'driver-1', userId: 'driver-user' } as any);
      await expect(service.getById('delivery-1', reader(UserRole.DRIVER, 'other-driver'))).rejects.toThrow(ForbiddenError);

      deliveries.findById.mockResolvedValue(baseDelivery as any);
      await expect(service.getById('delivery-1', reader(UserRole.DRIVER, 'driver-user'))).rejects.toThrow(ForbiddenError);
    });

    it('lets an admin read any delivery', async () => {
      deliveries.findById.mockResolvedValue(baseDelivery as any);
      await expect(service.getById('delivery-1', reader(UserRole.ADMIN))).resolves.toBeDefined();
      expect(orderClient.assertReadableBy).not.toHaveBeenCalled();
    });
  });

  describe('getByOrderId', () => {
    const reader = (role: UserRole, userId = 'customer-1') => ({ userId, role, authHeader: 'Bearer user' });

    it('returns the delivery for the owning customer', async () => {
      orderClient.assertReadableBy.mockResolvedValue(undefined);
      deliveries.findByOrderId.mockResolvedValue(baseDelivery as any);

      await expect(service.getByOrderId('order-1', reader(UserRole.CUSTOMER))).resolves.toMatchObject({ id: 'delivery-1' });
    });

    it('404s when the order does not exist', async () => {
      orderClient.assertReadableBy.mockRejectedValue(new NotFoundError('Order order-x not found'));
      await expect(service.getByOrderId('order-x', reader(UserRole.CUSTOMER))).rejects.toThrow(NotFoundError);
    });

    it("403s for someone else's order without revealing whether a delivery exists", async () => {
      orderClient.assertReadableBy.mockRejectedValue(new ForbiddenError('You do not have access to this order'));

      await expect(service.getByOrderId('order-1', reader(UserRole.CUSTOMER, 'intruder'))).rejects.toThrow(ForbiddenError);
      expect(deliveries.findByOrderId).not.toHaveBeenCalled();
    });

    it('404s with a clear message when the delivery has not been created yet', async () => {
      orderClient.assertReadableBy.mockResolvedValue(undefined);
      deliveries.findByOrderId.mockResolvedValue(null);

      await expect(service.getByOrderId('order-1', reader(UserRole.CUSTOMER))).rejects.toThrow(
        'No delivery has been created for order order-1 yet',
      );
    });

    it('only lets a driver look up an order they are assigned to', async () => {
      deliveries.findByOrderId.mockResolvedValue({ ...baseDelivery, driverId: 'driver-1' } as any);
      driverClient.getDriver.mockResolvedValue({ id: 'driver-1', userId: 'driver-user' } as any);

      await expect(service.getByOrderId('order-1', reader(UserRole.DRIVER, 'driver-user'))).resolves.toBeDefined();
      await expect(service.getByOrderId('order-1', reader(UserRole.DRIVER, 'other'))).rejects.toThrow(ForbiddenError);
    });
  });
});
