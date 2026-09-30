import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/**
 * Mints a short-lived service-account JWT so tracking-service can read driver
 * profiles (driver.id -> userId), which are no longer public.
 *
 * SIMPLIFICATION: same pattern/limitation as delivery-service's and
 * payment-service's SystemTokenService — a stand-in for a proper
 * service-identity/mTLS scheme.
 */
@Injectable()
export class SystemTokenService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly jwtService: JwtService,
  ) {}

  async mint(): Promise<string> {
    const token = await this.jwtService.signAsync(
      { sub: 'system:tracking-service', email: 'tracking-service@internal', role: UserRole.ADMIN },
      { secret: this.config.jwtSecret, expiresIn: '5m' },
    );
    return `Bearer ${token}`;
  }
}
