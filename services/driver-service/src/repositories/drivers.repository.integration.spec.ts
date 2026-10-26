/**
 * Integration tests for driver verification (#206) and the idle queue (#210) against real PostgreSQL: the real
 * migrations build the schema, and the gate lives in the repository's WHERE clauses, which a mocked
 * repository cannot prove.
 *
 * Opt-in: set DRIVER_TEST_DATABASE_URL to a DISPOSABLE database (the public schema is dropped and
 * recreated). Without it the suite is skipped so `npm test` works without Postgres. Example with the
 * docker-compose stack:
 *
 *   docker compose exec postgres psql -U postgres -c 'CREATE DATABASE driver_service_test'
 *   DRIVER_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/driver_service_test \
 *     npm test -w services/driver-service
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource, MigrationInterface } from 'typeorm';
import { DriverStatus } from '@food-delivery/shared';
import { Driver } from '../entities/driver.entity';
import { DriversRepository } from './drivers.repository';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { InitialSchema1700000000000 } from '../database/migrations/001-initial-schema';
import { UuidPrimaryKeyDefaults1700000000001 } from '../database/migrations/002-uuid-primary-key-defaults';
import { DriverVerification1700000000002 } from '../database/migrations/003-driver-verification';
import { VerifyExistingDrivers1700000000003 } from '../database/migrations/004-verify-existing-drivers';

import { DriverAvailableSince1700000000004 } from '../database/migrations/005-driver-available-since';

const DATABASE_URL = process.env.DRIVER_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const BEFORE_206 = [InitialSchema1700000000000, UuidPrimaryKeyDefaults1700000000001, DriverVerification1700000000002];
const BEFORE_210 = [...BEFORE_206, VerifyExistingDrivers1700000000003];
const ALL_MIGRATIONS = [...BEFORE_210, DriverAvailableSince1700000000004];

/** The service's own DataSource options, with an explicit migration list. */
function dataSource(migrations: Array<new () => MigrationInterface>): DataSource {
  return new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [Driver], { migrations }));
}

type Verification = Driver['verificationStatus'];

