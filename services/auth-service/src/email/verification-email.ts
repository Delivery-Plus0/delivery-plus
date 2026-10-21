import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { EmailMessage } from './email-sender';

export type EmailLocale = 'ar' | 'en';

/** Arabic unless the client asks for English, matching the apps' default language. */
export function localeFrom(acceptLanguage: string | undefined): EmailLocale {
  return acceptLanguage?.trim().toLowerCase().startsWith('en') ? 'en' : 'ar';
}

/** A 6-digit code, uniformly random, leading zeros kept. */
export function newVerificationCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/**
 * The stored form of a code (#203): an HMAC with a server secret, bound to the account, so a leaked
 * database row can't be turned back into a code by trying all one million of them.
 */
export function hashVerificationCode(code: string, credentialId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${credentialId}:${code}`).digest('hex');
}

export function verificationCodeMatches(code: string, credentialId: string, secret: string, storedHash: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const presented = Buffer.from(hashVerificationCode(code, credentialId, secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  return presented.length === stored.length && timingSafeEqual(presented, stored);
}

const COPY = {
  en: {
    subject: 'Your Delivery Plus verification code',
    intro: 'Use this code to verify your email address in Delivery Plus:',
    expiry: (minutes: number) => `The code expires in ${minutes} minutes and works once.`,
    ignore: "If you didn't create a Delivery Plus account, you can ignore this email.",
  },
  ar: {
    subject: 'رمز التحقق من Delivery Plus',
    intro: 'استخدم هذا الرمز لتأكيد بريدك الإلكتروني في Delivery Plus:',
    expiry: (minutes: number) => `ينتهي الرمز خلال ${minutes} دقائق ويُستخدم مرة واحدة.`,
    ignore: 'إذا لم تنشئ حسابًا في Delivery Plus، يمكنك تجاهل هذه الرسالة.',
  },
} as const;

/** The verification email (#203): plain text and HTML, in Arabic (right to left) or English. */
export function buildVerificationEmail(to: string, code: string, locale: EmailLocale, ttlMinutes: number): EmailMessage {
  const copy = COPY[locale];
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const text = [copy.intro, '', code, '', copy.expiry(ttlMinutes), copy.ignore].join('\n');
  const html = `<!doctype html>
<html lang="${locale}" dir="${dir}">
  <body style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; margin: 0; padding: 24px;">
    <p style="margin: 0 0 16px;">${copy.intro}</p>
    <p style="font-size: 32px; font-weight: bold; letter-spacing: 6px; margin: 0 0 16px;" dir="ltr">${code}</p>
    <p style="margin: 0 0 8px;">${copy.expiry(ttlMinutes)}</p>
    <p style="margin: 0; color: #6b7280;">${copy.ignore}</p>
  </body>
</html>`;
  return { to, subject: copy.subject, text, html };
}
