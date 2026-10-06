import { DeliveryStatus } from '@food-delivery/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('deliveries')
@Index('IDX_deliveries_driver_updated', ['driverId', 'updatedAt'])
export class Delivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column()
  orderId!: string;

  /** The order's customer, copied at creation so delivery events can name whom to notify (#5). */
  @Column({ type: 'uuid', nullable: true })
  customerId?: string | null;

  @Index()
  @Column({ nullable: true })
  driverId?: string; // driver-service Driver.id (not the userId)

  /**
   * When the current driver's claim was accepted (#46): set in the same compare-and-set write that
   * moves the delivery to DRIVER_ASSIGNED, never by a client. The assignment contract is
   * (driverId, assignedAt); a delivery is assigned at most once (DRIVER_ASSIGNED only moves on to
   * PICKED_UP or CANCELLED), so this never changes after it is set.
   */
  @Column({ type: 'timestamptz', nullable: true })
  assignedAt?: Date | null;

  /**
   * When the delivery reached each later stage (#142, driver history). Written in the same
   * compare-and-set as the status change, by the server only; null until that stage happens.
   */
  @Column({ type: 'timestamptz', nullable: true })
  pickedUpAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt?: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt?: Date | null;

  @Column({ type: 'enum', enum: DeliveryStatus, default: DeliveryStatus.CREATED })
  status!: DeliveryStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
