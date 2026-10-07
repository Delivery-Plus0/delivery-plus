import { AppError } from '@food-delivery/shared';
import { Redis } from 'ioredis';

/**
 * Port for sending text messages (#153). No real provider is wired in yet: production runs with
 * `DisabledSmsSender` until a provider and its credentials exist, so nothing pretends a code was sent.
 */
export abstract class SmsSender {
  /** False when no provider is configured; phone verification then refuses to start. */
  abstract readonly enabled: boolean;
  abstract send(to: string, text: string): Promise<void>;
}

export class SmsUnavailableError extends AppError {
  constructor(message = 'Phone verification is not available yet. Please try again later.') {
    super(503, 'ServiceUnavailable', message);
  }
}

/** The default: no provider configured. */
export class DisabledSmsSender extends SmsSender {
  readonly enabled = false;

  async send(): Promise<void> {
    throw new SmsUnavailableError();
  }
}

/** Where the test sender leaves the last message for a number, for E2E runs to read. */
export const testSmsKey = (phone: string) => `test:sms:${phone}`;
const TEST_SMS_TTL_SECONDS = 15 * 60;

/**
 * Isolated test environments only (`SMS_PROVIDER=test`, refused in production by the config): keeps the
 * last message per number in Redis instead of sending it, so E2E suites can read the code.
 */
export class TestSmsSender extends SmsSender {
  readonly enabled = true;

  constructor(private readonly redis: Redis) {
    super();
  }

  async send(to: string, text: string): Promise<void> {
    await this.redis.set(testSmsKey(to), text, 'EX', TEST_SMS_TTL_SECONDS);
  }
}
