import { DriverLocation } from '../entities/location.model';
import { MAX_FUTURE_SKEW_SECONDS, checkLocationReport, positionForDelivery } from './location-trust';

describe('location trust rules (#60)', () => {
  const now = new Date('2026-10-06T12:00:00.000Z');
  const at = (secondsFromNow: number) => new Date(now.getTime() + secondsFromNow * 1000).toISOString();
  const stored = (overrides: Partial<DriverLocation> = {}): DriverLocation => ({
    userId: 'user-1',
    deliveryId: 'delivery-1',
    latitude: 30,
    longitude: 31,
    updatedAt: at(-10),
    recordedAt: at(-10),
    ...overrides,
  });
  const check = (recordedAt: string | undefined, previous: DriverLocation | null = null, deliveryId = 'delivery-1') =>
    checkLocationReport({ now, recordedAt, previous, deliveryId, maxAgeSeconds: 60 });

  describe('checkLocationReport', () => {
    it('accepts a current report, and one without a client time (older clients)', () => {
      expect(check(at(-1))).toBeNull();
      expect(check(undefined, stored())).toBeNull();
    });

    it('tolerates small device clock skew, rejects a future timestamp beyond it', () => {
      expect(check(at(MAX_FUTURE_SKEW_SECONDS))).toBeNull();
      expect(check(at(MAX_FUTURE_SKEW_SECONDS + 1))).toBe('FUTURE_TIMESTAMP');
    });

    it('rejects a report older than the stale threshold (a stale geo event or a replay)', () => {
      expect(check(at(-60))).toBeNull();
      expect(check(at(-61))).toBe('TOO_OLD');
    });

    it('rejects a replayed, duplicated or reordered report for the same delivery', () => {
      expect(check(at(-10), stored({ recordedAt: at(-10) }))).toBe('OUT_OF_ORDER'); // exact replay
      expect(check(at(-20), stored({ recordedAt: at(-10) }))).toBe('OUT_OF_ORDER'); // older
      expect(check(at(-9), stored({ recordedAt: at(-10) }))).toBeNull(); // newer
    });

    it('ordering is per delivery: the previous job\'s report does not constrain a new delivery', () => {
      expect(check(at(-20), stored({ deliveryId: 'previous-delivery', recordedAt: at(-1) }))).toBeNull();
    });

    it('a stored report without a client time cannot be used to order (nothing to compare)', () => {
      expect(check(at(-30), stored({ recordedAt: undefined }))).toBeNull();
    });
  });

  describe('positionForDelivery (session binding)', () => {
    it('returns the stored position only for the delivery it was reported on', () => {
      expect(positionForDelivery(stored(), 'delivery-1')).toEqual(stored());
      expect(positionForDelivery(stored({ deliveryId: 'previous-delivery' }), 'delivery-1')).toBeNull();
      expect(positionForDelivery(stored({ deliveryId: undefined }), 'delivery-1')).toBeNull();
      expect(positionForDelivery(null, 'delivery-1')).toBeNull();
    });
  });
});
