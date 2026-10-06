import { TrackingService } from './tracking.service';
import { LocationRepository } from '../repositories/location.repository';
import { DeliveryServiceClient } from '../common/delivery-service.client';
import { DriverServiceClient } from '../common/driver-service.client';
import { DeliveryStatus, ForbiddenError, NotFoundError, UserRole } from '@food-delivery/shared';
import { TrackingState } from './tracking-state';
import { TrackingEventsBus } from '../common/tracking-events.bus';
import { EtaUnavailableReason, NO_ETA_ESTIMATOR } from './eta';

describe('TrackingService', () => {
  let service: TrackingService;
  let locationRepository: jest.Mocked<LocationRepository>;
  let deliveryClient: jest.Mocked<DeliveryServiceClient>;
  let driverClient: jest.Mocked<DriverServiceClient>;

  beforeEach(() => {
    locationRepository = {
      save: jest.fn(),
      find: jest.fn(),
      ping: jest.fn(),
    } as unknown as jest.Mocked<LocationRepository>;

    deliveryClient = {
      getDelivery: jest.fn(),
    } as unknown as jest.Mocked<DeliveryServiceClient>;

    driverClient = {
      getDriver: jest.fn(),
    } as unknown as jest.Mocked<DriverServiceClient>;

    events = { publishDriverLocation: jest.fn(async () => 1) };
    service = new TrackingService(
      locationRepository,
      deliveryClient,
      driverClient,
      { locationStaleAfterSeconds: 60 },
      events as unknown as TrackingEventsBus,
      NO_ETA_ESTIMATOR,
    );
  });

  let events: { publishDriverLocation: jest.Mock };

  describe('updateLocation', () => {
    it('saves and returns the location with a timestamp', async () => {
      const result = await service.updateLocation('user-1', { latitude: 30.1, longitude: 31.2 });
      expect(result.userId).toBe('user-1');
      expect(result.latitude).toBe(30.1);
      expect(locationRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', latitude: 30.1, longitude: 31.2 }),
      );
    });

    it('wakes realtime subscribers after the position is stored (#135)', async () => {
      const order: string[] = [];
      locationRepository.save.mockImplementation(async () => {
        order.push('save');
      });
      events.publishDriverLocation.mockImplementation(async () => {
        order.push('publish');
        return 1;
      });

      await service.updateLocation('user-1', { latitude: 30.1, longitude: 31.2 });

      expect(events.publishDriverLocation).toHaveBeenCalledWith('user-1');
      expect(order).toEqual(['save', 'publish']);
    });

    it('a failed realtime publish does not fail the report (streams resync and clients fall back)', async () => {
      events.publishDriverLocation.mockRejectedValue(new Error('redis down'));
      await expect(service.updateLocation('user-1', { latitude: 30.1, longitude: 31.2 })).resolves.toMatchObject({
        userId: 'user-1',
      });
    });
  });

  describe('assignment + ETA contract in the tracking read (#46)', () => {
    const assignedAt = '2026-10-06T11:58:00.000Z';

    it('carries the assignment from delivery-service and an UNAVAILABLE ETA when no estimator is configured', async () => {
      deliveryClient.getDelivery.mockResolvedValue({
        id: 'delivery-1',
        orderId: 'order-1',
        driverId: 'driver-1',
        assignedAt,
        status: DeliveryStatus.IN_TRANSIT,
      });
      driverClient.getDriver.mockResolvedValue({ id: 'driver-1', userId: 'user-1' });
      locationRepository.find.mockResolvedValue({ userId: 'user-1', latitude: 1, longitude: 2, updatedAt: new Date().toISOString() });

      const result = await service.getDeliveryTracking('delivery-1', 'Bearer x');

      expect(result.assignment).toEqual({ driverId: 'driver-1', assignedAt });
      expect(result.eta).toEqual({ status: 'UNAVAILABLE', reason: EtaUnavailableReason.NOT_ESTIMATED });
    });

    it('no driver yet: no assignment and no ETA', async () => {
      deliveryClient.getDelivery.mockResolvedValue({ id: 'delivery-1', orderId: 'order-1', status: DeliveryStatus.CREATED });

      const result = await service.getDeliveryTracking('delivery-1', 'Bearer x');

      expect(result.assignment).toBeNull();
      expect(result.eta).toEqual({ status: 'UNAVAILABLE', reason: EtaUnavailableReason.NO_DRIVER });
    });

    it.each([DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED])('%s: the assignment stays known, the ETA is gone', async (status) => {
      deliveryClient.getDelivery.mockResolvedValue({ id: 'delivery-1', orderId: 'order-1', driverId: 'driver-1', assignedAt, status });

      const result = await service.getDeliveryTracking('delivery-1', 'Bearer x');

      expect(result.assignment).toEqual({ driverId: 'driver-1', assignedAt });
      expect(result.eta).toEqual({ status: 'UNAVAILABLE', reason: EtaUnavailableReason.DELIVERY_ENDED });
      expect(result.location).toBeNull();
    });

    it('an estimator only ever sees a LIVE position of the current assignment', async () => {
      const estimator = { estimateSeconds: jest.fn(() => 300) };
      const withEstimator = new TrackingService(
        locationRepository,
        deliveryClient,
        driverClient,
        { locationStaleAfterSeconds: 60 },
        events as unknown as TrackingEventsBus,
        estimator,
      );
      deliveryClient.getDelivery.mockResolvedValue({ id: 'delivery-1', orderId: 'order-1', driverId: 'driver-1', assignedAt, status: DeliveryStatus.IN_TRANSIT });
      driverClient.getDriver.mockResolvedValue({ id: 'driver-1', userId: 'user-1' });

      locationRepository.find.mockResolvedValue({ userId: 'user-1', latitude: 1, longitude: 2, updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
      expect((await withEstimator.getDeliveryTracking('delivery-1', 'Bearer x')).eta).toEqual({
        status: 'UNAVAILABLE',
        reason: EtaUnavailableReason.STALE_LOCATION,
      });
      expect(estimator.estimateSeconds).not.toHaveBeenCalled();

      locationRepository.find.mockResolvedValue({ userId: 'user-1', latitude: 1, longitude: 2, updatedAt: new Date().toISOString() });
      expect((await withEstimator.getDeliveryTracking('delivery-1', 'Bearer x')).eta).toMatchObject({
        status: 'ESTIMATED',
        seconds: 300,
        driverId: 'driver-1',
        assignedAt,
      });
    });
  });

  describe('loadDeliveryContext + snapshot (the steps the realtime stream reuses)', () => {
    it('loads the delivery as the caller and resolves the driver user once; snapshot reads only Redis', async () => {
      deliveryClient.getDelivery.mockResolvedValue({
        id: 'delivery-1',
        orderId: 'order-1',
        driverId: 'driver-1',
        status: DeliveryStatus.IN_TRANSIT,
      });
      driverClient.getDriver.mockResolvedValue({ id: 'driver-1', userId: 'user-1' });
      locationRepository.find.mockResolvedValue({ userId: 'user-1', latitude: 1, longitude: 2, updatedAt: new Date().toISOString() });

      const context = await service.loadDeliveryContext('delivery-1', 'Bearer x');
      expect(context).toEqual({
        deliveryId: 'delivery-1',
        status: DeliveryStatus.IN_TRANSIT,
        driverId: 'driver-1',
        assignedAt: null,
        driverUserId: 'user-1',
      });

      deliveryClient.getDelivery.mockClear();
      driverClient.getDriver.mockClear();
      const snapshot = await service.snapshot(context);
      expect(snapshot).toMatchObject({ tracking: TrackingState.LIVE, location: { latitude: 1 } });
      expect(deliveryClient.getDelivery).not.toHaveBeenCalled();
      expect(driverClient.getDriver).not.toHaveBeenCalled();
    });

    it('a finished delivery has no driver user to follow', async () => {
      deliveryClient.getDelivery.mockResolvedValue({ id: 'd', orderId: 'o', driverId: 'driver-1', status: DeliveryStatus.DELIVERED });
      await expect(service.loadDeliveryContext('d', 'Bearer x')).resolves.toMatchObject({ driverUserId: null });
      expect(driverClient.getDriver).not.toHaveBeenCalled();
    });
  });

  describe('getDriverLocation', () => {
    const self = { sub: 'user-1', role: UserRole.DRIVER };

    it('throws NotFoundError when nothing has been reported', async () => {
      locationRepository.find.mockResolvedValue(null);
      await expect(service.getDriverLocation('user-1', self)).rejects.toThrow(NotFoundError);
    });

    it("rejects a customer asking for a driver's raw location", async () => {
      await expect(
        service.getDriverLocation('user-1', { sub: 'customer-1', role: UserRole.CUSTOMER }),
      ).rejects.toThrow(ForbiddenError);
      expect(locationRepository.find).not.toHaveBeenCalled();
    });

    it("rejects a driver reading another driver's location", async () => {
      await expect(
        service.getDriverLocation('user-1', { sub: 'user-2', role: UserRole.DRIVER }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('lets an admin read any driver location', async () => {
      locationRepository.find.mockResolvedValue({ userId: 'user-1', latitude: 1, longitude: 2, updatedAt: '' });
      await expect(
        service.getDriverLocation('user-1', { sub: 'admin', role: UserRole.ADMIN }),
      ).resolves.toBeDefined();
    });

    it('returns the stored location', async () => {
      locationRepository.find.mockResolvedValue({
        userId: 'user-1',
        latitude: 30.1,
        longitude: 31.2,
        updatedAt: new Date().toISOString(),
      });
      const result = await service.getDriverLocation('user-1', self);
      expect(result.latitude).toBe(30.1);
    });
  });

  describe('getDeliveryTracking', () => {
    it('returns null location when no driver is assigned yet', async () => {
      deliveryClient.getDelivery.mockResolvedValue({
        id: 'delivery-1',
        orderId: 'order-1',
        driverId: undefined,
        status: DeliveryStatus.CREATED,
      });

      const result = await service.getDeliveryTracking('delivery-1', 'Bearer x');
      expect(result.location).toBeNull();
      expect(result.tracking).toBe(TrackingState.NO_DRIVER);
      expect(driverClient.getDriver).not.toHaveBeenCalled();
    });

    it('AWAITING_LOCATION when the assigned driver has not reported a position yet', async () => {
      deliveryClient.getDelivery.mockResolvedValue({
        id: 'delivery-1',
        orderId: 'order-1',
        driverId: 'driver-1',
        status: DeliveryStatus.DRIVER_ASSIGNED,
      });
      driverClient.getDriver.mockResolvedValue({ id: 'driver-1', userId: 'user-1' });
      locationRepository.find.mockResolvedValue(null);

      const result = await service.getDeliveryTracking('delivery-1', 'Bearer x');
      expect(result).toMatchObject({ tracking: TrackingState.AWAITING_LOCATION, location: null, locationAgeSeconds: null });
    });

    it('STALE with the last position when the driver stopped reporting', async () => {
      deliveryClient.getDelivery.mockResolvedValue({
        id: 'delivery-1',
        orderId: 'order-1',
        driverId: 'driver-1',
        status: DeliveryStatus.IN_TRANSIT,
      });
      driverClient.getDriver.mockResolvedValue({ id: 'driver-1', userId: 'user-1' });
      locationRepository.find.mockResolvedValue({
        userId: 'user-1',
        latitude: 30.1,
        longitude: 31.2,
        updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      });

      const result = await service.getDeliveryTracking('delivery-1', 'Bearer x');
      expect(result.tracking).toBe(TrackingState.STALE);
      expect(result.location?.latitude).toBe(30.1);
      expect(result.locationAgeSeconds).toBeGreaterThanOrEqual(300);
    });

    it.each([DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED])(
      'ENDED for a %s delivery: no driver lookup, no position, even if one is still stored',
      async (status) => {
        deliveryClient.getDelivery.mockResolvedValue({ id: 'delivery-1', orderId: 'order-1', driverId: 'driver-1', status });
        locationRepository.find.mockResolvedValue({
          userId: 'user-1',
          latitude: 30.1,
          longitude: 31.2,
          updatedAt: new Date().toISOString(),
        });

        const result = await service.getDeliveryTracking('delivery-1', 'Bearer x');
        expect(result).toMatchObject({ status, driverId: 'driver-1', tracking: TrackingState.ENDED, location: null });
        expect(driverClient.getDriver).not.toHaveBeenCalled();
        expect(locationRepository.find).not.toHaveBeenCalled();
      },
    );

    it("after a reassignment returns the new driver's position, never the previous driver's", async () => {
      deliveryClient.getDelivery.mockResolvedValue({
        id: 'delivery-1',
        orderId: 'order-1',
        driverId: 'driver-2',
        status: DeliveryStatus.DRIVER_ASSIGNED,
      });
      driverClient.getDriver.mockResolvedValue({ id: 'driver-2', userId: 'user-2' });
      locationRepository.find.mockImplementation(async (userId) =>
        userId === 'user-1'
          ? { userId: 'user-1', latitude: 1, longitude: 1, updatedAt: new Date().toISOString() }
          : null,
      );

      const result = await service.getDeliveryTracking('delivery-1', 'Bearer x');
      expect(locationRepository.find).toHaveBeenCalledWith('user-2');
      expect(result).toMatchObject({ driverId: 'driver-2', tracking: TrackingState.AWAITING_LOCATION, location: null });
    });

    it('propagates a driver-service failure instead of reporting a misleading state', async () => {
      deliveryClient.getDelivery.mockResolvedValue({
        id: 'delivery-1',
        orderId: 'order-1',
        driverId: 'driver-1',
        status: DeliveryStatus.IN_TRANSIT,
      });
      driverClient.getDriver.mockRejectedValue(new Error('driver-service down'));

      await expect(service.getDeliveryTracking('delivery-1', 'Bearer x')).rejects.toThrow('driver-service down');
    });

    it('resolves driver.id -> userId and returns the combined tracking info', async () => {
      deliveryClient.getDelivery.mockResolvedValue({
        id: 'delivery-1',
        orderId: 'order-1',
        driverId: 'driver-1',
        status: DeliveryStatus.IN_TRANSIT,
      });
      driverClient.getDriver.mockResolvedValue({ id: 'driver-1', userId: 'user-1' });
      locationRepository.find.mockResolvedValue({
        userId: 'user-1',
        latitude: 30.1,
        longitude: 31.2,
        updatedAt: new Date().toISOString(),
      });

      const result = await service.getDeliveryTracking('delivery-1', 'Bearer x');

      expect(driverClient.getDriver).toHaveBeenCalledWith('driver-1');
      expect(locationRepository.find).toHaveBeenCalledWith('user-1');
      expect(result.status).toBe(DeliveryStatus.IN_TRANSIT);
      expect(result.location?.latitude).toBe(30.1);
      expect(result.tracking).toBe(TrackingState.LIVE);
      expect(result.locationAgeSeconds).toBeLessThanOrEqual(1);
    });
  });
});
