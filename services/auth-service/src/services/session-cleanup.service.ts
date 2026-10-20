import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SessionsService } from './sessions.service';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/**
 * Deletes refresh sessions that expired or were revoked more than SESSION_RETENTION_DAYS ago (#34),
 * every SESSION_CLEANUP_INTERVAL_MS. The DELETE is idempotent, so running it in every replica is safe.
 */
@Injectable()
export class SessionCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionCleanupService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly sessions: SessionsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.sessionCleanupIntervalMs > 0) {
      this.timer = setInterval(() => void this.sweep(), this.config.sessionCleanupIntervalMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass; returns how many sessions it deleted. Overlapping runs are skipped. */
  async sweep(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const deleted = await this.sessions.deleteEnded(now);
      if (deleted > 0) this.logger.log(`Deleted ${deleted} ended refresh sessions`);
      return deleted;
    } catch (error) {
      this.logger.error('Session cleanup failed; will retry on the next run', error instanceof Error ? error.stack : String(error));
      return 0;
    } finally {
      this.running = false;
    }
  }
}
