import { DriverStatus } from '@food-delivery/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('drivers')
export class Driver {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index({ unique: true })
  @Column()
  userId!: string; // credential id from auth-service (role DRIVER)

  @Column()
  vehicleType!: string;

  @Column()
  licensePlate!: string;

  @Column({ type: 'enum', enum: DriverStatus, default: DriverStatus.OFFLINE })
  status!: DriverStatus;

  /** Admin review of the driver (#147). No identity documents are stored. */
  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  verificationStatus!: 'PENDING' | 'VERIFIED' | 'REJECTED';

  /** The admin's note to the driver, e.g. why the review failed. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  verificationNote!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
