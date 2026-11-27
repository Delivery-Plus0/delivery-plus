/**
 * Staff account actions (#215) against real PostgreSQL: the status compare-and-set, ending sessions
 * and the audit event in one transaction, and repeats that change and record nothing.
 *
 * Opt-in: AUTH_TEST_DATABASE_URL, a DISPOSABLE database; run with --runInBand.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { Credential } from '../entities/credential.entity';
import { AuthSession } from '../entities/auth-session.entity';
import { StaffPermission } from '../entities/staff-permission.entity';
import { CredentialsRepository } from '../repositories/credentials.repository';
import { SessionsRepository } from '../repositories/sessions.repository';
import { AdminAccountsService } from './admin-accounts.service';

const DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('AdminAccountsService (PostgreSQL integration, #215)', () => {
  jest.setTimeout(30_000);
  let ds: DataSource;
  let service: AdminAccountsService;
  let sessions: SessionsRepository;
  const actor = { id: randomUUID(), email: 'support@example.com' };

  beforeAll(async () => {
    ds = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [Credential, AuthSession, StaffPermission]));
    await ds.initialize();
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
    sessions = new SessionsRepository(ds.getRepository(AuthSession));
    service = new AdminAccountsService(new CredentialsRepository(ds.getRepository(Credential)), sessions, { kick: jest.fn() } as never);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  const person = async (role = 'CUSTOMER') => {
    const [row] = await ds.query(`INSERT INTO "credentials" ("email", "passwordHash", "role") VALUES ($1, 'x', $2) RETURNING "id"`, [`${randomUUID()}@example.com`, role]);
    for (let i = 0; i < 2; i++) {
      await sessions.create({ id: randomUUID(), credentialId: row.id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 86_400_000), userAgent: null, appId: 'customer' } as never);
    }
    return row.id as string;
  };
  const actions = async (id: string) =>
    (await ds.query(`SELECT "payload"->'payload'->>'action' AS "action" FROM "outbox_events" WHERE "payload"->'payload'->>'targetId' = $1 ORDER BY "id"`, [id])).map(
      (row: { action: string }) => row.action,
    );
  const openSessions = async (id: string) => Number((await ds.query(`SELECT count(*) FROM "auth_sessions" WHERE "credentialId" = $1 AND "revokedAt" IS NULL`, [id]))[0].count);

  it('suspends once, ending the sessions with one audit event, and a repeat is a no-op', async () => {
    const id = await person();
    await expect(service.suspend(actor, id, 'Chargeback fraud')).resolves.toEqual({ userId: id, status: 'SUSPENDED', sessionsRevoked: 2, changed: true });
    expect(await openSessions(id)).toBe(0);
    await expect(service.suspend(actor, id, 'Chargeback fraud')).resolves.toMatchObject({ status: 'SUSPENDED', changed: false });
    expect(await actions(id)).toEqual(['user.suspend']);
    const [{ suspendedReason }] = await ds.query(`SELECT "suspendedReason" FROM "credentials" WHERE "id" = $1`, [id]);
    expect(suspendedReason).toBe('Chargeback fraud');
  });

  it('reactivates once, with a notice for the person', async () => {
    const id = await person();
    await service.suspend(actor, id, 'Chargeback fraud');
    await expect(service.reactivate(actor, id, 'Bank confirmed the payment')).resolves.toMatchObject({ status: 'ACTIVE', changed: true });
    await expect(service.reactivate(actor, id, 'Again')).resolves.toMatchObject({ changed: false });
    expect(await actions(id)).toEqual(['user.suspend', 'user.reactivate']);
    const [{ notify }] = await ds.query(`SELECT "payload"->'payload'->'notify' AS "notify" FROM "outbox_events" WHERE "payload"->'payload'->>'action' = 'user.reactivate' AND "payload"->'payload'->>'targetId' = $1`, [id]);
    expect(notify).toEqual({ userId: id, messageKey: 'account.reactivated' });
  });

  it('signs out everywhere, and with no session left it records nothing', async () => {
    const id = await person();
    await expect(service.revokeSessions(actor, id, 'Lost phone')).resolves.toMatchObject({ sessionsRevoked: 2, changed: true });
    await expect(service.revokeSessions(actor, id, 'Lost phone')).resolves.toMatchObject({ sessionsRevoked: 0, changed: false });
    expect(await actions(id)).toEqual(['user.revoke_sessions']);
  });

  it("refuses staff accounts, the actor's own account and unknown ids", async () => {
    const staff = await person('ADMIN');
    await expect(service.suspend(actor, staff, 'x-reason')).rejects.toThrow('staff tools');
    await expect(service.suspend({ id: staff }, staff, 'x-reason')).rejects.toThrow('your own account');
    await expect(service.suspend(actor, randomUUID(), 'x-reason')).rejects.toThrow('not found');
  });
});
