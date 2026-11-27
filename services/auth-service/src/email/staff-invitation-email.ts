import { createHash, randomBytes } from 'node:crypto';
import { EmailLocale } from './verification-email';
import { EmailMessage } from './email-sender';

/** A single-use invitation token: 32 random bytes, URL-safe. Only its SHA-256 is stored. */
export function newInvitationToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const COPY = {
  en: {
    subject: "You're invited to the Delivery Plus staff console",
    intro: 'You were invited to join the Delivery Plus staff console. Open this link to set your password:',
    expiry: (hours: number) => `The link works once and expires in ${hours} hours.`,
    ignore: "If you weren't expecting this, you can ignore this email.",
  },
  ar: {
    subject: 'دعوة للانضمام إلى لوحة موظفي Delivery Plus',
    intro: 'تمت دعوتك للانضمام إلى لوحة موظفي Delivery Plus. افتح هذا الرابط لتعيين كلمة المرور:',
    expiry: (hours: number) => `الرابط يُستخدم مرة واحدة وينتهي خلال ${hours} ساعة.`,
    ignore: 'إذا لم تكن تنتظر هذه الدعوة، يمكنك تجاهل هذه الرسالة.',
  },
} as const;

/** #216: the invitation email, plain text and HTML, in Arabic (right to left) or English. */
export function buildStaffInvitationEmail(to: string, link: string, locale: EmailLocale, ttlHours: number): EmailMessage {
  const copy = COPY[locale];
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const text = [copy.intro, '', link, '', copy.expiry(ttlHours), copy.ignore].join('\n');
  const html = `<!doctype html>
<html lang="${locale}" dir="${dir}">
  <body style="font-family: Arial, Helvetica, sans-serif; color: #1f2937; margin: 0; padding: 24px;">
    <p style="margin: 0 0 16px;">${copy.intro}</p>
    <p style="margin: 0 0 16px;" dir="ltr"><a href="${link}">${link}</a></p>
    <p style="margin: 0 0 8px;">${copy.expiry(ttlHours)}</p>
    <p style="margin: 0; color: #6b7280;">${copy.ignore}</p>
  </body>
</html>`;
  return { to, subject: copy.subject, text, html };
}
