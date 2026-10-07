import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
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

  /** The live menu: archived items are never listed (#148). */
  findByRestaurant(restaurantId: string): Promise<MenuItem[]> {
    return this.repo.find({ where: { restaurantId, archivedAt: IsNull() }, order: { name: 'ASC' } });
  }

  /** Items in a category that are still on the menu. */
  countLiveInCategory(categoryId: string): Promise<number> {
    return this.repo.count({ where: { categoryId, archivedAt: IsNull() } });
  }

  /** Archived items keep their history but not a category that is being deleted. */
  async detachArchivedFromCategory(categoryId: string): Promise<void> {
    await this.repo.update({ categoryId, archivedAt: Not(IsNull()) }, { categoryId: null as unknown as string });
  }

  /** Archive instead of delete; only the first archive sets the time. */
  async archive(id: string, at: Date): Promise<MenuItem | null> {
    await this.repo.update({ id, archivedAt: IsNull() }, { archivedAt: at, available: false });
    return this.findById(id);
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
