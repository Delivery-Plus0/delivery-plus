import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BadRequestError } from '../errors/app-error';

const ALLOWED_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

const UPLOAD_URL_TTL_SECONDS = 300;

export interface PresignedUpload {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
  headers: Record<string, string>;
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
    const objectKey = `${keyPrefix}${randomUUID()}.${extension}`;
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      ContentType: contentType,
      Metadata: { 'max-size-bytes': String(maxSizeBytes) },
    });
    const uploadUrl = await getSignedUrl(this.signingClient, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });

    return {
      uploadUrl,
      objectKey,
      expiresIn: UPLOAD_URL_TTL_SECONDS,
      headers: {
        'Content-Type': contentType,
        'x-amz-meta-max-size-bytes': String(maxSizeBytes),
      },
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
    const fileName = objectKey.startsWith(expectedKeyPrefix)
      ? objectKey.slice(expectedKeyPrefix.length)
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

    const contentType = head.ContentType || '';
    this.assertAllowedContentType(contentType);
    const extension = ALLOWED_CONTENT_TYPES[contentType as keyof typeof ALLOWED_CONTENT_TYPES];
    if (!fileName.endsWith(`.${extension}`)) {
      throw new BadRequestError('Uploaded object extension does not match its content type');
    }

    const contentLength = head.ContentLength;
    if (typeof contentLength !== 'number' || !Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > maxSizeBytes) {
      throw new BadRequestError(`Uploaded object must be between 1 and ${maxSizeBytes} bytes`);
    }
    if (head.Metadata?.['max-size-bytes'] !== String(maxSizeBytes)) {
      throw new BadRequestError('Uploaded object metadata does not match the issued upload constraints');
    }

    return {
      publicUrl: this.getPublicUrl(objectKey),
      contentType,
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