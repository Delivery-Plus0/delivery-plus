import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { Driver } from '../entities/driver.entity';
import { DriverDocument } from '../entities/driver-document.entity';
import { DriverDocumentAccess } from '../entities/driver-document-access.entity';
import { DriverReview, DriverReviewDecision } from '../entities/driver-review.entity';
import { DriverDocumentType } from '../common/driver-documents';

/** The application fields of a driver row, including the ones not selected by default. */
export type DriverApplicationRow = Driver & { nationalIdLast4: string | null };

export interface NewDocumentVersion {
  objectKey: string;
  contentType: DriverDocument['contentType'];
  sizeBytes: number;
  sha256: string;
}

export interface ApplicationFields {
  nationalIdLast4: string;
  nationalIdHash: string;
  drivingLicenceExpiresOn: string;
  vehicleLicenceExpiresOn: string;
}

/** The application could not be written because the driver can't change it now (submitted or verified). */
export class ApplicationLockedError extends Error {}
/** A review was refused: the application isn't waiting for review, or a different submission is. */
export class NotInReviewError extends Error {}
/** The national ID is already on another driver account. */
export class DuplicateNationalIdError extends Error {}
/** The document type already has the maximum number of versions. */
export class DocumentVersionLimitError extends Error {}

/**
 * The driver may change the application: a draft (PENDING, never submitted) or, to resubmit, a
 * rejected one. Parenthesized because it is combined with other conditions.
 */
const EDITABLE_WHERE = `(("verificationStatus" = 'PENDING' AND "submittedAt" IS NULL) OR "verificationStatus" = 'REJECTED')`;

export function isEditable(driver: Pick<Driver, 'verificationStatus' | 'submittedAt'>): boolean {
  return (driver.verificationStatus === 'PENDING' && !driver.submittedAt) || driver.verificationStatus === 'REJECTED';
}

export interface ReviewDecision {
  decision: DriverReviewDecision;
  note: string | null;
  reviewerUserId: string;
  /** The submission the reviewer looked at; a different one (resubmitted since) is refused. */
  submittedAt: Date;
}

/**
 * Storage for the driver application (#207). Every write that depends on the application still being
 * editable locks the driver row (`SELECT … FOR UPDATE`) and checks it in the same transaction, so a
 * document confirmed while the driver submits either lands before the submit or is refused. Reviews
 * lock the same row, so a decision and a resubmission never interleave.
 */
