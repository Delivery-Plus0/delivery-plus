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
import { DriverReview, DriverReviewDecision } from '../entities/driver-review.entity';
import {
  ApplicationLockedError,
  NotInReviewError,
  isEditable,
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
  ApplicationNotInReviewError,
  DocumentNotFoundError,
  DocumentVersionLimitError,
  NationalIdAlreadyRegisteredError,
} from '../common/application-errors';
import { ReviewDriverApplicationDto, SaveDriverApplicationDto } from '../dto/driver-application.dto';
import { LicenceField, cairoDate, expiringLicences } from '../common/licence-dates';

export { cairoDate };

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

/** The latest decision, as the driver sees it (no reviewer). */
export interface ApplicationReviewSummary {
  decision: DriverReviewDecision;
  note: string | null;
  reviewedAt: Date;
}

/** One entry of the review history, for staff. */
export interface ApplicationReviewView extends ApplicationReviewSummary {
  id: string;
  reviewerUserId: string;
  applicationSubmittedAt: Date | null;
  documents: { type: DriverDocumentType; version: number }[];
}

export interface DriverApplicationView {
  driverId: string;
  status: ApplicationStatus;
  submittedAt: Date | null;
  verificationNote: string | null;
  lastReview: ApplicationReviewSummary | null;
  nationalIdLast4: string | null;
  drivingLicenceExpiresOn: string | null;
  vehicleLicenceExpiresOn: string | null;
  documents: ApplicationDocumentView[];
  missingDocuments: DriverDocumentType[];
  canSubmit: boolean;
  /** Licences valid today that expire within 14 days (Cairo), soonest first: time to renew. */
  expiringLicences: { field: LicenceField; expiresOn: string }[];
}

/** The staff view also carries the whole review history, newest first. */
export interface StaffDriverApplicationView extends DriverApplicationView {
  reviews: ApplicationReviewView[];
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
 * The driver application (#207): application fields, documents in the private bucket, submitting for
 * review, staff decisions with their history, and resubmission after a rejection.
 *
 * - A driver is a draft (`PENDING`, no `submittedAt`) until they submit. A draft or a rejected
 *   application can be edited; submitting a rejected one sends it back to the review queue.
 * - Staff decide a submitted application with a compare-and-set on that exact submission; every
 *   decision is kept in `driver_reviews` with the document versions it looked at.
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
    const [documents, reviews] = await Promise.all([this.applications.currentDocuments(driverId), this.applications.reviews(driverId)]);
    return this.view(driver, documents, reviews, now);
  }

  /** The application with the full review history, for staff with `onboarding.review`. */
  async getApplicationForStaff(driverId: string, now = new Date()): Promise<StaffDriverApplicationView> {
    const driver = await this.requireApplication(driverId);
    const [documents, reviews] = await Promise.all([this.applications.currentDocuments(driverId), this.applications.reviews(driverId)]);
    const versions = new Map(
      (await this.applications.documentVersions([...new Set(reviews.flatMap((review) => review.documentIds))])).map((document) => [document.id, document]),
    );
    return {
      ...this.view(driver, documents, reviews, now),
      reviews: reviews.map((review) => ({
        id: review.id,
        decision: review.decision,
        note: review.note,
        reviewedAt: review.reviewedAt,
        reviewerUserId: review.reviewerUserId,
        applicationSubmittedAt: review.applicationSubmittedAt,
        documents: review.documentIds
          .map((id) => versions.get(id))
          .filter((document): document is NonNullable<typeof document> => !!document)
          .map(({ type, version }) => ({ type, version }))
          .sort((a, b) => a.type.localeCompare(b.type)),
      })),
    };
  }

