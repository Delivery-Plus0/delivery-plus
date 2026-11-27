import { maskEmail, maskPhone } from './pii-mask';

describe('PII masking (#317)', () => {
  it('masks an Egyptian mobile to the country code, operator prefix and last three digits', () => {
    expect(maskPhone('+201012345123')).toBe('+20 10•• ••• 123');
    expect(maskPhone('+201512345678')).toBe('+20 15•• ••• 678');
  });

  it('masks other numbers to their last three digits, and nothing to null', () => {
    expect(maskPhone('+4915112345678')).toBe('••••••••••678');
    expect(maskPhone('12')).toBe('•••');
    expect(maskPhone(null)).toBeNull();
  });

  it('masks an email to its first character and domain', () => {
    expect(maskEmail('mona.ali@example.com')).toBe('m•••@example.com');
    expect(maskEmail('a@b.co')).toBe('a•••@b.co');
    expect(maskEmail('not-an-email')).toBe('•••');
    expect(maskEmail(undefined)).toBeNull();
  });

  it('never leaks more than the last three digits', () => {
    const masked = maskPhone('+201098765432') as string;
    expect(masked.replace(/\D/g, '')).toBe('2010432');
  });
});
