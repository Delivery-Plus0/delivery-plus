import { AppError } from '@food-delivery/shared';
import { DriverLocation } from '../entities/location.model';

/**
 * Trust boundaries for driver locations (#60).
 *
 * - Trusted (server-side facts): the caller's identity and role (JWT), the delivery's status and
 *   assignment (delivery-service), and the time the server received a report.
 * - Untrusted (client claims): the reported coordinates and the client's `recordedAt`. A report says
 *   where the driver's device claims to be; it is never proof of presence.
 * - Derived (from trusted facts + accepted reports): the tracking state (LIVE/STALE…), the ETA, and any
 *   future geofence or arrival signal. Derived values are for display and estimation only: no delivery
 *   transition is ever taken because of them (pickup/start/complete are explicit actions by the
 *   assigned driver, authorized by delivery-service).
 *
 * The rules below decide which reports are accepted, and which stored positions a read may use.
 */

/** A report claiming to be from further in the future than this is rejected (device clock skew). */
export const MAX_FUTURE_SKEW_SECONDS = 30;

export type LocationReportRejection =
  /** `recordedAt` is ahead of the server clock by more than the allowed skew. */
  | 'FUTURE_TIMESTAMP'
  /** `recordedAt` is older than the stale threshold: it could only ever be shown as stale (or is a replay). */
  | 'TOO_OLD'
  /** Not newer than the last accepted report for this delivery: a replay, duplicate or reordered report. */
  | 'OUT_OF_ORDER';

/** 422: the report was understood but not accepted; nothing was stored. */
export class LocationReportRejectedError extends AppError {
  constructor(readonly reason: LocationReportRejection, message: string) {
    super(422, 'LocationReportRejected', message);
  }
}

export interface ReportCheck {
  /** Server receive time. */
  now: Date;
  /** The client's claimed capture time (ISO 8601), if it sent one. */
  recordedAt?: string;
  /** The driver's last accepted report, if any. */
  previous: DriverLocation | null;
  /** The delivery this report is bound to (the driver's active delivery, resolved server-side). */
  deliveryId: string;
  /** Same threshold that turns a position STALE. */
  maxAgeSeconds: number;
}

/**
 * Accepts or rejects a location report. The client's `recordedAt` can only ever cause a rejection:
 * freshness is always measured from the server receive time, so a wrong or forged device clock can't
 * make a position look newer than it is. Without `recordedAt` (older clients), a report is accepted
 * and ordered by receive time only.
 */
export function checkLocationReport(check: ReportCheck): LocationReportRejection | null {
  if (check.recordedAt === undefined) return null;
  const recorded = Date.parse(check.recordedAt);
  const now = check.now.getTime();
  if (recorded > now + MAX_FUTURE_SKEW_SECONDS * 1000) return 'FUTURE_TIMESTAMP';
  if (recorded < now - check.maxAgeSeconds * 1000) return 'TOO_OLD';
  const previous = check.previous;
  if (previous?.deliveryId === check.deliveryId && previous.recordedAt !== undefined) {
    if (recorded <= Date.parse(previous.recordedAt)) return 'OUT_OF_ORDER';
  }
  return null;
}

export const REJECTION_MESSAGES: Record<LocationReportRejection, string> = {
  FUTURE_TIMESTAMP: 'Location report rejected: recordedAt is in the future',
  TOO_OLD: 'Location report rejected: recordedAt is too old to be current',
  OUT_OF_ORDER: 'Location report rejected: not newer than the last accepted report',
};

/**
 * Session binding: a stored position counts for a delivery only if it was reported while the driver
 * was on that delivery. A position from the driver's previous job, or one stored before reports were
 * bound (no deliveryId), is not used: the read shows "waiting for location" until the next report.
 */
export function positionForDelivery(location: DriverLocation | null, deliveryId: string): DriverLocation | null {
  return location && location.deliveryId === deliveryId ? location : null;
}
