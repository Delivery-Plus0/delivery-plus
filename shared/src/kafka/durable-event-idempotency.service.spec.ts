import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  DurableEventIdempotencyService,
  eventIdempotencyKey,
} from './durable-event-idempotency.service';
import {
  ACQUIRE_SCRIPT,
  MARK_PROCESSED_SCRIPT,
  RELEASE_SCRIPT,
} from './durable-event-idempotency.scripts';

/**
 * In-memory stand-in for Redis that reproduces the semantics of the three Lua
 * scripts, with a manual clock so lease expiry is deterministic. Each eval call
 * runs synchronously, mirroring Redis's atomic script execution.
 */
class FakeRedis {
  private readonly store = new Map<string, { value: string; expiresAt: number }>();
  private now = 0;

  advance(ms: number) {
    this.now += ms;
  }

  async get(key: string): Promise<string | null> {
    return this.read(key);
  }

  /** Redis PTTL: remaining ms, or -2 when the key does not exist. */
  async pttl(key: string): Promise<number> {
    if (this.read(key) === null) return -2;
    return this.store.get(key)!.expiresAt - this.now;
  }

  async eval(script: string, _numKeys: number, key: string, ...args: Array<string | number>) {
    const [leaseValue, ttlMs] = args;
    const current = this.read(key);

    if (script === ACQUIRE_SCRIPT) {
      if (current === null) {
        this.write(key, String(leaseValue), Number(ttlMs));
        return 'acquired';
      }
      if (current === leaseValue) return 'acquired';
      return current === 'processed' ? 'processed' : 'in-progress';
    }
    if (script === MARK_PROCESSED_SCRIPT) {
      if (current === 'processed') return 0;
      this.write(key, 'processed', Number(ttlMs));
      return current === leaseValue ? 1 : 0;
    }
    if (script === RELEASE_SCRIPT) {
      if (current !== leaseValue) return 0;
      this.store.delete(key);
      return 1;
    }
    throw new Error('FakeRedis: unknown script');
  }

  private read(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  private write(key: string, value: string, ttlMs: number) {
    this.store.set(key, { value, expiresAt: this.now + ttlMs });
  }
}

interface Backend {
  /** A client for a new service instance; the real backend opens a fresh connection. */
  connect(): Redis;
  advance(ms: number): Promise<void>;
  close(): Promise<void>;
}

function fakeBackend(): Backend {
  const fake = new FakeRedis();
  return {
    connect: () => fake as unknown as Redis,
    advance: async (ms) => fake.advance(ms),
    close: async () => undefined,
  };
}

function realBackend(url: string): Backend {
  const clients: Redis[] = [];
  return {
    connect: () => {
      const client = new Redis(url);
      clients.push(client);
      return client;
    },
    advance: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    close: async () => {
      await Promise.all(clients.map((client) => client.quit()));
    },
  };
}

// Set REDIS_TEST_URL (e.g. redis://localhost:6379) to also run the suite against
// a real Redis, which exercises the Lua scripts themselves.
const backends: Array<[string, () => Backend]> = [['in-memory fake', fakeBackend]];
if (process.env.REDIS_TEST_URL) {
  const url = process.env.REDIS_TEST_URL;
  backends.push(['real Redis', () => realBackend(url)]);
}

const LEASE_MS = 100;
const RETENTION_MS = 60_000;

describe.each(backends)('DurableEventIdempotencyService (%s)', (_name, createBackend) => {
  let backend: Backend;
  let service: DurableEventIdempotencyService;
  // Unique per test so real-Redis runs never see each other's keys.
  let group: string;
  let eventId: string;

  beforeEach(() => {
    backend = createBackend();
    service = newService();
    group = `test-group-${randomUUID()}`;
    eventId = randomUUID();
  });

  afterEach(async () => {
    await backend.close();
  });

  function newService() {
    return new DurableEventIdempotencyService(backend.connect(), {
      leaseTtlMs: LEASE_MS,
      retentionTtlMs: RETENTION_MS,
    });
  }

  async function acquireToken(svc = service, consumerGroup = group, id = eventId) {
    const result = await svc.tryAcquire(consumerGroup, id);
    if (result.status !== 'acquired') throw new Error(`expected acquired, got ${result.status}`);
    return result.leaseToken;
  }

  it('acquires an unclaimed event and returns a lease token', async () => {
    const result = await service.tryAcquire(group, eventId);

    expect(result).toEqual({ status: 'acquired', leaseToken: expect.any(String) });
    expect(await service.isProcessed(group, eventId)).toBe(false);
  });

  it('lets exactly one of two concurrent consumers acquire the same event', async () => {
    const otherConsumer = newService();

    const results = await Promise.all([
      service.tryAcquire(group, eventId),
      otherConsumer.tryAcquire(group, eventId),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['acquired', 'in-progress']);
  });

  it('gives the event to exactly one of many concurrent consumers', async () => {
    // On the real backend each consumer has its own connection.
    const consumers = Array.from({ length: 25 }, () => newService());

    const results = await Promise.all(consumers.map((c) => c.tryAcquire(group, eventId)));

    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 'acquired')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'in-progress')).toHaveLength(24);
  });