@Injectable()
export class DriverApplicationRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** The driver with the application columns that are not selected by default (never the hash). */
  findApplication(driverId: string): Promise<DriverApplicationRow | null> {
    return this.dataSource
      .getRepository(Driver)
      .createQueryBuilder('driver')
      .addSelect('driver.nationalIdLast4')
      .where('driver.id = :driverId', { driverId })
      .getOne() as Promise<DriverApplicationRow | null>;
  }

  currentDocuments(driverId: string): Promise<DriverDocument[]> {
    return this.dataSource.getRepository(DriverDocument).find({
      where: { driverId, isCurrent: true },
      order: { type: 'ASC' },
    });
  }

  /** The current version of one document, with its object key, for a staff read. */
  findCurrentDocumentWithKey(driverId: string, type: DriverDocumentType): Promise<DriverDocument | null> {
    return this.dataSource
      .getRepository(DriverDocument)
      .createQueryBuilder('document')
      .addSelect('document.objectKey')
      .where('document.driverId = :driverId AND document.type = :type AND document.isCurrent', { driverId, type })
      .getOne();
  }

  /** Writes the application fields while the application is editable (compare-and-set). */
  async saveFieldsIfEditable(driverId: string, fields: ApplicationFields): Promise<void> {
    let affected: number | null | undefined;
    try {
      const result = await this.dataSource
        .createQueryBuilder()
        .update(Driver)
        .set(fields)
        .where('id = :driverId', { driverId })
        .andWhere(EDITABLE_WHERE)
        .execute();
      affected = result.affected;
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_drivers_national_id_hash')) throw new DuplicateNationalIdError();
      throw error;
    }
    if (!affected) throw new ApplicationLockedError();
  }

  /**
   * Records a confirmed upload as the document's new current version. Idempotent per object key: a
   * retried confirm returns the row the first one wrote, whatever state the application is in now.
   */
  async addDocumentVersion(
    driverId: string,
    type: DriverDocumentType,
    upload: NewDocumentVersion,
    maxVersions: number,
  ): Promise<DriverDocument> {
    return this.dataSource.transaction(async (manager) => {
      const documents = manager.getRepository(DriverDocument);
      const existing = await documents.findOne({ where: { objectKey: upload.objectKey } });
      if (existing) return existing;

      await this.lockEditable(manager, driverId);

      const { max } = await documents
        .createQueryBuilder('document')
        .select('COALESCE(MAX(document.version), 0)', 'max')
        .where('document.driverId = :driverId AND document.type = :type', { driverId, type })
        .getRawOne<{ max: number | string }>() ?? { max: 0 };
      const version = Number(max) + 1;
      if (version > maxVersions) throw new DocumentVersionLimitError();

      await documents.update({ driverId, type, isCurrent: true }, { isCurrent: false });
      const created = await documents.save(documents.create({ driverId, type, version, isCurrent: true, ...upload }));
      return documents.findOneOrFail({ where: { id: created.id } });
    });
  }

  /**
   * Submits a draft, or resubmits a rejected application: `check` sees the locked driver and its
   * current documents and throws to refuse. The driver goes back to PENDING with a new `submittedAt`,
   * and the previous decision's note is cleared from the row (the review history keeps it).
   */
  async submitIfEditable(
    driverId: string,
    check: (driver: DriverApplicationRow, documents: DriverDocument[]) => void,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const driver = await this.lockEditable(manager, driverId);
      const documents = await manager.getRepository(DriverDocument).find({ where: { driverId, isCurrent: true } });
      check(driver, documents);
      await manager
        .createQueryBuilder()
        .update(Driver)
        .set({ verificationStatus: 'PENDING', verificationNote: null, verifiedAt: null, submittedAt: () => 'now()' })
        .where('id = :driverId', { driverId })
        .andWhere(EDITABLE_WHERE)
        .execute();
    });
  }

  /**
   * Records a staff decision on a submitted application, compare-and-set under the driver row lock:
   * only a driver still PENDING with exactly the submission the reviewer looked at is decided. `check`
   * sees the locked driver and documents and throws to refuse (an approval needs a valid application).
   *
   * Repeating the last decision on the same submission (same decision and note) is a no-op that returns
   * `'repeat'`; anything else on an application not in review throws NotInReviewError.
   */
  async decideIfSubmitted(
    driverId: string,
    review: ReviewDecision,
    check: (driver: DriverApplicationRow, documents: DriverDocument[]) => void,
  ): Promise<'decided' | 'repeat'> {
    return this.dataSource.transaction(async (manager) => {
      const driver = await this.lockRow(manager, driverId);
      if (!driver) throw new NotInReviewError();
      const sameSubmission = driver.submittedAt?.getTime() === review.submittedAt.getTime();

      if (driver.verificationStatus === 'PENDING' && driver.submittedAt && sameSubmission) {
        const documents = await manager.getRepository(DriverDocument).find({ where: { driverId, isCurrent: true } });
        check(driver, documents);
        await manager
          .createQueryBuilder()
          .update(Driver)
          .set({
            verificationStatus: review.decision,
            verificationNote: review.note,
            verifiedAt: review.decision === 'VERIFIED' ? () => 'now()' : null,
          })
          .where('id = :driverId', { driverId })
          .andWhere(`"verificationStatus" = 'PENDING' AND "submittedAt" IS NOT NULL`)
          .execute();
        await manager.getRepository(DriverReview).insert({
          driverId,
          reviewerUserId: review.reviewerUserId,
          decision: review.decision,
          note: review.note,
          applicationSubmittedAt: driver.submittedAt,
          documentIds: documents.map((document) => document.id).sort(),
        });
        return 'decided';
      }

      const latest = await manager.getRepository(DriverReview).findOne({ where: { driverId }, order: { reviewedAt: 'DESC', id: 'DESC' } });
      const repeat =
        sameSubmission &&
        driver.verificationStatus === review.decision &&
        latest?.decision === review.decision &&
        latest.applicationSubmittedAt?.getTime() === review.submittedAt.getTime() &&
        (latest.note ?? null) === review.note;
      if (repeat) return 'repeat';
      throw new NotInReviewError();
    });
  }

  /** The review history, newest first. */
  reviews(driverId: string): Promise<DriverReview[]> {
    return this.dataSource.getRepository(DriverReview).find({ where: { driverId }, order: { reviewedAt: 'DESC', id: 'DESC' } });
  }

  /** Type and version of each listed document, for the review history. */
  async documentVersions(documentIds: string[]): Promise<Pick<DriverDocument, 'id' | 'type' | 'version'>[]> {
    if (!documentIds.length) return [];
    return this.dataSource
      .getRepository(DriverDocument)
      .createQueryBuilder('document')
      .select(['document.id', 'document.type', 'document.version'])
      .where('document.id IN (:...documentIds)', { documentIds })
      .getMany();
  }

  recordAccess(access: Pick<DriverDocumentAccess, 'staffUserId' | 'driverId' | 'documentId' | 'documentType' | 'documentVersion'>): Promise<DriverDocumentAccess> {
    const repository = this.dataSource.getRepository(DriverDocumentAccess);
    return repository.save(repository.create(access));
  }

  private async lockEditable(manager: EntityManager, driverId: string): Promise<DriverApplicationRow> {
    const driver = await this.lockRow(manager, driverId);
    if (!driver || !isEditable(driver)) throw new ApplicationLockedError();
    return driver;
  }

  private lockRow(manager: EntityManager, driverId: string): Promise<DriverApplicationRow | null> {
    return manager
      .getRepository(Driver)
      .createQueryBuilder('driver')
      .addSelect('driver.nationalIdLast4')
      .setLock('pessimistic_write')
      .where('driver.id = :driverId', { driverId })
      .getOne() as Promise<DriverApplicationRow | null>;
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = (error as QueryFailedError & { driverError?: { code?: string; constraint?: string } }).driverError;
  return driverError?.code === '23505' && driverError.constraint === constraint;
}
