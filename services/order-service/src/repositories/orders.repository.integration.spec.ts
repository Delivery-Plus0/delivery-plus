/**
 * order-service SQL against real PostgreSQL (#214): today's orders of a restaurant by the Cairo
 * calendar day, across the UTC midnight and in summer time (Egypt is UTC+3 from April to October).
 *
 * Opt-in: ORDER_TEST_DATABASE_URL, a DISPOSABLE database (the public schema is dropped and recreated).
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { OrderStatus } from '@food-delivery/shared';
import { Order } from '../entities/order.entity';
import { OrderItem } from '../entities/order-item.entity';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { OrdersRepository } from './orders.repository';

const DATABASE_URL = process.env.ORDER_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('OrdersRepository.countTodayForRestaurant (PostgreSQL integration, #214)', () => {
  jest.setTimeout(30_000);
  let ds: DataSource;
  let repo: OrdersRepository;
  const restaurantId = randomUUID();

  beforeAll(async () => {
    ds = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [Order, OrderItem]));
    await ds.initialize();
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
    repo = new OrdersRepository(ds.getRepository(Order));
    const add = (createdAt: string, restaurant = restaurantId, status = 'DELIVERED') =>
      ds.query(`INSERT INTO "orders" ("id", "customerId", "restaurantId", "status", "totalAmount", "createdAt") VALUES ($1, $2, $3, $4, 100, $5)`, [
        randomUUID(),
        randomUUID(),
        restaurant,
        status,
        createdAt,
      ]);
    // Winter (UTC+2): the Cairo day of 2026-11-27 is 2026-11-26T22:00Z to 2026-11-27T22:00Z.
    await add('2026-11-26T21:59:00Z'); // 23:59 on the 26th in Cairo
    await add('2026-11-26T22:00:00Z'); // 00:00 on the 27th
    await add('2026-11-27T12:00:00Z', restaurantId, 'CANCELLED');
    await add('2026-11-27T21:59:00Z'); // 23:59 on the 27th
    await add('2026-11-27T22:00:00Z'); // 00:00 on the 28th
    await add('2026-11-27T12:00:00Z', randomUUID()); // another restaurant
    // Summer (UTC+3): the Cairo day of 2026-07-15 starts at 2026-07-14T21:00Z.
    await add('2026-07-14T20:59:00Z');
    await add('2026-07-14T21:00:00Z');
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('counts the Cairo calendar day, cancelled orders included, one restaurant only', async () => {
    expect(await repo.countTodayForRestaurant(restaurantId, new Date('2026-11-27T08:00:00Z'))).toBe(3);
    // Just after midnight in Cairo (still the 27th in UTC) it's already the 28th.
    expect(await repo.countTodayForRestaurant(restaurantId, new Date('2026-11-27T22:30:00Z'))).toBe(1);
  });

  it('follows summer time', async () => {
    expect(await repo.countTodayForRestaurant(restaurantId, new Date('2026-07-15T10:00:00Z'))).toBe(1);
  });
});

describeDb('OrdersRepository status history (PostgreSQL integration, #217)', () => {
  jest.setTimeout(30_000);
  let ds: DataSource;
  let repo: OrdersRepository;
  const event = (order: Order) => ({ eventId: randomUUID(), eventType: 'order.test', aggregateId: order.id, timestamp: new Date().toISOString(), version: 1, payload: {} }) as never;
  const pricing = { subtotalAmount: '100.00', deliveryFee: '25.00', totalAmount: '125.00', driverFeeShare: '12.50', platformFeeShare: '12.50', driverCancelFeeShare: '6.25' };
  const delivery = { address: '1 Test Street', notes: null, latitude: null, longitude: null };
  const place = () => repo.create(randomUUID(), randomUUID(), [{ menuItemId: randomUUID(), name: 'Koshary', price: 50, quantity: 2 }], pricing, undefined, delivery, event);

  beforeAll(async () => {
    ds = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [Order, OrderItem]));
    await ds.initialize();
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
    repo = new OrdersRepository(ds.getRepository(Order));
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('writes one row when the order is placed, and one per transition with its actor and reason', async () => {
    const order = await place();
    await repo.updateStatus(order.id, OrderStatus.CREATED, OrderStatus.PAYMENT_PENDING, event, {}, { actorType: 'SYSTEM', actorId: 'system:payment-service' });
    await repo.updateStatus(order.id, OrderStatus.PAYMENT_PENDING, OrderStatus.CONFIRMED, event, {}, { actorType: 'SYSTEM', actorId: 'system' });
    await repo.updateStatus(order.id, OrderStatus.CONFIRMED, OrderStatus.CANCELLED, event, { cancelledBy: 'RESTAURANT' }, { actorType: 'RESTAURANT', actorId: 'owner-1', reason: 'Out of falafel' });

    const history = await repo.statusHistory(order.id);
    expect(history.map((row) => [row.fromStatus, row.toStatus, row.actorType, row.actorId, row.reason])).toEqual([
      [null, 'CREATED', 'CUSTOMER', order.customerId, null],
      ['CREATED', 'PAYMENT_PENDING', 'SYSTEM', 'system:payment-service', null],
      ['PAYMENT_PENDING', 'CONFIRMED', 'SYSTEM', 'system', null],
      ['CONFIRMED', 'CANCELLED', 'RESTAURANT', 'owner-1', 'Out of falafel'],
    ]);
    expect(history.every((row) => row.at instanceof Date)).toBe(true);
  });

  it('writes nothing for a compare-and-set that lost (the order moved on)', async () => {
    const order = await place();
    expect(await repo.updateStatus(order.id, OrderStatus.CONFIRMED, OrderStatus.PREPARING, event, {}, { actorType: 'RESTAURANT', actorId: 'owner-1' })).toBeNull();
    expect(await repo.statusHistory(order.id)).toHaveLength(1);
  });

  it('of writers racing to the same status, only the winner writes a row', async () => {
    const order = await place();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repo.updateStatus(order.id, OrderStatus.CREATED, OrderStatus.PAYMENT_PENDING, event, {}, { actorType: 'SYSTEM', actorId: 'system' })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await repo.statusHistory(order.id)).map((row) => row.toStatus)).toEqual(['CREATED', 'PAYMENT_PENDING']);
  });

  it('refuses an actor type outside the list, and keeps long reasons to 500 characters', async () => {
    const order = await place();
    await expect(
      ds.query(`INSERT INTO "order_status_history" ("orderId", "toStatus", "actorType") VALUES ($1, 'CANCELLED', 'ROBOT')`, [order.id]),
    ).rejects.toThrow(/CHK_order_status_history_actor/);
    await repo.updateStatus(order.id, OrderStatus.CREATED, OrderStatus.CANCELLED, event, {}, { actorType: 'STAFF', actorId: 'staff-1', reason: 'x'.repeat(600) });
    expect((await repo.statusHistory(order.id)).slice(-1)[0]?.reason).toHaveLength(500);
  });
});
