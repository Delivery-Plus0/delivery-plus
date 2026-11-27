import { Reflector } from '@nestjs/core';
import { ROLES_KEY, UserRole } from '@food-delivery/shared';
import { InternalOrdersController } from './internal-orders.controller';

describe('InternalOrdersController (#214)', () => {
  const orders = { countTodayForRestaurant: jest.fn().mockResolvedValue(7) };
  const controller = new InternalOrdersController(orders as never);

  it('is SYSTEM-only', () => {
    expect(new Reflector().get(ROLES_KEY, InternalOrdersController.prototype.today)).toEqual([UserRole.SYSTEM]);
  });

  it("gives restaurant-service today's count, and refuses other services", async () => {
    await expect(controller.today('r1', { user: { sub: 'system:restaurant-service' } })).resolves.toEqual({ restaurantId: 'r1', ordersToday: 7 });
    await expect(controller.today('r1', { user: { sub: 'system:delivery-service' } })).rejects.toThrow('Only restaurant-service');
  });
});
