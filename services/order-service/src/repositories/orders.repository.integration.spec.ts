/**
 * order-service SQL against real PostgreSQL (#214): today's orders of a restaurant by the Cairo
 * calendar day, across the UTC midnight and in summer time (Egypt is UTC+3 from April to October).
 *
 * Opt-in: ORDER_TEST_DATABASE_URL, a DISPOSABLE database (the public schema is dropped and recreated).
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
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
