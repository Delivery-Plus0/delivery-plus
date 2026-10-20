import { AppError } from '@food-delivery/shared';
import { Redis } from 'ioredis';

/** One email, always both parts: a plain-text body for every client and an HTML one. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** What a sender may log about a send: never the recipient or the content (#203). */
export interface SendContext {
  correlationId: string;
}

/**
 * Port for sending email (#203), mirroring user-service's SmsSender (#153). Production runs with
 * `DisabledEmailSender` until EMAIL_PROVIDER names a real provider, so nothing pretends a code was sent.
 * Reusable for other mail (e.g. a future email password reset); only verification uses it today.
 */
export abstract class EmailSender {
  /** False when no provider is configured; resending a verification email then answers 503. */
  abstract readonly enabled: boolean;
  abstract send(message: EmailMessage, context: SendContext): Promise<void>;
}

/** Sending failed or isn't set up. Never carries provider details. */
export class EmailUnavailableError extends AppError {
  constructor(message = 'We could not send the email right now. Please try again later.') {
    super(503, 'EmailUnavailable', message);
  }
}

/** The default: no provider configured. */
export class DisabledEmailSender extends EmailSender {
  readonly enabled = false;

  async send(): Promise<void> {
    throw new EmailUnavailableError('Email verification is not available yet. Please try again later.');
  }
}

/** Where the test sender leaves the last email for an address, for E2E runs to read. */
export const testEmailKey = (address: string) => `test:email:${address.toLowerCase()}`;
const TEST_EMAIL_TTL_SECONDS = 15 * 60;

/**
 * Isolated test environments only (`EMAIL_PROVIDER=test`, refused in production by the config): keeps the
 * last email per address in Redis instead of sending it, so E2E suites can read the code.
 */
export class TestEmailSender extends EmailSender {
  readonly enabled = true;

  constructor(private readonly redis: Redis) {
    super();
  }

  async send(message: EmailMessage): Promise<void> {
    await this.redis.set(testEmailKey(message.to), JSON.stringify(message), 'EX', TEST_EMAIL_TTL_SECONDS);
  }
}
