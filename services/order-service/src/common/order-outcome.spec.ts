import { OrderStatus, UserRole } from '@food-delivery/shared';
import { OrderEndedBy, outcomeFor } from './order-outcome';

describe('outcomeFor', () => {
  it('records a declined payment for FAILED, whoever syncs it', () => {
    for (const role of [UserRole.ADMIN, UserRole.CUSTOMER]) {
      expect(outcomeFor(OrderStatus.FAILED, role)).toEqual({
        cancelledBy: OrderEndedBy.PAYMENT,
        cancellationReason: 'Your payment was declined, so the order was not placed.',
      });
    }
  });

  it('records the customer cancelling, ignoring any free text', () => {
    expect(outcomeFor(OrderStatus.CANCELLED, UserRole.CUSTOMER, 'whatever')).toEqual({
      cancelledBy: OrderEndedBy.CUSTOMER,
      cancellationReason: 'You cancelled this order.',
    });
  });

  it("records the restaurant cancelling, with its own reason when given", () => {
    expect(outcomeFor(OrderStatus.CANCELLED, UserRole.RESTAURANT_OWNER)).toEqual({
      cancelledBy: OrderEndedBy.RESTAURANT,
      cancellationReason: 'The restaurant cancelled this order.',
    });
    expect(outcomeFor(OrderStatus.CANCELLED, UserRole.RESTAURANT_OWNER, '  Out of stock ')).toEqual({
      cancelledBy: OrderEndedBy.RESTAURANT,
      cancellationReason: 'The restaurant cancelled this order: Out of stock',
    });
  });

  it('records the platform for system (ADMIN-role) cancellations', () => {
    expect(outcomeFor(OrderStatus.CANCELLED, UserRole.ADMIN)).toEqual({
      cancelledBy: OrderEndedBy.SYSTEM,
      cancellationReason: 'Delivery Plus cancelled this order.',
    });
  });

  it('records nothing for statuses that do not end an order unsuccessfully', () => {
    for (const status of [OrderStatus.CONFIRMED, OrderStatus.PREPARING, OrderStatus.DELIVERED]) {
      expect(outcomeFor(status, UserRole.ADMIN)).toBeNull();
    }
  });
});
