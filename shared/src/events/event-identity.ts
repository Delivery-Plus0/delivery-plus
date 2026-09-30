import { v5 as uuidv5 } from 'uuid';
import { BaseEvent } from './base-event';

const LIFECYCLE_EVENT_NAMESPACE = '43b91be0-b664-46b4-99f0-e52f107a8f5c';

/**
 * Deterministic eventId for an entity's lifecycle event: the same (entity, event type) always
 * yields the same id, so a re-published event is deduplicated by consumers instead of being handled
 * twice. Only valid for one-way lifecycles (orders, deliveries), where each event type happens at
 * most once per entity.
 */
export function lifecycleEventId(entityId: string, eventType: string): string {
  return uuidv5(`${entityId}:${eventType}`, LIFECYCLE_EVENT_NAMESPACE);
}

/**
 * Kafka message key. Every order, payment and delivery event carries the orderId, so keying by it
 * puts all events about one order on the same partition, in publish order. Events without an
 * orderId fall back to their correlationId.
 */
export function eventPartitionKey(event: BaseEvent<unknown>): string {
  const payload = event.payload as { orderId?: unknown } | null | undefined;
  return typeof payload?.orderId === 'string' && payload.orderId.length > 0
    ? payload.orderId
    : event.correlationId;
}
