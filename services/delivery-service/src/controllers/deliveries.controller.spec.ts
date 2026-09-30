import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '@food-delivery/shared';
import { DeliveriesController } from './deliveries.controller';

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
});
