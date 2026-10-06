import { NotificationsService } from './notifications.service';
import { NotificationsRepository } from '../repositories/notifications.repository';
import {
  DeliveryEventType,
  KafkaConsumerService,
  NotFoundError,
  OrderEventType,
  OrderStatus,
  PaymentEventType,
  TOPICS,
} from '@food-delivery/shared';
import { Notification, NotificationType } from '../entities/notification.entity';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let repository: jest.Mocked<NotificationsRepository>;
  let kafkaConsumer: jest.Mocked<KafkaConsumerService>;

  beforeEach(() => {
    repository = {
      create: jest.fn(),
      findByUserId: jest.fn(),
      markAsReadForUser: jest.fn(),
      markAllAsRead: jest.fn(),
    } as unknown as jest.Mocked<NotificationsRepository>;

    kafkaConsumer = {
      subscribe: jest.fn().mockResolvedValue(undefined),
      start: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<KafkaConsumerService>;

    service = new NotificationsService(repository, kafkaConsumer);
  });

  describe('onModuleInit', () => {
    it('subscribes to the order, payment, and delivery events and starts the consumer', async () => {
      await service.onModuleInit();

      expect(kafkaConsumer.subscribe).toHaveBeenCalledTimes(5);
      expect(kafkaConsumer.subscribe).toHaveBeenNthCalledWith(
        1,
        TOPICS.ORDER_EVENTS,
        OrderEventType.CONFIRMED,
        expect.any(Function),
      );
      expect(kafkaConsumer.subscribe).toHaveBeenNthCalledWith(
        2,
        TOPICS.PAYMENT_EVENTS,
        PaymentEventType.COMPLETED,
        expect.any(Function),
      );
      expect(kafkaConsumer.subscribe.mock.calls.slice(2).map(([topic, type]) => [topic, type])).toEqual([
        [TOPICS.DELIVERY_EVENTS, DeliveryEventType.DRIVER_ASSIGNED],
        [TOPICS.DELIVERY_EVENTS, DeliveryEventType.PICKED_UP],
        [TOPICS.DELIVERY_EVENTS, DeliveryEventType.COMPLETED],
      ]);
      expect(kafkaConsumer.start).toHaveBeenCalledTimes(1);
    });

    it('creates an order-confirmed notification when the subscribed event fires', async () => {
      const createdNotification = {
        id: 'notification-1',
        userId: 'customer-1',
        type: NotificationType.ORDER_CONFIRMED,
        title: 'Order Confirmed',
        message: 'Your order order-42 has been confirmed.',
        isRead: false,
        createdAt: new Date(),
      } as Notification;

      repository.create.mockResolvedValue(createdNotification);

      await service.onModuleInit();

      const orderConfirmedHandler = kafkaConsumer.subscribe.mock.calls[0][2];
      await orderConfirmedHandler({
        eventId: 'event-1',
        eventType: OrderEventType.CONFIRMED,
        correlationId: 'corr-1',
        timestamp: new Date().toISOString(),
        payload: {
          orderId: 'order-42',
          customerId: 'customer-1',
          restaurantId: 'restaurant-9',
          total: 24.5,
          status: OrderStatus.CONFIRMED,
        },
      });

      expect(repository.create).toHaveBeenCalledWith(
        'customer-1',
        NotificationType.ORDER_CONFIRMED,
        'Order Confirmed',
        'Your order order-42 has been confirmed.',
      );
    });
  });

  describe('payment and delivery notifications (#5)', () => {
    const handlerFor = (eventType: string) => {
      const call = kafkaConsumer.subscribe.mock.calls.find(([, type]) => type === eventType);
      if (!call) throw new Error(`no handler for ${eventType}`);
      return call[2] as (event: unknown) => Promise<void>;
    };
    const event = (eventType: string, payload: Record<string, unknown>) => ({
      eventId: `event-${eventType}`,
      eventType,
      correlationId: 'corr-1',
      timestamp: new Date().toISOString(),
      payload,
    });

    beforeEach(async () => {
      repository.create.mockResolvedValue({} as Notification);
      await service.onModuleInit();
    });

    it('notifies the paying customer when the payment completes', async () => {
      await handlerFor(PaymentEventType.COMPLETED)(
        event(PaymentEventType.COMPLETED, { paymentId: 'p1', orderId: 'order-42', customerId: 'customer-1', amount: 24.5, status: 'COMPLETED' }),
      );

      expect(repository.create).toHaveBeenCalledWith(
        'customer-1',
        NotificationType.PAYMENT_COMPLETED,
        'Payment Received',
        'We received your payment for order order-42.',
      );
    });

    it.each([
      [DeliveryEventType.DRIVER_ASSIGNED, NotificationType.DRIVER_ASSIGNED, 'Driver Assigned', 'A driver is on the way to pick up your order order-42.'],
      [DeliveryEventType.PICKED_UP, NotificationType.PICKED_UP, 'Order Picked Up', 'Your order order-42 has been picked up and is on its way.'],
      [DeliveryEventType.COMPLETED, NotificationType.DELIVERED, 'Order Delivered', 'Your order order-42 has been delivered. Enjoy!'],
    ])('notifies the customer on %s', async (eventType, type, title, message) => {
      await handlerFor(eventType)(event(eventType, { deliveryId: 'd1', orderId: 'order-42', customerId: 'customer-1', status: 'X' }));

      expect(repository.create).toHaveBeenCalledWith('customer-1', type, title, message);
    });

    it.each([PaymentEventType.COMPLETED, DeliveryEventType.DRIVER_ASSIGNED, DeliveryEventType.PICKED_UP, DeliveryEventType.COMPLETED])(
      'skips %s without a customerId instead of notifying anyone (older events)',
      async (eventType) => {
        await handlerFor(eventType)(event(eventType, { orderId: 'order-42', status: 'X' }));

        expect(repository.create).not.toHaveBeenCalled();
      },
    );

    it('does not notify on delivery.created or delivery.in_transit', () => {
      const subscribed = kafkaConsumer.subscribe.mock.calls.map(([, type]) => type);
      expect(subscribed).not.toContain(DeliveryEventType.CREATED);
      expect(subscribed).not.toContain(DeliveryEventType.IN_TRANSIT);
    });
  });

  describe('createNotification', () => {
    it('persists the notification record with the given user and message', async () => {
      const createdNotification = {
        id: 'notification-2',
        userId: 'customer-2',
        type: NotificationType.DELIVERED,
        title: 'Delivered',
        message: 'Your order is here.',
        isRead: false,
        createdAt: new Date(),
      } as Notification;

      repository.create.mockResolvedValue(createdNotification);

      const result = await service.createNotification(
        'customer-2',
        NotificationType.DELIVERED,
        'Delivered',
        'Your order is here.',
      );

      expect(repository.create).toHaveBeenCalledWith(
        'customer-2',
        NotificationType.DELIVERED,
        'Delivered',
        'Your order is here.',
      );
      expect(result).toBe(createdNotification);
    });
  });

  describe('listForUser', () => {
    it('applies pagination and computes total pages from the repository result', async () => {
      repository.findByUserId.mockResolvedValue([
        [
          { id: 'n1' },
          { id: 'n2' },
          { id: 'n3' },
        ] as Notification[],
        25,
      ]);

      const result = await service.listForUser('customer-3', 2, 10);

      expect(repository.findByUserId).toHaveBeenCalledWith('customer-3', 10, 10);
      expect(result).toEqual({
        items: [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }],
        page: 2,
        limit: 10,
        total: 25,
        totalPages: 3,
      });
    });
  });

  describe('markAsRead and markAllAsRead', () => {
    it("marks the caller's own notification as read", async () => {
      repository.markAsReadForUser.mockResolvedValue(true);
      await service.markAsRead('notification-9', 'customer-4');
      expect(repository.markAsReadForUser).toHaveBeenCalledWith('notification-9', 'customer-4');
    });

    it("404s for another user's notification (and nothing is updated for them)", async () => {
      repository.markAsReadForUser.mockResolvedValue(false);
      await expect(service.markAsRead('notification-9', 'intruder')).rejects.toThrow(NotFoundError);
    });

    it('marks all unread notifications for a user as read', async () => {
      await service.markAllAsRead('customer-4');
      expect(repository.markAllAsRead).toHaveBeenCalledWith('customer-4');
    });
  });
});
