import { DeliveryStatus } from '@food-delivery/shared';
import { TrackingState, resolveTracking } from './tracking-state';

describe('resolveTracking', () => {
  const now = new Date('2026-10-06T12:00:00.000Z');
  const at = (secondsAgo: number) => ({
    userId: 'user-1',
    latitude: 30.1,
    longitude: 31.2,
    updatedAt: new Date(now.getTime() - secondsAgo * 1000).toISOString(),
  });

  it.each([DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED])(
    'ENDED without a position once the delivery is %s, even with a fresh report',
    (status) => {
      expect(resolveTracking(status, 'driver-1', at(1), now, 60)).toEqual({
        tracking: TrackingState.ENDED,
        location: null,
        locationAgeSeconds: null,
      });
    },
  );

  it('NO_DRIVER while the delivery waits for a driver', () => {
    expect(resolveTracking(DeliveryStatus.CREATED, undefined, null, now, 60)).toEqual({
      tracking: TrackingState.NO_DRIVER,
      location: null,
      locationAgeSeconds: null,
    });
  });

  it('AWAITING_LOCATION when the assigned driver has not reported yet', () => {
    expect(resolveTracking(DeliveryStatus.DRIVER_ASSIGNED, 'driver-1', null, now, 60).tracking).toBe(
      TrackingState.AWAITING_LOCATION,
    );
  });

  it('treats a position with an unreadable timestamp as missing', () => {
    const result = resolveTracking(DeliveryStatus.PICKED_UP, 'driver-1', { ...at(0), updatedAt: 'nope' }, now, 60);
    expect(result).toEqual({ tracking: TrackingState.AWAITING_LOCATION, location: null, locationAgeSeconds: null });
  });

  it('LIVE with the age in seconds when the report is recent', () => {
    const result = resolveTracking(DeliveryStatus.IN_TRANSIT, 'driver-1', at(12), now, 60);
    expect(result.tracking).toBe(TrackingState.LIVE);
    expect(result.locationAgeSeconds).toBe(12);
    expect(result.location?.latitude).toBe(30.1);
  });

  it('LIVE exactly at the threshold, STALE one second after it (position still returned)', () => {
    expect(resolveTracking(DeliveryStatus.IN_TRANSIT, 'driver-1', at(60), now, 60).tracking).toBe(TrackingState.LIVE);
    const stale = resolveTracking(DeliveryStatus.IN_TRANSIT, 'driver-1', at(61), now, 60);
    expect(stale.tracking).toBe(TrackingState.STALE);
    expect(stale.locationAgeSeconds).toBe(61);
    expect(stale.location).not.toBeNull();
  });

  it('counts a timestamp in the future (clock skew) as age 0', () => {
    const result = resolveTracking(DeliveryStatus.IN_TRANSIT, 'driver-1', at(-30), now, 60);
    expect(result).toMatchObject({ tracking: TrackingState.LIVE, locationAgeSeconds: 0 });
  });
});
