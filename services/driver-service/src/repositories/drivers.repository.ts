import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { DriverStatus } from '@food-delivery/shared';
import { Driver } from '../entities/driver.entity';
import { DriverDocument } from '../entities/driver-document.entity';
import { DriverReview } from '../entities/driver-review.entity';

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

  async create(
    data: Pick<Driver, 'userId' | 'vehicleType' | 'licensePlate'> & Partial<Pick<Driver, 'verificationStatus' | 'verifiedAt'>>,
  ): Promise<Driver> {
    const saved = await this.repo.save(this.repo.create(data));
    // Re-read: `save` returns every column, including the application columns that are never
    // selected by default (#207), so the profile response would otherwise carry them.
    return (await this.findById(saved.id)) as Driver;
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

  /**
   * Sets the verification directly (#147 admin route). With a reviewer, a VERIFIED or REJECTED decision
   * is also appended to the review history (#207) in the same transaction, with the documents current
   * at that moment, so the history is complete whichever route an admin used.
   */
  async updateVerification(
    id: string,
    data: Pick<Driver, 'verificationStatus' | 'verificationNote' | 'verifiedAt'>,
    reviewerUserId?: string,
  ): Promise<Driver | null> {
    await this.repo.manager.transaction(async (manager) => {
      const result = await manager.update(Driver, { id }, data);
      if (!result.affected || !reviewerUserId || data.verificationStatus === 'PENDING') return;
      const driver = await manager.findOneOrFail(Driver, { where: { id } });
      const documents = await manager.find(DriverDocument, { where: { driverId: id, isCurrent: true }, select: { id: true } });
      await manager.insert(DriverReview, {
        driverId: id,
        reviewerUserId,
        decision: data.verificationStatus,
        note: data.verificationNote,
        applicationSubmittedAt: driver.submittedAt,
        documentIds: documents.map((document) => document.id).sort(),
      });
    });
    return this.findById(id);
  }

  /** Drivers auto-dispatch may claim: online and VERIFIED (#206). */
  findAvailable(page: number, limit: number): Promise<[Driver[], number]> {
    return this.repo.createQueryBuilder('driver')
      .where('driver.status = :status', { status: DriverStatus.AVAILABLE })
      .andWhere('driver.verificationStatus = :verification', { verification: 'VERIFIED' })
      // Legacy rows still participate by their best known idle time, not by UUID.
      .orderBy('COALESCE(driver.availableSince, driver.updatedAt)', 'ASC')
      .addOrderBy('driver.id', 'ASC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
  }
}
