/** The documents a driver application needs (#207). The values are part of the API and the database. */
export const DRIVER_DOCUMENT_TYPES = [
  'national-id-front',
  'national-id-back',
  'driving-licence',
  'vehicle-licence',
  'selfie',
] as const;
export type DriverDocumentType = (typeof DRIVER_DOCUMENT_TYPES)[number];

export function isDriverDocumentType(value: string): value is DriverDocumentType {
  return (DRIVER_DOCUMENT_TYPES as readonly string[]).includes(value);
}

/** 10 MB, the issue's limit, enforced by the upload policy and again on confirm. */
export const DRIVER_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Uploads kept per document type, current one included. Replaced versions stay with the review that used
 * them (#207), so this bounds what one account can store; past it, confirm answers 409.
 */
export const MAX_DOCUMENT_VERSIONS_PER_TYPE = 5;

/** Where the driver's uploads wait to be checked, under the bucket's `pending/` prefix. */
export function pendingDocumentPrefix(driverId: string, type: DriverDocumentType): string {
  return `drivers/${driverId}/${type}/`;
}

/** Where checked documents live: `drivers/{driverId}/documents/{type}/{uploadId}.{ext}`. */
export function documentPrefix(driverId: string, type: DriverDocumentType): string {
  return `drivers/${driverId}/documents/${type}/`;
}