describeDb('DriversRepository (PostgreSQL integration, #206, #210)', () => {
  jest.setTimeout(30_000);

  let ds: DataSource;
  let repo: DriversRepository;

  /** A fresh schema built by the real migrations: up to 003 only, or all of them. */
  async function migrate(migrations: Array<new () => MigrationInterface>) {
    const setup = dataSource(migrations);
    await setup.initialize();
    await setup.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await setup.runMigrations();
    await setup.destroy();
  }

  async function insert(status: DriverStatus, verificationStatus: Verification, db = ds): Promise<string> {
    const [row] = await db.query(
      `INSERT INTO "drivers" ("userId", "vehicleType", "licensePlate", "status", "verificationStatus")
       VALUES ($1, 'Scooter', $2, $3, $4) RETURNING "id"`,
      [randomUUID(), `QA-${randomUUID().slice(0, 6)}`, status, verificationStatus],
    );
    return row.id;
  }

  async function open() {
    ds = dataSource(ALL_MIGRATIONS);
    await ds.initialize();
    repo = new DriversRepository(ds.getRepository(Driver));
  }

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  describe('migration 004: drivers that existed before the gate', () => {
    it('marks PENDING drivers VERIFIED and leaves REJECTED ones rejected', async () => {
      await migrate(BEFORE_206);
      const before = dataSource(BEFORE_206);
      await before.initialize();
      const pending = await insert(DriverStatus.AVAILABLE, 'PENDING', before);
      const rejected = await insert(DriverStatus.OFFLINE, 'REJECTED', before);
      await before.destroy();

      await open();
      expect(await ds.runMigrations()).toHaveLength(2);

      expect(await repo.findById(pending)).toMatchObject({ verificationStatus: 'VERIFIED', verifiedAt: expect.any(Date) });
      expect(await repo.findById(rejected)).toMatchObject({ verificationStatus: 'REJECTED', verifiedAt: null });
    });

    it('leaves nothing pending on a fresh database, where new drivers start PENDING', async () => {
      await migrate(ALL_MIGRATIONS);
      await open();
      expect(await ds.showMigrations()).toBe(false);

      const created = await repo.create({ userId: randomUUID(), vehicleType: 'Car', licensePlate: 'NEW-1' });
      expect(created.verificationStatus).toBe('PENDING');
    });
  });

  describe('idle queue migration (#210)', () => {
    it('backfills only AVAILABLE drivers and can roll back and reapply', async () => {
      await migrate(BEFORE_210);
      const before = dataSource(BEFORE_210);
      await before.initialize();
      const online = await insert(DriverStatus.AVAILABLE, 'VERIFIED', before);
      const offline = await insert(DriverStatus.OFFLINE, 'VERIFIED', before);
      await before.query(`UPDATE drivers SET "updatedAt" = '2026-01-01T00:00:00Z' WHERE id = $1`, [online]);
      await before.destroy();
      await open();
      expect(await ds.runMigrations()).toHaveLength(1);
      expect((await repo.findById(online))?.availableSince).toEqual(new Date('2026-01-01T00:00:00Z'));
      expect((await repo.findById(offline))?.availableSince).toBeNull();
      await ds.undoLastMigration();
      expect(await ds.runMigrations()).toHaveLength(1);
      expect((await repo.findById(online))?.availableSince).toEqual(new Date('2026-01-01T00:00:00Z'));
    });
  });

  describe('longest-idle dispatch queue (#210)', () => {
    beforeEach(async () => {
      await migrate(ALL_MIGRATIONS);
      await open();
    });

    async function available(minutes: number) {
      const id = await insert(DriverStatus.OFFLINE, 'VERIFIED');
      await repo.transitionStatus(id, DriverStatus.OFFLINE, DriverStatus.AVAILABLE);
      await ds.query(`UPDATE drivers SET "availableSince" = clock_timestamp() - ($1 * interval '1 minute') WHERE id = $2`, [minutes, id]);
      return id;
    }

    it('selects A idle for 30 minutes before B idle for one, even if B was recently updated', async () => {
      const a = await available(30);
      const b = await available(1);
      await repo.updateVerification(b, { verificationStatus: 'VERIFIED', verificationNote: 'Reviewed', verifiedAt: new Date() });
      const [first, total] = await repo.findAvailable(1, 1);
      const [second] = await repo.findAvailable(2, 1);
      expect(total).toBe(2);
      expect(first.map(d => d.id)).toEqual([a]);
      expect(second.map(d => d.id)).toEqual([b]);
    });

    it('puts legacy AVAILABLE drivers with NULL idle times first, ordered by id', async () => {
      const timed = await available(30);
      const legacy = [await insert(DriverStatus.AVAILABLE, 'VERIFIED'), await insert(DriverStatus.AVAILABLE, 'VERIFIED')].sort();
      expect((await repo.findAvailable(1, 20))[0].map(driver => driver.id)).toEqual([...legacy, timed]);
      expect((await repo.findAvailable(1, 1))[0].map(driver => driver.id)).toEqual([legacy[0]]);
      expect((await repo.findAvailable(2, 1))[0].map(driver => driver.id)).toEqual([legacy[1]]);
    });

    it('two parallel queue consumers claim distinct drivers after racing for the same oldest one', async () => {
      const a = await available(30);
      const b = await available(1);
      let initialReads = 0;
      let release!: () => void;
      const bothRead = new Promise<void>(resolve => { release = resolve; });
      const firstChoices: string[] = [];
      const claim = async (): Promise<string> => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const [queue] = await repo.findAvailable(1, 1);
          const driver = queue[0];
          if (!driver) throw new Error('Queue unexpectedly empty');
          if (attempt === 0) {
            firstChoices.push(driver.id);
            if (++initialReads === 2) release();
            await bothRead;
          }
          const claimed = await repo.transitionStatus(driver.id, DriverStatus.AVAILABLE, DriverStatus.BUSY);
          if (claimed) return claimed.id;
        }
        throw new Error('Claim retry budget exhausted');
      };
      const claimed = await Promise.all([claim(), claim()]);
      expect(firstChoices).toEqual([a, a]);
      expect(claimed.sort()).toEqual([a, b].sort());
      expect((await repo.findAvailable(1, 20))[1]).toBe(0);
    });

    it('puts a driver finishing a delivery at the back and clears idle time while busy', async () => {
      const a = await available(30);
      const b = await available(1);
      expect(await repo.transitionStatus(a, DriverStatus.AVAILABLE, DriverStatus.BUSY)).toMatchObject({ availableSince: null });
      const released = await repo.transitionStatus(a, DriverStatus.BUSY, DriverStatus.AVAILABLE);
      expect(released?.availableSince).toBeInstanceOf(Date);
      expect((await repo.findAvailable(1, 20))[0].map(d => d.id)).toEqual([b, a]);
      // A stale retry must not move the driver in the queue again.
      expect(await repo.transitionStatus(a, DriverStatus.BUSY, DriverStatus.AVAILABLE)).toBeNull();
      expect((await repo.findById(a))?.availableSince).toEqual(released?.availableSince);
    });

    it('starts a new idle period on reconnect and leaves rejected transitions untouched', async () => {
      const id = await available(30);
      const original = (await repo.findById(id))!.availableSince!;
      expect(await repo.transitionStatus(id, DriverStatus.AVAILABLE, DriverStatus.OFFLINE)).toMatchObject({ availableSince: null });
      const online = await repo.transitionStatus(id, DriverStatus.OFFLINE, DriverStatus.AVAILABLE);
      expect(online!.availableSince!.getTime()).toBeGreaterThan(original.getTime());
      await repo.updateVerification(id, { verificationStatus: 'REJECTED', verificationNote: null, verifiedAt: null });
      expect(await repo.transitionStatus(id, DriverStatus.AVAILABLE, DriverStatus.BUSY)).toBeNull();
      expect((await repo.findById(id))?.availableSince).toEqual(online?.availableSince);
    });

    it('breaks equal idle times deterministically by id', async () => {
      const ids = [await available(1), await available(1)].sort();
      await ds.query(`UPDATE drivers SET "availableSince" = '2026-01-01T00:00:00Z' WHERE id = ANY($1::uuid[])`, [ids]);
      expect((await repo.findAvailable(1, 20))[0].map(d => d.id)).toEqual(ids);
    });
  });

  describe('the gate in SQL', () => {
    beforeEach(async () => {
      await migrate(ALL_MIGRATIONS);
      await open();
    });

    it('lists only AVAILABLE and VERIFIED drivers for dispatch', async () => {
      const verified = await insert(DriverStatus.AVAILABLE, 'VERIFIED');
      await insert(DriverStatus.AVAILABLE, 'PENDING');
      await insert(DriverStatus.AVAILABLE, 'REJECTED');
      await insert(DriverStatus.OFFLINE, 'VERIFIED');

      const [items, total] = await repo.findAvailable(1, 20);

      expect(total).toBe(1);
      expect(items.map((d) => d.id)).toEqual([verified]);
    });

    it.each(['PENDING', 'REJECTED'] as const)('never claims a %s driver, even one left AVAILABLE', async (verification) => {
      const id = await insert(DriverStatus.AVAILABLE, verification);

      expect(await repo.transitionStatus(id, DriverStatus.AVAILABLE, DriverStatus.BUSY)).toBeNull();
      expect((await repo.findById(id))?.status).toBe(DriverStatus.AVAILABLE);
    });

    it('claims a VERIFIED driver, and only once', async () => {
      const id = await insert(DriverStatus.AVAILABLE, 'VERIFIED');

      const [first, second] = await Promise.all([
        repo.transitionStatus(id, DriverStatus.AVAILABLE, DriverStatus.BUSY),
        repo.transitionStatus(id, DriverStatus.AVAILABLE, DriverStatus.BUSY),
      ]);

      expect([first, second].filter(Boolean)).toHaveLength(1);
      expect((await repo.findById(id))?.status).toBe(DriverStatus.BUSY);
    });

    it('refuses a claim once the driver is rejected, even when the caller read them as VERIFIED', async () => {
      const id = await insert(DriverStatus.AVAILABLE, 'VERIFIED');
      const read = await repo.findById(id);
      await repo.updateVerification(id, { verificationStatus: 'REJECTED', verificationNote: null, verifiedAt: null });

      expect(read?.verificationStatus).toBe('VERIFIED');
      expect(await repo.transitionStatus(id, DriverStatus.AVAILABLE, DriverStatus.BUSY)).toBeNull();
    });

    it('does not let an unverified driver go online, but lets them go offline and be released offline', async () => {
      const offline = await insert(DriverStatus.OFFLINE, 'PENDING');
      const online = await insert(DriverStatus.AVAILABLE, 'REJECTED');
      const busy = await insert(DriverStatus.BUSY, 'REJECTED');

      expect(await repo.transitionStatus(offline, DriverStatus.OFFLINE, DriverStatus.AVAILABLE)).toBeNull();
      expect(await repo.transitionStatus(online, DriverStatus.AVAILABLE, DriverStatus.OFFLINE)).toMatchObject({ status: DriverStatus.OFFLINE });
      expect(await repo.transitionStatus(busy, DriverStatus.BUSY, DriverStatus.AVAILABLE)).toBeNull();
      expect(await repo.transitionStatus(busy, DriverStatus.BUSY, DriverStatus.OFFLINE)).toMatchObject({ status: DriverStatus.OFFLINE });
    });
  });
});
