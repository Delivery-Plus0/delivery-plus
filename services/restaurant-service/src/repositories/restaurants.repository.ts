import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RestaurantStatus } from '@food-delivery/shared';
import { Restaurant } from '../entities/restaurant.entity';
import { ListRestaurantsQueryDto } from '../dto/list-restaurants-query.dto';

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

  create(data: Pick<Restaurant, 'ownerId' | 'name' | 'description' | 'address'>): Promise<Restaurant> {
    return this.repo.save(this.repo.create(data));
  }

  async update(id: string, data: Partial<Restaurant>): Promise<Restaurant | null> {
    await this.repo.update({ id }, data);
    return this.findById(id);
  }

  async list(query: ListRestaurantsQueryDto): Promise<[Restaurant[], number]> {
    const qb = this.repo.createQueryBuilder('r');

    if (query.status) {
      qb.andWhere('r.status = :status', { status: query.status });
    }
    if (query.search) {
      qb.andWhere('r.name ILIKE :search', { search: `%${query.search}%` });
    }

    qb.orderBy(`r.${query.sortBy}`, query.sortOrder)
      .skip((query.page - 1) * query.limit)
      .take(query.limit);

    return qb.getManyAndCount();
  }

  findOpenById(id: string): Promise<Restaurant | null> {
    return this.repo.findOne({ where: { id, status: RestaurantStatus.OPEN } });
  }
}
