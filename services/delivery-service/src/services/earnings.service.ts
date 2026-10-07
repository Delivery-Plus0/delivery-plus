import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DriverServiceClient } from '../common/driver-service.client';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { DriverLedgerEntry } from '../entities/driver-ledger-entry.entity';
import { LedgerRepository } from '../repositories/ledger.repository';

export interface EarningsEntryView {
  id: string;
  deliveryId: string;
  orderId: string;
  type: string;
  amount: string;
  status: string;
  availableAt: Date;
  createdAt: Date;
}

export interface DriverEarnings {
  currency: 'EGP';
  /** Still in the settlement window. */
  pending: string;
  /** Settled, in the driver's internal wallet (no bank payouts yet). */
  available: string;
  /** pending + available: always the sum of the ledger entries. */
  balance: string;
  settlementHours: number;
  entries: EarningsEntryView[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const view = (entry: DriverLedgerEntry): EarningsEntryView => ({
  id: entry.id,
  deliveryId: entry.deliveryId,
  orderId: entry.orderId,
  type: entry.type,
  amount: entry.amount,
  status: entry.status,
  availableAt: entry.availableAt,
  createdAt: entry.createdAt,
});

/**
 * The calling driver's earnings from the ledger (#145). Settlement is automatic: a sweep moves due
 * entries to AVAILABLE, and every read settles the driver's own due entries first, so totals are
 * exact even between sweeps. Both are idempotent (a due PENDING row is updated once).
 */
@Injectable()
export class EarningsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EarningsService.name);
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly ledger: LedgerRepository,
    private readonly driverClient: DriverServiceClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.earningsSettleSweepMs > 0) {
      this.sweepTimer = setInterval(() => void this.sweep(), this.config.earningsSettleSweepMs);
      this.sweepTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  async sweep(now = new Date()): Promise<number> {
    try {
      const settled = await this.ledger.settleDue(now);
      if (settled > 0) this.logger.log(`earnings.settled count=${settled}`);
      return settled;
    } catch (error) {
      this.logger.warn(`earnings.settle_failed ${(error as Error).message}`);
      return 0;
    }
  }

  async getForDriver(authHeader: string, page: number, limit: number, now = new Date()): Promise<DriverEarnings> {
    const empty: DriverEarnings = {
      currency: 'EGP',
      pending: '0.00',
      available: '0.00',
      balance: '0.00',
      settlementHours: this.config.earningsSettlementHours,
      entries: [],
      page,
      limit,
      total: 0,
      totalPages: 1,
    };
    const driver = await this.driverClient.getOwnProfile(authHeader);
    if (!driver) return empty;

    await this.ledger.settleDue(now, driver.id);
    const [totals, [entries, total]] = await Promise.all([this.ledger.totals(driver.id), this.ledger.findPage(driver.id, page, limit)]);
    return {
      ...empty,
      ...totals,
      entries: entries.map(view),
      total,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }
}
