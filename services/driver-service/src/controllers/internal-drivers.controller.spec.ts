import { Reflector } from '@nestjs/core';
import { ROLES_KEY, UserRole } from '@food-delivery/shared';
import { InternalDriversController } from './internal-drivers.controller';

describe('InternalDriversController (#214)', () => {
  const drivers = { findByUserId: jest.fn() };
  const controller = new InternalDriversController(drivers as never);
  const userService = { user: { sub: 'system:user-service' } };

  it('is SYSTEM-only', () => {
    expect(new Reflector().get(ROLES_KEY, InternalDriversController.prototype.byUser)).toEqual([UserRole.SYSTEM]);
  });

  it("gives user-service the driver id of a person, and 404s someone who isn't a driver", async () => {
    drivers.findByUserId.mockResolvedValueOnce({ id: 'd1', nationalIdHash: 'secret' });
    await expect(controller.byUser('u1', userService)).resolves.toEqual({ id: 'd1' });
    drivers.findByUserId.mockResolvedValueOnce(null);
    await expect(controller.byUser('u2', userService)).rejects.toThrow('No driver');
  });

  it('refuses other services', async () => {
    await expect(controller.byUser('u1', { user: { sub: 'system:order-service' } })).rejects.toThrow('Only user-service');
  });
});
