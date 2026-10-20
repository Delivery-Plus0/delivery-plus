import { CartRepository, CartSnapshot } from '../repositories/cart.repository';
import { Cart } from '../entities/cart.model';

/**
 * Test support: carts stored as JSON strings, with the same compare-and-set rule as
 * REPLACE_CART_SCRIPT. Every call yields once, like a Redis round trip, so concurrent requests
 * interleave between their read and their write.
 */
export class InMemoryCarts {
  private readonly values = new Map<string, string>();
  private readonly tick = () => new Promise((resolve) => setImmediate(resolve));

  seed(userId: string, cart: Cart | null): void {
    if (cart) this.values.set(userId, JSON.stringify(cart));
    else this.values.delete(userId);
  }

  stored(userId: string): Cart | null {
    const raw = this.values.get(userId);
    return raw ? (JSON.parse(raw) as Cart) : null;
  }

  asRepository(): jest.Mocked<CartRepository> {
    const read = async (userId: string): Promise<CartSnapshot> => {
      await this.tick();
      const raw = this.values.get(userId) ?? null;
      return { cart: raw ? (JSON.parse(raw) as Cart) : null, version: raw };
    };
    return {
      read: jest.fn(read),
      find: jest.fn(async (userId: string) => (await read(userId)).cart),
      replace: jest.fn(async (userId: string, version: string | null, next: Cart | null) => {
        await this.tick();
        if ((this.values.get(userId) ?? null) !== version) return false;
        this.seed(userId, next);
        return true;
      }),
      delete: jest.fn(async (userId: string) => {
        await this.tick();
        this.values.delete(userId);
      }),
      ping: jest.fn(async () => true),
    } as unknown as jest.Mocked<CartRepository>;
  }
}
