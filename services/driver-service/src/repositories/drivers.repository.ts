import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, FindOptionsWhere, Repository } from 'typeorm';
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

  /**
   * #214: the staff driver list. Explicit filters; `platePrefix` is the start of the plate (stored
   * uppercase); `licenceExpiringBy` keeps drivers whose driving or vehicle licence ends on or before
   * that Cairo date. The review queue (`queue`) is submitted, still PENDING applications, oldest first.
   */
  async findForAdmin(filter: AdminDriverFilter, page: number, limit: number): Promise<[Driver[], number]> {
    const qb = this.repo.createQueryBuilder('d');
    if (filter.status) qb.andWhere('d.status = :status', { status: filter.status });
    if (filter.verificationStatus) qb.andWhere('d.verificationStatus = :verificationStatus', { verificationStatus: filter.verificationStatus });
    if (filter.queue) qb.andWhere(`d.submittedAt IS NOT NULL AND d.verificationStatus = 'PENDING'`);
    if (filter.licenceExpiringBy) {
      qb.andWhere('(d.drivingLicenceExpiresOn <= :by OR d.vehicleLicenceExpiresOn <= :by)', { by: filter.licenceExpiringBy });
    }
    if (filter.platePrefix) {
      const escaped = filter.platePrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      qb.andWhere(`d.licensePlate LIKE :plate ESCAPE '\\'`, { plate: `${escaped}%` });
    }
    if (filter.queue) qb.orderBy('d.submittedAt', 'ASC');
    else qb.orderBy('d.createdAt', 'DESC');
    return qb.addOrderBy('d.id', 'ASC').skip((page - 1) * limit).take(limit).getManyAndCount();
  }

  /**
   * #215: the end of a delivery (BUSY → AVAILABLE, or OFFLINE for a driver who lost verification),
   * in one compare-and-set: when staff asked to suspend the driver meanwhile, the release lands on
   * SUSPENDED instead and the request is cleared. One statement, so a suspension can't be lost to a
   * release racing it.
   */
  async releaseFromBusy(id: string, to: DriverStatus): Promise<Driver | null> {
    // For an UPDATE, TypeORM's query() resolves to [rows, affectedCount].
    const [rows]: [{ id: string }[], number] = await this.repo.query(
      `UPDATE "drivers"
          SET "status" = CASE WHEN "suspensionRequestedAt" IS NOT NULL THEN 'SUSPENDED'::driver_status ELSE $2::driver_status END,
              "availableSince" = CASE WHEN "suspensionRequestedAt" IS NULL AND $2::text = 'AVAILABLE' THEN clock_timestamp() ELSE NULL END,
              "suspensionRequestedAt" = NULL
        WHERE "id" = $1 AND "status" = 'BUSY'
          -- On duty needs VERIFIED (#206), as transitionStatus checks: a rejection landing meanwhile fails the write.
          AND ($2::text <> 'AVAILABLE' OR "verificationStatus" = 'VERIFIED' OR "suspensionRequestedAt" IS NOT NULL)
       RETURNING "id"`,
      [id, to],
    );
    return rows.length ? this.findById(id) : null;
  }

  /**
   * #215: suspends a driver in the caller's transaction. Off duty (OFFLINE, AVAILABLE): SUSPENDED now.
   * BUSY: the request is recorded and applied when the delivery ends. Null when there was nothing to do
   * (already suspended, or already requested): the action is idempotent.
   */
  async suspend(manager: EntityManager, id: string): Promise<DriverStatusChange | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const driver = await manager.getRepository(Driver).findOne({ where: { id } });
      if (!driver || driver.status === DriverStatus.SUSPENDED || (driver.status === DriverStatus.BUSY && driver.suspensionRequestedAt)) return null;
      const before = { status: driver.status, suspensionRequested: !!driver.suspensionRequestedAt };
      if (driver.status === DriverStatus.BUSY) {
        const result = await manager
          .createQueryBuilder()
          .update(Driver)
          .set({ suspensionRequestedAt: () => 'now()' })
          .where(`id = :id AND status = 'BUSY' AND "suspensionRequestedAt" IS NULL`, { id })
          .execute();
        if (result.affected) return { before, after: { status: DriverStatus.BUSY, suspensionRequested: true } };
      } else {
        const result = await manager
          .createQueryBuilder()
          .update(Driver)
          .set({ status: DriverStatus.SUSPENDED, availableSince: null, suspensionRequestedAt: null })
          .where('id = :id AND status = :from', { id, from: driver.status })
          .execute();
        if (result.affected) return { before, after: { status: DriverStatus.SUSPENDED, suspensionRequested: false } };
      }
      // The driver changed status between the read and the write (a claim or a release): read again.
    }
    throw new Error(`Driver ${id} kept changing status during the suspension`);
  }

  /**
   * #215: reactivates a driver in the caller's transaction: SUSPENDED → OFFLINE (they go online
   * themselves), or a BUSY driver's pending suspension is withdrawn. Null when there was nothing to do.
   */
  async reactivate(manager: EntityManager, id: string): Promise<DriverStatusChange | null> {
    const suspended = await manager
      .createQueryBuilder()
      .update(Driver)
      .set({ status: DriverStatus.OFFLINE, suspensionRequestedAt: null })
      .where(`id = :id AND status = 'SUSPENDED'`, { id })
      .execute();
    if (suspended.affected) {
      return { before: { status: DriverStatus.SUSPENDED, suspensionRequested: false }, after: { status: DriverStatus.OFFLINE, suspensionRequested: false } };
    }
    const withdrawn = await manager
      .createQueryBuilder()
      .update(Driver)
      .set({ suspensionRequestedAt: null })
      .where(`id = :id AND status = 'BUSY' AND "suspensionRequestedAt" IS NOT NULL`, { id })
      .execute();
    if (withdrawn.affected) {
      return { before: { status: DriverStatus.BUSY, suspensionRequested: true }, after: { status: DriverStatus.BUSY, suspensionRequested: false } };
    }
    return null;
  }
}

/** #215: the state a staff suspension or reactivation changed, for its audit event. */
export type DriverStatusChange = { before: { status: DriverStatus; suspensionRequested: boolean }; after: { status: DriverStatus; suspensionRequested: boolean } };

export interface AdminDriverFilter {
  status?: string;
  verificationStatus?: 'PENDING' | 'VERIFIED' | 'REJECTED';
  queue?: boolean;
  licenceExpiringBy?: string;
  platePrefix?: string;
}
