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
      transitionStatus: jest.fn(),
      findAvailable: jest.fn(),
    } as unknown as jest.Mocked<DriversRepository>;

    service = new DriversService(drivers);
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

  describe('updateStatus (the driver acting on their own profile)', () => {
    it('rejects a transition that does not exist (409)', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.SUSPENDED });
      await expect(
        service.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.BUSY }),
      ).rejects.toThrow(InvalidStateTransitionError);
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it('rejects DRIVER role trying to set BUSY directly (403)', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      await expect(
        service.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.BUSY }),
      ).rejects.toThrow(ForbiddenError);
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it('lets a DRIVER go online (OFFLINE -> AVAILABLE) with a compare-and-set write', async () => {
      drivers.findByUserId.mockResolvedValue(baseDriver);
      drivers.transitionStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });

      const result = await service.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.AVAILABLE });

      expect(drivers.transitionStatus).toHaveBeenCalledWith('driver-1', DriverStatus.OFFLINE, DriverStatus.AVAILABLE);
      expect(result.status).toBe(DriverStatus.AVAILABLE);
    });

    it('lets a DRIVER go offline (AVAILABLE -> OFFLINE)', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      drivers.transitionStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.OFFLINE });

      const result = await service.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.OFFLINE });
      expect(result.status).toBe(DriverStatus.OFFLINE);
    });

    it('does not let a BUSY driver make themselves AVAILABLE (403, nothing written)', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.BUSY });

      await expect(
        service.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.AVAILABLE }),
      ).rejects.toThrow('Driver is on an active delivery');
      await expect(
        service.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.AVAILABLE }),
      ).rejects.toThrow(ForbiddenError);
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it('does not let a BUSY driver go OFFLINE (409: not a transition)', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.BUSY });
      await expect(
        service.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.OFFLINE }),
      ).rejects.toThrow(InvalidStateTransitionError);
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it.each([DriverStatus.AVAILABLE, DriverStatus.OFFLINE])(
      'treats repeating the current %s status as a no-op (retry-safe)',
      async (status) => {
        drivers.findByUserId.mockResolvedValue({ ...baseDriver, status });

        const result = await service.updateStatus('user-1', UserRole.DRIVER, { status });

        expect(result.status).toBe(status);
        expect(drivers.transitionStatus).not.toHaveBeenCalled();
      },
    );

    it('lets ADMIN force BUSY', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      drivers.transitionStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.BUSY });

      const result = await service.updateStatus('user-1', UserRole.ADMIN, { status: DriverStatus.BUSY });
      expect(result.status).toBe(DriverStatus.BUSY);
    });

    it('lets ADMIN reinstate a SUSPENDED driver to OFFLINE', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.SUSPENDED });
      drivers.transitionStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.OFFLINE });

      const result = await service.updateStatus('user-1', UserRole.ADMIN, { status: DriverStatus.OFFLINE });
      expect(result.status).toBe(DriverStatus.OFFLINE);
    });

    it('rejects a DRIVER going offline if they were claimed for a delivery in the meantime (409)', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      drivers.transitionStatus.mockResolvedValue(null); // lost the compare-and-set
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.BUSY });

      await expect(
        service.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.OFFLINE }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });
  });

  describe('listAvailable', () => {
    it('returns a paginated result', async () => {
      drivers.findAvailable.mockResolvedValue([[{ ...baseDriver, status: DriverStatus.AVAILABLE }], 1]);
      const result = await service.listAvailable(1, 20);
      expect(result.total).toBe(1);
    });
  });

  describe('updateStatusById (delivery-service claim and release, admin)', () => {
    it('rejects non-ADMIN callers', async () => {
      await expect(
        service.updateStatusById('driver-1', UserRole.DRIVER, { status: DriverStatus.BUSY }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('claims an AVAILABLE driver (AVAILABLE -> BUSY)', async () => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      drivers.transitionStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.BUSY });

      const result = await service.updateStatusById('driver-1', UserRole.ADMIN, { status: DriverStatus.BUSY });

      expect(drivers.transitionStatus).toHaveBeenCalledWith('driver-1', DriverStatus.AVAILABLE, DriverStatus.BUSY);
      expect(result.status).toBe(DriverStatus.BUSY);
    });

    it('never treats claiming an already BUSY driver as a no-op (409)', async () => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.BUSY });
      await expect(
        service.updateStatusById('driver-1', UserRole.ADMIN, { status: DriverStatus.BUSY }),
      ).rejects.toThrow(InvalidStateTransitionError);
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it('rejects a claim that loses the compare-and-set to another claim (409)', async () => {
      drivers.findById
        .mockResolvedValueOnce({ ...baseDriver, status: DriverStatus.AVAILABLE })
        .mockResolvedValueOnce({ ...baseDriver, status: DriverStatus.BUSY });
      drivers.transitionStatus.mockResolvedValue(null);

      await expect(
        service.updateStatusById('driver-1', UserRole.ADMIN, { status: DriverStatus.BUSY }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('releases a BUSY driver (BUSY -> AVAILABLE)', async () => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.BUSY });
      drivers.transitionStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });

      const result = await service.updateStatusById('driver-1', UserRole.ADMIN, { status: DriverStatus.AVAILABLE });
      expect(result.status).toBe(DriverStatus.AVAILABLE);
    });

    it('treats a repeated release of an already AVAILABLE driver as a no-op', async () => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });

      const result = await service.updateStatusById('driver-1', UserRole.ADMIN, { status: DriverStatus.AVAILABLE });

      expect(result.status).toBe(DriverStatus.AVAILABLE);
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it('treats a release that raced another release as done, not as an error', async () => {
      drivers.findById
        .mockResolvedValueOnce({ ...baseDriver, status: DriverStatus.BUSY })
        .mockResolvedValueOnce({ ...baseDriver, status: DriverStatus.AVAILABLE });
      drivers.transitionStatus.mockResolvedValue(null);

      const result = await service.updateStatusById('driver-1', UserRole.ADMIN, { status: DriverStatus.AVAILABLE });
      expect(result.status).toBe(DriverStatus.AVAILABLE);
    });

    it('rejects an invalid transition even for ADMIN', async () => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.SUSPENDED });
      await expect(
        service.updateStatusById('driver-1', UserRole.ADMIN, { status: DriverStatus.BUSY }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });
  });

  describe('concurrent claims (repository with real compare-and-set semantics)', () => {
    /** One stored driver; reads and the conditional update interleave like two requests would. */
    function inMemoryRepository(initial: DriverStatus) {
      const row = { ...baseDriver, status: initial };
      const tick = () => new Promise((resolve) => setImmediate(resolve));
      return {
        row,
        repo: {
          findById: jest.fn(async () => {
            await tick();
            return { ...row };
          }),
          transitionStatus: jest.fn(async (_id: string, from: DriverStatus, to: DriverStatus) => {
            await tick();
            if (row.status !== from) return null;
            row.status = to;
            return { ...row };
          }),
        } as unknown as jest.Mocked<DriversRepository>,
      };
    }

    it('lets exactly one of two simultaneous assignments claim the same driver', async () => {
      const { row, repo } = inMemoryRepository(DriverStatus.AVAILABLE);
      const racing = new DriversService(repo);

      const results = await Promise.allSettled([
        racing.updateStatusById('driver-1', UserRole.ADMIN, { status: DriverStatus.BUSY }),
        racing.updateStatusById('driver-1', UserRole.ADMIN, { status: DriverStatus.BUSY }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(InvalidStateTransitionError);
      expect(row.status).toBe(DriverStatus.BUSY);
    });

    it('lets either a claim or a go-offline win, never both', async () => {
      const { row, repo } = inMemoryRepository(DriverStatus.AVAILABLE);
      repo.findByUserId = jest.fn(async () => ({ ...row })) as never;
      const racing = new DriversService(repo);

      const [claim, offline] = await Promise.allSettled([
        racing.updateStatusById('driver-1', UserRole.ADMIN, { status: DriverStatus.BUSY }),
        racing.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.OFFLINE }),
      ]);

      expect([claim.status, offline.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
      expect(row.status).toBe(claim.status === 'fulfilled' ? DriverStatus.BUSY : DriverStatus.OFFLINE);
    });
  });
});
