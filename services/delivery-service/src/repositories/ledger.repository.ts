import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { DriverLedgerEntry, LedgerEntryStatus, LedgerEntryType } from '../entities/driver-ledger-entry.entity';

export interface NewLedgerEntry {
  driverId: string;
  deliveryId: string;
  orderId: string;
  type: LedgerEntryType;
  amount: string;
  availableAt: Date;
}

export interface LedgerTotals {
  pending: string;
  available: string;
  balance: string;
}

@Injectable()
export class LedgerRepository {
  constructor(
    @InjectRepository(DriverLedgerEntry)
    private readonly repo: Repository<DriverLedgerEntry>,
  ) {}

  /**
   * Appends an entry inside the caller's transaction (the delivery's status change), unless one for
   * the same (delivery, type) exists: a retried completion or redelivered event is a no-op.
   */
  async appendOnce(manager: EntityManager, entry: NewLedgerEntry): Promise<void> {
    await manager.query(
      `INSERT INTO "driver_ledger_entries" ("driverId", "deliveryId", "orderId", "type", "amount", "status", "availableAt")
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)
       ON CONFLICT ("deliveryId", "type") DO NOTHING`,
      [entry.driverId, entry.deliveryId, entry.orderId, entry.type, entry.amount, entry.availableAt],
    );
  }

  /** Settles every due entry (all drivers, or one): PENDING → AVAILABLE. Idempotent; returns how many moved. */
  async settleDue(now: Date, driverId?: string): Promise<number> {
    const params: unknown[] = [now];
    let filter = '';
    if (driverId) {
      params.push(driverId);
      filter = ' AND "driverId" = $2';
    }
    const result: unknown = await this.repo.query(
      `UPDATE "driver_ledger_entries" SET "status" = 'AVAILABLE', "settledAt" = $1
        WHERE "status" = 'PENDING' AND "availableAt" <= $1${filter}`,
      params,
    );
    // pg returns [rows, affected] for UPDATE through TypeORM's query().
    return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
  }

  /** Totals straight from the entries: the balance is always their sum. */
  async totals(driverId: string): Promise<LedgerTotals> {
    const [row] = (await this.repo.query(
      `SELECT COALESCE(SUM(CASE WHEN "status" = 'PENDING' THEN "amount" END), 0)::numeric(12,2)::text AS "pending",
              COALESCE(SUM(CASE WHEN "status" = 'AVAILABLE' THEN "amount" END), 0)::numeric(12,2)::text AS "available",
              COALESCE(SUM("amount"), 0)::numeric(12,2)::text AS "balance"
         FROM "driver_ledger_entries" WHERE "driverId" = $1`,
      [driverId],
    )) as LedgerTotals[];
    return row ?? { pending: '0.00', available: '0.00', balance: '0.00' };
  }

  findPage(driverId: string, page: number, limit: number): Promise<[DriverLedgerEntry[], number]> {
    return this.repo.findAndCount({
      where: { driverId },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }
}

export { LedgerEntryStatus, LedgerEntryType };
