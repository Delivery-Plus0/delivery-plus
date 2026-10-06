import { DeliveryStatus } from '@food-delivery/shared';
import { DriverLocation } from '../entities/location.model';
import { ResolvedTracking, TrackingState } from './tracking-state';

/** Why no ETA is given. Clients must treat every value as "no ETA", never as an error. */
export enum EtaUnavailableReason {
  /** The delivery is delivered or cancelled: an ETA no longer means anything. */
  DELIVERY_ENDED = 'DELIVERY_ENDED',
  /** No driver is assigned yet. */
  NO_DRIVER = 'NO_DRIVER',
  /** The assigned driver has no usable position (never reported, expired, or not in this session). */
  NO_LOCATION = 'NO_LOCATION',
  /** The driver's last position is older than the stale threshold: an ETA from it would be stale too. */
  STALE_LOCATION = 'STALE_LOCATION',
  /** Every input is valid but no estimator produced a value (none is configured yet: routing is out of scope). */
  NOT_ESTIMATED = 'NOT_ESTIMATED',
}

/**
 * The ETA contract of a tracking read (#46). Derived on every read from server-side state only (the
 * delivery's current assignment and status from delivery-service, the driver's last accepted position
 * from Redis); never accepted from a client, never stored or cached. So it can't outlive the facts it
 * came from: a cancellation, completion, reassignment or stale position simply yields no ETA.
 */
export type DeliveryEta =
  | { status: 'UNAVAILABLE'; reason: EtaUnavailableReason }
  | {
      status: 'ESTIMATED';
      /** Seconds from `computedAt` until arrival at the drop-off. */
      seconds: number;
      /** The assignment the estimate belongs to: it is invalid for any other (driverId, assignedAt). */
      driverId: string;
      assignedAt: string | null;
      /** Server receive time of the position the estimate is based on. */
      basedOnLocationAt: string;
      computedAt: string;
      /** The estimate's basis goes stale at this time; after it the ETA must not be shown. */
      validUntil: string;
    };

/** What an estimator may use. Only server-side, already-validated inputs. */
export interface EtaInput {
  deliveryId: string;
  status: DeliveryStatus;
  driverId: string;
  location: DriverLocation;
}

/** Plug-in point for a future routing/ETA provider; returns seconds, or null when it can't estimate. */
export interface EtaEstimator {
  estimateSeconds(input: EtaInput): number | null;
}

export const ETA_ESTIMATOR = Symbol('ETA_ESTIMATOR');

/** No routing provider yet: every valid input is reported as NOT_ESTIMATED. */
export const NO_ETA_ESTIMATOR: EtaEstimator = { estimateSeconds: () => null };

export interface EtaContext {
  deliveryId: string;
  status: DeliveryStatus;
  driverId?: string;
  assignedAt: string | null;
}

/**
 * The single gate every ETA passes. In order: ended → no driver → no position → stale position →
 * estimator. Only a LIVE position of the current assignment can produce an estimate, and the estimate
 * is valid only until that position would turn stale.
 */
export function deriveEta(
  context: EtaContext,
  tracking: ResolvedTracking,
  estimator: EtaEstimator,
  now: Date,
  staleAfterSeconds: number,
): DeliveryEta {
  const unavailable = (reason: EtaUnavailableReason): DeliveryEta => ({ status: 'UNAVAILABLE', reason });

  switch (tracking.tracking) {
    case TrackingState.ENDED:
      return unavailable(EtaUnavailableReason.DELIVERY_ENDED);
    case TrackingState.NO_DRIVER:
      return unavailable(EtaUnavailableReason.NO_DRIVER);
    case TrackingState.AWAITING_LOCATION:
      return unavailable(EtaUnavailableReason.NO_LOCATION);
    case TrackingState.STALE:
      return unavailable(EtaUnavailableReason.STALE_LOCATION);
    case TrackingState.LIVE:
      break;
    default:
      return unavailable(EtaUnavailableReason.NO_LOCATION);
  }
  if (!context.driverId || !tracking.location) return unavailable(EtaUnavailableReason.NO_LOCATION);

  const seconds = estimator.estimateSeconds({
    deliveryId: context.deliveryId,
    status: context.status,
    driverId: context.driverId,
    location: tracking.location,
  });
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return unavailable(EtaUnavailableReason.NOT_ESTIMATED);
  }
  const basedOn = Date.parse(tracking.location.updatedAt);
  return {
    status: 'ESTIMATED',
    seconds: Math.round(seconds),
    driverId: context.driverId,
    assignedAt: context.assignedAt,
    basedOnLocationAt: tracking.location.updatedAt,
    computedAt: now.toISOString(),
    validUntil: new Date(basedOn + staleAfterSeconds * 1000).toISOString(),
  };
}

/**
 * Whether an ETA a client is holding may still be shown, against the current assignment: it must be an
 * estimate, for the same (driverId, assignedAt), on a delivery that hasn't ended, before `validUntil`.
 * A reassigned, cancelled or delivered delivery, or a stale basis, invalidates it.
 */
export function isEtaValid(
  eta: DeliveryEta,
  current: { driverId?: string; assignedAt: string | null; status: DeliveryStatus },
  now: Date,
): boolean {
  if (eta.status !== 'ESTIMATED') return false;
  if (current.status === DeliveryStatus.DELIVERED || current.status === DeliveryStatus.CANCELLED) return false;
  if (eta.driverId !== current.driverId || eta.assignedAt !== current.assignedAt) return false;
  return now.getTime() <= Date.parse(eta.validUntil);
}
