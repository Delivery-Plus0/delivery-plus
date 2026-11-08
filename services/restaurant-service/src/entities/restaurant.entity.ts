import { RestaurantStatus } from '@food-delivery/shared';
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const RESTAURANT_APPROVAL_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const;
export type RestaurantApprovalStatus = (typeof RESTAURANT_APPROVAL_STATUSES)[number];

@Entity('restaurants')
export class Restaurant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  ownerId!: string; // userId of the RESTAURANT_OWNER, from auth-service

  @Column()
  name!: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'text', nullable: true })
  coverImageUrl?: string;

  @Column({ type: 'text', nullable: true })
  logoUrl?: string;

  @Column()
  address!: string;

  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  deliveryRadiusKm!: string | null;

  @Column({ type: 'enum', enum: RestaurantStatus, default: RestaurantStatus.CLOSED })
  status!: RestaurantStatus;

  /**
   * #208: the application, separate from the operating `status`. A new restaurant is a DRAFT; only an
   * APPROVED one can open or appear to customers. Restaurants that existed before #208 are APPROVED.
   */
  @Column({ type: 'varchar', length: 20, default: 'DRAFT' })
  approvalStatus!: RestaurantApprovalStatus;

  /** #208: when the owner last sent the application for review; a reviewer decides that exact submission. */
  @Column({ type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt!: Date | null;

  /** #208: the reviewer's latest note to the owner, e.g. what to fix. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  approvalNote!: string | null;

  /** #208: the only legal detail required to submit (owner decision); never public. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  legalName!: string | null;

  /** #208: optional; never public. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  commercialRegistrationNumber!: string | null;

  /** #208: optional; never public. */
  @Column({ type: 'varchar', length: 50, nullable: true })
  taxCardNumber!: string | null;

  /** #208: Egyptian mobile in E.164, required to submit; drivers reach the restaurant on it (#211). Never public. */
  @Column({ type: 'varchar', length: 20, nullable: true })
  contactPhone!: string | null;

  /** #208: up to 5 short cuisine labels shown to customers, e.g. "Burgers". */
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  cuisineTags!: string[];

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
