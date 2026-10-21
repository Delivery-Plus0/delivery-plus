import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard, RequirePermissions } from './permissions';
import { GATEWAY_MARKER_HEADER, LOCAL_SYSTEM_JWT_SECRET, loadSystemJwtSecret, systemSecretForVerification } from './system-principal';
import { UserRole } from '../../types/enums';

const USER_SECRET = 'user-secret';
const SYSTEM_SECRET = 'system-secret';

const jwt = new JwtService({ secret: USER_SECRET });
const guard = new JwtAuthGuard(jwt);

function request(token: string, headers: Record<string, string> = {}) {
  const req: { headers: Record<string, string>; user?: unknown } = { headers: { authorization: `Bearer ${token}`, ...headers } };
  return { req, ctx: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext };
}

describe('JwtAuthGuard and the SYSTEM principal (#202)', () => {
  const original = process.env.SYSTEM_JWT_SECRET;
  beforeAll(() => {
    process.env.SYSTEM_JWT_SECRET = SYSTEM_SECRET;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.SYSTEM_JWT_SECRET;
    else process.env.SYSTEM_JWT_SECRET = original;
  });

  const userToken = (role: UserRole, extra: object = {}) => jwt.sign({ sub: 'u1', email: 'u@x', role, ...extra });
  const systemToken = (role = UserRole.SYSTEM, secret = SYSTEM_SECRET) => jwt.sign({ sub: 'system:delivery-service', email: 'd@internal', role }, { secret, expiresIn: '2m' });

  it('accepts a user token signed with JWT_SECRET, through the gateway or not', async () => {
    for (const headers of [{}, { [GATEWAY_MARKER_HEADER]: '1' }] as Array<Record<string, string>>) {
      const { req, ctx } = request(userToken(UserRole.CUSTOMER), headers);
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(req.user).toMatchObject({ sub: 'u1', role: UserRole.CUSTOMER });
    }
  });

  it('accepts a SYSTEM token signed with SYSTEM_JWT_SECRET on a direct (service-to-service) request', async () => {
    const { req, ctx } = request(systemToken());
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.user).toMatchObject({ role: UserRole.SYSTEM, sub: 'system:delivery-service' });
  });

  it('refuses a SYSTEM token on a request that came through the gateway', async () => {
    const { ctx } = request(systemToken(), { [GATEWAY_MARKER_HEADER]: '1' });
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid or expired token');
  });

  it('refuses a token claiming SYSTEM but signed with the user secret (forged with JWT_SECRET)', async () => {
    const { ctx } = request(userToken(UserRole.SYSTEM));
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid or expired token');
  });

  it('refuses a token signed with SYSTEM_JWT_SECRET that claims a person role (e.g. ADMIN)', async () => {
    const { ctx } = request(systemToken(UserRole.ADMIN));
    await expect(guard.canActivate(ctx)).rejects.toThrow('Invalid or expired token');
  });

  it('refuses tokens signed with neither secret, expired tokens and malformed headers', async () => {
    await expect(guard.canActivate(request(systemToken(UserRole.SYSTEM, 'other')).ctx)).rejects.toThrow();
    await expect(guard.canActivate(request(jwt.sign({ sub: 'u', role: UserRole.CUSTOMER, exp: 1 })).ctx)).rejects.toThrow();
    const req = { headers: { authorization: 'Basic abc' } };
    await expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext)).rejects.toThrow('Missing or malformed');
  });

  it('accepts no SYSTEM token at all in production when the service has no SYSTEM_JWT_SECRET', () => {
    expect(systemSecretForVerification({ NODE_ENV: 'production' })).toBeUndefined();
    expect(systemSecretForVerification({ NODE_ENV: 'test' })).toBe(LOCAL_SYSTEM_JWT_SECRET);
    expect(systemSecretForVerification({ NODE_ENV: 'production', SYSTEM_JWT_SECRET: 's' })).toBe('s');
  });
});

describe('loadSystemJwtSecret: a required production secret (#202, #14)', () => {
  const strong = 'x'.repeat(40);

  it('falls back to the local default outside production', () => {
    expect(loadSystemJwtSecret('development', {})).toBe(LOCAL_SYSTEM_JWT_SECRET);
    expect(loadSystemJwtSecret('test', { SYSTEM_JWT_SECRET: 'abc' })).toBe('abc');
  });

  it.each([
    ['missing', {}, 'Missing required environment variables: SYSTEM_JWT_SECRET'],
    ['the local default', { SYSTEM_JWT_SECRET: LOCAL_SYSTEM_JWT_SECRET }, 'local development default'],
    ['shorter than 32 characters', { SYSTEM_JWT_SECRET: 'short-secret' }, 'at least 32 characters'],
    ['the same as JWT_SECRET', { SYSTEM_JWT_SECRET: strong, JWT_SECRET: strong }, 'must differ from JWT_SECRET'],
  ])('refuses %s in production', (_label, env, message) => {
    expect(() => loadSystemJwtSecret('production', env as NodeJS.ProcessEnv)).toThrow(message);
  });

  it('accepts a long, distinct secret in production', () => {
    expect(loadSystemJwtSecret('production', { SYSTEM_JWT_SECRET: strong, JWT_SECRET: 'y'.repeat(40) })).toBe(strong);
  });
});

describe('PermissionsGuard (#202)', () => {
  class Routes {
    @RequirePermissions('users.manage')
    suspend() {}
    open() {}
  }
  const permissions = new PermissionsGuard(new Reflector());
  const ctx = (handler: keyof Routes, user: unknown) =>
    ({ getHandler: () => Routes.prototype[handler], getClass: () => Routes, switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

  it('lets staff holding the permission through, and refuses staff without it', () => {
    expect(permissions.canActivate(ctx('suspend', { role: UserRole.ADMIN, perms: ['users.manage', 'ops.read'] }))).toBe(true);
    expect(() => permissions.canActivate(ctx('suspend', { role: UserRole.ADMIN, perms: ['ops.read'] }))).toThrow('users.manage');
    expect(() => permissions.canActivate(ctx('suspend', { role: UserRole.ADMIN }))).toThrow('users.manage');
  });

  it('never honours perms on a non-staff token', () => {
    expect(() => permissions.canActivate(ctx('suspend', { role: UserRole.CUSTOMER, perms: ['users.manage'] }))).toThrow();
    expect(() => permissions.canActivate(ctx('suspend', { role: UserRole.SYSTEM, perms: ['users.manage'] }))).toThrow();
  });

  it('does nothing on a route without permissions', () => {
    expect(permissions.canActivate(ctx('open', undefined))).toBe(true);
  });
});
