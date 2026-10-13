import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { KafkaConsumerService, OrderEvent, OrderEventType, TOPICS } from '@food-delivery/shared';
import { PaymentsService } from './payments.service';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/** How many payments one sweep finishes. */
const SWEEP_BATCH = 50;

/**
 * The background half of #56 (docs/business/cancellation-and-refunds.md):
 *
 * - On `order.cancelled`: refund the order's payment if it collected money. The handler is
 *   idempotent in the database (row lock + one refund per payment), so redeliveries and dead-letter
 *   replays are safe even without durable consumer idempotency here.
 * - Every PAYMENT_SIDE_EFFECTS_SWEEP_MS:
 *   - #18: settle payments abandoned in PROCESSING for PAYMENT_PROCESSING_ABANDON_MS as not charged;
 *   - finish events and order updates a failed or crashed request left owed, e.g. a refund event that
 *     could not be published while another request held the lease.
 */
@Injectable()
export class RefundWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefundWorkerService.name);
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly payments: PaymentsService,
    private readonly kafkaConsumer: KafkaConsumerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.kafkaConsumer.subscribe<OrderEvent['payload']>(TOPICS.ORDER_EVENTS, OrderEventType.CANCELLED, async (event) => {
      await this.payments.refundCancelledOrder({
        orderId: event.payload.orderId,
        cancelledBy: event.payload.cancelledBy,
        cancellationReason: event.payload.cancellationReason,
        source: `order.cancelled:${event.eventId}`,
      });
    });
    await this.kafkaConsumer.start();

    if (this.config.sideEffectsSweepMs > 0) {
      this.sweepTimer = setInterval(() => void this.sweep(), this.config.sideEffectsSweepMs);
      this.sweepTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      // #18 first: a payment it recovers then owes its side effects, which the next step finishes.
      const recovered = await this.payments.recoverAbandonedProcessing(this.config.processingAbandonMs, SWEEP_BATCH);
      if (recovered > 0) this.logger.warn(`Recovered ${recovered} payment(s) abandoned in PROCESSING`);
      const finished = await this.payments.finishOwedSideEffects(this.config.sideEffectsSweepMs, SWEEP_BATCH);
      if (finished > 0) this.logger.log(`Finished owed side effects for ${finished} payment(s)`);
    } catch (error) {
      this.logger.error('Payment side-effects sweep failed; will retry on the next tick', error as Error);
    } finally {
      this.sweeping = false;
    }
  }
}
