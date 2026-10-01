import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrderStatus } from '@food-delivery/shared';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';

/** Drop-off address snapshot stored on a new order. */
export interface DeliveryAddress {
  address: string;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
}

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
    return this.repo.save(order);
  }

  findByCustomerAndIdempotencyKey(customerId: string, idempotencyKey: string): Promise<Order | null> {
    return this.repo.findOne({
      where: { customerId, idempotencyKey },
    });
  }

  /**
   * Compare-and-set: moves the order from `from` to `to` only if it is still in `from`.
   * Returns the updated order, or null when another writer changed it first.
   */
  async updateStatus(id: string, from: OrderStatus, to: OrderStatus): Promise<Order | null> {
    const result = await this.repo.update({ id, status: from }, { status: to });
    return result.affected ? this.findById(id) : null;
  }

  async findByCustomer(customerId: string, page: number, limit: number): Promise<[Order[], number]> {
    return this.repo.findAndCount({
      where: { customerId },
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
