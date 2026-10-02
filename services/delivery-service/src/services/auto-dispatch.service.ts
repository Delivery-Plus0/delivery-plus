import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  BadRequestError,
  ConflictError,
  DeliveryStatus,
  InvalidStateTransitionError,
  KafkaConsumerService,
  OrderEvent,
  OrderEventType,
  TOPICS,
  UserRole,
} from '@food-delivery/shared';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { DeliveriesService, DeliveryRequester } from './deliveries.service';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/** Acts with dispatch rights (ADMIN), like a restaurant owner pressing "dispatch", but for every order. */
const AUTO_DISPATCHER: DeliveryRequester = { userId: 'system:auto-dispatch', role: UserRole.ADMIN, authHeader: '' };

/** How many waiting deliveries one sweep tries to assign. */
const SWEEP_BATCH = 20;

/**
 * Dispatches orders without anyone calling the API.
 *
 * - On `order.ready_for_pickup`: create the delivery (if the order has none) and assign a driver,
 *   through the same create/assign paths as a manual dispatch.
 * - No driver free: the delivery stays CREATED. The event is handled, not retried or dead-lettered.
 *   A periodic sweep (AUTO_DISPATCH_SWEEP_MS, default 15 s) assigns waiting deliveries, oldest
 *   first, once drivers come online.
 *
 * Safe against duplicates and races: events are deduplicated per consumer group (durable
 * idempotency), `deliveries.orderId` is unique (a concurrent manual create gets 409), the delivery
 * transition is compare-and-set, and the driver claim is exclusive (#33).
 */
@Injectable()
export class AutoDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutoDispatchService.name);
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly deliveriesService: DeliveriesService,
    private readonly deliveries: DeliveriesRepository,
    private readonly kafkaConsumer: KafkaConsumerService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.kafkaConsumer.subscribe<OrderEvent['payload']>(
      TOPICS.ORDER_EVENTS,
      OrderEventType.READY_FOR_PICKUP,
      async (event) => {
        await this.dispatchOrder(event.payload.orderId);
      },
    );
    await this.kafkaConsumer.start();

    if (this.config.autoDispatchSweepMs > 0) {
      this.sweepTimer = setInterval(() => void this.sweep(), this.config.autoDispatchSweepMs);
      this.sweepTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** Makes sure the order has a delivery and tries to assign it. Safe to call repeatedly. */
  async dispatchOrder(orderId: string): Promise<void> {
    let delivery = await this.deliveries.findByOrderId(orderId);
    if (!delivery) {
      try {
        delivery = await this.deliveriesService.create(AUTO_DISPATCHER, { orderId });
      } catch (error) {
        if (error instanceof ConflictError) {
          // A manual dispatch created it first; continue with that delivery.
          delivery = await this.deliveries.findByOrderId(orderId);
        } else if (error instanceof BadRequestError) {
          // The order is no longer ready (e.g. cancelled before the event was handled): nothing to do.
          this.logger.warn(`Not dispatching order ${orderId}: ${error.message}`);
          return;
        } else {
          throw error;
        }
      }
    }
    if (delivery?.status === DeliveryStatus.CREATED) {
      await this.tryAssign(delivery.id);
    }
  }

  /** Assigns deliveries still waiting for a driver, oldest first; stops when no driver is free. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const waiting = await this.deliveries.findWaitingForDriver(SWEEP_BATCH);
      for (const delivery of waiting) {
        if (!(await this.tryAssign(delivery.id))) break;
      }
    } catch (error) {
      this.logger.error('Auto-dispatch sweep failed; will retry on the next tick', error as Error);
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * True when the delivery is assigned (now or by someone else), false when no driver is free.
   * Other failures propagate: the Kafka consumer retries them, the sweep logs them.
   */
  private async tryAssign(deliveryId: string): Promise<boolean> {
    try {
      await this.deliveriesService.assignDriver(deliveryId, AUTO_DISPATCHER);
      return true;
    } catch (error) {
      if (error instanceof ConflictError) {
        this.logger.log(`Delivery ${deliveryId} is waiting for a driver`);
        return false;
      }
      if (error instanceof InvalidStateTransitionError) {
        return true; // assigned or cancelled concurrently: nothing left to do for this one
      }
      throw error;
    }
  }
}
