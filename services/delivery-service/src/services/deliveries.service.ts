import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestError,
  ConflictError,
  DELIVERY_TRANSITIONS,
  DeliveryStatus,
  DriverStatus,
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  OrderStatus,
  UserRole,
  isTransitionAllowed,
  DeliveryEventType,
  DeliveryEvent,
  generateCorrelationId,
  lifecycleEventId,
} from '@food-delivery/shared';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { OrderServiceClient } from '../common/order-service.client';
import { DriverDto, DriverServiceClient, DriverStatusRejectedError } from '../common/driver-service.client';
import { RestaurantServiceClient } from '../common/restaurant-service.client';
import { OutboxRelayService } from '../common/outbox-relay.service';
import { DriverCurrentDeliveryDto, NEXT_DRIVER_ACTIONS } from '../dto/driver-current-delivery.dto';
import { CreateDeliveryDto } from '../dto/create-delivery.dto';
import { Delivery } from '../entities/delivery.entity';

const DISPATCH_ROLES = [UserRole.RESTAURANT_OWNER, UserRole.ADMIN];

/** PostgreSQL unique_violation, as surfaced by TypeORM's QueryFailedError. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

/** How many drivers one assignment tries when it keeps losing claims to concurrent assignments. */
const MAX_DRIVER_CLAIM_ATTEMPTS = 3;

/** The order statuses a delivery drives, in order. */
const ORDER_DELIVERY_PATH = [
  OrderStatus.READY_FOR_PICKUP,
  OrderStatus.DRIVER_ASSIGNED,
  OrderStatus.PICKED_UP,
  OrderStatus.DELIVERED,
];

/** Who is acting on a delivery; `authHeader` is forwarded to order-service for ownership checks. */
export interface DeliveryRequester {
  userId: string;
  role: UserRole;
  authHeader: string;
}

/**
 * The lifecycle event for a delivery as written. Keyed by orderId (same partition as the order's own
 * events); the eventId is stable per (delivery, event type), so it is staged and consumed once.
 */
function deliveryEvent(eventType: DeliveryEventType, delivery: Delivery): DeliveryEvent {
  return {
    eventId: lifecycleEventId(delivery.id, eventType),
    eventType,
    timestamp: new Date().toISOString(),
    correlationId: generateCorrelationId(),
    payload: {
      deliveryId: delivery.id,
      orderId: delivery.orderId,
      customerId: delivery.customerId || undefined,
      driverId: delivery.driverId || undefined,
      assignedAt: delivery.assignedAt ? new Date(delivery.assignedAt).toISOString() : undefined,
      status: delivery.status,
    },
  };
}

/** The stage timestamp written together with a move to `target` (#142); assignment has its own. */
export function stageTime(target: DeliveryStatus, now = new Date()): Partial<Delivery> {
  switch (target) {
    case DeliveryStatus.PICKED_UP:
      return { pickedUpAt: now };
    case DeliveryStatus.DELIVERED:
      return { deliveredAt: now };
    case DeliveryStatus.CANCELLED:
      return { cancelledAt: now };
    default:
      return {};
  }
}

@Injectable()
export class DeliveriesService {
  private readonly logger = new Logger(DeliveriesService.name);

  constructor(
    private readonly deliveries: DeliveriesRepository,
    private readonly orderClient: OrderServiceClient,
    private readonly driverClient: DriverServiceClient,
    private readonly outbox: OutboxRelayService,
    private readonly restaurantClient: RestaurantServiceClient,
  ) {}

  async create(requester: DeliveryRequester, dto: CreateDeliveryDto): Promise<Delivery> {
    await this.assertCanDispatch(dto.orderId, requester);

    const existing = await this.deliveries.findByOrderId(dto.orderId);
    if (existing) {
      throw new ConflictError(`A delivery already exists for order ${dto.orderId}`);
    }

    const order = await this.orderClient.getOrder(dto.orderId);
    if (order.status !== OrderStatus.READY_FOR_PICKUP) {
      throw new BadRequestError(
        `Order ${dto.orderId} is not ready for pickup (status ${order.status})`,
      );
    }

    let delivery: Delivery;
    try {
      delivery = await this.deliveries.create(dto.orderId, order.customerId ?? null, (created) =>
        deliveryEvent(DeliveryEventType.CREATED, created),
      );
    } catch (error) {
      // Two creates (e.g. auto-dispatch and a manual dispatch) passed the check above at the same
      // time; the unique index on orderId let only one insert through.
      if (isUniqueViolation(error)) {
        throw new ConflictError(`A delivery already exists for order ${dto.orderId}`);
      }
      throw error;
    }
    this.outbox.kick();
    return delivery;
  }

