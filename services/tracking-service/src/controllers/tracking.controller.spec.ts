import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard, ROLES_KEY, RolesGuard, UserRole } from '@food-delivery/shared';
import { TrackingController } from './tracking.controller';

describe('TrackingController', () => {
  const handler = (name: keyof TrackingController) => TrackingController.prototype[name];

  it('no longer exposes driver locations publicly: JWT + role guard on GET /tracking/driver/:userId', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('getDriverLocation'))).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, handler('getDriverLocation'))).toEqual([UserRole.DRIVER, UserRole.ADMIN]);
  });

  it('requires a JWT for delivery tracking (ownership is enforced by delivery-service)', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler('getDeliveryTracking'))).toContain(JwtAuthGuard);
  });
});
