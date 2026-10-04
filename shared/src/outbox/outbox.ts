import { Logger } from '@nestjs/common';
import { BaseEvent } from '../events/base-event';

/**
 * Transactional outbox (#98). A service writes its state change and the event describing it in the
 * same database transaction (`stageEvent`); `OutboxRelay` publishes staged events to Kafka afterwards.
 * An event is therefore published if and only if its state change committed, even if the process
 * dies right after the commit or Kafka is down at the time.
 *
 * Delivery is at-least-once: a crash after Kafka accepted a message but before it was marked published
 * re-sends it. That is safe because event ids are deterministic (`lifecycleEventId`) and consumers
 * deduplicate by eventId (durable idempotency).
 *
 * Plain SQL against a minimal interface, so `shared` doesn't depend on TypeORM: a TypeORM
 * `EntityManager` or `DataSource` satisfies `SqlExecutor`/`SqlTransactionRunner` as is.
 */

export const OUTBOX_TABLE = 'outbox_events';

/** Statements for a service migration's `up` (one outbox table per service database). */
export const OUTBOX_CREATE_SQL = [
  `CREATE TABLE IF NOT EXISTS "${OUTBOX_TABLE}" (
    "id" bigserial PRIMARY KEY,
    "event_id" uuid NOT NULL UNIQUE,
    "topic" varchar(200) NOT NULL,
    "payload" jsonb NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now(),
    "published_at" timestamptz,
    "attempts" integer NOT NULL DEFAULT 0,
    "last_error" text
  )`,
  `CREATE INDEX IF NOT EXISTS "IDX_outbox_events_unpublished" ON "${OUTBOX_TABLE}" ("id") WHERE "published_at" IS NULL`,
];

/** Statement for the same migration's `down`. */
export const OUTBOX_DROP_SQL = `DROP TABLE IF EXISTS "${OUTBOX_TABLE}"`;

export interface SqlExecutor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(sql: string, parameters?: unknown[]): Promise<any>;
}

export interface SqlTransactionRunner {
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * Records `event` for publication to `topic`, inside the caller's transaction. Staging the same event
 * again (same eventId, e.g. a retried action) is a no-op.
 */
export async function stageEvent<T>(tx: SqlExecutor, topic: string, event: BaseEvent<T>): Promise<void> {
  await tx.query(
    `INSERT INTO "${OUTBOX_TABLE}" ("event_id", "topic", "payload") VALUES ($1, $2, $3) ON CONFLICT ("event_id") DO NOTHING`,
    [event.eventId, topic, JSON.stringify(event)],
  );
}

export interface OutboxRelayOptions {
  /** Names this relay's advisory lock; one per service database, e.g. 'order-service'. */
  lockName: string;
  /** How often to look for unpublished events when nothing kicks the relay. */
  intervalMs?: number;
  /** Events published per transaction. */
  batchSize?: number;
}

type Publish = (topic: string, event: BaseEvent<unknown>) => Promise<void>;

/**
 * Publishes staged events in the order they were staged. Stops a batch at the first failure (recorded
 * on the row as `attempts`/`last_error`) and retries it on the next run, so a later event for the same
 * order never overtakes an earlier one. A Postgres advisory lock lets only one relay per database work
 * at a time, so several service instances neither double-publish nor reorder.
 */
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private kicked = false;

  constructor(
    private readonly db: SqlTransactionRunner,
    private readonly publish: Publish,
    private readonly options: OutboxRelayOptions,
  ) {
    this.intervalMs = options.intervalMs ?? 500;
    this.batchSize = options.batchSize ?? 100;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Stops after the batch in progress; staged events stay for the next start. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  /** Asks for a run now instead of at the next interval (called right after a commit that staged events). */
  kick(): void {
    this.kicked = true;
    this.wake?.();
  }

  /** One batch: publishes unpublished events in order and returns how many were published. */
  async drainOnce(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const [lock] = await tx.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS "locked"', [this.options.lockName]);
      if (!lock?.locked) return 0; // another instance is relaying

      const rows: { id: string; topic: string; payload: BaseEvent<unknown> | string }[] = await tx.query(
        `SELECT "id", "topic", "payload" FROM "${OUTBOX_TABLE}" WHERE "published_at" IS NULL ORDER BY "id" LIMIT $1`,
        [this.batchSize],
      );

      const published: string[] = [];
      for (const row of rows) {
        const event = typeof row.payload === 'string' ? (JSON.parse(row.payload) as BaseEvent<unknown>) : row.payload;
        try {
          await this.publish(row.topic, event);
          published.push(String(row.id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await tx.query(`UPDATE "${OUTBOX_TABLE}" SET "attempts" = "attempts" + 1, "last_error" = $2 WHERE "id" = $1`, [row.id, message]);
          this.logger.warn(`Outbox event ${event.eventId} (${event.eventType}) not published yet: ${message}`);
          break;
        }
      }

      if (published.length) {
        await tx.query(`UPDATE "${OUTBOX_TABLE}" SET "published_at" = now() WHERE "id" = ANY($1::bigint[])`, [published]);
      }
      return published.length;
    });
  }

  private async run(): Promise<void> {
    while (this.running) {
      this.kicked = false;
      let published = 0;
      try {
        published = await this.drainOnce();
      } catch (error) {
        this.logger.error('Outbox relay run failed; retrying', error instanceof Error ? error.stack : String(error));
      }
      // A full batch means more may be waiting: go again at once. Otherwise wait for a kick or the interval.
      if (this.running && published < this.batchSize && !this.kicked) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.intervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.wake = null;
      }
    }
  }
}
