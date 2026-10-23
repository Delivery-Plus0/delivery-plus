import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { AllExceptionsFilter, INTERNAL_AUTH_HEADERS, RateLimiterService, UserRole, signInternalRequest } from '@food-delivery/shared';
import { AuthController } from './auth.controller';
import { InternalSessionsController } from './internal-sessions.controller';
import { AuthService } from '../services/auth.service';
import { SessionsService } from '../services/sessions.service';
import { SessionsRepository } from '../repositories/sessions.repository';
import { CredentialsRepository } from '../repositories/credentials.repository';
import { UserServiceClient } from '../common/user-service.client';
import { InternalAuthGuard } from '../guards/internal-auth.guard';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { InMemorySessions } from '../testing/in-memory-sessions';
import { AccountStatus, Credential } from '../entities/credential.entity';
import { StaffPermissionsRepository } from '../repositories/staff-permissions.repository';
import { DisabledEmailSender } from '../email/email-sender';

const JWT_SECRET = 'test-jwt-secret';
const INTERNAL_SECRET = 'test-internal-secret';
const PASSWORD = 'correct-password';

const config = {
  emailVerificationRequired: false,
  maxFailedLoginAttempts: 5,
  lockoutMinutes: 15,
  verificationTokenTtlMinutes: 60,
  refreshTokenTtlDays: 30,
  sessionCleanupIntervalMs: 0,
  sessionRetentionDays: 30,
  internalAuthSecret: INTERNAL_SECRET,
  internalAuthAllowedServices: ['user-service'],
} as AppConfig;

const sessionRows = new InMemorySessions();
const credentialRows = new Map<string, Credential>();
const credentials = {
  findByEmail: async (email: string) => [...credentialRows.values()].find((c) => c.email === email) ?? null,
  findById: async (id: string) => credentialRows.get(id) ?? null,
  resetFailureState: async () => undefined,
  recordFailedLogin: async (id: string) => credentialRows.get(id) ?? null,
  update: async () => null,
  setStatus: async (id: string, status: AccountStatus, reason: string | null) => {
    const row = credentialRows.get(id);
    if (!row) return null;
    Object.assign(row, { status, suspendedAt: status === 'SUSPENDED' ? new Date() : null, suspendedReason: status === 'SUSPENDED' ? reason : null });
    return row;
  },
};
/** Staff permissions by credential id (#202). */
const permissionRows = new Map<string, string[]>();
const staffPermissions = { listFor: async (id: string) => [...(permissionRows.get(id) ?? [])].sort() };
/** Counts per key like the Redis limiter, so the per-session refresh limit can be exercised. */
const counts = new Map<string, number>();
const limiter = {
  incrementAndCheck: async (key: string, limit: number) => {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return (counts.get(key) as number) <= limit;
  },
};
const nonces = new Set<string>();
const redis = { set: async (key: string) => (nonces.has(key) ? null : (nonces.add(key), 'OK')) };

const userServiceClient = {
  sendPasswordResetCode: jest.fn().mockResolvedValue(undefined),
  verifyPasswordResetCode: jest.fn().mockResolvedValue(undefined), // rename to the client's real method
};

@Module({
  imports: [JwtModule.register({ secret: JWT_SECRET, signOptions: { expiresIn: '15m' } })],
  controllers: [AuthController, InternalSessionsController],
  providers: [
    { provide: APP_CONFIG, useValue: config },
    { provide: 'REDIS_CLIENT', useValue: redis },
    { provide: RateLimiterService, useValue: limiter },
    { provide: SessionsService, useFactory: () => new SessionsService(sessionRows as unknown as SessionsRepository, config) },
    {
      provide: AuthService,
      inject: [JwtService, SessionsService],
      useFactory: (jwt: JwtService, sessions: SessionsService) =>
        new AuthService(credentials as unknown as CredentialsRepository, userServiceClient as unknown  as UserServiceClient, jwt, config, sessions, staffPermissions as unknown as StaffPermissionsRepository, new DisabledEmailSender(), limiter as unknown as RateLimiterService),
    },
    InternalAuthGuard,
  ],
})
class AuthHttpTestModule {}

