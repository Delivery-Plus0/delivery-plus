import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeliveryRating } from '../entities/delivery-rating.entity';
import { DriverRatingSummary } from '../entities/driver-rating-summary.entity';

export type NewRating = Pick<DeliveryRating, 'deliveryId' | 'driverId' | 'customerId' | 'score' | 'comment'>;

@Injectable()
export class RatingsRepository {
  constructor(
    @InjectRepository(DeliveryRating)
    private readonly ratings: Repository<DeliveryRating>,
    @InjectRepository(DriverRatingSummary)
    private readonly summaries: Repository<DriverRatingSummary>,
  ) {}

  findByDeliveryId(deliveryId: string): Promise<DeliveryRating | null> {
    return this.ratings.findOne({ where: { deliveryId } });
  }

  /**
   * Stores the rating and adds it to the driver's running count and sum in one transaction, so the
   * summary can never miss or double-count a rating. A second rating for the same delivery fails on
   * the unique deliveryId index (caller maps it to 409 / idempotent replay).
   */
  create(rating: NewRating): Promise<DeliveryRating> {
    return this.ratings.manager.transaction(async (manager) => {
      const saved = await manager.getRepository(DeliveryRating).save(manager.getRepository(DeliveryRating).create(rating));
      await manager.query(
        `INSERT INTO "driver_rating_summaries" ("driverId", "ratingCount", "ratingSum", "updatedAt")
         VALUES ($1, 1, $2, now())
         ON CONFLICT ("driverId") DO UPDATE
           SET "ratingCount" = "driver_rating_summaries"."ratingCount" + 1,
               "ratingSum" = "driver_rating_summaries"."ratingSum" + EXCLUDED."ratingSum",
               "updatedAt" = now()`,
        [rating.driverId, rating.score],
      );
      return saved;
    });
  }

  findSummary(driverId: string): Promise<DriverRatingSummary | null> {
    return this.summaries.findOne({ where: { driverId } });
  }

  /** The driver's latest ratings that carry a comment, newest first. */
  findRecentComments(driverId: string, limit: number): Promise<DeliveryRating[]> {
    return this.ratings
      .createQueryBuilder('r')
      .where('r.driverId = :driverId', { driverId })
      .andWhere("r.comment IS NOT NULL AND r.comment <> ''")
      .orderBy('r.createdAt', 'DESC')
      .take(limit)
      .getMany();
  }
}
