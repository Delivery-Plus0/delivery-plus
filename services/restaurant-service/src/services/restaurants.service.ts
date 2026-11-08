import { Inject, Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  PaginatedResult,
  RestaurantStatus,
  S3StorageService,
  UserRole,
  CacheService,
} from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { RestaurantsRepository } from '../repositories/restaurants.repository';
import { CreateRestaurantDto } from '../dto/create-restaurant.dto';
import { UpdateRestaurantDto } from '../dto/update-restaurant.dto';
import { UpdateRestaurantStatusDto } from '../dto/update-restaurant-status.dto';
import { ListRestaurantsQueryDto } from '../dto/list-restaurants-query.dto';
import { PublicRestaurantDto } from '../dto/public-restaurant.dto';
import { Restaurant, RestaurantApprovalStatus } from '../entities/restaurant.entity';
import { RestaurantReview } from '../entities/restaurant-review.entity';
import { MenuServiceClient } from '../common/menu-service.client';
import { NotInReviewError, OwnerHasRestaurantError, SUBMITTABLE } from '../repositories/restaurants.repository';
import { ReviewRestaurantApplicationDto } from '../dto/restaurant-application.dto';
import {
  RestaurantApplicationIncompleteError,
  RestaurantApplicationNotEditableError,
  RestaurantApplicationNotInReviewError,
  RestaurantApplicationRequirement,
  RestaurantLimitReachedError,
  RestaurantNotApprovedError,
} from '../common/application-errors';

/** #208: fields reviewed with the application; legal details change only before approval. */
const LEGAL_FIELDS = ['legalName', 'commercialRegistrationNumber', 'taxCardNumber'] as const;
/** #208: what customers see of the restaurant, frozen while a reviewer looks at it. */
const REVIEWED_FIELDS = ['name', 'address', 'latitude', 'longitude'] as const;
const ALL_APPROVAL_STATUSES: readonly RestaurantApprovalStatus[] = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'];

/** The owner's view of their restaurant: the public card plus the application (#208). */
export interface OwnerRestaurantDto extends PublicRestaurantDto {
  approvalStatus: RestaurantApprovalStatus;
  submittedAt: Date | null;
  approvedAt: Date | null;
  approvalNote: string | null;
  legalName: string | null;
  commercialRegistrationNumber: string | null;
  taxCardNumber: string | null;
  contactPhone: string | null;
  lastReview: { decision: RestaurantReview['decision']; note: string | null; reviewedAt: Date } | null;
}

/** The staff view: the owner's view plus the owner id and the whole review history, newest first. */
export interface StaffRestaurantApplicationDto extends OwnerRestaurantDto {
  ownerId: string;
  reviews: Pick<RestaurantReview, 'id' | 'decision' | 'note' | 'reviewerUserId' | 'applicationSubmittedAt' | 'reviewedAt'>[];
}

@Injectable()
export class RestaurantsService {
  private readonly imageMaxSizeBytes = 10 * 1024 * 1024;

  constructor(
    private readonly restaurants: RestaurantsRepository,
    private readonly cache: CacheService,
    private readonly storage: S3StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly menus: MenuServiceClient,
  ) {}

  /** #208: a new restaurant is a DRAFT, and an owner can have one (409 RestaurantLimitReached). */
  async create(ownerId: string, dto: CreateRestaurantDto): Promise<OwnerRestaurantDto> {
    try {
      const created = await this.restaurants.createForOwner({
        ownerId,
        ...dto,
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
      });
      return this.toOwnerRestaurant(created, []);
    } catch (error) {
      if (error instanceof OwnerHasRestaurantError) throw new RestaurantLimitReachedError();
      throw error;
    }
  }

  /** Public: only an APPROVED restaurant exists for customers (#208). */
  async getById(id: string): Promise<PublicRestaurantDto> {
    const restaurant = await this.getEntityById(id);
    if (restaurant.approvalStatus !== 'APPROVED') throw new NotFoundError(`Restaurant ${id} not found`);
    return this.toPublicRestaurant(restaurant);
  }

