import { Injectable } from '@nestjs/common';
import {
  ForbiddenError,
  NotFoundError,
  PaginatedResult,
  S3StorageService,
  UserRole,
  CacheService,
} from '@food-delivery/shared';
import { RestaurantsRepository } from '../repositories/restaurants.repository';
import { CreateRestaurantDto } from '../dto/create-restaurant.dto';
import { UpdateRestaurantDto } from '../dto/update-restaurant.dto';
import { UpdateRestaurantStatusDto } from '../dto/update-restaurant-status.dto';
import { ListRestaurantsQueryDto } from '../dto/list-restaurants-query.dto';
import { PublicRestaurantDto } from '../dto/public-restaurant.dto';
import { Restaurant } from '../entities/restaurant.entity';

@Injectable()
export class RestaurantsService {
  private readonly imageMaxSizeBytes = 10 * 1024 * 1024;

  constructor(
    private readonly restaurants: RestaurantsRepository,
    private readonly cache: CacheService,
    private readonly storage: S3StorageService,
  ) {}

  create(ownerId: string, dto: CreateRestaurantDto): Promise<Restaurant> {
    return this.restaurants.create({ ownerId, ...dto });
  }

  async getById(id: string): Promise<PublicRestaurantDto> {
    return this.toPublicRestaurant(await this.getEntityById(id));
  }

  async listMine(ownerId: string): Promise<PublicRestaurantDto[]> {
    const restaurants = await this.restaurants.findByOwner(ownerId);
    return restaurants.map((restaurant) => this.toPublicRestaurant(restaurant));
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
    const [items, total] = await this.restaurants.list(query);
    return {
      items: items.map((restaurant) => this.toPublicRestaurant(restaurant)),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit) || 1,
    };
  }

  async update(id: string, requesterId: string, dto: UpdateRestaurantDto): Promise<Restaurant> {
    const restaurant = await this.assertOwnership(id, requesterId);
    void restaurant;
    const updated = await this.restaurants.update(id, dto);
    await this.cache.del(`restaurant:${id}`);
    return updated as Restaurant;
  }

  async updateStatus(
    id: string,
    requesterId: string,
    requesterRole: UserRole,
    dto: UpdateRestaurantStatusDto,
  ): Promise<Restaurant> {
    // ADMIN can force any status transition (e.g. SUSPENDED); owners manage their own restaurant.
    if (requesterRole !== UserRole.ADMIN) {
      await this.assertOwnership(id, requesterId);
    } else {
      await this.getEntityById(id);
    }
    const updated = await this.restaurants.update(id, { status: dto.status });
    await this.cache.del(`restaurant:${id}`);
    return updated as Restaurant;
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

  private toPublicRestaurant(restaurant: Restaurant): PublicRestaurantDto {
    return {
      id: restaurant.id,
      name: restaurant.name,
      description: restaurant.description,
      coverImageUrl: restaurant.coverImageUrl,
      logoUrl: restaurant.logoUrl,
      address: restaurant.address,
      status: restaurant.status,
    };
  }
}