  it('answers "acquired" to a re-sent acquire carrying the same lease token', async () => {
    // Simulates ioredis resending an EVAL whose first execution succeeded but
    // whose reply was lost to a disconnect.
    const client = backend.connect();
    const key = eventIdempotencyKey(group, eventId);
    const sendAcquire = () => client.eval(ACQUIRE_SCRIPT, 1, key, 'lease:resent-token', LEASE_MS);

    await expect(sendAcquire()).resolves.toBe('acquired');
    const ttlAfterFirst = await client.pttl(key);
    await expect(sendAcquire()).resolves.toBe('acquired');

    // Still one lease, not extended by the re-send: others see it held, and its token releases it.
    expect(await client.pttl(key)).toBeLessThanOrEqual(ttlAfterFirst);
    expect(await service.tryAcquire(group, eventId)).toEqual({ status: 'in-progress' });
    await expect(service.release(group, eventId, 'resent-token')).resolves.toBe(true);
  });

  it('detects a processed event and refuses to hand it out again', async () => {
    const token = await acquireToken();

    await expect(service.markProcessed(group, eventId, token)).resolves.toBe(true);

    expect(await service.isProcessed(group, eventId)).toBe(true);
    expect(await service.tryAcquire(group, eventId)).toEqual({ status: 'processed' });
  });

  it('lets another consumer acquire after the lease expires, without the stale holder interfering', async () => {
    const crashedToken = await acquireToken();
    await backend.advance(LEASE_MS + 50);

    const otherConsumer = newService();
    const takeoverToken = await acquireToken(otherConsumer);

    // The stale holder cannot release the new holder's lease...
    await expect(service.release(group, eventId, crashedToken)).resolves.toBe(false);
    expect(await otherConsumer.tryAcquire(group, eventId)).toEqual({ status: 'in-progress' });

    // ...and the new holder completes normally.
    await expect(otherConsumer.markProcessed(group, eventId, takeoverToken)).resolves.toBe(true);
    expect(await service.isProcessed(group, eventId)).toBe(true);
  });

  it('records processing but reports lost ownership when the lease expired before markProcessed', async () => {
    const token = await acquireToken();
    await backend.advance(LEASE_MS + 50);

    await expect(service.markProcessed(group, eventId, token)).resolves.toBe(false);
    expect(await service.isProcessed(group, eventId)).toBe(true);
  });

