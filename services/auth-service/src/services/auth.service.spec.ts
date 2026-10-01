import { AuthService } from './auth.service';
import { CredentialsRepository } from '../repositories/credentials.repository';
import { UserServiceClient } from '../common/user-service.client';
import { JwtService } from '@nestjs/jwt';
import { UserRole, ConflictError, ForbiddenError, UnauthorizedError, RateLimitGuard, RATE_LIMIT_KEY } from '@food-delivery/shared';
import { SELF_SERVICE_ROLES } from '../dto/register.dto';
import * as bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config/app-config';
import { AuthController } from '../controllers/auth.controller';

describe('AuthService', () => {
  let service: AuthService;
  let credentials: jest.Mocked<CredentialsRepository>;
  let userServiceClient: jest.Mocked<UserServiceClient>;
  let jwtService: jest.Mocked<JwtService>;

  beforeEach(() => {
    credentials = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      recordFailedLogin: jest.fn(),
      resetFailureState: jest.fn(),
      deleteById: jest.fn(),
    } as unknown as jest.Mocked<CredentialsRepository>;

    userServiceClient = {
      createProfile: jest.fn(),
    } as unknown as jest.Mocked<UserServiceClient>;

    jwtService = {
      signAsync: jest.fn().mockResolvedValue('signed.jwt.token'),
    } as unknown as jest.Mocked<JwtService>;

    service = new AuthService(credentials, userServiceClient, jwtService, {
      serviceName: 'auth-service',
      port: 3001,
      nodeEnv: 'test',
      databaseUrl: 'postgres://postgres:postgres@localhost:5432/auth_service',
      jwtSecret: 'secret',
      jwtExpiresIn: '1h',
      userServiceUrl: 'http://localhost:3002',
      internalAuthService: 'auth-service',
      internalAuthSecret: 'dev-secret',
      emailVerificationRequired: false,
      maxFailedLoginAttempts: 5,
      lockoutMinutes: 15,
      verificationTokenTtlMinutes: 60,
    });
  });

  describe('config validation', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
          delete process.env[key];
        }
      }
      for (const [key, value] of Object.entries(originalEnv)) {
        process.env[key] = value;
      }
    });

    it('accepts valid positive integer configuration values', () => {
      process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/auth_service';
      process.env.JWT_SECRET = 'secret';
      process.env.MAX_FAILED_LOGIN_ATTEMPTS = '7';
      process.env.LOCKOUT_MINUTES = '30';

      const config = loadConfig();

      expect(config.maxFailedLoginAttempts).toBe(7);
      expect(config.lockoutMinutes).toBe(30);
    });

    it.each([
      ['unset', undefined, 5],
      ['empty', '', 5],
      ['zero', '0', 0],
      ['negative', '-1', -1],
      ['decimal', '1.5', 1.5],
      ['non-numeric', 'abc', NaN],
    ])('rejects invalid MAX_FAILED_LOGIN_ATTEMPTS values for %s', (_label, rawValue, expected) => {
      process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/auth_service';
      process.env.JWT_SECRET = 'secret';
      if (rawValue === undefined) {
        delete process.env.MAX_FAILED_LOGIN_ATTEMPTS;
      } else {
        process.env.MAX_FAILED_LOGIN_ATTEMPTS = rawValue;
      }
      process.env.LOCKOUT_MINUTES = '15';

      if (_label === 'unset' || _label === 'empty') {
        expect(loadConfig().maxFailedLoginAttempts).toBe(5);
        return;
      }

      expect(() => loadConfig()).toThrow(`Invalid MAX_FAILED_LOGIN_ATTEMPTS: ${rawValue}`);
      expect(expected).toBeDefined();
    });

    it.each([
      ['unset', undefined, 15],
      ['empty', '', 15],
      ['zero', '0', 0],
      ['negative', '-1', -1],
      ['decimal', '1.5', 1.5],
      ['non-numeric', 'abc', NaN],
    ])('rejects invalid LOCKOUT_MINUTES values for %s', (_label, rawValue, expected) => {
      process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/auth_service';
      process.env.JWT_SECRET = 'secret';
      process.env.MAX_FAILED_LOGIN_ATTEMPTS = '5';
      if (rawValue === undefined) {
        delete process.env.LOCKOUT_MINUTES;
      } else {
        process.env.LOCKOUT_MINUTES = rawValue;
      }

      if (_label === 'unset' || _label === 'empty') {
        expect(loadConfig().lockoutMinutes).toBe(15);
        return;
      }

      expect(() => loadConfig()).toThrow(`Invalid LOCKOUT_MINUTES: ${rawValue}`);
      expect(expected).toBeDefined();
    });
  });

  describe('route rate limiting', () => {
    it('applies the shared rate limiter to verification routes', () => {
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, AuthController.prototype.verifyEmail)).toEqual({
        limit: 5,
        windowSeconds: 60,
      });
      expect(Reflect.getMetadata(RATE_LIMIT_KEY, AuthController.prototype.resendVerification)).toEqual({
        limit: 5,
        windowSeconds: 60,
      });
      expect(Reflect.getMetadata('__guards__', AuthController.prototype.verifyEmail)).toEqual(
        expect.arrayContaining([RateLimitGuard]),
      );
      expect(Reflect.getMetadata('__guards__', AuthController.prototype.resendVerification)).toEqual(
        expect.arrayContaining([RateLimitGuard]),
      );
    });
  });

  describe('register', () => {
    it('throws ConflictError when email already exists', async () => {
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'a@a.com',
        passwordHash: 'x',
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(
        service.register({ email: 'a@a.com', password: 'password123', fullName: 'A' }),
      ).rejects.toThrow(ConflictError);
    });

    it('creates credential, calls user-service, and returns a token', async () => {
      credentials.findByEmail.mockResolvedValue(null);
      credentials.create.mockResolvedValue({
        id: 'new-user-id',
        email: 'b@b.com',
        passwordHash: 'hashed',
        role: UserRole.CUSTOMER,
        emailVerified: false,
        failedLoginCount: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
        verificationTokenHash: 'token-hash',
        verificationTokenExpiresAt: new Date(Date.now() + 60000),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      userServiceClient.createProfile.mockResolvedValue(undefined);

      const result = await service.register({
        email: 'b@b.com',
        password: 'password123',
        fullName: 'B',
      });

      expect(userServiceClient.createProfile).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'new-user-id', email: 'b@b.com', fullName: 'B' }),
        expect.any(String),
      );
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.userId).toBe('new-user-id');
    });

    it('rolls back the credential if user-service call fails', async () => {
      credentials.findByEmail.mockResolvedValue(null);
      credentials.create.mockResolvedValue({
        id: 'orphan-id',
        email: 'c@c.com',
        passwordHash: 'hashed',
        role: UserRole.CUSTOMER,
        emailVerified: false,
        failedLoginCount: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
        verificationTokenHash: 'token-hash',
        verificationTokenExpiresAt: new Date(Date.now() + 60000),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      userServiceClient.createProfile.mockRejectedValue(new Error('user-service down'));

      await expect(
        service.register({ email: 'c@c.com', password: 'password123', fullName: 'C' }),
      ).rejects.toThrow('user-service down');

      expect(credentials.deleteById).toHaveBeenCalledWith('orphan-id');
    });

    describe('role is server-authoritative (no self-assigned privileges)', () => {
      // The repository returns what the service asked it to persist, so the token's role can only
      // come from the role the service decided on.
      beforeEach(() => {
        credentials.findByEmail.mockResolvedValue(null);
        credentials.create.mockImplementation(async (data) =>
          ({ id: 'new-user-id', ...data, createdAt: new Date(), updatedAt: new Date() }) as any,
        );
        userServiceClient.createProfile.mockResolvedValue(undefined);
      });

      // Every role outside the self-service allow-list: ADMIN today, and any privileged role added later.
      const privilegedRoles = Object.values(UserRole).filter((role) => !SELF_SERVICE_ROLES.includes(role));

      it('keeps ADMIN out of the self-service roles', () => {
        expect(privilegedRoles).toContain(UserRole.ADMIN);
        expect(SELF_SERVICE_ROLES).not.toContain(UserRole.ADMIN);
      });

      it.each(privilegedRoles)('refuses to register a %s account and persists nothing', async (role) => {
        await expect(
          service.register({ email: 'attacker@example.com', password: 'valid-password', fullName: 'Attacker', role }),
        ).rejects.toThrow(ForbiddenError);

        expect(credentials.findByEmail).not.toHaveBeenCalled();
        expect(credentials.create).not.toHaveBeenCalled();
        expect(userServiceClient.createProfile).not.toHaveBeenCalled();
        expect(jwtService.signAsync).not.toHaveBeenCalled();
      });

      it('registers a normal user as CUSTOMER with a hashed password and a CUSTOMER token', async () => {
        const result = await service.register({ email: 'jane@example.com', password: 'valid-password', fullName: 'Jane' });

        const persisted = credentials.create.mock.calls[0][0];
        expect(persisted.role).toBe(UserRole.CUSTOMER);
        expect(persisted.passwordHash).not.toBe('valid-password');
        await expect(bcrypt.compare('valid-password', persisted.passwordHash)).resolves.toBe(true);
        expect(userServiceClient.createProfile).toHaveBeenCalled();
        expect(jwtService.signAsync).toHaveBeenCalledWith({
          sub: 'new-user-id',
          email: 'jane@example.com',
          role: UserRole.CUSTOMER,
        });
        expect(result.role).toBe(UserRole.CUSTOMER);
      });

      it('treats an explicit null role like an omitted one (CUSTOMER)', async () => {
        const result = await service.register({
          email: 'nullrole@example.com',
          password: 'valid-password',
          fullName: 'Null Role',
          role: null as unknown as UserRole,
        });

        expect(credentials.create.mock.calls[0][0].role).toBe(UserRole.CUSTOMER);
        expect(result.role).toBe(UserRole.CUSTOMER);
      });

      it.each(SELF_SERVICE_ROLES)('still lets a caller register as %s', async (role) => {
        const result = await service.register({ email: 'b@b.com', password: 'valid-password', fullName: 'B', role });

        expect(credentials.create.mock.calls[0][0].role).toBe(role);
        expect(jwtService.signAsync).toHaveBeenCalledWith(expect.objectContaining({ role }));
        expect(result.role).toBe(role);
      });
    });
  });

  describe('login', () => {
    it('throws UnauthorizedError for unknown email', async () => {
      credentials.findByEmail.mockResolvedValue(null);
      await expect(service.login({ email: 'nope@a.com', password: 'whatever' })).rejects.toThrow(
        UnauthorizedError,
      );
    });

    it.each([true, false])(
      'throws the generic authentication error for wrong passwords on %s accounts',
      async (emailVerified) => {
        const hash = await bcrypt.hash('correct-password', 10);
        credentials.findByEmail.mockResolvedValue({
          id: 'u1',
          email: 'd@d.com',
          passwordHash: hash,
          role: UserRole.CUSTOMER,
          emailVerified,
          failedLoginCount: 0,
          lockedUntil: null,
          verificationTokenHash: null,
          verificationTokenExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);
        credentials.recordFailedLogin.mockResolvedValue({
          id: 'u1',
          email: 'd@d.com',
          passwordHash: hash,
          role: UserRole.CUSTOMER,
          emailVerified,
          failedLoginCount: 1,
          lockedUntil: null,
          lastFailedLoginAt: new Date(),
          verificationTokenHash: null,
          verificationTokenExpiresAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        } as any);

        await expect(service.login({ email: 'd@d.com', password: 'wrong-password' })).rejects.toThrow(
          'Invalid email or password',
        );
        expect(credentials.recordFailedLogin).toHaveBeenCalledWith('u1', expect.any(Date));
      },
    );

    it('returns a token for verified credentials and resets failure state', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'e@e.com',
        passwordHash: hash,
        role: UserRole.ADMIN,
        emailVerified: true,
        failedLoginCount: 3,
        lockedUntil: null,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      credentials.update.mockResolvedValue({} as any);

      const result = await service.login({ email: 'e@e.com', password: 'correct-password' });
      expect(credentials.resetFailureState).toHaveBeenCalledWith('u1');
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.role).toBe(UserRole.ADMIN);
    });

    it('locks the account after the configured failed-attempt threshold', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'locked@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 4,
        lockedUntil: null,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      credentials.recordFailedLogin.mockResolvedValue({
        id: 'u1',
        email: 'locked@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 5,
        lockedUntil: null,
        lastFailedLoginAt: new Date(),
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.login({ email: 'locked@example.com', password: 'wrong-password' })).rejects.toThrow(
        'Invalid email or password',
      );

      expect(credentials.recordFailedLogin).toHaveBeenCalledWith('u1', expect.any(Date));
      expect(credentials.update).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({
          lockedUntil: expect.any(Date),
        }),
      );
    });

    it('rejects login while the account is still locked', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'locked@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() + 60_000),
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(
        service.login({ email: 'locked@example.com', password: 'correct-password' }),
      ).rejects.toThrow('Invalid email or password');
    });

    it('starts a new failure sequence from 1 after an expired lockout', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'expired@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() - 1000),
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      credentials.recordFailedLogin.mockResolvedValue({
        id: 'u1',
        email: 'expired@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 1,
        lockedUntil: null,
        lastFailedLoginAt: new Date(),
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.login({ email: 'expired@example.com', password: 'wrong-password' })).rejects.toThrow(
        'Invalid email or password',
      );

      expect(credentials.resetFailureState).toHaveBeenCalledWith('u1');
      expect(credentials.recordFailedLogin).toHaveBeenCalledWith('u1', expect.any(Date));
    });

    it('clears the failure state and lock when valid credentials are used after an expired lock', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'expired@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: true,
        failedLoginCount: 5,
        lockedUntil: new Date(Date.now() - 1000),
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      credentials.update.mockResolvedValue({} as any);

      await service.login({ email: 'expired@example.com', password: 'correct-password' });

      expect(credentials.resetFailureState).toHaveBeenCalledWith('u1');
    });

    it('requires email verification before a successful login when enabled', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      service = new AuthService(credentials, userServiceClient, jwtService, {
        ...service['config'],
        emailVerificationRequired: true,
      });

      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'verify@example.com',
        passwordHash: hash,
        role: UserRole.CUSTOMER,
        emailVerified: false,
        failedLoginCount: 0,
        lockedUntil: null,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.login({ email: 'verify@example.com', password: 'correct-password' })).rejects.toThrow(
        'Please verify your email before logging in',
      );
    });
  });

  describe('email verification', () => {
    it('accepts a valid verification token and clears it after success', async () => {
      const token = 'token-123';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'verify@example.com',
        passwordHash: 'hash',
        role: UserRole.CUSTOMER,
        emailVerified: false,
        failedLoginCount: 0,
        lockedUntil: null,
        verificationTokenHash: tokenHash,
        verificationTokenExpiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      credentials.update.mockResolvedValue({} as any);

      await expect(service.verifyEmail({ email: 'verify@example.com', token })).resolves.toEqual({
        message: 'Email verified successfully',
      });

      expect(credentials.update).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({
          emailVerified: true,
          verificationTokenHash: null,
          verificationTokenExpiresAt: null,
        }),
      );
    });

    it('rejects expired verification tokens', async () => {
      const token = 'token-123';
      const tokenHash = createHash('sha256').update(token).digest('hex');
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'verify@example.com',
        passwordHash: 'hash',
        role: UserRole.CUSTOMER,
        emailVerified: false,
        failedLoginCount: 0,
        lockedUntil: null,
        verificationTokenHash: tokenHash,
        verificationTokenExpiresAt: new Date(Date.now() - 1000),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.verifyEmail({ email: 'verify@example.com', token })).rejects.toThrow(
        'Invalid or expired verification token',
      );
    });

    it('rejects wrong verification tokens', async () => {
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'verify@example.com',
        passwordHash: 'hash',
        role: UserRole.CUSTOMER,
        emailVerified: false,
        failedLoginCount: 0,
        lockedUntil: null,
        verificationTokenHash: createHash('sha256').update('other-token').digest('hex'),
        verificationTokenExpiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.verifyEmail({ email: 'verify@example.com', token: 'token-123' })).rejects.toThrow(
        'Invalid or expired verification token',
      );
    });

    it('rejects already-used verification tokens independently of expiry', async () => {
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'verify@example.com',
        passwordHash: 'hash',
        role: UserRole.CUSTOMER,
        emailVerified: false,
        failedLoginCount: 0,
        lockedUntil: null,
        verificationTokenHash: null,
        verificationTokenExpiresAt: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await expect(service.verifyEmail({ email: 'verify@example.com', token: 'token-123' })).rejects.toThrow(
        'Invalid or expired verification token',
      );
    });

    it('issues a safe resend-verification response for existing accounts', async () => {
      credentials.findByEmail.mockResolvedValue({
        id: 'u1',
        email: 'resend@example.com',
        passwordHash: 'hash',
        role: UserRole.CUSTOMER,
        emailVerified: false,
        failedLoginCount: 0,
        lockedUntil: null,
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
      credentials.update.mockResolvedValue({} as any);

      const result = await service.resendVerification({ email: 'resend@example.com' });

      expect(credentials.update).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({
          verificationTokenHash: expect.any(String),
          verificationTokenExpiresAt: expect.any(Date),
        }),
      );
      expect(result).toEqual({ message: 'If that account exists, a verification email has been sent' });
    });
  });
});
