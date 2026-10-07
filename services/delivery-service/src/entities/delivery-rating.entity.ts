import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A customer's rating of the driver who delivered their order (#144). One per delivery (unique
 * deliveryId), written once and never edited. `customerId` is kept for eligibility and auditing only;
 * it is never returned to the driver.
 */
@Entity('delivery_ratings')
@Index('IDX_delivery_ratings_driver_created', ['driverId', 'createdAt'])
export class DeliveryRating {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_delivery_ratings_delivery', { unique: true })
  @Column({ type: 'uuid' })
  deliveryId!: string;

  @Column()
  driverId!: string; // driver-service Driver.id, as on the delivery

  @Column({ type: 'uuid' })
  customerId!: string;

  /** 1–5 stars (CHECK constraint in migration 007). */
  @Column({ type: 'smallint' })
  score!: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  comment!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
