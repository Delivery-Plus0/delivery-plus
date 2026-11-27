import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SystemTokenService } from './system-token.service';

/**
 * The records a person's account is linked to, for the staff person page (#214). `undefined` means
 * the owning service didn't answer: the page shows the link as unavailable rather than "none".
 */
@Injectable()
export class LinkedRecordsClient {
  private readonly logger = new Logger(LinkedRecordsClient.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly systemToken: SystemTokenService,
  ) {}

  /** The driver id of a DRIVER account: a string, null when there is none, undefined when unknown. */
  async driverIdFor(userId: string): Promise<string | null | undefined> {
    try {
      const response = await fetch(`${this.config.driverServiceUrl}/internal/drivers/by-user/${encodeURIComponent(userId)}`, {
        headers: { Authorization: await this.systemToken.mint() },
        signal: AbortSignal.timeout(3000),
      });
      if (response.status === 404) return null;
      if (!response.ok) {
        this.logger.warn(`staff.linked_driver_failed status=${response.status}`);
        return undefined;
      }
      return ((await response.json()) as { id: string }).id;
    } catch (error) {
      this.logger.warn(`staff.linked_driver_failed ${error instanceof Error ? error.name : 'error'}`);
      return undefined;
    }
  }
}
