import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PERMISSIONS_KEY } from '@food-delivery/shared';
import { AdminRestaurantActionsController } from './admin-restaurant-actions.controller';
import { AdminRestaurantReasonDto } from '../dto/admin-restaurant-actions.dto';
import { AdminRestaurantActionsService } from '../services/admin-restaurant-actions.service';

describe('AdminRestaurantActionsController (#215)', () => {
  it('needs onboarding.review to review and ops.act to suspend or reactivate, with a reason', async () => {
    const required = (route: 'review' | 'suspend' | 'reactivate') => new Reflector().get(PERMISSIONS_KEY, AdminRestaurantActionsController.prototype[route]);
    expect(required('review')).toEqual(['onboarding.review']);
    expect(required('suspend')).toEqual(['ops.act']);
    expect(required('reactivate')).toEqual(['ops.act']);
    expect((await validate(plainToInstance(AdminRestaurantReasonDto, {}))).map((e) => e.property)).toEqual(['reason']);
  });
});

describe('AdminRestaurantActionsService (#215)', () => {
  const manager = { query: jest.fn().mockResolvedValue([]) };
  const restaurants = {
    findById: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'owner-1', name: 'Zooba', status: 'SUSPENDED' }),
    transaction: jest.fn((work: (m: unknown) => unknown) => work(manager)),
    suspend: jest.fn(),
  };
  const restaurantsService = { forget: jest.fn(), review: jest.fn() };
  const outbox = { kick: jest.fn() };
  const service = new AdminRestaurantActionsService(restaurants as never, restaurantsService as never, outbox as never);

  it('suspends with one audit event telling the owner, drops the cache, and a repeat records nothing', async () => {
    restaurants.suspend.mockResolvedValueOnce({ before: { status: 'OPEN' }, after: { status: 'SUSPENDED' } });
    await expect(service.suspend({ id: 'staff-1' }, 'r1', 'Food safety complaint')).resolves.toEqual({ restaurant: { id: 'r1', status: 'SUSPENDED' }, changed: true });
    const staged = manager.query.mock.calls.map(([, params]) => JSON.parse(params[2]).payload);
    expect(staged).toEqual([
      expect.objectContaining({ action: 'restaurant.suspend', notify: { userId: 'owner-1', messageKey: 'restaurant.suspended', params: { restaurantName: 'Zooba' } } }),
    ]);
    expect(restaurantsService.forget).toHaveBeenCalledWith('r1');

    restaurants.suspend.mockResolvedValueOnce(null);
    await expect(service.suspend({ id: 'staff-1' }, 'r1', 'Again')).resolves.toMatchObject({ changed: false });
    expect(manager.query).toHaveBeenCalledTimes(1);
  });
});
