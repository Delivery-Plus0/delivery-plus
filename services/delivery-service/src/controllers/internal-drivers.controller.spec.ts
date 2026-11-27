import { Reflector } from '@nestjs/core';
import { ROLES_KEY, UserRole } from '@food-delivery/shared';
import { DRIVER_SUMMARY_CALLER, InternalDriversController } from './internal-drivers.controller';

describe('InternalDriversController (#214)', () => {
  const earnings = { totalsForStaff: jest.fn().mockResolvedValue({ currency: 'EGP', pending: '12.50', available: '100.00', balance: '112.50' }) };
  const ratings = { summaryForStaff: jest.fn().mockResolvedValue({ average: 4.6, count: 12 }) };
  const controller = new InternalDriversController(earnings as never, ratings as never);

  it('is SYSTEM-only', () => {
    expect(new Reflector().get(ROLES_KEY, InternalDriversController.prototype.summary)).toEqual([UserRole.SYSTEM]);
  });

  it('gives driver-service the balance and the rating', async () => {
    await expect(controller.summary('d1', { user: { sub: DRIVER_SUMMARY_CALLER } })).resolves.toEqual({
      earnings: { currency: 'EGP', pending: '12.50', available: '100.00', balance: '112.50' },
      rating: { average: 4.6, count: 12 },
    });
    expect(earnings.totalsForStaff).toHaveBeenCalledWith('d1');
  });

  it('refuses any other service', async () => {
    await expect(controller.summary('d1', { user: { sub: 'system:order-service' } })).rejects.toThrow('Only driver-service');
  });
});
