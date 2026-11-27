/**
 * #318 against real PostgreSQL: the reviewer undoes their own decision within the window; the driver
 * is back in review (and offline), a WITHDRAWN row joins the append-only history, the audit hook runs
 * once; a repeat is a no-op; someone else's decision, a closed window and a BUSY driver are refused.
 *
 * Opt-in: DRIVER_TEST_DATABASE_URL, a DISPOSABLE database; run with --runInBand.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Driver } from '../entities/driver.entity';
import { DriverDocument } from '../entities/driver-document.entity';
import { DriverDocumentAccess } from '../entities/driver-document-access.entity';
import { DriverReview } from '../entities/driver-review.entity';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { DriverApplicationRepository, UndoDriverOnDeliveryError, UndoNotAllowedError, UndoWindowClosedError } from './driver-application.repository';

const DATABASE_URL = process.env.DRIVER_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('DriverApplicationRepository.undoDecision (PostgreSQL integration, #318)', () => {
  jest.setTimeout(30_000);
  let ds: DataSource;
  let repo: DriverApplicationRepository;
  const reviewer = randomUUID();

  beforeAll(async () => {
    ds = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [Driver, DriverDocument, DriverDocumentAccess, DriverReview]));
    await ds.initialize();
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
    repo = new DriverApplicationRepository(ds);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  /** A driver approved just now by `by`, then optionally online or on a delivery. */
  const approved = async (by = reviewer, status = 'OFFLINE') => {
    const [row] = await ds.query(
      `INSERT INTO "drivers" ("userId", "vehicleType", "licensePlate", "status", "verificationStatus", "submittedAt", "verifiedAt")
       VALUES ($1, 'Scooter', $2, $3, 'VERIFIED', '2026-11-20T00:00:00Z', now()) RETURNING "id"`,
      [randomUUID(), `U-${randomUUID().slice(0, 6)}`, status],
    );
    await ds.query(
      `INSERT INTO "driver_reviews" ("driverId", "reviewerUserId", "decision", "applicationSubmittedAt", "documentIds") VALUES ($1, $2, 'VERIFIED', '2026-11-20T00:00:00Z', '{}')`,
      [row.id, by],
    );
    return row.id as string;
  };
  const history = async (id: string) => (await ds.query(`SELECT "decision" FROM "driver_reviews" WHERE "driverId" = $1 ORDER BY "reviewedAt", "id"`, [id])).map((r: { decision: string }) => r.decision);

  it('puts the application back in review once, takes an online driver offline, and runs the hook once', async () => {
    const id = await approved(reviewer, 'AVAILABLE');
    const hook = jest.fn().mockResolvedValue(undefined);
    expect(await repo.undoDecision(id, reviewer, 10, hook)).toBe('undone');
    expect(await repo.undoDecision(id, reviewer, 10, hook)).toBe('repeat');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0][2]).toBe('VERIFIED');
    const [driver] = await ds.query(`SELECT "status", "verificationStatus", "verifiedAt", "submittedAt" FROM "drivers" WHERE "id" = $1`, [id]);
    expect(driver).toMatchObject({ status: 'OFFLINE', verificationStatus: 'PENDING', verifiedAt: null });
    expect(driver.submittedAt).not.toBeNull();
    expect(await history(id)).toEqual(['VERIFIED', 'WITHDRAWN']);
  });

  it("refuses someone else's decision, a closed window and a driver on a delivery", async () => {
    await expect(repo.undoDecision(await approved(randomUUID()), reviewer, 10)).rejects.toThrow(UndoNotAllowedError);
    await expect(repo.undoDecision(await approved(), reviewer, -1)).rejects.toThrow(UndoWindowClosedError);
    await expect(repo.undoDecision(await approved(reviewer, 'BUSY'), reviewer, 10)).rejects.toThrow(UndoDriverOnDeliveryError);
    await expect(repo.undoDecision(randomUUID(), reviewer, 10)).rejects.toThrow(UndoNotAllowedError);
  });
});
