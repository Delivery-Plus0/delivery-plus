import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from '../entities/category.entity';

@Injectable()
export class CategoriesRepository {
  constructor(
    @InjectRepository(Category)
    private readonly repo: Repository<Category>,
  ) {}

  findById(id: string): Promise<Category | null> {
    return this.repo.findOne({ where: { id } });
  }

  findByRestaurant(restaurantId: string): Promise<Category[]> {
    return this.repo.find({ where: { restaurantId }, order: { displayOrder: 'ASC' } });
  }

  create(data: Pick<Category, 'restaurantId' | 'name' | 'displayOrder'>): Promise<Category> {
    return this.repo.save(this.repo.create(data));
  }

  async update(id: string, data: Partial<Pick<Category, 'name' | 'displayOrder'>>): Promise<Category | null> {
    await this.repo.update({ id }, data);
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.repo.delete({ id });
  }

  /** Sets displayOrder 0..n-1 in the given order, in one transaction. */
  async reorder(ids: string[]): Promise<void> {
    await this.repo.manager.transaction(async (manager) => {
      const categories = manager.getRepository(Category);
      for (const [index, id] of ids.entries()) {
        await categories.update({ id }, { displayOrder: index });
      }
    });
  }
}
