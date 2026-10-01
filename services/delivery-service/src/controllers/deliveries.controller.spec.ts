import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard, ROLES_KEY, RolesGuard, UserRole } from '@food-delivery/shared';
import type { Response } from 'express';
import { DeliveriesController } from './deliveries.controller';
import { DeliveriesService } from '../services/deliveries.service';

describe('DeliveriesController', () => {
  it('requires a valid JWT on every route, including the read routes (401 otherwise)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, DeliveriesController)).toContain(JwtAuthGuard);
  });

  it('passes the requester and their token through so ownership can be checked', async () => {
    const service = { getById: jest.fn(), getByOrderId: jest.fn() };
    const controller = new DeliveriesController(service as any);
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

      await expect(new DeliveriesController(service as unknown as DeliveriesService).getMyCurrent('Bearer driver', res as unknown as Response)).resolves.toBe(current);
      expect(service.getCurrentForDriver).toHaveBeenCalledWith('Bearer driver');
      expect(res.status).not.toHaveBeenCalled();
    });

    it('answers 204 No Content when there is no active delivery', async () => {
      const service = { getCurrentForDriver: jest.fn().mockResolvedValue(null) };
      const res = { status: jest.fn() };

      await expect(new DeliveriesController(service as unknown as DeliveriesService).getMyCurrent('Bearer driver', res as unknown as Response)).resolves.toBeUndefined();
      expect(res.status).toHaveBeenCalledWith(204);
    });
  });
});