  it('lets a late consumer record processing over the current owner\'s lease, leaving the owner unable to mark or release it', async () => {
    const lateToken = await acquireToken();
    await backend.advance(LEASE_MS + 50);
    const owner = newService();
    const ownerToken = await acquireToken(owner);

    // Reviewed design: the late consumer's handler did run, so the event is
    // recorded as processed over the owner's lease; false flags the overlap.
    await expect(service.markProcessed(group, eventId, lateToken)).resolves.toBe(false);
    expect(await owner.isProcessed(group, eventId)).toBe(true);

    await expect(owner.markProcessed(group, eventId, ownerToken)).resolves.toBe(false);
    await expect(owner.release(group, eventId, ownerToken)).resolves.toBe(false);
    expect(await owner.tryAcquire(group, eventId)).toEqual({ status: 'processed' });
  });

  it('leaves an existing processed marker and its TTL untouched', async () => {
    const client = backend.connect();
    const key = eventIdempotencyKey(group, eventId);
    const token = await acquireToken();
    await service.markProcessed(group, eventId, token);
    const ttlBefore = await client.pttl(key);

    // Neither a longer nor a shorter retention may touch the existing marker.
    await expect(service.markProcessed(group, eventId, token, RETENTION_MS * 10)).resolves.toBe(false);
    await expect(service.markProcessed(group, eventId, 'other-token', 1)).resolves.toBe(false);

    const ttlAfter = await client.pttl(key);
    expect(ttlAfter).toBeLessThanOrEqual(ttlBefore); // not extended
    expect(ttlAfter).toBeGreaterThan(1); // not shortened (and not deleted: PTTL -2)
    expect(await service.isProcessed(group, eventId)).toBe(true);
  });

  it('makes a released event immediately available to retry', async () => {
    const token = await acquireToken();

    await expect(service.release(group, eventId, token)).resolves.toBe(true);

    expect(await service.isProcessed(group, eventId)).toBe(false);
    expect((await service.tryAcquire(group, eventId)).status).toBe('acquired');
  });

  it('never lets a release erase a processed marker', async () => {
    const token = await acquireToken();
    await service.markProcessed(group, eventId, token);

    await expect(service.release(group, eventId, token)).resolves.toBe(false);
    expect(await service.isProcessed(group, eventId)).toBe(true);
  });

  it('keeps processed state across a process restart', async () => {
    const token = await acquireToken();
    await service.markProcessed(group, eventId, token);

    const restarted = newService();

    expect(await restarted.isProcessed(group, eventId)).toBe(true);
    expect(await restarted.tryAcquire(group, eventId)).toEqual({ status: 'processed' });
  });

  it('keeps consumer groups independent for the same event id', async () => {
    const otherGroup = `${group}-other`;
    const token = await acquireToken();
    await service.markProcessed(group, eventId, token);

    expect(await service.isProcessed(otherGroup, eventId)).toBe(false);
    expect((await service.tryAcquire(otherGroup, eventId)).status).toBe('acquired');
  });

  it('does not collide when a colon moves between the group and the event id', async () => {
    const token = await acquireToken(service, `${group}:a`, 'b');
    await service.markProcessed(`${group}:a`, 'b', token);

    expect(await service.isProcessed(group, 'a:b')).toBe(false);
    expect((await service.tryAcquire(group, 'a:b')).status).toBe('acquired');
  });

  it('forgets a processed event after the retention TTL, so it can be acquired again', async () => {
    const shortRetention = new DurableEventIdempotencyService(backend.connect(), {
      leaseTtlMs: LEASE_MS,
      retentionTtlMs: LEASE_MS,
    });
    const token = await acquireToken(shortRetention);
    await shortRetention.markProcessed(group, eventId, token);

    await backend.advance(LEASE_MS + 50);

    expect(await shortRetention.isProcessed(group, eventId)).toBe(false);
    expect((await shortRetention.tryAcquire(group, eventId)).status).toBe('acquired');
  });
});

