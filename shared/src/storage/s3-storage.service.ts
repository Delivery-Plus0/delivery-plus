import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { BadRequestError } from '../errors/app-error';
import { DetectedFileFormat, detectFileFormat } from './file-signatures';
import { createS3Clients } from './s3-clients';

const ALLOWED_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

const UPLOAD_URL_TTL_SECONDS = 300;
const PENDING_UPLOAD_PREFIX = 'pending/';

/** Only the image formats are accepted here: this bucket is public (menu, logo, avatar images). */
function detectImageFormat(bytes: Uint8Array): DetectedFileFormat | undefined {
  const format = detectFileFormat(bytes);
  return format && format.contentType !== 'application/pdf' ? format : undefined;
}

export interface PresignedUpload {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
  method: 'POST';
  fields: Record<string, string>;
}

export interface VerifiedUpload {
  publicUrl: string;
  contentType: string;
  contentLength: number;
}

@Injectable()
export class S3StorageService {
  private readonly client: S3Client;
  private readonly signingClient: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor() {
    const isProduction = process.env.NODE_ENV === 'production';
    this.bucket = process.env.AWS_S3_BUCKET || (isProduction ? '' : 'delivery-plus-media');
    const clients = createS3Clients();
    this.region = clients.region;
    this.client = clients.client;
    this.signingClient = clients.signingClient;
  }

  async generateUploadUrl(keyPrefix: string, contentType: string, maxSizeBytes: number): Promise<PresignedUpload> {
    this.assertConfigured();
    this.assertValidKeyPrefix(keyPrefix);
    this.assertAllowedContentType(contentType);
    this.assertValidMaxSize(maxSizeBytes);

    const extension = ALLOWED_CONTENT_TYPES[contentType as keyof typeof ALLOWED_CONTENT_TYPES];
    const objectKey = `${PENDING_UPLOAD_PREFIX}${keyPrefix}${randomUUID()}.${extension}`;
    const fields = {
      'Content-Type': contentType,
      'x-amz-meta-max-size-bytes': String(maxSizeBytes),
    };
    const post = await createPresignedPost(this.signingClient, {
      Bucket: this.bucket,
      Key: objectKey,
      Expires: UPLOAD_URL_TTL_SECONDS,
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
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      method: 'POST',
      fields: post.fields,
    };
  }

  async verifyUploadedObject(
    objectKey: string,
    expectedKeyPrefix: string,
    maxSizeBytes: number,
  ): Promise<VerifiedUpload> {
    this.assertConfigured();
    this.assertValidKeyPrefix(expectedKeyPrefix);
    this.assertValidMaxSize(maxSizeBytes);
    const pendingKeyPrefix = `${PENDING_UPLOAD_PREFIX}${expectedKeyPrefix}`;
    const fileName = objectKey.startsWith(pendingKeyPrefix)
      ? objectKey.slice(pendingKeyPrefix.length)
      : '';
    if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/i.test(fileName)) {
      throw new BadRequestError('Uploaded object key is outside the authorized resource prefix');
    }

    let head;
    try {
      head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }));
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

    const object = await this.client.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      IfMatch: head.ETag,
    }));
    if (!object.Body) {
      throw new BadRequestError('Uploaded object has no content');
    }
    const bytes = await object.Body.transformToByteArray();
    if (bytes.byteLength !== contentLength || bytes.byteLength > maxSizeBytes) {
      throw new BadRequestError('Uploaded object content length does not match its stored size');
    }
    const detectedFormat = detectImageFormat(bytes);
    if (!detectedFormat || !fileName.endsWith(`.${detectedFormat.extension}`)) {
      throw new BadRequestError('Uploaded object bytes do not match an allowed image format');
    }

    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const verifiedObjectKey = `${expectedKeyPrefix}${contentHash}.${detectedFormat.extension}`;
    const copySource = `${encodeURIComponent(this.bucket)}/${objectKey
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    await this.client.send(new CopyObjectCommand({
      Bucket: this.bucket,
      Key: verifiedObjectKey,
      CopySource: copySource,
      CopySourceIfMatch: head.ETag,
      ContentType: detectedFormat.contentType,
      MetadataDirective: 'REPLACE',
      Metadata: { 'max-size-bytes': String(maxSizeBytes) },
    }));

    return {
      publicUrl: this.getPublicUrl(verifiedObjectKey),
      contentType: detectedFormat.contentType,
      contentLength,
    };
  }

  getPublicUrl(objectKey: string): string {
    this.assertConfigured();
    const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
    const configuredBaseUrl = process.env.AWS_PUBLIC_BASE_URL;
    if (configuredBaseUrl) {
      return `${configuredBaseUrl.replace(/\/+$/, '')}/${encodedKey}`;
    }

    const endpoint = process.env.AWS_S3_PUBLIC_ENDPOINT || process.env.AWS_S3_ENDPOINT;
    if (endpoint) {
      return `${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(this.bucket)}/${encodedKey}`;
    }

    const host = this.region === 'us-east-1'
      ? `${this.bucket}.s3.amazonaws.com`
      : `${this.bucket}.s3.${this.region}.amazonaws.com`;
    return `https://${host}/${encodedKey}`;
  }

  private assertAllowedContentType(contentType: string): void {
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_CONTENT_TYPES, contentType)) {
      throw new BadRequestError('Only image/jpeg, image/png, and image/webp uploads are allowed');
    }
  }

  private assertConfigured(): void {
    if (!this.bucket) {
      throw new Error('AWS_S3_BUCKET is required to use media storage');
    }
  }

  private assertValidMaxSize(maxSizeBytes: number): void {
    if (!Number.isSafeInteger(maxSizeBytes) || maxSizeBytes <= 0) {
      throw new BadRequestError('Maximum upload size must be a positive integer');
    }
  }

  private assertValidKeyPrefix(keyPrefix: string): void {
    const segments = keyPrefix.split('/');
    if (
      !keyPrefix.endsWith('/') ||
      keyPrefix.startsWith('/') ||
      segments.slice(0, -1).some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))
    ) {
      throw new BadRequestError('Upload key prefix is invalid');
    }
  }
}