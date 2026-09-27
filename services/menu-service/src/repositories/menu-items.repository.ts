import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MenuItem } from '../entities/menu-item.entity';

@Injectable()
export class MenuItemsRepository {
  constructor(
    @InjectRepository(MenuItem)
    private readonly repo: Repository<MenuItem>,
  ) {}

  findById(id: string): Promise<MenuItem | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByRestaurant(restaurantId: string): Promise<MenuItem[]> {
    return this.repo.find({ where: { restaurantId }, order: { name: 'ASC' } });
  }

  create(
    data: Pick<MenuItem, 'restaurantId' | 'categoryId' | 'name' | 'description'> & {
      price: number;
    },
  ): Promise<MenuItem> {
    const entity = this.repo.create({ ...data, price: data.price.toFixed(2) });
    return this.repo.save(entity);
  }

  async update(id: string, data: Partial<Omit<MenuItem, 'price'>> & { price?: number }): Promise<MenuItem | null> {
    const { price, ...rest } = data;
    await this.repo.update(
      { id },
      { ...rest, ...(price !== undefined ? { price: price.toFixed(2) } : {}) },
    );
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete({ id });
  }
}
