import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export interface OwnProfileDto {
  id: string;
  /** Set once the phone was confirmed by a one-time code (#153). */
  phoneVerifiedAt?: string | null;
}

/** Reads the driver's own user-service profile with the driver's Authorization header (#153). */
@Injectable()
export class UserServiceClient {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async getOwnProfile(authHeader: string): Promise<OwnProfileDto> {
    const response = await fetch(`${this.config.userServiceUrl}/users/me`, { headers: { Authorization: authHeader } });
    if (!response.ok) {
      throw new AppError(503, 'ServiceUnavailable', `Could not check your phone verification (status ${response.status}). Try again.`);
    }
    return (await response.json()) as OwnProfileDto;
  }
}
