import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type RestaurantReviewDecision = 'APPROVED' | 'REJECTED';

/**
 * One staff decision on a restaurant application (#208): who decided what, with which note, on which
 * submission. Append-only (a trigger refuses updates); rows go only with the restaurant.
 */
@Entity('restaurant_reviews')
@Index('IDX_restaurant_reviews_restaurant', ['restaurantId', 'reviewedAt'])
export class RestaurantReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  restaurantId!: string;

  /** The staff member's user id (the token's `sub`). Never shown to the owner. */
  @Column({ type: 'uuid' })
  reviewerUserId!: string;

  @Column({ type: 'varchar', length: 20 })
  decision!: RestaurantReviewDecision;

  @Column({ type: 'varchar', length: 300, nullable: true })
  note!: string | null;

  @Column({ type: 'timestamptz' })
  applicationSubmittedAt!: Date;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  reviewedAt!: Date;
}