describe('eventIdempotencyKey', () => {
  it('scopes the key by consumer group and event id', () => {
    expect(eventIdempotencyKey('order-service-group', 'evt-1')).toBe(
      'kafka:idempotency:order-service-group:evt-1',
    );
  });

  it.each([
    [['a:b', 'c'], ['a', 'b:c']],
    [['a:', 'b'], ['a', ':b']],
    [['%3A', 'x'], [':', 'x']],
    [['{tag}', 'x'], ['tag', 'x']],
  ])('maps %j and %j to different keys', ([g1, e1], [g2, e2]) => {
    expect(eventIdempotencyKey(g1, e1)).not.toBe(eventIdempotencyKey(g2, e2));
  });

  it('rejects empty consumer groups and event ids', () => {
    expect(() => eventIdempotencyKey('', 'evt-1')).toThrow(TypeError);
    expect(() => eventIdempotencyKey('group', '')).toThrow(TypeError);
  });
});

describe('DurableEventIdempotencyService infrastructure failures', () => {
  const redisDown = new Error('connect ECONNREFUSED 127.0.0.1:6379');
  let redis: { get: jest.Mock; eval: jest.Mock };
  let service: DurableEventIdempotencyService;

  beforeEach(() => {
    redis = {
      get: jest.fn().mockRejectedValue(redisDown),
      eval: jest.fn().mockRejectedValue(redisDown),
    };
    service = new DurableEventIdempotencyService(redis as unknown as Redis);
  });

  it('propagates Redis errors from every operation instead of treating them as "not processed"', async () => {
    await expect(service.isProcessed('group', 'evt-1')).rejects.toBe(redisDown);
    await expect(service.tryAcquire('group', 'evt-1')).rejects.toBe(redisDown);
    await expect(service.markProcessed('group', 'evt-1', 'token')).rejects.toBe(redisDown);
    await expect(service.release('group', 'evt-1', 'token')).rejects.toBe(redisDown);
  });

  it('throws on a script reply it does not recognise', async () => {
    redis.eval.mockResolvedValue('OK');

    await expect(service.tryAcquire('group', 'evt-1')).rejects.toThrow(/Unexpected/);
    await expect(service.markProcessed('group', 'evt-1', 'token')).rejects.toThrow(/Unexpected/);
    await expect(service.release('group', 'evt-1', 'token')).rejects.toThrow(/Unexpected/);
  });

  it('applies the configured default TTLs and allows a per-call lease override', async () => {
    redis.eval.mockResolvedValue('acquired');
    const configured = new DurableEventIdempotencyService(redis as unknown as Redis, {
      leaseTtlMs: 5_000,
      retentionTtlMs: 9_000,
    });

    await configured.tryAcquire('group', 'evt-1');
    await configured.tryAcquire('group', 'evt-1', 1_234);
    redis.eval.mockResolvedValue(1);
    await configured.markProcessed('group', 'evt-1', 'token');

    expect(redis.eval.mock.calls[0].slice(1)).toEqual([
      1,
      'kafka:idempotency:group:evt-1',
      expect.stringMatching(/^lease:/),
      5_000,
    ]);
    expect(redis.eval.mock.calls[1][4]).toBe(1_234);
    expect(redis.eval.mock.calls[2].slice(1)).toEqual([
      1,
      'kafka:idempotency:group:evt-1',
      'lease:token',
      9_000,
    ]);
  });

  it('rejects invalid TTLs and lease tokens before touching Redis', async () => {
    expect(() => new DurableEventIdempotencyService(redis as unknown as Redis, { leaseTtlMs: 0 })).toThrow(
      RangeError,
    );
    expect(
      () => new DurableEventIdempotencyService(redis as unknown as Redis, { retentionTtlMs: 1.5 }),
    ).toThrow(RangeError);
    await expect(service.tryAcquire('group', 'evt-1', -1)).rejects.toThrow(RangeError);
    await expect(service.markProcessed('group', 'evt-1', '')).rejects.toThrow(TypeError);
    await expect(service.release('group', 'evt-1', '')).rejects.toThrow(TypeError);
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
