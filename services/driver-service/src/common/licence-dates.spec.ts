import { addDays, cairoDate, expiringLicences } from './licence-dates';

describe('licence dates (#207)', () => {
  it('adds calendar days across months, years and leap days', () => {
    expect(addDays('2026-11-08', 14)).toBe('2026-11-22');
    expect(addDays('2026-12-25', 14)).toBe('2027-01-08');
    expect(addDays('2028-02-20', 14)).toBe('2028-03-05');
    expect(addDays('2027-02-20', 14)).toBe('2027-03-06');
  });

  it('gives the date in Cairo', () => {
    expect(cairoDate(new Date('2026-11-07T21:59:00Z'))).toBe('2026-11-07');
    expect(cairoDate(new Date('2026-11-07T22:00:00Z'))).toBe('2026-11-08');
  });

  it('flags licences valid today that expire within 14 days, soonest first', () => {
    expect(expiringLicences({ drivingLicenceExpiresOn: '2026-11-22', vehicleLicenceExpiresOn: '2026-11-08' }, '2026-11-08')).toEqual([
      { field: 'vehicleLicenceExpiresOn', expiresOn: '2026-11-08' },
      { field: 'drivingLicenceExpiresOn', expiresOn: '2026-11-22' },
    ]);
  });

  it('flags neither a licence further out, an expired one nor a missing date', () => {
    expect(expiringLicences({ drivingLicenceExpiresOn: '2026-11-23', vehicleLicenceExpiresOn: null }, '2026-11-08')).toEqual([]);
    expect(expiringLicences({ drivingLicenceExpiresOn: '2026-11-07', vehicleLicenceExpiresOn: null }, '2026-11-08')).toEqual([]);
  });
});