  /*
   * Retry safety. Each action writes the delivery and stages its event in one transaction
   * (compare-and-set + outbox, #98), then runs its side effects: order-service sync and driver release.
   * The event is published whatever happens next, and order-service converges from it, so the order
   * catches up even if the HTTP sync fails. If a side effect fails (a service is down, or this one
   * restarts mid-request) the request errors but the delivery has already moved. Repeating the same
   * action on a delivery that is already in the target status therefore skips the write and re-runs
   * the side effects, each of which is idempotent, instead of answering 409. Without that, a failed
   * driver release after DELIVERED left the driver BUSY for good.
   */

  async assignDriver(deliveryId: string, requester: DeliveryRequester): Promise<Delivery> {
    this.assertDispatchRole(requester.role);
    const delivery = await this.findOrThrow(deliveryId);
    await this.assertCanDispatch(delivery.orderId, requester);
    if (delivery.status === DeliveryStatus.DRIVER_ASSIGNED) {
      return this.afterDriverAssigned(delivery); // retry: the driver is already claimed
    }
    this.assertTransition(delivery.status, DeliveryStatus.DRIVER_ASSIGNED);

    const driver = await this.claimAvailableDriver();
    let updated: Delivery | null;
    try {
      updated = await this.deliveries.transition(
        deliveryId,
        delivery.status,
        { driverId: driver.id, status: DeliveryStatus.DRIVER_ASSIGNED, assignedAt: new Date() },
        (assigned) => deliveryEvent(DeliveryEventType.DRIVER_ASSIGNED, assigned),
      );
    } catch (error) {
      await this.giveBackClaimedDriver(driver.id);
      throw error;
    }
    if (!updated) {
      // Another request (a concurrent assign or cancel) moved the delivery first.
      await this.giveBackClaimedDriver(driver.id);
      const current = await this.findOrThrow(deliveryId);
      if (current.status !== DeliveryStatus.DRIVER_ASSIGNED) {
        throw new InvalidStateTransitionError('Delivery', current.status, DeliveryStatus.DRIVER_ASSIGNED);
      }
      return this.afterDriverAssigned(current);
    }
    this.outbox.kick();
    return this.afterDriverAssigned(updated);
  }

  async pickup(deliveryId: string, requesterId: string, requesterRole: UserRole): Promise<Delivery> {
    const delivery = await this.findOrThrow(deliveryId);
    await this.assertAssignedDriver(delivery, requesterId, requesterRole);
    return this.advance(delivery, DeliveryStatus.PICKED_UP, DeliveryEventType.PICKED_UP, async (updated) => {
      await this.syncOrderAlongDelivery(updated.orderId, OrderStatus.PICKED_UP);
    });
  }

  async start(deliveryId: string, requesterId: string, requesterRole: UserRole): Promise<Delivery> {
    const delivery = await this.findOrThrow(deliveryId);
    await this.assertAssignedDriver(delivery, requesterId, requesterRole);
    return this.advance(delivery, DeliveryStatus.IN_TRANSIT, DeliveryEventType.IN_TRANSIT, async (updated) => {
      // The order has no IN_TRANSIT counterpart and stays PICKED_UP until DELIVERED; syncing it here
      // repairs a pickup whose order update failed before the driver moved on.
      await this.syncOrderAlongDelivery(updated.orderId, OrderStatus.PICKED_UP);
    });
  }

  async complete(deliveryId: string, requesterId: string, requesterRole: UserRole): Promise<Delivery> {
    const delivery = await this.findOrThrow(deliveryId);
    await this.assertAssignedDriver(delivery, requesterId, requesterRole);
    return this.advance(delivery, DeliveryStatus.DELIVERED, DeliveryEventType.COMPLETED, async (updated) => {
      // Driver first: freeing the driver must not depend on order-service being reachable.
      await this.releaseDriverOf(updated);
      await this.syncOrderAlongDelivery(updated.orderId, OrderStatus.DELIVERED);
    });
  }

  async cancel(deliveryId: string, requester: DeliveryRequester): Promise<Delivery> {
    this.assertDispatchRole(requester.role);
    const delivery = await this.findOrThrow(deliveryId);
    await this.assertCanDispatch(delivery.orderId, requester);
    return this.advance(delivery, DeliveryStatus.CANCELLED, DeliveryEventType.CANCELLED, async (updated) => {
      await this.releaseDriverOf(updated);
      await this.orderClient.updateOrderStatus(updated.orderId, OrderStatus.CANCELLED);
    });
  }

