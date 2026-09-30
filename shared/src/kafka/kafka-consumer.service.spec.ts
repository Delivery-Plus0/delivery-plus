import { EachMessagePayload } from 'kafkajs';
import { DEAD_LETTER_HEADERS, KafkaConsumerService } from './kafka-consumer.service';
import { KafkaProducerService } from './kafka-producer.service';
import { DurableEventIdempotencyService } from './durable-event-idempotency.service';

const admin = {
  connect: jest.fn().mockResolvedValue(undefined),
  createTopics: jest.fn().mockResolvedValue(true),
  disconnect: jest.fn().mockResolvedValue(undefined),
};
const consumer = {
  connect: jest.fn(),
  disconnect: jest.fn(),
  subscribe: jest.fn().mockResolvedValue(undefined),
  run: jest.fn(),
  commitOffsets: jest.fn().mockResolvedValue(undefined),
};

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({ admin: () => admin, consumer: () => consumer })),
}));

const options = { clientId: 'order-service', brokers: ['kafka:29092'], groupId: 'order-service-group' };

function producerMock() {
  return { send: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaProducerService & { send: jest.Mock };
}

function idempotencyMock() {
  return {
    tryAcquire: jest.fn().mockResolvedValue({ status: 'acquired', leaseToken: 'lease-1' }),
    markProcessed: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(true),
  } as unknown as DurableEventIdempotencyService & Record<'tryAcquire' | 'markProcessed' | 'release', jest.Mock>;
}

function message(value: unknown, offset = '41'): EachMessagePayload {
  return {
    topic: 'order.events',
    partition: 0,
    message: {
      key: Buffer.from('order-1'),
      value: value === null ? null : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
      offset,
      headers: { 'x-trace': 'abc' },
    },
  } as unknown as EachMessagePayload;
}

const event = {
  eventId: 'evt-1',
  eventType: 'order.confirmed',
  timestamp: '2026-10-01T00:00:00.000Z',
  correlationId: 'corr-1',
  payload: { orderId: 'order-1' },
};

/** Subscribes a handler, starts the consumer and returns the eachMessage callback kafkajs would call. */
async function startWith(
  handler: jest.Mock,
  deps: { producer?: KafkaProducerService; idempotency?: DurableEventIdempotencyService } = {},
) {
  const service = new KafkaConsumerService(options, deps.producer ?? producerMock(), deps.idempotency);
  await service.subscribe('order.events', 'order.confirmed', handler);
  await service.start();
  return consumer.run.mock.calls[0][0].eachMessage as (payload: EachMessagePayload) => Promise<void>;
}

const committedAfter41 = [{ topic: 'order.events', partition: 0, offset: '42' }];

describe('KafkaConsumerService.subscribe', () => {
  beforeEach(() => jest.clearAllMocks());

  const service = () => new KafkaConsumerService(options, producerMock());

  it('creates the topic and its dead-letter topic before subscribing (fresh cluster)', async () => {
    await service().subscribe('delivery.events', 'delivery.completed', jest.fn());

    expect(admin.createTopics).toHaveBeenCalledWith({
      topics: [{ topic: 'delivery.events' }, { topic: 'delivery.events.dlq' }],
      waitForLeaders: true,
    });
    expect(admin.createTopics.mock.invocationCallOrder[0]).toBeLessThan(consumer.subscribe.mock.invocationCallOrder[0]);
    expect(admin.disconnect).toHaveBeenCalled();
  });

  it('treats an already-existing topic as fine (createTopics resolves false)', async () => {
    admin.createTopics.mockResolvedValueOnce(false);
    await expect(service().subscribe('order.events', 'order.confirmed', jest.fn())).resolves.toBeUndefined();
    expect(consumer.subscribe).toHaveBeenCalledWith({ topic: 'order.events', fromBeginning: false });
  });

  it('ensures and subscribes once per topic, even with several event handlers', async () => {
    const s = service();
    await s.subscribe('payment.events', 'payment.created', jest.fn());
    await s.subscribe('payment.events', 'payment.completed', jest.fn());

    expect(admin.createTopics).toHaveBeenCalledTimes(1);
    expect(consumer.subscribe).toHaveBeenCalledTimes(1);
  });

  it('disconnects the admin client even when topic creation fails', async () => {
    admin.createTopics.mockRejectedValueOnce(new Error('broker unavailable'));
    await expect(service().subscribe('delivery.events', 'x', jest.fn())).rejects.toThrow('broker unavailable');
    expect(admin.disconnect).toHaveBeenCalled();
  });
});

describe('KafkaConsumerService message handling', () => {
  beforeEach(() => jest.clearAllMocks());

  it('handles a new event, marks it processed for the group, then commits', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const idempotency = idempotencyMock();
    const eachMessage = await startWith(handler, { idempotency });

    await eachMessage(message(event));

    expect(idempotency.tryAcquire).toHaveBeenCalledWith('order-service-group', 'evt-1');
    expect(handler).toHaveBeenCalledWith(event);
    expect(idempotency.markProcessed).toHaveBeenCalledWith('order-service-group', 'evt-1', 'lease-1');
    expect(consumer.commitOffsets).toHaveBeenCalledWith(committedAfter41);
    expect(idempotency.markProcessed.mock.invocationCallOrder[0]).toBeLessThan(
      consumer.commitOffsets.mock.invocationCallOrder[0],
    );
  });

  it('skips an event the group already processed (redelivery after restart) and commits', async () => {
    const handler = jest.fn();
    const idempotency = idempotencyMock();
    idempotency.tryAcquire.mockResolvedValue({ status: 'processed' });
    const eachMessage = await startWith(handler, { idempotency });

    await eachMessage(message(event));

    expect(handler).not.toHaveBeenCalled();
    expect(consumer.commitOffsets).toHaveBeenCalledWith(committedAfter41);
  });

  it('waits while another consumer holds the event, then skips it once that consumer finished', async () => {
    const handler = jest.fn();
    const idempotency = idempotencyMock();
    idempotency.tryAcquire
      .mockResolvedValueOnce({ status: 'in-progress' })
      .mockResolvedValueOnce({ status: 'processed' });
    const eachMessage = await startWith(handler, { idempotency });

    await eachMessage(message(event));

    expect(idempotency.tryAcquire).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled();
    expect(consumer.commitOffsets).toHaveBeenCalledWith(committedAfter41);
  });

  it('does not commit when Redis is unavailable, so kafkajs redelivers the message', async () => {
    const handler = jest.fn();
    const idempotency = idempotencyMock();
    idempotency.tryAcquire.mockRejectedValue(new Error('ECONNREFUSED'));
    const eachMessage = await startWith(handler, { idempotency });

    await expect(eachMessage(message(event))).rejects.toThrow('ECONNREFUSED');
    expect(handler).not.toHaveBeenCalled();
    expect(consumer.commitOffsets).not.toHaveBeenCalled();
  });

  it('retries a failing handler and succeeds without dead-lettering', async () => {
    const handler = jest.fn().mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce(undefined);
    const producer = producerMock();
    const eachMessage = await startWith(handler, { producer, idempotency: idempotencyMock() });

    await eachMessage(message(event));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(producer.send).not.toHaveBeenCalled();
    expect(consumer.commitOffsets).toHaveBeenCalledWith(committedAfter41);
  });

  it('dead-letters after 3 failed attempts, releases the claim (replayable) and commits', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('order-service down'));
    const producer = producerMock();
    const idempotency = idempotencyMock();
    const eachMessage = await startWith(handler, { producer, idempotency });

    await eachMessage(message(event));

    expect(handler).toHaveBeenCalledTimes(3);
    expect(producer.send).toHaveBeenCalledTimes(1);
    const [topic, [dead]] = producer.send.mock.calls[0];
    expect(topic).toBe('order.events.dlq');
    expect(dead.key).toEqual(Buffer.from('order-1'));
    expect(JSON.parse(dead.value.toString())).toEqual(event);
    expect(dead.headers).toMatchObject({
      'x-trace': 'abc',
      [DEAD_LETTER_HEADERS.originalTopic]: 'order.events',
      [DEAD_LETTER_HEADERS.originalPartition]: '0',
      [DEAD_LETTER_HEADERS.originalOffset]: '41',
      [DEAD_LETTER_HEADERS.consumerGroup]: 'order-service-group',
      [DEAD_LETTER_HEADERS.reason]: 'handler-failed',
      [DEAD_LETTER_HEADERS.error]: 'order-service down',
    });
    expect(idempotency.markProcessed).not.toHaveBeenCalled();
    expect(idempotency.release).toHaveBeenCalledWith('order-service-group', 'evt-1', 'lease-1');
    expect(producer.send.mock.invocationCallOrder[0]).toBeLessThan(consumer.commitOffsets.mock.invocationCallOrder[0]);
  });

  it('keeps the offset uncommitted when the dead-letter send fails, so nothing is lost', async () => {
    const handler = jest.fn().mockRejectedValue(new Error('boom'));
    const producer = producerMock();
    producer.send.mockRejectedValue(new Error('broker unavailable'));
    const eachMessage = await startWith(handler, { producer, idempotency: idempotencyMock() });

    await expect(eachMessage(message(event))).rejects.toThrow('broker unavailable');
    expect(consumer.commitOffsets).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['JSON without an eventId', JSON.stringify({ eventType: 'order.confirmed', payload: {} })],
  ])('dead-letters an unparseable message (%s) without calling handlers', async (_label, raw) => {
    const handler = jest.fn();
    const producer = producerMock();
    const idempotency = idempotencyMock();
    const eachMessage = await startWith(handler, { producer, idempotency });

    await eachMessage(message(raw));

    expect(handler).not.toHaveBeenCalled();
    expect(idempotency.tryAcquire).not.toHaveBeenCalled();
    expect(producer.send.mock.calls[0][0]).toBe('order.events.dlq');
    expect(producer.send.mock.calls[0][1][0].headers[DEAD_LETTER_HEADERS.reason]).toBe('unparseable');
    expect(consumer.commitOffsets).toHaveBeenCalledWith(committedAfter41);
  });

  it('commits events nobody in this group handles without touching Redis', async () => {
    const idempotency = idempotencyMock();
    const eachMessage = await startWith(jest.fn(), { idempotency });

    await eachMessage(message({ ...event, eventType: 'order.preparing' }));

    expect(idempotency.tryAcquire).not.toHaveBeenCalled();
    expect(consumer.commitOffsets).toHaveBeenCalledWith(committedAfter41);
  });

  it('without durable idempotency, still skips a redelivery within the same process', async () => {
    const handler = jest.fn().mockResolvedValue(undefined);
    const eachMessage = await startWith(handler);

    await eachMessage(message(event, '41'));
    await eachMessage(message(event, '42'));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(consumer.commitOffsets).toHaveBeenCalledTimes(2);
  });
});
