import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Who caused the refund (#56): whoever ended the order, or support refunding by hand. */
export enum RefundInitiator {
  CUSTOMER = 'CUSTOMER',
  RESTAURANT = 'RESTAURANT',
  SYSTEM = 'SYSTEM',
  SUPPORT = 'SUPPORT',
}

/** Refunds are simulated like payments until a real payment gateway exists. */
export const REFUND_PROVIDER_SIMULATED = 'SIMULATED';

export const UQ_REFUNDS_PAYMENT = 'UQ_refunds_payment';

/**
 * The audit record of a refund (#56): one per payment, always the whole payment, written in the
 * same transaction that moves the payment COMPLETED → REFUNDED. Never edited.
 * See docs/business/cancellation-and-refunds.md.
 */
@Entity('refunds')
@Index(UQ_REFUNDS_PAYMENT, ['paymentId'], { unique: true })
export class Refund {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  paymentId!: string;

  @Index('IDX_refunds_orderId')
  @Column({ type: 'uuid' })
  orderId!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  /** EGP, the payment's whole amount (items + delivery fee). */
  @Column('decimal', { precision: 10, scale: 2 })
  amount!: string;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({ type: 'varchar', length: 20 })
  initiatedBy!: RefundInitiator;

  /** The support user who asked for it; null when a cancellation triggered it. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  requestedBy!: string | null;

  @Column({ type: 'varchar', length: 300 })
  reason!: string;

  /** What triggered it: `order.cancelled:<eventId>`, `payment.completed-after-cancel` or `support`. */
  @Column({ type: 'varchar', length: 120 })
  source!: string;

  @Column({ type: 'varchar', length: 20 })
  provider!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
