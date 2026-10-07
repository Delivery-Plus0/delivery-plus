import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { BaseEvent, DeliveryStatus, TOPICS, stageEvent } from '@food-delivery/shared';
import { Delivery } from '../entities/delivery.entity';

/** Builds the event describing the change from the delivery as written (staged in the same transaction). */
export type DeliveryEventBuilder = (delivery: Delivery) => BaseEvent<unknown>;

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

  /**
   * One page of a driver's deliveries, newest first (#142), optionally limited to `statuses`.
   * Uses IDX_deliveries_driver_updated; id breaks ties so paging is stable.
   */
  findPageByDriverId(
    driverId: string,
    statuses: DeliveryStatus[] | null,
    page: number,
    limit: number,
  ): Promise<[Delivery[], number]> {
    const query = this.repo.createQueryBuilder('d').where('d.driverId = :driverId', { driverId });
    if (statuses) query.andWhere('d.status IN (:...statuses)', { statuses });
    return query
      .orderBy('d.updatedAt', 'DESC')
      .addOrderBy('d.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
  }

  /** Finished (delivered or cancelled) deliveries with a driver, changed since `since`, newest first. */
  findFinishedWithDriverSince(since: Date, limit: number): Promise<Delivery[]> {
    return this.repo
      .createQueryBuilder('d')
      .where('d.driverId IS NOT NULL')
      .andWhere('d.status IN (:...finished)', { finished: [DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED] })
      .andWhere('d.updatedAt >= :since', { since })
      .orderBy('d.updatedAt', 'DESC')
      .take(limit)
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

  /** Creates the delivery and stages its delivery.created event in one transaction (outbox, #98). */
  create(orderId: string, customerId: string | null, event: DeliveryEventBuilder): Promise<Delivery> {
    return this.repo.manager.transaction(async (manager) => {
      const deliveries = manager.getRepository(Delivery);
      const delivery = await deliveries.save(deliveries.create({ orderId, customerId, status: DeliveryStatus.CREATED }));
      await stageEvent(manager, TOPICS.DELIVERY_EVENTS, event(delivery));
      return delivery;
    });
  }

  /**
   * Compare-and-set: applies the change only while the delivery is still in `from`. Returns null when
   * another request moved it first, so two concurrent writers (e.g. cancel and complete) cannot both win.
   * Only the winner stages the event for the change, in the same transaction (outbox, #98).
   */
  async transition(
    id: string,
    from: DeliveryStatus,
    data: Partial<Delivery>,
    event: DeliveryEventBuilder,
    inTransaction?: (manager: EntityManager, updated: Delivery) => Promise<void>,
  ): Promise<Delivery | null> {
    return this.repo.manager.transaction(async (manager) => {
      const deliveries = manager.getRepository(Delivery);
      const result = await deliveries.update({ id, status: from }, data);
      if (!result.affected) return null;
      const updated = await deliveries.findOne({ where: { id } });
      if (!updated) return null;
      await stageEvent(manager, TOPICS.DELIVERY_EVENTS, event(updated));
      // Writes that must commit with the status (e.g. the earnings ledger, #145).
      if (inTransaction) await inTransaction(manager, updated);
      return updated;
    });
  }
}
