import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  DRIVER_TRANSITIONS,
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
import { isRoleAllowedForTransition } from '../common/driver-transition-rules';
import { Driver } from '../entities/driver.entity';

/**
 * Driver availability is changed synchronously by delivery-service (BUSY on assignment, AVAILABLE on
 * completion or cancellation). There is deliberately no delivery.* consumer releasing drivers too:
 * a late delivery.completed could free a driver who is already on their next delivery.
 */
@Injectable()
export class DriversService {
  constructor(private readonly drivers: DriversRepository) {}

  async register(userId: string, dto: RegisterDriverDto): Promise<Driver> {
    const existing = await this.drivers.findByUserId(userId);
    if (existing) {
      throw new ConflictError(`Driver profile already exists for user ${userId}`);
    }
    return this.drivers.create({
      userId,
      vehicleType: dto.vehicleType,
      licensePlate: dto.licensePlate,
    });
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
    if (requester.role !== UserRole.ADMIN && driver.userId !== requester.sub) {
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
   * Restricted to ADMIN (delivery-service calls this with a minted service
   * token, same SystemTokenService pattern as payment-service).
   */
  async updateStatusById(
    driverId: string,
    requesterRole: UserRole,
    dto: UpdateDriverStatusDto,
  ): Promise<Driver> {
    if (requesterRole !== UserRole.ADMIN) {
      throw new ForbiddenError('Only ADMIN (or a system token) can update another driver\'s status');
    }

    const driver = await this.getById(driverId);

    if (!isTransitionAllowed(DRIVER_TRANSITIONS, driver.status, dto.status)) {
      throw new InvalidStateTransitionError('Driver', driver.status, dto.status);
    }

    const updated = await this.drivers.updateStatus(driverId, dto.status);
    return updated as Driver;
  }

  async listAvailable(page: number, limit: number): Promise<PaginatedResult<Driver>> {
    const [items, total] = await this.drivers.findAvailable(page, limit);
    return { items, page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
  }

  async updateStatus(
    userId: string,
    requesterRole: UserRole,
    dto: UpdateDriverStatusDto,
  ): Promise<Driver> {
    const driver = await this.getByUserId(userId);

    if (!isTransitionAllowed(DRIVER_TRANSITIONS, driver.status, dto.status)) {
      throw new InvalidStateTransitionError('Driver', driver.status, dto.status);
    }
    if (!isRoleAllowedForTransition(dto.status, requesterRole)) {
      throw new ForbiddenError(`Role ${requesterRole} cannot set driver status to ${dto.status}`);
    }

    const updated = await this.drivers.updateStatus(driver.id, dto.status);
    return updated as Driver;
  }
}
