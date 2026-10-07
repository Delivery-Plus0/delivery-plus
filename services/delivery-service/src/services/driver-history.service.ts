import { Injectable, Logger } from '@nestjs/common';
import { DriverServiceClient } from '../common/driver-service.client';
import { OrderDto, OrderServiceClient } from '../common/order-service.client';
import { RestaurantServiceClient } from '../common/restaurant-service.client';
import {
  DriverHistoryItemDto,
  DriverHistoryPageDto,
  HISTORY_FILTER_STATUSES,
  HistoryFilter,
  HistoryRestaurantDto,
} from '../dto/driver-delivery-history.dto';
import { Delivery } from '../entities/delivery.entity';
import { DeliveriesRepository } from '../repositories/deliveries.repository';

export interface HistoryQuery {
  status?: HistoryFilter;
  page: number;
  limit: number;
}

/**
 * The calling driver's delivery history (#142). Which driver is asking comes only from their token
 * (driver-service resolves it), so a driver can never page through someone else's deliveries.
 * Rows are enriched from order- and restaurant-service; if either is unreachable the row is still
 * returned with that part null, so one outage doesn't hide the driver's whole history.
 */
@Injectable()
export class DriverHistoryService {
  private readonly logger = new Logger(DriverHistoryService.name);

  constructor(
    private readonly deliveries: DeliveriesRepository,
    private readonly driverClient: DriverServiceClient,
    private readonly orderClient: OrderServiceClient,
    private readonly restaurantClient: RestaurantServiceClient,
  ) {}

  async getForDriver(authHeader: string, query: HistoryQuery): Promise<DriverHistoryPageDto> {
    const { page, limit } = query;
    const driver = await this.driverClient.getOwnProfile(authHeader);
    if (!driver) return { items: [], page, limit, total: 0, totalPages: 1 };

    const statuses = query.status ? HISTORY_FILTER_STATUSES[query.status] : null;
    const [rows, total] = await this.deliveries.findPageByDriverId(driver.id, statuses, page, limit);

    const orders = await Promise.all(rows.map((row) => this.orderOrNull(row.orderId)));
    const restaurantIds = [...new Set(orders.flatMap((order) => (order ? [order.restaurantId] : [])))];
    const restaurants = new Map(
      await Promise.all(restaurantIds.map(async (id) => [id, await this.restaurantOrNull(id)] as const)),
    );

    const items = rows.map((row, index) => toItem(row, orders[index], restaurants));
    return { items, page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
  }

  private async orderOrNull(orderId: string): Promise<OrderDto | null> {
    try {
      return await this.orderClient.getOrder(orderId);
    } catch (error) {
      this.logger.warn(`delivery.history.order_unavailable orderId=${orderId}: ${(error as Error).message}`);
      return null;
    }
  }

  private async restaurantOrNull(restaurantId: string): Promise<HistoryRestaurantDto | null> {
    try {
      const restaurant = await this.restaurantClient.getRestaurant(restaurantId);
      return { id: restaurant.id, name: restaurant.name };
    } catch (error) {
      this.logger.warn(`delivery.history.restaurant_unavailable restaurantId=${restaurantId}: ${(error as Error).message}`);
      return null;
    }
  }
}

function toItem(
  delivery: Delivery,
  order: OrderDto | null,
  restaurants: Map<string, HistoryRestaurantDto | null>,
): DriverHistoryItemDto {
  return {
    id: delivery.id,
    orderId: delivery.orderId,
    status: delivery.status,
    assignedAt: delivery.assignedAt ?? null,
    pickedUpAt: delivery.pickedUpAt ?? null,
    deliveredAt: delivery.deliveredAt ?? null,
    cancelledAt: delivery.cancelledAt ?? null,
    updatedAt: delivery.updatedAt,
    restaurant: order ? (restaurants.get(order.restaurantId) ?? null) : null,
    order: order
      ? {
          items: (order.items ?? []).map((item) => ({ name: item.name, quantity: item.quantity })),
          totalAmount: order.totalAmount ?? '0.00',
          dropOffAddress: order.deliveryAddress ?? null,
        }
      : null,
  };
}
