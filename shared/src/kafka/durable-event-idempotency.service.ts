import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import {
  ACQUIRE_SCRIPT,
  MARK_PROCESSED_SCRIPT,
  RELEASE_SCRIPT,
} from './durable-event-idempotency.scripts';

export const DURABLE_EVENT_IDEMPOTENCY_OPTIONS = 'DURABLE_EVENT_IDEMPOTENCY_OPTIONS';

export const DEFAULT_EVENT_LEASE_TTL_MS = 60_000;
// Matches Kafka's default log retention, the window in which a message can be redelivered.
export const DEFAULT_PROCESSED_RETENTION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface DurableEventIdempotencyOptions {
  /** How long a claim blocks other consumers before expiring on its own (crash safety). */
  leaseTtlMs?: number;
  /** How long a processed marker is kept. Must outlive the topic's redelivery window. */
  retentionTtlMs?: number;
}

export type EventAcquireResult =
  | { status: 'acquired'; leaseToken: string }
  | { status: 'processed' }
  | { status: 'in-progress' };

const PROCESSED = 'processed';

/**
 * Builds the Redis key for one (consumerGroup, eventId) pair. Each segment is
 * URI-encoded so a ':' inside a group or event id can never make two different
 * pairs map to the same key (e.g. "a:b" + "c" vs "a" + "b:c").
 */
export function eventIdempotencyKey(consumerGroup: string, eventId: string): string {
  assertNonEmpty('consumerGroup', consumerGroup);
  assertNonEmpty('eventId', eventId);
  return `kafka:idempotency:${encodeURIComponent(consumerGroup)}:${encodeURIComponent(eventId)}`;
}

/**
 * Durable, cross-process record of which events each consumer group has
 * handled, backed by the shared REDIS_CLIENT. Redis errors are never caught
 * here: callers must see infrastructure failures rather than a silent
 * "not processed" answer that would re-run side effects.
 */
@Injectable()
export class DurableEventIdempotencyService {
  private readonly leaseTtlMs: number;
  private readonly retentionTtlMs: number;

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    @Optional()
    @Inject(DURABLE_EVENT_IDEMPOTENCY_OPTIONS)
    options: DurableEventIdempotencyOptions = {},
  ) {
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_EVENT_LEASE_TTL_MS;
    this.retentionTtlMs = options.retentionTtlMs ?? DEFAULT_PROCESSED_RETENTION_TTL_MS;
    assertPositiveInteger('leaseTtlMs', this.leaseTtlMs);
    assertPositiveInteger('retentionTtlMs', this.retentionTtlMs);
  }

  /**
   * Informational only (logging, metrics, diagnostics). This MUST NOT be used
   * to decide whether to run a handler: checking here and acting later is a
   * check-then-act race. Gate processing on tryAcquire(), which checks and
   * claims in one atomic step.
   */
  async isProcessed(consumerGroup: string, eventId: string): Promise<boolean> {
    const value = await this.redis.get(eventIdempotencyKey(consumerGroup, eventId));
    return value === PROCESSED;
  }

  /**
   * The correctness gate for processing: atomically checks the event's state
   * and claims it. Run the handler only on "acquired"; skip on "processed";
   * on "in-progress" another consumer holds it, so do not process or commit.
   * Only one caller at a time receives "acquired"; the claim expires after
   * leaseTtlMs if never released.
   */
  async tryAcquire(
    consumerGroup: string,
    eventId: string,
    leaseTtlMs: number = this.leaseTtlMs,
  ): Promise<EventAcquireResult> {
    assertPositiveInteger('leaseTtlMs', leaseTtlMs);
    const key = eventIdempotencyKey(consumerGroup, eventId);
    const leaseToken = randomUUID();

    const result = await this.redis.eval(ACQUIRE_SCRIPT, 1, key, leaseValue(leaseToken), leaseTtlMs);
    switch (result) {
      case 'acquired':
        return { status: 'acquired', leaseToken };
      case 'processed':
        return { status: 'processed' };
      case 'in-progress':
        return { status: 'in-progress' };
      default:
        throw new Error(`Unexpected idempotency acquire result for ${key}: ${String(result)}`);
    }
  }

  /**
   * Records the event as processed for retentionTtlMs. Returns true only when
   * the caller still owned its lease. Returns false when the lease had expired
   * or been taken over (the handler may have run concurrently elsewhere; the
   * event is still recorded as processed, even over another consumer's lease),
   * or when the event was already processed (the existing marker and its TTL
   * are left untouched).
   */
  async markProcessed(
    consumerGroup: string,
    eventId: string,
    leaseToken: string,
    retentionTtlMs: number = this.retentionTtlMs,
  ): Promise<boolean> {
    assertNonEmpty('leaseToken', leaseToken);
    assertPositiveInteger('retentionTtlMs', retentionTtlMs);
    const key = eventIdempotencyKey(consumerGroup, eventId);

    const result = await this.redis.eval(
      MARK_PROCESSED_SCRIPT,
      1,
      key,
      leaseValue(leaseToken),
      retentionTtlMs,
    );
    return toOwnershipFlag(key, result);
  }

  /**
   * Gives up the claim without marking the event processed, so it can be
   * retried immediately. A no-op (returns false) if the lease is no longer ours.
   */
  async release(consumerGroup: string, eventId: string, leaseToken: string): Promise<boolean> {
    assertNonEmpty('leaseToken', leaseToken);
    const key = eventIdempotencyKey(consumerGroup, eventId);

    const result = await this.redis.eval(RELEASE_SCRIPT, 1, key, leaseValue(leaseToken));
    return toOwnershipFlag(key, result);
  }
}

function leaseValue(leaseToken: string): string {
  return `lease:${leaseToken}`;
}

function toOwnershipFlag(key: string, result: unknown): boolean {
  if (result === 1) return true;
  if (result === 0) return false;
  throw new Error(`Unexpected idempotency script result for ${key}: ${String(result)}`);
}

function assertNonEmpty(name: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer number of milliseconds`);
  }
}
