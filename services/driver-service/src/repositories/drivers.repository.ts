import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DriverStatus } from '@food-delivery/shared';
import { Driver } from '../entities/driver.entity';

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

  create(data: Pick<Driver, 'userId' | 'vehicleType' | 'licensePlate'>): Promise<Driver> {
    return this.repo.save(this.repo.create(data));
  }

  /**
   * Compare-and-set: moves the driver from `from` to `to` only if it is still in `from`.
   * Returns the updated driver, or null when another writer changed the status first.
   */
  async transitionStatus(id: string, from: DriverStatus, to: DriverStatus): Promise<Driver | null> {
    const result = await this.repo.update({ id, status: from }, { status: to });
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

  findAvailable(page: number, limit: number): Promise<[Driver[], number]> {
    return this.repo.findAndCount({
      where: { status: DriverStatus.AVAILABLE },
      order: { updatedAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }
}
