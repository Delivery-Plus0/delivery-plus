import { BadRequestError, ConflictError, UserRole } from '@food-delivery/shared';
import { AppConfig, loadSmsConfig } from '../config/app-config';
import { PhoneVerification } from '../entities/phone-verification.entity';
import { UserProfile } from '../entities/user-profile.entity';
import { NewPhoneVerification, PhoneVerificationsRepository, SendHistory } from '../repositories/phone-verifications.repository';
import { DisabledSmsSender, SmsSender, SmsUnavailableError, TestSmsSender, testSmsKey } from '../sms/sms-sender';
import { PHONE_OTP_POLICY, PhoneVerificationService, TooManyRequestsError } from './phone-verification.service';
import { UsersService } from './users.service';

describe('PhoneVerificationService (#153)', () => {
  const requester = { sub: 'u-1', email: 'mona@example.com', role: UserRole.CUSTOMER };
  const now = new Date('2026-10-07T10:00:00.000Z');
  const config = { otpHashSecret: 'test-secret' } as AppConfig;

  let users: jest.Mocked<Pick<UsersService, 'getOwnProfile'>>;
  let repo: jest.Mocked<PhoneVerificationsRepository>;
  let sent: { to: string; text: string }[];
  let sms: SmsSender;
  let history: SendHistory;
  let stored: (PhoneVerification & { codeHash: string }) | null;

  function profile(overrides: Partial<UserProfile> = {}): UserProfile {
    return {
      id: 'u-1',
      authCredentialId: 'u-1',
      createdByService: 'auth-service',
      email: 'mona@example.com',
      fullName: 'Mona Adel',
      phone: '+201012345678',
      phoneVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function service(sender: SmsSender = sms) {
    return new PhoneVerificationService(users as unknown as UsersService, repo, sender, config);
  }

  /** Starts a verification and returns the code that was "texted". */
  async function startAndReadCode(at = now): Promise<string> {
    await service().start(requester, undefined, at);
    const match = /(\d{6})/.exec(sent[sent.length - 1].text);
    if (!match) throw new Error('no code in the message');
    return match[1];
  }

  beforeEach(() => {
    users = { getOwnProfile: jest.fn().mockResolvedValue(profile()) };
    sent = [];
    sms = { enabled: true, send: jest.fn(async (to: string, text: string) => void sent.push({ to, text })) };
    history = { latestSentAt: null, sentByUser: 0, sentToPhone: 0 };
    stored = null;
    repo = {
      createUnderLimits: jest.fn(async (_userId: string, _phone: string, _since: Date, decide: (h: SendHistory) => NewPhoneVerification) => {
        const row = decide(history);
        stored = { ...row, attempts: 0, consumedAt: null, createdAt: now };
        return stored;
      }),
      latestForUser: jest.fn(async () => stored),
      registerAttempt: jest.fn(async (_id: string, max: number) => {
        if (!stored || stored.consumedAt || stored.attempts >= max) return null;
        stored.attempts += 1;
        return stored.attempts;
      }),
      consumeAndVerify: jest.fn(async () => {
        if (!stored || stored.consumedAt) return false;
        stored.consumedAt = now;
        return true;
      }),
      delete: jest.fn(async () => undefined),
    } as unknown as jest.Mocked<PhoneVerificationsRepository>;
  });

  describe('start', () => {
    it('texts a 6-digit code to the profile phone and stores only its hash', async () => {
      const result = await service().start(requester, undefined, now);

      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('+201012345678');
      const code = /(\d{6})/.exec(sent[0].text)?.[1];
      expect(code).toHaveLength(6);
      expect(stored?.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored?.codeHash).not.toContain(code);
      expect(result).toEqual({
        phone: '+201012345678',
        expiresAt: new Date(now.getTime() + PHONE_OTP_POLICY.ttlSeconds * 1000).toISOString(),
        resendAvailableAt: new Date(now.getTime() + PHONE_OTP_POLICY.resendCooldownSeconds * 1000).toISOString(),
      });
    });

    it('sends to a new number for a phone change, without changing the profile yet', async () => {
      await service().start(requester, '+201198765432', now);
      expect(sent[0].to).toBe('+201198765432');
      expect(stored?.phone).toBe('+201198765432');
      expect(repo.consumeAndVerify).not.toHaveBeenCalled();
    });

    it('needs a phone, and refuses one that is already verified', async () => {
      users.getOwnProfile.mockResolvedValue(profile({ phone: undefined }));
      await expect(service().start(requester, undefined, now)).rejects.toBeInstanceOf(BadRequestError);

      users.getOwnProfile.mockResolvedValue(profile({ phoneVerifiedAt: now }));
      await expect(service().start(requester, undefined, now)).rejects.toBeInstanceOf(ConflictError);
      expect(sent).toHaveLength(0);
    });

    it('refuses to start without an SMS provider instead of pretending a code was sent', async () => {
      await expect(service(new DisabledSmsSender()).start(requester, undefined, now)).rejects.toBeInstanceOf(SmsUnavailableError);
      expect(repo.createUnderLimits).not.toHaveBeenCalled();
    });

    it('enforces the resend cooldown', async () => {
      history.latestSentAt = new Date(now.getTime() - 20_000);
      await expect(service().start(requester, undefined, now)).rejects.toThrow('Please wait 40 seconds');
      expect(sent).toHaveLength(0);

      history.latestSentAt = new Date(now.getTime() - PHONE_OTP_POLICY.resendCooldownSeconds * 1000);
      await expect(service().start(requester, undefined, now)).resolves.toBeDefined();
    });

    it('limits sends per hour, per user and per number', async () => {
      history.sentByUser = PHONE_OTP_POLICY.maxSendsPerHour;
      await expect(service().start(requester, undefined, now)).rejects.toBeInstanceOf(TooManyRequestsError);

      history.sentByUser = 0;
      history.sentToPhone = PHONE_OTP_POLICY.maxSendsPerHour;
      await expect(service().start(requester, undefined, now)).rejects.toBeInstanceOf(TooManyRequestsError);
      expect(sent).toHaveLength(0);
    });

    it('drops the stored code when the message could not be sent', async () => {
      const failing: SmsSender = { enabled: true, send: jest.fn().mockRejectedValue(new Error('provider down')) };
      await expect(service(failing).start(requester, undefined, now)).rejects.toBeInstanceOf(SmsUnavailableError);
      expect(repo.delete).toHaveBeenCalledWith(stored?.id);
    });
  });

  describe('verify', () => {
    it('verifies the phone with the right code, once', async () => {
      const code = await startAndReadCode();
      users.getOwnProfile.mockResolvedValue(profile({ phoneVerifiedAt: now }));

      const result = await service().verify(requester, code, now);

      expect(repo.consumeAndVerify).toHaveBeenCalledWith(stored?.id, 'u-1', '+201012345678');
      expect(result.phoneVerifiedAt).toEqual(now);
      await expect(service().verify(requester, code, now)).rejects.toThrow('Request a new code first.');
    });

    it('counts wrong codes and locks after the maximum attempts', async () => {
      const code = await startAndReadCode();
      const wrong = code === '000000' ? '111111' : '000000';

      await expect(service().verify(requester, wrong, now)).rejects.toThrow(`${PHONE_OTP_POLICY.maxAttempts - 1} tries left`);
      for (let i = 2; i < PHONE_OTP_POLICY.maxAttempts; i += 1) await expect(service().verify(requester, wrong, now)).rejects.toThrow();
      await expect(service().verify(requester, wrong, now)).rejects.toThrow('Too many wrong codes');
      // Even the right code no longer works.
      await expect(service().verify(requester, code, now)).rejects.toBeInstanceOf(TooManyRequestsError);
      expect(repo.consumeAndVerify).not.toHaveBeenCalled();
    });

    it('rejects an expired code', async () => {
      const code = await startAndReadCode();
      const later = new Date(now.getTime() + PHONE_OTP_POLICY.ttlSeconds * 1000);
      await expect(service().verify(requester, code, later)).rejects.toThrow('expired');
      expect(repo.registerAttempt).not.toHaveBeenCalled();
    });

    it('needs a code to have been sent', async () => {
      await expect(service().verify(requester, '123456', now)).rejects.toThrow('Request a new code first.');
    });
  });
});

describe('SMS config (#153)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('is disabled by default', () => {
    delete process.env.SMS_PROVIDER;
    expect(loadSmsConfig('production').smsProvider).toBe('disabled');
  });

  it('never runs the test sender in production', () => {
    process.env.SMS_PROVIDER = 'test';
    expect(() => loadSmsConfig('production')).toThrow('cannot run in production');
    expect(loadSmsConfig('test').smsProvider).toBe('test');
  });

  it('rejects unknown providers', () => {
    process.env.SMS_PROVIDER = 'twilio';
    expect(() => loadSmsConfig('development')).toThrow('Unsupported SMS_PROVIDER');
  });
});

describe('TestSmsSender (#153)', () => {
  it('keeps the message in Redis with a short expiry instead of sending it', async () => {
    const redis = { set: jest.fn().mockResolvedValue('OK') };
    await new TestSmsSender(redis as never).send('+201012345678', 'Your code is 123456');
    expect(redis.set).toHaveBeenCalledWith(testSmsKey('+201012345678'), 'Your code is 123456', 'EX', 900);
  });
});
