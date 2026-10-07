import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MenuItem } from '../entities/menu-item.entity';
import { MenuItemImage } from '../entities/menu-item-image.entity';

@Injectable()
export class MenuItemImagesRepository {
  constructor(
    @InjectRepository(MenuItemImage)
    private readonly repo: Repository<MenuItemImage>,
  ) {}

  findByItems(menuItemIds: string[]): Promise<MenuItemImage[]> {
    if (menuItemIds.length === 0) return Promise.resolve([]);
    return this.repo.find({ where: { menuItemId: In(menuItemIds) }, order: { position: 'ASC', createdAt: 'ASC' } });
  }

  findOne(menuItemId: string, imageId: string): Promise<MenuItemImage | null> {
    return this.repo.findOne({ where: { id: imageId, menuItemId } });
  }

  /**
   * Appends an image after the existing ones and mirrors the first image into menu_items.imageUrl,
   * in one transaction, so the list and the primary never disagree.
   */
  append(menuItemId: string, url: string): Promise<MenuItemImage[]> {
    return this.repo.manager.transaction(async (manager) => {
      const images = manager.getRepository(MenuItemImage);
      const [{ next }] = (await manager.query(
        `SELECT COALESCE(MAX("position") + 1, 0)::int AS "next" FROM "menu_item_images" WHERE "menuItemId" = $1`,
        [menuItemId],
      )) as { next: number }[];
      await images.save(images.create({ menuItemId, url, position: next }));
      return this.syncPrimary(manager.getRepository(MenuItemImage), manager.getRepository(MenuItem), menuItemId);
    });
  }

  /** Removes one image, renumbers the rest from 0 and re-mirrors the primary (null when none are left). */
  remove(menuItemId: string, imageId: string): Promise<MenuItemImage[]> {
    return this.repo.manager.transaction(async (manager) => {
      const images = manager.getRepository(MenuItemImage);
      await images.delete({ id: imageId, menuItemId });
      const rest = await images.find({ where: { menuItemId }, order: { position: 'ASC', createdAt: 'ASC' } });
      for (const [index, image] of rest.entries()) {
        if (image.position !== index) await images.update({ id: image.id }, { position: index });
      }
      return this.syncPrimary(images, manager.getRepository(MenuItem), menuItemId);
    });
  }

  private async syncPrimary(images: Repository<MenuItemImage>, items: Repository<MenuItem>, menuItemId: string): Promise<MenuItemImage[]> {
    const ordered = await images.find({ where: { menuItemId }, order: { position: 'ASC', createdAt: 'ASC' } });
    await items.update({ id: menuItemId }, { imageUrl: (ordered[0]?.url ?? null) as unknown as string });
    return ordered;
  }
}
