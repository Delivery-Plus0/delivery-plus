import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  BadRequestError,
  NotFoundError,
  PresignedUpload,
  PrivateDocumentStorage,
} from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { Driver } from '../entities/driver.entity';
import { DriverDocument } from '../entities/driver-document.entity';
import {
  ApplicationLockedError,
  DocumentVersionLimitError as RepositoryVersionLimitError,
  DriverApplicationRepository,
  DriverApplicationRow,
  DuplicateNationalIdError,
} from '../repositories/driver-application.repository';
import {
  DRIVER_DOCUMENT_MAX_BYTES,
  DRIVER_DOCUMENT_TYPES,
  DriverDocumentType,
  MAX_DOCUMENT_VERSIONS_PER_TYPE,
  documentPrefix,
  isDriverDocumentType,
  pendingDocumentPrefix,
} from '../common/driver-documents';
import {
  ApplicationIncompleteError,
  ApplicationNotEditableError,
  DocumentNotFoundError,
  DocumentVersionLimitError,
  NationalIdAlreadyRegisteredError,
} from '../common/application-errors';
import { SaveDriverApplicationDto } from '../dto/driver-application.dto';

export const DRIVER_DOCUMENT_STORAGE = Symbol('DRIVER_DOCUMENT_STORAGE');

/** Where the application stands, derived from the driver row (no separate column, #207). */
export type ApplicationStatus = 'DRAFT' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED';

export interface ApplicationDocumentView {
  type: DriverDocumentType;
  version: number;
  contentType: DriverDocument['contentType'];
  sizeBytes: number;
  uploadedAt: Date;
}

export interface DriverApplicationView {
  driverId: string;
  status: ApplicationStatus;
  submittedAt: Date | null;
  verificationNote: string | null;
  nationalIdLast4: string | null;
  drivingLicenceExpiresOn: string | null;
  vehicleLicenceExpiresOn: string | null;
  documents: ApplicationDocumentView[];
  missingDocuments: DriverDocumentType[];
  canSubmit: boolean;
}

export interface DocumentReadUrl {
  type: DriverDocumentType;
  version: number;
  contentType: DriverDocument['contentType'];
  url: string;
  expiresIn: number;
}

/** A licence expiry further out than this is a typo, not a licence. */
const MAX_EXPIRY_YEARS_AHEAD = 15;

/**
 * The driver application (#207, first part): application fields, documents in the private bucket and
 * submitting for review. Reviews and resubmission, and the expiry job, come next.
 *
 * - A driver is a draft (`PENDING`, no `submittedAt`) until they submit; only a draft can be edited.
 * - Documents are uploaded straight to object storage through a presigned POST, then confirmed: the
 *   bytes are checked and copied to a key under the driver's own prefix. Only the key is stored.
 * - Only staff with `onboarding.review` ever get a URL to a document, valid five minutes, and every
 *   such read is recorded in `driver_document_access`. No URL is ever logged or stored.
 */
