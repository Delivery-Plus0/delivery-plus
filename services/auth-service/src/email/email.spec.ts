import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { Logger } from '@nestjs/common';
import { DisabledEmailSender, EmailUnavailableError, TestEmailSender, testEmailKey } from './email-sender';
import { SesClient, SesEmailSender } from './ses-email-sender';
import { buildVerificationEmail, hashVerificationCode, localeFrom, newVerificationCode, verificationCodeMatches } from './verification-email';
import { loadEmailConfig } from '../config/app-config';

const message = buildVerificationEmail('customer@example.com', '042517', 'en', 10);
const settings = { region: 'eu-west-1', fromAddress: 'no-reply@deliveryplus.example', configurationSet: 'transactional', timeoutMs: 50 };
const awsError = (name: string, status?: number) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe('SesEmailSender (#203, mocked SESv2: no real AWS calls)', () => {
  let logs: string[];
  beforeEach(() => {
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  });
  afterEach(() => jest.restoreAllMocks());

  const sender = (send: jest.Mock) => new SesEmailSender(settings, { send } as unknown as SesClient, async () => undefined);

  it('sends one multipart SendEmail with the configured sender and configuration set', async () => {
    const send = jest.fn().mockResolvedValue({ MessageId: 'm-1' });

    await sender(send).send(message, { correlationId: 'corr-1' });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as SendEmailCommand;
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command.input).toMatchObject({
      FromEmailAddress: 'no-reply@deliveryplus.example',
      Destination: { ToAddresses: ['customer@example.com'] },
      ConfigurationSetName: 'transactional',
      Content: { Simple: { Subject: { Data: message.subject, Charset: 'UTF-8' }, Body: { Text: { Data: message.text }, Html: { Data: message.html } } } },
    });
    expect(send.mock.calls[0][1]).toEqual({ abortSignal: expect.any(Object) });
  });

  it.each([['TooManyRequestsException', 429], ['ThrottlingException', 400], ['InternalFailure', 500], ['ServiceUnavailable', 503]])(
    'retries once after %s, and succeeds',
    async (name, status) => {
      const send = jest.fn().mockRejectedValueOnce(awsError(name, status)).mockResolvedValueOnce({ MessageId: 'm-2' });

      await sender(send).send(message, { correlationId: 'corr-1' });

      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it('gives up with 503 after the one retry also fails', async () => {
    const send = jest.fn().mockRejectedValue(awsError('TooManyRequestsException', 429));

    await expect(sender(send).send(message, { correlationId: 'corr-1' })).rejects.toBeInstanceOf(EmailUnavailableError);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([['MessageRejected', 400], ['MailFromDomainNotVerifiedException', 400], ['AccountSuspendedException', 400], ['NotFoundException', 404]])(
    'never retries a 4xx (%s) and answers 503 without provider details',
    async (name, status) => {
      const send = jest.fn().mockRejectedValue(awsError(name, status));

      const error = await sender(send).send(message, { correlationId: 'corr-1' }).catch((e: unknown) => e);

      expect(send).toHaveBeenCalledTimes(1);
      expect(error).toMatchObject({ statusCode: 503, error: 'EmailUnavailable' });
      expect((error as Error).message).not.toContain(name);
    },
  );

  it('abandons a send after the timeout and does not retry it (SES may already have sent it)', async () => {
    const send = jest.fn((_command: unknown, options: { abortSignal: AbortSignal }) =>
      new Promise((_resolve, reject) => options.abortSignal.addEventListener('abort', () => reject(awsError('AbortError')))),
    );

    await expect(sender(send).send(message, { correlationId: 'corr-1' })).rejects.toBeInstanceOf(EmailUnavailableError);
    expect(send).toHaveBeenCalledTimes(1);
    expect(logs.join('\n')).toMatch(/timeout/);
  });

  it('logs the correlation id, never the recipient or the code', async () => {
    const send = jest.fn().mockRejectedValueOnce(awsError('InternalFailure', 500)).mockResolvedValueOnce({ MessageId: 'm-3' });

    await sender(send).send(message, { correlationId: 'corr-42' });

    const output = logs.join('\n');
    expect(output).toContain('corr-42');
    expect(output).not.toContain('customer@example.com');
    expect(output).not.toContain('042517');
  });
});

describe('the other senders (#203)', () => {
  it('Disabled refuses with 503 EmailUnavailable', async () => {
    const disabled = new DisabledEmailSender();
    expect(disabled.enabled).toBe(false);
    await expect(disabled.send()).rejects.toMatchObject({ statusCode: 503, error: 'EmailUnavailable' });
  });

  it('Test keeps the last email per address in Redis for 15 minutes', async () => {
    const redis = { set: jest.fn().mockResolvedValue('OK') };
    await new TestEmailSender(redis as never).send({ ...message, to: 'Customer@Example.com' });
    expect(redis.set).toHaveBeenCalledWith(testEmailKey('customer@example.com'), JSON.stringify({ ...message, to: 'Customer@Example.com' }), 'EX', 900);
    expect(testEmailKey('A@B.c')).toBe('test:email:a@b.c');
  });
});

describe('verification email and code (#203)', () => {
  it('builds a multipart email in English or Arabic (right to left), with the code in both parts', () => {
    const en = buildVerificationEmail('a@b.c', '000123', 'en', 10);
    const ar = buildVerificationEmail('a@b.c', '000123', 'ar', 10);

    expect(en.text).toContain('000123');
    expect(en.html).toContain('000123');
    expect(en.html).toContain('dir="ltr"');
    expect(ar.subject).toBe('رمز التحقق من Delivery Plus');
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.text).toContain('10 دقائق');
  });

  it('picks the language from Accept-Language, Arabic by default', () => {
    expect(localeFrom('en-US,en;q=0.9')).toBe('en');
    expect(localeFrom('ar-EG')).toBe('ar');
    expect(localeFrom(undefined)).toBe('ar');
    expect(localeFrom('fr')).toBe('ar');
  });

  it('makes 6-digit codes and matches them only for the same account and secret', () => {
    const codes = new Set(Array.from({ length: 200 }, newVerificationCode));
    expect([...codes].every((code) => /^\d{6}$/.test(code))).toBe(true);
    expect(codes.size).toBeGreaterThan(190);

    const stored = hashVerificationCode('123456', 'u1', 'secret');
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(verificationCodeMatches('123456', 'u1', 'secret', stored)).toBe(true);
    expect(verificationCodeMatches('123457', 'u1', 'secret', stored)).toBe(false);
    expect(verificationCodeMatches('123456', 'u2', 'secret', stored)).toBe(false);
    expect(verificationCodeMatches('123456', 'u1', 'other', stored)).toBe(false);
    expect(verificationCodeMatches('12345', 'u1', 'secret', stored)).toBe(false);
  });
});

describe('loadEmailConfig: production rules (#203)', () => {
  const strong = 'x'.repeat(40);

  it('defaults to disabled', () => {
    expect(loadEmailConfig('development', false, {})).toMatchObject({ emailProvider: 'disabled', ses: null });
  });

  it('needs AWS_REGION and SES_FROM_ADDRESS for ses, and reads the optional configuration set and timeout', () => {
    expect(() => loadEmailConfig('test', false, { EMAIL_PROVIDER: 'ses' })).toThrow('EMAIL_PROVIDER=ses needs AWS_REGION and SES_FROM_ADDRESS');
    expect(() => loadEmailConfig('test', false, { EMAIL_PROVIDER: 'ses', AWS_REGION: 'eu-west-1' })).toThrow('needs SES_FROM_ADDRESS');
    expect(loadEmailConfig('test', false, { EMAIL_PROVIDER: 'ses', AWS_REGION: 'eu-west-1', SES_FROM_ADDRESS: 'no-reply@x.example', SES_CONFIGURATION_SET: 'tx' }).ses).toEqual({
      region: 'eu-west-1',
      fromAddress: 'no-reply@x.example',
      configurationSet: 'tx',
      timeoutMs: 5000,
    });
  });

  it('refuses the test sender in production', () => {
    expect(() => loadEmailConfig('production', false, { EMAIL_PROVIDER: 'test', EMAIL_CODE_HASH_SECRET: strong })).toThrow('EMAIL_PROVIDER=test is for isolated test environments');
  });

  it('refuses EMAIL_VERIFICATION_REQUIRED=true with the disabled sender in production', () => {
    expect(() => loadEmailConfig('production', true, {})).toThrow('needs a real EMAIL_PROVIDER in production');
    expect(() => loadEmailConfig('development', true, {})).not.toThrow();
  });

  it('needs a real EMAIL_CODE_HASH_SECRET for a provider in production', () => {
    const ses = { EMAIL_PROVIDER: 'ses', AWS_REGION: 'eu-west-1', SES_FROM_ADDRESS: 'no-reply@x.example' };
    expect(() => loadEmailConfig('production', true, ses)).toThrow('EMAIL_CODE_HASH_SECRET');
    expect(() => loadEmailConfig('production', true, { ...ses, EMAIL_CODE_HASH_SECRET: 'short' })).toThrow('at least 32 characters');
    expect(loadEmailConfig('production', true, { ...ses, EMAIL_CODE_HASH_SECRET: strong }).emailCodeHashSecret).toBe(strong);
  });

  it('rejects an unknown provider', () => {
    expect(() => loadEmailConfig('test', false, { EMAIL_PROVIDER: 'postmark' })).toThrow('Unsupported EMAIL_PROVIDER');
  });
});
