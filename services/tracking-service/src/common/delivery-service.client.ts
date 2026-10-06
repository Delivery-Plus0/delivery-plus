import { Inject, Injectable } from '@nestjs/common';
import { BadRequestError, DeliveryStatus, ForbiddenError, NotFoundError, assertValidUuidV4 } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export interface DeliveryDto {
  id: string;
  orderId: string;
  driverId?: string;
  /** When the current driver's assignment was accepted (#46); null/absent before assignment. */
  assignedAt?: string | null;
  status: DeliveryStatus;
}

@Injectable()
export class DeliveryServiceClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async getDelivery(deliveryId: string, authHeader: string): Promise<DeliveryDto> {
    const safeDeliveryId = assertValidUuidV4(deliveryId, 'deliveryId');
    const response = await fetch(`${this.config.deliveryServiceUrl}/deliveries/${safeDeliveryId}`, {
      headers: { Authorization: authHeader },
    });

    if (response.status === 404) {
      throw new NotFoundError(`Delivery ${safeDeliveryId} not found`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ForbiddenError('You do not have access to this delivery');
    }
    if (!response.ok) {
      throw new BadRequestError(`Failed to fetch delivery ${safeDeliveryId}`);
    }

    return (await response.json()) as DeliveryDto;
  }

  /**
   * The calling driver's active delivery, resolved by delivery-service from the driver's own token
   * (GET /deliveries/me/current), or null when they have none (204). Nothing comes from the request
   * body, so a driver can't bind a report to another driver's delivery.
   */
  async getCurrentForDriver(authHeader: string): Promise<{ id: string } | null> {
    const response = await fetch(`${this.config.deliveryServiceUrl}/deliveries/me/current`, {
      headers: { Authorization: authHeader },
    });
    if (response.status === 204) return null;
    if (response.status === 401 || response.status === 403) {
      throw new ForbiddenError('Only the assigned driver can report a location');
    }
    if (!response.ok) {
      throw new BadRequestError('Failed to resolve the driver\'s current delivery');
    }
    const current = (await response.json()) as { id?: string } | null;
    return current?.id ? { id: current.id } : null;
  }
}
