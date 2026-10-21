import { Logger } from '@nestjs/common';
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { EmailMessage, EmailSender, EmailUnavailableError, SendContext } from './email-sender';

export interface SesSettings {
  region: string;
  fromAddress: string;
  configurationSet?: string;
  /** Per attempt: a send that takes longer is abandoned. */
  timeoutMs: number;
}

/** The slice of SESv2Client this sender uses, so tests can pass a mock. */
export type SesClient = Pick<SESv2Client, 'send'>;

type Failure = 'retryable' | 'permanent' | 'timeout';

const RETRY_DELAY_MS = 250;
const THROTTLING = new Set(['TooManyRequestsException', 'ThrottlingException', 'Throttling']);

/**
 * Amazon SES (SESv2 SendEmail) behind EMAIL_PROVIDER=ses (#203).
 *
 * - Credentials come only from the AWS provider chain (instance/task role, or the standard AWS_*
 *   environment): nothing is configured here and no key is in the repository.
 * - Each attempt has a timeout. The SDK's own retries are off; this sender retries **once**, only when
 *   SES throttles or answers 5xx. A 4xx (bad address, unverified sender, sandbox) is final. A timeout is
 *   final too: SES may have accepted the message, and a retry could deliver a second code.
 * - Every failure becomes 503 EmailUnavailable with no provider details. Logs carry the correlation id
 *   and SES's error name and status, never the recipient or the content.
 */
export class SesEmailSender extends EmailSender {
  readonly enabled = true;
  private readonly logger = new Logger(SesEmailSender.name);

  constructor(
    private readonly settings: SesSettings,
    private readonly client: SesClient = new SESv2Client({ region: settings.region, maxAttempts: 1 }),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    super();
  }

  async send(message: EmailMessage, context: SendContext): Promise<void> {
    const command = new SendEmailCommand({
      FromEmailAddress: this.settings.fromAddress,
      Destination: { ToAddresses: [message.to] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: message.text, Charset: 'UTF-8' },
            Html: { Data: message.html, Charset: 'UTF-8' },
          },
        },
      },
      ...(this.settings.configurationSet ? { ConfigurationSetName: this.settings.configurationSet } : {}),
    });

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.sendOnce(command);
        this.logger.log(`Email sent via SES (message ${result.MessageId ?? 'unknown'}, correlation ${context.correlationId})`);
        return;
      } catch (error) {
        const failure = this.classify(error);
        const { name, status } = describe(error);
        this.logger.warn(`SES send failed: ${failure} (${name}${status ? ` ${status}` : ''}), attempt ${attempt}, correlation ${context.correlationId}`);
        if (failure === 'retryable' && attempt === 1) {
          await this.sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new EmailUnavailableError();
      }
    }
  }

  private async sendOnce(command: SendEmailCommand): Promise<{ MessageId?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      return await this.client.send(command, { abortSignal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new SesTimeoutError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private classify(error: unknown): Failure {
    if (error instanceof SesTimeoutError) return 'timeout';
    const { name, status } = describe(error);
    if (THROTTLING.has(name) || status === 429) return 'retryable';
    if (status !== undefined && status >= 500) return 'retryable';
    return 'permanent';
  }
}

class SesTimeoutError extends Error {
  constructor() {
    super('SES send timed out');
    this.name = 'Timeout';
  }
}

function describe(error: unknown): { name: string; status?: number } {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return { name: e?.name ?? 'Error', status: e?.$metadata?.httpStatusCode };
}
