import { Inject, Injectable } from '@nestjs/common';
import { BadRequestError } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export interface UserProfileDto {
  id: string;
  address?: string | null;
}

/**
 * Reads the customer's own profile with the customer's Authorization header (same pattern as
 * CartServiceClient): order-service only ever needs the profile of the person placing the order.
 */
@Injectable()
export class UserServiceClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async getOwnProfile(authHeader: string): Promise<UserProfileDto> {
    const response = await fetch(`${this.config.userServiceUrl}/users/me`, {
      headers: { Authorization: authHeader },
    });

    if (!response.ok) {
      throw new BadRequestError(`Failed to read the customer profile (status ${response.status})`);
    }

    return (await response.json()) as UserProfileDto;
  }
}
