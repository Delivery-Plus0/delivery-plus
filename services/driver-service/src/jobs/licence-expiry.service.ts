import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { LICENCE_WARNING_DAYS, addDays, cairoDate } from '../common/licence-dates';
import { LicenceExpiryOutcome, LicenceExpiryRepository } from '../repositories/licence-expiry.repository';

/**
 * The licence expiry check (#207), every DRIVER_LICENCE_EXPIRY_CHECK_MS (hourly by default; 0 turns it
 * off). Dates are Cairo calendar dates, so a licence that expired yesterday is acted on by the first run
 * after midnight in Cairo; the hourly cadence also retries soon a driver skipped because they were on a
 * delivery. A Postgres advisory lock makes one instance do each run; overlapping runs in one instance
 * are skipped too. The clock is a parameter so tests pin it.
 */
@Injectable()
export class LicenceExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LicenceExpiryService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repository: LicenceExpiryRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.licenceExpiryCheckIntervalMs > 0) {
      this.timer = setInterval(() => void this.run(), this.config.licenceExpiryCheckIntervalMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass. Null when skipped (already running here, another instance holds the lock, or it failed). */
  async run(now = new Date()): Promise<LicenceExpiryOutcome | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const today = cairoDate(now);
      const outcome = await this.repository.run(today, addDays(today, LICENCE_WARNING_DAYS));
      if (outcome && (outcome.expired.length || outcome.skippedBusy)) {
        // Counts only: the job never logs licence dates or anything else from the application.
        this.logger.log(
          `Licence expiry: ${outcome.expired.length} drivers sent back to re-review, ${outcome.skippedBusy} on a delivery left for the next run`,
        );
      }
      return outcome;
    } catch (error) {
      this.logger.error('Licence expiry check failed; will retry on the next run', error instanceof Error ? error.stack : String(error));
      return null;
    } finally {
      this.running = false;
    }
  }
}
