import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** What an entry is for (#145). REVERSAL is reserved for corrections; nothing produces one yet (refunds: #53/#56). */
export enum LedgerEntryType {
  DELIVERY_EARNING = 'DELIVERY_EARNING',
  CANCELLATION_COMPENSATION = 'CANCELLATION_COMPENSATION',
  REVERSAL = 'REVERSAL',
}

/** PENDING until its settlement time, then AVAILABLE in the driver's internal wallet (no bank payouts). */
export enum LedgerEntryStatus {
  PENDING = 'PENDING',
  AVAILABLE = 'AVAILABLE',
}

/**
 * The driver earnings ledger (#145): append-only, one entry per (delivery, type), so a retried or
 * redelivered completion can never pay twice. Corrections are new entries, never edits; the only
 * change an entry ever sees is PENDING → AVAILABLE. A driver's balance is the sum of their entries.
 */
@Entity('driver_ledger_entries')
@Index('UQ_driver_ledger_delivery_type', ['deliveryId', 'type'], { unique: true })
@Index('IDX_driver_ledger_driver_created', ['driverId', 'createdAt'])
export class DriverLedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  driverId!: string; // driver-service Driver.id

  @Column({ type: 'uuid' })
  deliveryId!: string;

  @Column({ type: 'uuid' })
  orderId!: string;

  @Column({ type: 'varchar', length: 40 })
  type!: LedgerEntryType;

  /** EGP, two decimals; negative only for reversals. */
  @Column('decimal', { precision: 10, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: LedgerEntryStatus;

  /** When the entry settles (PENDING → AVAILABLE): completion + the settlement window. */
  @Column({ type: 'timestamptz' })
  availableAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  settledAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
