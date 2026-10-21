import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { CartChangedError, CartWriteConflictError, ConflictError } from '@food-delivery/shared';
import { CartService } from './cart.service';
import { CartRepository } from '../repositories/cart.repository';
import { MenuItemDetails, MenuServiceClient } from '../common/menu-service.client';
import { AppConfig } from '../config/app-config';
import { InMemoryCarts } from '../testing/in-memory-carts';

/** Menu items item-0 … item-29 of one restaurant, EGP 10 each; getItem yields like an HTTP call. */
function menu(overrides: Record<string, Partial<MenuItemDetails>> = {}, delayMs = 0) {
  return {
    getItem: jest.fn(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { id, restaurantId: 'rest-1', name: `Item ${id}`, price: 10, available: true, archived: false, ...overrides[id] } as MenuItemDetails;
    }),
  } as unknown as MenuServiceClient;
}

type Backend = { repository: () => CartRepository; close: () => Promise<void> };

const backends: Array<[string, () => Backend]> = [
  ['in-memory fake', () => {
    const carts = new InMemoryCarts();
    return { repository: () => carts.asRepository(), close: async () => undefined };
  }],
];
// CI sets REDIS_TEST_URL, so the compare-and-set Lua script itself runs against a real Redis there.
if (process.env.REDIS_TEST_URL) {
  const url = process.env.REDIS_TEST_URL;
  backends.push(['real Redis', () => {
    const redis = new Redis(url, { maxRetriesPerRequest: 1 });
    return {
      repository: () => new CartRepository(redis, { cartTtlSeconds: 60 } as AppConfig),
      close: async () => void (await redis.quit()),
    };
  }]);
}

describe.each(backends)('CartService concurrent writes (F6, #205) on %s', (_name, makeBackend) => {
  let backend: Backend;
  let repository: CartRepository;
  let userId: string;

  beforeEach(() => {
    backend = makeBackend();
    repository = backend.repository();
    userId = `user-${randomUUID()}`;
  });

  afterEach(async () => {
    await repository.delete(userId);
    await backend.close();
  });

  it('keeps all 20 items when 20 different items are added at the same time', async () => {
    const service = new CartService(repository, menu());

    await Promise.all(Array.from({ length: 20 }, (_, i) => service.addItem(userId, { menuItemId: `item-${i}`, quantity: 1 })));

    const cart = await service.getCart(userId);
    expect(cart.items.map((item) => item.menuItemId).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `item-${i}`).sort());
    expect(cart.total).toBe(200);
  });

  it('ends concurrent quantity changes of one item in a deterministic total', async () => {
    const service = new CartService(repository, menu());

    // 5 × (+1) and 5 × (+2) on the same line, all at once: every one of them counts.
    await Promise.all(Array.from({ length: 10 }, (_, i) => service.addItem(userId, { menuItemId: 'item-0', quantity: i % 2 === 0 ? 1 : 2 })));

    const cart = await service.getCart(userId);
    expect(cart.items).toEqual([expect.objectContaining({ menuItemId: 'item-0', quantity: 15 })]);
    expect(cart.total).toBe(150);
  });

  it('applies concurrent quantity updates one after the other, never mixing two carts', async () => {
    const service = new CartService(repository, menu());
    await service.addItem(userId, { menuItemId: 'item-0', quantity: 1 });
    await service.addItem(userId, { menuItemId: 'item-1', quantity: 1 });

    await Promise.all([
      service.updateItemQuantity(userId, 'item-0', { quantity: 4 }),
      service.updateItemQuantity(userId, 'item-1', { quantity: 6 }),
      service.addItem(userId, { menuItemId: 'item-2', quantity: 3 }),
    ]);

    const cart = await service.getCart(userId);
    const quantities = Object.fromEntries(cart.items.map((item) => [item.menuItemId, item.quantity]));
    expect(quantities).toEqual({ 'item-0': 4, 'item-1': 6, 'item-2': 3 });
    expect(cart.total).toBe(130);
  });

  it('does not lose an item added while checkout validation was asking menu-service', async () => {
    // item-0's price went up; validation is slow because menu-service is.
    const slowMenu = menu({ 'item-0': { price: 12 } }, 30);
    const fastMenu = menu();
    await new CartService(repository, fastMenu).addItem(userId, { menuItemId: 'item-0', quantity: 1 });

    const validation = new CartService(repository, slowMenu).validateForCheckout(userId).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await new CartService(repository, fastMenu).addItem(userId, { menuItemId: 'item-1', quantity: 2 });

    expect(await validation).toBeInstanceOf(CartChangedError);
    const cart = await new CartService(repository, fastMenu).getCart(userId);
    expect(cart.items).toEqual([
      expect.objectContaining({ menuItemId: 'item-0', price: 12, quantity: 1 }),
      expect.objectContaining({ menuItemId: 'item-1', price: 10, quantity: 2 }),
    ]);
  });

  it('removes the cart key when the last item goes, even with an add racing it', async () => {
    const service = new CartService(repository, menu());
    await service.addItem(userId, { menuItemId: 'item-0', quantity: 1 });

    await Promise.all([service.removeItem(userId, 'item-0'), service.addItem(userId, { menuItemId: 'item-1', quantity: 1 })]);

    const ids = (await service.getCart(userId)).items.map((item) => item.menuItemId);
    // Whichever order they landed in, item-1 survives and item-0 is gone.
    expect(ids).toEqual(['item-1']);
  });
});

