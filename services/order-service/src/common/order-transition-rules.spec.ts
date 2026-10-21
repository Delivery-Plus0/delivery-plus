import { OrderStatus, ROLES_KEY, UserRole } from '@food-delivery/shared';
import { cancellationRefusal, isRoleAllowedForTransition } from './order-transition-rules';
import { OrdersController } from '../controllers/orders.controller';

describe('order transitions and the SYSTEM principal (#202)', () => {
  const serviceStatuses = [
    OrderStatus.PAYMENT_PENDING, // payment-service
    OrderStatus.CONFIRMED,
    OrderStatus.FAILED,
    OrderStatus.DRIVER_ASSIGNED, // delivery-service
    OrderStatus.PICKED_UP,
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
  ];

  it.each(serviceStatuses)('lets a SYSTEM caller set %s', (status) => {
    expect(isRoleAllowedForTransition(status, UserRole.SYSTEM)).toBe(true);
  });

  it.each([OrderStatus.PREPARING, OrderStatus.READY_FOR_PICKUP])('does not let a SYSTEM caller do the kitchen’s %s', (status) => {
    expect(isRoleAllowedForTransition(status, UserRole.SYSTEM)).toBe(false);
  });

  it('keeps every transition open to staff (ADMIN), and none of the service-only ones to people', () => {
    for (const status of Object.values(OrderStatus)) expect(isRoleAllowedForTransition(status, UserRole.ADMIN)).toBe(true);
    for (const status of [OrderStatus.CONFIRMED, OrderStatus.DRIVER_ASSIGNED, OrderStatus.DELIVERED]) {
      expect(isRoleAllowedForTransition(status, UserRole.CUSTOMER)).toBe(false);
      expect(isRoleAllowedForTransition(status, UserRole.RESTAURANT_OWNER)).toBe(false);
      expect(isRoleAllowedForTransition(status, UserRole.DRIVER)).toBe(false);
    }
  });

  it('lets a SYSTEM caller cancel an order with a driver on it (delivery-service syncing a cancelled delivery)', () => {
    expect(cancellationRefusal(OrderStatus.PICKED_UP, 'system:delivery-service', UserRole.SYSTEM)).toBeNull();
    // Staff still cancel such an order through its delivery, so the driver is released and compensated.
    expect(cancellationRefusal(OrderStatus.PICKED_UP, 'staff-1', UserRole.ADMIN)).toMatch(/cancel its delivery/);
  });

  it('serves the fee split to services only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, OrdersController.prototype.getFeeSplit)).toEqual([UserRole.SYSTEM]);
  });
});
