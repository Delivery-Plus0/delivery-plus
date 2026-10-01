import { KafkaConsumerService } from './kafka-consumer.service';

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
  commitOffsets: jest.fn(),
};

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({ admin: () => admin, consumer: () => consumer })),
}));

describe('KafkaConsumerService.subscribe', () => {
  beforeEach(() => jest.clearAllMocks());

  const service = () => new KafkaConsumerService({ clientId: 'driver-service', brokers: ['kafka:29092'] });

  it('creates the topic before subscribing (fresh cluster: nobody has produced to it yet)', async () => {
    await service().subscribe('delivery.events', 'delivery.completed', jest.fn());

    expect(admin.createTopics).toHaveBeenCalledWith({ topics: [{ topic: 'delivery.events' }], waitForLeaders: true });
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
