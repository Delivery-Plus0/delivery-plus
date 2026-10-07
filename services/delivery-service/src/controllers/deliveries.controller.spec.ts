import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard, JwtPayload, ROLES_KEY, RolesGuard, UserRole } from '@food-delivery/shared';
import type { Response } from 'express';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from '../services/deliveries.service';
import { DriverCardService } from '../services/driver-card.service';
import { DriverHistoryService } from '../services/driver-history.service';
import { RatingsService } from '../services/ratings.service';
import { EarningsService } from '../services/earnings.service';

describe('DeliveriesController', () => {
  it('requires a valid JWT on every route, including the read routes (401 otherwise)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, DeliveriesController)).toContain(JwtAuthGuard);
  });

  it('passes the requester and their token through so ownership can be checked', async () => {
    const service = { getById: jest.fn(), getByOrderId: jest.fn().mockResolvedValue({ id: 'delivery-1' }) };
    const controller = new DeliveriesController(service as any, { getCard: jest.fn() } as unknown as DriverCardService, {} as DriverHistoryService, {} as RatingsService, {} as EarningsService);
    const user = { sub: 'customer-1', email: 'c@example.com', role: 'CUSTOMER' } as any;

    await controller.getById('delivery-1', user, 'Bearer t');
    await controller.getByOrderId('order-1', user, 'Bearer t');

    const reader = { userId: 'customer-1', role: 'CUSTOMER', authHeader: 'Bearer t' };
    expect(service.getById).toHaveBeenCalledWith('delivery-1', reader);
    expect(service.getByOrderId).toHaveBeenCalledWith('order-1', reader);
  });

  describe('GET me/current', () => {
    const handler = DeliveriesController.prototype.getMyCurrent;

    it('is for DRIVER accounts only (customers, owners and admins get 403)', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([RolesGuard]);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.DRIVER]);
    });

    it("resolves the driver from the caller's own token only", async () => {
      const current = { id: 'delivery-1' };
      const service = { getCurrentForDriver: jest.fn().mockResolvedValue(current) };
      const res = { status: jest.fn() };

      await expect(new DeliveriesController(service as unknown as DeliveriesService, {} as DriverCardService, {} as DriverHistoryService, {} as RatingsService, {} as EarningsService).getMyCurrent('Bearer driver', res as unknown as Response)).resolves.toBe(current);
      expect(service.getCurrentForDriver).toHaveBeenCalledWith('Bearer driver');
      expect(res.status).not.toHaveBeenCalled();
    });

    it('answers 204 No Content when there is no active delivery', async () => {
      const service = { getCurrentForDriver: jest.fn().mockResolvedValue(null) };
      const res = { status: jest.fn() };

      await expect(new DeliveriesController(service as unknown as DeliveriesService, {} as DriverCardService, {} as DriverHistoryService, {} as RatingsService, {} as EarningsService).getMyCurrent('Bearer driver', res as unknown as Response)).resolves.toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(204);
    });
  });

  describe('GET by-order/:orderId driver card (#140)', () => {
    const user = { sub: 'customer-1', email: 'c@example.com', role: UserRole.CUSTOMER } as JwtPayload;
    const card = { displayName: 'Omar', avatarUrl: null, vehicleType: 'Scooter', licensePlate: 'ABC 123' };

    it('adds the card for an assigned delivery the reader is allowed to see', async () => {
      const service = { getByOrderId: jest.fn().mockResolvedValue({ id: 'delivery-1', driverId: 'driver-1', status: 'DRIVER_ASSIGNED' }) };
      const cards = { getCard: jest.fn().mockResolvedValue(card) };
      const result = await new DeliveriesController(service as unknown as DeliveriesService, cards as unknown as DriverCardService, {} as DriverHistoryService, {} as RatingsService, {} as EarningsService).getByOrderId('order-1', user, 'Bearer t');

      expect(result).toMatchObject({ id: 'delivery-1', driverId: 'driver-1', driver: card });
      expect(cards.getCard).toHaveBeenCalledWith('driver-1');
    });

    it('no driver yet: driver is null and no lookup happens', async () => {
      const service = { getByOrderId: jest.fn().mockResolvedValue({ id: 'delivery-1', status: 'CREATED' }) };
      const cards = { getCard: jest.fn() };
      const result = await new DeliveriesController(service as unknown as DeliveriesService, cards as unknown as DriverCardService, {} as DriverHistoryService, {} as RatingsService, {} as EarningsService).getByOrderId('order-1', user, 'Bearer t');

      expect(result).toMatchObject({ driver: null });
      expect(cards.getCard).not.toHaveBeenCalled();
    });

    it('another customer: authorization fails first, so no card is ever composed', async () => {
      const service = { getByOrderId: jest.fn().mockRejectedValue(new Error('You do not have access to this order')) };
      const cards = { getCard: jest.fn() };
      await expect(new DeliveriesController(service as unknown as DeliveriesService, cards as unknown as DriverCardService, {} as DriverHistoryService, {} as RatingsService, {} as EarningsService).getByOrderId('order-1', user, 'Bearer other')).rejects.toThrow('access');
      expect(cards.getCard).not.toHaveBeenCalled();
    });
  });

  describe('getMyHistory (#142)', () => {
    it('is for DRIVER accounts only (customers, owners and admins get 403)', () => {
      const handler = DeliveriesController.prototype.getMyHistory;
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([RolesGuard]);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.DRIVER]);
    });

    it('passes the caller token and the validated query to the history service', async () => {
      const page = { items: [], page: 2, limit: 5, total: 0, totalPages: 1 };
      const history = { getForDriver: jest.fn().mockResolvedValue(page) };
      const controller = new DeliveriesController({} as DeliveriesService, {} as DriverCardService, history as unknown as DriverHistoryService, {} as RatingsService, {} as EarningsService);

      await expect(controller.getMyHistory('Bearer driver', { status: 'completed', page: 2, limit: 5 })).resolves.toBe(page);
      expect(history.getForDriver).toHaveBeenCalledWith('Bearer driver', { status: 'completed', page: 2, limit: 5 });
    });
  });

  describe('ratings (#144)', () => {
    const roles = (handler: object) => [Reflect.getMetadata(GUARDS_METADATA, handler), Reflect.getMetadata(ROLES_KEY, handler)];

    it('lets only customers rate, customers and admins read, and drivers read their own summary', () => {
      expect(roles(DeliveriesController.prototype.rate)).toEqual([[RolesGuard], [UserRole.CUSTOMER]]);
      expect(roles(DeliveriesController.prototype.getRating)).toEqual([[RolesGuard], [UserRole.CUSTOMER, UserRole.ADMIN]]);
      expect(roles(DeliveriesController.prototype.getMyRatingSummary)).toEqual([[RolesGuard], [UserRole.DRIVER]]);
    });

    it('answers 201 for a new rating and 200 for an identical retry', async () => {
      const rating = { score: 5, comment: null, createdAt: new Date() };
      const ratings = { rate: jest.fn().mockResolvedValueOnce({ rating, created: true }).mockResolvedValueOnce({ rating, created: false }) };
      const controller = new DeliveriesController({} as DeliveriesService, {} as DriverCardService, {} as DriverHistoryService, ratings as unknown as RatingsService, {} as EarningsService);
      const user = { sub: 'customer-1', role: UserRole.CUSTOMER } as JwtPayload;
      const res = { status: jest.fn() };

      await expect(controller.rate('delivery-1', user, { score: 5 }, res as unknown as Response)).resolves.toBe(rating);
      expect(res.status).toHaveBeenLastCalledWith(201);
      await controller.rate('delivery-1', user, { score: 5 }, res as unknown as Response);
      expect(res.status).toHaveBeenLastCalledWith(200);
      expect(ratings.rate).toHaveBeenCalledWith('delivery-1', { userId: 'customer-1', role: UserRole.CUSTOMER }, { score: 5 });
    });
  });
});
