/**
 * The driver application (#207) against real PostgreSQL: the draft lock, document versions, the
 * national ID uniqueness and the CHECK constraints live in SQL, which a mocked repository can't prove.
 *
 * Opt-in like drivers.repository.integration.spec.ts: set DRIVER_TEST_DATABASE_URL to a DISPOSABLE
 * database (the public schema is dropped and recreated).
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Driver } from '../entities/driver.entity';
import { DriverDocument } from '../entities/driver-document.entity';
import { DriverDocumentAccess } from '../entities/driver-document-access.entity';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { InitialSchema1700000000000 } from '../database/migrations/001-initial-schema';
import { UuidPrimaryKeyDefaults1700000000001 } from '../database/migrations/002-uuid-primary-key-defaults';
import { DriverVerification1700000000002 } from '../database/migrations/003-driver-verification';
import { VerifyExistingDrivers1700000000003 } from '../database/migrations/004-verify-existing-drivers';
import { DriverAvailableSince1700000000004 } from '../database/migrations/005-driver-available-since';
import { DriverEffectiveIdleIndex1700000000005 } from '../database/migrations/006-driver-effective-idle-index';
import { DriverApplicationDocuments1700000000006 } from '../database/migrations/007-driver-application-documents';
import { DriverReviews1700000000007 } from '../database/migrations/008-driver-reviews';
import { DriverReview } from '../entities/driver-review.entity';
import {
  ApplicationLockedError,
  DocumentVersionLimitError,
  DriverApplicationRepository,
  DuplicateNationalIdError,
  NewDocumentVersion,
  NotInReviewError,
} from './driver-application.repository';
import { DriversRepository } from './drivers.repository';

const DATABASE_URL = process.env.DRIVER_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

const BEFORE_207 = [
  InitialSchema1700000000000,
  UuidPrimaryKeyDefaults1700000000001,
  DriverVerification1700000000002,
  VerifyExistingDrivers1700000000003,
  DriverAvailableSince1700000000004,
  DriverEffectiveIdleIndex1700000000005,
];
const ALL_MIGRATIONS = [...BEFORE_207, DriverApplicationDocuments1700000000006, DriverReviews1700000000007];
const ENTITIES = [Driver, DriverDocument, DriverDocumentAccess, DriverReview];

const FIELDS = {
  nationalIdLast4: '4567',
  nationalIdHash: 'a'.repeat(64),
  drivingLicenceExpiresOn: '2028-05-31',
  vehicleLicenceExpiresOn: '2027-01-15',
};

function upload(overrides: Partial<NewDocumentVersion> = {}): NewDocumentVersion {
  return {
    objectKey: `drivers/x/documents/selfie/${randomUUID()}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 1234,
    sha256: 'b'.repeat(64),
    ...overrides,
  };
}

describeDb('DriverApplicationRepository (PostgreSQL integration, #207)', () => {
  jest.setTimeout(30_000);

  let ds: DataSource;
  let repo: DriverApplicationRepository;

  async function freshSchema(migrations = ALL_MIGRATIONS) {
    const setup = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, ENTITIES, { migrations }));
    await setup.initialize();
    await setup.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await setup.runMigrations();
    await setup.destroy();
  }

  async function open() {
    ds = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, ENTITIES, { migrations: ALL_MIGRATIONS }));
    await ds.initialize();
    repo = new DriverApplicationRepository(ds);
  }

  async function insertDriver(verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED' = 'PENDING', db = ds): Promise<string> {
    const [row] = await db.query(
      `INSERT INTO "drivers" ("userId", "vehicleType", "licensePlate", "status", "verificationStatus")
       VALUES ($1, 'Scooter', $2, 'OFFLINE', $3) RETURNING "id"`,
      [randomUUID(), `QA-${randomUUID().slice(0, 6)}`, verificationStatus],
    );
    return row.id;
  }

  afterEach(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  describe('migration 007', () => {
    it('keeps existing drivers as they were: verified drivers stay verified, pending ones become drafts', async () => {
      await freshSchema(BEFORE_207);
      const before = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [], { migrations: BEFORE_207 }));
      await before.initialize();
      const verified = await insertDriver('VERIFIED', before);
      const pending = await insertDriver('PENDING', before);
      await before.destroy();

      await open();
      expect(await ds.runMigrations()).toHaveLength(2);

      expect(await repo.findApplication(verified)).toMatchObject({ verificationStatus: 'VERIFIED', submittedAt: null, nationalIdLast4: null });
      expect(await repo.findApplication(pending)).toMatchObject({ verificationStatus: 'PENDING', submittedAt: null });

      await ds.undoLastMigration();
      await ds.undoLastMigration();
      expect(await ds.runMigrations()).toHaveLength(2);
    });

    it('enforces the value rules in the database too', async () => {
      await freshSchema();
      await open();
      const driverId = await insertDriver();
      const insertDocument = (type: string, contentType: string) =>
        ds.query(
          `INSERT INTO driver_documents ("driverId", "type", "version", "objectKey", "contentType", "sizeBytes", "sha256")
           VALUES ($1, $2, 1, $3, $4, 10, $5)`,
          [driverId, type, randomUUID(), contentType, 'c'.repeat(64)],
        );

      await expect(insertDocument('passport', 'image/jpeg')).rejects.toThrow(/CHK_driver_documents_type/);
      await expect(insertDocument('selfie', 'text/html')).rejects.toThrow(/CHK_driver_documents_content_type/);
      await expect(
        ds.query(`UPDATE drivers SET "nationalIdLast4" = '45a7', "nationalIdHash" = $2 WHERE id = $1`, [driverId, 'a'.repeat(64)]),
      ).rejects.toThrow(/CHK_drivers_national_id/);
      await expect(ds.query(`UPDATE drivers SET "nationalIdLast4" = '4567' WHERE id = $1`, [driverId])).rejects.toThrow(/CHK_drivers_national_id/);
    });
  });

  describe('application fields', () => {
    beforeEach(async () => {
      await freshSchema();
      await open();
    });

    it('saves the fields of a draft and never selects the hash', async () => {
      const driverId = await insertDriver();
      await repo.saveFieldsIfEditable(driverId, FIELDS);

      const row = await repo.findApplication(driverId);
      expect(row).toMatchObject({ nationalIdLast4: '4567', drivingLicenceExpiresOn: '2028-05-31', vehicleLicenceExpiresOn: '2027-01-15' });
      expect(row).not.toHaveProperty('nationalIdHash');
      expect(await ds.getRepository(Driver).findOneByOrFail({ id: driverId })).not.toHaveProperty('nationalIdLast4');
    });

    it('lets one national ID back only one driver account', async () => {
      const first = await insertDriver();
      const second = await insertDriver();
      await repo.saveFieldsIfEditable(first, FIELDS);
      await repo.saveFieldsIfEditable(first, FIELDS); // Saving your own ID again is fine.

      await expect(repo.saveFieldsIfEditable(second, FIELDS)).rejects.toBeInstanceOf(DuplicateNationalIdError);
    });

    it('refuses to change a VERIFIED driver', async () => {
      const driverId = await insertDriver('VERIFIED');
      await expect(repo.saveFieldsIfEditable(driverId, FIELDS)).rejects.toBeInstanceOf(ApplicationLockedError);
    });

    it('lets a REJECTED driver correct the application to resubmit', async () => {
      const driverId = await insertDriver('REJECTED');
      await repo.saveFieldsIfEditable(driverId, FIELDS);
      expect(await repo.findApplication(driverId)).toMatchObject({ verificationStatus: 'REJECTED', nationalIdLast4: '4567' });
    });

    it('refuses to change a submitted application', async () => {
      const driverId = await insertDriver();
      await ds.query(`UPDATE drivers SET "submittedAt" = now() WHERE id = $1`, [driverId]);
      await expect(repo.saveFieldsIfEditable(driverId, FIELDS)).rejects.toBeInstanceOf(ApplicationLockedError);
    });
  });

  describe('documents', () => {
    beforeEach(async () => {
      await freshSchema();
      await open();
    });

    it('keeps replaced versions and exactly one current version per type', async () => {
      const driverId = await insertDriver();
      const first = await repo.addDocumentVersion(driverId, 'selfie', upload(), 5);
      const second = await repo.addDocumentVersion(driverId, 'selfie', upload(), 5);
      await repo.addDocumentVersion(driverId, 'driving-licence', upload({ contentType: 'application/pdf' }), 5);

      expect([first.version, second.version]).toEqual([1, 2]);
      const current = await repo.currentDocuments(driverId);
      expect(current.map((document) => [document.type, document.version])).toEqual([
        ['driving-licence', 1],
        ['selfie', 2],
      ]);
      expect(current[0]).not.toHaveProperty('objectKey');
      expect(await ds.getRepository(DriverDocument).countBy({ driverId, type: 'selfie' })).toBe(2);
    });

    it('is idempotent per object key, so a retried confirm adds nothing', async () => {
      const driverId = await insertDriver();
      const same = upload();
      const first = await repo.addDocumentVersion(driverId, 'selfie', same, 5);
      const retried = await repo.addDocumentVersion(driverId, 'selfie', same, 5);

      expect(retried.id).toBe(first.id);
      expect(await ds.getRepository(DriverDocument).countBy({ driverId })).toBe(1);
    });

    it('caps the versions per document type', async () => {
      const driverId = await insertDriver();
      for (let i = 0; i < 5; i++) await repo.addDocumentVersion(driverId, 'selfie', upload(), 5);
      await expect(repo.addDocumentVersion(driverId, 'selfie', upload(), 5)).rejects.toBeInstanceOf(DocumentVersionLimitError);
      // Other types are counted on their own.
      await expect(repo.addDocumentVersion(driverId, 'driving-licence', upload(), 5)).resolves.toMatchObject({ version: 1 });
    });

    it('refuses documents once the application is submitted', async () => {
      const driverId = await insertDriver();
      await ds.query(`UPDATE drivers SET "submittedAt" = now() WHERE id = $1`, [driverId]);
      await expect(repo.addDocumentVersion(driverId, 'selfie', upload(), 5)).rejects.toBeInstanceOf(ApplicationLockedError);
    });

    it('returns the object key only to the staff read query', async () => {
      const driverId = await insertDriver();
      const stored = upload();
      await repo.addDocumentVersion(driverId, 'selfie', stored, 5);
      expect(await repo.findCurrentDocumentWithKey(driverId, 'selfie')).toMatchObject({ objectKey: stored.objectKey, version: 1 });
      expect(await repo.findCurrentDocumentWithKey(driverId, 'driving-licence')).toBeNull();
    });

    it('deletes documents with the driver', async () => {
      const driverId = await insertDriver();
      await repo.addDocumentVersion(driverId, 'selfie', upload(), 5);
      await ds.query('DELETE FROM drivers WHERE id = $1', [driverId]);
      expect(await ds.getRepository(DriverDocument).countBy({ driverId })).toBe(0);
    });
  });

  describe('submit', () => {
    beforeEach(async () => {
      await freshSchema();
      await open();
    });

    it('sets submittedAt once, and a second submit is refused', async () => {
      const driverId = await insertDriver();
      await repo.submitIfEditable(driverId, () => undefined);
      expect((await repo.findApplication(driverId))?.submittedAt).toBeInstanceOf(Date);
      await expect(repo.submitIfEditable(driverId, () => undefined)).rejects.toBeInstanceOf(ApplicationLockedError);
    });

    it('writes nothing when the check refuses', async () => {
      const driverId = await insertDriver();
      await expect(
        repo.submitIfEditable(driverId, () => {
          throw new Error('incomplete');
        }),
      ).rejects.toThrow('incomplete');
      expect((await repo.findApplication(driverId))?.submittedAt).toBeNull();
    });

    it('gives the check the locked driver and its current documents', async () => {
      const driverId = await insertDriver();
      await repo.saveFieldsIfEditable(driverId, FIELDS);
      await repo.addDocumentVersion(driverId, 'selfie', upload(), 5);
      await repo.addDocumentVersion(driverId, 'selfie', upload(), 5);

      const check = jest.fn();
      await repo.submitIfEditable(driverId, check);
      const [driver, documents] = check.mock.calls[0];
      expect(driver).toMatchObject({ id: driverId, nationalIdLast4: '4567' });
      expect(documents.map((document: DriverDocument) => document.version)).toEqual([2]);
    });

    it('serializes a submit and a document confirm racing on the same draft', async () => {
      const driverId = await insertDriver();
      const outcomes = await Promise.allSettled([
        repo.submitIfEditable(driverId, () => undefined),
        repo.addDocumentVersion(driverId, 'selfie', upload(), 5),
      ]);
      const submitted = (await repo.findApplication(driverId))?.submittedAt;
      const documents = await ds.getRepository(DriverDocument).countBy({ driverId });

      expect(submitted).toBeInstanceOf(Date);
      // Either the document landed before the submit locked the row, or it was refused after.
      if (outcomes[1].status === 'rejected') {
        expect(outcomes[1].reason).toBeInstanceOf(ApplicationLockedError);
        expect(documents).toBe(0);
      } else {
        expect(documents).toBe(1);
      }
    });
  });

  it('records staff reads without any URL', async () => {
    await freshSchema();
    await open();
    const driverId = await insertDriver();
    const record = await repo.recordAccess({
      staffUserId: randomUUID(),
      driverId,
      documentId: randomUUID(),
      documentType: 'selfie',
      documentVersion: 1,
    });
    const [row] = await ds.query('SELECT * FROM driver_document_access WHERE id = $1', [record.id]);
    expect(Object.keys(row).sort()).toEqual(['accessedAt', 'documentId', 'documentType', 'documentVersion', 'driverId', 'id', 'staffUserId']);
  });
  describe('reviews and resubmission', () => {
    beforeEach(async () => {
      await freshSchema();
      await open();
    });

    const reviewer = randomUUID();
    const secondReviewer = randomUUID();

    async function submittedDriver(): Promise<{ driverId: string; submittedAt: Date }> {
      const driverId = await insertDriver();
      await repo.saveFieldsIfEditable(driverId, { ...FIELDS, nationalIdHash: randomUUID().replace(/-/g, '').padEnd(64, '0') });
      await repo.addDocumentVersion(driverId, 'selfie', upload(), 5);
      await repo.submitIfEditable(driverId, () => undefined);
      return { driverId, submittedAt: (await repo.findApplication(driverId))!.submittedAt as Date };
    }

    it('rejected, corrected, resubmitted and approved: the history keeps both reviews and their documents', async () => {
      const { driverId, submittedAt } = await submittedDriver();
      const firstSelfie = (await repo.currentDocuments(driverId))[0];

      expect(
        await repo.decideIfSubmitted(driverId, { decision: 'REJECTED', note: 'Selfie is blurry', reviewerUserId: reviewer, submittedAt }, () => undefined),
      ).toBe('decided');
      expect(await repo.findApplication(driverId)).toMatchObject({ verificationStatus: 'REJECTED', verificationNote: 'Selfie is blurry', verifiedAt: null });

      // The rejected driver replaces the document and resubmits.
      await repo.addDocumentVersion(driverId, 'selfie', upload(), 5);
      await repo.submitIfEditable(driverId, () => undefined);
      const resubmitted = (await repo.findApplication(driverId))!;
      expect(resubmitted).toMatchObject({ verificationStatus: 'PENDING', verificationNote: null });
      expect(resubmitted.submittedAt!.getTime()).toBeGreaterThan(submittedAt.getTime());
      const secondSelfie = (await repo.currentDocuments(driverId))[0];

      expect(
        await repo.decideIfSubmitted(
          driverId,
          { decision: 'VERIFIED', note: null, reviewerUserId: secondReviewer, submittedAt: resubmitted.submittedAt! },
          () => undefined,
        ),
      ).toBe('decided');
      const approved = (await repo.findApplication(driverId))!;
      expect(approved.verificationStatus).toBe('VERIFIED');
      expect(approved.verifiedAt).toBeInstanceOf(Date);

      const history = await repo.reviews(driverId);
      expect(history.map(({ decision, note, reviewerUserId }) => ({ decision, note, reviewerUserId }))).toEqual([
        { decision: 'VERIFIED', note: null, reviewerUserId: secondReviewer },
        { decision: 'REJECTED', note: 'Selfie is blurry', reviewerUserId: reviewer },
      ]);
      expect(history[0].documentIds).toEqual([secondSelfie.id]);
      expect(history[1].documentIds).toEqual([firstSelfie.id]);
      expect(history[1].applicationSubmittedAt!.getTime()).toBe(submittedAt.getTime());
      // The replaced version is still there for the review that used it.
      expect((await repo.documentVersions([firstSelfie.id])).map(({ version }) => version)).toEqual([1]);
    });

    it('refuses a decision on a draft, or on a submission the driver has replaced', async () => {
      const draft = await insertDriver();
      await expect(
        repo.decideIfSubmitted(draft, { decision: 'VERIFIED', note: null, reviewerUserId: reviewer, submittedAt: new Date() }, () => undefined),
      ).rejects.toBeInstanceOf(NotInReviewError);

      const { driverId, submittedAt } = await submittedDriver();
      await expect(
        repo.decideIfSubmitted(driverId, { decision: 'VERIFIED', note: null, reviewerUserId: reviewer, submittedAt: new Date(submittedAt.getTime() - 1000) }, () => undefined),
      ).rejects.toBeInstanceOf(NotInReviewError);
      expect(await repo.reviews(driverId)).toHaveLength(0);
      expect((await repo.findApplication(driverId))!.verificationStatus).toBe('PENDING');
    });

    it('treats the same decision repeated as a no-op, and refuses to flip a decided application', async () => {
      const { driverId, submittedAt } = await submittedDriver();
      const reject = { decision: 'REJECTED' as const, note: 'Licence photo cut off', reviewerUserId: reviewer, submittedAt };
      expect(await repo.decideIfSubmitted(driverId, reject, () => undefined)).toBe('decided');
      expect(await repo.decideIfSubmitted(driverId, reject, () => undefined)).toBe('repeat');
      await expect(
        repo.decideIfSubmitted(driverId, { ...reject, decision: 'VERIFIED', note: null }, () => undefined),
      ).rejects.toBeInstanceOf(NotInReviewError);
      expect(await repo.reviews(driverId)).toHaveLength(1);
    });

    it('lets only one of two racing reviewers decide', async () => {
      const { driverId, submittedAt } = await submittedDriver();
      const outcomes = await Promise.allSettled([
        repo.decideIfSubmitted(driverId, { decision: 'VERIFIED', note: null, reviewerUserId: reviewer, submittedAt }, () => undefined),
        repo.decideIfSubmitted(driverId, { decision: 'REJECTED', note: 'Not readable', reviewerUserId: secondReviewer, submittedAt }, () => undefined),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      const refused = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(NotInReviewError);
      expect(await repo.reviews(driverId)).toHaveLength(1);
    });

    it('writes nothing when the check refuses the decision', async () => {
      const { driverId, submittedAt } = await submittedDriver();
      await expect(
        repo.decideIfSubmitted(driverId, { decision: 'VERIFIED', note: null, reviewerUserId: reviewer, submittedAt }, () => {
          throw new Error('incomplete');
        }),
      ).rejects.toThrow('incomplete');
      expect(await repo.reviews(driverId)).toHaveLength(0);
      expect((await repo.findApplication(driverId))!.verificationStatus).toBe('PENDING');
    });

    it('keeps the history append-only, and deletes it with the driver', async () => {
      const { driverId, submittedAt } = await submittedDriver();
      await repo.decideIfSubmitted(driverId, { decision: 'REJECTED', note: 'Blurry', reviewerUserId: reviewer, submittedAt }, () => undefined);
      await expect(ds.query(`UPDATE driver_reviews SET "note" = 'rewritten' WHERE "driverId" = $1`, [driverId])).rejects.toThrow(/append-only/);
      await expect(ds.query(`INSERT INTO driver_reviews ("driverId", "reviewerUserId", "decision") VALUES ($1, $2, 'APPROVED')`, [driverId, reviewer])).rejects.toThrow(
        /CHK_driver_reviews_decision/,
      );

      await ds.query('DELETE FROM drivers WHERE id = $1', [driverId]);
      expect(await ds.getRepository(DriverReview).countBy({ driverId })).toBe(0);
    });

    it('records decisions made through the #147 admin route too, but not a move back to PENDING', async () => {
      const { driverId } = await submittedDriver();
      const drivers = new DriversRepository(ds.getRepository(Driver));
      await drivers.updateVerification(driverId, { verificationStatus: 'VERIFIED', verificationNote: 'Checked in person', verifiedAt: new Date() }, reviewer);
      await drivers.updateVerification(driverId, { verificationStatus: 'PENDING', verificationNote: null, verifiedAt: null }, reviewer);
      await drivers.updateVerification(driverId, { verificationStatus: 'REJECTED', verificationNote: null, verifiedAt: null });

      const history = await repo.reviews(driverId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ decision: 'VERIFIED', note: 'Checked in person', reviewerUserId: reviewer });
      expect(history[0].documentIds).toHaveLength(1);
    });
  });
});
