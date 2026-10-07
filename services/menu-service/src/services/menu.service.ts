import { Injectable } from '@nestjs/common';
import { BadRequestError, ConflictError, NotFoundError, CacheService, S3StorageService } from '@food-delivery/shared';
import { ReorderCategoriesDto, UpdateCategoryDto } from '../dto/manage-categories.dto';
import { CategoriesRepository } from '../repositories/categories.repository';
import { MenuItemsRepository } from '../repositories/menu-items.repository';
import { RestaurantServiceClient } from '../common/restaurant-service.client';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { CreateMenuItemDto } from '../dto/create-menu-item.dto';
import { UpdateMenuItemDto } from '../dto/update-menu-item.dto';
import { UpdateAvailabilityDto } from '../dto/update-availability.dto';
import { Category } from '../entities/category.entity';
import { MenuItem } from '../entities/menu-item.entity';
import { MenuItemImage } from '../entities/menu-item-image.entity';
import { MenuItemImagesRepository } from '../repositories/menu-item-images.repository';

/** An item as menus return it (#149): its ordered images, the first mirrored into imageUrl. */
export type MenuItemWithImages = MenuItem & { images: Pick<MenuItemImage, 'id' | 'url' | 'position'>[] };

export const MAX_ITEM_IMAGES = 10;

export interface MenuResponse {
  restaurantId: string;
  categories: Category[];
  items: MenuItemWithImages[];
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
    private readonly images: MenuItemImagesRepository,
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

  async updateCategory(id: string, requesterId: string, dto: UpdateCategoryDto): Promise<Category> {
    const category = await this.findCategoryOrThrow(id);
    await this.restaurantClient.assertOwnership(category.restaurantId, requesterId);
    const updated = await this.categories.update(id, { ...(dto.name !== undefined ? { name: dto.name } : {}), ...(dto.displayOrder !== undefined ? { displayOrder: dto.displayOrder } : {}) });
    await this.cache.del(`menu:${category.restaurantId}`);
    return updated as Category;
  }

  /** Only an empty category can go (#148); archived items in it just lose the category. */
  async deleteCategory(id: string, requesterId: string): Promise<void> {
    const category = await this.findCategoryOrThrow(id);
    await this.restaurantClient.assertOwnership(category.restaurantId, requesterId);
    const live = await this.menuItems.countLiveInCategory(id);
    if (live > 0) {
      throw new ConflictError(`Move or archive the ${live} item${live === 1 ? '' : 's'} in this category first.`);
    }
    await this.menuItems.detachArchivedFromCategory(id);
    await this.categories.delete(id);
    await this.cache.del(`menu:${category.restaurantId}`);
  }

  /** The new order must list every category of the restaurant exactly once. */
  async reorderCategories(restaurantId: string, requesterId: string, dto: ReorderCategoriesDto): Promise<Category[]> {
    await this.restaurantClient.assertOwnership(restaurantId, requesterId);
    const existing = await this.categories.findByRestaurant(restaurantId);
    const known = new Set(existing.map((category) => category.id));
    if (dto.categoryIds.length !== known.size || dto.categoryIds.some((id) => !known.has(id))) {
      throw new BadRequestError('categoryIds must list every category of this restaurant exactly once');
    }
    await this.categories.reorder(dto.categoryIds);
    await this.cache.del(`menu:${restaurantId}`);
    return this.categories.findByRestaurant(restaurantId);
  }

