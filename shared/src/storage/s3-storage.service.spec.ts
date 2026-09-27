import { createHash } from 'node:crypto';

const mockSend = jest.fn();
const mockCreatePresignedPost = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockSend })),
  GetObjectCommand: jest.fn((input) => ({ input })),
  CopyObjectCommand: jest.fn((input) => ({ input })),
  HeadObjectCommand: jest.fn((input) => ({ input })),
}));

jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: mockCreatePresignedPost,
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
    mockCreatePresignedPost.mockReset().mockResolvedValue({
      url: 'https://signed.example/upload',
      fields: {
        key: 'pending/users/user-1/avatar/01234567-89ab-cdef-0123-456789abcdef.png',
        'Content-Type': 'image/png',
        'x-amz-meta-max-size-bytes': '1024',
      },
    });
    service = new S3StorageService();
  });

  it('generates a short-lived POST policy with a size range and constrained fields', async () => {
    const result = await service.generateUploadUrl('users/user-1/avatar/', 'image/png', 1024);

    expect(result.uploadUrl).toBe('https://signed.example/upload');
    expect(result.objectKey).toMatch(/^pending\/users\/user-1\/avatar\/[0-9a-f-]+\.png$/);
    expect(result.expiresIn).toBe(300);
    expect(result.method).toBe('POST');
    expect(result.fields).toMatchObject({
      'Content-Type': 'image/png',
      'x-amz-meta-max-size-bytes': '1024',
    });
    expect(mockCreatePresignedPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        Bucket: 'test-media',
        Key: result.objectKey,
        Expires: 300,
        Fields: {
          'Content-Type': 'image/png',
          'x-amz-meta-max-size-bytes': '1024',
        },
        Conditions: [
          ['content-length-range', 1, 1024],
          ['eq', '$Content-Type', 'image/png'],
          ['eq', '$x-amz-meta-max-size-bytes', '1024'],
        ],
      }),
    );
  });

  it('rejects unsupported upload content types', async () => {
    await expect(service.generateUploadUrl('users/user-1/avatar/', 'image/gif', 1024)).rejects.toThrow(
      BadRequestError,
    );
    expect(mockCreatePresignedPost).not.toHaveBeenCalled();
  });

  it('validates uploaded bytes and copies them to a separate verified key', async () => {
    const pngBytes = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngBytes);
    pngBytes.writeUInt32BE(13, 8);
    pngBytes.write('IHDR', 12);
    pngBytes.writeUInt32BE(1, 16);
    pngBytes.writeUInt32BE(1, 20);
    mockSend
      .mockResolvedValueOnce({
        ContentLength: pngBytes.byteLength,
        ETag: '"verified-etag"',
        Metadata: { 'max-size-bytes': '1024' },
      })
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => pngBytes } })
      .mockResolvedValueOnce({});

    const result = await service.verifyUploadedObject(
      'pending/users/user-1/avatar/01234567-89ab-cdef-0123-456789abcdef.png',
      'users/user-1/avatar/',
      1024,
    );

    expect(result.contentType).toBe('image/png');
    expect(result.contentLength).toBe(pngBytes.byteLength);
    const contentHash = createHash('sha256').update(pngBytes).digest('hex');
    expect(result.publicUrl).toBe(
      `http://localhost:9000/test-media/users/user-1/avatar/${contentHash}.png`,
    );
    expect(mockSend.mock.calls[1][0].input).toMatchObject({
      Bucket: 'test-media',
      Key: 'pending/users/user-1/avatar/01234567-89ab-cdef-0123-456789abcdef.png',
      IfMatch: '"verified-etag"',
    });
    expect(mockSend.mock.calls[2][0].input).toMatchObject({
      Bucket: 'test-media',
      CopySourceIfMatch: '"verified-etag"',
      ContentType: 'image/png',
      MetadataDirective: 'REPLACE',
    });
    expect(mockSend.mock.calls[2][0].input.Key).toBe(
      `users/user-1/avatar/${contentHash}.png`,
    );
  });

  it('rejects keys outside the expected prefix before querying S3', async () => {
    await expect(
      service.verifyUploadedObject(
        'pending/restaurants/other/logo/01234567-89ab-cdef-0123-456789abcdef.png',
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
        'pending/users/user-1/avatar/01234567-89ab-cdef-0123-456789abcdef.png',
        'users/user-1/avatar/',
        1024,
      ),
    ).rejects.toThrow(BadRequestError);
  });

  it('rejects bytes that are not an image before copying them to a public key', async () => {
    const notAnImage = Buffer.from('<html>not an image</html>');
    mockSend
      .mockResolvedValueOnce({
        ContentLength: notAnImage.byteLength,
        ETag: '"untrusted-etag"',
        Metadata: { 'max-size-bytes': '1024' },
      })
      .mockResolvedValueOnce({ Body: { transformToByteArray: async () => notAnImage } });

    await expect(
      service.verifyUploadedObject(
        'pending/users/user-1/avatar/01234567-89ab-cdef-0123-456789abcdef.png',
        'users/user-1/avatar/',
        1024,
      ),
    ).rejects.toThrow(BadRequestError);
    expect(mockSend).toHaveBeenCalledTimes(2);
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