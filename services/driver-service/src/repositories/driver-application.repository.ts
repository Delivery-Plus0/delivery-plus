import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { Driver } from '../entities/driver.entity';
import { DriverDocument } from '../entities/driver-document.entity';
import { DriverDocumentAccess } from '../entities/driver-document-access.entity';
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

/** The application could not be written because it is no longer a draft (submitted, verified, rejected). */
export class ApplicationLockedError extends Error {}
/** The national ID is already on another driver account. */
export class DuplicateNationalIdError extends Error {}
/** The document type already has the maximum number of versions. */
export class DocumentVersionLimitError extends Error {}

const DRAFT_WHERE = `"verificationStatus" = 'PENDING' AND "submittedAt" IS NULL`;

/**
 * Storage for the driver application (#207). Every write that depends on the application still being
 * a draft locks the driver row (`SELECT … FOR UPDATE`) and checks it in the same transaction, so a
 * document confirmed while the driver submits either lands before the submit or is refused.
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

  /** Writes the application fields while the application is a draft (compare-and-set). */
  async saveFieldsIfDraft(driverId: string, fields: ApplicationFields): Promise<void> {
    let affected: number | null | undefined;
    try {
      const result = await this.dataSource
        .createQueryBuilder()
        .update(Driver)
        .set(fields)
        .where('id = :driverId', { driverId })
        .andWhere(DRAFT_WHERE)
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

      await this.lockDraft(manager, driverId);

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
   * Submits a draft: `check` sees the locked driver and its current documents and throws to refuse.
   * Returns the submitted driver.
   */
  async submitIfDraft(
    driverId: string,
    check: (driver: DriverApplicationRow, documents: DriverDocument[]) => void,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const driver = await this.lockDraft(manager, driverId);
      const documents = await manager.getRepository(DriverDocument).find({ where: { driverId, isCurrent: true } });
      check(driver, documents);
      await manager
        .createQueryBuilder()
        .update(Driver)
        .set({ submittedAt: () => 'now()' })
        .where('id = :driverId', { driverId })
        .andWhere(DRAFT_WHERE)
        .execute();
    });
  }

  recordAccess(access: Pick<DriverDocumentAccess, 'staffUserId' | 'driverId' | 'documentId' | 'documentType' | 'documentVersion'>): Promise<DriverDocumentAccess> {
    const repository = this.dataSource.getRepository(DriverDocumentAccess);
    return repository.save(repository.create(access));
  }

  private async lockDraft(manager: EntityManager, driverId: string): Promise<DriverApplicationRow> {
    const driver = (await manager
      .getRepository(Driver)
      .createQueryBuilder('driver')
      .addSelect('driver.nationalIdLast4')
      .setLock('pessimistic_write')
      .where('driver.id = :driverId', { driverId })
      .getOne()) as DriverApplicationRow | null;
    if (!driver || driver.verificationStatus !== 'PENDING' || driver.submittedAt) throw new ApplicationLockedError();
    return driver;
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = (error as QueryFailedError & { driverError?: { code?: string; constraint?: string } }).driverError;
  return driverError?.code === '23505' && driverError.constraint === constraint;
}
