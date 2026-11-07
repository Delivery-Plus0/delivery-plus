/**
 * Detects a file's real format from its bytes ("magic bytes"), never from the name or the declared
 * content type a client sent. Shared by the public media uploads (images) and the private driver
 * documents (#207, images and PDF).
 */
export interface DetectedFileFormat {
  contentType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  extension: 'jpg' | 'png' | 'webp' | 'pdf';
}

/** How far from the end a PDF's `%%EOF` marker may sit (writers append whitespace or a few bytes). */
const PDF_EOF_SEARCH_BYTES = 1024;

export function detectFileFormat(bytes: Uint8Array): DetectedFileFormat | undefined {
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
  if (
    buffer.length >= 16 &&
    buffer.subarray(0, 5).toString('ascii') === '%PDF-' &&
    buffer.subarray(Math.max(0, buffer.length - PDF_EOF_SEARCH_BYTES)).includes('%%EOF')
  ) {
    return { contentType: 'application/pdf', extension: 'pdf' };
  }
  return undefined;
}
