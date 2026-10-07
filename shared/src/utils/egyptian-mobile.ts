import { Transform } from 'class-transformer';
import { registerDecorator, ValidationOptions } from 'class-validator';

/** Egyptian mobile networks: 010 Vodafone, 011 Etisalat (e&), 012 Orange, 015 WE. */
const NATIONAL_MOBILE = /^1[0125]\d{8}$/;

/**
 * Normalizes an Egyptian mobile number to E.164 (`+201XXXXXXXXX`), or returns null when it isn't one
 * (#152). Accepts the local form `01XXXXXXXXX` and the international forms `+20`, `0020` or `20`
 * followed by the number (with or without its leading 0), with spaces, dashes, dots or parentheses.
 * Landlines, other countries and wrong lengths are rejected. The apps use the same rules and cases.
 */
export function normalizeEgyptianMobile(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const compact = input.trim().replace(/[\s\-.()]/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;

  let national: string;
  if (compact.startsWith('+20')) national = compact.slice(3);
  else if (compact.startsWith('0020')) national = compact.slice(4);
  else if (compact.startsWith('+')) return null;
  else if (compact.startsWith('20') && compact.length >= 12) national = compact.slice(2);
  else if (compact.startsWith('0')) national = compact.slice(1);
  else return null;

  if (national.startsWith('0')) national = national.slice(1);
  return NATIONAL_MOBILE.test(national) ? `+20${national}` : null;
}

export const EGYPTIAN_MOBILE_MESSAGE =
  'Enter an Egyptian mobile number, e.g. 01012345678 or +20 101 234 5678 (Vodafone 010, Etisalat 011, Orange 012, WE 015).';

/**
 * Validates an Egyptian mobile number and stores it normalized to E.164. Invalid input is kept as
 * sent, so the validation error (400) reports it instead of silently dropping it.
 */
export function EgyptianMobile(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    // A blank value means "no phone" (clears it on update); @IsOptional() then skips validation.
    Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? null : (normalizeEgyptianMobile(value) ?? value)))(
      target,
      propertyKey,
    );
    registerDecorator({
      name: 'isEgyptianMobile',
      target: target.constructor,
      propertyName: propertyKey as string,
      options: { message: EGYPTIAN_MOBILE_MESSAGE, ...options },
      validator: {
        validate: (value: unknown) => normalizeEgyptianMobile(value) === value,
      },
    });
  };
}
