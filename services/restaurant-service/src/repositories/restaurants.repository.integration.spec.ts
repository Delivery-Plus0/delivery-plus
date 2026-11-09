/**
 * Restaurant applications (#208) against real PostgreSQL: one restaurant per owner under an advisory
 * lock, the compare-and-set submit, status and decision writes, the public filter, the migration
 * backfill and the append-only history live in SQL, which a mocked repository can't prove.
 *
 * Opt-in: set RESTAURANT_TEST_DATABASE_URL to a DISPOSABLE database (the public schema is dropped and
 * recreated).
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { RestaurantStatus } from '@food-delivery/shared';
import { Restaurant } from '../entities/restaurant.entity';
import { RestaurantReview } from '../entities/restaurant-review.entity';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { InitialSchema1700000000000 } from '../database/migrations/001-initial-schema';
import { UuidPrimaryKeyDefaults1700000000001 } from '../database/migrations/002-uuid-primary-key-defaults';
import { RestaurantImageUrls1700000000002 } from '../database/migrations/003-restaurant-image-urls';
import { RestaurantLocationDeliveryRadius1700000000003 } from '../database/migrations/004-restaurant-location-delivery-radius';
import { RestaurantApproval1700000000004 } from '../database/migrations/005-restaurant-approval';
import { NotInReviewError, OwnerHasRestaurantError, RestaurantsRepository } from './restaurants.repository';
import { ListRestaurantsQueryDto } from '../dto/list-restaurants-query.dto';

const DATABASE_URL = process.env.RESTAURANT_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const BEFORE_208 = [
  InitialSchema1700000000000,
  UuidPrimaryKeyDefaults1700000000001,
  RestaurantImageUrls1700000000002,
  RestaurantLocationDeliveryRadius1700000000003,
];
const ALL = [...BEFORE_208, RestaurantApproval1700000000004];
const ENTITIES = [Restaurant, RestaurantReview];

describeDb('RestaurantsRepository (PostgreSQL integration, #208)', () => {
  jest.setTimeout(30_000);

  let ds: DataSource;
  let repo: RestaurantsRepository;

  async function freshSchema(migrations = ALL) {
    const setup = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, ENTITIES, { migrations }));
    await setup.initialize();
    await setup.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await setup.runMigrations();
    await setup.destroy();
  }

  async function open() {
    ds = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, ENTITIES, { migrations: ALL }));
    await ds.initialize();
    repo = new RestaurantsRepository(ds.getRepository(Restaurant));
  }

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const create = (ownerId = randomUUID(), name = 'Cairo Kitchen') =>
    repo.createForOwner({ ownerId, name, address: '9 Nile Corniche', latitude: 30.04, longitude: 31.23 });

  async function submitted(): Promise<Restaurant> {
    const restaurant = await create();
    return (await repo.submitIfSubmittable(restaurant.id)) as Restaurant;
  }

  it('migration 005 keeps every existing restaurant visible (APPROVED); new ones start as drafts', async () => {
    await freshSchema(BEFORE_208);
    const before = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [], { migrations: BEFORE_208 }));
    await before.initialize();
    const [existing] = await before.query(
      `INSERT INTO "restaurants" ("ownerId", "name", "address", "status") VALUES ($1, 'Old Place', 'x', 'OPEN') RETURNING "id"`,
      [randomUUID()],
    );
    await before.destroy();

    await open();
    expect(await ds.runMigrations()).toHaveLength(1);
    expect(await repo.findById(existing.id)).toMatchObject({ approvalStatus: 'APPROVED', status: RestaurantStatus.OPEN, cuisineTags: [] });
    expect((await create()).approvalStatus).toBe('DRAFT');
    const [listed] = await repo.list({ page: 1, limit: 10, sortBy: 'createdAt', sortOrder: 'DESC' } as ListRestaurantsQueryDto, 5);
    expect(listed.map(({ restaurant }) => restaurant.id)).toEqual([existing.id]);

    await ds.undoLastMigration();
    expect(await ds.runMigrations()).toHaveLength(1);
  });

  describe('with the current schema', () => {
    beforeEach(async () => {
      await freshSchema();
      await open();
    });

    it('gives an owner one restaurant, even when two creates race', async () => {
      const ownerId = randomUUID();
      const outcomes = await Promise.allSettled([create(ownerId, 'A'), create(ownerId, 'B')]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect((outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(OwnerHasRestaurantError);
      await expect(create(ownerId, 'C')).rejects.toBeInstanceOf(OwnerHasRestaurantError);
      expect(await repo.findByOwner(ownerId)).toHaveLength(1);
    });

    it('lets an owner open only an approved restaurant, and close any', async () => {
      const draft = await create();
      expect(await repo.updateStatusUnlessSuspended(draft.id, RestaurantStatus.OPEN)).toBeNull();
      expect(await repo.updateStatusUnlessSuspended(draft.id, RestaurantStatus.BUSY)).toBeNull();
      expect((await repo.updateStatusUnlessSuspended(draft.id, RestaurantStatus.CLOSED))?.status).toBe(RestaurantStatus.CLOSED);

      const pending = await repo.submitIfSubmittable(draft.id);
      await repo.decideIfSubmitted(draft.id, { decision: 'APPROVED', note: null, reviewerUserId: randomUUID(), submittedAt: pending!.submittedAt! }, () => undefined);
      expect((await repo.updateStatusUnlessSuspended(draft.id, RestaurantStatus.OPEN))?.status).toBe(RestaurantStatus.OPEN);
    });

    it('submits a draft once, then a rejected application again', async () => {
      const draft = await create();
      const first = await repo.submitIfSubmittable(draft.id);
      expect(first).toMatchObject({ approvalStatus: 'SUBMITTED' });
      expect(await repo.submitIfSubmittable(draft.id)).toBeNull();

      await repo.decideIfSubmitted(draft.id, { decision: 'REJECTED', note: 'Logo missing', reviewerUserId: randomUUID(), submittedAt: first!.submittedAt! }, () => undefined);
      expect(await repo.findById(draft.id)).toMatchObject({ approvalStatus: 'REJECTED', approvalNote: 'Logo missing' });

      const second = await repo.submitIfSubmittable(draft.id);
      expect(second).toMatchObject({ approvalStatus: 'SUBMITTED', approvalNote: null });
      expect(second!.submittedAt!.getTime()).toBeGreaterThan(first!.submittedAt!.getTime());
    });

    it('rejected, resubmitted and approved: the history keeps both decisions, and the restaurant is listed', async () => {
      const reviewer = randomUUID();
      const first = await submitted();
      await repo.decideIfSubmitted(first.id, { decision: 'REJECTED', note: 'Logo missing', reviewerUserId: reviewer, submittedAt: first.submittedAt! }, () => undefined);
      const second = (await repo.submitIfSubmittable(first.id))!;
      expect(await repo.decideIfSubmitted(first.id, { decision: 'APPROVED', note: null, reviewerUserId: reviewer, submittedAt: second.submittedAt! }, () => undefined)).toBe('decided');

      expect(await repo.findById(first.id)).toMatchObject({ approvalStatus: 'APPROVED', approvalNote: null });
      expect((await repo.findById(first.id))!.approvedAt).toBeInstanceOf(Date);
      const history = await repo.reviews(first.id);
      expect(history.map(({ decision, note }) => ({ decision, note }))).toEqual([
        { decision: 'APPROVED', note: null },
        { decision: 'REJECTED', note: 'Logo missing' },
      ]);
      expect(history[1].applicationSubmittedAt.getTime()).toBe(first.submittedAt!.getTime());
      const [listed] = await repo.list({ page: 1, limit: 10, sortBy: 'createdAt', sortOrder: 'DESC' } as ListRestaurantsQueryDto, 5);
      expect(listed.map(({ restaurant }) => restaurant.id)).toEqual([first.id]);
    });

    it('lists approved restaurants by distance from a delivery point, only within their delivery radius (#54)', async () => {
      const near = await submitted();
      await repo.decideIfSubmitted(near.id, { decision: 'APPROVED', note: null, reviewerUserId: randomUUID(), submittedAt: near.submittedAt! }, () => undefined);

      const query = (lat: number, lng: number) =>
        ({ page: 1, limit: 10, sortBy: 'createdAt', sortOrder: 'DESC', lat, lng }) as ListRestaurantsQueryDto;
      const [here, total] = await repo.list(query(30.04, 31.23), 5);
      expect(total).toBe(1);
      expect(here.map(({ restaurant }) => restaurant.id)).toEqual([near.id]);
      expect(here[0].distanceKm).toBeCloseTo(0, 3);

      const [far] = await repo.list(query(31.2001, 29.9187), 5);
      expect(far).toEqual([]);
    });

    it('refuses a decision on a draft or on a replaced submission, repeats the same one as a no-op, and lets one of two racing reviewers win', async () => {
      const draft = await create();
      await expect(
        repo.decideIfSubmitted(draft.id, { decision: 'APPROVED', note: null, reviewerUserId: randomUUID(), submittedAt: new Date() }, () => undefined),
      ).rejects.toBeInstanceOf(NotInReviewError);

      const pending = await submitted();
      const stale = new Date(pending.submittedAt!.getTime() - 1000);
      await expect(
        repo.decideIfSubmitted(pending.id, { decision: 'APPROVED', note: null, reviewerUserId: randomUUID(), submittedAt: stale }, () => undefined),
      ).rejects.toBeInstanceOf(NotInReviewError);

      const outcomes = await Promise.allSettled([
        repo.decideIfSubmitted(pending.id, { decision: 'APPROVED', note: null, reviewerUserId: randomUUID(), submittedAt: pending.submittedAt! }, () => undefined),
        repo.decideIfSubmitted(pending.id, { decision: 'REJECTED', note: 'No', reviewerUserId: randomUUID(), submittedAt: pending.submittedAt! }, () => undefined),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const winner = (await repo.findById(pending.id))!.approvalStatus as 'APPROVED' | 'REJECTED';
      const note = winner === 'REJECTED' ? 'No' : null;
      expect(
        await repo.decideIfSubmitted(pending.id, { decision: winner, note, reviewerUserId: randomUUID(), submittedAt: pending.submittedAt! }, () => undefined),
      ).toBe('repeat');
      expect(await repo.reviews(pending.id)).toHaveLength(1);
    });

    it('writes nothing when the check refuses an approval', async () => {
      const pending = await submitted();
      await expect(
        repo.decideIfSubmitted(pending.id, { decision: 'APPROVED', note: null, reviewerUserId: randomUUID(), submittedAt: pending.submittedAt! }, () => {
          throw new Error('menu empty');
        }),
      ).rejects.toThrow('menu empty');
      expect((await repo.findById(pending.id))!.approvalStatus).toBe('SUBMITTED');
      expect(await repo.reviews(pending.id)).toHaveLength(0);
    });

    it('changes fields only in the allowed application states', async () => {
      const draft = await create();
      expect(await repo.updateIfApprovalIn(draft.id, { legalName: 'Kitchen LLC' }, ['DRAFT', 'REJECTED'])).toMatchObject({ legalName: 'Kitchen LLC' });
      await repo.submitIfSubmittable(draft.id);
      expect(await repo.updateIfApprovalIn(draft.id, { legalName: 'Other LLC' }, ['DRAFT', 'REJECTED'])).toBeNull();
      expect((await repo.findById(draft.id))!.legalName).toBe('Kitchen LLC');
    });

    it('keeps the history append-only, checks the values, and deletes the history with the restaurant', async () => {
      const pending = await submitted();
      await repo.decideIfSubmitted(pending.id, { decision: 'REJECTED', note: 'Blurry logo', reviewerUserId: randomUUID(), submittedAt: pending.submittedAt! }, () => undefined);
      await expect(ds.query(`UPDATE restaurant_reviews SET "note" = 'x' WHERE "restaurantId" = $1`, [pending.id])).rejects.toThrow(/append-only/);
      await expect(ds.query(`UPDATE restaurants SET "approvalStatus" = 'LIVE' WHERE id = $1`, [pending.id])).rejects.toThrow(/CHK_restaurants_approval_status/);
      await expect(ds.query(`UPDATE restaurants SET "contactPhone" = '0101234567' WHERE id = $1`, [pending.id])).rejects.toThrow(/CHK_restaurants_contact_phone/);
      await expect(
        ds.query(`UPDATE restaurants SET "cuisineTags" = ARRAY['a','b','c','d','e','f'] WHERE id = $1`, [pending.id]),
      ).rejects.toThrow(/CHK_restaurants_cuisine_tags/);

      await ds.query('DELETE FROM restaurants WHERE id = $1', [pending.id]);
      expect(await ds.getRepository(RestaurantReview).countBy({ restaurantId: pending.id })).toBe(0);
    });
  });
});
