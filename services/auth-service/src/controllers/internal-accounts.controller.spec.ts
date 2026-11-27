import { Reflector } from '@nestjs/core';
import { ROLES_KEY, UserRole } from '@food-delivery/shared';
import { ACCOUNT_DIRECTORY_CALLER, InternalAccountsController } from './internal-accounts.controller';

describe('InternalAccountsController (#214)', () => {
  const credentials = { queryAccounts: jest.fn().mockResolvedValue([[{ id: 'u1' }], 1]) };
  const controller = new InternalAccountsController(credentials as never);

  it('is a SYSTEM-only route', () => {
    expect(new Reflector().get(ROLES_KEY, InternalAccountsController.prototype.query)).toEqual([UserRole.SYSTEM]);
  });

  it('answers user-service', async () => {
    const dto = { page: 2, limit: 50, roles: [UserRole.DRIVER], createdFrom: '2026-11-01T00:00:00Z' };
    await expect(controller.query(dto as never, { user: { sub: ACCOUNT_DIRECTORY_CALLER } })).resolves.toEqual({ items: [{ id: 'u1' }], total: 1 });
    expect(credentials.queryAccounts).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 50, roles: [UserRole.DRIVER], createdFrom: new Date('2026-11-01T00:00:00Z') }));
  });

  it('refuses any other service', async () => {
    await expect(controller.query({ page: 1, limit: 20 } as never, { user: { sub: 'system:delivery-service' } })).rejects.toThrow('Only user-service');
  });
});
