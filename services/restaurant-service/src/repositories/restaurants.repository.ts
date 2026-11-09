import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Not, Repository } from 'typeorm';
import { RestaurantStatus } from '@food-delivery/shared';
import { Restaurant, RestaurantApprovalStatus } from '../entities/restaurant.entity';
import { RestaurantReview, RestaurantReviewDecision } from '../entities/restaurant-review.entity';
import { ListRestaurantsQueryDto } from '../dto/list-restaurants-query.dto';

/** The owner already has a restaurant (one per owner for now, #208). */
export class OwnerHasRestaurantError extends Error {}
/** A review was refused: not SUBMITTED, or a different submission than the reviewer's. */
export class NotInReviewError extends Error {}

/** #208: the application can be (re)submitted from these states. */
export const SUBMITTABLE: readonly RestaurantApprovalStatus[] = ['DRAFT', 'REJECTED'];

export interface RestaurantReviewDecisionInput {
  decision: RestaurantReviewDecision;
  note: string | null;
  reviewerUserId: string;
  submittedAt: Date;
}

export interface RestaurantListItem {
  restaurant: Restaurant;
  distanceKm?: number;
}

@Injectable()
export class RestaurantsRepository {
  constructor(
    @InjectRepository(Restaurant)
    private readonly repo: Repository<Restaurant>,
  ) {}

  findById(id: string): Promise<Restaurant | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByOwner(ownerId: string): Promise<Restaurant[]> {
    return this.repo.find({ where: { ownerId }, order: { createdAt: 'DESC' } });
  }

