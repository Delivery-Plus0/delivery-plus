import { Injectable } from '@nestjs/common';
import { BadRequestError, NotFoundError, CacheService, S3StorageService } from '@food-delivery/shared';
import { CategoriesRepository } from '../repositories/categories.repository';
import { MenuItemsRepository } from '../repositories/menu-items.repository';
import { RestaurantServiceClient } from '../common/restaurant-service.client';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { CreateMenuItemDto } from '../dto/create-menu-item.dto';
import { UpdateMenuItemDto } from '../dto/update-menu-item.dto';
import { UpdateAvailabilityDto } from '../dto/update-availability.dto';
import { Category } from '../entities/category.entity';
import { MenuItem } from '../entities/menu-item.entity';

export interface MenuResponse {
  restaurantId: string;
  categories: Category[];
  items: MenuItem[];
}

@Injectable()
export class MenuService {
  private readonly imageMaxSizeBytes = 10 * 1024 * 1024;
  constructor(
    private readonly categories: CategoriesRepository,
    private readonly menuItems: MenuItemsRepository,
    private readonly restaurantClient: RestaurantServiceClient,
    private readonly cache: CacheService,
    private readonly storage: S3StorageService,
  ) {}

  async createCategory(requesterId: string, dto: CreateCategoryDto): Promise<Category> {
    await this.restaurantClient.assertOwnership(dto.restaurantId, requesterId);
    const category = await this.categories.create({
      restaurantId: dto.restaurantId,
      name: dto.name,
      displayOrder: dto.displayOrder ?? 0,
    });
    await this.cache.del(`menu:${dto.restaurantId}`);
    return category;
  }

  async getMenu(restaurantId: string): Promise<MenuResponse> {
    return this.cache.getOrSet(`menu:${restaurantId}`, async () => {
      const [categories, items] = await Promise.all([
        this.categories.findByRestaurant(restaurantId),
        this.menuItems.findByRestaurant(restaurantId),
      ]);
      return { restaurantId, categories, items };
    }, 60);
  }

  async getItem(id: string): Promise<MenuItem> {
    return this.cache.getOrSet(`menuitem:${id}`, async () => {
      const item = await this.menuItems.findById(id);
      if (!item) {
        throw new NotFoundError(`Menu item ${id} not found`);
      }
      return item;
    }, 60);
  }

  async createItem(requesterId: string, dto: CreateMenuItemDto): Promise<MenuItem> {
    await this.restaurantClient.assertOwnership(dto.restaurantId, requesterId);

    if (dto.categoryId) {
      const category = await this.categories.findById(dto.categoryId);
      if (!category || category.restaurantId !== dto.restaurantId) {
        throw new BadRequestError('categoryId does not belong to this restaurant');
      }
    }

    const item = await this.menuItems.create({
      restaurantId: dto.restaurantId,
      categoryId: dto.categoryId,
      name: dto.name,
      description: dto.description,
      price: dto.price,
    });
    await this.cache.del(`menu:${dto.restaurantId}`);
    return item;
  }

  async updateItem(id: string, requesterId: string, dto: UpdateMenuItemDto): Promise<MenuItem> {
    const item = await this.getItem(id);
    await this.restaurantClient.assertOwnership(item.restaurantId, requesterId);
    const updated = await this.menuItems.update(id, dto);
    await this.cache.del(`menu:${item.restaurantId}`);
    await this.cache.del(`menuitem:${id}`);
    return updated as MenuItem;
  }

  async deleteItem(id: string, requesterId: string): Promise<void> {
    const item = await this.getItem(id);
    await this.restaurantClient.assertOwnership(item.restaurantId, requesterId);
    await this.menuItems.delete(id);
    await this.cache.del(`menu:${item.restaurantId}`);
    await this.cache.del(`menuitem:${id}`);
  }

  async updateAvailability(
    id: string,
    requesterId: string,
    dto: UpdateAvailabilityDto,
  ): Promise<MenuItem> {
    const item = await this.getItem(id);
    await this.restaurantClient.assertOwnership(item.restaurantId, requesterId);
    const updated = await this.menuItems.update(id, { available: dto.available });
    await this.cache.del(`menu:${item.restaurantId}`);
    await this.cache.del(`menuitem:${id}`);
    return updated as MenuItem;
  }

  async createItemImageUploadUrl(id: string, requesterId: string, contentType: string) {
    const item = await this.getItem(id);
    await this.restaurantClient.assertOwnership(item.restaurantId, requesterId);
    return this.storage.generateUploadUrl(
      `restaurants/${item.restaurantId}/menu-items/${item.id}/`,
      contentType,
      this.imageMaxSizeBytes,
    );
  }

  async confirmItemImageUpload(id: string, requesterId: string, objectKey: string): Promise<MenuItem> {
    const item = await this.getItem(id);
    await this.restaurantClient.assertOwnership(item.restaurantId, requesterId);
    const verifiedUpload = await this.storage.verifyUploadedObject(
      objectKey,
      `restaurants/${item.restaurantId}/menu-items/${item.id}/`,
      this.imageMaxSizeBytes,
    );
    const updated = await this.menuItems.update(id, { imageUrl: verifiedUpload.publicUrl });
    await this.cache.del(`menu:${item.restaurantId}`);
    await this.cache.del(`menuitem:${id}`);
    return updated as MenuItem;
  }
}
