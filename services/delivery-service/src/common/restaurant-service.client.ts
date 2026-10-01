import { Inject, Injectable } from '@nestjs/common';
import { BadRequestError, NotFoundError, assertValidUuidV4 } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export interface RestaurantDto {
  id: string;
  name: string;
  address: string;
}

/** Restaurant profiles are public in restaurant-service, so no token is needed. */
@Injectable()
export class RestaurantServiceClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async getRestaurant(restaurantId: string): Promise<RestaurantDto> {
    const safeId = assertValidUuidV4(restaurantId, 'restaurantId');
    const response = await fetch(`${this.config.restaurantServiceUrl}/restaurants/${safeId}`);
    if (response.status === 404) {
      throw new NotFoundError(`Restaurant ${safeId} not found`);
    }
    if (!response.ok) {
      throw new BadRequestError(`Failed to fetch restaurant ${safeId}`);
    }
    return (await response.json()) as RestaurantDto;
  }
}
