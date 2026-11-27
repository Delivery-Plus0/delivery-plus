/**
 * The staff restaurant list (#214) against real PostgreSQL: every approval status, the review queue,
 * the name prefix with LIKE wildcards literal, the area filter (nearest first) and the exact phone.
 *
 * Opt-in: RESTAURANT_TEST_DATABASE_URL, a DISPOSABLE database (the public schema is dropped and
 * recreated); run with --runInBand, the restaurant Postgres specs share it.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Restaurant } from '../entities/restaurant.entity';
import { RestaurantReview } from '../entities/restaurant-review.entity';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { ListRestaurantsQueryDto } from '../dto/list-restaurants-query.dto';
import { AdminAudit } from '@food-delivery/shared';
import { RestaurantsRepository } from './restaurants.repository';

const DATABASE_URL = process.env.RESTAURANT_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('RestaurantsRepository.findForAdmin (PostgreSQL integration, #214)', () => {
  jest.setTimeout(30_000);
  let ds: DataSource;
  let repo: RestaurantsRepository;

  beforeAll(async () => {
    ds = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [Restaurant, RestaurantReview]));
    await ds.initialize();
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
    repo = new RestaurantsRepository(ds.getRepository(Restaurant));
    const add = (name: string, approval: string, status: string, lat: number | null, lng: number | null, extra: { submitted?: string; phone?: string; created: string }) =>
      ds.query(
        `INSERT INTO "restaurants" ("ownerId", "name", "address", "status", "approvalStatus", "latitude", "longitude", "submittedAt", "contactPhone", "createdAt")
         VALUES ($1, $2, 'Cairo', $3, $4, $5, $6, $7, $8, $9)`,
        [randomUUID(), name, status, approval, lat, lng, extra.submitted ?? null, extra.phone ?? null, extra.created],
      );
    await add('Koshary Abou Tarek', 'APPROVED', 'OPEN', 30.0505, 31.2413, { phone: '+201011111111', created: '2026-11-01T00:00:00Z' });
    await add('Zooba', 'APPROVED', 'BUSY', 30.0626, 31.2197, { created: '2026-11-02T00:00:00Z' });
    await add('100% Grill', 'SUBMITTED', 'CLOSED', 31.2001, 29.9187, { submitted: '2026-11-20T00:00:00Z', created: '2026-11-03T00:00:00Z' });
    await add('Late Koshary', 'SUBMITTED', 'CLOSED', null, null, { submitted: '2026-11-10T00:00:00Z', created: '2026-11-04T00:00:00Z' });
    await add('Draft Diner', 'DRAFT', 'CLOSED', null, null, { created: '2026-11-05T00:00:00Z' });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const names = (rows: Restaurant[]) => rows.map((row) => row.name);

  it('lists every approval status, newest first, and filters by approval and status', async () => {
    const [all, total] = await repo.findForAdmin({}, 1, 20);
    expect(total).toBe(5);
    expect(names(all)[0]).toBe('Draft Diner');
    expect(names((await repo.findForAdmin({ approvalStatus: 'APPROVED' }, 1, 20))[0])).toEqual(['Zooba', 'Koshary Abou Tarek']);
    expect(names((await repo.findForAdmin({ status: 'BUSY' }, 1, 20))[0])).toEqual(['Zooba']);
  });

  it('lists the review queue oldest submission first', async () => {
    expect(names((await repo.findForAdmin({ queue: true }, 1, 20))[0])).toEqual(['Late Koshary', '100% Grill']);
  });

  it('matches a name prefix of any word, wildcards literal', async () => {
    expect(names((await repo.findForAdmin({ namePrefix: 'kosh' }, 1, 20))[0])).toEqual(['Late Koshary', 'Koshary Abou Tarek']);
    expect(names((await repo.findForAdmin({ namePrefix: '100%' }, 1, 20))[0])).toEqual(['100% Grill']);
    expect((await repo.findForAdmin({ namePrefix: '%' }, 1, 20))[1]).toBe(0);
  });

  it('keeps restaurants within the area, nearest first, and pages them', async () => {
    // Tahrir Square: Koshary Abou Tarek is about 0.5 km away, Zooba about 3 km, the Alexandria one 180 km.
    const near = { latitude: 30.0444, longitude: 31.2357, withinKm: 5 };
    const [rows, total] = await repo.findForAdmin({ near }, 1, 20);
    expect(total).toBe(2);
    expect(names(rows)).toEqual(['Koshary Abou Tarek', 'Zooba']);
    expect(names((await repo.findForAdmin({ near }, 2, 1))[0])).toEqual(['Zooba']);
    expect((await repo.findForAdmin({ near: { ...near, withinKm: 0.1 } }, 1, 20))[1]).toBe(0);
  });

  it('finds by the exact contact phone only', async () => {
    expect(names(await repo.findByContactPhone('+201011111111'))).toEqual(['Koshary Abou Tarek']);
    expect(await repo.findByContactPhone('+2010111')).toEqual([]);
  });

  it('suspends and reactivates in a transaction with one audit event each, idempotently, and hides a suspended one from customers (#215)', async () => {
    const [[zooba]] = await repo.findForAdmin({ namePrefix: 'zooba' }, 1, 1);
    const act = (kind: 'suspend' | 'reactivate') =>
      repo.transaction(async (manager) => {
        const change = kind === 'suspend' ? await repo.suspend(manager, zooba.id) : await repo.reactivate(manager, zooba.id);
        if (change) {
          await AdminAudit.record(manager, {
            actor: { id: randomUUID() },
            permission: 'ops.act',
            action: `restaurant.${kind}`,
            targetType: 'RESTAURANT',
            targetId: zooba.id,
            reason: 'Integration test',
            before: change.before,
            after: change.after,
            service: 'restaurant-service',
          });
        }
        return change;
      });
    const publicNames = async () =>
      (await repo.list(Object.assign(new ListRestaurantsQueryDto(), { page: 1, limit: 50, sortBy: 'createdAt', sortOrder: 'DESC' }), 5))[0].map((item) => item.restaurant.name);

    expect(await publicNames()).toContain('Zooba');
    expect(await act('suspend')).toEqual({ before: { status: 'BUSY' }, after: { status: 'SUSPENDED' } });
    expect(await act('suspend')).toBeNull();
    expect(await publicNames()).not.toContain('Zooba');

    expect(await act('reactivate')).toEqual({ before: { status: 'SUSPENDED' }, after: { status: 'CLOSED' } });
    expect(await act('reactivate')).toBeNull();
    expect(await publicNames()).toContain('Zooba');

    const actions = await ds.query(`SELECT "payload"->'payload'->>'action' AS "action" FROM "outbox_events" WHERE "payload"->'payload'->>'targetId' = $1 ORDER BY "id"`, [zooba.id]);
    expect(actions.map((row: { action: string }) => row.action)).toEqual(['restaurant.suspend', 'restaurant.reactivate']);
  });

  it("undoes the reviewer's own decision within the window, once, and refuses others and a closed window (#318)", async () => {
    const reviewer = randomUUID();
    const decided = async (by: string, decision: 'APPROVED' | 'REJECTED') => {
      const [row] = await ds.query(
        `INSERT INTO "restaurants" ("ownerId", "name", "address", "status", "approvalStatus", "submittedAt", "approvedAt")
         VALUES ($1, $2, 'Cairo', 'OPEN', $3::varchar, '2026-11-20T00:00:00Z', CASE WHEN $3::text = 'APPROVED' THEN now() END) RETURNING "id"`,
        [randomUUID(), `Undo ${randomUUID().slice(0, 6)}`, decision],
      );
      await ds.query(`INSERT INTO "restaurant_reviews" ("restaurantId", "reviewerUserId", "decision", "applicationSubmittedAt") VALUES ($1, $2, $3, '2026-11-20T00:00:00Z')`, [row.id, by, decision]);
      return row.id as string;
    };
    const id = await decided(reviewer, 'APPROVED');
    const hook = jest.fn().mockResolvedValue(undefined);
    expect(await repo.undoDecision(id, reviewer, 10, hook)).toBe('undone');
    expect(await repo.undoDecision(id, reviewer, 10, hook)).toBe('repeat');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await repo.findById(id)).toMatchObject({ approvalStatus: 'SUBMITTED', status: 'CLOSED', approvedAt: null });
    const decisions = await ds.query(`SELECT "decision" FROM "restaurant_reviews" WHERE "restaurantId" = $1 ORDER BY "reviewedAt", "id"`, [id]);
    expect(decisions.map((r: { decision: string }) => r.decision)).toEqual(['APPROVED', 'WITHDRAWN']);

    expect(await repo.undoDecision(await decided(randomUUID(), 'REJECTED'), reviewer, 10)).toBe('not-allowed');
    expect(await repo.undoDecision(await decided(reviewer, 'REJECTED'), reviewer, -1)).toBe('window-closed');
  });
});

