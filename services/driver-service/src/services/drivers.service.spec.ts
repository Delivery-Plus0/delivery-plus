import { DriversService } from './drivers.service';
import { DriversRepository } from '../repositories/drivers.repository';
import {
  ConflictError,
  DriverStatus,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  UserRole,
} from '@food-delivery/shared';

describe('DriversService', () => {
  let service: DriversService;
  let drivers: jest.Mocked<DriversRepository>;

  const baseDriver = {
    id: 'driver-1',
    userId: 'user-1',
    vehicleType: 'motorcycle',
    licensePlate: 'ABC-123',
    status: DriverStatus.OFFLINE,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    drivers = {
      findById: jest.fn(),
      findByUserId: jest.fn(),
      create: jest.fn(),
      updateStatus: jest.fn(),
      findAvailable: jest.fn(),
    } as unknown as jest.Mocked<DriversRepository>;

    service = new DriversService(drivers, { subscribe: jest.fn(), start: jest.fn() } as any);
  });

  describe('register', () => {
    it('throws ConflictError when a profile already exists', async () => {
      drivers.findByUserId.mockResolvedValue(baseDriver);
      await expect(
        service.register('user-1', { vehicleType: 'car', licensePlate: 'X' }),
      ).rejects.toThrow(ConflictError);
    });

    it('creates a new driver profile', async () => {
      drivers.findByUserId.mockResolvedValue(null);
      drivers.create.mockResolvedValue(baseDriver);
      const result = await service.register('user-1', {
        vehicleType: 'motorcycle',
        licensePlate: 'ABC-123',
      });
      expect(result.id).toBe('driver-1');
    });
  });

  describe('getByUserId', () => {
    it('throws NotFoundError when missing', async () => {
      drivers.findByUserId.mockResolvedValue(null);
      await expect(service.getByUserId('missing')).rejects.toThrow(NotFoundError);
    });
  });

  describe('getByIdFor (driver profile visibility)', () => {
    it('lets a driver read their own profile', async () => {
      drivers.findById.mockResolvedValue(baseDriver as any);
      await expect(service.getByIdFor('driver-1', { sub: 'user-1', role: UserRole.DRIVER })).resolves.toMatchObject({
        id: 'driver-1',
      });
    });

    it("rejects a driver reading another driver's profile (plate, user id)", async () => {
      drivers.findById.mockResolvedValue(baseDriver as any);
      await expect(service.getByIdFor('driver-1', { sub: 'user-2', role: UserRole.DRIVER })).rejects.toThrow(ForbiddenError);
    });

    it('lets admins and service system tokens (ADMIN role) read any profile', async () => {
      drivers.findById.mockResolvedValue(baseDriver as any);
      await expect(
        service.getByIdFor('driver-1', { sub: 'system:delivery-service', role: UserRole.ADMIN }),
      ).resolves.toBeDefined();
    });

    it('404s for an unknown driver', async () => {
      drivers.findById.mockResolvedValue(null);
      await expect(service.getByIdFor('missing', { sub: 'admin', role: UserRole.ADMIN })).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateStatus', () => {
    it('rejects an invalid transition', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.SUSPENDED });
      await expect(
        service.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.BUSY }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('rejects DRIVER role trying to set BUSY directly', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      await expect(
        service.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.BUSY }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('allows a DRIVER to go online (OFFLINE -> AVAILABLE)', async () => {
      drivers.findByUserId.mockResolvedValue(baseDriver);
      drivers.updateStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });

      const result = await service.updateStatus('user-1', UserRole.DRIVER, {
        status: DriverStatus.AVAILABLE,
      });
      expect(result.status).toBe(DriverStatus.AVAILABLE);
    });

    it('allows ADMIN to force BUSY', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      drivers.updateStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.BUSY });

      const result = await service.updateStatus('user-1', UserRole.ADMIN, {
        status: DriverStatus.BUSY,
      });
      expect(result.status).toBe(DriverStatus.BUSY);
    });

    it('allows ADMIN to reinstate a SUSPENDED driver to OFFLINE', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.SUSPENDED });
      drivers.updateStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.OFFLINE });

      const result = await service.updateStatus('user-1', UserRole.ADMIN, {
        status: DriverStatus.OFFLINE,
      });
      expect(result.status).toBe(DriverStatus.OFFLINE);
    });
  });

  describe('listAvailable', () => {
    it('returns a paginated result', async () => {
      drivers.findAvailable.mockResolvedValue([[{ ...baseDriver, status: DriverStatus.AVAILABLE }], 1]);
      const result = await service.listAvailable(1, 20);
      expect(result.total).toBe(1);
    });
  });

  describe('updateStatusById', () => {
    it('rejects non-ADMIN callers', async () => {
      await expect(
        service.updateStatusById('driver-1', UserRole.DRIVER, { status: DriverStatus.BUSY }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('allows ADMIN to set another driver BUSY', async () => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      drivers.updateStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.BUSY });

      const result = await service.updateStatusById('driver-1', UserRole.ADMIN, {
        status: DriverStatus.BUSY,
      });
      expect(result.status).toBe(DriverStatus.BUSY);
    });

    it('rejects an invalid transition even for ADMIN', async () => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.SUSPENDED });
      await expect(
        service.updateStatusById('driver-1', UserRole.ADMIN, { status: DriverStatus.BUSY }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });
  });
});
