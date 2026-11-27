import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PERMISSIONS_KEY, ROLES_KEY, UserRole } from '@food-delivery/shared';
import { AdminRestaurantsController } from './admin-restaurants.controller';
import { InternalRestaurantsController } from './internal-restaurants.controller';
import { AdminListRestaurantsQueryDto, AdminSearchRestaurantsDto } from '../dto/admin-restaurants.dto';

describe('AdminRestaurantsController (#214)', () => {
  const required = (route: 'list' | 'queue' | 'search' | 'detail') => new Reflector().get(PERMISSIONS_KEY, AdminRestaurantsController.prototype[route]);

  it('needs support.read, and onboarding.review for the queue', () => {
    expect(required('list')).toEqual(['support.read']);
    expect(required('search')).toEqual(['support.read']);
    expect(required('detail')).toEqual(['support.read']);
    expect(required('queue')).toEqual(['onboarding.review']);
    const names = Object.getOwnPropertyNames(AdminRestaurantsController.prototype);
    expect(names.indexOf('queue')).toBeLessThan(names.indexOf('detail'));
  });
});

describe('admin restaurants DTOs (#214)', () => {
  it('needs the whole area or none of it, within 50 km', async () => {
    expect(await validate(plainToInstance(AdminListRestaurantsQueryDto, {}))).toHaveLength(0);
    expect(await validate(plainToInstance(AdminListRestaurantsQueryDto, { nearLat: '30.04', nearLng: '31.23', withinKm: '5' }))).toHaveLength(0);
    const partial = await validate(plainToInstance(AdminListRestaurantsQueryDto, { nearLat: '30.04' }));
    expect(partial.map((e) => e.property)).toEqual(expect.arrayContaining(['nearLng', 'withinKm']));
    expect((await validate(plainToInstance(AdminListRestaurantsQueryDto, { nearLat: 30, nearLng: 31, withinKm: 51 }))).map((e) => e.property)).toEqual(['withinKm']);
  });

  it('normalizes the searched phone to E.164', async () => {
    const dto = plainToInstance(AdminSearchRestaurantsDto, { phone: '01011111111' });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.phone).toBe('+201011111111');
  });
});

describe('InternalRestaurantsController (#214)', () => {
  const restaurants = { findByOwner: jest.fn().mockResolvedValue([{ id: 'r1', taxCardNumber: 'x' }]) };
  const controller = new InternalRestaurantsController(restaurants as never);

  it('is SYSTEM-only, gives user-service the ids, and refuses other services', async () => {
    expect(new Reflector().get(ROLES_KEY, InternalRestaurantsController.prototype.byOwner)).toEqual([UserRole.SYSTEM]);
    await expect(controller.byOwner('o1', { user: { sub: 'system:user-service' } })).resolves.toEqual({ ids: ['r1'] });
    await expect(controller.byOwner('o1', { user: { sub: 'system:order-service' } })).rejects.toThrow('Only user-service');
  });
});
