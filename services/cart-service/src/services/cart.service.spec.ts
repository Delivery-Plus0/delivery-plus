import { CartService } from './cart.service';
import { CartRepository } from '../repositories/cart.repository';
import { MenuServiceClient } from '../common/menu-service.client';
import { BadRequestError, CartChangedError, ConflictError, MAX_CART_ITEM_QUANTITY, NotFoundError } from '@food-delivery/shared';
import { emptyCart } from '../entities/cart.model';

describe('CartService', () => {
  let service: CartService;
  let cartRepository: jest.Mocked<CartRepository>;
  let menuServiceClient: jest.Mocked<MenuServiceClient>;

  beforeEach(() => {
    cartRepository = {
      find: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
      ping: jest.fn(),
    } as unknown as jest.Mocked<CartRepository>;

    menuServiceClient = {
      getItem: jest.fn(),
    } as unknown as jest.Mocked<MenuServiceClient>;

    service = new CartService(cartRepository, menuServiceClient);
  });

  describe('getCart', () => {
    it('returns an empty cart with total 0 when none exists', async () => {
      cartRepository.find.mockResolvedValue(null);
      const result = await service.getCart('user-1');
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('addItem', () => {
    it('rejects unavailable items', async () => {
      menuServiceClient.getItem.mockResolvedValue({
        id: 'item-1',
        restaurantId: 'rest-1',
        name: 'Burger',
        price: 9.99,
        available: false,
      });
      cartRepository.find.mockResolvedValue(null);

      await expect(
        service.addItem('user-1', { menuItemId: 'item-1', quantity: 1 }),
      ).rejects.toThrow(BadRequestError);
    });

    it('adds a new item and computes the total', async () => {
      menuServiceClient.getItem.mockResolvedValue({
        id: 'item-1',
        restaurantId: 'rest-1',
        name: 'Burger',
        price: 9.99,
        available: true,
      });
      cartRepository.find.mockResolvedValue(null);
      cartRepository.save.mockResolvedValue(undefined);

      const result = await service.addItem('user-1', { menuItemId: 'item-1', quantity: 2 });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(19.98);
      expect(result.restaurantId).toBe('rest-1');
    });

    it('increments quantity when the item already exists in the cart', async () => {
      menuServiceClient.getItem.mockResolvedValue({
        id: 'item-1',
        restaurantId: 'rest-1',
        name: 'Burger',
        price: 10,
        available: true,
      });
      cartRepository.find.mockResolvedValue({
        userId: 'user-1',
        restaurantId: 'rest-1',
        items: [{ menuItemId: 'item-1', name: 'Burger', price: 10, quantity: 1 }],
        updatedAt: new Date().toISOString(),
      });

      const result = await service.addItem('user-1', { menuItemId: 'item-1', quantity: 1 });
      expect(result.items[0].quantity).toBe(2);
      expect(result.total).toBe(20);
    });

    it('rejects adding an item from a different restaurant than the existing cart', async () => {
      menuServiceClient.getItem.mockResolvedValue({
        id: 'item-2',
        restaurantId: 'rest-2',
        name: 'Pizza',
        price: 12,
        available: true,
      });
      cartRepository.find.mockResolvedValue({
        userId: 'user-1',
        restaurantId: 'rest-1',
        items: [{ menuItemId: 'item-1', name: 'Burger', price: 10, quantity: 1 }],
        updatedAt: new Date().toISOString(),
      });

      await expect(
        service.addItem('user-1', { menuItemId: 'item-2', quantity: 1 }),
      ).rejects.toThrow(ConflictError);
    });
  });

  describe('updateItemQuantity', () => {
    it('throws when the cart is empty', async () => {
      cartRepository.find.mockResolvedValue(null);
      await expect(
        service.updateItemQuantity('user-1', 'item-1', { quantity: 2 }),
      ).rejects.toThrow(BadRequestError);
    });

    it('removes the item and clears the cart key when quantity is set to 0 and cart becomes empty', async () => {
      cartRepository.find.mockResolvedValue({
        userId: 'user-1',
        restaurantId: 'rest-1',
        items: [{ menuItemId: 'item-1', name: 'Burger', price: 10, quantity: 1 }],
        updatedAt: new Date().toISOString(),
      });

      const result = await service.updateItemQuantity('user-1', 'item-1', { quantity: 0 });

      expect(cartRepository.delete).toHaveBeenCalledWith('user-1');
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('updates quantity in place', async () => {
      cartRepository.find.mockResolvedValue({
        userId: 'user-1',
        restaurantId: 'rest-1',
        items: [{ menuItemId: 'item-1', name: 'Burger', price: 10, quantity: 1 }],
        updatedAt: new Date().toISOString(),
      });

      const result = await service.updateItemQuantity('user-1', 'item-1', { quantity: 5 });
      expect(result.items[0].quantity).toBe(5);
      expect(result.total).toBe(50);
    });
  });

  describe('clearCart', () => {
    it('deletes the cart key', async () => {
      await service.clearCart('user-1');
      expect(cartRepository.delete).toHaveBeenCalledWith('user-1');
    });
  });

  it('emptyCart helper returns a cart with null restaurantId and no items', () => {
    const cart = emptyCart('user-x');
    expect(cart.restaurantId).toBeNull();
    expect(cart.items).toHaveLength(0);
  });

  describe('quantity limit (#42)', () => {
    it('refuses adding past the maximum of one item', async () => {
      menuServiceClient.getItem.mockResolvedValue({ id: 'item-1', restaurantId: 'rest-1', name: 'Burger', price: 10, available: true });
      cartRepository.find.mockResolvedValue({
        userId: 'user-1',
        restaurantId: 'rest-1',
        items: [{ menuItemId: 'item-1', name: 'Burger', price: 10, quantity: MAX_CART_ITEM_QUANTITY - 1 }],
        updatedAt: new Date().toISOString(),
      });

      await expect(service.addItem('user-1', { menuItemId: 'item-1', quantity: 2 })).rejects.toThrow(`at most ${MAX_CART_ITEM_QUANTITY}`);
      expect(cartRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('validateForCheckout (#42)', () => {
    const line = (menuItemId: string, price: number, quantity = 1) => ({ menuItemId, name: `Old ${menuItemId}`, price, quantity });
    const cartOf = (...items: ReturnType<typeof line>[]) => ({ userId: 'user-1', restaurantId: 'rest-1', items, updatedAt: '2026-10-01T00:00:00.000Z' });
    const menu = (id: string, price: number, extra: Record<string, unknown> = {}) => ({ id, restaurantId: 'rest-1', name: `Menu ${id}`, price, available: true, archived: false, ...extra });

    it('returns an unchanged cart without writing anything', async () => {
      cartRepository.find.mockResolvedValue({ ...cartOf(line('a', 10, 2)), items: [{ menuItemId: 'a', name: 'Menu a', price: 10, quantity: 2 }] });
      menuServiceClient.getItem.mockResolvedValue(menu('a', 10.0));

      await expect(service.validateForCheckout('user-1')).resolves.toMatchObject({ total: 20 });
      expect(cartRepository.save).not.toHaveBeenCalled();
    });

    it('reports every change, updates the cart, and never lets the old price through', async () => {
      cartRepository.find.mockResolvedValue(cartOf(line('cheaper', 40, 1), line('gone', 5), line('soldout', 7), line('archived', 9), line('many', 3, 50)));
      menuServiceClient.getItem.mockImplementation(async (id: string) => {
        if (id === 'gone') throw new NotFoundError('gone');
        if (id === 'soldout') return menu(id, 7, { available: false });
        if (id === 'archived') return menu(id, 9, { available: false, archived: true });
        if (id === 'cheaper') return menu(id, 45);
        return menu(id, 3);
      });

      const error = await service.validateForCheckout('user-1').catch((e) => e);

      expect(error).toBeInstanceOf(CartChangedError);
      expect((error as CartChangedError).changes).toEqual([
        { menuItemId: 'cheaper', name: 'Menu cheaper', change: 'PRICE_CHANGED', previousPrice: 40, currentPrice: 45 },
        { menuItemId: 'gone', name: 'Old gone', change: 'REMOVED' },
        { menuItemId: 'soldout', name: 'Menu soldout', change: 'UNAVAILABLE' },
        { menuItemId: 'archived', name: 'Old archived', change: 'REMOVED' },
        { menuItemId: 'many', name: 'Menu many', change: 'QUANTITY_LIMITED', previousQuantity: 50, currentQuantity: MAX_CART_ITEM_QUANTITY },
      ]);
      expect(cartRepository.save.mock.calls[0][0].items).toEqual([
        { menuItemId: 'cheaper', name: 'Menu cheaper', price: 45, quantity: 1 },
        { menuItemId: 'many', name: 'Menu many', price: 3, quantity: MAX_CART_ITEM_QUANTITY },
      ]);
    });

    it('takes out an item that now belongs to another restaurant', async () => {
      cartRepository.find.mockResolvedValue(cartOf(line('a', 10)));
      menuServiceClient.getItem.mockResolvedValue(menu('a', 10, { restaurantId: 'rest-2' }));

      await expect(service.validateForCheckout('user-1')).rejects.toBeInstanceOf(CartChangedError);
      expect(cartRepository.delete).toHaveBeenCalledWith('user-1'); // nothing left: the cart is cleared
    });

    it('quietly refreshes a renamed item: the price the customer pays is the same', async () => {
      cartRepository.find.mockResolvedValue(cartOf(line('a', 10)));
      menuServiceClient.getItem.mockResolvedValue(menu('a', 10));

      await expect(service.validateForCheckout('user-1')).resolves.toMatchObject({ items: [{ name: 'Menu a', price: 10 }] });
      expect(cartRepository.save).toHaveBeenCalled();
    });

    it('does not hide a menu-service outage as a removed item', async () => {
      cartRepository.find.mockResolvedValue(cartOf(line('a', 10)));
      menuServiceClient.getItem.mockRejectedValue(new BadRequestError('Failed to fetch menu item a'));

      await expect(service.validateForCheckout('user-1')).rejects.toThrow('Failed to fetch menu item a');
      expect(cartRepository.save).not.toHaveBeenCalled();
      expect(cartRepository.delete).not.toHaveBeenCalled();
    });

    it('returns an empty cart as is (order-service refuses it)', async () => {
      cartRepository.find.mockResolvedValue(null);
      await expect(service.validateForCheckout('user-1')).resolves.toMatchObject({ items: [], total: 0 });
    });
  });
});
