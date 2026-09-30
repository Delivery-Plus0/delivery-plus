import { TrackingService } from './tracking.service';
import { LocationRepository } from '../repositories/location.repository';
import { DeliveryServiceClient } from '../common/delivery-service.client';
import { DriverServiceClient } from '../common/driver-service.client';
import { DeliveryStatus, ForbiddenError, NotFoundError, UserRole } from '@food-delivery/shared';

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

    service = new TrackingService(locationRepository, deliveryClient, driverClient);
  });

  describe('updateLocation', () => {
    it('saves and returns the location with a timestamp', async () => {
      const result = await service.updateLocation('user-1', { latitude: 30.1, longitude: 31.2 });
      expect(result.userId).toBe('user-1');
      expect(result.latitude).toBe(30.1);
      expect(locationRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', latitude: 30.1, longitude: 31.2 }),
      );
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
      expect(driverClient.getDriver).not.toHaveBeenCalled();
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
    });
  });
});
