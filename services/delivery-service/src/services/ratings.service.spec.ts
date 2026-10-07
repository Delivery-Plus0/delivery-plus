import { ConflictError, DeliveryStatus, DriverStatus, ForbiddenError, NotFoundError, UserRole } from '@food-delivery/shared';
import { DriverServiceClient } from '../common/driver-service.client';
import { OrderServiceClient } from '../common/order-service.client';
import { Delivery } from '../entities/delivery.entity';
import { DeliveryRating } from '../entities/delivery-rating.entity';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { RatingsRepository } from '../repositories/ratings.repository';
import { RatingNotAllowedError, RatingsService } from './ratings.service';

const NOW = new Date('2026-10-07T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const customer = { userId: 'customer-1', role: UserRole.CUSTOMER };

const delivery = (overrides: Partial<Delivery> = {}): Delivery =>
  ({
    id: 'delivery-1',
    orderId: 'order-1',
    customerId: 'customer-1',
    driverId: 'driver-1',
    status: DeliveryStatus.DELIVERED,
    deliveredAt: new Date(NOW.getTime() - DAY),
    updatedAt: new Date(NOW.getTime() - DAY),
    ...overrides,
  }) as Delivery;

const stored = (overrides: Partial<DeliveryRating> = {}): DeliveryRating =>
  ({
    id: 'rating-1',
    deliveryId: 'delivery-1',
    driverId: 'driver-1',
    customerId: 'customer-1',
    score: 5,
    comment: 'Fast and friendly',
    createdAt: NOW,
    ...overrides,
  }) as DeliveryRating;

describe('RatingsService', () => {
  let deliveries: { findById: jest.Mock };
  let ratings: { findByDeliveryId: jest.Mock; create: jest.Mock; findSummary: jest.Mock; findRecentComments: jest.Mock };
  let orderClient: { getOrder: jest.Mock };
  let driverClient: { getOwnProfile: jest.Mock };
  let service: RatingsService;

  beforeEach(() => {
    deliveries = { findById: jest.fn().mockResolvedValue(delivery()) };
    ratings = {
      findByDeliveryId: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async (rating) => ({ id: 'rating-1', createdAt: NOW, ...rating })),
      findSummary: jest.fn().mockResolvedValue(null),
      findRecentComments: jest.fn().mockResolvedValue([]),
    };
    orderClient = { getOrder: jest.fn() };
    driverClient = { getOwnProfile: jest.fn().mockResolvedValue({ id: 'driver-1', userId: 'user-9', status: DriverStatus.AVAILABLE }) };
    service = new RatingsService(
      deliveries as unknown as DeliveriesRepository,
      ratings as unknown as RatingsRepository,
      orderClient as unknown as OrderServiceClient,
      driverClient as unknown as DriverServiceClient,
    );
  });

  describe('rate', () => {
    it("stores the rating for the delivery's driver, from the order's customer", async () => {
      const result = await service.rate('delivery-1', customer, { score: 4, comment: 'On time' }, NOW);

      expect(ratings.create).toHaveBeenCalledWith({
        deliveryId: 'delivery-1',
        driverId: 'driver-1',
        customerId: 'customer-1',
        score: 4,
        comment: 'On time',
      });
      expect(result).toEqual({ rating: { score: 4, comment: 'On time', createdAt: NOW }, created: true });
    });

    it('stores a blank comment as no comment', async () => {
      await service.rate('delivery-1', customer, { score: 5, comment: '' }, NOW);
      expect(ratings.create).toHaveBeenCalledWith(expect.objectContaining({ comment: null }));
    });

    it('404s for an unknown delivery', async () => {
      deliveries.findById.mockResolvedValue(null);
      await expect(service.rate('nope', customer, { score: 5 }, NOW)).rejects.toThrow(NotFoundError);
    });

    it("403s for another customer, and for roles that aren't customers", async () => {
      await expect(service.rate('delivery-1', { userId: 'customer-2', role: UserRole.CUSTOMER }, { score: 5 }, NOW)).rejects.toThrow(
        ForbiddenError,
      );
      await expect(service.rate('delivery-1', { userId: 'customer-1', role: UserRole.DRIVER }, { score: 5 }, NOW)).rejects.toThrow(
        ForbiddenError,
      );
      expect(ratings.create).not.toHaveBeenCalled();
    });

    it('asks order-service who the customer is for deliveries created before customerId was copied', async () => {
      deliveries.findById.mockResolvedValue(delivery({ customerId: null }));
      orderClient.getOrder.mockResolvedValue({ id: 'order-1', customerId: 'customer-1' });

      await expect(service.rate('delivery-1', customer, { score: 5 }, NOW)).resolves.toMatchObject({ created: true });
      expect(orderClient.getOrder).toHaveBeenCalledWith('order-1');
    });

    it.each([DeliveryStatus.CREATED, DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.PICKED_UP, DeliveryStatus.IN_TRANSIT, DeliveryStatus.CANCELLED])(
      '422s before delivery (%s)',
      async (status) => {
        deliveries.findById.mockResolvedValue(delivery({ status, deliveredAt: null }));
        await expect(service.rate('delivery-1', customer, { score: 5 }, NOW)).rejects.toThrow(RatingNotAllowedError);
        expect(ratings.create).not.toHaveBeenCalled();
      },
    );

    it('accepts a rating up to 14 days after delivery and 422s after that', async () => {
      deliveries.findById.mockResolvedValue(delivery({ deliveredAt: new Date(NOW.getTime() - 14 * DAY) }));
      await expect(service.rate('delivery-1', customer, { score: 5 }, NOW)).resolves.toMatchObject({ created: true });

      deliveries.findById.mockResolvedValue(delivery({ deliveredAt: new Date(NOW.getTime() - 14 * DAY - 1) }));
      await expect(service.rate('delivery-1', customer, { score: 5 }, NOW)).rejects.toThrow('Ratings close 14 days after delivery.');
    });

    it('uses the last update as the delivery time for deliveries finished before stage times existed', async () => {
      deliveries.findById.mockResolvedValue(delivery({ deliveredAt: null, updatedAt: new Date(NOW.getTime() - 20 * DAY) }));
      await expect(service.rate('delivery-1', customer, { score: 5 }, NOW)).rejects.toThrow(RatingNotAllowedError);
    });

    it('returns the stored rating for an identical retry, without storing it again', async () => {
      ratings.findByDeliveryId.mockResolvedValue(stored());

      const result = await service.rate('delivery-1', customer, { score: 5, comment: 'Fast and friendly' }, NOW);

      expect(result).toEqual({ rating: { score: 5, comment: 'Fast and friendly', createdAt: NOW }, created: false });
      expect(ratings.create).not.toHaveBeenCalled();
    });

    it('409s for a different second rating', async () => {
      ratings.findByDeliveryId.mockResolvedValue(stored());
      await expect(service.rate('delivery-1', customer, { score: 1 }, NOW)).rejects.toThrow(ConflictError);
    });

    it('treats losing a concurrent insert like an existing rating', async () => {
      ratings.findByDeliveryId.mockResolvedValueOnce(null).mockResolvedValueOnce(stored({ score: 3, comment: null }));
      ratings.create.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));

      await expect(service.rate('delivery-1', customer, { score: 3 }, NOW)).resolves.toMatchObject({ created: false });
      ratings.findByDeliveryId.mockResolvedValueOnce(null).mockResolvedValueOnce(stored({ score: 3, comment: null }));
      await expect(service.rate('delivery-1', customer, { score: 4 }, NOW)).rejects.toThrow(ConflictError);
    });
  });

  describe('getStatus', () => {
    it('tells the customer they can rate, until when', async () => {
      await expect(service.getStatus('delivery-1', customer, NOW)).resolves.toEqual({
        rating: null,
        canRate: true,
        reason: null,
        closesAt: new Date(NOW.getTime() - DAY + 14 * DAY),
      });
    });

    it('returns the existing rating and that it is done', async () => {
      ratings.findByDeliveryId.mockResolvedValue(stored());
      await expect(service.getStatus('delivery-1', customer, NOW)).resolves.toMatchObject({
        rating: { score: 5, comment: 'Fast and friendly' },
        canRate: false,
      });
    });

    it('explains why a delivery in progress cannot be rated yet', async () => {
      deliveries.findById.mockResolvedValue(delivery({ status: DeliveryStatus.IN_TRANSIT, deliveredAt: null }));
      await expect(service.getStatus('delivery-1', customer, NOW)).resolves.toMatchObject({
        canRate: false,
        reason: 'You can rate the driver once the order has been delivered.',
        closesAt: null,
      });
    });

    it('is only for the order customer (or an admin)', async () => {
      await expect(service.getStatus('delivery-1', { userId: 'customer-2', role: UserRole.CUSTOMER }, NOW)).rejects.toThrow(
        ForbiddenError,
      );
      await expect(service.getStatus('delivery-1', { userId: 'admin-1', role: UserRole.ADMIN }, NOW)).resolves.toMatchObject({
        canRate: true,
      });
    });
  });

  describe('getSummaryForDriver', () => {
    it('averages to one decimal and lists recent comments without customer identity', async () => {
      ratings.findSummary.mockResolvedValue({ driverId: 'driver-1', ratingCount: 3, ratingSum: 14 });
      ratings.findRecentComments.mockResolvedValue([stored()]);

      const summary = await service.getSummaryForDriver('Bearer driver');

      expect(driverClient.getOwnProfile).toHaveBeenCalledWith('Bearer driver');
      expect(ratings.findSummary).toHaveBeenCalledWith('driver-1');
      expect(summary).toEqual({ average: 4.7, count: 3, recentComments: [{ score: 5, comment: 'Fast and friendly', createdAt: NOW }] });
      expect(JSON.stringify(summary)).not.toContain('customer-1');
    });

    it('has no average before the first rating', async () => {
      await expect(service.getSummaryForDriver('Bearer driver')).resolves.toEqual({ average: null, count: 0, recentComments: [] });
    });

    it('is empty for a user with no driver profile', async () => {
      driverClient.getOwnProfile.mockResolvedValue(null);
      await expect(service.getSummaryForDriver('Bearer x')).resolves.toEqual({ average: null, count: 0, recentComments: [] });
      expect(ratings.findSummary).not.toHaveBeenCalled();
    });
  });
});