  /**
   * Creates the owner's restaurant as a DRAFT, refusing a second one (#208). An advisory lock per owner
   * serializes concurrent creates, so two requests at once can't both pass the check. Owners who had
   * several restaurants before #208 keep them.
   */
  async createForOwner(data: Partial<Restaurant> & Pick<Restaurant, 'ownerId' | 'name' | 'address'>): Promise<Restaurant> {
    return this.repo.manager.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`restaurant-owner:${data.ownerId}`]);
      if (await manager.count(Restaurant, { where: { ownerId: data.ownerId } })) throw new OwnerHasRestaurantError();
      const saved = await manager.save(manager.create(Restaurant, { ...data, approvalStatus: 'DRAFT' }));
      return manager.findOneOrFail(Restaurant, { where: { id: saved.id } });
    });
  }

  async update(id: string, data: Partial<Restaurant>): Promise<Restaurant | null> {
    await this.repo.update({ id }, data);
    return this.findById(id);
  }

  /**
   * Updates only while the application is in one of `statuses` (compare-and-set, #208), so a submit or a
   * decision landing between the caller's read and this write is never overwritten. Null when refused.
   */
  async updateIfApprovalIn(id: string, data: Partial<Restaurant>, statuses: readonly RestaurantApprovalStatus[]): Promise<Restaurant | null> {
    const result = await this.repo.update({ id, approvalStatus: In([...statuses]) }, data);
    return result.affected ? this.findById(id) : null;
  }

  /**
   * Owner status change, compare-and-set: applies only while the restaurant is not SUSPENDED, so an
   * owner can never lift an admin suspension, even one written after the owner's read. OPEN and BUSY
   * also need the restaurant to be APPROVED at write time (#208). Returns the updated restaurant, or
   * null when refused (the caller re-reads to say why).
   */
  async updateStatusUnlessSuspended(id: string, status: RestaurantStatus): Promise<Restaurant | null> {
    const takesOrders = status === RestaurantStatus.OPEN || status === RestaurantStatus.BUSY;
    const result = await this.repo.update(
      { id, status: Not(RestaurantStatus.SUSPENDED), ...(takesOrders ? { approvalStatus: 'APPROVED' as const } : {}) },
      { status },
    );
    return result.affected ? this.findById(id) : null;
  }

  /** Submits a DRAFT or a REJECTED application (compare-and-set). Null when it isn't submittable now. */
  async submitIfSubmittable(id: string): Promise<Restaurant | null> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Restaurant)
      .set({ approvalStatus: 'SUBMITTED', submittedAt: () => 'now()', approvalNote: null })
      .where('id = :id', { id })
      .andWhere('"approvalStatus" IN (:...statuses)', { statuses: [...SUBMITTABLE] })
      .execute();
    return result.affected ? this.findById(id) : null;
  }

  /**
   * Records a staff decision on a SUBMITTED application, under a row lock, only for exactly the
   * submission the reviewer looked at. `check` sees the locked restaurant and throws to refuse (an
   * approval re-checks the application). The same decision repeated on the same submission returns
   * 'repeat'; anything else not in review throws NotInReviewError.
   */
  async decideIfSubmitted(
    id: string,
    review: RestaurantReviewDecisionInput,
    check: (restaurant: Restaurant) => Promise<void> | void,
  ): Promise<'decided' | 'repeat'> {
    return this.repo.manager.transaction(async (manager) => {
      const restaurant = await this.lock(manager, id);
      if (!restaurant) throw new NotInReviewError();
      const sameSubmission = restaurant.submittedAt?.getTime() === review.submittedAt.getTime();

      if (restaurant.approvalStatus === 'SUBMITTED' && sameSubmission) {
        await check(restaurant);
        await manager
          .createQueryBuilder()
          .update(Restaurant)
          .set({
            approvalStatus: review.decision,
            approvalNote: review.note,
            approvedAt: review.decision === 'APPROVED' ? () => 'now()' : null,
          })
          .where('id = :id', { id })
          .andWhere(`"approvalStatus" = 'SUBMITTED'`)
          .execute();
        await manager.insert(RestaurantReview, {
          restaurantId: id,
          reviewerUserId: review.reviewerUserId,
          decision: review.decision,
          note: review.note,
          applicationSubmittedAt: restaurant.submittedAt as Date,
        });
        return 'decided';
      }

      const latest = await manager.findOne(RestaurantReview, { where: { restaurantId: id }, order: { reviewedAt: 'DESC', id: 'DESC' } });
      const repeat =
        sameSubmission &&
        restaurant.approvalStatus === review.decision &&
        latest?.decision === review.decision &&
        latest.applicationSubmittedAt.getTime() === review.submittedAt.getTime() &&
        (latest.note ?? null) === review.note;
      if (repeat) return 'repeat';
      throw new NotInReviewError();
    });
  }

  /** The review history, newest first. */
  reviews(restaurantId: string): Promise<RestaurantReview[]> {
    return this.repo.manager.find(RestaurantReview, { where: { restaurantId }, order: { reviewedAt: 'DESC', id: 'DESC' } });
  }

  private lock(manager: EntityManager, id: string): Promise<Restaurant | null> {
    return manager.getRepository(Restaurant).createQueryBuilder('r').setLock('pessimistic_write').where('r.id = :id', { id }).getOne();
  }

  async list(query: ListRestaurantsQueryDto, defaultRadiusKm: number): Promise<[RestaurantListItem[], number]> {
    // #208: customers only ever see APPROVED restaurants.
    const qb = this.repo.createQueryBuilder('r').where(`r.approvalStatus = 'APPROVED'`);

    if (query.status) {
      qb.andWhere('r.status = :status', { status: query.status });
    }
    if (query.search) {
      qb.andWhere('r.name ILIKE :search', { search: `%${query.search}%` });
    }

    if (query.lat !== undefined && query.lng !== undefined) {
      const distanceExpression = `
        6371 * 2 * ASIN(SQRT(LEAST(1,
          POWER(SIN(RADIANS(r.latitude - :lat) / 2), 2)
          + COS(RADIANS(:lat)) * COS(RADIANS(r.latitude))
          * POWER(SIN(RADIANS(r.longitude - :lng) / 2), 2)
        )))
      `;
      const params = { lat: query.lat, lng: query.lng, defaultRadiusKm };

      qb.andWhere('r.latitude IS NOT NULL AND r.longitude IS NOT NULL')
        .addSelect(distanceExpression, 'distanceKm')
        .andWhere(
          // Quoted: TypeORM doesn't rewrite `r.deliveryRadiusKm` before `::`, and Postgres would fold it to lower case.
          `${distanceExpression} <= COALESCE("r"."deliveryRadiusKm"::double precision, :defaultRadiusKm)`,
          params,
        );

      const total = await qb.clone().getCount();
      const { entities, raw } = await qb
        .orderBy('"distanceKm"', 'ASC')
        .addOrderBy('r.id', 'ASC')
        .skip((query.page - 1) * query.limit)
        .take(query.limit)
        .getRawAndEntities();

      return [
        entities.map((restaurant, index) => ({
          restaurant,
          distanceKm: Number(raw[index].distanceKm),
        })),
        total,
      ];
    }

    qb.orderBy(`r.${query.sortBy}`, query.sortOrder)
      .skip((query.page - 1) * query.limit)
      .take(query.limit);

    const [restaurants, total] = await qb.getManyAndCount();
    return [restaurants.map((restaurant) => ({ restaurant })), total];
  }

  findOpenById(id: string): Promise<Restaurant | null> {
    return this.repo.findOne({ where: { id, status: RestaurantStatus.OPEN, approvalStatus: 'APPROVED' } });
  }
}
