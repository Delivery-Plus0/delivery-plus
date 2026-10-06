import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DeliveryEvent, DeliveryEventType, KafkaConsumerService, TOPICS } from '@food-delivery/shared';
import { TrackingEventsBus } from '../common/tracking-events.bus';

/**
 * Turns delivery lifecycle events (Kafka, published by delivery-service through its outbox) into
 * realtime triggers for that delivery's tracking subscribers (#135): driver assigned or reassigned,
 * picked up, in transit, delivered, cancelled. One consumer group for the service, so each event is
 * handled once and fanned out to every instance through Redis. A duplicate only causes one extra
 * recompute, whose unchanged result is not resent.
 */
@Injectable()
export class DeliveryEventsBridge implements OnModuleInit {
  private readonly logger = new Logger(DeliveryEventsBridge.name);

  constructor(
    private readonly kafkaConsumer: KafkaConsumerService,
    private readonly events: TrackingEventsBus,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const eventType of Object.values(DeliveryEventType)) {
      await this.kafkaConsumer.subscribe<DeliveryEvent['payload']>(TOPICS.DELIVERY_EVENTS, eventType, (event) =>
        this.handle(event.payload),
      );
    }
    await this.kafkaConsumer.start();
  }

  async handle(payload: Pick<DeliveryEvent['payload'], 'deliveryId'>): Promise<void> {
    if (!payload?.deliveryId) {
      this.logger.warn('tracking.bridge.skipped delivery event without deliveryId');
      return;
    }
    await this.events.publishDeliveryChanged(payload.deliveryId);
  }
}
