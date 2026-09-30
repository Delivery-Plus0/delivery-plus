import { eventPartitionKey, lifecycleEventId } from './event-identity';

describe('lifecycleEventId', () => {
  it('is stable for the same entity and event type (re-publish dedupes downstream)', () => {
    expect(lifecycleEventId('order-1', 'order.confirmed')).toBe(lifecycleEventId('order-1', 'order.confirmed'));
  });

  it('differs per entity and per event type', () => {
    const id = lifecycleEventId('order-1', 'order.confirmed');
    expect(lifecycleEventId('order-2', 'order.confirmed')).not.toBe(id);
    expect(lifecycleEventId('order-1', 'order.preparing')).not.toBe(id);
  });

  it('is a UUID', () => {
    expect(lifecycleEventId('d-1', 'delivery.picked_up')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('eventPartitionKey', () => {
  const base = { eventId: 'e', eventType: 't', timestamp: 'now', correlationId: 'corr-1' };

  it('keys by orderId so one order stays on one partition', () => {
    expect(eventPartitionKey({ ...base, payload: { orderId: 'order-1', deliveryId: 'd-1' } })).toBe('order-1');
  });

  it('falls back to the correlationId when there is no orderId', () => {
    expect(eventPartitionKey({ ...base, payload: { userId: 'u-1' } })).toBe('corr-1');
    expect(eventPartitionKey({ ...base, payload: { orderId: '' } })).toBe('corr-1');
    expect(eventPartitionKey({ ...base, payload: null })).toBe('corr-1');
  });
});