describe('Auth sessions over HTTP (#34)', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;
  let userId: string;

  beforeAll(async () => {
    userId = randomUUID();
    credentialRows.set(userId, {
      id: userId,
      email: 'driver@example.com',
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      role: UserRole.DRIVER,
      emailVerified: true,
      lockedUntil: null,
      failedLoginCount: 0,
      lastFailedLoginAt: null,
      verificationTokenHash: null,
      verificationTokenExpiresAt: null,
      verificationAttempts: 0,
      verificationSentAt: null,
      status: 'ACTIVE',
      suspendedAt: null,
      suspendedReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    app = await NestFactory.create(AuthHttpTestModule, { logger: false, abortOnError: false });
    // The same pipe and filter as main.ts.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter({ log: jest.fn() } as never));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => counts.clear());

  const post = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  const login = async (appId?: string) => (await post('/auth/login', { email: 'driver@example.com', password: PASSWORD, ...(appId ? { appId } : {}) })).body;
  const refresh = (refreshToken: string) => post('/auth/refresh', { refreshToken });

  it('login returns an access token, a refresh token and both expiries', async () => {
    const response = await post('/auth/login', { email: 'driver@example.com', password: PASSWORD, appId: 'driver' }, { 'User-Agent': 'DriverApp/1.0' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.stringMatching(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
      accessTokenExpiresAt: expect.any(String),
      refreshTokenExpiresAt: expect.any(String),
      userId,
      role: UserRole.DRIVER,
    });
    const minutes = (Date.parse(response.body.accessTokenExpiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    expect(sessionRows.rows.get(response.body.refreshToken.split('.')[0])).toMatchObject({ appId: 'driver', userAgent: 'DriverApp/1.0' });
  });

  it('rejects an unknown appId', async () => {
    expect((await post('/auth/login', { email: 'driver@example.com', password: PASSWORD, appId: 'tv' })).status).toBe(400);
  });

  it('keeps existing routes working with the access token, which now names its session', async () => {
    const { accessToken, refreshToken } = await login();

    const response = await fetch(`${baseUrl}/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sub: userId, role: UserRole.DRIVER, sid: refreshToken.split('.')[0] });
  });

  it('refresh rotates: a new pair comes back and the old refresh token fails', async () => {
    const first = await login();

    const rotated = await refresh(first.refreshToken);
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(first.refreshToken);
    expect(rotated.body.accessToken).toEqual(expect.any(String));

    const again = await refresh(first.refreshToken);
    expect(again.status).toBe(401);
    expect(again.body).toMatchObject({ error: 'InvalidRefreshToken' });
  });

  it('reusing a rotated token revokes the family: the newest token fails too', async () => {
    const first = await login();
    const second = (await refresh(first.refreshToken)).body;

    await refresh(first.refreshToken);

    expect((await refresh(second.refreshToken)).status).toBe(401);
  });

  it('refresh re-reads the role from the credential', async () => {
    const first = await login();
    credentialRows.get(userId)!.role = UserRole.CUSTOMER;
    try {
      const rotated = await refresh(first.refreshToken);
      expect(rotated.body.role).toBe(UserRole.CUSTOMER);
      expect(app.get(JwtService).decode(rotated.body.accessToken)).toMatchObject({ role: UserRole.CUSTOMER });
    } finally {
      credentialRows.get(userId)!.role = UserRole.DRIVER;
    }
  });

  it('logout ends the session (204) and the refresh token stops working; any token gets 204', async () => {
    const { refreshToken } = await login();

    expect((await post('/auth/logout', { refreshToken })).status).toBe(204);
    expect((await refresh(refreshToken)).status).toBe(401);
    expect((await post('/auth/logout', { refreshToken: 'whatever' })).status).toBe(204);
  });

  it('logout-all needs the access token and ends every session of the user', async () => {
    const a = await login('driver');
    const b = await login('customer');

    expect((await post('/auth/logout-all')).status).toBe(401);
    expect((await post('/auth/logout-all', undefined, { Authorization: `Bearer ${a.accessToken}` })).status).toBe(204);

    expect((await refresh(a.refreshToken)).status).toBe(401);
    expect((await refresh(b.refreshToken)).status).toBe(401);
  });

  it('limits refreshes per session, not per IP (every client shares the gateway IP)', async () => {
    let token = (await login()).refreshToken;
    for (let i = 0; i < 10; i++) {
      const response = await refresh(token);
      expect(response.status).toBe(200);
      token = response.body.refreshToken;
    }
    expect((await refresh(token)).status).toBe(429);

    // Another session from the same IP is not affected.
    expect((await refresh((await login()).refreshToken)).status).toBe(200);
  });

  describe('account status and staff permissions (#202)', () => {
    const STAFF_PASSWORD = 'staff-password-123';
    let adminId: string;
    let readOnlyStaffId: string;

    const addCredential = async (email: string, role: UserRole, password = PASSWORD) => {
      const id = randomUUID();
      credentialRows.set(id, {
        id, email, passwordHash: await bcrypt.hash(password, 4), role, emailVerified: true, lockedUntil: null, failedLoginCount: 0,
        lastFailedLoginAt: null, verificationTokenHash: null, verificationTokenExpiresAt: null, verificationAttempts: 0, verificationSentAt: null, status: 'ACTIVE', suspendedAt: null,
        suspendedReason: null, createdAt: new Date(), updatedAt: new Date(),
      });
      return id;
    };
    const signIn = async (email: string, password = PASSWORD) => (await post('/auth/login', { email, password })).body;
    const setStatus = async (id: string, body: unknown, accessToken: string) => {
      const response = await fetch(`${baseUrl}/auth/users/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };

    beforeAll(async () => {
      adminId = await addCredential('admin@example.com', UserRole.ADMIN, STAFF_PASSWORD);
      permissionRows.set(adminId, ['users.manage', 'ops.read']);
      readOnlyStaffId = await addCredential('support@example.com', UserRole.ADMIN, STAFF_PASSWORD);
      permissionRows.set(readOnlyStaffId, ['support.read']);
    });

    it('puts the staff permissions in staff access tokens, and none in other tokens', async () => {
      const staff = await signIn('admin@example.com', STAFF_PASSWORD);
      const driver = await signIn('driver@example.com');

      expect(app.get(JwtService).decode(staff.accessToken)).toMatchObject({ role: UserRole.ADMIN, perms: ['ops.read', 'users.manage'] });
      expect(app.get(JwtService).decode(driver.accessToken)).not.toHaveProperty('perms');
    });

    it('re-reads the permissions on refresh, so a change applies within one access-token lifetime', async () => {
      const staff = await signIn('support@example.com', STAFF_PASSWORD);
      permissionRows.set(readOnlyStaffId, ['support.read', 'support.act']);
      try {
        const rotated = (await refresh(staff.refreshToken)).body;
        expect(app.get(JwtService).decode(rotated.accessToken)).toMatchObject({ perms: ['support.act', 'support.read'] });
      } finally {
        permissionRows.set(readOnlyStaffId, ['support.read']);
      }
    });

    it('suspends an account: its sessions end, refresh and login answer 403 AccountSuspended; a wrong password stays 401', async () => {
      const userId = await addCredential('to-suspend@example.com', UserRole.CUSTOMER);
      const phone = await signIn('to-suspend@example.com');
      const laptop = await signIn('to-suspend@example.com');
      const admin = await signIn('admin@example.com', STAFF_PASSWORD);

      const suspended = await setStatus(userId, { status: 'SUSPENDED', reason: 'Chargeback fraud' }, admin.accessToken);

      expect(suspended.status).toBe(200);
      expect(suspended.body).toMatchObject({ userId, status: 'SUSPENDED', suspendedReason: 'Chargeback fraud', sessionsRevoked: 2 });
      for (const session of [phone, laptop]) {
        expect(await refresh(session.refreshToken)).toMatchObject({ status: 403, body: { error: 'AccountSuspended' } });
      }
      expect(await post('/auth/login', { email: 'to-suspend@example.com', password: PASSWORD })).toMatchObject({ status: 403, body: { error: 'AccountSuspended' } });
      // Nothing is revealed to someone without the password.
      expect(await post('/auth/login', { email: 'to-suspend@example.com', password: 'wrong-password' })).toMatchObject({ status: 401 });

      counts.clear(); // the login limit (5 per minute) is not what this test is about
      const reactivated = await setStatus(userId, { status: 'ACTIVE' }, admin.accessToken);
      expect(reactivated.body).toMatchObject({ status: 'ACTIVE', suspendedAt: null, suspendedReason: null });
      expect((await post('/auth/login', { email: 'to-suspend@example.com', password: PASSWORD })).status).toBe(200);
      // The sessions ended by the suspension stay ended.
      expect(await refresh(phone.refreshToken)).toMatchObject({ status: 401, body: { error: 'InvalidRefreshToken' } });
    });

    it('refuses the status route without users.manage, to non-staff, for staff targets and for yourself', async () => {
      const target = await addCredential('target@example.com', UserRole.DRIVER);
      const support = await signIn('support@example.com', STAFF_PASSWORD);
      const driver = await signIn('driver@example.com');
      const admin = await signIn('admin@example.com', STAFF_PASSWORD);

      expect((await setStatus(target, { status: 'SUSPENDED' }, support.accessToken)).status).toBe(403);
      expect((await setStatus(target, { status: 'SUSPENDED' }, driver.accessToken)).status).toBe(403);
      expect((await setStatus(readOnlyStaffId, { status: 'SUSPENDED' }, admin.accessToken)).status).toBe(403);
      expect((await setStatus(adminId, { status: 'SUSPENDED' }, admin.accessToken)).status).toBe(403);
      expect((await setStatus(target, { status: 'BANNED' }, admin.accessToken)).status).toBe(400);
      expect((await setStatus(randomUUID(), { status: 'SUSPENDED' }, admin.accessToken)).status).toBe(404);
      expect(credentialRows.get(target)?.status).toBe('ACTIVE');
    });
  });

  describe('POST /internal/auth/users/:id/revoke-sessions', () => {
    const path = () => `/internal/auth/users/${userId}/revoke-sessions`;
    const signed = (body: unknown, service = 'user-service', nonce: string = randomUUID()) => {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      return {
        [INTERNAL_AUTH_HEADERS.service]: service,
        [INTERNAL_AUTH_HEADERS.timestamp]: timestamp,
        [INTERNAL_AUTH_HEADERS.nonce]: nonce,
        [INTERNAL_AUTH_HEADERS.signature]: signInternalRequest({ method: 'POST', path: path(), timestamp, nonce, body, service, secret: INTERNAL_SECRET }),
      };
    };

    it('revokes every session except the one named, for an allowed service', async () => {
      const keep = await login();
      const other = await login();
      const body = { reason: 'password_changed', exceptSessionId: keep.refreshToken.split('.')[0] };

      const response = await post(path(), body, signed(body));

      expect(response.status).toBe(200);
      expect(response.body.revoked).toBeGreaterThanOrEqual(1);
      expect((await refresh(other.refreshToken)).status).toBe(401);
      expect((await refresh(keep.refreshToken)).status).toBe(200);
    });

    it('refuses unsigned, wrongly signed, replayed and not-allowed callers', async () => {
      const body = { reason: 'suspended' };
      expect((await post(path(), body)).status).toBe(401);

      const tampered = signed(body);
      expect((await post(path(), { reason: 'admin' }, tampered)).status).toBe(401);

      const once = signed(body);
      expect((await post(path(), body, once)).status).toBe(200);
      expect((await post(path(), body, once)).status).toBe(401);

      expect((await post(path(), body, signed(body, 'order-service'))).status).toBe(401);
    });

    it('refuses user-facing reasons and a malformed user id', async () => {
      const body = { reason: 'reuse_detected' };
      expect((await post(path(), body, signed(body))).status).toBe(400);

      const valid = { reason: 'admin' };
      const badPath = '/internal/auth/users/not-a-uuid/revoke-sessions';
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = randomUUID();
      const headers = {
        [INTERNAL_AUTH_HEADERS.service]: 'user-service',
        [INTERNAL_AUTH_HEADERS.timestamp]: timestamp,
        [INTERNAL_AUTH_HEADERS.nonce]: nonce,
        [INTERNAL_AUTH_HEADERS.signature]: signInternalRequest({ method: 'POST', path: badPath, timestamp, nonce, body: valid, service: 'user-service', secret: INTERNAL_SECRET }),
      };
      expect((await post(badPath, valid, headers)).status).toBe(400);
    });
  });

describe('password forgot / reset (#35)', () => {
  // copy a valid phone from the `phone` const in auth.service.spec.ts
  const PHONE = '+201012345678';
  const NEW_PASSWORD = 'a-new-password-123';

  it('POST /auth/password/forgot is public and answers 202 with a message', async () => {
    const response = await post('/auth/password/forgot', { phone: PHONE });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ message: expect.any(String) });
  });

  it('forgot rejects a malformed body with 400', async () => {
    expect((await post('/auth/password/forgot', {})).status).toBe(400);
    expect((await post('/auth/password/forgot', { phone: 'abc' })).status).toBe(400);
    expect((await post('/auth/password/forgot', { phone: PHONE, extra: true })).status).toBe(400);
  });

  it('forgot is rate limited over HTTP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await post('/auth/password/forgot', { phone: PHONE })).status);

    expect(statuses[0]).toBe(202);
    expect(statuses).toContain(429);
  });

  it('reset rejects a malformed body with 400', async () => {
    expect((await post('/auth/password/reset', { phone: PHONE, code: '123456' })).status).toBe(400);
    expect((await post('/auth/password/reset', { phone: PHONE, code: '123456', newPassword: 'short' })).status).toBe(400);
  });

  it('reset is public and answers 204 with no body', async () => {
  userServiceClient.verifyPasswordResetCode.mockResolvedValueOnce({ userId });
  const response = await post('/auth/password/reset', { phone: PHONE, code: '123456', newPassword: NEW_PASSWORD });

  expect(response.status).toBe(204);
  expect(response.body).toBeUndefined();
});
});
});
