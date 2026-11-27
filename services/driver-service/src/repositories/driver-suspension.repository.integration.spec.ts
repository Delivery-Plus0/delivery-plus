/**
 * Staff suspension of drivers (#215) against real PostgreSQL: off duty is immediate, a BUSY driver
 * finishes the delivery first (the release lands on SUSPENDED), reactivation, idempotency, and one
 * audit event in the outbox per change, committed with it.
 *
 * Opt-in: DRIVER_TEST_DATABASE_URL, a DISPOSABLE database; run with --runInBand.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AdminAudit, DriverStatus } from '@food-delivery/shared';
import { Driver } from '../entities/driver.entity';
import { DriverDocument } from '../entities/driver-document.entity';
import { DriverDocumentAccess } from '../entities/driver-document-access.entity';
import { DriverReview } from '../entities/driver-review.entity';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { DriversRepository } from './drivers.repository';

const DATABASE_URL = process.env.DRIVER_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Driver suspension (PostgreSQL integration, #215)', () => {
  jest.setTimeout(30_000);
  let ds: DataSource;
  let repo: DriversRepository;

  beforeAll(async () => {
    ds = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [Driver, DriverDocument, DriverDocumentAccess, DriverReview]));
    await ds.initialize();
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
    repo = new DriversRepository(ds.getRepository(Driver));
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const driver = async (status: DriverStatus, verification = 'VERIFIED') => {
    const [row] = await ds.query(
      `INSERT INTO "drivers" ("userId", "vehicleType", "licensePlate", "status", "verificationStatus") VALUES ($1, 'Scooter', $2, $3, $4) RETURNING "id"`,
      [randomUUID(), `S-${randomUUID().slice(0, 6)}`, status, verification],
    );
    return row.id as string;
  };
  const status = async (id: string) => (await repo.findById(id))!;
  const audited = async (id: string) =>
    (await ds.query(`SELECT "payload" FROM "outbox_events" WHERE "payload"->'payload'->>'targetId' = $1 ORDER BY "id"`, [id])).map(
      (row: { payload: { payload: { action: string } } }) => row.payload.payload.action,
    );
  const act = (id: string, kind: 'suspend' | 'reactivate') =>
    ds.transaction(async (manager) => {
      const change = kind === 'suspend' ? await repo.suspend(manager, id) : await repo.reactivate(manager, id);
      if (change) {
        await AdminAudit.record(manager, {
          actor: { id: randomUUID() },
          permission: 'ops.act',
          action: `driver.${kind}`,
          targetType: 'DRIVER',
          targetId: id,
          reason: 'Integration test',
          before: change.before,
          after: change.after,
          service: 'driver-service',
        });
      }
      return change;
    });

  it('suspends an off-duty driver at once, and a repeat changes and records nothing', async () => {
    const id = await driver(DriverStatus.AVAILABLE);
    expect(await act(id, 'suspend')).toMatchObject({ after: { status: 'SUSPENDED' } });
    expect((await status(id)).status).toBe(DriverStatus.SUSPENDED);
    expect(await act(id, 'suspend')).toBeNull();
    expect(await audited(id)).toEqual(['driver.suspend']);
  });

  it('lets a BUSY driver finish: the release at the end of the delivery lands on SUSPENDED', async () => {
    const id = await driver(DriverStatus.BUSY);
    expect(await act(id, 'suspend')).toMatchObject({ after: { status: 'BUSY', suspensionRequested: true } });
    expect(await status(id)).toMatchObject({ status: DriverStatus.BUSY });
    expect((await status(id)).suspensionRequestedAt).not.toBeNull();
    expect(await act(id, 'suspend')).toBeNull(); // already requested

    const released = await repo.releaseFromBusy(id, DriverStatus.AVAILABLE);
    expect(released).toMatchObject({ status: DriverStatus.SUSPENDED, suspensionRequestedAt: null, availableSince: null });
    expect(await audited(id)).toEqual(['driver.suspend']);
  });

  it('releases a driver nobody suspended to AVAILABLE, and refuses AVAILABLE for one who lost verification', async () => {
    const ok = await driver(DriverStatus.BUSY);
    expect(await repo.releaseFromBusy(ok, DriverStatus.AVAILABLE)).toMatchObject({ status: DriverStatus.AVAILABLE });
    const rejected = await driver(DriverStatus.BUSY, 'REJECTED');
    expect(await repo.releaseFromBusy(rejected, DriverStatus.AVAILABLE)).toBeNull();
    expect(await repo.releaseFromBusy(rejected, DriverStatus.OFFLINE)).toMatchObject({ status: DriverStatus.OFFLINE });
  });

  it('reactivates a suspended driver to OFFLINE, withdraws a pending suspension, and repeats as no-ops', async () => {
    const suspended = await driver(DriverStatus.OFFLINE);
    await act(suspended, 'suspend');
    expect(await act(suspended, 'reactivate')).toMatchObject({ after: { status: 'OFFLINE' } });
    expect(await act(suspended, 'reactivate')).toBeNull();
    expect(await audited(suspended)).toEqual(['driver.suspend', 'driver.reactivate']);

    const busy = await driver(DriverStatus.BUSY);
    await act(busy, 'suspend');
    expect(await act(busy, 'reactivate')).toMatchObject({ after: { status: 'BUSY', suspensionRequested: false } });
    expect(await repo.releaseFromBusy(busy, DriverStatus.AVAILABLE)).toMatchObject({ status: DriverStatus.AVAILABLE });
  });

  it('never loses a suspension to a release racing it', async () => {
    for (let round = 0; round < 10; round++) {
      const id = await driver(DriverStatus.BUSY);
      await Promise.all([act(id, 'suspend'), repo.releaseFromBusy(id, DriverStatus.AVAILABLE)]);
      const final = await status(id);
      // Either the release came first (AVAILABLE, then suspended off duty) or the request did (SUSPENDED at release).
      expect(final.status).toBe(DriverStatus.SUSPENDED);
      expect(final.suspensionRequestedAt).toBeNull();
    }
  });
});