  /**
   * The calling driver's active delivery with what they need to act on it (pickup, drop-off, order
   * summary, next actions), or null when they have none or no driver profile yet. Which driver is
   * asking comes from their own token via driver-service; nothing is taken from the request.
   */
  async getCurrentForDriver(authHeader: string): Promise<DriverCurrentDeliveryDto | null> {
    const driver = await this.driverClient.getOwnProfile(authHeader);
    if (!driver) return null;

    const active = await this.deliveries.findActiveByDriverId(driver.id);
    if (active.length === 0) return null;
    if (active.length > 1) {
      // Claims are exclusive (#33), so this means drift; show the most recent rather than failing.
      this.logger.warn(`Driver ${driver.id} has ${active.length} active deliveries; returning the most recent`);
    }
    const delivery = active.reduce((latest, d) => (d.updatedAt > latest.updatedAt ? d : latest));

    const order = await this.orderClient.getOrder(delivery.orderId);
    const restaurant = await this.restaurantClient.getRestaurant(order.restaurantId);

    return {
      id: delivery.id,
      status: delivery.status,
      orderId: delivery.orderId,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
      assignedAt: delivery.assignedAt ?? null,
      pickup: { restaurantId: restaurant.id, name: restaurant.name, address: restaurant.address },
      dropOff: {
        address: order.deliveryAddress ?? null,
        notes: order.deliveryNotes ?? null,
        latitude: order.deliveryLatitude ?? null,
        longitude: order.deliveryLongitude ?? null,
      },
      order: {
        id: order.id,
        items: (order.items ?? []).map((item) => ({ name: item.name, quantity: item.quantity })),
        totalAmount: order.totalAmount ?? '0.00',
      },
      nextActions: NEXT_DRIVER_ACTIONS[delivery.status] ?? [],
    };
  }

  async getById(id: string, reader: DeliveryRequester): Promise<Delivery> {
    const delivery = await this.findOrThrow(id);
    await this.assertCanRead(delivery, reader);
    return delivery;
  }

  /**
   * Resolves the delivery for an order. For customers and restaurant owners the order is checked
   * first, so someone else's order is a 403/404 on the order and never reveals whether a delivery
   * exists. A 404 after a successful order check means the delivery has not been created yet.
   */
  async getByOrderId(orderId: string, reader: DeliveryRequester): Promise<Delivery> {
    if (reader.role === UserRole.CUSTOMER || reader.role === UserRole.RESTAURANT_OWNER) {
      await this.orderClient.assertReadableBy(orderId, reader.authHeader);
    } else if (reader.role !== UserRole.ADMIN && reader.role !== UserRole.DRIVER) {
      throw new ForbiddenError('You do not have access to this delivery');
    }

    const delivery = await this.deliveries.findByOrderId(orderId);
    if (!delivery) {
      throw new NotFoundError(`No delivery has been created for order ${orderId} yet`);
    }
    if (reader.role === UserRole.DRIVER) {
      await this.assertIsAssignedDriver(delivery, reader.userId);
    }
    return delivery;
  }

  /** Read access follows the ownership chain: JWT → order ownership (or assignment) → delivery. */
  private async assertCanRead(delivery: Delivery, reader: DeliveryRequester): Promise<void> {
    switch (reader.role) {
      case UserRole.ADMIN:
        return;
      case UserRole.DRIVER:
        return this.assertIsAssignedDriver(delivery, reader.userId);
      case UserRole.CUSTOMER:
      case UserRole.RESTAURANT_OWNER:
        return this.orderClient.assertReadableBy(delivery.orderId, reader.authHeader);
      default:
        throw new ForbiddenError('You do not have access to this delivery');
    }
  }

  private async assertIsAssignedDriver(delivery: Delivery, userId: string): Promise<void> {
    if (!delivery.driverId) {
      throw new ForbiddenError('You are not the driver assigned to this delivery');
    }
    const driver = await this.driverClient.getDriver(delivery.driverId);
    if (driver.userId !== userId) {
      throw new ForbiddenError('You are not the driver assigned to this delivery');
    }
  }

  /**
   * Dispatch (create/assign/cancel) is for admins and the owner of the order's restaurant only.
   * order-service decides restaurant ownership when asked with the owner's own token.
   */
  private async assertCanDispatch(orderId: string, requester: DeliveryRequester): Promise<void> {
    this.assertDispatchRole(requester.role);
    if (requester.role === UserRole.RESTAURANT_OWNER) {
      await this.orderClient.assertReadableBy(orderId, requester.authHeader);
    }
  }

  private assertDispatchRole(role: UserRole): void {
    if (!DISPATCH_ROLES.includes(role)) {
      throw new ForbiddenError('Only a restaurant owner or admin can dispatch deliveries');
    }
  }

  private assertTransition(from: DeliveryStatus, to: DeliveryStatus): void {
    if (!isTransitionAllowed(DELIVERY_TRANSITIONS, from, to)) {
      throw new InvalidStateTransitionError('Delivery', from, to);
    }
  }

