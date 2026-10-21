import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  PhoneNotVerifiedError,
  DRIVER_TRANSITIONS,
  DriverNotVerifiedError,
  DriverStatus,
  ForbiddenError,
  InvalidStateTransitionError,
  JwtPayload,
  NotFoundError,
  PaginatedResult,
  UserRole,
  isTransitionAllowed,
} from '@food-delivery/shared';
import { DriversRepository } from '../repositories/drivers.repository';
import { RegisterDriverDto } from '../dto/register-driver.dto';
import { UpdateDriverStatusDto } from '../dto/update-driver-status.dto';
import { IDEMPOTENT_STATUSES, isRoleAllowedForTransition } from '../common/driver-transition-rules';
import { Driver } from '../entities/driver.entity';
import { UserServiceClient } from '../common/user-service.client';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { UpdateVehicleDto, UpdateVerificationDto } from '../dto/driver-profile.dto';

/**
 * Driver availability is changed synchronously by delivery-service (BUSY on assignment, AVAILABLE on
 * completion or cancellation). There is deliberately no delivery.* consumer releasing drivers too:
 * a late delivery.completed could free a driver who is already on their next delivery.
 *
 * Drivers themselves only go online/offline; they cannot leave BUSY (see driver-transition-rules).
 *
 * Only a driver an admin has VERIFIED is ever put on the road (#206): going online is refused,
 * auto-dispatch never lists or claims them, and a rejection (or a re-review back to PENDING) takes an
 * online driver offline. A busy driver who loses verification finishes the current job and is then
 * released to OFFLINE instead of AVAILABLE.
 */
