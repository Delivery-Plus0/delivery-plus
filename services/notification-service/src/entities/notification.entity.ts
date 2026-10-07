import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

export enum NotificationType {
  ORDER_CONFIRMED = 'ORDER_CONFIRMED',
  PAYMENT_COMPLETED = 'PAYMENT_COMPLETED',
  DRIVER_ASSIGNED = 'DRIVER_ASSIGNED',
  PICKED_UP = 'PICKED_UP',
  DELIVERED = 'DELIVERED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
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

  @Column({ default: false })
  isRead!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
