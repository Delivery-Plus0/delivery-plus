import { KafkaConsumerService } from './kafka-consumer.service';
import { KafkaModule } from './kafka.module';
import { KafkaProducerService } from './kafka-producer.service';

describe('KafkaModule (#213)', () => {
  it('registers a producer only, and no consumer group, for producerOnly services', () => {
    const module = KafkaModule.register({ clientId: 'auth-service', brokers: ['kafka:9092'], producerOnly: true });
    expect(module.providers).toContain(KafkaProducerService);
    expect(module.providers).not.toContain(KafkaConsumerService);
    expect(module.exports).toEqual([KafkaProducerService]);
  });

  it('keeps the consumer by default', () => {
    const module = KafkaModule.register({ clientId: 'order-service', brokers: ['kafka:9092'] });
    expect(module.providers).toContain(KafkaConsumerService);
  });
});
