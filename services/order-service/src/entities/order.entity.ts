import { OrderStatus } from '@food-delivery/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { OrderItem } from './order-item.entity';

export const UQ_ORDERS_CUSTOMER_IDEMPOTENCY_KEY = 'UQ_orders_customer_idempotency_key';

@Entity('orders')
@Index(UQ_ORDERS_CUSTOMER_IDEMPOTENCY_KEY, ['customerId', 'idempotencyKey'], {
  unique: true,
  where: `"idempotencyKey" IS NOT NULL`,
})
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  customerId!: string;

  @Index()
  @Column()
  restaurantId!: string;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.CREATED })
  status!: OrderStatus;

  @Column('decimal', { precision: 10, scale: 2 })
  totalAmount!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  idempotencyKey?: string | null;

  /**
   * Drop-off address copied at checkout and never updated afterwards. Nullable only because orders
   * created before this column existed have none; every new order gets one.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  deliveryAddress!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  deliveryNotes!: string | null;

  @Column({ type: 'double precision', nullable: true })
  deliveryLatitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  deliveryLongitude!: number | null;

  @OneToMany(() => OrderItem, (item) => item.order, { cascade: true, eager: true })
  items!: OrderItem[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
