import { Reflector } from '@nestjs/core';
import { ROLES_KEY, UserRole } from '@food-delivery/shared';
import { InternalNamesController } from './internal-names.controller';

describe('InternalNamesController (#214)', () => {
  const profiles = { findByIds: jest.fn().mockResolvedValue([{ id: 'u1', fullName: 'Ali Hassan', email: 'ali@example.com', phone: '+201011111111' }]) };
  const controller = new InternalNamesController(profiles as never);

  it('is SYSTEM-only', () => {
    expect(new Reflector().get(ROLES_KEY, InternalNamesController.prototype.names)).toEqual([UserRole.SYSTEM]);
  });

  it('returns names only, never contact data', async () => {
    const result = await controller.names({ ids: ['u1'] }, { user: { sub: 'system:driver-service' } });
    expect(result).toEqual({ items: [{ id: 'u1', fullName: 'Ali Hassan' }] });
  });

  it('refuses other services', async () => {
    await expect(controller.names({ ids: ['u1'] }, { user: { sub: 'system:order-service' } })).rejects.toThrow('Not allowed');
  });
});
