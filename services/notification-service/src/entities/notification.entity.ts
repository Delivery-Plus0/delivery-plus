import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export enum NotificationType {
  ORDER_CONFIRMED = 'ORDER_CONFIRMED',
  PAYMENT_COMPLETED = 'PAYMENT_COMPLETED',
  DRIVER_ASSIGNED = 'DRIVER_ASSIGNED',
  PICKED_UP = 'PICKED_UP',
  DELIVERED = 'DELIVERED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  PAYMENT_REFUNDED = 'PAYMENT_REFUNDED',
}

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  userId!: string;

  @Column({
    type: 'enum',
    enum: NotificationType,
  })
  type!: NotificationType;

  @Column()
  title!: string;

  @Column('text')
  message!: string;

  /** #151: what the notification says, as a key the apps translate (e.g. `order.confirmed`). Null on older rows. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  messageKey!: string | null;

  /** #151: the values the message refers to (order id, who cancelled, their note). Never personal data. */
  @Column({ type: 'jsonb', nullable: true })
  params!: NotificationParams | null;

  @Column({ default: false })
  isRead!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}

/** #151: parameters of a localized notification. */
export type NotificationParams = Record<string, string>;