@Injectable()
export class DriverApplicationService {
  constructor(
    private readonly applications: DriverApplicationRepository,
    @Inject(DRIVER_DOCUMENT_STORAGE) private readonly storage: PrivateDocumentStorage,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async getApplication(driverId: string, now = new Date()): Promise<DriverApplicationView> {
    const driver = await this.requireApplication(driverId);
    return this.view(driver, await this.applications.currentDocuments(driverId), now);
  }

  async saveApplication(driverId: string, dto: SaveDriverApplicationDto, now = new Date()): Promise<DriverApplicationView> {
    const today = cairoDate(now);
    assertExpiryDate('drivingLicenceExpiresOn', dto.drivingLicenceExpiresOn, today);
    assertExpiryDate('vehicleLicenceExpiresOn', dto.vehicleLicenceExpiresOn, today);

    const driver = await this.requireApplication(driverId);
    assertDraft(driver);
    try {
      await this.applications.saveFieldsIfDraft(driverId, {
        nationalIdLast4: dto.nationalIdNumber.slice(-4),
        nationalIdHash: this.hashNationalId(dto.nationalIdNumber),
        drivingLicenceExpiresOn: dto.drivingLicenceExpiresOn,
        vehicleLicenceExpiresOn: dto.vehicleLicenceExpiresOn,
      });
    } catch (error) {
      throw await this.refusal(error, driverId);
    }
    return this.getApplication(driverId, now);
  }

  async createUpload(driverId: string, type: string, contentType: string): Promise<PresignedUpload> {
    const documentType = parseDocumentType(type);
    assertDraft(await this.requireApplication(driverId));
    return this.storage.createUpload(pendingDocumentPrefix(driverId, documentType), contentType, DRIVER_DOCUMENT_MAX_BYTES);
  }

  async confirmUpload(driverId: string, type: string, objectKey: string, now = new Date()): Promise<DriverApplicationView> {
    const documentType = parseDocumentType(type);
    assertDraft(await this.requireApplication(driverId));
    const promoted = await this.storage.promote(
      objectKey,
      pendingDocumentPrefix(driverId, documentType),
      documentPrefix(driverId, documentType),
      DRIVER_DOCUMENT_MAX_BYTES,
    );
    try {
      await this.applications.addDocumentVersion(
        driverId,
        documentType,
        {
          objectKey: promoted.objectKey,
          contentType: promoted.contentType,
          sizeBytes: promoted.contentLength,
          sha256: promoted.sha256,
        },
        MAX_DOCUMENT_VERSIONS_PER_TYPE,
      );
    } catch (error) {
      if (error instanceof RepositoryVersionLimitError) {
        throw new DocumentVersionLimitError(documentType, MAX_DOCUMENT_VERSIONS_PER_TYPE);
      }
      throw await this.refusal(error, driverId);
    }
    return this.getApplication(driverId, now);
  }

  /** Sends a complete draft to the review queue. */
  async submit(driverId: string, now = new Date()): Promise<DriverApplicationView> {
    await this.requireApplication(driverId);
    try {
      await this.applications.submitIfDraft(driverId, (driver, documents) => {
        const problems = applicationProblems(driver, documents, cairoDate(now));
        if (problems) throw new ApplicationIncompleteError(problems.missingFields, problems.missingDocuments, problems.expiredLicences);
      });
    } catch (error) {
      throw await this.refusal(error, driverId);
    }
    return this.getApplication(driverId, now);
  }

  /**
   * Staff with `onboarding.review` only (checked by the route's guard). Records the read first: if the
   * record can't be written, no URL is issued.
   */
  async createReadUrl(staffUserId: string, driverId: string, type: string): Promise<DocumentReadUrl> {
    const documentType = parseDocumentType(type);
    await this.requireApplication(driverId);
    const document = await this.applications.findCurrentDocumentWithKey(driverId, documentType);
    if (!document) throw new DocumentNotFoundError(documentType);

    await this.applications.recordAccess({
      staffUserId,
      driverId,
      documentId: document.id,
      documentType,
      documentVersion: document.version,
    });
    const { url, expiresIn } = await this.storage.createReadUrl(document.objectKey);
    return { type: documentType, version: document.version, contentType: document.contentType, url, expiresIn };
  }

  private async requireApplication(driverId: string): Promise<DriverApplicationRow> {
    const driver = await this.applications.findApplication(driverId);
    if (!driver) throw new NotFoundError(`Driver ${driverId} not found`);
    return driver;
  }

  private hashNationalId(nationalId: string): string {
    return createHmac('sha256', this.config.nationalIdHmacSecret).update(`national-id:v1:${nationalId}`).digest('hex');
  }

  /** Repository refusals become API errors; a refused draft write re-reads the row to say why. */
  private async refusal(error: unknown, driverId: string): Promise<unknown> {
    if (error instanceof ApplicationLockedError) {
      const driver = await this.applications.findApplication(driverId);
      return new ApplicationNotEditableError(driver ? applicationStatus(driver) : 'UNKNOWN');
    }
    if (error instanceof DuplicateNationalIdError) return new NationalIdAlreadyRegisteredError();
    return error;
  }

  private view(driver: DriverApplicationRow, documents: DriverDocument[], now: Date): DriverApplicationView {
    const status = applicationStatus(driver);
    const present = new Set(documents.map((document) => document.type));
    return {
      driverId: driver.id,
      status,
      submittedAt: driver.submittedAt,
      verificationNote: driver.verificationNote,
      nationalIdLast4: driver.nationalIdLast4,
      drivingLicenceExpiresOn: driver.drivingLicenceExpiresOn,
      vehicleLicenceExpiresOn: driver.vehicleLicenceExpiresOn,
      documents: documents.map(({ type, version, contentType, sizeBytes, uploadedAt }) => ({ type, version, contentType, sizeBytes, uploadedAt })),
      missingDocuments: DRIVER_DOCUMENT_TYPES.filter((type) => !present.has(type)),
      canSubmit: status === 'DRAFT' && !applicationProblems(driver, documents, cairoDate(now)),
    };
  }
}

export function applicationStatus(driver: Pick<Driver, 'verificationStatus' | 'submittedAt'>): ApplicationStatus {
  if (driver.verificationStatus === 'PENDING') return driver.submittedAt ? 'SUBMITTED' : 'DRAFT';
  return driver.verificationStatus;
}

function assertDraft(driver: DriverApplicationRow): void {
  const status = applicationStatus(driver);
  if (status !== 'DRAFT') throw new ApplicationNotEditableError(status);
}

function parseDocumentType(type: string): DriverDocumentType {
  if (!isDriverDocumentType(type)) {
    throw new BadRequestError(`Document type must be one of: ${DRIVER_DOCUMENT_TYPES.join(', ')}`);
  }
  return type;
}

/** What stops a draft from being submitted, or undefined when nothing does. */
function applicationProblems(
  driver: DriverApplicationRow,
  documents: Pick<DriverDocument, 'type'>[],
  today: string,
): { missingFields: string[]; missingDocuments: DriverDocumentType[]; expiredLicences: string[] } | undefined {
  const missingFields = (['nationalIdLast4', 'drivingLicenceExpiresOn', 'vehicleLicenceExpiresOn'] as const)
    .filter((field) => !driver[field])
    .map((field) => (field === 'nationalIdLast4' ? 'nationalIdNumber' : field));
  const present = new Set(documents.map((document) => document.type));
  const missingDocuments = DRIVER_DOCUMENT_TYPES.filter((type) => !present.has(type));
  const expiredLicences = (['drivingLicenceExpiresOn', 'vehicleLicenceExpiresOn'] as const).filter(
    (field) => driver[field] !== null && (driver[field] as string) < today,
  );
  return missingFields.length || missingDocuments.length || expiredLicences.length
    ? { missingFields, missingDocuments, expiredLicences }
    : undefined;
}

/** A licence expiry must be a real calendar date, not already past in Cairo, and plausible. */
function assertExpiryDate(field: string, value: string, today: string): void {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new BadRequestError(`${field} is not a real date`);
  }
  if (value < today) throw new BadRequestError(`${field} is in the past: the licence has expired`);
  const latest = `${Number(today.slice(0, 4)) + MAX_EXPIRY_YEARS_AHEAD}${today.slice(4)}`;
  if (value > latest) throw new BadRequestError(`${field} is more than ${MAX_EXPIRY_YEARS_AHEAD} years away`);
}

/** The calendar date in Cairo, YYYY-MM-DD: licence expiry dates are Cairo dates. */
export function cairoDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
