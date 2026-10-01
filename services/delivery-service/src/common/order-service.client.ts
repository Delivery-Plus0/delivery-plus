import { Inject, Injectable } from '@nestjs/common';
import { BadRequestError, ForbiddenError, NotFoundError, OrderStatus, assertValidUuidV4 } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SystemTokenService } from './system-token.service';

export interface OrderDto {
  id: string;
  customerId: string;
  restaurantId: string;
  status: OrderStatus;
}

@Injectable()
export class OrderServiceClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly systemToken: SystemTokenService,
  ) {}

  async getOrder(orderId: string): Promise<OrderDto> {
    const safeOrderId = assertValidUuidV4(orderId, 'orderId');
    const authHeader = await this.systemToken.mint();
    const response = await fetch(`${this.config.orderServiceUrl}/orders/${safeOrderId}`, {
      headers: { Authorization: authHeader },
    });

    if (response.status === 404) {
      throw new NotFoundError(`Order ${safeOrderId} not found`);
    }
    if (!response.ok) {
      throw new BadRequestError(`Failed to fetch order ${safeOrderId}`);
    }

    return (await response.json()) as OrderDto;
  }

  /**
   * Asks order-service whether the requester may read this order, using the requester's own token
   * so order-service's rules (owning customer, owning restaurant owner, admin) stay the single
   * source of truth for order access.
   */
  async assertReadableBy(orderId: string, authHeader: string): Promise<void> {
    const safeOrderId = assertValidUuidV4(orderId, 'orderId');
    const response = await fetch(`${this.config.orderServiceUrl}/orders/${safeOrderId}`, {
      headers: { Authorization: authHeader },
    });

    if (response.status === 404) {
      throw new NotFoundError(`Order ${safeOrderId} not found`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ForbiddenError('You do not have access to this order');
    }
    if (!response.ok) {
      throw new BadRequestError(`Failed to fetch order ${safeOrderId}`);
    }
  }

  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    const safeOrderId = assertValidUuidV4(orderId, 'orderId');
    const authHeader = await this.systemToken.mint();
    const response = await fetch(`${this.config.orderServiceUrl}/orders/${safeOrderId}/status`, {
      method: 'PATCH',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });

    if (!response.ok) {
      throw new Error(`Failed to update order ${safeOrderId} to ${status} (status ${response.status})`);
    }
  }
}