  async getMenu(restaurantId: string): Promise<MenuResponse> {
    return this.cache.getOrSet(`menu:${restaurantId}`, async () => {
      const [categories, items] = await Promise.all([
        this.categories.findByRestaurant(restaurantId),
        this.menuItems.findByRestaurant(restaurantId),
      ]);
      return { restaurantId, categories, items: await this.withImages(items) };
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

    if (dto.categoryId) await this.assertCategoryOf(dto.categoryId, dto.restaurantId);

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
    this.assertNotArchived(item);
    if (dto.categoryId) await this.assertCategoryOf(dto.categoryId, item.restaurantId);
    const updated = await this.menuItems.update(id, dto);
    await this.cache.del(`menu:${item.restaurantId}`);
    await this.cache.del(`menuitem:${id}`);
    return updated as MenuItem;
  }

  /**
   * DELETE /menu-items/:id archives (#148): the item leaves the menu and can't be added to carts
   * (available false), but past orders and existing references stay valid. Repeating it is a no-op.
   */
  async archiveItem(id: string, requesterId: string, now = new Date()): Promise<MenuItem> {
    const item = await this.getItem(id);
    await this.restaurantClient.assertOwnership(item.restaurantId, requesterId);
    const archived = item.archivedAt ? item : await this.menuItems.archive(id, now);
    await this.cache.del(`menu:${item.restaurantId}`);
    await this.cache.del(`menuitem:${id}`);
    return archived as MenuItem;
  }

  async updateAvailability(
    id: string,
    requesterId: string,
    dto: UpdateAvailabilityDto,
  ): Promise<MenuItem> {
    const item = await this.getItem(id);
    await this.restaurantClient.assertOwnership(item.restaurantId, requesterId);
    this.assertNotArchived(item);
    const updated = await this.menuItems.update(id, { available: dto.available });
    await this.cache.del(`menu:${item.restaurantId}`);
    await this.cache.del(`menuitem:${id}`);
    return updated as MenuItem;
  }

  async createItemImageUploadUrl(id: string, requesterId: string, contentType: string) {
    const item = await this.getItem(id);
    await this.restaurantClient.assertOwnership(item.restaurantId, requesterId);
    this.assertNotArchived(item);
    const existing = await this.images.findByItems([id]);
    if (existing.length >= MAX_ITEM_IMAGES) {
      throw new ConflictError(`An item can have at most ${MAX_ITEM_IMAGES} images. Remove one first.`);
    }
    return this.storage.generateUploadUrl(
      `restaurants/${item.restaurantId}/menu-items/${item.id}/`,
      contentType,
      this.imageMaxSizeBytes,
    );
  }

  async confirmItemImageUpload(id: string, requesterId: string, objectKey: string): Promise<MenuItemWithImages> {
    const item = await this.getItem(id);
    await this.restaurantClient.assertOwnership(item.restaurantId, requesterId);
    const verifiedUpload = await this.storage.verifyUploadedObject(
      objectKey,
      `restaurants/${item.restaurantId}/menu-items/${item.id}/`,
      this.imageMaxSizeBytes,
    );
    // Appended after the existing images; the first stays the primary mirrored into imageUrl (#149).
    const images = await this.images.append(id, verifiedUpload.publicUrl);
    await this.cache.del(`menu:${item.restaurantId}`);
    await this.cache.del(`menuitem:${id}`);
    return this.itemWithImages(id, images);
  }

  /** Removes one image (#149); the next one becomes the primary, or the item has none. */
  async removeItemImage(id: string, imageId: string, requesterId: string): Promise<MenuItemWithImages> {
    const item = await this.getItem(id);
    await this.restaurantClient.assertOwnership(item.restaurantId, requesterId);
    this.assertNotArchived(item);
    const image = await this.images.findOne(id, imageId);
    if (!image) throw new NotFoundError(`Image ${imageId} not found on this item`);
    const images = await this.images.remove(id, imageId);
    await this.cache.del(`menu:${item.restaurantId}`);
    await this.cache.del(`menuitem:${id}`);
    return this.itemWithImages(id, images);
  }

  private async withImages(items: MenuItem[]): Promise<MenuItemWithImages[]> {
    const images = await this.images.findByItems(items.map((item) => item.id));
    const byItem = new Map<string, Pick<MenuItemImage, 'id' | 'url' | 'position'>[]>();
    for (const image of images) {
      const list = byItem.get(image.menuItemId) ?? [];
      list.push({ id: image.id, url: image.url, position: image.position });
      byItem.set(image.menuItemId, list);
    }
    return items.map((item) => ({ ...item, images: byItem.get(item.id) ?? [] }));
  }

  private async itemWithImages(id: string, images: MenuItemImage[]): Promise<MenuItemWithImages> {
    const item = await this.menuItems.findById(id);
    if (!item) throw new NotFoundError(`Menu item ${id} not found`);
    return { ...item, images: images.map(({ id: imageId, url, position }) => ({ id: imageId, url, position })) };
  }

  private async findCategoryOrThrow(id: string): Promise<Category> {
    const category = await this.categories.findById(id);
    if (!category) throw new NotFoundError(`Category ${id} not found`);
    return category;
  }

  private async assertCategoryOf(categoryId: string, restaurantId: string): Promise<void> {
    const category = await this.categories.findById(categoryId);
    if (!category || category.restaurantId !== restaurantId) {
      throw new BadRequestError('categoryId does not belong to this restaurant');
    }
  }

  /** Archived items are kept for history only; un-archiving is not offered yet. */
  private assertNotArchived(item: MenuItem): void {
    if (item.archivedAt) throw new ConflictError('This item is archived and can no longer be changed.');
  }
}
