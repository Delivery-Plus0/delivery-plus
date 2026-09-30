import { Inject, Injectable } from '@nestjs/common';
import { BadRequestError, NotFoundError, assertValidUuidV4 } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SystemTokenService } from './system-token.service';

export interface DriverDto {
  id: string;
  userId: string;
}

@Injectable()
export class DriverServiceClient {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly systemToken: SystemTokenService,
  ) {}

  async getDriver(driverId: string): Promise<DriverDto> {
    const safeDriverId = assertValidUuidV4(driverId, 'driverId');
    // Driver profiles are not public; resolve driver.id -> userId as this service.
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
}
