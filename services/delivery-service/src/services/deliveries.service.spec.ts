import { DeliveriesService } from './deliveries.service';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { OrderServiceClient } from '../common/order-service.client';
import { DriverServiceClient } from '../common/driver-service.client';
import {
  BadRequestError,
  ConflictError,
  DeliveryStatus,
  DriverStatus,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  OrderStatus,
  UserRole,
} from '@food-delivery/shared';

/** A requester as the controller builds it from the JWT and Authorization header. */
const actor = (role: UserRole, userId = 'user-1') => ({ userId, role, authHeader: 'Bearer user' });

describe('DeliveriesService', () => {
  let service: DeliveriesService;
  let deliveries: jest.Mocked<DeliveriesRepository>;
  let orderClient: jest.Mocked<OrderServiceClient>;
  let driverClient: jest.Mocked<DriverServiceClient>;

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
      findActiveByDriverId: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    } as unknown as jest.Mocked<DeliveriesRepository>;

    orderClient = {
      getOrder: jest.fn(),
      assertReadableBy: jest.fn(),
      updateOrderStatus: jest.fn(),
    } as unknown as jest.Mocked<OrderServiceClient>;

    driverClient = {
      getDriver: jest.fn(),
      findAvailableDriver: jest.fn(),
      updateDriverStatus: jest.fn(),
    } as unknown as jest.Mocked<DriverServiceClient>;

    service = new DeliveriesService(deliveries, orderClient, driverClient, { publish: jest.fn() } as any);
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
      deliveries.update.mockResolvedValue({
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
      deliveries.update.mockResolvedValue({
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
      deliveries.update.mockResolvedValue({
        ...baseDelivery,
        driverId: 'driver-1',
        status: DeliveryStatus.DELIVERED,
      });

      const result = await service.complete('delivery-1', 'user-1', UserRole.DRIVER);

      expect(driverClient.updateDriverStatus).toHaveBeenCalledWith('driver-1', DriverStatus.AVAILABLE);
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
      deliveries.update.mockResolvedValue({
        ...baseDelivery,
        driverId: 'driver-1',
        status: DeliveryStatus.CANCELLED,
      });

      const result = await service.cancel('delivery-1', actor(UserRole.ADMIN));

      expect(driverClient.updateDriverStatus).toHaveBeenCalledWith('driver-1', DriverStatus.AVAILABLE);
      expect(orderClient.updateOrderStatus).toHaveBeenCalledWith('order-1', OrderStatus.CANCELLED);
      expect(result.status).toBe(DeliveryStatus.CANCELLED);
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
      expect(deliveries.update).not.toHaveBeenCalled();
    });

    it('does not ask order-service for admins (they may dispatch anything)', async () => {
      deliveries.findById.mockResolvedValue(baseDelivery as any);
      deliveries.update.mockResolvedValue({ ...baseDelivery, status: DeliveryStatus.CANCELLED } as any);

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
