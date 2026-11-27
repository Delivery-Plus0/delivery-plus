/**
 * The staff driver list (#214) against real PostgreSQL: the filters, the review queue (submitted and
 * still PENDING, oldest first), licences expiring, and the plate prefix with LIKE wildcards literal.
 *
 * Opt-in: DRIVER_TEST_DATABASE_URL, a DISPOSABLE database (the public schema is dropped and recreated);
 * run with --runInBand, the driver Postgres specs share it.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Driver } from '../entities/driver.entity';
import { DriverDocument } from '../entities/driver-document.entity';
import { DriverDocumentAccess } from '../entities/driver-document-access.entity';
import { DriverReview } from '../entities/driver-review.entity';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { DriversRepository } from './drivers.repository';

const DATABASE_URL = process.env.DRIVER_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('DriversRepository.findForAdmin (PostgreSQL integration, #214)', () => {
  jest.setTimeout(30_000);
  let ds: DataSource;
  let repo: DriversRepository;
  const plates: Record<string, string> = {};

  beforeAll(async () => {
    ds = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [Driver, DriverDocument, DriverDocumentAccess, DriverReview]));
    await ds.initialize();
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
    repo = new DriversRepository(ds.getRepository(Driver));
    const add = async (
      key: string,
      plate: string,
      status: string,
      verification: string,
      extra: { submittedAt?: string; driving?: string; vehicle?: string; created: string },
    ) => {
      plates[key] = plate;
      await ds.query(
        `INSERT INTO "drivers" ("userId", "vehicleType", "licensePlate", "status", "verificationStatus", "submittedAt",
                                "drivingLicenceExpiresOn", "vehicleLicenceExpiresOn", "createdAt")
         VALUES ($1, 'Scooter', $2, $3, $4, $5, $6, $7, $8)`,
        [randomUUID(), plate, status, verification, extra.submittedAt ?? null, extra.driving ?? null, extra.vehicle ?? null, extra.created],
      );
    };
    await add('draft', 'ABC 101', 'OFFLINE', 'PENDING', { created: '2026-11-01T00:00:00Z' });
    await add('queuedLate', 'ABC 102', 'OFFLINE', 'PENDING', { submittedAt: '2026-11-20T00:00:00Z', created: '2026-11-02T00:00:00Z' });
    await add('queuedEarly', 'XYZ 1', 'OFFLINE', 'PENDING', { submittedAt: '2026-11-10T00:00:00Z', created: '2026-11-03T00:00:00Z' });
    await add('verified', 'ABC 103', 'AVAILABLE', 'VERIFIED', { submittedAt: '2026-11-05T00:00:00Z', driving: '2026-12-01', vehicle: '2027-06-01', created: '2026-11-04T00:00:00Z' });
    await add('rejected', 'A_C 104', 'OFFLINE', 'REJECTED', { submittedAt: '2026-11-06T00:00:00Z', vehicle: '2026-11-30', created: '2026-11-05T00:00:00Z' });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const plateList = (rows: Driver[]) => rows.map((row) => row.licensePlate);

  it('lists the review queue: submitted and still PENDING, oldest submission first', async () => {
    const [rows, total] = await repo.findForAdmin({ queue: true }, 1, 20);
    expect(total).toBe(2);
    expect(plateList(rows)).toEqual(['XYZ 1', 'ABC 102']);
  });

  it('filters by status and verification, newest first', async () => {
    expect(plateList((await repo.findForAdmin({ verificationStatus: 'PENDING' }, 1, 20))[0])).toEqual(['XYZ 1', 'ABC 102', 'ABC 101']);
    expect(plateList((await repo.findForAdmin({ status: 'AVAILABLE' }, 1, 20))[0])).toEqual(['ABC 103']);
  });

  it('keeps drivers with either licence ending on or before the date', async () => {
    expect(plateList((await repo.findForAdmin({ licenceExpiringBy: '2026-11-30' }, 1, 20))[0])).toEqual(['A_C 104']);
    expect(plateList((await repo.findForAdmin({ licenceExpiringBy: '2026-12-01' }, 1, 20))[0])).toEqual(['A_C 104', 'ABC 103']);
  });

  it('matches the start of the plate with wildcards literal, and pages', async () => {
    expect(plateList((await repo.findForAdmin({ platePrefix: 'ABC' }, 1, 20))[0])).toEqual(['ABC 103', 'ABC 102', 'ABC 101']);
    expect(plateList((await repo.findForAdmin({ platePrefix: 'A_C' }, 1, 20))[0])).toEqual(['A_C 104']);
    expect(plateList((await repo.findForAdmin({ platePrefix: '%' }, 1, 20))[0])).toEqual([]);
    const [page2, total] = await repo.findForAdmin({ platePrefix: 'ABC' }, 2, 2);
    expect(total).toBe(3);
    expect(plateList(page2)).toEqual(['ABC 101']);
  });
});
