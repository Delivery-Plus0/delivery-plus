const mockSend = jest.fn();
const mockCreatePresignedPost = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockSend })),
  GetObjectCommand: jest.fn((input) => ({ input })),
  CopyObjectCommand: jest.fn((input) => ({ input })),
  HeadObjectCommand: jest.fn((input) => ({ input })),
}));

jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: mockCreatePresignedPost,
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

import { createHash } from 'node:crypto';
import { BadRequestError } from '../errors/app-error';
import { PrivateDocumentStorage } from './private-document-storage';
import { detectFileFormat } from './file-signatures';

const UPLOAD_ID = '01234567-89ab-cdef-0123-456789abcdef';
const PENDING_KEY = `pending/drivers/d-1/selfie/${UPLOAD_ID}.pdf`;
const MAX = 10 * 1024 * 1024;

function pdfBytes(): Buffer {
  return Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'ascii');
}

function headFor(bytes: Buffer, maxSize = MAX) {
  return { ContentLength: bytes.byteLength, ETag: '"etag-1"', Metadata: { 'max-size-bytes': String(maxSize) } };
}

describe('PrivateDocumentStorage (#207)', () => {
  let storage: PrivateDocumentStorage;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.AWS_S3_ENDPOINT = 'http://media-storage:9000';
    process.env.AWS_S3_PUBLIC_ENDPOINT = 'http://localhost:9000';
    mockSend.mockReset();
    mockGetSignedUrl.mockReset().mockResolvedValue('https://signed.example/read');
    mockCreatePresignedPost.mockReset().mockResolvedValue({ url: 'https://signed.example/upload', fields: { key: 'k' } });
    storage = new PrivateDocumentStorage({ bucket: 'private-docs' });
  });

  it('refuses to start without a bucket', () => {
    expect(() => new PrivateDocumentStorage({ bucket: '' })).toThrow('private document bucket');
  });

  describe('createUpload', () => {
    it('issues a five-minute POST under pending/ with a fixed key, exact type and a size range', async () => {
      const upload = await storage.createUpload('drivers/d-1/selfie/', 'application/pdf', MAX);

      expect(upload.objectKey).toMatch(/^pending\/drivers\/d-1\/selfie\/[0-9a-f-]{36}\.pdf$/);
      expect(upload.expiresIn).toBe(300);
      expect(mockCreatePresignedPost).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          Bucket: 'private-docs',
          Key: upload.objectKey,
          Expires: 300,
          Conditions: [
            ['content-length-range', 1, MAX],
            ['eq', '$Content-Type', 'application/pdf'],
            ['eq', '$x-amz-meta-max-size-bytes', String(MAX)],
          ],
        }),
      );
    });

    it.each(['image/webp', 'image/gif', 'text/html', 'application/octet-stream'])('refuses %s', async (type) => {
      await expect(storage.createUpload('drivers/d-1/selfie/', type, MAX)).rejects.toThrow(BadRequestError);
      expect(mockCreatePresignedPost).not.toHaveBeenCalled();
    });

    it.each(['../x/', 'drivers/d-1/selfie', '/drivers/', 'pending/drivers/'])('refuses the key prefix %s', async (prefix) => {
      await expect(storage.createUpload(prefix, 'image/png', MAX)).rejects.toThrow(BadRequestError);
    });
  });

  describe('promote', () => {
    it('checks the bytes and copies the upload to the final key, keeping its upload id', async () => {
      const bytes = pdfBytes();
      mockSend
        .mockResolvedValueOnce(headFor(bytes))
        .mockResolvedValueOnce({ Body: { transformToByteArray: async () => bytes } })
        .mockResolvedValueOnce({});

      const result = await storage.promote(PENDING_KEY, 'drivers/d-1/selfie/', 'drivers/d-1/documents/selfie/', MAX);

      expect(result).toEqual({
        objectKey: `drivers/d-1/documents/selfie/${UPLOAD_ID}.pdf`,
        contentType: 'application/pdf',
        contentLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      expect(mockSend.mock.calls[1][0].input).toMatchObject({ Key: PENDING_KEY, IfMatch: '"etag-1"' });
      expect(mockSend.mock.calls[2][0].input).toMatchObject({
        Bucket: 'private-docs',
        Key: `drivers/d-1/documents/selfie/${UPLOAD_ID}.pdf`,
        CopySourceIfMatch: '"etag-1"',
        ContentType: 'application/pdf',
        CacheControl: 'no-store',
        MetadataDirective: 'REPLACE',
      });
    });

    it.each([
      ['another driver', `pending/drivers/d-2/selfie/${UPLOAD_ID}.pdf`],
      ['another document type', `pending/drivers/d-1/driving-licence/${UPLOAD_ID}.pdf`],
      ['an already promoted key', `drivers/d-1/documents/selfie/${UPLOAD_ID}.pdf`],
      ['a traversal', `pending/drivers/d-1/selfie/../../d-2/selfie/${UPLOAD_ID}.pdf`],
      ['a disallowed extension', `pending/drivers/d-1/selfie/${UPLOAD_ID}.html`],
    ])('refuses %s before touching storage', async (_label, key) => {
      await expect(storage.promote(key, 'drivers/d-1/selfie/', 'drivers/d-1/documents/selfie/', MAX)).rejects.toThrow(BadRequestError);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses an object over the size limit', async () => {
      mockSend.mockResolvedValueOnce({ ContentLength: MAX + 1, ETag: '"e"', Metadata: { 'max-size-bytes': String(MAX) } });
      await expect(storage.promote(PENDING_KEY, 'drivers/d-1/selfie/', 'drivers/d-1/documents/selfie/', MAX)).rejects.toThrow(BadRequestError);
    });

    it('refuses an object uploaded under different constraints', async () => {
      mockSend.mockResolvedValueOnce({ ContentLength: 10, ETag: '"e"', Metadata: { 'max-size-bytes': '99' } });
      await expect(storage.promote(PENDING_KEY, 'drivers/d-1/selfie/', 'drivers/d-1/documents/selfie/', MAX)).rejects.toThrow(BadRequestError);
    });

    it('answers 400 for an upload that never arrived', async () => {
      mockSend.mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
      await expect(storage.promote(PENDING_KEY, 'drivers/d-1/selfie/', 'drivers/d-1/documents/selfie/', MAX)).rejects.toThrow('not found');
    });

    it('refuses bytes that are not the declared format, and copies nothing', async () => {
      const html = Buffer.from('<html><script>alert(1)</script></html>');
      mockSend
        .mockResolvedValueOnce(headFor(html))
        .mockResolvedValueOnce({ Body: { transformToByteArray: async () => html } });
      await expect(storage.promote(PENDING_KEY, 'drivers/d-1/selfie/', 'drivers/d-1/documents/selfie/', MAX)).rejects.toThrow(BadRequestError);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('refuses a real PNG uploaded under a .pdf key', async () => {
      const png = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
      png.writeUInt32BE(13, 8);
      png.write('IHDR', 12);
      png.writeUInt32BE(1, 16);
      png.writeUInt32BE(1, 20);
      mockSend
        .mockResolvedValueOnce(headFor(png))
        .mockResolvedValueOnce({ Body: { transformToByteArray: async () => png } });
      await expect(storage.promote(PENDING_KEY, 'drivers/d-1/selfie/', 'drivers/d-1/documents/selfie/', MAX)).rejects.toThrow(BadRequestError);
    });
  });

  describe('createReadUrl', () => {
    it('signs a GET that lives five minutes and asks caches not to store the file', async () => {
      const result = await storage.createReadUrl('drivers/d-1/documents/selfie/x.pdf');

      expect(result).toEqual({ url: 'https://signed.example/read', expiresIn: 300 });
      const [, command, options] = mockGetSignedUrl.mock.calls[0];
      expect(command.input).toEqual({
        Bucket: 'private-docs',
        Key: 'drivers/d-1/documents/selfie/x.pdf',
        ResponseCacheControl: 'no-store',
      });
      expect(options).toEqual({ expiresIn: 300 });
    });

    it.each([0, 301, 3600])('refuses a lifetime of %i seconds', async (ttl) => {
      await expect(storage.createReadUrl('drivers/d-1/documents/selfie/x.pdf', ttl)).rejects.toThrow();
      expect(mockGetSignedUrl).not.toHaveBeenCalled();
    });

    it('never signs a read of an unconfirmed upload', async () => {
      await expect(storage.createReadUrl(PENDING_KEY)).rejects.toThrow();
    });
  });
});

describe('detectFileFormat', () => {
  it('recognises a PDF only with its header and end marker', () => {
    expect(detectFileFormat(pdfBytes())?.contentType).toBe('application/pdf');
    expect(detectFileFormat(Buffer.from('%PDF-1.7 but truncated, no end marker'))).toBeUndefined();
    expect(detectFileFormat(Buffer.from('not a pdf at all, %%EOF'))).toBeUndefined();
  });
});
