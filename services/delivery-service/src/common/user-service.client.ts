import { Inject, Injectable } from '@nestjs/common';
import { BadRequestError, NotFoundError, assertValidUuidV4 } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SystemTokenService } from './system-token.service';

/** The parts of a user-service profile delivery-service may use. */
export interface UserProfileDto {
  id: string;
  fullName: string;
  avatarUrl?: string | null;
  /** #211: E.164; shown only to the participants of an active delivery (DeliveryContactService). */
  phone?: string | null;
}

/**
 * Reads a user profile as this service (system token). Used to compose the customer-safe driver card
 * (#140), which must never carry more than the display fields, and the contact window of an active
 * delivery (#211), the only place a phone number may be forwarded.
 */
@Injectable()
export class UserServiceClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly systemToken: SystemTokenService,
  ) {}

  async getProfile(userId: string): Promise<UserProfileDto> {
    const safeUserId = assertValidUuidV4(userId, 'userId');
    const response = await fetch(`${this.config.userServiceUrl}/users/${safeUserId}`, {
      headers: { Authorization: await this.systemToken.mint() },
    });
    if (response.status === 404) {
      throw new NotFoundError(`User ${safeUserId} not found`);
    }
    if (!response.ok) {
      throw new BadRequestError(`Failed to fetch user ${safeUserId}`);
    }
    return (await response.json()) as UserProfileDto;
  }
}
