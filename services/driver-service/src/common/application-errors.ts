import { AppError } from '@food-delivery/shared';
import { DriverDocumentType } from './driver-documents';

/** #207: the application is submitted or decided, so the driver can't change it now (409). */
export class ApplicationNotEditableError extends AppError {
  constructor(applicationStatus: string) {
    super(
      409,
      'ApplicationNotEditable',
      applicationStatus === 'SUBMITTED'
        ? 'Your application is waiting for review and can no longer be changed.'
        : 'Your application can no longer be changed.',
      { applicationStatus },
    );
  }
}

/** #207: another driver account already uses this national ID (409). */
export class NationalIdAlreadyRegisteredError extends AppError {
  constructor() {
    super(409, 'NationalIdAlreadyRegistered', 'This national ID is already registered to another driver account.');
  }
}

/** #207: the document type already has the maximum number of uploads (409). */
export class DocumentVersionLimitError extends AppError {
  constructor(type: DriverDocumentType, maxVersions: number) {
    super(409, 'DocumentVersionLimitReached', `You can upload ${type} at most ${maxVersions} times. Contact support.`, { type, maxVersions });
  }
}

/** #207: submit was called before every field and document was in place (422). */
export class ApplicationIncompleteError extends AppError {
  constructor(missingFields: string[], missingDocuments: DriverDocumentType[], expiredLicences: string[]) {
    super(422, 'ApplicationIncomplete', 'Complete your application before submitting it.', {
      missingFields,
      missingDocuments,
      expiredLicences,
    });
  }
}

/** #207: the driver has no document of this type to read (404). */
export class DocumentNotFoundError extends AppError {
  constructor(type: DriverDocumentType) {
    super(404, 'NotFound', `The driver has no ${type} document`);
  }
}
