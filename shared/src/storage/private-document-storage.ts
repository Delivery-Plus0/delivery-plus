import { createHash, randomUUID } from 'node:crypto';
import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestError } from '../errors/app-error';
import { detectFileFormat } from './file-signatures';
import { createS3Clients } from './s3-clients';
import { PresignedUpload } from './s3-storage.service';

/** What a private document may be (#207): photos or scans of an ID or licence. */
export const PRIVATE_DOCUMENT_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
} as const;
export type PrivateDocumentContentType = keyof typeof PRIVATE_DOCUMENT_CONTENT_TYPES;

/** A presigned POST is usable for five minutes, like the public media uploads. */
export const PRIVATE_DOCUMENT_UPLOAD_TTL_SECONDS = 300;
/** A staff read URL lives at most five minutes (#207). */
export const PRIVATE_DOCUMENT_READ_URL_MAX_TTL_SECONDS = 300;
/**
 * Uploads land under this prefix and a bucket lifecycle rule deletes everything in it after a day,
 * which also removes uploads that are never confirmed. S3 lifecycle filters match a key prefix, so the
 * quarantine area is one top-level prefix rather than a folder inside each driver's prefix.
 */
export const PRIVATE_DOCUMENT_PENDING_PREFIX = 'pending/';

export interface PrivateDocumentStorageOptions {
  /** The private bucket: no public policy, Block Public Access on. Never the public media bucket. */
  bucket: string;
}

export interface PromotedDocument {
  /** The final key. Store it; never store or log a URL. */
  objectKey: string;
  contentType: PrivateDocumentContentType;
  contentLength: number;
  /** SHA-256 of the bytes, hex: lets a review show which exact file it looked at. */
  sha256: string;
}

export interface PrivateReadUrl {
  url: string;
  expiresIn: number;
}

const UPLOAD_FILE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(jpg|png|pdf)$/;

/**
 * Object storage for personal documents (#207). Unlike `S3StorageService` (public menu and profile
 * images), nothing here is ever public:
 *
 * - uploads go to `pending/<prefix><uuid>.<ext>` through a presigned POST that fixes the key, the
 *   content type and a 1 byte to `maxSizeBytes` size range;
 * - `promote` checks the object (size, issued metadata, the real format from its bytes) and copies it
 *   to a final key the client never chooses, so a still-valid upload policy can't replace it;
 * - reads are presigned GET URLs that live at most five minutes and tell caches not to store the file.
 *
 * Callers authorize every request before calling this; the URLs are the only way to the bytes.
 */
export class PrivateDocumentStorage {
  private readonly client: S3Client;
  private readonly signingClient: S3Client;
  private readonly bucket: string;

  constructor(options: PrivateDocumentStorageOptions, clients = createS3Clients()) {
    if (!options.bucket) throw new Error('A private document bucket name is required');
    this.bucket = options.bucket;
    this.client = clients.client;
    this.signingClient = clients.signingClient;
  }

  /** A presigned POST for one upload under `pending/<keyPrefix>`. */
  async createUpload(keyPrefix: string, contentType: string, maxSizeBytes: number): Promise<PresignedUpload> {
    assertValidKeyPrefix(keyPrefix);
    assertValidMaxSize(maxSizeBytes);
    if (!isPrivateDocumentContentType(contentType)) {
      throw new BadRequestError('Only image/jpeg, image/png, and application/pdf uploads are allowed');
    }

    const extension = PRIVATE_DOCUMENT_CONTENT_TYPES[contentType];
    const objectKey = `${PRIVATE_DOCUMENT_PENDING_PREFIX}${keyPrefix}${randomUUID()}.${extension}`;
    const fields = {
      'Content-Type': contentType,
      'x-amz-meta-max-size-bytes': String(maxSizeBytes),
    };
    const post = await createPresignedPost(this.signingClient, {
      Bucket: this.bucket,
      Key: objectKey,
      Expires: PRIVATE_DOCUMENT_UPLOAD_TTL_SECONDS,
      Fields: fields,
      Conditions: [
        ['content-length-range', 1, maxSizeBytes],
        ['eq', '$Content-Type', contentType],
        ['eq', '$x-amz-meta-max-size-bytes', String(maxSizeBytes)],
      ],
    });

    return {
      uploadUrl: post.url,
      objectKey,
      expiresIn: PRIVATE_DOCUMENT_UPLOAD_TTL_SECONDS,
      method: 'POST',
      fields: post.fields,
    };
  }

