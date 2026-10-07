import { MenuItemImagesRepository } from '../repositories/menu-item-images.repository';
import { MenuService } from './menu.service';
import { CategoriesRepository } from '../repositories/categories.repository';
import { MenuItemsRepository } from '../repositories/menu-items.repository';
import { RestaurantServiceClient } from '../common/restaurant-service.client';
import { BadRequestError, ForbiddenError, NotFoundError, S3StorageService, ConflictError } from '@food-delivery/shared';

describe('MenuService', () => {
  let images: { findByItems: jest.Mock; findOne: jest.Mock; append: jest.Mock; remove: jest.Mock };
  let service: MenuService;
  let categories: jest.Mocked<CategoriesRepository>;
  let menuItems: jest.Mocked<MenuItemsRepository>;
  let restaurantClient: jest.Mocked<RestaurantServiceClient>;
  let storage: jest.Mocked<S3StorageService>;
  let cache: { getOrSet: jest.Mock; del: jest.Mock };

  const item = {
    id: 'item-1',
    restaurantId: 'r1',
    categoryId: undefined,
    name: 'Burger',
    description: undefined,
    price: '9.99',
    imageUrl: undefined,
    available: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    categories = {
      findById: jest.fn(),
      findByRestaurant: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      reorder: jest.fn(),
    } as unknown as jest.Mocked<CategoriesRepository>;

    menuItems = {
      findById: jest.fn(),
      findByRestaurant: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      archive: jest.fn(),
      countLiveInCategory: jest.fn(),
      detachArchivedFromCategory: jest.fn(),
    } as unknown as jest.Mocked<MenuItemsRepository>;

    restaurantClient = {
      assertOwnership: jest.fn(),
    } as unknown as jest.Mocked<RestaurantServiceClient>;

    storage = {
      generateUploadUrl: jest.fn(),
      verifyUploadedObject: jest.fn(),
      getPublicUrl: jest.fn(),
    } as unknown as jest.Mocked<S3StorageService>;
    cache = { getOrSet: jest.fn((_key, callback) => callback()), del: jest.fn() };

    images = {
      findByItems: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      append: jest.fn(),
      remove: jest.fn(),
    };
    service = new MenuService(categories, menuItems, restaurantClient, cache as any, storage, images as unknown as MenuItemImagesRepository);
  });

  describe('createItem', () => {
    it('does not persist caller-supplied image URLs outside the confirmation flow', async () => {
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      menuItems.create.mockResolvedValue(item);
      const input = {
        restaurantId: 'r1',
        name: 'Burger',
        price: 9.99,
        imageUrl: 'https://untrusted.example/image.png',
      } as Parameters<MenuService['createItem']>[1];

      await service.createItem('owner-1', input);

      expect(menuItems.create).toHaveBeenCalledWith(
        expect.not.objectContaining({ imageUrl: 'https://untrusted.example/image.png' }),
      );
    });

    it('rejects when caller does not own the restaurant', async () => {
      restaurantClient.assertOwnership.mockRejectedValue(
        new ForbiddenError('You do not own this restaurant'),
      );

      await expect(
        service.createItem('not-owner', {
          restaurantId: 'r1',
          name: 'Burger',
          price: 9.99,
        }),
      ).rejects.toThrow(ForbiddenError);
    });

    it('rejects when categoryId belongs to a different restaurant', async () => {
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      categories.findById.mockResolvedValue({
        id: 'cat-1',
        restaurantId: 'other-restaurant',
        name: 'Mains',
        displayOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await expect(
        service.createItem('owner-1', {
          restaurantId: 'r1',
          categoryId: 'cat-1',
          name: 'Burger',
          price: 9.99,
        }),
      ).rejects.toThrow(BadRequestError);
    });

    it('creates the item when ownership and category are valid', async () => {
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      menuItems.create.mockResolvedValue(item);

      const result = await service.createItem('owner-1', {
        restaurantId: 'r1',
        name: 'Burger',
        price: 9.99,
      });

      expect(result.name).toBe('Burger');
      expect(menuItems.create).toHaveBeenCalledWith(
        expect.objectContaining({ restaurantId: 'r1', name: 'Burger', price: 9.99 }),
      );
    });
  });

  describe('getItem', () => {
    it('throws NotFoundError when missing', async () => {
      menuItems.findById.mockResolvedValue(null);
      await expect(service.getItem('missing')).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateAvailability', () => {
    it('checks ownership via the item restaurantId before updating', async () => {
      menuItems.findById.mockResolvedValue(item);
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      menuItems.update.mockResolvedValue({ ...item, available: false });

      const result = await service.updateAvailability('item-1', 'owner-1', { available: false });

      expect(restaurantClient.assertOwnership).toHaveBeenCalledWith('r1', 'owner-1');
      expect(result.available).toBe(false);
    });

    it('rejects a foreign owner before changing availability', async () => {
      menuItems.findById.mockResolvedValue(item);
      restaurantClient.assertOwnership.mockRejectedValue(
        new ForbiddenError('You do not own this restaurant'),
      );

      await expect(
        service.updateAvailability('item-1', 'owner-2', { available: false }),
      ).rejects.toThrow(ForbiddenError);
      expect(menuItems.update).not.toHaveBeenCalled();
    });
  });

  describe('archiveItem (#148: DELETE archives)', () => {
    const now = new Date('2026-10-07T12:00:00Z');

    it('archives only after ownership passes, never hard-deletes', async () => {
      menuItems.findById.mockResolvedValue(item);
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      menuItems.archive.mockResolvedValue({ ...item, archivedAt: now, available: false } as any);

      const result = await service.archiveItem('item-1', 'owner-1', now);

      expect(restaurantClient.assertOwnership).toHaveBeenCalledWith(item.restaurantId, 'owner-1');
      expect(menuItems.archive).toHaveBeenCalledWith('item-1', now);
      expect(menuItems.delete).not.toHaveBeenCalled();
      expect(result).toMatchObject({ archivedAt: now, available: false });
      expect(cache.del).toHaveBeenCalledWith(`menu:${item.restaurantId}`);
    });

    it('is a no-op for an item that is already archived', async () => {
      menuItems.findById.mockResolvedValue({ ...item, archivedAt: now } as any);
      restaurantClient.assertOwnership.mockResolvedValue(undefined);

      await service.archiveItem('item-1', 'owner-1');

      expect(menuItems.archive).not.toHaveBeenCalled();
    });

    it("stops another owner (403 from the ownership check)", async () => {
      menuItems.findById.mockResolvedValue(item);
      restaurantClient.assertOwnership.mockRejectedValue(new ForbiddenError('not yours'));

      await expect(service.archiveItem('item-1', 'other-owner')).rejects.toThrow(ForbiddenError);
      expect(menuItems.archive).not.toHaveBeenCalled();
    });

    it('refuses to edit or toggle an archived item', async () => {
      menuItems.findById.mockResolvedValue({ ...item, archivedAt: now } as any);
      restaurantClient.assertOwnership.mockResolvedValue(undefined);

      await expect(service.updateItem('item-1', 'owner-1', { name: 'New' })).rejects.toThrow(ConflictError);
      await expect(service.updateAvailability('item-1', 'owner-1', { available: true })).rejects.toThrow(ConflictError);
      expect(menuItems.update).not.toHaveBeenCalled();
    });
  });

  describe('updateItem category check (#148)', () => {
    it("rejects moving an item into another restaurant's category", async () => {
      menuItems.findById.mockResolvedValue(item);
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      categories.findById.mockResolvedValue({ id: 'cat-x', restaurantId: 'someone-else' } as any);

      await expect(service.updateItem('item-1', 'owner-1', { categoryId: 'cat-x' })).rejects.toThrow(BadRequestError);
      expect(menuItems.update).not.toHaveBeenCalled();
    });
  });

  describe('categories (#148)', () => {
    const category = { id: 'cat-1', restaurantId: item.restaurantId, name: 'Burgers', displayOrder: 0 };

    it('renames a category after ownership passes', async () => {
      categories.findById.mockResolvedValue(category as any);
      categories.update.mockResolvedValue({ ...category, name: 'Mains' } as any);

      await expect(service.updateCategory('cat-1', 'owner-1', { name: 'Mains' })).resolves.toMatchObject({ name: 'Mains' });
      expect(restaurantClient.assertOwnership).toHaveBeenCalledWith(item.restaurantId, 'owner-1');
      expect(categories.update).toHaveBeenCalledWith('cat-1', { name: 'Mains' });
    });

    it('404s for an unknown category', async () => {
      categories.findById.mockResolvedValue(null);
      await expect(service.updateCategory('nope', 'owner-1', { name: 'X' })).rejects.toThrow(NotFoundError);
    });

    it('deletes an empty category, detaching archived items', async () => {
      categories.findById.mockResolvedValue(category as any);
      menuItems.countLiveInCategory.mockResolvedValue(0);

      await service.deleteCategory('cat-1', 'owner-1');

      expect(menuItems.detachArchivedFromCategory).toHaveBeenCalledWith('cat-1');
      expect(categories.delete).toHaveBeenCalledWith('cat-1');
    });

    it('409s while the category still has items on the menu', async () => {
      categories.findById.mockResolvedValue(category as any);
      menuItems.countLiveInCategory.mockResolvedValue(2);

      await expect(service.deleteCategory('cat-1', 'owner-1')).rejects.toThrow('Move or archive the 2 items in this category first.');
      expect(categories.delete).not.toHaveBeenCalled();
    });

    it('reorders when the list names every category exactly once', async () => {
      categories.findByRestaurant.mockResolvedValue([category, { ...category, id: 'cat-2' }] as any);

      await service.reorderCategories(item.restaurantId, 'owner-1', { categoryIds: ['cat-2', 'cat-1'] });

      expect(categories.reorder).toHaveBeenCalledWith(['cat-2', 'cat-1']);
    });

    it('rejects a partial or foreign order', async () => {
      categories.findByRestaurant.mockResolvedValue([category, { ...category, id: 'cat-2' }] as any);

      await expect(service.reorderCategories(item.restaurantId, 'owner-1', { categoryIds: ['cat-1'] })).rejects.toThrow(BadRequestError);
      await expect(service.reorderCategories(item.restaurantId, 'owner-1', { categoryIds: ['cat-1', 'cat-9'] })).rejects.toThrow(
        BadRequestError,
      );
      expect(categories.reorder).not.toHaveBeenCalled();
    });
  });

  describe('getMenu', () => {
    it('returns categories and items together', async () => {
      categories.findByRestaurant.mockResolvedValue([]);
      menuItems.findByRestaurant.mockResolvedValue([item]);

      const result = await service.getMenu('r1');
      expect(result.restaurantId).toBe('r1');
      expect(result.items).toHaveLength(1);
    });
  });

  describe('menu item image uploads', () => {
    it('rejects a mismatched object key before persisting an image URL', async () => {
      menuItems.findById.mockResolvedValue(item);
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      storage.verifyUploadedObject.mockRejectedValue(new BadRequestError('Object key prefix mismatch'));

      await expect(
        service.confirmItemImageUpload(
          'item-1',
          'owner-1',
          'restaurants/other/menu-items/item-1/01234567-89ab-cdef-0123-456789abcdef.png',
        ),
      ).rejects.toThrow(BadRequestError);

      expect(storage.verifyUploadedObject).toHaveBeenCalledWith(
        'restaurants/other/menu-items/item-1/01234567-89ab-cdef-0123-456789abcdef.png',
        'restaurants/r1/menu-items/item-1/',
        10 * 1024 * 1024,
      );
      expect(menuItems.update).not.toHaveBeenCalled();
    });

    it('checks restaurant ownership before issuing an item image upload URL', async () => {
      menuItems.findById.mockResolvedValue(item);
      restaurantClient.assertOwnership.mockRejectedValue(new ForbiddenError('Not the restaurant owner'));

      await expect(service.createItemImageUploadUrl('item-1', 'owner-1', 'image/png')).rejects.toThrow(
        ForbiddenError,
      );

      expect(storage.generateUploadUrl).not.toHaveBeenCalled();
    });
  });

  describe('item images (#149)', () => {
    const stored = [{ id: 'img-1', menuItemId: 'item-1', url: 'https://cdn/a.png', position: 0, createdAt: new Date() }];

    it('appends a verified upload and returns the item with its ordered images', async () => {
      menuItems.findById.mockResolvedValue(item);
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      storage.verifyUploadedObject.mockResolvedValue({ publicUrl: 'https://cdn/a.png', contentType: 'image/png', contentLength: 10 });
      images.append.mockResolvedValue(stored);

      const result = await service.confirmItemImageUpload('item-1', 'owner-1', 'restaurants/r/menu-items/item-1/a.png');

      expect(images.append).toHaveBeenCalledWith('item-1', 'https://cdn/a.png');
      expect(result.images).toEqual([{ id: 'img-1', url: 'https://cdn/a.png', position: 0 }]);
    });

    it('caps an item at 10 images before issuing an upload URL', async () => {
      menuItems.findById.mockResolvedValue(item);
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      images.findByItems.mockResolvedValue(Array.from({ length: 10 }, (_, n) => ({ ...stored[0], id: `img-${n}` })));

      await expect(service.createItemImageUploadUrl('item-1', 'owner-1', 'image/png')).rejects.toThrow(ConflictError);
      expect(storage.generateUploadUrl).not.toHaveBeenCalled();
    });

    it('removes an image after ownership passes', async () => {
      menuItems.findById.mockResolvedValue(item);
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      images.findOne.mockResolvedValue(stored[0]);
      images.remove.mockResolvedValue([]);

      const result = await service.removeItemImage('item-1', 'img-1', 'owner-1');

      expect(images.remove).toHaveBeenCalledWith('item-1', 'img-1');
      expect(result.images).toEqual([]);
    });

    it('404s for an image of another item and stops other owners and archived items', async () => {
      menuItems.findById.mockResolvedValue(item);
      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      images.findOne.mockResolvedValue(null);
      await expect(service.removeItemImage('item-1', 'img-x', 'owner-1')).rejects.toThrow(NotFoundError);

      restaurantClient.assertOwnership.mockRejectedValue(new ForbiddenError('not yours'));
      await expect(service.removeItemImage('item-1', 'img-1', 'other')).rejects.toThrow(ForbiddenError);

      restaurantClient.assertOwnership.mockResolvedValue(undefined);
      menuItems.findById.mockResolvedValue({ ...item, archivedAt: new Date() } as any);
      await expect(service.removeItemImage('item-1', 'img-1', 'owner-1')).rejects.toThrow(ConflictError);
      expect(images.remove).not.toHaveBeenCalled();
    });

    it('attaches each item its ordered images on the menu', async () => {
      categories.findByRestaurant.mockResolvedValue([]);
      menuItems.findByRestaurant.mockResolvedValue([item, { ...item, id: 'item-2' }] as any);
      images.findByItems.mockResolvedValue(stored);

      const menu = await service.getMenu(item.restaurantId);

      expect(images.findByItems).toHaveBeenCalledWith(['item-1', 'item-2']);
      expect(menu.items.map((i) => [i.id, i.images.length])).toEqual([
        ['item-1', 1],
        ['item-2', 0],
      ]);
    });
  });
});
