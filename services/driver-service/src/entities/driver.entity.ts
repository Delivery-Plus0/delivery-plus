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

  /** Start of the current idle period; null when not AVAILABLE (#210). */
  @Column({ type: 'timestamptz', nullable: true })
  availableSince!: Date | null;

  /**
   * Admin review of the driver (#147). With the application (#207): PENDING without `submittedAt` is a
   * draft the driver is still filling in; PENDING with it is waiting in the review queue.
   */
  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  verificationStatus!: 'PENDING' | 'VERIFIED' | 'REJECTED';

  /** The admin's note to the driver, e.g. why the review failed. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  verificationNote!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  /** #207: when the driver sent a complete application for review; null while it is a draft. */
  @Column({ type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  /** #207: the last four digits of the national ID. Never the full number. Not part of the profile. */
  @Column({ type: 'varchar', length: 4, nullable: true, select: false })
  nationalIdLast4?: string | null;

  /**
   * #207: HMAC-SHA256 of the national ID under NATIONAL_ID_HMAC_SECRET, unique, so one ID can't back two
   * driver accounts. Never selected by default and never returned.
   */
  @Column({ type: 'varchar', length: 64, nullable: true, select: false })
  nationalIdHash?: string | null;

  /** #207: calendar dates (YYYY-MM-DD), Cairo time. */
  @Column({ type: 'date', nullable: true })
  drivingLicenceExpiresOn!: string | null;

  @Column({ type: 'date', nullable: true })
  vehicleLicenceExpiresOn!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
