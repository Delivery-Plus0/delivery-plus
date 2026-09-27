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

const ALLOWED_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

const UPLOAD_URL_TTL_SECONDS = 300;
const PENDING_UPLOAD_PREFIX = 'pending/';

function detectImageFormat(bytes: Uint8Array): { contentType: string; extension: string } | undefined {
  const buffer = Buffer.from(bytes);
  if (
    buffer.length >= 33 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString('ascii') === 'PNG' &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a &&
    buffer.readUInt32BE(8) === 13 &&
    buffer.subarray(12, 16).toString('ascii') === 'IHDR' &&
    buffer.readUInt32BE(16) > 0 &&
    buffer.readUInt32BE(20) > 0
  ) {
    return { contentType: 'image/png', extension: 'png' };
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff &&
    buffer[buffer.length - 2] === 0xff &&
    buffer[buffer.length - 1] === 0xd9
  ) {
    return { contentType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    buffer.length >= 20 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP' &&
    buffer.readUInt32LE(4) + 8 <= buffer.length &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.subarray(12, 16).toString('ascii')) &&
    buffer.readUInt32LE(16) + 20 <= buffer.length
  ) {
    return { contentType: 'image/webp', extension: 'webp' };
  }
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
    this.region = process.env.AWS_REGION || 'us-east-1';

    const endpoint = process.env.AWS_S3_ENDPOINT || (isProduction ? undefined : 'http://localhost:9000');
    const publicEndpoint = process.env.AWS_S3_PUBLIC_ENDPOINT || endpoint;
    const forcePathStyle = process.env.AWS_S3_FORCE_PATH_STYLE === undefined
      ? Boolean(endpoint)
      : process.env.AWS_S3_FORCE_PATH_STYLE === 'true';
    const credentials = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : isProduction
        ? undefined
        : { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' };

    const clientConfig = {
      region: this.region,
      endpoint,
      forcePathStyle,
      ...(credentials ? { credentials } : {}),
    };

    this.client = new S3Client(clientConfig);
    this.signingClient = publicEndpoint && publicEndpoint !== endpoint
      ? new S3Client({ ...clientConfig, endpoint: publicEndpoint })
      : this.client;
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