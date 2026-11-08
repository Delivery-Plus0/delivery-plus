/**
 * The licence expiry check (#207) against real PostgreSQL: the compare-and-set UPDATE, the BUSY skip,
 * NULL dates and the advisory lock live in SQL, which a mocked repository can't prove.
 *
 * Opt-in like the other driver-service integration specs: set DRIVER_TEST_DATABASE_URL to a DISPOSABLE
 * database (the public schema is dropped and recreated).
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { DriverStatus } from '@food-delivery/shared';
import { Driver } from '../entities/driver.entity';
import { DriverDocument } from '../entities/driver-document.entity';
import { DriverDocumentAccess } from '../entities/driver-document-access.entity';
import { DriverReview } from '../entities/driver-review.entity';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { InitialSchema1700000000000 } from '../database/migrations/001-initial-schema';
import { UuidPrimaryKeyDefaults1700000000001 } from '../database/migrations/002-uuid-primary-key-defaults';
import { DriverVerification1700000000002 } from '../database/migrations/003-driver-verification';
import { VerifyExistingDrivers1700000000003 } from '../database/migrations/004-verify-existing-drivers';
import { DriverAvailableSince1700000000004 } from '../database/migrations/005-driver-available-since';
import { DriverEffectiveIdleIndex1700000000005 } from '../database/migrations/006-driver-effective-idle-index';
import { DriverApplicationDocuments1700000000006 } from '../database/migrations/007-driver-application-documents';
import { DriverReviews1700000000007 } from '../database/migrations/008-driver-reviews';
import { LICENCE_EXPIRED_NOTE, LICENCE_EXPIRY_LOCK, LicenceExpiryRepository } from './licence-expiry.repository';
import { DriverApplicationRepository } from './driver-application.repository';
import { DriversRepository } from './drivers.repository';

const DATABASE_URL = process.env.DRIVER_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const MIGRATIONS = [
  InitialSchema1700000000000,
  UuidPrimaryKeyDefaults1700000000001,
  DriverVerification1700000000002,
  VerifyExistingDrivers1700000000003,
  DriverAvailableSince1700000000004,
  DriverEffectiveIdleIndex1700000000005,
  DriverApplicationDocuments1700000000006,
  DriverReviews1700000000007,
];
const ENTITIES = [Driver, DriverDocument, DriverDocumentAccess, DriverReview];

const TODAY = '2026-11-08';
const WARN_UNTIL = '2026-11-22';

describeDb('LicenceExpiryRepository (PostgreSQL integration, #207)', () => {
  jest.setTimeout(30_000);

  let ds: DataSource;
  let repo: LicenceExpiryRepository;

  beforeEach(async () => {
    const setup = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, ENTITIES, { migrations: MIGRATIONS }));
    await setup.initialize();
    await setup.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await setup.runMigrations();
    await setup.destroy();
    ds = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, ENTITIES, { migrations: MIGRATIONS }));
    await ds.initialize();
    repo = new LicenceExpiryRepository(ds);
  });

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  async function insertDriver(row: {
    verificationStatus?: 'PENDING' | 'VERIFIED' | 'REJECTED';
    status?: DriverStatus;
    driving?: string | null;
    vehicle?: string | null;
  }): Promise<string> {
    const [inserted] = await ds.query(
      `INSERT INTO "drivers" ("userId", "vehicleType", "licensePlate", "status", "verificationStatus", "verifiedAt", "submittedAt",
         "drivingLicenceExpiresOn", "vehicleLicenceExpiresOn", "availableSince")
       VALUES ($1, 'Scooter', $2, $3::"driver_status", $4::varchar, CASE WHEN $4::varchar = 'VERIFIED' THEN now() END, now(), $5::date, $6::date,
         CASE WHEN $3::"driver_status" = 'AVAILABLE' THEN now() END)
       RETURNING "id"`,
      [
        randomUUID(),
        `QA-${randomUUID().slice(0, 6)}`,
        row.status ?? DriverStatus.OFFLINE,
        row.verificationStatus ?? 'VERIFIED',
        row.driving === undefined ? '2028-01-01' : row.driving,
        row.vehicle === undefined ? '2028-01-01' : row.vehicle,
      ],
    );
    return inserted.id;
  }

  const load = (id: string) => ds.getRepository(Driver).findOneByOrFail({ id });

  it('sends a verified driver with an expired licence back to a draft, with a note, and takes them offline', async () => {
    const offline = await insertDriver({ driving: '2026-11-07' });
    const online = await insertDriver({ status: DriverStatus.AVAILABLE, vehicle: '2026-10-01' });

    const outcome = await repo.run(TODAY, WARN_UNTIL);

    expect(outcome?.expired.sort()).toEqual([offline, online].sort());
    for (const id of [offline, online]) {
      expect(await load(id)).toMatchObject({
        verificationStatus: 'PENDING',
        submittedAt: null,
        verifiedAt: null,
        verificationNote: LICENCE_EXPIRED_NOTE,
        status: DriverStatus.OFFLINE,
        availableSince: null,
      });
    }
    // Back to a draft: the driver can save the renewed licence date and resubmit.
    const applications = new DriverApplicationRepository(ds);
    await expect(
      applications.saveFieldsIfEditable(offline, {
        nationalIdLast4: '4567',
        nationalIdHash: 'a'.repeat(64),
        drivingLicenceExpiresOn: '2031-11-07',
        vehicleLicenceExpiresOn: '2028-01-01',
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps a licence valid through its expiry date, and never treats a missing date as expired', async () => {
    const expiresToday = await insertDriver({ driving: TODAY });
    const verifiedBeforeApplications = await insertDriver({ driving: null, vehicle: null });

    expect((await repo.run(TODAY, WARN_UNTIL))?.expired).toEqual([]);
    expect((await load(expiresToday)).verificationStatus).toBe('VERIFIED');
    expect((await load(verifiedBeforeApplications)).verificationStatus).toBe('VERIFIED');
  });

  it('leaves a driver on a delivery alone and expires them on the first run after the delivery ends', async () => {
    const busy = await insertDriver({ status: DriverStatus.BUSY, driving: '2026-11-01' });

    expect(await repo.run(TODAY, WARN_UNTIL)).toEqual({ expired: [], skippedBusy: 1, expiringSoon: 0 });
    expect(await load(busy)).toMatchObject({ verificationStatus: 'VERIFIED', status: DriverStatus.BUSY });

    // The delivery ends: the release is a compare-and-set to AVAILABLE, which still sees VERIFIED.
    const drivers = new DriversRepository(ds.getRepository(Driver));
    expect(await drivers.transitionStatus(busy, DriverStatus.BUSY, DriverStatus.AVAILABLE)).not.toBeNull();

    expect((await repo.run(TODAY, WARN_UNTIL))?.expired).toEqual([busy]);
    expect(await load(busy)).toMatchObject({ verificationStatus: 'PENDING', status: DriverStatus.OFFLINE });
    // And the dispatch claim compare-and-set can no longer take them.
    expect(await drivers.transitionStatus(busy, DriverStatus.OFFLINE, DriverStatus.AVAILABLE)).toBeNull();
  });

  it('touches only VERIFIED drivers', async () => {
    const pending = await insertDriver({ verificationStatus: 'PENDING', driving: '2026-01-01' });
    const rejected = await insertDriver({ verificationStatus: 'REJECTED', driving: '2026-01-01' });

    expect((await repo.run(TODAY, WARN_UNTIL))?.expired).toEqual([]);
    expect(await load(pending)).toMatchObject({ verificationStatus: 'PENDING', verificationNote: null });
    expect((await load(pending)).submittedAt).toBeInstanceOf(Date);
    expect((await load(rejected)).verificationStatus).toBe('REJECTED');
  });

  it('counts verified drivers whose licence expires within the warning window', async () => {
    await insertDriver({ driving: TODAY });
    await insertDriver({ vehicle: WARN_UNTIL });
    await insertDriver({ vehicle: '2026-11-23' });
    await insertDriver({ verificationStatus: 'PENDING', driving: '2026-11-10' });

    expect(await repo.run(TODAY, WARN_UNTIL)).toEqual({ expired: [], skippedBusy: 0, expiringSoon: 2 });
  });

  it('does nothing while another instance holds the lock', async () => {
    const expired = await insertDriver({ driving: '2026-11-01' });
    const runner = ds.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [LICENCE_EXPIRY_LOCK]);
    try {
      expect(await repo.run(TODAY, WARN_UNTIL)).toBeNull();
      expect((await load(expired)).verificationStatus).toBe('VERIFIED');
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
    expect((await repo.run(TODAY, WARN_UNTIL))?.expired).toEqual([expired]);
  });
});