  /**
   * Validates an upload under `pending/<pendingKeyPrefix>` and copies it to
   * `<finalKeyPrefix><upload uuid>.<real extension>`. The same upload always promotes to the same final
   * key, so a retried confirm is idempotent.
   */
  async promote(
    pendingKey: string,
    pendingKeyPrefix: string,
    finalKeyPrefix: string,
    maxSizeBytes: number,
  ): Promise<PromotedDocument> {
    assertValidKeyPrefix(pendingKeyPrefix);
    assertValidKeyPrefix(finalKeyPrefix);
    assertValidMaxSize(maxSizeBytes);

    const authorizedPrefix = `${PRIVATE_DOCUMENT_PENDING_PREFIX}${pendingKeyPrefix}`;
    const fileName = pendingKey.startsWith(authorizedPrefix) ? pendingKey.slice(authorizedPrefix.length) : '';
    const match = UPLOAD_FILE_NAME.exec(fileName);
    if (!match) {
      throw new BadRequestError('Uploaded object key is outside the authorized upload prefix');
    }
    const [, uploadId, declaredExtension] = match;

    let head;
    try {
      head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: pendingKey }));
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        throw new BadRequestError('Uploaded object was not found');
      }
      throw error;
    }

    const contentLength = head.ContentLength;
    if (typeof contentLength !== 'number' || !Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > maxSizeBytes) {
      throw new BadRequestError(`Uploaded object must be between 1 and ${maxSizeBytes} bytes`);
    }
    if (head.Metadata?.['max-size-bytes'] !== String(maxSizeBytes)) {
      throw new BadRequestError('Uploaded object metadata does not match the issued upload constraints');
    }
    if (!head.ETag) {
      throw new Error('S3 did not return an ETag for the uploaded object');
    }

    const object = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: pendingKey, IfMatch: head.ETag }));
    if (!object.Body) {
      throw new BadRequestError('Uploaded object has no content');
    }
    const bytes = await object.Body.transformToByteArray();
    if (bytes.byteLength !== contentLength) {
      throw new BadRequestError('Uploaded object content length does not match its stored size');
    }
    const format = detectFileFormat(bytes);
    if (!format || !isPrivateDocumentContentType(format.contentType) || format.extension !== declaredExtension) {
      throw new BadRequestError('Uploaded object bytes are not a JPEG, PNG, or PDF file of the declared type');
    }

    const objectKey = `${finalKeyPrefix}${uploadId}.${format.extension}`;
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      CopySource: `${encodeURIComponent(this.bucket)}/${pendingKey.split('/').map(encodeURIComponent).join('/')}`,
      CopySourceIfMatch: head.ETag,
      ContentType: format.contentType,
      CacheControl: 'no-store',
      MetadataDirective: 'REPLACE',
      Metadata: { 'max-size-bytes': String(maxSizeBytes) },
    }));

    return {
      objectKey,
      contentType: format.contentType,
      contentLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  /**
   * A presigned GET for one object, at most five minutes, with `Cache-Control: no-store` on the
   * response. The URL is a bearer credential: never log it or store it.
   */
  async createReadUrl(objectKey: string, expiresIn = PRIVATE_DOCUMENT_READ_URL_MAX_TTL_SECONDS): Promise<PrivateReadUrl> {
    if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > PRIVATE_DOCUMENT_READ_URL_MAX_TTL_SECONDS) {
      throw new Error(`A document read URL lives between 1 and ${PRIVATE_DOCUMENT_READ_URL_MAX_TTL_SECONDS} seconds`);
    }
    if (!objectKey || objectKey.startsWith(PRIVATE_DOCUMENT_PENDING_PREFIX) || objectKey.startsWith('/')) {
      throw new Error('Only a promoted document can be read');
    }
    const url = await getSignedUrl(
      this.signingClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey, ResponseCacheControl: 'no-store' }),
      { expiresIn },
    );
    return { url, expiresIn };
  }
}

export function isPrivateDocumentContentType(value: string): value is PrivateDocumentContentType {
  return Object.prototype.hasOwnProperty.call(PRIVATE_DOCUMENT_CONTENT_TYPES, value);
}

function assertValidMaxSize(maxSizeBytes: number): void {
  if (!Number.isSafeInteger(maxSizeBytes) || maxSizeBytes <= 0) {
    throw new BadRequestError('Maximum upload size must be a positive integer');
  }
}

function assertValidKeyPrefix(keyPrefix: string): void {
  const segments = keyPrefix.split('/');
  if (
    !keyPrefix.endsWith('/') ||
    keyPrefix.startsWith('/') ||
    keyPrefix.startsWith(PRIVATE_DOCUMENT_PENDING_PREFIX) ||
    segments.slice(0, -1).some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))
  ) {
    throw new BadRequestError('Upload key prefix is invalid');
  }
}
