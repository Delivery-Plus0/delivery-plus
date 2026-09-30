import { Inject, Injectable } from '@nestjs/common';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, OrderStatus, assertValidUuidV4 } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SystemTokenService } from './system-token.service';

export interface OrderDto {
  id: string;
  customerId: string;
  restaurantId: string;
  status: OrderStatus;
  totalAmount: string;
}

@Injectable()
export class OrderServiceClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly systemToken: SystemTokenService,
  ) {}

  /** Uses the customer's own token — they're allowed to read their own order. */
  async getOrder(orderId: string, authHeader: string): Promise<OrderDto> {
    const safeOrderId = assertValidUuidV4(orderId, 'orderId');
    const response = await fetch(`${this.config.orderServiceUrl}/orders/${safeOrderId}`, {
      headers: { Authorization: authHeader },
    });

    if (response.status === 404) {
      throw new NotFoundError(`Order ${safeOrderId} not found`);
    }
    if (response.status === 403) {
      throw new ForbiddenError('You do not have access to this order');
    }
    if (!response.ok) {
      throw new BadRequestError(`Failed to fetch order ${safeOrderId}`);
    }

    return (await response.json()) as OrderDto;
  }

  /** Reads an order with the service token, e.g. to see where it ended up after a rejected sync. */
  async getOrderAsSystem(orderId: string): Promise<OrderDto> {
    return this.getOrder(orderId, await this.systemToken.mint());
  }

  /** Uses a minted service token (see SystemTokenService) since this is a system-triggered transition. */
  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    const safeOrderId = assertValidUuidV4(orderId, 'orderId');
    const authHeader = await this.systemToken.mint();
    const response = await fetch(`${this.config.orderServiceUrl}/orders/${safeOrderId}/status`, {
      method: 'PATCH',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });

    if (response.status === 409) {
      // The order is in a state that cannot move to `status` (e.g. already terminal).
      throw new ConflictError(`Order ${safeOrderId} cannot move to ${status}`);
    }
    if (!response.ok) {
      throw new Error(`Failed to update order ${safeOrderId} to ${status} (status ${response.status})`);
    }
  }
}
