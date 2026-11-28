import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository, In, FindOptionsWhere } from 'typeorm';
import { BaseEvent, OrderStatus, TOPICS, stageEvent } from '@food-delivery/shared';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { PricingSnapshot } from '../common/pricing';

/** Drop-off address snapshot stored on a new order. */
export interface DeliveryAddress {
  address: string;
  notes: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Who changed an order's status (#217): the kind of caller, its id, and the reason it gave. */
export type HistoryActorType = 'CUSTOMER' | 'RESTAURANT' | 'DRIVER' | 'SYSTEM' | 'STAFF';
export interface HistoryActor {
  actorType: HistoryActorType;
  actorId: string | null;
  reason?: string | null;
}

/** One row of an order's status history (#217), oldest first. */
export interface OrderStatusHistoryRow {
  id: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorType: HistoryActorType;
  actorId: string | null;
  reason: string | null;
  at: Date;
}

/** Builds the event describing the change from the order as written (staged in the same transaction). */
export type OrderEventBuilder = (order: Order) => BaseEvent<unknown>;

export interface NewOrderItem {
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
}

@Injectable()
export class OrdersRepository {
  constructor(
    @InjectRepository(Order)
    private readonly repo: Repository<Order>,
  ) {}

  findById(id: string): Promise<Order | null> {
    return this.repo.findOne({ where: { id } });
  }

  async create(
    customerId: string,
    restaurantId: string,
    items: NewOrderItem[],
    pricing: PricingSnapshot,
    idempotencyKey: string | undefined,
    delivery: DeliveryAddress,
    event: OrderEventBuilder,
    customerFirstName: string | null = null,
  ): Promise<Order> {
    const order = this.repo.create({
      customerFirstName,
      customerId,
      restaurantId,
      status: OrderStatus.CREATED,
      totalAmount: pricing.totalAmount,
      subtotalAmount: pricing.subtotalAmount,
      deliveryFee: pricing.deliveryFee,
      driverFeeShare: pricing.driverFeeShare,
      platformFeeShare: pricing.platformFeeShare,
      driverCancelFeeShare: pricing.driverCancelFeeShare,
      idempotencyKey: idempotencyKey ?? null,
      deliveryAddress: delivery.address,
      deliveryNotes: delivery.notes,
      deliveryLatitude: delivery.latitude,
      deliveryLongitude: delivery.longitude,
      items: items.map(
        (item) =>
          ({
            menuItemId: item.menuItemId,
            name: item.name,
            price: item.price.toFixed(2),
            quantity: item.quantity,
          }) as OrderItem,
      ),
    });
    // The order, its first history row (#217) and its order.created event commit together (transactional outbox, #98).
    return this.repo.manager.transaction(async (manager) => {
      const saved = await manager.getRepository(Order).save(order);
      await recordHistory(manager, saved.id, null, OrderStatus.CREATED, { actorType: 'CUSTOMER', actorId: customerId });
      await stageEvent(manager, TOPICS.ORDER_EVENTS, event(saved));
      return saved;
    });
  }

  findByCustomerAndIdempotencyKey(customerId: string, idempotencyKey: string): Promise<Order | null> {
    return this.repo.findOne({
      where: { customerId, idempotencyKey },
    });
  }

  /**
   * Compare-and-set: moves the order from `from` to `to` only if it is still in `from`, and stages the
   * event for the change and its history row (#217) in the same transaction (only the writer that wins
   * writes either). Returns the
   * updated order, or null when another writer changed it first.
   */
  async updateStatus(
    id: string,
    from: OrderStatus,
    to: OrderStatus,
    event: OrderEventBuilder,
    outcome: Partial<Pick<Order, 'cancelledBy' | 'cancellationReason' | 'cancellationNote'>>,
    actor: HistoryActor,
  ): Promise<Order | null> {
    return this.repo.manager.transaction(async (manager) => {
      const orders = manager.getRepository(Order);
      const result = await orders.update({ id, status: from }, { status: to, ...outcome });
      if (!result.affected) return null;
      const updated = await orders.findOne({ where: { id } });
      if (!updated) return null;
      await recordHistory(manager, id, from, to, actor);
      await stageEvent(manager, TOPICS.ORDER_EVENTS, event(updated));
      return updated;
    });
  }

  /** #217: the order's status history, oldest first. Empty for orders placed before it was recorded. */
  async statusHistory(orderId: string): Promise<OrderStatusHistoryRow[]> {
    return this.repo.query(
      `SELECT "id", "fromStatus", "toStatus", "actorType", "actorId", "reason", "at"
         FROM "order_status_history" WHERE "orderId" = $1 ORDER BY "at" ASC, "id" ASC`,
      [orderId],
    );
  }

  /**
   * Records the payment status learnt from a payment event (#143). Never moves backwards: PENDING only
   * fills an unknown status, and an outcome (COMPLETED / FAILED) only replaces unknown or PENDING, so
   * redelivered or out-of-order events can't undo what is known. Independent of the order status, so
   * a payment that completes after the order was cancelled is still recorded.
   */
  async recordPaymentStatus(id: string, status: string): Promise<void> {
    // Statuses only move forward: PENDING → COMPLETED/FAILED → REFUNDED (#56). REFUNDED is final, and a
    // refund can arrive without its completion ever being recorded (the order was cancelled first).
    const replaceable =
      status === 'PENDING'
        ? '"paymentStatus" IS NULL'
        : status === 'REFUNDED'
          ? '("paymentStatus" IS NULL OR "paymentStatus" <> \'REFUNDED\')'
          : '("paymentStatus" IS NULL OR "paymentStatus" = \'PENDING\')';
    await this.repo.query(`UPDATE "orders" SET "paymentStatus" = $1 WHERE "id" = $2 AND ${replaceable}`, [status, id]);
  }

