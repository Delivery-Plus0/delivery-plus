import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { DriverStatus } from '@food-delivery/shared';
import { Driver } from '../entities/driver.entity';

/** #206: the statuses that put a driver on the road. Only a VERIFIED driver can be moved into them. */
export const ON_DUTY_STATUSES: readonly DriverStatus[] = [DriverStatus.AVAILABLE, DriverStatus.BUSY];

@Injectable()
export class DriversRepository {
  constructor(
    @InjectRepository(Driver)
    private readonly repo: Repository<Driver>,
  ) {}

  findById(id: string): Promise<Driver | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByUserId(userId: string): Promise<Driver | null> {
    return this.repo.findOne({ where: { userId } });
  }

  create(
    data: Pick<Driver, 'userId' | 'vehicleType' | 'licensePlate'> & Partial<Pick<Driver, 'verificationStatus' | 'verifiedAt'>>,
  ): Promise<Driver> {
    return this.repo.save(this.repo.create(data));
  }

  /**
   * Compare-and-set: moves the driver from `from` to `to` only if it is still in `from`.
   * Returns the updated driver, or null when another writer changed the status first.
   *
   * Going online (AVAILABLE) or being claimed (BUSY) also needs the driver to still be VERIFIED at the
   * moment of the write (#206), so a driver rejected between the caller's read and this write is
   * never put on the road.
   */
  async transitionStatus(id: string, from: DriverStatus, to: DriverStatus): Promise<Driver | null> {
    const where: FindOptionsWhere<Driver> = { id, status: from };
    if (ON_DUTY_STATUSES.includes(to)) where.verificationStatus = 'VERIFIED';
    const result = await this.repo.update(where, {
      status: to,
      // Database time and status change are one compare-and-set write.
      ...(from !== to ? { availableSince: to === DriverStatus.AVAILABLE ? () => 'clock_timestamp()' : null } : {}),
    });
    return result.affected ? this.findById(id) : null;
  }

  /** Vehicle change only while the driver is still OFFLINE (compare-and-set, #147). */
  async updateVehicleWhileOffline(id: string, vehicle: Pick<Driver, 'vehicleType' | 'licensePlate'>): Promise<Driver | null> {
    const result = await this.repo.update({ id, status: DriverStatus.OFFLINE }, vehicle);
    return result.affected ? this.findById(id) : null;
  }

  async updateVerification(id: string, data: Pick<Driver, 'verificationStatus' | 'verificationNote' | 'verifiedAt'>): Promise<Driver | null> {
    await this.repo.update({ id }, data);
    return this.findById(id);
  }

  /** Drivers auto-dispatch may claim: online and VERIFIED (#206). */
  findAvailable(page: number, limit: number): Promise<[Driver[], number]> {
    return this.repo.findAndCount({
      where: { status: DriverStatus.AVAILABLE, verificationStatus: 'VERIFIED' },
      order: { availableSince: 'ASC', id: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }
}
