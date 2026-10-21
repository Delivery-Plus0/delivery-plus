import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { Cart } from '../entities/cart.model';

function cartKey(userId: string): string {
  return `cart:${userId}`;
}

/**
 * F6 (#205): replace the cart only if it is still the value the caller read, in one atomic step.
 *
 * KEYS[1] = cart key; ARGV[1] = '1' if the caller read a cart, '0' if it read none; ARGV[2] = the
 * value read; ARGV[3] = the new value, or '' to delete; ARGV[4] = TTL in seconds.
 * Returns 1 when written, 0 when the cart changed since the read.
 */
export const REPLACE_CART_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '1' then
  if current ~= ARGV[2] then return 0 end
elseif current then
  return 0
end
if ARGV[3] == '' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
end
return 1
`;

/** The cart as read, and the exact stored value it came from (the version a write must match). */
export interface CartSnapshot {
  cart: Cart | null;
  version: string | null;
}

@Injectable()
export class CartRepository {
  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async find(userId: string): Promise<Cart | null> {
    return (await this.read(userId)).cart;
  }

  async read(userId: string): Promise<CartSnapshot> {
    const raw = await this.redis.get(cartKey(userId));
    return { cart: raw ? (JSON.parse(raw) as Cart) : null, version: raw };
  }

  /**
   * Writes `next` (or deletes the cart when it is null) only if the stored cart is still `version`.
   * Returns false when another request changed the cart first; the caller reads again and retries.
   */
  async replace(userId: string, version: string | null, next: Cart | null): Promise<boolean> {
    const written = await this.redis.eval(
      REPLACE_CART_SCRIPT,
      1,
      cartKey(userId),
      version === null ? '0' : '1',
      version ?? '',
      next ? JSON.stringify(next) : '',
      this.config.cartTtlSeconds,
    );
    return Number(written) === 1;
  }

  async delete(userId: string): Promise<void> {
    await this.redis.del(cartKey(userId));
  }

  async ping(): Promise<boolean> {
    const result = await this.redis.ping();
    return result === 'PONG';
  }
}
