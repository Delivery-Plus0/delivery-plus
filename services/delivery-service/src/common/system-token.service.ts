import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SYSTEM_TOKEN_TTL, UserRole } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/**
 * Mints the short-lived SYSTEM token delivery-service sends to claim and release drivers, list available drivers, read and move orders, read the fee split and read driver profiles (#202, F5).
 *
 * `role: SYSTEM`, signed with SYSTEM_JWT_SECRET (never the user tokens' JWT_SECRET), valid for
 * SYSTEM_TOKEN_TTL. The receiving service accepts it only on routes that allow UserRole.SYSTEM and only
 * when the request did not come through the public gateway.
 */
@Injectable()
export class SystemTokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jwtService: JwtService,
  ) {}

  async mint(): Promise<string> {
    const token = await this.jwtService.signAsync(
      { sub: 'system:delivery-service', email: 'delivery-service@internal', role: UserRole.SYSTEM },
      { secret: this.config.systemJwtSecret, expiresIn: SYSTEM_TOKEN_TTL },
    );
    return `Bearer ${token}`;
  }
}
