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

  @Column({ type: 'enum', enum: DeliveryStatus, default: DeliveryStatus.CREATED })
  status!: DeliveryStatus;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
