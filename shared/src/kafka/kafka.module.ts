import { Module, DynamicModule, Global, Provider } from '@nestjs/common';
import { KafkaProducerService } from './kafka-producer.service';
import { KafkaConsumerService } from './kafka-consumer.service';
import { DurableEventIdempotencyService } from './durable-event-idempotency.service';

export interface KafkaModuleOptions {
  clientId: string;
  brokers: string[];
  groupId?: string;
  /**
   * Record handled events in Redis (per consumer group) so redeliveries after a restart or
   * rebalance are skipped. Requires RedisModule to be registered in the same application.
   */
  durableIdempotency?: boolean;
  /** Attempts per event before it is dead-lettered (default 3, exponential backoff between them). */
  maxHandlerAttempts?: number;
  /**
   * Publish only (#213: services whose outbox relays admin audit events). No consumer is created,
   * so the service joins no consumer group.
   */
  producerOnly?: boolean;
}

@Global()
@Module({})
export class KafkaModule {
  static register(options: KafkaModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: 'KAFKA_OPTIONS',
        useValue: options,
      },
      KafkaProducerService,
    ];
    if (!options.producerOnly) {
      providers.push(KafkaConsumerService);
    }
    if (options.durableIdempotency) {
      providers.push(DurableEventIdempotencyService);
    }
    return {
      module: KafkaModule,
      providers,
      exports: options.producerOnly ? [KafkaProducerService] : [KafkaProducerService, KafkaConsumerService],
    };
  }
}
