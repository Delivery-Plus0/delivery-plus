import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard, ROLES_KEY, RolesGuard, UserRole } from '@food-delivery/shared';
import { DriversController } from './drivers.controller';

describe('DriversController', () => {
  const handler = (name: keyof DriversController) => DriversController.prototype[name];

  it('GET /drivers/available is no longer anonymous: JWT + ADMIN (service system tokens) only', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('listAvailable'))).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, handler('listAvailable'))).toEqual([UserRole.ADMIN]);
  });

  it('GET /drivers/:id requires a JWT from a driver (self, checked in the service) or admin', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('getById'))).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, handler('getById'))).toEqual([UserRole.DRIVER, UserRole.ADMIN]);
  });
});
