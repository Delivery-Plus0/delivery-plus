import { DriverStatus, UserRole } from '@food-delivery/shared';

/**
 * The only transitions a DRIVER may make on their own profile: going online and offline.
 *
 * Everything else is ADMIN-only. delivery-service holds an ADMIN system token and performs the
 * assignment claim (AVAILABLE -> BUSY) and the release (BUSY -> AVAILABLE) itself, so a driver
 * cannot make themselves AVAILABLE while on a delivery and pick up a second one.
 */
const DRIVER_SELF_TRANSITIONS: ReadonlyArray<readonly [DriverStatus, DriverStatus]> = [
  [DriverStatus.OFFLINE, DriverStatus.AVAILABLE],
  [DriverStatus.AVAILABLE, DriverStatus.OFFLINE],
];

export function isRoleAllowedForTransition(from: DriverStatus, to: DriverStatus, role: UserRole): boolean {
  if (role === UserRole.ADMIN) return true;
  if (role !== UserRole.DRIVER) return false;
  return DRIVER_SELF_TRANSITIONS.some(([allowedFrom, allowedTo]) => allowedFrom === from && allowedTo === to);
}

/**
 * Statuses where repeating the request for the current status is a safe no-op (going online
 * twice, releasing a driver twice). BUSY is deliberately absent: claiming a driver must be
 * exclusive, so a second claim of a BUSY driver is always a conflict.
 */
export const IDEMPOTENT_STATUSES: readonly DriverStatus[] = [DriverStatus.AVAILABLE, DriverStatus.OFFLINE];
