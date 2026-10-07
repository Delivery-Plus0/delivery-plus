import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Running total of a driver's ratings (#144), updated in the same transaction as each new rating. */
@Entity('driver_rating_summaries')
export class DriverRatingSummary {
  @PrimaryColumn()
  driverId!: string;

  @Column({ type: 'integer', default: 0 })
  ratingCount!: number;

  @Column({ type: 'integer', default: 0 })
  ratingSum!: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
