import { Injectable, Logger } from '@nestjs/common';
import { DriverServiceClient } from '../common/driver-service.client';
import { UserServiceClient } from '../common/user-service.client';

/**
 * What a customer (or the restaurant) may see about the driver of their delivery (#140): enough to
 * recognise the person and the vehicle at the door, nothing else. Never the phone, email, user id,
 * identity documents or the driver's location (that is tracking-service's job, with its own rules).
 */
export interface DriverCard {
  /** First name only. */
  displayName: string;
  avatarUrl: string | null;
  vehicleType: string | null;
  licensePlate: string | null;
}

/** Driver cards change rarely (a renamed driver, a new photo); a short cache keeps polling cheap. */
const CARD_TTL_MS = 60_000;

export function firstName(fullName: string | undefined | null): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0];
  return first || 'Your driver';
}

@Injectable()
export class DriverCardService {
  private readonly logger = new Logger(DriverCardService.name);
  private readonly cache = new Map<string, { card: DriverCard; expiresAt: number }>();

  constructor(
    private readonly drivers: DriverServiceClient,
    private readonly users: UserServiceClient,
  ) {}

  /**
   * The card for a driver-service driver id, or null when it can't be composed right now. A missing
   * card must never fail the delivery read it decorates.
   */
  async getCard(driverId: string, now = Date.now()): Promise<DriverCard | null> {
    const cached = this.cache.get(driverId);
    if (cached && cached.expiresAt > now) return cached.card;
    try {
      const driver = await this.drivers.getDriver(driverId);
      const profile = await this.users.getProfile(driver.userId);
      const card: DriverCard = {
        displayName: firstName(profile.fullName),
        avatarUrl: profile.avatarUrl || null,
        vehicleType: driver.vehicleType || null,
        licensePlate: driver.licensePlate || null,
      };
      this.cache.set(driverId, { card, expiresAt: now + CARD_TTL_MS });
      return card;
    } catch (error) {
      this.logger.warn(`delivery.driver_card.unavailable driver=${driverId}: ${(error as Error).message}`);
      return null;
    }
  }
}
