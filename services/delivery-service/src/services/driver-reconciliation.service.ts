import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DriverStatus } from '@food-delivery/shared';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { DriverServiceClient } from '../common/driver-service.client';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/** How far back finished deliveries are checked for a driver who was never released. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;

/**
 * Releases drivers left BUSY after their delivery finished (#98).
 *
 * `complete`/`cancel` commit the delivery (and its event, via the outbox) first and release the driver
 * afterwards over HTTP. If that release fails and the client never retries, the driver stays BUSY with
 * nothing to do. This sweep finds them among the drivers of recently finished deliveries and releases a
 * driver only when all of these hold:
 *   - they have no active delivery;
 *   - driver-service still reports them BUSY;
 *   - their status has not changed for `driverReconcileGraceMs`.
 * The last condition protects a driver being assigned right now (claimed, assignment not committed yet):
 * the claim just changed their status. A stuck BUSY driver cannot be claimed in the meantime (claims need
 * AVAILABLE), so the check and the release cannot race with a new assignment.
 */
@Injectable()
export class DriverReconciliationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DriverReconciliationService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly deliveries: DeliveriesRepository,
    private readonly driverClient: DriverServiceClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.driverReconcileSweepMs > 0) {
      this.timer = setInterval(() => void this.sweep(), this.config.driverReconcileSweepMs);
      this.timer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass; returns the ids of the drivers it released. Overlapping runs are skipped. */
  async sweep(now: number = Date.now()): Promise<string[]> {
    if (this.running) return [];
    this.running = true;
    const released: string[] = [];
    try {
      const finished = await this.deliveries.findFinishedWithDriverSince(new Date(now - LOOKBACK_MS), BATCH);
      const driverIds = [...new Set(finished.map((d) => d.driverId).filter((id): id is string => Boolean(id)))];
      for (const driverId of driverIds) {
        try {
          if (await this.reconcile(driverId, now)) released.push(driverId);
        } catch (error) {
          this.logger.error(`Could not reconcile driver ${driverId}; will retry on the next sweep`, error instanceof Error ? error.stack : String(error));
        }
      }
    } catch (error) {
      this.logger.error('Driver reconciliation sweep failed', error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
    return released;
  }

  private async reconcile(driverId: string, now: number): Promise<boolean> {
    const active = await this.deliveries.findActiveByDriverId(driverId);
    if (active.length > 0) return false;

    const driver = await this.driverClient.getDriver(driverId);
    if (driver.status !== DriverStatus.BUSY) return false;

    const lastChange = driver.updatedAt ? new Date(driver.updatedAt).getTime() : NaN;
    if (!Number.isFinite(lastChange) || now - lastChange < this.config.driverReconcileGraceMs) return false;

    await this.driverClient.releaseDriver(driverId);
    this.logger.warn(`Released driver ${driverId}: BUSY with no active delivery since ${new Date(lastChange).toISOString()}`);
    return true;
  }
}