  private async assertAssignedDriver(
    delivery: Delivery,
    requesterId: string,
    requesterRole: UserRole,
  ): Promise<void> {
    if (requesterRole === UserRole.ADMIN) return;
    if (requesterRole !== UserRole.DRIVER) {
      throw new ForbiddenError('Only the assigned driver (or admin) can perform this action');
    }
    if (!delivery.driverId) {
      throw new ConflictError('No driver is assigned to this delivery yet');
    }
    const driver = await this.driverClient.getDriver(delivery.driverId);
    if (driver.userId !== requesterId) {
      throw new ForbiddenError('You are not the driver assigned to this delivery');
    }
  }

  /**
   * Moves the delivery to `target` (compare-and-set, staging `eventType` in the same transaction) and
   * runs `effects`. Already at `target` → the write is skipped (its event was staged with it) and the
   * effects run again (retry after a failed side effect).
   */
  private async advance(
    delivery: Delivery,
    target: DeliveryStatus,
    eventType: DeliveryEventType,
    effects: (updated: Delivery) => Promise<void>,
  ): Promise<Delivery> {
    let current = delivery;
    if (delivery.status !== target) {
      this.assertTransition(delivery.status, target);
      const updated = await this.deliveries.transition(delivery.id, delivery.status, { status: target, ...stageTime(target) }, (moved) =>
        deliveryEvent(eventType, moved),
      );
      if (updated) this.outbox.kick();
      current = updated ?? (await this.findOrThrow(delivery.id));
      if (current.status !== target) {
        // Lost the race to a request that moved it elsewhere (e.g. cancel vs complete).
        throw new InvalidStateTransitionError('Delivery', current.status, target);
      }
    }
    await effects(current);
    return current;
  }

  private async afterDriverAssigned(delivery: Delivery): Promise<Delivery> {
    await this.syncOrderAlongDelivery(delivery.orderId, OrderStatus.DRIVER_ASSIGNED);
    return delivery;
  }

  /**
   * Frees the delivery's driver. Skipped when the driver already has another active delivery: a
   * retried completion must never free a driver who has since been assigned elsewhere.
   */
  private async releaseDriverOf(delivery: Delivery): Promise<void> {
    if (!delivery.driverId) return;
    const active = await this.deliveries.findActiveByDriverId(delivery.driverId);
    if (active.some((other) => other.id !== delivery.id)) {
      this.logger.warn(
        `Not releasing driver ${delivery.driverId} for delivery ${delivery.id}: they are on another active delivery`,
      );
      return;
    }
    await this.driverClient.releaseDriver(delivery.driverId);
  }

  /** assignDriver claimed a driver but could not record the assignment: give the driver back. */
  /**
   * Picks an available driver and claims them (AVAILABLE -> BUSY). driver-service's claim is
   * compare-and-set, so when two assignments race for the same driver exactly one wins; the loser
   * gets DriverStatusRejectedError and moves on to the next available driver.
   */
  private async claimAvailableDriver(): Promise<DriverDto> {
    for (let attempt = 0; attempt < MAX_DRIVER_CLAIM_ATTEMPTS; attempt++) {
      const driver = await this.driverClient.findAvailableDriver();
      if (!driver) break;
      try {
        await this.driverClient.updateDriverStatus(driver.id, DriverStatus.BUSY);
        return driver;
      } catch (error) {
        if (!(error instanceof DriverStatusRejectedError)) throw error;
        this.logger.warn(`Driver ${driver.id} was claimed by another assignment first; trying the next one`);
      }
    }
    throw new ConflictError('No available drivers to assign');
  }

  private async giveBackClaimedDriver(driverId: string): Promise<void> {
    try {
      await this.driverClient.releaseDriver(driverId);
    } catch (error) {
      this.logger.error(`Driver ${driverId} was claimed for an assignment that failed and is still BUSY`, error);
    }
  }

  /**
   * Moves the order forward along the delivery path up to `target`, one allowed step at a time, so an
   * order left behind by an earlier failed sync catches up (READY_FOR_PICKUP → DRIVER_ASSIGNED →
   * PICKED_UP → DELIVERED). An order already at or past `target` is left alone. An order that left the
   * path (e.g. CANCELLED) is not forced back; that is logged, so the delivery (and the driver release)
   * still complete.
   */
  private async syncOrderAlongDelivery(orderId: string, target: OrderStatus): Promise<void> {
    const order = await this.orderClient.getOrder(orderId);
    const from = ORDER_DELIVERY_PATH.indexOf(order.status);
    const to = ORDER_DELIVERY_PATH.indexOf(target);
    if (from === -1) {
      this.logger.warn(`Order ${orderId} is ${order.status}; not moving it to ${target}`);
      return;
    }
    for (let step = from + 1; step <= to; step++) {
      await this.orderClient.updateOrderStatus(orderId, ORDER_DELIVERY_PATH[step]);
    }
  }

  private async findOrThrow(id: string): Promise<Delivery> {
    const delivery = await this.deliveries.findById(id);
    if (!delivery) {
      throw new NotFoundError(`Delivery ${id} not found`);
    }
    return delivery;
  }
}
