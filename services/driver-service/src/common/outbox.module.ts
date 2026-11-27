import { Global, Injectable, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { KafkaProducerService, OutboxRelay } from '@food-delivery/shared';

/**
 * Publishes the events this service stages in its outbox (#98), today the staff audit events (#213).
 * Started once the app (and the Kafka producer) is up; `kick()` after a commit publishes right away
 * instead of at the next poll. While Kafka is down, events wait in the table.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly relay: OutboxRelay;

  constructor(@InjectDataSource() dataSource: DataSource, producer: KafkaProducerService) {
    this.relay = new OutboxRelay(dataSource, (topic, event) => producer.publish(topic, event), {
      lockName: 'driver-service-outbox',
      intervalMs: Number(process.env.OUTBOX_RELAY_INTERVAL_MS) || 500,
    });
  }

  onApplicationBootstrap(): void {
    this.relay.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.relay.stop();
  }

  kick(): void {
    this.relay.kick();
  }
}

/** Global so any feature module can kick the relay after a commit that staged an event. */
@Global()
@Module({
  providers: [OutboxRelayService],
  exports: [OutboxRelayService],
})
export class OutboxModule {}
