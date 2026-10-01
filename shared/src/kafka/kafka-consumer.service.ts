import { Injectable, Inject, OnModuleInit, OnModuleDestroy, Logger, Optional } from '@nestjs/common';
import { Kafka, Consumer, EachMessagePayload, IHeaders } from 'kafkajs';
import { BaseEvent } from '../events/base-event';
import { KafkaModuleOptions } from './kafka.module';
import { KafkaProducerService } from './kafka-producer.service';
import {
  DEFAULT_EVENT_LEASE_TTL_MS,
  DurableEventIdempotencyService,
} from './durable-event-idempotency.service';

export type MessageHandler<T> = (event: BaseEvent<T>) => Promise<void>;

/** Messages a consumer group could not handle go to `<topic>.dlq`, one per source topic. */
export const DEAD_LETTER_SUFFIX = '.dlq';

export function deadLetterTopic(topic: string): string {
  return `${topic}${DEAD_LETTER_SUFFIX}`;
}

/** Headers added to a dead-lettered message; the key, value and original headers are kept as-is. */
export const DEAD_LETTER_HEADERS = {
  originalTopic: 'dlq-original-topic',
  originalPartition: 'dlq-original-partition',
  originalOffset: 'dlq-original-offset',
  consumerGroup: 'dlq-consumer-group',
  reason: 'dlq-reason',
  error: 'dlq-error',
  failedAt: 'dlq-failed-at',
} as const;

export type DeadLetterReason = 'unparseable' | 'handler-failed';

export const DEFAULT_MAX_HANDLER_ATTEMPTS = 3;
const CLAIM_POLL_MS = 500;
/** Wait past a crashed consumer's lease before giving the message back to kafkajs to retry. */
const CLAIM_WAIT_MS = DEFAULT_EVENT_LEASE_TTL_MS + 5_000;

type Claim = { status: 'acquired'; leaseToken?: string } | { status: 'processed' };

@Injectable()
export class KafkaConsumerService implements OnModuleInit, OnModuleDestroy {
  private kafka: Kafka;
  private consumer: Consumer;
  private readonly groupId: string;
  private readonly maxAttempts: number;
  private handlers = new Map<string, Map<string, MessageHandler<any>>>();
  /** Only used without durable idempotency: dedupes within this process, forgotten on restart. */
  private processedInMemory = new Set<string>();
  private readonly logger = new Logger(KafkaConsumerService.name);

