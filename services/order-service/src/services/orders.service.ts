import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  BadRequestError,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  OrderStatus,
  ORDER_TRANSITIONS,
  PaginatedResult,
  RestaurantStatus,
  UserRole,
  isTransitionAllowed,
  KafkaConsumerService,
  OrderEventType,
  PaymentEventType,
  PaymentEvent,
  DeliveryEventType,
  DeliveryEvent,
  TOPICS,
  OrderEvent,
  generateCorrelationId,
  lifecycleEventId,
  ConflictError,
  OrderPayload,
  PhoneNotVerifiedError,
} from '@food-delivery/shared';
import { DeliveryAddress, OrdersRepository } from '../repositories/orders.repository';
import { OrderPaymentStatus, outcomeFor } from '../common/order-outcome';
import { priceOrder } from '../common/pricing';
import { APP_CONFIG, AppConfig } from '../config/app-config';

export interface OrderQuote {
  subtotalAmount: string;
  deliveryFee: string;
  totalAmount: string;
  currency: 'EGP';
}

export interface OrderFeeSplit {
  orderId: string;
  deliveryFee: string;
  driverFeeShare: string;
  platformFeeShare: string;
  driverCancelFeeShare: string;
}
import { ORDER_LIST_FILTER_STATUSES, OrderListFilter } from '../dto/list-orders-query.dto';
import { CartServiceClient } from '../common/cart-service.client';
import { RestaurantServiceClient } from '../common/restaurant-service.client';
import { UserServiceClient } from '../common/user-service.client';
import { OutboxRelayService } from '../common/outbox-relay.service';
import { isRoleAllowedForTransition } from '../common/order-transition-rules';
import { UpdateOrderStatusDto } from '../dto/update-order-status.dto';
import { CreateOrderDto } from '../dto/create-order.dto';
import { Order } from '../entities/order.entity';

/** The order event for each status an order can be moved to. */
const ORDER_STATUS_EVENTS: Partial<Record<OrderStatus, OrderEventType>> = {
  [OrderStatus.PAYMENT_PENDING]: OrderEventType.PAYMENT_PENDING,
  [OrderStatus.CONFIRMED]: OrderEventType.CONFIRMED,
  [OrderStatus.FAILED]: OrderEventType.FAILED,
  [OrderStatus.CANCELLED]: OrderEventType.CANCELLED,
  [OrderStatus.PREPARING]: OrderEventType.PREPARING,
  [OrderStatus.READY_FOR_PICKUP]: OrderEventType.READY_FOR_PICKUP,
  [OrderStatus.DRIVER_ASSIGNED]: OrderEventType.DRIVER_ASSIGNED,
  [OrderStatus.PICKED_UP]: OrderEventType.PICKED_UP,
  [OrderStatus.DELIVERED]: OrderEventType.DELIVERED,
};

/** The lifecycle event for an order as written; the eventId is stable per (order, event type). */
/**
 * The fee split is internal (#145): reads never select it, but an order just created still holds it
 * in memory, so strip it before the order goes back to the customer.
 */
export function withoutFeeSplit(order: Order): Order {
  const { driverFeeShare, platformFeeShare, driverCancelFeeShare, ...visible } = order;
  void driverFeeShare;
  void platformFeeShare;
  void driverCancelFeeShare;
  return visible as Order;
}

