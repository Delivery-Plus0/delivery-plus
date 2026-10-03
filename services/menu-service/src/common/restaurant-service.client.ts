import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ForbiddenError,
  INTERNAL_AUTH_HEADERS,
  NotFoundError,
  assertValidUuidV4,
  signInternalRequest,
} from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/**
 * Synchronous internal HTTP call to restaurant-service to confirm the
 * requesting user owns the restaurant before allowing menu mutations.
 * SIMPLIFICATION: same pattern/limitation as UserServiceClient in
 * auth-service — replaced by cached/event-driven ownership data once Kafka
 * exists, to avoid a hard runtime dependency on restaurant-service uptime.
 */
@Injectable()
export class RestaurantServiceClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async assertOwnership(restaurantId: string, requesterId: string): Promise<void> {
    const safeRestaurantId = assertValidUuidV4(restaurantId, 'restaurantId');
    const safeRequesterId = assertValidUuidV4(requesterId, 'requesterId');
    const url = `${this.config.restaurantServiceUrl}/restaurants/${safeRestaurantId}/ownership/${safeRequesterId}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomUUID();
    const signature = signInternalRequest({
      method: 'GET',
      path: `/restaurants/${safeRestaurantId}/ownership/${safeRequesterId}`,
      timestamp,
      nonce,
      body: {},
      service: this.config.internalAuthService,
      secret: this.config.internalAuthSecret,
    });

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        [INTERNAL_AUTH_HEADERS.service]: this.config.internalAuthService,
        [INTERNAL_AUTH_HEADERS.timestamp]: timestamp,
        [INTERNAL_AUTH_HEADERS.nonce]: nonce,
        [INTERNAL_AUTH_HEADERS.signature]: signature,
      },
    });

    if (response.status === 404) {
      throw new NotFoundError(`Restaurant ${safeRestaurantId} not found`);
    }
    if (response.status === 403) {
      throw new ForbiddenError('You do not own this restaurant');
    }
    if (!response.ok) {
      throw new Error(`restaurant-service ownership check failed (status ${response.status})`);
    }
  }
}
