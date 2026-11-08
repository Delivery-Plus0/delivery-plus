import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type DriverReviewDecision = 'VERIFIED' | 'REJECTED';

/**
 * One staff decision on a driver (#207): who decided what, with which note, on which submission and
 * which document versions. Append-only (a trigger refuses updates); rows go only with the driver.
 */
@Entity('driver_reviews')
@Index('IDX_driver_reviews_driver', ['driverId', 'reviewedAt'])
export class DriverReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  driverId!: string;

  /** The staff member's user id (the token's `sub`). Never shown to the driver. */
  @Column({ type: 'uuid' })
  reviewerUserId!: string;

  @Column({ type: 'varchar', length: 20 })
  decision!: DriverReviewDecision;

  @Column({ type: 'varchar', length: 300, nullable: true })
  note!: string | null;

  /** The submission this decision answered; null for a decision made outside the application (#147 route). */
  @Column({ type: 'timestamptz', nullable: true })
  applicationSubmittedAt!: Date | null;

  /** The document versions that were current when the decision was made. */
  @Column({ type: 'uuid', array: true, default: () => "'{}'" })
  documentIds!: string[];

  @Column({ type: 'timestamptz', default: () => 'now()' })
  reviewedAt!: Date;
}
