import { OrderStatus, UserRole } from '@food-delivery/shared';

/**
 * Who is allowed to request each *target* status, before ownership is even
 * checked. ADMIN can always do everything (checked separately in the
 * service). This is intentionally conservative for statuses that will
 * eventually be system-triggered by payment-service, driver-service, and
 * delivery-service once those exist (Phases 5–7): until then only ADMIN can
 * set them, so the transition endpoint stays usable for local testing
 * without pretending those integrations already exist.
 */
export const TRANSITION_ROLES: Partial<Record<OrderStatus, UserRole[]>> = {
  [OrderStatus.PAYMENT_PENDING]: [UserRole.ADMIN], // normally: order-service itself, right after creation
  [OrderStatus.CONFIRMED]: [UserRole.ADMIN], // normally: payment-service, on payment.completed (Phase 5/9)
  [OrderStatus.PREPARING]: [UserRole.RESTAURANT_OWNER, UserRole.ADMIN],
  [OrderStatus.READY_FOR_PICKUP]: [UserRole.RESTAURANT_OWNER, UserRole.ADMIN],
  [OrderStatus.DRIVER_ASSIGNED]: [UserRole.ADMIN], // normally: delivery-service (Phase 7/9)
  [OrderStatus.PICKED_UP]: [UserRole.ADMIN], // normally: delivery-service (Phase 7/9)
  [OrderStatus.DELIVERED]: [UserRole.ADMIN], // normally: delivery-service (Phase 7/9)
  [OrderStatus.CANCELLED]: [UserRole.CUSTOMER, UserRole.RESTAURANT_OWNER, UserRole.ADMIN],
  [OrderStatus.FAILED]: [UserRole.ADMIN],
};

export function isRoleAllowedForTransition(target: OrderStatus, role: UserRole): boolean {
  if (role === UserRole.ADMIN) return true;
  return TRANSITION_ROLES[target]?.includes(role) ?? false;
}

/** #53: a customer may cancel only before the restaurant starts preparing (the app shows the same rule). */
export const CUSTOMER_CANCELLABLE_STATUSES: readonly OrderStatus[] = [
  OrderStatus.CREATED,
  OrderStatus.PAYMENT_PENDING,
  OrderStatus.CONFIRMED,
];

/**
 * #53: once a driver is on the order, the platform cancels it through its delivery
 * (`POST /deliveries/:id/cancel`), so delivery-service decides it against the driver's own actions
 * and releases and compensates the driver. Services acting for the platform may still sync it.
 */
export const DRIVER_ON_ORDER_STATUSES: readonly OrderStatus[] = [OrderStatus.DRIVER_ASSIGNED, OrderStatus.PICKED_UP];

/** Services call with a system identity (`system`, `system:<service>`); people never have one. */
export function isSystemCaller(requesterId: string): boolean {
  return requesterId === 'system' || requesterId.startsWith('system:');
}

/**
 * Why `requester` may not cancel an order that is currently `from`, or null when they may.
 * Ownership is checked separately; this is the cancellation window (docs/business/cancellation-and-refunds.md).
 */
export function cancellationRefusal(from: OrderStatus, requesterId: string, role: UserRole): string | null {
  switch (role) {
    case UserRole.CUSTOMER:
      return CUSTOMER_CANCELLABLE_STATUSES.includes(from)
        ? null
        : 'An order can only be cancelled before the restaurant starts preparing it.';
    case UserRole.RESTAURANT_OWNER:
      // A restaurant rejects an order before cooking it, never mid-way (#154).
      return from === OrderStatus.CONFIRMED ? null : 'An order can only be rejected before you start preparing it.';
    case UserRole.ADMIN:
      return DRIVER_ON_ORDER_STATUSES.includes(from) && !isSystemCaller(requesterId)
        ? 'This order has a driver: cancel its delivery instead (POST /deliveries/:id/cancel), so the driver is released and compensated.'
        : null;
    default:
      return 'You cannot cancel this order.';
  }
}
