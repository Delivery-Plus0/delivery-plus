import { OrderStatus, UserRole } from '@food-delivery/shared';

/** Who ended an order (#143). Recorded with the CANCELLED / FAILED transition, never guessed later. */
export enum OrderEndedBy {
  CUSTOMER = 'CUSTOMER',
  RESTAURANT = 'RESTAURANT',
  SYSTEM = 'SYSTEM',
  PAYMENT = 'PAYMENT',
}

/** The order's payment as order-service learns it from payment events (#143). */
export enum OrderPaymentStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  /** #56: the whole payment was refunded after the order was cancelled. Final. */
  REFUNDED = 'REFUNDED',
}

export const CANCELLATION_REASON_MAX = 200;

export interface OrderOutcome {
  cancelledBy: OrderEndedBy;
  cancellationReason: string;
  /** #151: the restaurant's or platform's own words, without the lead-in; null when none was given. */
  cancellationNote: string | null;
}

/**
 * Who ended the order and the reason shown to the customer, for a move to CANCELLED or FAILED.
 * FAILED only ever comes from payment (payment-service's sync and the payment.failed consumer).
 * ADMIN-role callers that cancel are the platform itself (delivery-service, support), so SYSTEM.
 * A restaurant may give its own reason; otherwise each path has a fixed, accurate sentence.
 */
export function outcomeFor(target: OrderStatus, role: UserRole, reason?: string | null): OrderOutcome | null {
  if (target === OrderStatus.FAILED) {
    return { cancelledBy: OrderEndedBy.PAYMENT, cancellationReason: 'Your payment was declined, so the order was not placed.', cancellationNote: null };
  }
  if (target !== OrderStatus.CANCELLED) return null;

  const given = reason?.trim();
  switch (role) {
    case UserRole.CUSTOMER:
      return { cancelledBy: OrderEndedBy.CUSTOMER, cancellationReason: 'You cancelled this order.', cancellationNote: null };
    case UserRole.RESTAURANT_OWNER:
      return {
        cancelledBy: OrderEndedBy.RESTAURANT,
        cancellationReason: given ? `The restaurant cancelled this order: ${given}` : 'The restaurant cancelled this order.',
        cancellationNote: given || null,
      };
    default:
      return {
        cancelledBy: OrderEndedBy.SYSTEM,
        cancellationReason: given ? `Delivery Plus cancelled this order: ${given}` : 'Delivery Plus cancelled this order.',
        cancellationNote: given || null,
      };
  }
}
