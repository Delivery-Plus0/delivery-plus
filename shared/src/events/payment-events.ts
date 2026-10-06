import { BaseEvent } from './base-event';

export enum PaymentEventType {
  CREATED = 'payment.created',
  COMPLETED = 'payment.completed',
  FAILED = 'payment.failed',
}

export interface PaymentPayload {
  paymentId: string;
  orderId: string;
  /** The paying customer (#5). Optional: events published before it was added have none. */
  customerId?: string;
  amount: number;
  status: string; // PENDING, PROCESSING, COMPLETED, FAILED
}

export interface PaymentEvent extends BaseEvent<PaymentPayload> {
  eventType: PaymentEventType;
}
