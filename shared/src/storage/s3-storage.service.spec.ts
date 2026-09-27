const mockSend = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn((input) => ({ input })),
  HeadObjectCommand: jest.fn((input) => ({ input })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

import { BadRequestError } from '../errors/app-error';
import { S3StorageService } from './s3-storage.service';

describe('S3StorageService', () => {
  let service: S3StorageService;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.AWS_S3_BUCKET = 'test-media';
    process.env.AWS_S3_ENDPOINT = 'http://minio:9000';
    process.env.AWS_S3_PUBLIC_ENDPOINT = 'http://localhost:9000';
    process.env.AWS_PUBLIC_BASE_URL = 'http://localhost:9000/test-media';
    process.env.AWS_ACCESS_KEY_ID = 'minioadmin';
    process.env.AWS_SECRET_ACCESS_KEY = 'minioadmin';
    mockSend.mockReset();
    mockGetSignedUrl.mockReset().mockResolvedValue('https://signed.example/upload');
    service = new S3StorageService();
  });

  it('generates a short-lived upload URL with signed type and size metadata', async () => {
    const result = await service.generateUploadUrl('users/user-1/avatar/', 'image/png', 1024);

    expect(result.uploadUrl).toBe('https://signed.example/upload');
    expect(result.objectKey).toMatch(/^users\/user-1\/avatar\/[0-9a-f-]+\.png$/);
    expect(result.expiresIn).toBe(300);
    expect(result.headers).toEqual({
      'Content-Type': 'image/png',
      'x-amz-meta-max-size-bytes': '1024',
    });
    expect(mockGetSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        input: expect.objectContaining({
          ContentType: 'image/png',
          Metadata: { 'max-size-bytes': '1024' },
        }),
      }),
      { expiresIn: 300 },
    );
  });

  it('rejects unsupported upload content types', async () => {
    await expect(service.generateUploadUrl('users/user-1/avatar/', 'image/gif', 1024)).rejects.toThrow(
      BadRequestError,
    );
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('confirms object metadata and returns its public URL', async () => {
    mockSend.mockResolvedValue({
      ContentLength: 512,
      ContentType: 'image/webp',
      Metadata: { 'max-size-bytes': '1024' },
    });

    const result = await service.verifyUploadedObject(
      'users/user-1/avatar/01234567-89ab-cdef-0123-456789abcdef.webp',
      'users/user-1/avatar/',
      1024,
    );

    expect(result).toEqual({
      publicUrl: 'http://localhost:9000/test-media/users/user-1/avatar/01234567-89ab-cdef-0123-456789abcdef.webp',
      contentType: 'image/webp',
      contentLength: 512,
    });
  });

  it('rejects keys outside the expected prefix before querying S3', async () => {
    await expect(
      service.verifyUploadedObject(
        'restaurants/other/logo/01234567-89ab-cdef-0123-456789abcdef.png',
        'restaurants/restaurant-1/logo/',
        1024,
      ),
    ).rejects.toThrow(BadRequestError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects uploaded objects that exceed the configured size', async () => {
    mockSend.mockResolvedValue({
      ContentLength: 1025,
      ContentType: 'image/png',
      Metadata: { 'max-size-bytes': '1024' },
    });

    await expect(
      service.verifyUploadedObject(
        'users/user-1/avatar/01234567-89ab-cdef-0123-456789abcdef.png',
        'users/user-1/avatar/',
        1024,
      ),
    ).rejects.toThrow(BadRequestError);
  });

  it('does not prevent service startup when production media storage is not configured', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.AWS_S3_BUCKET;
    service = new S3StorageService();

    await expect(service.generateUploadUrl('users/user-1/avatar/', 'image/png', 1024)).rejects.toThrow(
      'AWS_S3_BUCKET is required to use media storage',
    );
  });
});