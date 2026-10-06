import { BaseEvent } from './base-event';

export enum DeliveryEventType {
  CREATED = 'delivery.created',
  DRIVER_ASSIGNED = 'delivery.driver_assigned',
  PICKED_UP = 'delivery.picked_up',
  IN_TRANSIT = 'delivery.in_transit',
  COMPLETED = 'delivery.completed',
  CANCELLED = 'delivery.cancelled',
}

export interface DeliveryPayload {
  deliveryId: string;
  orderId: string;
  /** The order's customer (#5). Optional: deliveries created before it was stored have none. */
  customerId?: string;
  driverId?: string;
  /**
   * Assignment contract (#46): when the current driver's claim was accepted (ISO 8601), set by
   * delivery-service in the same write as the assignment. Present on every event after the assignment;
   * optional because deliveries assigned before it was recorded may lack it.
   */
  assignedAt?: string;
  status: string; // PENDING, ASSIGNED, PICKED_UP, IN_TRANSIT, DELIVERED, CANCELLED
}

export interface DeliveryEvent extends BaseEvent<DeliveryPayload> {
  eventType: DeliveryEventType;
}
