import { Injectable } from '@nestjs/common';
import { AppError, ConflictError, DeliveryStatus, ForbiddenError, NotFoundError, UserRole } from '@food-delivery/shared';
import { DriverServiceClient } from '../common/driver-service.client';
import { OrderServiceClient } from '../common/order-service.client';
import { CreateRatingDto, DeliveryRatingStatusDto, DriverRatingSummaryDto, RatingDto } from '../dto/rating.dto';
import { Delivery } from '../entities/delivery.entity';
import { DeliveryRating } from '../entities/delivery-rating.entity';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { RatingsRepository } from '../repositories/ratings.repository';

export const RATING_WINDOW_DAYS = 14;
const RATING_WINDOW_MS = RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const RECENT_COMMENTS = 5;

/** 422: the request is understood but this delivery can't be rated (not delivered yet, window closed). */
export class RatingNotAllowedError extends AppError {
  constructor(message: string) {
    super(422, 'UnprocessableEntity', message);
  }
}

export interface Rater {
  userId: string;
  role: UserRole;
}

/** PostgreSQL unique_violation, as surfaced by TypeORM's QueryFailedError. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

const view = (rating: DeliveryRating): RatingDto => ({ score: rating.score, comment: rating.comment, createdAt: rating.createdAt });

const NOT_THE_CUSTOMER = 'Only the customer who placed this order can rate it.';

/**
 * Driver ratings (#144). Every rule is enforced here, never by the app: only the order's customer,
 * only once the delivery is DELIVERED, only within 14 days of delivery, only once per delivery.
 * The driver rated is the delivery's driver (assignment happens once, so that is who delivered it).
 */
@Injectable()
export class RatingsService {
  constructor(
    private readonly deliveries: DeliveriesRepository,
    private readonly ratings: RatingsRepository,
    private readonly orderClient: OrderServiceClient,
    private readonly driverClient: DriverServiceClient,
  ) {}

  async rate(
    deliveryId: string,
    rater: Rater,
    dto: CreateRatingDto,
    now = new Date(),
  ): Promise<{ rating: RatingDto; created: boolean }> {
    const delivery = await this.findDelivery(deliveryId);
    await this.assertOrderCustomer(delivery, rater);
    const comment = dto.comment ? dto.comment : null;

    const existing = await this.ratings.findByDeliveryId(delivery.id);
    if (existing) return { rating: this.replayOrConflict(existing, dto.score, comment), created: false };

    const reason = this.ineligibility(delivery, now);
    if (reason) throw new RatingNotAllowedError(reason);

    try {
      const saved = await this.ratings.create({
        deliveryId: delivery.id,
        driverId: delivery.driverId!,
        customerId: rater.userId,
        score: dto.score,
        comment,
      });
      return { rating: view(saved), created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent request stored a rating first: answer as if it had been there already.
      const winner = await this.ratings.findByDeliveryId(delivery.id);
      if (!winner) throw error;
      return { rating: this.replayOrConflict(winner, dto.score, comment), created: false };
    }
  }

  async getStatus(deliveryId: string, reader: Rater, now = new Date()): Promise<DeliveryRatingStatusDto> {
    const delivery = await this.findDelivery(deliveryId);
    if (reader.role !== UserRole.ADMIN) await this.assertOrderCustomer(delivery, reader);

    const existing = await this.ratings.findByDeliveryId(delivery.id);
    const deliveredAt = this.deliveredAt(delivery);
    const closesAt = deliveredAt ? new Date(deliveredAt.getTime() + RATING_WINDOW_MS) : null;
    if (existing) return { rating: view(existing), canRate: false, reason: 'You already rated this delivery.', closesAt };

    const reason = this.ineligibility(delivery, now);
    return { rating: null, canRate: reason === null, reason, closesAt };
  }

  /** The calling driver's average, count and latest comments; nothing about who wrote them. */
  async getSummaryForDriver(authHeader: string): Promise<DriverRatingSummaryDto> {
    const driver = await this.driverClient.getOwnProfile(authHeader);
    if (!driver) return { average: null, count: 0, recentComments: [] };

    const [summary, recent] = await Promise.all([
      this.ratings.findSummary(driver.id),
      this.ratings.findRecentComments(driver.id, RECENT_COMMENTS),
    ]);
    const count = summary?.ratingCount ?? 0;
    const average = summary && count > 0 ? Math.round((summary.ratingSum / count) * 10) / 10 : null;
    return { average, count, recentComments: recent.map(view) };
  }

  /** Why this delivery can't be rated now, or null when it can. */
  private ineligibility(delivery: Delivery, now: Date): string | null {
    if (delivery.status !== DeliveryStatus.DELIVERED || !delivery.driverId) {
      return 'You can rate the driver once the order has been delivered.';
    }
    const deliveredAt = this.deliveredAt(delivery);
    if (deliveredAt && now.getTime() - deliveredAt.getTime() > RATING_WINDOW_MS) {
      return `Ratings close ${RATING_WINDOW_DAYS} days after delivery.`;
    }
    return null;
  }

  /** The delivery time; deliveries finished before stage times existed fall back to their last update. */
  private deliveredAt(delivery: Delivery): Date | null {
    if (delivery.status !== DeliveryStatus.DELIVERED) return null;
    return new Date(delivery.deliveredAt ?? delivery.updatedAt);
  }

  /** An identical retry gets the stored rating back (safe after a lost response); anything else is a duplicate. */
  private replayOrConflict(existing: DeliveryRating, score: number, comment: string | null): RatingDto {
    if (existing.score === score && (existing.comment ?? null) === comment) return view(existing);
    throw new ConflictError('This delivery has already been rated.');
  }

  private async findDelivery(deliveryId: string): Promise<Delivery> {
    const delivery = await this.deliveries.findById(deliveryId);
    if (!delivery) throw new NotFoundError(`Delivery ${deliveryId} not found`);
    return delivery;
  }

  /** Only the customer who placed the order. Old deliveries without a customer copy ask order-service. */
  private async assertOrderCustomer(delivery: Delivery, rater: Rater): Promise<void> {
    if (rater.role !== UserRole.CUSTOMER) throw new ForbiddenError(NOT_THE_CUSTOMER);
    const customerId = delivery.customerId ?? (await this.orderClient.getOrder(delivery.orderId)).customerId;
    if (customerId !== rater.userId) throw new ForbiddenError(NOT_THE_CUSTOMER);
  }
}
