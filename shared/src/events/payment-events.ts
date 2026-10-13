import { BaseEvent } from './base-event';

export enum PaymentEventType {
  CREATED = 'payment.created',
  COMPLETED = 'payment.completed',
  FAILED = 'payment.failed',
  /** #56: the whole payment was refunded because its order was cancelled (or by support). */
  REFUNDED = 'payment.refunded',
}

export interface PaymentPayload {
  paymentId: string;
  orderId: string;
  /** The paying customer (#5). Optional: events published before it was added have none. */
  customerId?: string;
  amount: number;
  status: string; // PENDING, PROCESSING, COMPLETED, FAILED, REFUNDED
  /** On payment.refunded (#56): the refund record. The refunded amount is `amount` (always the whole payment). */
  refundId?: string;
}

export interface PaymentEvent extends BaseEvent<PaymentPayload> {
  eventType: PaymentEventType;
}
