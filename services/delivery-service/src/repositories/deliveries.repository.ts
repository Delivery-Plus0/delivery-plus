import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliveryStatus } from '@food-delivery/shared';
import { Delivery } from '../entities/delivery.entity';

@Injectable()
export class DeliveriesRepository {
  constructor(
    @InjectRepository(Delivery)
    private readonly repo: Repository<Delivery>,
  ) {}

  findById(id: string): Promise<Delivery | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByOrderId(orderId: string): Promise<Delivery | null> {
    return this.repo.findOne({ where: { orderId } });
  }

  findActiveByDriverId(driverId: string): Promise<Delivery[]> {
    return this.repo
      .createQueryBuilder('d')
      .where('d.driverId = :driverId', { driverId })
      .andWhere('d.status NOT IN (:...terminal)', {
        terminal: [DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED],
      })
      .getMany();
  }

  /** Deliveries still waiting for a driver, oldest first (what auto-dispatch retries). */
  findWaitingForDriver(limit: number): Promise<Delivery[]> {
    return this.repo.find({
      where: { status: DeliveryStatus.CREATED },
      order: { createdAt: 'ASC' },
      take: limit,
    });
  }

  create(orderId: string): Promise<Delivery> {
    return this.repo.save(this.repo.create({ orderId, status: DeliveryStatus.CREATED }));
  }

  /**
   * Compare-and-set: applies the change only while the delivery is still in `from`. Returns null when
   * another request moved it first, so two concurrent writers (e.g. cancel and complete) cannot both win.
   */
  async transition(id: string, from: DeliveryStatus, data: Partial<Delivery>): Promise<Delivery | null> {
    const result = await this.repo.update({ id, status: from }, data);
    return result.affected ? this.findById(id) : null;
  }
}
