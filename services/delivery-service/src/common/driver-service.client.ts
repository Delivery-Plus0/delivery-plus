import { Inject, Injectable } from '@nestjs/common';
import { BadRequestError, DriverStatus, NotFoundError, assertValidUuidV4 } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SystemTokenService } from './system-token.service';

export interface DriverDto {
  id: string;
  userId: string;
  status: DriverStatus;
}

@Injectable()
export class DriverServiceClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly systemToken: SystemTokenService,
  ) {}

  async getDriver(driverId: string): Promise<DriverDto> {
    const safeDriverId = assertValidUuidV4(driverId, 'driverId');
    const response = await fetch(`${this.config.driverServiceUrl}/drivers/${safeDriverId}`, {
      headers: { Authorization: await this.systemToken.mint() },
    });
    if (response.status === 404) {
      throw new NotFoundError(`Driver ${safeDriverId} not found`);
    }
    if (!response.ok) {
      throw new BadRequestError(`Failed to fetch driver ${safeDriverId}`);
    }
    return (await response.json()) as DriverDto;
  }

  /** Returns the first currently available driver, or null if none. */
  async findAvailableDriver(): Promise<DriverDto | null> {
    const response = await fetch(`${this.config.driverServiceUrl}/drivers/available?page=1&limit=1`, {
      headers: { Authorization: await this.systemToken.mint() },
    });
    if (!response.ok) {
      throw new BadRequestError('Failed to query available drivers');
    }
    const body = (await response.json()) as { items: DriverDto[] };
    return body.items[0] ?? null;
  }

  async updateDriverStatus(driverId: string, status: DriverStatus): Promise<void> {
    const safeDriverId = assertValidUuidV4(driverId, 'driverId');
    const authHeader = await this.systemToken.mint();
    const response = await fetch(`${this.config.driverServiceUrl}/drivers/${safeDriverId}/status`, {
      method: 'PATCH',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });

    if (!response.ok) {
      throw new Error(`Failed to update driver ${safeDriverId} to ${status} (status ${response.status})`);
    }
  }
}
