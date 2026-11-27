/**
 * #317 (owner decision on admin#3): staff see personal data masked by default; revealing a value is
 * its own audited call. These helpers are the one masking format for every staff view.
 */
const DOT = '•';

/** `+201012345678` → `+20 10•• ••• 678`: the country code, the operator prefix and the last three digits. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (phone.startsWith('+20') && digits.length === 12) {
    return `+20 ${digits.slice(2, 4)}${DOT.repeat(2)} ${DOT.repeat(3)} ${digits.slice(-3)}`;
  }
  return digits.length > 3 ? `${DOT.repeat(Math.max(digits.length - 3, 3))}${digits.slice(-3)}` : DOT.repeat(3);
}

/** `mona.ali@example.com` → `m•••@example.com`: the first character and the domain. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0) return DOT.repeat(3);
  return `${email[0]}${DOT.repeat(3)}${email.slice(at)}`;
}

/** The personal fields a staff member can reveal one at a time (#317). */
export const REVEALABLE_FIELDS = ['phone', 'email', 'address'] as const;
export type RevealableField = (typeof REVEALABLE_FIELDS)[number];
