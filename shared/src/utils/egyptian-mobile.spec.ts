import { plainToInstance } from 'class-transformer';
import { IsOptional, validate } from 'class-validator';
import { EgyptianMobile, normalizeEgyptianMobile } from './egyptian-mobile';

/**
 * The shared case table (#152). The customer, driver and restaurant apps copy this table into their
 * own phone tests, so frontend and backend agree on every input.
 */
export const EGYPTIAN_MOBILE_CASES: [input: string, expected: string | null][] = [
  // Accepted forms of the same number, all stored identically.
  ['01092784342', '+201092784342'],
  ['+20 1092784342', '+201092784342'],
  ['+201092784342', '+201092784342'],
  ['0020-109-278-4342', '+201092784342'],
  ['201092784342', '+201092784342'],
  ['+20 01092784342', '+201092784342'],
  [' 010 9278 4342 ', '+201092784342'],
  ['(010) 9278-4342', '+201092784342'],
  // Every mobile network prefix.
  ['01112345678', '+201112345678'],
  ['01212345678', '+201212345678'],
  ['01512345678', '+201512345678'],
  // Rejected.
  ['0192784342', null], // no such network (019), and too short
  ['01912345678', null], // 019 is not a mobile network
  ['01312345678', null], // 013 is not a mobile network
  ['0101', null], // too short
  ['010927843421', null], // too long
  ['0223456789', null], // Cairo landline
  ['+1 555 010 2030', null], // another country
  ['+44 7700 900123', null],
  ['1092784342', null], // no country code and no leading 0
  ['01O92784342', null], // letter O instead of zero
  ['', null],
];

describe('normalizeEgyptianMobile', () => {
  it.each(EGYPTIAN_MOBILE_CASES)('%j → %j', (input, expected) => {
    expect(normalizeEgyptianMobile(input)).toBe(expected);
  });

  it('rejects non-strings', () => {
    expect(normalizeEgyptianMobile(1092784342)).toBeNull();
    expect(normalizeEgyptianMobile(null)).toBeNull();
  });
});

class Profile {
  @IsOptional()
  @EgyptianMobile()
  phone?: string;
}

describe('@EgyptianMobile()', () => {
  it('stores valid numbers normalized', async () => {
    const dto = plainToInstance(Profile, { phone: '0020-109-278-4342' });
    expect(await validate(dto)).toEqual([]);
    expect(dto.phone).toBe('+201092784342');
  });

  it('rejects invalid numbers with a clear message, keeping what was sent', async () => {
    const dto = plainToInstance(Profile, { phone: '0223456789' });
    const errors = await validate(dto);
    expect(errors.map((error) => error.property)).toEqual(['phone']);
    expect(Object.values(errors[0].constraints ?? {})[0]).toContain('Egyptian mobile number');
    expect(dto.phone).toBe('0223456789');
  });

  it('leaves the field optional', async () => {
    expect(await validate(plainToInstance(Profile, {}))).toEqual([]);
  });
});
