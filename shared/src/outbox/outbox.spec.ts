import { BaseEvent } from '../events/base-event';
import { OutboxRelay, SqlExecutor, SqlTransactionRunner, stageEvent } from './outbox';

/** In-memory stand-in for the outbox table, answering the statements the outbox issues. */
class FakeOutboxDb implements SqlTransactionRunner {
  rows: { id: number; event_id: string; topic: string; payload: string; published_at: Date | null; attempts: number; last_error: string | null }[] = [];
  lockFree = true;
  private nextId = 1;

  readonly executor: SqlExecutor = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('INSERT INTO')) {
        const [eventId, topic, payload] = params as string[];
        if (!this.rows.some((r) => r.event_id === eventId)) {
          this.rows.push({ id: this.nextId++, event_id: eventId, topic, payload, published_at: null, attempts: 0, last_error: null });
        }
        return [];
      }
      if (sql.includes('pg_try_advisory_xact_lock')) return [{ locked: this.lockFree }];
      if (sql.startsWith('SELECT "id", "topic", "payload"')) {
        const [limit] = params as number[];
        return this.rows
          .filter((r) => !r.published_at)
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map((r) => ({ id: String(r.id), topic: r.topic, payload: JSON.parse(r.payload) }));
      }
      if (sql.includes('"attempts" = "attempts" + 1')) {
        const [id, error] = params as [string, string];
        const row = this.rows.find((r) => String(r.id) === id)!;
        row.attempts += 1;
        row.last_error = error;
        return [];
      }
      if (sql.includes('"published_at" = now()')) {
        const [ids] = params as [string[]];
        this.rows.filter((r) => ids.includes(String(r.id))).forEach((r) => (r.published_at = new Date()));
        return [];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return work(this.executor);
  }
}

const event = (orderId: string, eventType: string): BaseEvent<{ orderId: string }> => ({
  eventId: `${orderId}-${eventType}`,
  eventType,
  timestamp: '2026-10-04T12:00:00.000Z',
  correlationId: 'corr-1',
  payload: { orderId },
});

describe('transactional outbox', () => {
  let db: FakeOutboxDb;
  let publish: jest.Mock;
  let relay: OutboxRelay;

  beforeEach(() => {
    db = new FakeOutboxDb();
    publish = jest.fn().mockResolvedValue(undefined);
    relay = new OutboxRelay(db, publish, { lockName: 'test-service', batchSize: 2, intervalMs: 10_000 });
  });

  it('stages each event once, even when the same action is retried', async () => {
    await stageEvent(db.executor, 'order.events', event('o1', 'order.confirmed'));
    await stageEvent(db.executor, 'order.events', event('o1', 'order.confirmed'));

    expect(db.rows).toHaveLength(1);
    expect(JSON.parse(db.rows[0].payload)).toEqual(event('o1', 'order.confirmed'));
  });

  it('publishes staged events in the order they were staged and marks them published', async () => {
    await stageEvent(db.executor, 'order.events', event('o1', 'order.created'));
    await stageEvent(db.executor, 'order.events', event('o1', 'order.confirmed'));
    await stageEvent(db.executor, 'delivery.events', event('o1', 'delivery.created'));

    expect(await relay.drainOnce()).toBe(2); // batch size 2
    expect(await relay.drainOnce()).toBe(1);
    expect(await relay.drainOnce()).toBe(0);

    expect(publish.mock.calls.map(([topic, e]) => [topic, e.eventType])).toEqual([
      ['order.events', 'order.created'],
      ['order.events', 'order.confirmed'],
      ['delivery.events', 'delivery.created'],
    ]);
    expect(db.rows.every((r) => r.published_at)).toBe(true);
  });

  it('stops at the first failure, records it, and publishes from there on the next run (no overtaking)', async () => {
    await stageEvent(db.executor, 'order.events', event('o1', 'order.preparing'));
    await stageEvent(db.executor, 'order.events', event('o1', 'order.ready_for_pickup'));
    publish.mockRejectedValueOnce(new Error('broker unavailable'));

    expect(await relay.drainOnce()).toBe(0);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(db.rows[0]).toMatchObject({ attempts: 1, last_error: 'broker unavailable', published_at: null });
    expect(db.rows[1]).toMatchObject({ attempts: 0, published_at: null });

    expect(await relay.drainOnce()).toBe(2);
    expect(publish.mock.calls.map(([, e]) => e.eventType)).toEqual(['order.preparing', 'order.preparing', 'order.ready_for_pickup']);
  });

  it('publishes nothing while another instance holds the relay lock', async () => {
    await stageEvent(db.executor, 'order.events', event('o1', 'order.created'));
    db.lockFree = false;

    expect(await relay.drainOnce()).toBe(0);
    expect(publish).not.toHaveBeenCalled();
    expect(db.rows[0].published_at).toBeNull();
  });

  it('runs as soon as it is kicked instead of waiting for the interval, and stops cleanly', async () => {
    relay.start();
    await new Promise((r) => setTimeout(r, 20)); // first (empty) run done; now waiting 10 s

    await stageEvent(db.executor, 'order.events', event('o2', 'order.created'));
    relay.kick();
    await new Promise((r) => setTimeout(r, 20));

    expect(publish).toHaveBeenCalledTimes(1);
    await relay.stop();
  });
});
