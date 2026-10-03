import { MenuService } from './menu.service';
import { CategoriesRepository } from '../repositories/categories.repository';
import { MenuItemsRepository } from '../repositories/menu-items.repository';
import { RestaurantServiceClient } from '../common/restaurant-service.client';
import { BadRequestError, ForbiddenError, NotFoundError, S3StorageService } from '@food-delivery/shared';

describe('MenuService', () => {
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
    } as unknown as jest.Mocked<CategoriesRepository>;

    menuItems = {
      findById: jest.fn(),
      findByRestaurant: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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

    service = new MenuService(categories, menuItems, restaurantClient, cache as any, storage);
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

  describe('deleteItem', () => {
    it('deletes only after ownership passes', async () => {
      menuItems.findById.mockResolvedValue(item);
      restaurantClient.assertOwnership.mockResolvedValue(undefined);

      await service.deleteItem('item-1', 'owner-1');

      expect(menuItems.delete).toHaveBeenCalledWith('item-1');
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
});
