import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { RestaurantStatus } from '@food-delivery/shared';
import { Restaurant } from '../entities/restaurant.entity';
import { ListRestaurantsQueryDto } from '../dto/list-restaurants-query.dto';

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

  create(
    data: Pick<Restaurant, 'ownerId' | 'name' | 'description' | 'address' | 'latitude' | 'longitude'>,
  ): Promise<Restaurant> {
    return this.repo.save(this.repo.create(data));
  }

  async update(id: string, data: Partial<Restaurant>): Promise<Restaurant | null> {
    await this.repo.update({ id }, data);
    return this.findById(id);
  }

  /**
   * Owner status change, compare-and-set: applies only while the restaurant is not SUSPENDED, so an
   * owner can never lift an admin suspension, even one written after the owner's read. Returns the
   * updated restaurant, or null when it is suspended.
   */
  async updateStatusUnlessSuspended(id: string, status: RestaurantStatus): Promise<Restaurant | null> {
    const result = await this.repo.update({ id, status: Not(RestaurantStatus.SUSPENDED) }, { status });
    return result.affected ? this.findById(id) : null;
  }

  async list(query: ListRestaurantsQueryDto, defaultRadiusKm: number): Promise<[RestaurantListItem[], number]> {
    const qb = this.repo.createQueryBuilder('r');

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
          `${distanceExpression} <= COALESCE(r.deliveryRadiusKm::double precision, :defaultRadiusKm)`,
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
    return this.repo.findOne({ where: { id, status: RestaurantStatus.OPEN } });
  }
}