  constructor(
    @Inject('KAFKA_OPTIONS') private options: KafkaModuleOptions,
    private readonly producer: KafkaProducerService,
    @Optional() private readonly idempotency?: DurableEventIdempotencyService,
  ) {
    this.kafka = new Kafka({
      clientId: this.options.clientId,
      brokers: this.options.brokers,
    });
    this.groupId = this.options.groupId || `${this.options.clientId}-group`;
    this.maxAttempts = this.options.maxHandlerAttempts ?? DEFAULT_MAX_HANDLER_ATTEMPTS;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new RangeError('maxHandlerAttempts must be a positive integer');
    }
    this.consumer = this.kafka.consumer({ groupId: this.groupId });
  }

  async onModuleInit() {
    await this.consumer.connect();
    this.logger.log(`Kafka Consumer connected for ${this.options.clientId}`);
  }

  async onModuleDestroy() {
    await this.consumer.disconnect();
  }

  async subscribe<T>(topic: string, eventType: string, handler: MessageHandler<T>) {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Map());
      await this.ensureTopics([topic, deadLetterTopic(topic)]);
      await this.consumer.subscribe({ topic, fromBeginning: false });
    }
    this.handlers.get(topic)!.set(eventType, handler);
  }

  async start() {
    if (!this.idempotency) {
      this.logger.warn(
        `${this.groupId} has no durable idempotency: redelivered events are only skipped until this process restarts`,
      );
    }
    await this.consumer.run({
      autoCommit: false, // Manual offset commit
      eachMessage: (payload) => this.handleMessage(payload),
    });
  }

  /**
   * One message, start to finish. The offset is committed only once the event is handled,
   * already handled, or safely in the dead-letter topic. Anything that throws out of here (Redis or
   * the dead-letter send failing) leaves the offset uncommitted, so kafkajs redelivers it.
   */
  private async handleMessage({ topic, partition, message }: EachMessagePayload) {
    if (!message.value) {
      await this.commitOffset(topic, partition, message.offset);
      return;
    }

    const event = parseEvent(message.value);
    if (!event) {
      this.logger.error(`Unparseable message at ${topic}[${partition}]@${message.offset}; dead-lettering it`);
      await this.deadLetter(topic, partition, message, 'unparseable', 'Not a JSON event with eventId and eventType');
      await this.commitOffset(topic, partition, message.offset);
      return;
    }

    const handler = this.handlers.get(topic)?.get(event.eventType);
    if (!handler) {
      await this.commitOffset(topic, partition, message.offset);
      return;
    }

    const claim = await this.claim(event.eventId);
    if (claim.status === 'processed') {
      this.logger.log(`Event ${event.eventId} already processed by ${this.groupId}, skipping`);
      await this.commitOffset(topic, partition, message.offset);
      return;
    }

    const failure = await this.runWithRetries(handler, event);
    if (!failure) {
      await this.markProcessed(event.eventId, claim.leaseToken);
      await this.commitOffset(topic, partition, message.offset);
      return;
    }

    this.logger.error(`Exhausted retries for event ${event.eventId} (${event.eventType}); dead-lettering it`, failure);
    await this.deadLetter(topic, partition, message, 'handler-failed', errorMessage(failure));
    // Not marked processed: a replay from the dead-letter topic must be able to run it again.
    await this.release(event.eventId, claim.leaseToken);
    await this.commitOffset(topic, partition, message.offset);
  }

  private async runWithRetries(handler: MessageHandler<unknown>, event: BaseEvent<unknown>): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        await handler(event);
        return undefined;
      } catch (error) {
        this.logger.warn(`Failed to process event ${event.eventId}, attempt ${attempt}/${this.maxAttempts}`, error);
        if (attempt >= this.maxAttempts) return error ?? new Error('Handler failed');
        // Exponential backoff
        await sleep(Math.pow(2, attempt) * 100);
      }
    }
  }

  /**
   * Claims the event for this consumer group. If another consumer holds it (a rebalance while it
   * was mid-handler), wait for it to finish or for its lease to expire; the partition stays blocked
   * meanwhile, which keeps per-order ordering.
   */
  private async claim(eventId: string): Promise<Claim> {
    if (!this.idempotency) {
      return this.processedInMemory.has(eventId) ? { status: 'processed' } : { status: 'acquired' };
    }
    const deadline = Date.now() + CLAIM_WAIT_MS;
    for (;;) {
      const result = await this.idempotency.tryAcquire(this.groupId, eventId);
      if (result.status !== 'in-progress') return result;
      if (Date.now() >= deadline) {
        throw new Error(`Event ${eventId} is still being processed by another ${this.groupId} consumer`);
      }
      await sleep(CLAIM_POLL_MS);
    }
  }

  private async markProcessed(eventId: string, leaseToken?: string) {
    if (!this.idempotency || !leaseToken) {
      this.processedInMemory.add(eventId);
      return;
    }
    const ownedLease = await this.idempotency.markProcessed(this.groupId, eventId, leaseToken);
    if (!ownedLease) {
      this.logger.warn(`Lease on event ${eventId} expired while handling it; it may have been handled twice`);
    }
  }

  private async release(eventId: string, leaseToken?: string) {
    if (this.idempotency && leaseToken) {
      await this.idempotency.release(this.groupId, eventId, leaseToken);
    }
  }

  private async deadLetter(
    topic: string,
    partition: number,
    message: EachMessagePayload['message'],
    reason: DeadLetterReason,
    error: string,
  ) {
    const headers: IHeaders = {
      ...message.headers,
      [DEAD_LETTER_HEADERS.originalTopic]: topic,
      [DEAD_LETTER_HEADERS.originalPartition]: String(partition),
      [DEAD_LETTER_HEADERS.originalOffset]: message.offset,
      [DEAD_LETTER_HEADERS.consumerGroup]: this.groupId,
      [DEAD_LETTER_HEADERS.reason]: reason,
      [DEAD_LETTER_HEADERS.error]: error.slice(0, 1000),
      [DEAD_LETTER_HEADERS.failedAt]: new Date().toISOString(),
    };
    await this.producer.send(deadLetterTopic(topic), [{ key: message.key, value: message.value, headers }]);
  }

  /**
   * Topics are otherwise only auto-created when first produced to. On a fresh cluster a consumer
   * that subscribes before any producer has written (e.g. driver-service to delivery.events) gets
   * "This server does not host this topic-partition" and the service crashes on boot. Creating the
   * topic first is idempotent (resolves false when it already exists) and waits for a leader.
   */
  private async ensureTopics(topics: string[]) {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      await admin.createTopics({ topics: topics.map((topic) => ({ topic })), waitForLeaders: true });
    } finally {
      await admin.disconnect();
    }
  }

  private async commitOffset(topic: string, partition: number, offset: string) {
    await this.consumer.commitOffsets([{ topic, partition, offset: (BigInt(offset) + 1n).toString() }]);
  }
}

function parseEvent(value: Buffer): BaseEvent<unknown> | null {
  try {
    const event = JSON.parse(value.toString());
    if (typeof event?.eventId !== 'string' || !event.eventId || typeof event.eventType !== 'string') {
      return null;
    }
    return event;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