describe('CartService when a cart never stops changing', () => {
  it('gives up with 409 CartWriteConflict instead of retrying forever', async () => {
    const carts = new InMemoryCarts();
    const repository = carts.asRepository();
    repository.replace.mockResolvedValue(false); // always lost to another writer

    const error = await new CartService(repository, menu()).addItem('user-1', { menuItemId: 'item-0', quantity: 1 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CartWriteConflictError);
    expect(error).toMatchObject({ statusCode: 409, error: 'CartWriteConflict' });
    expect(repository.replace).toHaveBeenCalledTimes(50);
  });

  it('keeps the different-restaurant 409 as its own code, distinct from CartWriteConflict', async () => {
    const carts = new InMemoryCarts();
    carts.seed('user-1', { userId: 'user-1', restaurantId: 'rest-2', items: [{ menuItemId: 'x', name: 'X', price: 5, quantity: 1 }], updatedAt: 't' });

    const error = await new CartService(carts.asRepository(), menu()).addItem('user-1', { menuItemId: 'item-0', quantity: 1 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect(error).not.toBeInstanceOf(CartWriteConflictError);
    expect(error).toMatchObject({ statusCode: 409, error: 'Conflict' });
  });

  it('answers CartWriteConflict from checkout validation too when the cart never settles', async () => {
    const carts = new InMemoryCarts();
    carts.seed('user-1', { userId: 'user-1', restaurantId: 'rest-1', items: [{ menuItemId: 'item-0', name: 'Old', price: 10, quantity: 1 }], updatedAt: 't' });
    const repository = carts.asRepository();
    repository.replace.mockResolvedValue(false);

    await expect(new CartService(repository, menu()).validateForCheckout('user-1')).rejects.toMatchObject({ statusCode: 409, error: 'CartWriteConflict' });
  });
});

if (process.env.REDIS_TEST_URL) {
  describe('CartRepository.replace on real Redis (F6)', () => {
    const redis = new Redis(process.env.REDIS_TEST_URL as string, { maxRetriesPerRequest: 1 });
    const repository = new CartRepository(redis, { cartTtlSeconds: 60 } as AppConfig);
    const cart = (userId: string, quantity: number) => ({ userId, restaurantId: 'rest-1', items: [{ menuItemId: 'a', name: 'A', price: 10, quantity }], updatedAt: 't' });

    afterAll(async () => {
      await redis.quit();
    });

    it('writes only over the version it read, sets the TTL, and deletes with null', async () => {
      const userId = `user-${randomUUID()}`;

      await expect(repository.replace(userId, null, cart(userId, 1))).resolves.toBe(true);
      await expect(repository.replace(userId, null, cart(userId, 2))).resolves.toBe(false); // it exists now
      const { version } = await repository.read(userId);
      expect(await redis.ttl(`cart:${userId}`)).toBeGreaterThan(0);

      await expect(repository.replace(userId, version, cart(userId, 3))).resolves.toBe(true);
      await expect(repository.replace(userId, version, cart(userId, 4))).resolves.toBe(false); // stale version
      expect((await repository.find(userId))?.items[0].quantity).toBe(3);

      const latest = (await repository.read(userId)).version;
      await expect(repository.replace(userId, latest, null)).resolves.toBe(true);
      expect(await redis.exists(`cart:${userId}`)).toBe(0);
    });
  });
}