  async listMine(ownerId: string): Promise<OwnerRestaurantDto[]> {
    const restaurants = await this.restaurants.findByOwner(ownerId);
    return Promise.all(restaurants.map(async (restaurant) => this.toOwnerRestaurant(restaurant, await this.restaurants.reviews(restaurant.id))));
  }

  /**
   * #208: sends a DRAFT or REJECTED application for review. Needs the legal name, the contact phone, the
   * location, and a menu customers can order from (a category and an available item); otherwise 422 with
   * what is missing.
   */
  async submit(id: string, requesterId: string): Promise<OwnerRestaurantDto> {
    const restaurant = await this.assertOwnership(id, requesterId);
    const fresh = (await this.restaurants.findById(id)) ?? restaurant;
    if (!SUBMITTABLE.includes(fresh.approvalStatus)) throw new RestaurantApplicationNotEditableError(fresh.approvalStatus);
    const missing = await this.missingForApproval(fresh);
    if (missing.length) throw new RestaurantApplicationIncompleteError(missing);

    const submitted = await this.restaurants.submitIfSubmittable(id);
    await this.cache.del(`restaurant:${id}`);
    if (!submitted) {
      const now = await this.restaurants.findById(id);
      throw new RestaurantApplicationNotEditableError(now?.approvalStatus ?? 'UNKNOWN');
    }
    return this.toOwnerRestaurant(submitted, await this.restaurants.reviews(id));
  }

  /** #208: the application with its review history, for staff with onboarding.review. */
  async getApplicationForStaff(id: string): Promise<StaffRestaurantApplicationDto> {
    const restaurant = await this.restaurants.findById(id);
    if (!restaurant) throw new NotFoundError(`Restaurant ${id} not found`);
    return this.toStaffApplication(restaurant, await this.restaurants.reviews(id));
  }

  /**
   * #208: a staff decision on the exact submission the reviewer loaded (compare-and-set on submittedAt).
   * An approval re-checks the application, menu included (422). Repeating the same decision is a no-op.
   */
  async review(reviewerUserId: string, id: string, dto: ReviewRestaurantApplicationDto): Promise<StaffRestaurantApplicationDto> {
    if (!(await this.restaurants.findById(id))) throw new NotFoundError(`Restaurant ${id} not found`);
    try {
      await this.restaurants.decideIfSubmitted(
        id,
        { decision: dto.decision, note: dto.note ? dto.note : null, reviewerUserId, submittedAt: new Date(dto.submittedAt) },
        async (restaurant) => {
          if (dto.decision !== 'APPROVED') return;
          const missing = await this.missingForApproval(restaurant);
          if (missing.length) throw new RestaurantApplicationIncompleteError(missing);
        },
      );
    } catch (error) {
      if (error instanceof NotInReviewError) {
        const now = await this.restaurants.findById(id);
        throw new RestaurantApplicationNotInReviewError(now?.approvalStatus ?? 'UNKNOWN');
      }
      throw error;
    } finally {
      await this.cache.del(`restaurant:${id}`);
    }
    return this.getApplicationForStaff(id);
  }

  private async missingForApproval(restaurant: Restaurant): Promise<RestaurantApplicationRequirement[]> {
    const missing: RestaurantApplicationRequirement[] = [];
    if (!restaurant.legalName) missing.push('legalName');
    if (!restaurant.contactPhone) missing.push('contactPhone');
    if (restaurant.latitude === null || restaurant.latitude === undefined || restaurant.longitude === null || restaurant.longitude === undefined) {
      missing.push('location');
    }
    const menu = await this.menus.menuReadiness(restaurant.id);
    if (!menu.categories) missing.push('menuCategory');
    if (!menu.availableItems) missing.push('availableMenuItem');
    return missing;
  }

