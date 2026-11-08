import { LOCAL_NATIONAL_ID_HMAC_SECRET, loadDocumentConfig, loadLicenceExpiryInterval, loadVerificationConfig } from './app-config';

describe('loadVerificationConfig (#206)', () => {
  it('leaves new drivers PENDING by default', () => {
    expect(loadVerificationConfig('development', {})).toEqual({ autoVerifyDrivers: false });
    expect(loadVerificationConfig('production', {})).toEqual({ autoVerifyDrivers: false });
  });

  it('turns auto-verification on only for the exact value "true"', () => {
    expect(loadVerificationConfig('test', { DRIVER_AUTO_VERIFY: 'true' })).toEqual({ autoVerifyDrivers: true });
    for (const value of ['1', 'yes', 'TRUE ', 'false', '']) {
      expect(loadVerificationConfig('test', { DRIVER_AUTO_VERIFY: value }).autoVerifyDrivers).toBe(value.trim() === 'true');
    }
  });

  it('refuses to start in production with auto-verification on', () => {
    expect(() => loadVerificationConfig('production', { DRIVER_AUTO_VERIFY: 'true' })).toThrow(
      'DRIVER_AUTO_VERIFY=true is for isolated test environments and cannot run in production',
    );
  });
});

describe('loadDocumentConfig (#207)', () => {
  const SECRET = 'x'.repeat(40);

  it('uses local defaults only in development and test', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(loadDocumentConfig(nodeEnv, {})).toEqual({
        documentsBucket: 'delivery-plus-private',
        nationalIdHmacSecret: LOCAL_NATIONAL_ID_HMAC_SECRET,
      });
    }
  });

  it('refuses to start in production without the private bucket', () => {
    expect(() => loadDocumentConfig('production', { NATIONAL_ID_HMAC_SECRET: SECRET })).toThrow('DRIVER_DOCUMENTS_BUCKET');
  });

  it('has no national ID secret default outside development and test', () => {
    for (const nodeEnv of ['production', 'staging']) {
      expect(() => loadDocumentConfig(nodeEnv, { DRIVER_DOCUMENTS_BUCKET: 'private-docs' })).toThrow('NATIONAL_ID_HMAC_SECRET');
    }
  });

  it('refuses a weak, default or reused national ID secret in production', () => {
    const base = { DRIVER_DOCUMENTS_BUCKET: 'private-docs', JWT_SECRET: 'j'.repeat(40), SYSTEM_JWT_SECRET: 's'.repeat(40) };
    expect(() => loadDocumentConfig('production', { ...base, NATIONAL_ID_HMAC_SECRET: LOCAL_NATIONAL_ID_HMAC_SECRET })).toThrow('default');
    expect(() => loadDocumentConfig('production', { ...base, NATIONAL_ID_HMAC_SECRET: 'short' })).toThrow('at least 32');
    expect(() => loadDocumentConfig('production', { ...base, NATIONAL_ID_HMAC_SECRET: base.JWT_SECRET })).toThrow('differ');
    expect(loadDocumentConfig('production', { ...base, NATIONAL_ID_HMAC_SECRET: SECRET })).toEqual({
      documentsBucket: 'private-docs',
      nationalIdHmacSecret: SECRET,
    });
  });

  it('never uses the public media bucket for documents', () => {
    expect(() => loadDocumentConfig('test', { DRIVER_DOCUMENTS_BUCKET: 'media', AWS_S3_BUCKET: 'media' })).toThrow('public media bucket');
    expect(() => loadDocumentConfig('test', { DRIVER_DOCUMENTS_BUCKET: 'Not A Bucket' })).toThrow('valid bucket');
  });
});

describe('loadLicenceExpiryInterval (#207)', () => {
  it('runs hourly by default and can be turned off with 0', () => {
    expect(loadLicenceExpiryInterval({})).toBe(3_600_000);
    expect(loadLicenceExpiryInterval({ DRIVER_LICENCE_EXPIRY_CHECK_MS: '0' })).toBe(0);
    expect(loadLicenceExpiryInterval({ DRIVER_LICENCE_EXPIRY_CHECK_MS: '600000' })).toBe(600_000);
  });

  it.each(['abc', '-1', '1.5', '1000'])('refuses %s', (value) => {
    expect(() => loadLicenceExpiryInterval({ DRIVER_LICENCE_EXPIRY_CHECK_MS: value })).toThrow(/DRIVER_LICENCE_EXPIRY_CHECK_MS/);
  });
});