@Injectable()
export class DriversService {
  constructor(
    private readonly drivers: DriversRepository,
    private readonly userClient: UserServiceClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async register(userId: string, dto: RegisterDriverDto): Promise<Driver> {
    const existing = await this.drivers.findByUserId(userId);
    if (existing) {
      throw new ConflictError(`Driver profile already exists for user ${userId}`);
    }
    return this.drivers.create({
      userId,
      vehicleType: dto.vehicleType,
      licensePlate: dto.licensePlate,
      // Test stacks only (DRIVER_AUTO_VERIFY, refused in production): there is no admin to verify seeded drivers yet.
      ...(this.config.autoVerifyDrivers ? { verificationStatus: 'VERIFIED' as const, verifiedAt: new Date() } : {}),
    });
  }

  /**
   * The driver's own vehicle (#147). Only while OFFLINE: a vehicle change mid-shift would make the
   * customer's driver card wrong for a job already on its way.
   */
  async updateOwnVehicle(userId: string, dto: UpdateVehicleDto): Promise<Driver> {
    const driver = await this.getByUserId(userId);
    if (driver.status !== DriverStatus.OFFLINE) {
      throw new ConflictError('Go offline before changing your vehicle.');
    }
    const updated = await this.drivers.updateVehicleWhileOffline(driver.id, { vehicleType: dto.vehicleType, licensePlate: dto.licensePlate });
    if (!updated) throw new ConflictError('Go offline before changing your vehicle.');
    return updated;
  }

  /**
   * Admin review (#147): VERIFIED records when; PENDING and REJECTED clear it.
   *
   * #206: a driver who is no longer VERIFIED and is online goes OFFLINE. The verification is written
   * first, so from that moment no claim or go-online can succeed (their compare-and-set needs
   * VERIFIED); then an AVAILABLE driver is moved to OFFLINE (compare-and-set, a no-op otherwise).
   * A BUSY driver keeps the current job and is released to OFFLINE when it ends.
   */
  async setVerification(id: string, dto: UpdateVerificationDto, now = new Date()): Promise<Driver> {
    await this.getById(id);
    const updated = await this.drivers.updateVerification(id, {
      verificationStatus: dto.status,
      verificationNote: dto.note ? dto.note : null,
      verifiedAt: dto.status === 'VERIFIED' ? now : null,
    });
    if (!updated) throw new NotFoundError(`Driver ${id} not found`);
    if (dto.status === 'VERIFIED') return updated;

    const offline = await this.drivers.transitionStatus(id, DriverStatus.AVAILABLE, DriverStatus.OFFLINE);
    return offline ?? (await this.getById(id));
  }

  async getByUserId(userId: string): Promise<Driver> {
    const driver = await this.drivers.findByUserId(userId);
    if (!driver) {
      throw new NotFoundError(`Driver profile not found for user ${userId}`);
    }
    return driver;
  }

  /** A driver profile (user id, plate) is visible only to that driver and to admins/services. */
  async getByIdFor(id: string, requester: Pick<JwtPayload, 'sub' | 'role'>): Promise<Driver> {
    const driver = await this.getById(id);
    if (requester.role !== UserRole.ADMIN && requester.role !== UserRole.SYSTEM && driver.userId !== requester.sub) {
      throw new ForbiddenError('You can only view your own driver profile');
    }
    return driver;
  }

  async getById(id: string): Promise<Driver> {
    const driver = await this.drivers.findById(id);
    if (!driver) {
      throw new NotFoundError(`Driver ${id} not found`);
    }
    return driver;
  }

  /**
   * Admin/system variant of updateStatus that targets a driver by id rather
   * than "the current user's own profile". Needed by delivery-service to
   * mark a specific driver BUSY/AVAILABLE when assigning/releasing them.
   * Restricted to SYSTEM (#202): delivery-service calls this with a minted service
   * token, same SystemTokenService pattern as payment-service).
   */
  async updateStatusById(
    driverId: string,
    requesterRole: UserRole,
    dto: UpdateDriverStatusDto,
  ): Promise<Driver> {
    if (requesterRole !== UserRole.SYSTEM) {
      throw new ForbiddenError('Only a service (SYSTEM token) can update another driver\'s status');
    }

    return this.transition(await this.getById(driverId), dto.status, requesterRole);
  }

  async listAvailable(page: number, limit: number): Promise<PaginatedResult<Driver>> {
    const [items, total] = await this.drivers.findAvailable(page, limit);
    return { items, page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
  }

  /**
   * OFFLINE → AVAILABLE for the driver. Only a VERIFIED driver can (#206), checked before the phone so
   * an unreviewed driver isn't asked to verify a phone first. With the #153 gate on, only a driver with
   * a verified phone can start a shift; one already online stays online (the phone check guards the
   * transition, not the state).
   */
  async goOnline(userId: string, requesterRole: UserRole, authHeader: string): Promise<Driver> {
    const driver = await this.getByUserId(userId);
    assertCanGoOnline(driver);
    if (this.config.phoneVerificationRequired && driver.status !== DriverStatus.AVAILABLE) {
      const profile = await this.userClient.getOwnProfile(authHeader);
      if (!profile.phoneVerifiedAt) throw new PhoneNotVerifiedError('Verify your phone number to go online.');
    }
    return this.transition(driver, DriverStatus.AVAILABLE, requesterRole);
  }

  async updateStatus(
    userId: string,
    requesterRole: UserRole,
    dto: UpdateDriverStatusDto,
  ): Promise<Driver> {
    return this.transition(await this.getByUserId(userId), dto.status, requesterRole);
  }

  /**
   * The single path for every status change, in a fixed order:
   * 1. Verification (#206): going online needs VERIFIED (403 DriverNotVerified, whoever asks); a claim
   *    of a driver who isn't VERIFIED is a 409, so auto-dispatch moves on to the next driver.
   * 2. Repeating the current AVAILABLE/OFFLINE status is a no-op (safe retries). BUSY never is.
   * 3. The transition must exist in DRIVER_TRANSITIONS (409 otherwise).
   * 4. The caller's role must be allowed to make it (403 otherwise; a DRIVER can only go online/offline).
   * 5. Releasing a BUSY driver who is no longer VERIFIED writes OFFLINE instead of AVAILABLE (#206).
   * 6. The write is compare-and-set, and AVAILABLE/BUSY also need VERIFIED at write time. If another
   *    writer changed the driver between our read and our write (e.g. two assignments claiming the
   *    same driver), the loser gets a 409 instead of silently overwriting. If only the verification
   *    changed, the request is decided again once on the fresh row.
   */
  private async transition(driver: Driver, target: DriverStatus, requesterRole: UserRole, reread = false): Promise<Driver> {
    if (target === DriverStatus.BUSY && driver.verificationStatus !== 'VERIFIED') {
      throw new ConflictError(`Driver ${driver.id} is not verified and cannot be assigned`);
    }
    if (target === DriverStatus.AVAILABLE && driver.status !== DriverStatus.BUSY) {
      assertCanGoOnline(driver);
    }
    if (driver.status === target && IDEMPOTENT_STATUSES.includes(target)) {
      return driver;
    }
    if (!isTransitionAllowed(DRIVER_TRANSITIONS, driver.status, target)) {
      throw new InvalidStateTransitionError('Driver', driver.status, target);
    }
    if (!isRoleAllowedForTransition(driver.status, target, requesterRole)) {
      throw new ForbiddenError(
        driver.status === DriverStatus.BUSY
          ? 'Driver is on an active delivery; availability is restored when the delivery completes or is cancelled'
          : `Role ${requesterRole} cannot move a driver from ${driver.status} to ${target}`,
      );
    }

    const releasedTo =
      driver.status === DriverStatus.BUSY && target === DriverStatus.AVAILABLE && driver.verificationStatus !== 'VERIFIED'
        ? DriverStatus.OFFLINE
        : target;
    const updated = await this.drivers.transitionStatus(driver.id, driver.status, releasedTo);
    if (updated) return updated;

    const current = await this.getById(driver.id);
    if (current.status === releasedTo && IDEMPOTENT_STATUSES.includes(releasedTo)) {
      return current;
    }
    if (!reread && current.status === driver.status && current.verificationStatus !== driver.verificationStatus) {
      return this.transition(current, target, requesterRole, true);
    }
    throw new InvalidStateTransitionError('Driver', current.status, target);
  }
}

/** #206: going online needs an admin-VERIFIED driver. */
function assertCanGoOnline(driver: Driver): void {
  if (driver.verificationStatus !== 'VERIFIED') throw new DriverNotVerifiedError(driver.verificationStatus);
}
