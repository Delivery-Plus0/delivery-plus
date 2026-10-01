import { DeliveriesService } from './deliveries.service';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { OrderServiceClient } from '../common/order-service.client';
import { DriverServiceClient } from '../common/driver-service.client';
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
  let kafkaProducer: { publish: jest.Mock };

  const baseDelivery = {
    id: 'delivery-1',
    orderId: 'order-1',
    driverId: undefined,
    status: DeliveryStatus.CREATED,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

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
      findAvailableDriver: jest.fn(),
      updateDriverStatus: jest.fn(),
      releaseDriver: jest.fn(),
    } as unknown as jest.Mocked<DriverServiceClient>;

    kafkaProducer = { publish: jest.fn() };
    service = new DeliveriesService(deliveries, orderClient, driverClient, kafkaProducer as any);
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

    it.each(transitions)('%s publishes %s → %s as its delivery event', async (_name, from, to, eventType, run) => {
      deliveries.findById.mockResolvedValue(at(from));
      deliveries.transition.mockResolvedValue(at(to));
      driverClient.getDriver.mockResolvedValue(assignedDriver);
      driverClient.findAvailableDriver.mockResolvedValue({ ...assignedDriver, status: DriverStatus.AVAILABLE });

      await run();

      expect(kafkaProducer.publish).toHaveBeenCalledTimes(1);
      const [topic, event] = kafkaProducer.publish.mock.calls[0];
      expect(topic).toBe(TOPICS.DELIVERY_EVENTS);
      expect(event).toMatchObject({
        eventId: lifecycleEventId('delivery-1', eventType),
        eventType,
        payload: { deliveryId: 'delivery-1', orderId: 'order-1', driverId: 'driver-1', status: to },
      });
    });

    it('create publishes delivery.created', async () => {
      deliveries.findByOrderId.mockResolvedValue(null);
      orderClient.getOrder.mockResolvedValue({
        id: 'order-1',
        customerId: 'c1',
        restaurantId: 'r1',
        status: OrderStatus.READY_FOR_PICKUP,
      });
      deliveries.create.mockResolvedValue(baseDelivery);

      await service.create(actor(UserRole.ADMIN), { orderId: 'order-1' });

      expect(kafkaProducer.publish.mock.calls[0][1]).toMatchObject({
        eventType: DeliveryEventType.CREATED,
        payload: { deliveryId: 'delivery-1', orderId: 'order-1', status: DeliveryStatus.CREATED },
      });
    });

    it('publishes only after order-service and driver-service were synced', async () => {
      deliveries.findById.mockResolvedValue(at(DeliveryStatus.IN_TRANSIT));
      deliveries.transition.mockResolvedValue(at(DeliveryStatus.DELIVERED));
      driverClient.getDriver.mockResolvedValue(assignedDriver);

      await service.complete('delivery-1', 'user-1', UserRole.DRIVER);

      const published = kafkaProducer.publish.mock.invocationCallOrder[0];
      expect(orderClient.updateOrderStatus.mock.invocationCallOrder[0]).toBeLessThan(published);
      expect(driverClient.releaseDriver.mock.invocationCallOrder[0]).toBeLessThan(published);
    });

    it('publishes nothing when the transition is rejected', async () => {
      deliveries.findById.mockResolvedValue(at(DeliveryStatus.DRIVER_ASSIGNED));
      driverClient.getDriver.mockResolvedValue(assignedDriver);

      await expect(service.pickup('delivery-1', 'someone-else', UserRole.DRIVER)).rejects.toThrow(ForbiddenError);
      await expect(service.complete('delivery-1', 'user-1', UserRole.DRIVER)).rejects.toThrow(
        InvalidStateTransitionError,
      );
      expect(kafkaProducer.publish).not.toHaveBeenCalled();
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
      expect(kafkaProducer.publish).not.toHaveBeenCalled();

      // Retry: the delivery is already DELIVERED. Before the fix this was a 409 and the driver stayed BUSY.
      deliveries.findById.mockResolvedValueOnce(at(DeliveryStatus.DELIVERED));
      const result = await completeAsDriver();

      expect(result.status).toBe(DeliveryStatus.DELIVERED);
      expect(deliveries.transition).toHaveBeenCalledTimes(1); // not written twice
      expect(driverClient.releaseDriver).toHaveBeenCalledTimes(2);
      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.DELIVERED);
      expect(kafkaProducer.publish.mock.calls[0][1].eventType).toBe(DeliveryEventType.COMPLETED);
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
      expect(kafkaProducer.publish).toHaveBeenCalledTimes(1);
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
      expect(kafkaProducer.publish).not.toHaveBeenCalled();
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
