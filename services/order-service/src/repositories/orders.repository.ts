import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { BaseEvent, OrderStatus, TOPICS, stageEvent } from '@food-delivery/shared';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';

/** Drop-off address snapshot stored on a new order. */
export interface DeliveryAddress {
  address: string;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Builds the event describing the change from the order as written (staged in the same transaction). */
export type OrderEventBuilder = (order: Order) => BaseEvent<unknown>;

export interface NewOrderItem {
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
}

@Injectable()
export class OrdersRepository {
  constructor(
    @InjectRepository(Order)
    private readonly repo: Repository<Order>,
  ) {}

  findById(id: string): Promise<Order | null> {
    return this.repo.findOne({ where: { id } });
  }

  async create(
    customerId: string,
    restaurantId: string,
    items: NewOrderItem[],
    totalAmount: number,
    idempotencyKey: string | undefined,
    delivery: DeliveryAddress,
    event: OrderEventBuilder,
  ): Promise<Order> {
    const order = this.repo.create({
      customerId,
      restaurantId,
      status: OrderStatus.CREATED,
      totalAmount: totalAmount.toFixed(2),
      idempotencyKey: idempotencyKey ?? null,
      deliveryAddress: delivery.address,
      deliveryNotes: delivery.notes,
      deliveryLatitude: delivery.latitude,
      deliveryLongitude: delivery.longitude,
      items: items.map(
        (item) =>
          ({
            menuItemId: item.menuItemId,
            name: item.name,
            price: item.price.toFixed(2),
            quantity: item.quantity,
          }) as OrderItem,
      ),
    });
    // The order and its order.created event commit together (transactional outbox, #98).
    return this.repo.manager.transaction(async (manager) => {
      const saved = await manager.getRepository(Order).save(order);
      await stageEvent(manager, TOPICS.ORDER_EVENTS, event(saved));
      return saved;
    });
  }

  findByCustomerAndIdempotencyKey(customerId: string, idempotencyKey: string): Promise<Order | null> {
    return this.repo.findOne({
      where: { customerId, idempotencyKey },
    });
  }

  /**
   * Compare-and-set: moves the order from `from` to `to` only if it is still in `from`, and stages the
   * event for the change in the same transaction (only the writer that wins stages it). Returns the
   * updated order, or null when another writer changed it first.
   */
  async updateStatus(
    id: string,
    from: OrderStatus,
    to: OrderStatus,
    event: OrderEventBuilder,
    outcome: Partial<Pick<Order, 'cancelledBy' | 'cancellationReason'>> = {},
  ): Promise<Order | null> {
    return this.repo.manager.transaction(async (manager) => {
      const orders = manager.getRepository(Order);
      const result = await orders.update({ id, status: from }, { status: to, ...outcome });
      if (!result.affected) return null;
      const updated = await orders.findOne({ where: { id } });
      if (!updated) return null;
      await stageEvent(manager, TOPICS.ORDER_EVENTS, event(updated));
      return updated;
    });
  }

  /**
   * Records the payment status learnt from a payment event (#143). Never moves backwards: PENDING only
   * fills an unknown status, and an outcome (COMPLETED / FAILED) only replaces unknown or PENDING, so
   * redelivered or out-of-order events can't undo what is known. Independent of the order status, so
   * a payment that completes after the order was cancelled is still recorded.
   */
  async recordPaymentStatus(id: string, status: string): Promise<void> {
    const replaceable = status === 'PENDING' ? '"paymentStatus" IS NULL' : '("paymentStatus" IS NULL OR "paymentStatus" = \'PENDING\')';
    await this.repo.query(`UPDATE "orders" SET "paymentStatus" = $1 WHERE "id" = $2 AND ${replaceable}`, [status, id]);
  }

  async findByCustomer(
    customerId: string,
    page: number,
    limit: number,
    statuses: OrderStatus[] | null = null,
  ): Promise<[Order[], number]> {
    return this.repo.findAndCount({
      where: statuses ? { customerId, status: In(statuses) } : { customerId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async findByRestaurant(restaurantId: string, page: number, limit: number): Promise<[Order[], number]> {
    return this.repo.findAndCount({
      where: { restaurantId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }
}
