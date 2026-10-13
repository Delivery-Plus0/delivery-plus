import { PaymentStatus } from '@food-delivery/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Payment statuses that count as the order's "active" payment. At most one
 * payment per order may be in one of these states; enforced by the partial
 * unique index `UQ_payments_active_order` below. FAILED and REFUNDED are
 * excluded so a failed attempt can be retried with a new payment.
 */
export const ACTIVE_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.PENDING,
  PaymentStatus.PROCESSING,
  PaymentStatus.COMPLETED,
];

export const UQ_PAYMENTS_ACTIVE_ORDER = 'UQ_payments_active_order';
export const UQ_PAYMENTS_CUSTOMER_IDEMPOTENCY_KEY = 'UQ_payments_customer_idempotency_key';

@Entity('payments')
@Index(UQ_PAYMENTS_ACTIVE_ORDER, ['orderId'], {
  unique: true,
  where: `"status" IN ('PENDING', 'PROCESSING', 'COMPLETED')`,
})
@Index(UQ_PAYMENTS_CUSTOMER_IDEMPOTENCY_KEY, ['customerId', 'idempotencyKey'], {
  unique: true,
  where: `"idempotencyKey" IS NOT NULL`,
})
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  orderId!: string;

  @Index()
  @Column()
  customerId!: string;

  @Column('decimal', { precision: 10, scale: 2 })
  amount!: string;

  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status!: PaymentStatus;

  @Column({ nullable: true })
  failureReason?: string;

  /** Client-supplied `Idempotency-Key` used to create this payment (scoped per customer). */
  @Column({ type: 'varchar', length: 255, nullable: true })
  idempotencyKey?: string | null;

  /**
   * Payment status whose Kafka event has been published successfully.
   * When it differs from `status`, the event for `status` is still owed.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  publishedEventStatus?: PaymentStatus | null;

  /**
   * Payment status whose order-service status update has been applied.
   * When it differs from `status`, the order update for `status` is still owed.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  orderSyncedStatus?: PaymentStatus | null;

  /**
   * Short lease held by the request currently performing side effects. Prevents
   * two concurrent retries from both publishing/updating; expires on its own if
   * the holder crashes, so a later retry can resume.
   */
  @Column({ type: 'timestamptz', nullable: true })
  sideEffectsLeaseUntil?: Date | null;

  /**
   * #18: when the current PROCESSING claim was taken (database clock). A claim older than
   * PAYMENT_PROCESSING_TIMEOUT_MS was abandoned (its request crashed or timed out) and may be taken
   * over. Null on a PROCESSING row means it was claimed before this was recorded: also abandoned.
   */
  @Column({ type: 'timestamptz', nullable: true })
  processingClaimedAt?: Date | null;

  /** #18: who holds the PROCESSING claim. Only that holder may settle the payment (fencing). */
  @Column({ type: 'uuid', nullable: true })
  processingToken?: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