  /** The internal fee split of an order (#145); null for an unknown order. */
  findFeeSplit(id: string): Promise<Pick<Order, 'id' | 'deliveryFee' | 'driverFeeShare' | 'platformFeeShare' | 'driverCancelFeeShare'> | null> {
    return this.repo
      .createQueryBuilder('o')
      .select(['o.id', 'o.deliveryFee'])
      .addSelect(['o.driverFeeShare', 'o.platformFeeShare', 'o.driverCancelFeeShare'])
      .where('o.id = :id', { id })
      .getOne();
  }

  /**
   * Today's numbers for a restaurant (#154), "today" being the calendar day in Cairo. Revenue is the
   * items' subtotal of orders that weren't cancelled or failed; the delivery fee isn't the restaurant's.
   */
  async todaySummary(restaurantId: string): Promise<{ orders: number; active: number; delivered: number; cancelled: number; revenue: string }> {
    // "createdAt" is timestamptz: AT TIME ZONE 'Africa/Cairo' gives its Cairo wall-clock time directly.
    // (Converting through UTC first read that UTC time as Cairo time, so orders placed 00:00–03:00 UTC,
    // 03:00–06:00 in Cairo, counted as yesterday's.)
    const [row] = (await this.repo.query(
      `SELECT COUNT(*)::int AS "orders",
              COUNT(*) FILTER (WHERE "status" NOT IN ('DELIVERED', 'CANCELLED', 'FAILED'))::int AS "active",
              COUNT(*) FILTER (WHERE "status" = 'DELIVERED')::int AS "delivered",
              COUNT(*) FILTER (WHERE "status" IN ('CANCELLED', 'FAILED'))::int AS "cancelled",
              COALESCE(SUM(COALESCE("subtotalAmount", "totalAmount")) FILTER (WHERE "status" NOT IN ('CANCELLED', 'FAILED')), 0)::numeric(12,2)::text AS "revenue"
         FROM "orders"
        WHERE "restaurantId" = $1
          AND ("createdAt" AT TIME ZONE 'Africa/Cairo')::date = (now() AT TIME ZONE 'Africa/Cairo')::date`,
      [restaurantId],
    )) as { orders: number; active: number; delivered: number; cancelled: number; revenue: string }[];
    return row ?? { orders: 0, active: 0, delivered: 0, cancelled: 0, revenue: '0.00' };
  }

  async findByCustomer(
    customerId: string,
    page: number,
    limit: number,
    statuses: OrderStatus[] | null = null,
  ): Promise<[Order[], number]> {
    return this.repo.findAndCount({
      where: statuses ? { customerId, status: In(statuses) } : { customerId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  async findByRestaurant(restaurantId: string, page: number, limit: number): Promise<[Order[], number]> {
    return this.repo.findAndCount({
      where: { restaurantId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  /**
   * #212: staff list of every order. Explicit filters only (ids, status group), plus
   * a free-text `q` over the order and customer ids. No cross-service joins.
   */
  async findForAdmin(
    page: number,
    limit: number,
    options: {
      statuses?: OrderStatus[] | null;
      q?: string;
      id?: string;
      customerId?: string;
      restaurantId?: string;
      sort?: 'ASC' | 'DESC';
    } = {},
  ): Promise<[Order[], number]> {
    const where: FindOptionsWhere<Order> = {};
    if (options.statuses) where.status = In(options.statuses);
    if (options.id) where.id = options.id;
    if (options.customerId) where.customerId = options.customerId;
    if (options.restaurantId) where.restaurantId = options.restaurantId;

    // q is a free-text probe, never a leak: it only matches full ids typed by staff.
    const trimmed = options.q?.trim();
    if (trimmed) {
      const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
      if (uuidLike && !where.id) where.id = trimmed;
      else if (!uuidLike) return [[], 0];
    }

    return this.repo.findAndCount({
      where,
      order: { createdAt: options.sort === 'ASC' ? 'ASC' : 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  /**
   * #214: orders a restaurant received today, by the Cairo calendar day (the platform's day,
   * whatever the server's time zone). Cancelled and failed orders count: staff see the demand.
   */
  async countTodayForRestaurant(restaurantId: string, now = new Date()): Promise<number> {
    const [row] = (await this.repo.query(
      `SELECT count(*)::int AS "count" FROM "orders"
        WHERE "restaurantId" = $1
          AND "createdAt" >= (date_trunc('day', $2::timestamptz AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo')
          AND "createdAt" <  (date_trunc('day', $2::timestamptz AT TIME ZONE 'Africa/Cairo') AT TIME ZONE 'Africa/Cairo') + interval '1 day'`,
      [restaurantId, now.toISOString()],
    )) as { count: number }[];
    return row?.count ?? 0;
  }
}

/** One history row, inside the caller's transaction (#217). Reasons are capped at the column's 500 characters. */
async function recordHistory(manager: EntityManager, orderId: string, from: OrderStatus | null, to: OrderStatus, actor: HistoryActor): Promise<void> {
  await manager.query(
    `INSERT INTO "order_status_history" ("orderId", "fromStatus", "toStatus", "actorType", "actorId", "reason") VALUES ($1, $2, $3, $4, $5, $6)`,
    [orderId, from, to, actor.actorType, actor.actorId, actor.reason ? actor.reason.slice(0, 500) : null],
  );
}
