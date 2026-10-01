import { Inject, Injectable } from '@nestjs/common';
import { BadRequestError, DriverStatus, NotFoundError, assertValidUuidV4 } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SystemTokenService } from './system-token.service';

/** driver-service refused the status change (409: not a valid transition from the driver's current status). */
export class DriverStatusRejectedError extends Error {
  constructor(driverId: string, status: DriverStatus) {
    super(`Driver ${driverId} cannot move to ${status} from its current status`);
  }
}

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

  /**
   * Makes a BUSY driver AVAILABLE again. Idempotent: if driver-service rejects the transition because
   * the driver is no longer BUSY (already released by an earlier attempt, or set OFFLINE/SUSPENDED by
   * an admin), there is nothing left to release and this resolves.
   */
  async releaseDriver(driverId: string): Promise<void> {
    try {
      await this.updateDriverStatus(driverId, DriverStatus.AVAILABLE);
    } catch (error) {
      if (!(error instanceof DriverStatusRejectedError)) throw error;
      const driver = await this.getDriver(driverId);
      if (driver.status === DriverStatus.BUSY) throw error;
    }
  }

  async updateDriverStatus(driverId: string, status: DriverStatus): Promise<void> {
    const safeDriverId = assertValidUuidV4(driverId, 'driverId');
    const authHeader = await this.systemToken.mint();
    const response = await fetch(`${this.config.driverServiceUrl}/drivers/${safeDriverId}/status`, {
      method: 'PATCH',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });

    if (response.status === 409) {
      throw new DriverStatusRejectedError(safeDriverId, status);
    }
    if (!response.ok) {
      throw new Error(`Failed to update driver ${safeDriverId} to ${status} (status ${response.status})`);
    }
  }
}
