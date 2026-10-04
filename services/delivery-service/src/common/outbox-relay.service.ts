import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { KafkaProducerService, OutboxRelay } from '@food-delivery/shared';

/**
 * Publishes delivery events staged in the outbox (#98). Started once the app (and the Kafka producer) is
 * up; `kick()` after a commit publishes right away instead of at the next poll.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly relay: OutboxRelay;

  constructor(@InjectDataSource() dataSource: DataSource, producer: KafkaProducerService) {
    this.relay = new OutboxRelay(dataSource, (topic, event) => producer.publish(topic, event), {
      lockName: 'delivery-service-outbox',
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
