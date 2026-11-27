import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SystemTokenService } from './system-token.service';

const LOOKUP_TIMEOUT_MS = 3000;

/**
 * The other services' parts of the staff restaurant pages (#214), with SYSTEM tokens. When a service
 * doesn't answer, the field is null (shown as unavailable, never made up).
 */
@Injectable()
export class StaffLookupsClient {
  private readonly logger = new Logger(StaffLookupsClient.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly systemToken: SystemTokenService,
  ) {}

  /** Owners' full names by user id (user-service returns names only). */
  async names(userIds: string[]): Promise<Map<string, string> | null> {
    if (userIds.length === 0) return new Map();
    const body = await this.call<{ items: { id: string; fullName: string }[] }>(`${this.config.userServiceUrl}/internal/users/names`, {
      method: 'POST',
      body: JSON.stringify({ ids: [...new Set(userIds)] }),
    });
    return body ? new Map(body.items.map((item) => [item.id, item.fullName])) : null;
  }

  async ordersToday(restaurantId: string): Promise<number | null> {
    const body = await this.call<{ ordersToday: number }>(
      `${this.config.orderServiceUrl}/internal/orders/restaurants/${encodeURIComponent(restaurantId)}/today`,
      { method: 'GET' },
    );
    return body ? body.ordersToday : null;
  }

  private async call<T>(url: string, init: { method: string; body?: string }): Promise<T | null> {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: await this.systemToken.mint() },
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(`staff.lookup_failed status=${response.status} path=${new URL(url).pathname}`);
        return null;
      }
      return (await response.json()) as T;
    } catch (error) {
      this.logger.warn(`staff.lookup_failed ${error instanceof Error ? error.name : 'error'} path=${new URL(url).pathname}`);
      return null;
    }
  }
}