  /**
   * A staff decision on a submitted application (`onboarding.review`, checked by the route's guard).
   * `submittedAt` must be the submission the reviewer looked at: if the driver resubmitted since, the
   * decision is refused (409). An approval needs a complete application with no expired licence (422).
   * Repeating the same decision on the same submission returns the application unchanged.
   */
  async review(reviewerUserId: string, driverId: string, dto: ReviewDriverApplicationDto, now = new Date()): Promise<StaffDriverApplicationView> {
    await this.requireApplication(driverId);
    try {
      await this.applications.decideIfSubmitted(
        driverId,
        { decision: dto.decision, note: dto.note ? dto.note : null, reviewerUserId, submittedAt: new Date(dto.submittedAt) },
        (driver, documents) => {
          if (dto.decision !== 'VERIFIED') return;
          const problems = applicationProblems(driver, documents, cairoDate(now));
          if (problems) throw new ApplicationIncompleteError(problems.missingFields, problems.missingDocuments, problems.expiredLicences);
        },
      );
    } catch (error) {
      if (error instanceof NotInReviewError) {
        const driver = await this.applications.findApplication(driverId);
        throw new ApplicationNotInReviewError(driver ? applicationStatus(driver) : 'UNKNOWN');
      }
      throw error;
    }
    return this.getApplicationForStaff(driverId, now);
  }

  async saveApplication(driverId: string, dto: SaveDriverApplicationDto, now = new Date()): Promise<DriverApplicationView> {
    const today = cairoDate(now);
    assertExpiryDate('drivingLicenceExpiresOn', dto.drivingLicenceExpiresOn, today);
    assertExpiryDate('vehicleLicenceExpiresOn', dto.vehicleLicenceExpiresOn, today);

    const driver = await this.requireApplication(driverId);
    assertEditable(driver);
    try {
      await this.applications.saveFieldsIfEditable(driverId, {
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
    assertEditable(await this.requireApplication(driverId));
    return this.storage.createUpload(pendingDocumentPrefix(driverId, documentType), contentType, DRIVER_DOCUMENT_MAX_BYTES);
  }

  async confirmUpload(driverId: string, type: string, objectKey: string, now = new Date()): Promise<DriverApplicationView> {
    const documentType = parseDocumentType(type);
    assertEditable(await this.requireApplication(driverId));
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

  /** Sends a complete draft, or a corrected rejected application, to the review queue. */
  async submit(driverId: string, now = new Date()): Promise<DriverApplicationView> {
    await this.requireApplication(driverId);
    try {
      await this.applications.submitIfEditable(driverId, (driver, documents) => {
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

  private view(driver: DriverApplicationRow, documents: DriverDocument[], reviews: DriverReview[], now: Date): DriverApplicationView {
    const status = applicationStatus(driver);
    const present = new Set(documents.map((document) => document.type));
    const latest = reviews[0];
    return {
      driverId: driver.id,
      status,
      submittedAt: driver.submittedAt,
      verificationNote: driver.verificationNote,
      lastReview: latest ? { decision: latest.decision, note: latest.note, reviewedAt: latest.reviewedAt } : null,
      nationalIdLast4: driver.nationalIdLast4,
      drivingLicenceExpiresOn: driver.drivingLicenceExpiresOn,
      vehicleLicenceExpiresOn: driver.vehicleLicenceExpiresOn,
      documents: documents.map(({ type, version, contentType, sizeBytes, uploadedAt }) => ({ type, version, contentType, sizeBytes, uploadedAt })),
      missingDocuments: DRIVER_DOCUMENT_TYPES.filter((type) => !present.has(type)),
      canSubmit: isEditable(driver) && !applicationProblems(driver, documents, cairoDate(now)),
      expiringLicences: expiringLicences(driver, cairoDate(now)),
    };
  }
}

export function applicationStatus(driver: Pick<Driver, 'verificationStatus' | 'submittedAt'>): ApplicationStatus {
  if (driver.verificationStatus === 'PENDING') return driver.submittedAt ? 'SUBMITTED' : 'DRAFT';
  return driver.verificationStatus;
}

/** A draft or a rejected application (to resubmit) can change; a submitted or verified one can't. */
function assertEditable(driver: DriverApplicationRow): void {
  if (!isEditable(driver)) throw new ApplicationNotEditableError(applicationStatus(driver));
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

