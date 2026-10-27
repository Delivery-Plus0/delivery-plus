import { DriverNotVerifiedError, PhoneNotVerifiedError } from '@food-delivery/shared';
import { UserServiceClient } from '../common/user-service.client';
import { AppConfig } from '../config/app-config';
import { DriversService } from './drivers.service';
import { DriversRepository } from '../repositories/drivers.repository';
import { ConflictError, DriverStatus, ForbiddenError, InvalidStateTransitionError, NotFoundError, UserRole } from '@food-delivery/shared';

describe('DriversService', () => {
  let service: DriversService;
  let drivers: jest.Mocked<DriversRepository>;
  let userClient: jest.Mocked<UserServiceClient>;
  const gateOff = { phoneVerificationRequired: false, autoVerifyDrivers: false } as AppConfig;

  const baseDriver = {
    id: 'driver-1',
    userId: 'user-1',
    vehicleType: 'motorcycle',
    licensePlate: 'ABC-123',
    status: DriverStatus.OFFLINE,
    // Verified, so the status tests below are about status rules; the #206 gate has its own tests.
    verificationStatus: 'VERIFIED' as 'PENDING' | 'VERIFIED' | 'REJECTED',
    availableSince: null as Date | null,
    verificationNote: null,
    verifiedAt: new Date('2026-10-01T00:00:00Z') as Date | null,
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
      updateVehicleWhileOffline: jest.fn(),
      updateVerification: jest.fn(),
    } as unknown as jest.Mocked<DriversRepository>;

    userClient = { getOwnProfile: jest.fn() } as unknown as jest.Mocked<UserServiceClient>;
    service = new DriversService(drivers, userClient, gateOff);
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
      expect(drivers.create).toHaveBeenCalledWith({ userId: 'user-1', vehicleType: 'motorcycle', licensePlate: 'ABC-123' });
    });

    it('creates the profile VERIFIED only with the DRIVER_AUTO_VERIFY test hook (#206)', async () => {
      drivers.findByUserId.mockResolvedValue(null);
      drivers.create.mockResolvedValue(baseDriver);
      const autoVerify = new DriversService(drivers, userClient, { ...gateOff, autoVerifyDrivers: true });

      await autoVerify.register('user-1', { vehicleType: 'motorcycle', licensePlate: 'ABC-123' });

      expect(drivers.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', verificationStatus: 'VERIFIED', verifiedAt: expect.any(Date) }),
      );
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

  describe('updateStatusById (delivery-service claim and release, SYSTEM token, #202)', () => {
    it.each([UserRole.DRIVER, UserRole.ADMIN, UserRole.CUSTOMER])('refuses a %s caller: only a service (SYSTEM) claims and releases (#202)', async (role) => {
      await expect(service.updateStatusById('driver-1', role, { status: DriverStatus.BUSY })).rejects.toThrow(ForbiddenError);
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it('lets a SYSTEM caller read any driver profile, like staff', async () => {
      drivers.findById.mockResolvedValue(baseDriver as any);
      await expect(service.getByIdFor('driver-1', { sub: 'system:tracking-service', role: UserRole.SYSTEM })).resolves.toMatchObject({ id: 'driver-1' });
    });

    it('claims an AVAILABLE driver (AVAILABLE -> BUSY)', async () => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      drivers.transitionStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.BUSY });

      const result = await service.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.BUSY });

      expect(drivers.transitionStatus).toHaveBeenCalledWith('driver-1', DriverStatus.AVAILABLE, DriverStatus.BUSY);
      expect(result.status).toBe(DriverStatus.BUSY);
    });

    it('never treats claiming an already BUSY driver as a no-op (409)', async () => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.BUSY });
      await expect(
        service.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.BUSY }),
      ).rejects.toThrow(InvalidStateTransitionError);
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it('rejects a claim that loses the compare-and-set to another claim (409)', async () => {
      drivers.findById
        .mockResolvedValueOnce({ ...baseDriver, status: DriverStatus.AVAILABLE })
        .mockResolvedValueOnce({ ...baseDriver, status: DriverStatus.BUSY });
      drivers.transitionStatus.mockResolvedValue(null);

      await expect(
        service.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.BUSY }),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('releases a BUSY driver (BUSY -> AVAILABLE)', async () => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.BUSY });
      drivers.transitionStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });

      const result = await service.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.AVAILABLE });
      expect(result.status).toBe(DriverStatus.AVAILABLE);
    });

    it('treats a repeated release of an already AVAILABLE driver as a no-op', async () => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });

      const result = await service.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.AVAILABLE });

      expect(result.status).toBe(DriverStatus.AVAILABLE);
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it('treats a release that raced another release as done, not as an error', async () => {
      drivers.findById
        .mockResolvedValueOnce({ ...baseDriver, status: DriverStatus.BUSY })
        .mockResolvedValueOnce({ ...baseDriver, status: DriverStatus.AVAILABLE });
      drivers.transitionStatus.mockResolvedValue(null);

      const result = await service.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.AVAILABLE });
      expect(result.status).toBe(DriverStatus.AVAILABLE);
    });

    it('rejects an invalid transition even for SYSTEM', async () => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.SUSPENDED });
      await expect(
        service.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.BUSY }),
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
          findByUserId: jest.fn(async () => {
            await tick();
            return { ...row };
          }),
          // Same conditions as the SQL: the status, and VERIFIED for AVAILABLE/BUSY (#206).
          transitionStatus: jest.fn(async (_id: string, from: DriverStatus, to: DriverStatus) => {
            await tick();
            if (row.status !== from) return null;
            if ((to === DriverStatus.AVAILABLE || to === DriverStatus.BUSY) && row.verificationStatus !== 'VERIFIED') return null;
            row.status = to;
            return { ...row };
          }),
          updateVerification: jest.fn(async (_id: string, data: Partial<typeof row>) => {
            await tick();
            Object.assign(row, data);
            return { ...row };
          }),
        } as unknown as jest.Mocked<DriversRepository>,
      };
    }

    it('lets exactly one of two simultaneous assignments claim the same driver', async () => {
      const { row, repo } = inMemoryRepository(DriverStatus.AVAILABLE);
      const racing = new DriversService(repo, userClient, gateOff);

      const results = await Promise.allSettled([
        racing.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.BUSY }),
        racing.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.BUSY }),
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
      const racing = new DriversService(repo, userClient, gateOff);

      const [claim, offline] = await Promise.allSettled([
        racing.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.BUSY }),
        racing.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.OFFLINE }),
      ]);

      expect([claim.status, offline.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
      expect(row.status).toBe(claim.status === 'fulfilled' ? DriverStatus.BUSY : DriverStatus.OFFLINE);
    });

    it('never assigns a driver rejected while the claim was in flight (#206)', async () => {
      const { row, repo } = inMemoryRepository(DriverStatus.AVAILABLE);
      const racing = new DriversService(repo, userClient, gateOff);

      const [claim, review] = await Promise.allSettled([
        racing.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.BUSY }),
        racing.setVerification('driver-1', { status: 'REJECTED' }),
      ]);

      expect(review.status).toBe('fulfilled');
      expect(row.verificationStatus).toBe('REJECTED');
      if (claim.status === 'fulfilled') {
        // The claim won the race: the driver keeps that job (and is released to OFFLINE afterwards).
        expect(row.status).toBe(DriverStatus.BUSY);
      } else {
        expect(claim.reason).toBeInstanceOf(ConflictError);
        expect(row.status).toBe(DriverStatus.OFFLINE);
      }
    });

    it('never leaves a rejected driver online when the rejection races going online (#206)', async () => {
      const { row, repo } = inMemoryRepository(DriverStatus.OFFLINE);
      const racing = new DriversService(repo, userClient, gateOff);

      await Promise.allSettled([
        racing.goOnline('user-1', UserRole.DRIVER, 'Bearer d'),
        racing.setVerification('driver-1', { status: 'REJECTED' }),
      ]);

      expect(row.verificationStatus).toBe('REJECTED');
      expect(row.status).toBe(DriverStatus.OFFLINE);
    });
  });

  describe('verification gate (#206)', () => {
    const pending = { ...baseDriver, verificationStatus: 'PENDING' as const, verifiedAt: null };
    const rejected = { ...baseDriver, verificationStatus: 'REJECTED' as const, verifiedAt: null };

    it.each([
      ['PENDING', pending, 'waiting for review'],
      ['REJECTED', rejected, 'not approved'],
    ] as const)('refuses to put a %s driver online (403 DriverNotVerified), before the phone check', async (status, driver, text) => {
      drivers.findByUserId.mockResolvedValue(driver);
      const gated = new DriversService(drivers, userClient, { ...gateOff, phoneVerificationRequired: true });

      const error = await gated.goOnline('user-1', UserRole.DRIVER, 'Bearer d').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DriverNotVerifiedError);
      expect(error).toMatchObject({ statusCode: 403, error: 'DriverNotVerified', details: { verificationStatus: status } });
      expect((error as Error).message).toContain(text);
      expect(userClient.getOwnProfile).not.toHaveBeenCalled();
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it('applies the same gate to POST /drivers/me/status and to an admin setting AVAILABLE', async () => {
      drivers.findByUserId.mockResolvedValue(pending);
      drivers.findById.mockResolvedValue(pending);

      await expect(service.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.AVAILABLE })).rejects.toBeInstanceOf(DriverNotVerifiedError);
      await expect(service.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.AVAILABLE })).rejects.toBeInstanceOf(DriverNotVerifiedError);
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it('still lets an unverified driver go offline', async () => {
      drivers.findByUserId.mockResolvedValue({ ...pending, status: DriverStatus.AVAILABLE });
      drivers.transitionStatus.mockResolvedValue({ ...pending, status: DriverStatus.OFFLINE });

      await expect(service.updateStatus('user-1', UserRole.DRIVER, { status: DriverStatus.OFFLINE })).resolves.toMatchObject({ status: DriverStatus.OFFLINE });
    });

    it.each([['PENDING', pending], ['REJECTED', rejected]] as const)('never claims a %s driver (409, so dispatch tries the next one)', async (_status, driver) => {
      drivers.findById.mockResolvedValue({ ...driver, status: DriverStatus.AVAILABLE });

      await expect(service.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.BUSY })).rejects.toMatchObject({ statusCode: 409 });
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it('refuses a claim when the driver was rejected between the read and the write (409)', async () => {
      drivers.findById
        .mockResolvedValueOnce({ ...baseDriver, status: DriverStatus.AVAILABLE })
        .mockResolvedValueOnce({ ...rejected, status: DriverStatus.AVAILABLE });
      drivers.transitionStatus.mockResolvedValue(null); // the compare-and-set needs VERIFIED

      await expect(service.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.BUSY })).rejects.toBeInstanceOf(ConflictError);
      expect(drivers.transitionStatus).toHaveBeenCalledTimes(1);
    });

    it('releases a BUSY driver who lost verification to OFFLINE, not AVAILABLE', async () => {
      drivers.findById.mockResolvedValue({ ...rejected, status: DriverStatus.BUSY });
      drivers.transitionStatus.mockResolvedValue({ ...rejected, status: DriverStatus.OFFLINE });

      const result = await service.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.AVAILABLE });

      expect(drivers.transitionStatus).toHaveBeenCalledWith('driver-1', DriverStatus.BUSY, DriverStatus.OFFLINE);
      expect(result.status).toBe(DriverStatus.OFFLINE);
    });

    it('releases to OFFLINE when the rejection lands between the read and the write', async () => {
      drivers.findById
        .mockResolvedValueOnce({ ...baseDriver, status: DriverStatus.BUSY })
        .mockResolvedValueOnce({ ...rejected, status: DriverStatus.BUSY });
      drivers.transitionStatus
        .mockResolvedValueOnce(null) // BUSY -> AVAILABLE needs VERIFIED
        .mockResolvedValueOnce({ ...rejected, status: DriverStatus.OFFLINE });

      const result = await service.updateStatusById('driver-1', UserRole.SYSTEM, { status: DriverStatus.AVAILABLE });

      expect(drivers.transitionStatus).toHaveBeenLastCalledWith('driver-1', DriverStatus.BUSY, DriverStatus.OFFLINE);
      expect(result.status).toBe(DriverStatus.OFFLINE);
    });
  });

  describe('goOnline phone gate (#153)', () => {
    const gateOn = { phoneVerificationRequired: true } as AppConfig;

    it('needs a verified phone to start a shift when the gate is on', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.OFFLINE });
      userClient.getOwnProfile.mockResolvedValue({ id: 'user-1', phoneVerifiedAt: null });
      const gated = new DriversService(drivers, userClient, gateOn);

      await expect(gated.goOnline('user-1', UserRole.DRIVER, 'Bearer d')).rejects.toBeInstanceOf(PhoneNotVerifiedError);
      expect(userClient.getOwnProfile).toHaveBeenCalledWith('Bearer d');
      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });

    it('lets a verified driver go online', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.OFFLINE });
      drivers.transitionStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      userClient.getOwnProfile.mockResolvedValue({ id: 'user-1', phoneVerifiedAt: '2026-10-07T10:00:00.000Z' });

      const result = await new DriversService(drivers, userClient, gateOn).goOnline('user-1', UserRole.DRIVER, 'Bearer d');
      expect(result.status).toBe(DriverStatus.AVAILABLE);
    });

    it('does not check anything when the gate is off, or when the driver is already online', async () => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.OFFLINE });
      drivers.transitionStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      await service.goOnline('user-1', UserRole.DRIVER, 'Bearer d');

      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      await new DriversService(drivers, userClient, gateOn).goOnline('user-1', UserRole.DRIVER, 'Bearer d');
      expect(userClient.getOwnProfile).not.toHaveBeenCalled();
    });
  });

  describe('vehicle (#147)', () => {
    it('lets an offline driver change their vehicle', async () => {
      drivers.findByUserId.mockResolvedValue(baseDriver as any);
      drivers.updateVehicleWhileOffline.mockResolvedValue({ ...baseDriver, vehicleType: 'Car', licensePlate: 'XYZ-9' } as any);

      await expect(service.updateOwnVehicle('user-1', { vehicleType: 'Car', licensePlate: 'XYZ-9' })).resolves.toMatchObject({ vehicleType: 'Car' });
      expect(drivers.updateVehicleWhileOffline).toHaveBeenCalledWith('driver-1', { vehicleType: 'Car', licensePlate: 'XYZ-9' });
    });

    it.each([DriverStatus.AVAILABLE, DriverStatus.BUSY])('refuses while %s (409)', async (status) => {
      drivers.findByUserId.mockResolvedValue({ ...baseDriver, status } as any);
      await expect(service.updateOwnVehicle('user-1', { vehicleType: 'Car', licensePlate: 'XYZ-9' })).rejects.toThrow('Go offline before changing your vehicle.');
      expect(drivers.updateVehicleWhileOffline).not.toHaveBeenCalled();
    });

    it('refuses when the driver went online in the meantime (compare-and-set lost)', async () => {
      drivers.findByUserId.mockResolvedValue(baseDriver as any);
      drivers.updateVehicleWhileOffline.mockResolvedValue(null);
      await expect(service.updateOwnVehicle('user-1', { vehicleType: 'Car', licensePlate: 'XYZ-9' })).rejects.toThrow(ConflictError);
    });
  });

  describe('verification (#147)', () => {
    const now = new Date('2026-10-07T12:00:00Z');

    it('records when a driver is verified', async () => {
      drivers.findById.mockResolvedValue(baseDriver as any);
      drivers.updateVerification.mockResolvedValue({ ...baseDriver, verificationStatus: 'VERIFIED', verifiedAt: now } as any);

      await service.setVerification('driver-1', { status: 'VERIFIED' }, now);

      expect(drivers.updateVerification).toHaveBeenCalledWith('driver-1', { verificationStatus: 'VERIFIED', verificationNote: null, verifiedAt: now });
    });

    it('keeps the note and clears the time for a rejection', async () => {
      drivers.findById.mockResolvedValue(baseDriver as any);
      drivers.updateVerification.mockResolvedValue({ ...baseDriver, verificationStatus: 'REJECTED' } as any);

      await service.setVerification('driver-1', { status: 'REJECTED', note: 'Plate photo unreadable' }, now);

      expect(drivers.updateVerification).toHaveBeenCalledWith('driver-1', {
        verificationStatus: 'REJECTED',
        verificationNote: 'Plate photo unreadable',
        verifiedAt: null,
      });
    });

    it('404s for an unknown driver', async () => {
      drivers.findById.mockResolvedValue(null);
      await expect(service.setVerification('nope', { status: 'VERIFIED' })).rejects.toThrow(NotFoundError);
    });

    it.each(['REJECTED', 'PENDING'] as const)('takes an online driver OFFLINE when set to %s (#206)', async (status) => {
      drivers.findById.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE });
      drivers.updateVerification.mockResolvedValue({ ...baseDriver, status: DriverStatus.AVAILABLE, verificationStatus: status, verifiedAt: null });
      drivers.transitionStatus.mockResolvedValue({ ...baseDriver, status: DriverStatus.OFFLINE, verificationStatus: status, verifiedAt: null });

      const result = await service.setVerification('driver-1', { status }, now);

      expect(drivers.transitionStatus).toHaveBeenCalledWith('driver-1', DriverStatus.AVAILABLE, DriverStatus.OFFLINE);
      expect(result).toMatchObject({ status: DriverStatus.OFFLINE, verificationStatus: status });
    });

    it('lets a BUSY driver keep the current job when rejected (#206)', async () => {
      const busyRejected = { ...baseDriver, status: DriverStatus.BUSY, verificationStatus: 'REJECTED' as const, verifiedAt: null };
      drivers.findById.mockResolvedValueOnce({ ...baseDriver, status: DriverStatus.BUSY }).mockResolvedValue(busyRejected);
      drivers.updateVerification.mockResolvedValue(busyRejected);
      drivers.transitionStatus.mockResolvedValue(null); // not AVAILABLE: nothing to take offline

      const result = await service.setVerification('driver-1', { status: 'REJECTED' }, now);

      expect(result).toMatchObject({ status: DriverStatus.BUSY, verificationStatus: 'REJECTED' });
    });

    it('does not touch the status when a driver is verified', async () => {
      drivers.findById.mockResolvedValue(baseDriver);
      drivers.updateVerification.mockResolvedValue(baseDriver);

      await service.setVerification('driver-1', { status: 'VERIFIED' }, now);

      expect(drivers.transitionStatus).not.toHaveBeenCalled();
    });
  });
});
