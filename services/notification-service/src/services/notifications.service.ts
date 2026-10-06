import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { NotificationsRepository } from '../repositories/notifications.repository';
import { NotFoundError, PaginatedResult, KafkaConsumerService, TOPICS, OrderEventType, OrderEvent, PaymentEventType, PaymentEvent, DeliveryEventType, DeliveryEvent } from '@food-delivery/shared';
import { Notification, NotificationType } from '../entities/notification.entity';

/** Delivery stages that notify the customer: (event, notification type, title, message). */
const DELIVERY_NOTIFICATIONS: Array<[DeliveryEventType, NotificationType, string, (orderId: string) => string]> = [
  [DeliveryEventType.DRIVER_ASSIGNED, NotificationType.DRIVER_ASSIGNED, 'Driver Assigned', (id) => `A driver is on the way to pick up your order ${id}.`],
  [DeliveryEventType.PICKED_UP, NotificationType.PICKED_UP, 'Order Picked Up', (id) => `Your order ${id} has been picked up and is on its way.`],
  [DeliveryEventType.COMPLETED, NotificationType.DELIVERED, 'Order Delivered', (id) => `Your order ${id} has been delivered. Enjoy!`],
];

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly kafkaConsumer: KafkaConsumerService,
  ) {}

  async onModuleInit() {
    await this.kafkaConsumer.subscribe<OrderEvent['payload']>(
      TOPICS.ORDER_EVENTS,
      OrderEventType.CONFIRMED,
      async (event) => {
        await this.createNotification(
          event.payload.customerId,
          NotificationType.ORDER_CONFIRMED,
          'Order Confirmed',
          `Your order ${event.payload.orderId} has been confirmed.`,
        );
      },
    );

    await this.kafkaConsumer.subscribe<PaymentEvent['payload']>(
      TOPICS.PAYMENT_EVENTS,
      PaymentEventType.COMPLETED,
      async (event) => {
        await this.notifyCustomer(event.payload.customerId, event, NotificationType.PAYMENT_COMPLETED, 'Payment Received',
          `We received your payment for order ${event.payload.orderId}.`);
      },
    );

    // Delivery events: one notification per stage the customer sees. delivery.created (a driver is being
    // found) and delivery.in_transit (no matching notification type) are not notified.
    for (const [eventType, type, title, message] of DELIVERY_NOTIFICATIONS) {
      await this.kafkaConsumer.subscribe<DeliveryEvent['payload']>(TOPICS.DELIVERY_EVENTS, eventType, async (event) => {
        await this.notifyCustomer(event.payload.customerId, event, type, title, message(event.payload.orderId));
      });
    }

    await this.kafkaConsumer.start();
  }

  /**
   * Notifies the customer named in the event. Events without a customerId (published before payment and
   * delivery events carried one) are skipped with a warning rather than guessed: a notification must
   * never reach the wrong user. Redelivered events are dropped earlier by durable idempotency (eventId).
   */
  private async notifyCustomer(
    customerId: string | undefined,
    event: { eventId: string; eventType: string },
    type: NotificationType,
    title: string,
    message: string,
  ): Promise<void> {
    if (!customerId) {
      this.logger.warn(`Not notifying for ${event.eventType} ${event.eventId}: the event has no customerId`);
      return;
    }
    await this.createNotification(customerId, type, title, message);
  }

  async createNotification(userId: string, type: NotificationType, title: string, message: string): Promise<Notification> {
    return this.notifications.create(userId, type, title, message);
  }

  async listForUser(userId: string, page: number, limit: number): Promise<PaginatedResult<Notification>> {
    const offset = (page - 1) * limit;
    const [items, total] = await this.notifications.findByUserId(userId, limit, offset);
    return { items, page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
  }

  /** 404 (not 403) for someone else's notification, so ids can't be probed for existence. */
  async markAsRead(id: string, userId: string): Promise<void> {
    const updated = await this.notifications.markAsReadForUser(id, userId);
    if (!updated) {
      throw new NotFoundError(`Notification ${id} not found`);
    }
  }

  async markAllAsRead(userId: string): Promise<void> {
    await this.notifications.markAllAsRead(userId);
  }
}
