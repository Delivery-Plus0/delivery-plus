import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { RATE_LIMIT_SCRIPT, RateLimiterService } from './rate-limiter.service';

/** In-memory Redis with the semantics of RATE_LIMIT_SCRIPT (one eval = one atomic step). */
class FakeRedis {
  private readonly values = new Map<string, number>();
  private readonly expiresAt = new Map<string, number>();
  now = 0;

  async eval(script: string, _keys: number, key: string, windowMs: number): Promise<number> {
    if (script !== RATE_LIMIT_SCRIPT) throw new Error('unexpected script');
    this.expire();
    const count = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, count);
    if (!this.expiresAt.has(key)) this.expiresAt.set(key, this.now + Number(windowMs));
    return count;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, Number(value));
    this.expiresAt.delete(key); // a plain SET has no TTL, like a key left by a crash between INCR and EXPIRE
  }

  async pttl(key: string): Promise<number> {
    this.expire();
    if (!this.values.has(key)) return -2;
    const at = this.expiresAt.get(key);
    return at === undefined ? -1 : at - this.now;
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
    this.expiresAt.delete(key);
  }

  private expire() {
    for (const [key, at] of this.expiresAt) {
      if (at <= this.now) {
        this.values.delete(key);
        this.expiresAt.delete(key);
      }
    }
  }
}

type Backend = { redis: Pick<Redis, 'eval' | 'set' | 'pttl' | 'del'>; close: () => Promise<void> };

const backends: Array<[string, () => Backend]> = [['in-memory fake', () => ({ redis: new FakeRedis() as never, close: async () => undefined })]];
// CI sets REDIS_TEST_URL, so the Lua script itself runs against a real Redis there.
if (process.env.REDIS_TEST_URL) {
  const url = process.env.REDIS_TEST_URL;
  backends.push(['real Redis', () => {
    const redis = new Redis(url, { maxRetriesPerRequest: 1 });
    return { redis, close: async () => void (await redis.quit()) };
  }]);
}

describe.each(backends)('RateLimiterService (F7, #204) on %s', (_name, makeBackend) => {
  let backend: Backend;
  let limiter: RateLimiterService;
  let key: string;

  beforeEach(() => {
    backend = makeBackend();
    limiter = new RateLimiterService(backend.redis as unknown as Redis);
    key = `ratelimit:test:${randomUUID()}`;
  });

  afterEach(async () => {
    await backend.redis.del(key);
    await backend.close();
  });

  it('allows up to the limit in a window, then refuses', async () => {
    const results: boolean[] = [];
    for (let i = 0; i < 4; i++) results.push(await limiter.incrementAndCheck(key, 3, 60));
    expect(results).toEqual([true, true, true, false]);
  });

  it('gives the key a TTL of the window after the first hit', async () => {
    await limiter.incrementAndCheck(key, 3, 60);

    const ttl = await backend.redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it('repairs a key that was left without a TTL, so the caller is not limited forever', async () => {
    await backend.redis.set(key, '99'); // a crash between INCR and EXPIRE left this behind
    expect(await backend.redis.pttl(key)).toBe(-1);

    await limiter.incrementAndCheck(key, 3, 60);

    expect(await backend.redis.pttl(key)).toBeGreaterThan(0);
  });

  it('does not extend the window on later hits', async () => {
    await limiter.incrementAndCheck(key, 3, 60);
    const first = await backend.redis.pttl(key);
    await limiter.incrementAndCheck(key, 3, 600);

    expect(await backend.redis.pttl(key)).toBeLessThanOrEqual(first);
  });
});
