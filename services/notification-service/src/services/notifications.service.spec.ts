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

      expect(kafkaConsumer.subscribe).toHaveBeenCalledTimes(3);
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
      expect(kafkaConsumer.subscribe).toHaveBeenNthCalledWith(
        3,
        TOPICS.DELIVERY_EVENTS,
        DeliveryEventType.DRIVER_ASSIGNED,
        expect.any(Function),
      );
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