  private async getEntityById(id: string): Promise<Restaurant> {
    const key = `restaurant:${id}`;
    return this.cache.getOrSet(key, async () => {
      const restaurant = await this.restaurants.findById(id);
      if (!restaurant) {
        throw new NotFoundError(`Restaurant ${id} not found`);
      }
      return restaurant;
    }, 30);
  }

  async list(query: ListRestaurantsQueryDto): Promise<PaginatedResult<PublicRestaurantDto>> {
    const [items, total] = await this.restaurants.list(query, this.config.defaultDeliveryRadiusKm);
    return {
      items: items.map(({ restaurant, distanceKm }) => this.toPublicRestaurant(restaurant, distanceKm)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit) || 1,
    };
  }

  async setDeliveryRadius(id: string, deliveryRadiusKm: number): Promise<PublicRestaurantDto> {
    await this.getEntityById(id);
    const updated = await this.restaurants.update(id, { deliveryRadiusKm: String(deliveryRadiusKm) });
    if (!updated) {
      throw new NotFoundError(`Restaurant ${id} not found`);
    }
    await this.cache.del(`restaurant:${id}`);
    return this.toPublicRestaurant(updated);
  }

  /**
   * #208: legal details change only before approval (DRAFT or REJECTED); name, address and location not
   * while a reviewer looks at them (SUBMITTED). The write is compare-and-set on the approval status, so a
   * submit racing it can't be overtaken.
   */
  async update(id: string, requesterId: string, dto: UpdateRestaurantDto): Promise<OwnerRestaurantDto> {
    await this.assertOwnership(id, requesterId);
    const changes = Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined)) as Partial<Restaurant>;
    const touched = Object.keys(changes);
    const legal = touched.filter((field) => (LEGAL_FIELDS as readonly string[]).includes(field));
    const reviewed = touched.filter((field) => (REVIEWED_FIELDS as readonly string[]).includes(field));
    const allowed = ALL_APPROVAL_STATUSES.filter(
      (status) => (!legal.length || SUBMITTABLE.includes(status)) && (!reviewed.length || status !== 'SUBMITTED'),
    );

    const updated = touched.length
      ? await this.restaurants.updateIfApprovalIn(id, changes, allowed)
      : await this.restaurants.findById(id);
    await this.cache.del(`restaurant:${id}`);
    if (!updated) {
      const now = await this.restaurants.findById(id);
      if (!now) throw new NotFoundError(`Restaurant ${id} not found`);
      const locked = SUBMITTABLE.includes(now.approvalStatus) ? reviewed : now.approvalStatus === 'SUBMITTED' ? [...legal, ...reviewed] : legal;
      throw new RestaurantApplicationNotEditableError(now.approvalStatus, locked);
    }
    return this.toOwnerRestaurant(updated, await this.restaurants.reviews(id));
  }

  async updateStatus(
    id: string,
    requesterId: string,
    requesterRole: UserRole,
    dto: UpdateRestaurantStatusDto,
  ): Promise<Restaurant> {
    // ADMIN can force any status transition, including setting and lifting SUSPENDED.
    if (requesterRole === UserRole.ADMIN) {
      await this.getEntityById(id);
      const updated = await this.restaurants.update(id, { status: dto.status });
      await this.cache.del(`restaurant:${id}`);
      return updated as Restaurant;
    }

    // Owners manage OPEN / BUSY / CLOSED only: they can neither suspend their restaurant nor lift an
    // admin suspension (#125). The write is compare-and-set against SUSPENDED, because the ownership
    // read above may come from the cache and an admin may suspend the restaurant at any moment.
    await this.assertOwnership(id, requesterId);
    if (dto.status === RestaurantStatus.SUSPENDED) {
      throw new ForbiddenError('Only an administrator can suspend a restaurant');
    }
    const updated = await this.restaurants.updateStatusUnlessSuspended(id, dto.status);
    await this.cache.del(`restaurant:${id}`);
    if (!updated) {
      const now = await this.restaurants.findById(id);
      if (now && now.status !== RestaurantStatus.SUSPENDED && now.approvalStatus !== 'APPROVED') {
        throw new RestaurantNotApprovedError(now.approvalStatus);
      }
      throw new ForbiddenError('This restaurant is suspended by an administrator; contact support to have it reinstated');
    }
    return updated;
  }

  async createImageUploadUrl(
    id: string,
    requesterId: string,
    imageType: 'cover' | 'logo',
    contentType: string,
  ) {
    await this.assertOwnership(id, requesterId);
    return this.storage.generateUploadUrl(
      `restaurants/${id}/${imageType}/`,
      contentType,
      this.imageMaxSizeBytes,
    );
  }

  async confirmImageUpload(
    id: string,
    requesterId: string,
    imageType: 'cover' | 'logo',
    objectKey: string,
  ): Promise<Restaurant> {
    await this.assertOwnership(id, requesterId);
    const verifiedUpload = await this.storage.verifyUploadedObject(
      objectKey,
      `restaurants/${id}/${imageType}/`,
      this.imageMaxSizeBytes,
    );
    const imageUrlUpdate = imageType === 'cover'
      ? { coverImageUrl: verifiedUpload.publicUrl }
      : { logoUrl: verifiedUpload.publicUrl };
    const updated = await this.restaurants.update(id, imageUrlUpdate);
    await this.cache.del(`restaurant:${id}`);
    return updated as Restaurant;
  }

  /** Used by menu-service (via HTTP) to confirm the caller owns the restaurant. */
  async assertOwnership(id: string, requesterId: string): Promise<Restaurant> {
    const restaurant = await this.getEntityById(id);
    if (restaurant.ownerId !== requesterId) {
      throw new ForbiddenError('You do not own this restaurant');
    }
    return restaurant;
  }

  private toOwnerRestaurant(restaurant: Restaurant, reviews: RestaurantReview[]): OwnerRestaurantDto {
    const latest = reviews[0];
    return {
      ...this.toPublicRestaurant(restaurant),
      approvalStatus: restaurant.approvalStatus,
      submittedAt: restaurant.submittedAt ?? null,
      approvedAt: restaurant.approvedAt ?? null,
      approvalNote: restaurant.approvalNote ?? null,
      legalName: restaurant.legalName ?? null,
      commercialRegistrationNumber: restaurant.commercialRegistrationNumber ?? null,
      taxCardNumber: restaurant.taxCardNumber ?? null,
      contactPhone: restaurant.contactPhone ?? null,
      lastReview: latest ? { decision: latest.decision, note: latest.note, reviewedAt: latest.reviewedAt } : null,
    };
  }

  private toStaffApplication(restaurant: Restaurant, reviews: RestaurantReview[]): StaffRestaurantApplicationDto {
    return {
      ...this.toOwnerRestaurant(restaurant, reviews),
      ownerId: restaurant.ownerId,
      reviews: reviews.map(({ id, decision, note, reviewerUserId, applicationSubmittedAt, reviewedAt }) => ({
        id,
        decision,
        note,
        reviewerUserId,
        applicationSubmittedAt,
        reviewedAt,
      })),
    };
  }

  private toPublicRestaurant(restaurant: Restaurant, distanceKm?: number): PublicRestaurantDto {
    return {
      id: restaurant.id,
      name: restaurant.name,
      description: restaurant.description,
      coverImageUrl: restaurant.coverImageUrl,
      logoUrl: restaurant.logoUrl,
      address: restaurant.address,
      status: restaurant.status,
      approvalStatus: restaurant.approvalStatus ?? 'APPROVED',
      cuisineTags: restaurant.cuisineTags ?? [],
      latitude: restaurant.latitude ?? null,
      longitude: restaurant.longitude ?? null,
      deliveryRadiusKm: restaurant.deliveryRadiusKm === null || restaurant.deliveryRadiusKm === undefined
        ? this.config.defaultDeliveryRadiusKm
        : Number(restaurant.deliveryRadiusKm),
      ...(distanceKm === undefined ? {} : { distanceKm }),
    };
  }
}
