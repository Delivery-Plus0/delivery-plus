import { Injectable, Inject } from '@nestjs/common';
import { Redis } from 'ioredis';

/**
 * F7 (#204): count the hit and make sure the window has a TTL in one atomic step. The old
 * INCR-then-EXPIRE could crash in between and leave a key with no TTL, rate-limiting that caller
 * forever. Checking PTTL (rather than "count is 1") also repairs any key already left without one.
 *
 * KEYS[1] = counter key, ARGV[1] = window in milliseconds. Returns the new count.
 */
export const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

@Injectable()
export class RateLimiterService {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async incrementAndCheck(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const current = Number(await this.redis.eval(RATE_LIMIT_SCRIPT, 1, key, windowSeconds * 1000));
    return current <= limit;
  }
}
