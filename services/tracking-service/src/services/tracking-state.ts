import { DeliveryStatus } from '@food-delivery/shared';
import { DriverLocation } from '../entities/location.model';

/**
 * What a customer can know about the driver's position for one delivery (#32). Every read resolves to
 * exactly one state, so clients never have to guess from a null location.
 */
export enum TrackingState {
  /** No driver is assigned yet (the delivery is waiting for one). */
  NO_DRIVER = 'NO_DRIVER',
  /** A driver is assigned but has not reported a position yet, or it expired (TTL). */
  AWAITING_LOCATION = 'AWAITING_LOCATION',
  /** The assigned driver reported a position within the stale threshold. */
  LIVE = 'LIVE',
  /** The last position is older than the stale threshold: shown as "last seen", not as live. */
  STALE = 'STALE',
  /** The delivery is delivered or cancelled: tracking is over and no position is returned. */
  ENDED = 'ENDED',
}

const FINISHED: ReadonlySet<DeliveryStatus> = new Set([DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED]);

export function isTrackingFinished(status: DeliveryStatus): boolean {
  return FINISHED.has(status);
}

export interface ResolvedTracking {
  tracking: TrackingState;
  location: DriverLocation | null;
  locationAgeSeconds: number | null;
}

/**
 * Applies the lifecycle rules for a delivery whose status and (current) driver are known:
 * finished → ENDED without a position; no driver → NO_DRIVER; no stored position → AWAITING_LOCATION;
 * older than `staleAfterSeconds` → STALE; otherwise LIVE. A position with an unreadable timestamp is
 * treated as missing; a timestamp in the future (clock skew) counts as age 0.
 */
export function resolveTracking(
  status: DeliveryStatus,
  driverId: string | undefined,
  location: DriverLocation | null,
  now: Date,
  staleAfterSeconds: number,
): ResolvedTracking {
  if (isTrackingFinished(status)) {
    return { tracking: TrackingState.ENDED, location: null, locationAgeSeconds: null };
  }
  if (!driverId) {
    return { tracking: TrackingState.NO_DRIVER, location: null, locationAgeSeconds: null };
  }
  const reportedAt = location ? Date.parse(location.updatedAt) : NaN;
  if (!location || Number.isNaN(reportedAt)) {
    return { tracking: TrackingState.AWAITING_LOCATION, location: null, locationAgeSeconds: null };
  }
  const locationAgeSeconds = Math.max(0, Math.floor((now.getTime() - reportedAt) / 1000));
  const tracking = locationAgeSeconds > staleAfterSeconds ? TrackingState.STALE : TrackingState.LIVE;
  return { tracking, location, locationAgeSeconds };
}
