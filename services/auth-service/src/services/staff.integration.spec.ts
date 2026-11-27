/**
 * Staff accounts (#216) against real PostgreSQL: invite → accept with exactly the invited permissions
 * (single use, a newer invitation revokes an older one), the guard rails (own staff.manage, the last
 * super admin), disabling with sessions ended, and one audit event per change.
 *
 * Opt-in: AUTH_TEST_DATABASE_URL, a DISPOSABLE database; run with --runInBand.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { STAFF_PERMISSIONS } from '@food-delivery/shared';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { Credential } from '../entities/credential.entity';
import { AuthSession } from '../entities/auth-session.entity';
import { StaffPermission } from '../entities/staff-permission.entity';
import { StaffInvitation } from '../entities/staff-invitation.entity';
import { StaffRepository } from '../repositories/staff.repository';
import { SessionsRepository } from '../repositories/sessions.repository';
import { StaffPermissionsRepository } from '../repositories/staff-permissions.repository';
import { StaffService } from './staff.service';

const DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('StaffService (PostgreSQL integration, #216)', () => {
  jest.setTimeout(60_000);
  let ds: DataSource;
  let service: StaffService;
  let permissions: StaffPermissionsRepository;
  const sent: { to: string; text: string }[] = [];
  const userService = { createProfile: jest.fn().mockResolvedValue(undefined) };
  let superAdmin: { id: string; email: string };

  beforeAll(async () => {
    ds = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [Credential, AuthSession, StaffPermission, StaffInvitation]));
    await ds.initialize();
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
    permissions = new StaffPermissionsRepository(ds.getRepository(StaffPermission));
    service = new StaffService(
      { adminAppUrl: 'https://admin.example.test', staffInvitationTtlHours: 48 } as never,
      new StaffRepository(ds.getRepository(Credential), ds.getRepository(StaffInvitation)),
      new SessionsRepository(ds.getRepository(AuthSession)),
      { kick: jest.fn() } as never,
      userService as never,
      { enabled: true, send: async (message: { to: string; text: string }) => void sent.push(message) } as never,
    );
    const [row] = await ds.query(`INSERT INTO "credentials" ("email", "passwordHash", "role", "emailVerified") VALUES ('root@example.test', 'x', 'ADMIN', true) RETURNING "id"`);
    for (const permission of STAFF_PERMISSIONS) await ds.query(`INSERT INTO "staff_permissions" ("credentialId", "permission") VALUES ($1, $2)`, [row.id, permission]);
    superAdmin = { id: row.id, email: 'root@example.test' };
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const tokenFor = (email: string) => new URL(sent.filter((m) => m.to === email).slice(-1)[0].text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  const actions = async (targetId: string) =>
    (await ds.query(`SELECT "payload"->'payload'->>'action' AS "a" FROM "outbox_events" WHERE "payload"->'payload'->>'targetId' = $1 ORDER BY "id"`, [targetId])).map(
      (r: { a: string }) => r.a,
    );
  const invite = async (email: string, perms: string[]) => {
    const invitation = await service.invite(superAdmin, email, perms as never, 'Integration test', 'en', 'corr');
    return { invitation, token: tokenFor(email) };
  };

  it('invites by email and accepts once, with exactly the invited permissions', async () => {
    const { invitation, token } = await invite('agent@example.test', ['support.read', 'ops.read', 'support.read']);
    expect(invitation.permissions).toEqual(['ops.read', 'support.read']);
    expect(sent[sent.length - 1].text).toContain('https://admin.example.test/accept-invitation?token=');
    const [{ tokenHash }] = await ds.query(`SELECT "tokenHash" FROM "staff_invitations" WHERE "id" = $1`, [invitation.id]);
    expect(tokenHash).not.toContain(token); // only the hash is stored

    const accepted = await service.accept(token, 'a-long-staff-password', 'Mona Ali', '+201012345678', 'corr');
    expect(accepted).toMatchObject({ email: 'agent@example.test', permissions: ['ops.read', 'support.read'] });
    expect(await permissions.listFor(accepted.userId)).toEqual(['ops.read', 'support.read']);
    expect(userService.createProfile).toHaveBeenCalledWith({ userId: accepted.userId, email: 'agent@example.test', fullName: 'Mona Ali', phone: '+201012345678' }, 'corr');
    await expect(service.accept(token, 'a-long-staff-password', 'Mona Ali', undefined, 'corr')).rejects.toThrow('not valid any more');
    expect(await actions(invitation.id)).toEqual(['staff.invite']);
    expect(await actions(accepted.userId)).toEqual(['staff.accept']);
  });

  it('revokes an older invitation when the same email is invited again, and rolls back when user-service refuses', async () => {
    const first = await invite('twice@example.test', ['finance.read']);
    const second = await invite('twice@example.test', ['finance.read', 'finance.act']);
    await expect(service.accept(first.token, 'a-long-staff-password', 'Old Link', undefined, 'c')).rejects.toThrow('not valid any more');

    userService.createProfile.mockRejectedValueOnce(new Error('user-service down'));
    await expect(service.accept(second.token, 'a-long-staff-password', 'Sara', undefined, 'c')).rejects.toThrow('user-service down');
    const [{ count }] = await ds.query(`SELECT count(*)::int AS "count" FROM "credentials" WHERE "email" = 'twice@example.test'`);
    expect(count).toBe(0);
    // The rollback left the invitation usable.
    await expect(service.accept(second.token, 'a-long-staff-password', 'Sara', undefined, 'c')).resolves.toMatchObject({ permissions: ['finance.act', 'finance.read'] });
  });

  it('refuses to invite an email that already has an account', async () => {
    await expect(service.invite(superAdmin, 'root@example.test', ['support.read'], 'x-reason', 'en', 'c')).rejects.toThrow('already belongs');
  });

  it('keeps the guard rails: own staff.manage, and the last super admin', async () => {
    await expect(service.setPermissions(superAdmin, superAdmin.id, ['support.read'], 'Downgrade myself')).rejects.toThrow('your own staff.manage');
    await expect(service.disable(superAdmin, superAdmin.id, 'Disable myself')).rejects.toThrow('your own account');

    const { token } = await invite('second.admin@example.test', ['staff.manage', 'audit.read']);
    const second = await service.accept(token, 'a-long-staff-password', 'Second Admin', undefined, 'c');
    const secondActor = { id: second.userId, email: second.email };
    // With two managers, one can step down the other; then the remaining one is the last.
    await expect(service.setPermissions(secondActor, superAdmin.id, ['audit.read'], 'Rotate duties')).resolves.toMatchObject({ permissions: ['audit.read'] });
    await expect(service.disable(superAdmin, second.userId, 'Try to remove the last one')).rejects.toThrow('last active staff member');
    await expect(service.setPermissions(superAdmin, second.userId, ['audit.read'], 'x-reason')).rejects.toThrow('last active staff member');
    // Restore.
    await service.setPermissions(secondActor, superAdmin.id, [...STAFF_PERMISSIONS], 'Restore');
  });

  it('disables (ending sessions) and enables, once each, and a no-op change records nothing', async () => {
    const { token } = await invite('temp@example.test', ['support.read']);
    const temp = await service.accept(token, 'a-long-staff-password', 'Temp', undefined, 'c');
    await ds.query(
      `INSERT INTO "auth_sessions" ("id", "credentialId", "refreshTokenHash", "expiresAt") VALUES ($1, $2, $3, now() + interval '1 day')`,
      [randomUUID(), temp.userId, randomUUID()],
    );

    await expect(service.setPermissions(superAdmin, temp.userId, ['support.read'], 'Same set')).resolves.toMatchObject({ permissions: ['support.read'] });
    await expect(service.disable(superAdmin, temp.userId, 'Left the company')).resolves.toMatchObject({ status: 'SUSPENDED' });
    await expect(service.disable(superAdmin, temp.userId, 'Again')).resolves.toMatchObject({ status: 'SUSPENDED' });
    const [{ open }] = await ds.query(`SELECT count(*)::int AS "open" FROM "auth_sessions" WHERE "credentialId" = $1 AND "revokedAt" IS NULL`, [temp.userId]);
    expect(open).toBe(0);
    await expect(service.enable(superAdmin, temp.userId, 'Came back')).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(await actions(temp.userId)).toEqual(['staff.accept', 'staff.disable', 'staff.enable']);
  });

  it('lists staff with their permissions, never secret fields', async () => {
    const staff = await service.list();
    expect(staff.find((member) => member.email === 'root@example.test')?.permissions).toEqual([...STAFF_PERMISSIONS].sort());
    expect(Object.keys(staff[0]).sort()).toEqual(['createdAt', 'email', 'id', 'lastLoginAt', 'permissions', 'status']);
  });
});
