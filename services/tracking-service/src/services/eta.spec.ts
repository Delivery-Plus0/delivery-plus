import { DeliveryStatus } from '@food-delivery/shared';
import { DeliveryEta, EtaEstimator, EtaUnavailableReason, NO_ETA_ESTIMATOR, deriveEta, isEtaValid } from './eta';
import { resolveTracking } from './tracking-state';

describe('ETA contract (#46)', () => {
  const now = new Date('2026-10-06T12:00:00.000Z');
  const STALE_AFTER = 60;
  const assignedAt = '2026-10-06T11:58:00.000Z';
  const context = { deliveryId: 'delivery-1', status: DeliveryStatus.IN_TRANSIT, driverId: 'driver-1', assignedAt };
  const fixed = (seconds: number | null): EtaEstimator => ({ estimateSeconds: jest.fn(() => seconds) });
  const positionAgo = (secondsAgo: number) => ({
    userId: 'user-1',
    latitude: 30.0444,
    longitude: 31.2357,
    updatedAt: new Date(now.getTime() - secondsAgo * 1000).toISOString(),
  });
  const derive = (
    status: DeliveryStatus,
    driverId: string | undefined,
    location: ReturnType<typeof positionAgo> | null,
    estimator: EtaEstimator,
  ) =>
    deriveEta(
      { ...context, status, driverId, assignedAt: driverId ? assignedAt : null },
      resolveTracking(status, driverId, location, now, STALE_AFTER),
      estimator,
      now,
      STALE_AFTER,
    );

  describe('deriveEta: the single gate', () => {
    it('a LIVE position of the current assignment + an estimate → ESTIMATED, valid until its basis goes stale', () => {
      const estimator = fixed(420.4);
      const eta = derive(DeliveryStatus.IN_TRANSIT, 'driver-1', positionAgo(10), estimator);

      expect(eta).toEqual({
        status: 'ESTIMATED',
        seconds: 420,
        driverId: 'driver-1',
        assignedAt,
        basedOnLocationAt: positionAgo(10).updatedAt,
        computedAt: now.toISOString(),
        validUntil: new Date(now.getTime() + 50_000).toISOString(),
      });
      // The estimator sees only server-side, already-validated inputs.
      expect(estimator.estimateSeconds).toHaveBeenCalledWith({
        deliveryId: 'delivery-1',
        status: DeliveryStatus.IN_TRANSIT,
        driverId: 'driver-1',
        location: positionAgo(10),
      });
    });

    it.each([
      ['DELIVERED', DeliveryStatus.DELIVERED, 'driver-1', positionAgo(1), EtaUnavailableReason.DELIVERY_ENDED],
      ['CANCELLED', DeliveryStatus.CANCELLED, 'driver-1', positionAgo(1), EtaUnavailableReason.DELIVERY_ENDED],
      ['no driver', DeliveryStatus.CREATED, undefined, null, EtaUnavailableReason.NO_DRIVER],
      ['no position', DeliveryStatus.DRIVER_ASSIGNED, 'driver-1', null, EtaUnavailableReason.NO_LOCATION],
      ['stale position', DeliveryStatus.IN_TRANSIT, 'driver-1', positionAgo(61), EtaUnavailableReason.STALE_LOCATION],
    ])('%s → UNAVAILABLE (%s), and the estimator is never asked', (_label, status, driverId, location, reason) => {
      const estimator = fixed(300);
      expect(derive(status, driverId, location, estimator)).toEqual({ status: 'UNAVAILABLE', reason });
      expect(estimator.estimateSeconds).not.toHaveBeenCalled();
    });

    it.each([
      ['no estimator configured', NO_ETA_ESTIMATOR],
      ['estimator has no answer', fixed(null)],
      ['negative estimate', fixed(-5)],
      ['non-finite estimate', fixed(Number.POSITIVE_INFINITY)],
    ])('%s → UNAVAILABLE (NOT_ESTIMATED), never a made-up value', (_label, estimator) => {
      expect(derive(DeliveryStatus.IN_TRANSIT, 'driver-1', positionAgo(5), estimator)).toEqual({
        status: 'UNAVAILABLE',
        reason: EtaUnavailableReason.NOT_ESTIMATED,
      });
    });
  });

  describe('isEtaValid: an ETA never outlives its facts', () => {
    const estimate = derive(DeliveryStatus.IN_TRANSIT, 'driver-1', positionAgo(10), fixed(600)) as Extract<DeliveryEta, { status: 'ESTIMATED' }>;
    const current = { driverId: 'driver-1', assignedAt, status: DeliveryStatus.IN_TRANSIT };

    it('valid for the same assignment before validUntil', () => {
      expect(isEtaValid(estimate, current, now)).toBe(true);
      expect(isEtaValid(estimate, current, new Date(Date.parse(estimate.validUntil)))).toBe(true);
    });

    it('a stale ETA fails validation once its position basis turns stale', () => {
      expect(isEtaValid(estimate, current, new Date(Date.parse(estimate.validUntil) + 1))).toBe(false);
    });

    it('a reassigned delivery does not keep the old ETA (other driver, or same driver re-assigned later)', () => {
      expect(isEtaValid(estimate, { ...current, driverId: 'driver-2' }, now)).toBe(false);
      expect(isEtaValid(estimate, { ...current, assignedAt: '2026-10-06T11:59:30.000Z' }, now)).toBe(false);
    });

    it.each([DeliveryStatus.CANCELLED, DeliveryStatus.DELIVERED])('a %s delivery clears the ETA', (status) => {
      expect(isEtaValid(estimate, { ...current, status }, now)).toBe(false);
    });

    it('an UNAVAILABLE ETA is never valid to show', () => {
      expect(isEtaValid({ status: 'UNAVAILABLE', reason: EtaUnavailableReason.NO_LOCATION }, current, now)).toBe(false);
    });
  });
});
