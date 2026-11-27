import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SYSTEM_TOKEN_TTL, UserRole } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/**
 * Mints the short-lived SYSTEM token restaurant-service sends to user-service (owner names) and order-service (orders today) for the
 * staff restaurant pages (#214). Signed with SYSTEM_JWT_SECRET, never the user tokens' JWT_SECRET.
 */
@Injectable()
export class SystemTokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jwtService: JwtService,
  ) {}

  async mint(): Promise<string> {
    const token = await this.jwtService.signAsync(
      { sub: 'system:restaurant-service', email: 'restaurant-service@internal', role: UserRole.SYSTEM },
      { secret: this.config.systemJwtSecret, expiresIn: SYSTEM_TOKEN_TTL },
    );
    return `Bearer ${token}`;
  }
}
