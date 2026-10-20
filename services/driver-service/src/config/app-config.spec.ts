import { loadVerificationConfig } from './app-config';

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