function orderEvent(order: Order, eventType: OrderEventType): OrderEvent {
  return {
    eventId: lifecycleEventId(order.id, eventType),
    eventType,
    timestamp: new Date().toISOString(),
    correlationId: generateCorrelationId(),
    payload: {
      orderId: order.id,
      customerId: order.customerId,
      restaurantId: order.restaurantId,
      total: parseFloat(order.totalAmount),
      status: order.status,
      ...(order.cancelledBy ? { cancelledBy: order.cancelledBy as OrderPayload['cancelledBy'] } : {}),
      ...(order.cancellationReason ? { cancellationReason: order.cancellationReason } : {}),
    },
  };
}

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly orders: OrdersRepository,
    private readonly cartClient: CartServiceClient,
    private readonly restaurantClient: RestaurantServiceClient,
    private readonly outbox: OutboxRelayService,
    private readonly kafkaConsumer: KafkaConsumerService,
    private readonly userClient: UserServiceClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    await this.kafkaConsumer.subscribe<PaymentEvent['payload']>(
      TOPICS.PAYMENT_EVENTS,
      PaymentEventType.CREATED,
      async (event) => {
        await this.orders.recordPaymentStatus(event.payload.orderId, OrderPaymentStatus.PENDING);
        await this.syncStatusFromEvent(event.payload.orderId, OrderStatus.PAYMENT_PENDING);
      },
    );

    await this.kafkaConsumer.subscribe<PaymentEvent['payload']>(
      TOPICS.PAYMENT_EVENTS,
      PaymentEventType.COMPLETED,
      async (event) => {
        await this.orders.recordPaymentStatus(event.payload.orderId, OrderPaymentStatus.COMPLETED);
        await this.syncStatusFromEvent(event.payload.orderId, OrderStatus.CONFIRMED);
      },
    );

    await this.kafkaConsumer.subscribe<PaymentEvent['payload']>(
      TOPICS.PAYMENT_EVENTS,
      PaymentEventType.FAILED,
      async (event) => {
        await this.orders.recordPaymentStatus(event.payload.orderId, OrderPaymentStatus.FAILED);
        // A declined payment is FAILED, not CANCELLED: payment-service syncs the same status over
        // HTTP, so both paths must agree or the second writer hits an invalid transition.
        await this.syncStatusFromEvent(event.payload.orderId, OrderStatus.FAILED);
      },
    );

    await this.kafkaConsumer.subscribe<DeliveryEvent['payload']>(
      TOPICS.DELIVERY_EVENTS,
      DeliveryEventType.DRIVER_ASSIGNED,
      async (event) => {
        await this.syncStatusFromEvent(event.payload.orderId, OrderStatus.DRIVER_ASSIGNED);
      },
    );

    await this.kafkaConsumer.subscribe<DeliveryEvent['payload']>(
      TOPICS.DELIVERY_EVENTS,
      DeliveryEventType.PICKED_UP,
      async (event) => {
        await this.syncStatusFromEvent(event.payload.orderId, OrderStatus.PICKED_UP);
      },
    );

    await this.kafkaConsumer.subscribe<DeliveryEvent['payload']>(
      TOPICS.DELIVERY_EVENTS,
      DeliveryEventType.COMPLETED,
      async (event) => {
        await this.syncStatusFromEvent(event.payload.orderId, OrderStatus.DELIVERED);
      },
    );

    await this.kafkaConsumer.start();
  }

  async createFromCart(
    customerId: string,
    authHeader: string,
    idempotencyKey?: string,
    checkout: CreateOrderDto = {},
  ): Promise<Order> {
    if (idempotencyKey) {
      const prior = await this.orders.findByCustomerAndIdempotencyKey(customerId, idempotencyKey);
      if (prior) {
        return prior;
      }
    }

    if (this.config.phoneVerificationRequired) {
      await this.assertVerifiedPhone(authHeader);
    }

    const cart = await this.cartClient.getCart(authHeader);

    if (cart.items.length === 0 || !cart.restaurantId) {
      throw new BadRequestError('Cart is empty');
    }

    const restaurant = await this.restaurantClient.getRestaurant(cart.restaurantId);
    if (restaurant.status !== RestaurantStatus.OPEN) {
      throw new BadRequestError('Restaurant is currently closed');
    }

    const delivery = await this.resolveDeliveryAddress(checkout, authHeader);
    const customerFirstName = await this.customerFirstName(authHeader);

    try {
      const order = await this.orders.create(
        customerId,
        cart.restaurantId,
        cart.items.map((item) => ({
          menuItemId: item.menuItemId,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
        })),
        // Fee and split are priced here and stored with the order (#145).
        priceOrder(cart.total, this.config.pricing),
        idempotencyKey,
        delivery,
        (created) => orderEvent(created, OrderEventType.CREATED),
        customerFirstName,
      );
      this.outbox.kick();

      await this.cartClient.clearCart(authHeader);

      return withoutFeeSplit(order);
    } catch (error) {
      if (idempotencyKey) {
        const winner = await this.orders.findByCustomerAndIdempotencyKey(customerId, idempotencyKey);
        if (winner) {
          return winner;
        }
      }
      throw error;
    }
  }

  /** What checking out the current cart would cost (#145), priced by the same rules as the order. */
  async quote(authHeader: string): Promise<OrderQuote> {
    const cart = await this.cartClient.getCart(authHeader);
    const { subtotalAmount, deliveryFee, totalAmount } = priceOrder(cart.items.length ? cart.total : 0, this.config.pricing);
    return { subtotalAmount, deliveryFee, totalAmount, currency: 'EGP' };
  }

  /** The order's internal fee split, for delivery-service's earnings ledger (ADMIN-only route). */
  async getFeeSplit(id: string): Promise<OrderFeeSplit> {
    const split = await this.orders.findFeeSplit(id);
    if (!split) throw new NotFoundError(`Order ${id} not found`);
    return {
      orderId: split.id,
      deliveryFee: split.deliveryFee ?? '0.00',
      driverFeeShare: split.driverFeeShare ?? '0.00',
      platformFeeShare: split.platformFeeShare ?? '0.00',
      driverCancelFeeShare: split.driverCancelFeeShare ?? '0.00',
    };
  }

  async getById(id: string, requesterId: string, requesterRole: UserRole): Promise<Order> {
    const order = await this.findOrThrow(id);

    if (requesterRole === UserRole.ADMIN || order.customerId === requesterId) {
      return order;
    }

    if (requesterRole === UserRole.RESTAURANT_OWNER) {
      await this.restaurantClient.assertOwnership(order.restaurantId, requesterId);
      return order;
    }

    throw new ForbiddenError('You do not have access to this order');
  }

  /**
   * The drop-off address for a new order: the one sent at checkout, otherwise the customer's profile
   * address. It is copied onto the order, so later profile edits never move a placed order.
   * Coordinates are only taken together with an address sent at checkout.
   */
  private async resolveDeliveryAddress(checkout: CreateOrderDto, authHeader: string): Promise<DeliveryAddress> {
    const notes = checkout.deliveryNotes || null;
    if (checkout.deliveryAddress) {
      return {
        address: checkout.deliveryAddress,
        notes,
        latitude: checkout.deliveryLatitude ?? null,
        longitude: checkout.deliveryLongitude ?? null,
      };
    }
    if (checkout.deliveryLatitude !== undefined || checkout.deliveryLongitude !== undefined) {
      throw new BadRequestError('deliveryLatitude/deliveryLongitude require a deliveryAddress');
    }

    const profileAddress = (await this.userClient.getOwnProfile(authHeader)).address?.trim();
    if (!profileAddress) {
      throw new BadRequestError(
        'A delivery address is required: send deliveryAddress or add an address to your profile',
      );
    }
    return { address: profileAddress, notes, latitude: null, longitude: null };
  }

  /** Today's orders and item revenue for the owner's restaurant (#154). */
  async todaySummary(restaurantId: string, requesterId: string) {
    await this.restaurantClient.assertOwnership(restaurantId, requesterId);
    return { restaurantId, timezone: 'Africa/Cairo', currency: 'EGP', ...(await this.orders.todaySummary(restaurantId)) };
  }

  /** #153: ordering needs a verified phone when the gate is on; the app answers with the verification step. */
  private async assertVerifiedPhone(authHeader: string): Promise<void> {
    const profile = await this.userClient.getOwnProfile(authHeader);
    if (!profile.phoneVerifiedAt) {
      throw new PhoneNotVerifiedError('Verify your phone number to place orders.');
    }
  }

  /** The customer's first name for the kitchen (#154); best effort, checkout never fails over it. */
  private async customerFirstName(authHeader: string): Promise<string | null> {
    try {
      const fullName = (await this.userClient.getOwnProfile(authHeader)).fullName?.trim();
      return fullName ? fullName.split(/\s+/)[0].slice(0, 60) : null;
    } catch {
      return null;
    }
  }

  async listByCustomer(customerId: string, page: number, limit: number, filter?: OrderListFilter): Promise<PaginatedResult<Order>> {
    const statuses = filter ? ORDER_LIST_FILTER_STATUSES[filter] : null;
    const [items, total] = await this.orders.findByCustomer(customerId, page, limit, statuses);
    return { items, page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
  }

  async listByRestaurant(
    restaurantId: string,
    requesterId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedResult<Order>> {
    await this.restaurantClient.assertOwnership(restaurantId, requesterId);
    const [items, total] = await this.orders.findByRestaurant(restaurantId, page, limit);
    return { items, page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
  }

  async updateStatus(
    id: string,
    requesterId: string,
    requesterRole: UserRole,
    dto: UpdateOrderStatusDto,
  ): Promise<Order> {
    const order = await this.findOrThrow(id);

    if (!isRoleAllowedForTransition(dto.status, requesterRole)) {
      throw new ForbiddenError(`Role ${requesterRole} cannot set order status to ${dto.status}`);
    }

    if (requesterRole === UserRole.CUSTOMER && order.customerId !== requesterId) {
      throw new ForbiddenError('You do not own this order');
    }

    if (requesterRole === UserRole.RESTAURANT_OWNER) {
      await this.restaurantClient.assertOwnership(order.restaurantId, requesterId);
      // A restaurant rejects an order before cooking it, never mid-way (#154).
      if (dto.status === OrderStatus.CANCELLED && order.status !== OrderStatus.CONFIRMED && order.status !== OrderStatus.CANCELLED) {
        throw new ConflictError('An order can only be rejected before you start preparing it.');
      }
    }

    if (order.status === dto.status) {
      return order;
    }

    if (!isTransitionAllowed(ORDER_TRANSITIONS, order.status, dto.status)) {
      throw new InvalidStateTransitionError('Order', order.status, dto.status);
    }

    const eventType = ORDER_STATUS_EVENTS[dto.status] ?? OrderEventType.CREATED;

    // Compare-and-set so two writers racing to the same status (e.g. payment-service's HTTP sync and
    // the payment.completed consumer) cannot both "win"; only the winner stages the event, in the same
    // transaction as the change (transactional outbox, #98).
    // Who ended the order and why is written in the same compare-and-set as the status (#143).
    const outcome = outcomeFor(dto.status, requesterRole, dto.reason) ?? {};
    const updated = await this.orders.updateStatus(id, order.status, dto.status, (changed) => orderEvent(changed, eventType), outcome);
    if (!updated) {
      const current = await this.findOrThrow(id);
      if (current.status === dto.status) {
        return current; // Lost the race to a writer with the same target: already applied, publish nothing.
      }
      throw new InvalidStateTransitionError('Order', current.status, dto.status);
    }
    this.outbox.kick();

    return updated as Order;
  }

  /**
   * Applies the order status implied by a payment or delivery event. payment-service and
   * delivery-service own these transitions and also sync them over HTTP, so the event is a
   * convergence path: it must tolerate arriving after the HTTP sync (same status → no-op), being
   * redelivered, or arriving after the order has moved on (e.g. a late driver_assigned once the
   * order is picked up, or the customer cancelled while payment was pending) without failing the
   * consumer and ending up in the dead-letter topic.
   */
  async syncStatusFromEvent(orderId: string, target: OrderStatus): Promise<void> {
    const order = await this.orders.findById(orderId);
    if (!order) {
      this.logger.warn(`Ignoring event for unknown order ${orderId}`);
      return;
    }
    if (order.status === target) return;
    if (!isTransitionAllowed(ORDER_TRANSITIONS, order.status, target)) {
      this.logger.warn(`Ignoring stale event: order ${orderId} is ${order.status}, not moving to ${target}`);
      return;
    }
    await this.updateStatus(orderId, 'system', UserRole.ADMIN, { status: target });
  }

  private async findOrThrow(id: string): Promise<Order> {
    const order = await this.orders.findById(id);
    if (!order) {
      throw new NotFoundError(`Order ${id} not found`);
    }
    return order;
  }
}
