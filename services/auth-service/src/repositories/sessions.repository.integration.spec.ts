/**
 * Integration tests for refresh sessions (#34) against a real PostgreSQL: the schema comes from the
 * real migrations, and rotation and revocation are conditional UPDATEs, which only a real database
 * can prove under concurrency.
 *
 * Opt-in: set AUTH_TEST_DATABASE_URL to a DISPOSABLE database (the public schema is dropped and
 * recreated). Without it the suite is skipped so `npm test` works without Postgres. Example:
 *
 *   docker compose exec postgres psql -U postgres -c 'CREATE DATABASE auth_service_test'
 *   AUTH_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/auth_service_test \
 *     npm test -w services/auth-service -- --runInBand
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Credential } from '../entities/credential.entity';
import { AuthSession } from '../entities/auth-session.entity';
import { SessionsRepository } from './sessions.repository';
import { SessionsService } from '../services/sessions.service';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { AppConfig } from '../config/app-config';
import { InitialSchema1700000000000 } from '../database/migrations/001-initial-schema';
import { UuidPrimaryKeyDefaults1700000000001 } from '../database/migrations/002-uuid-primary-key-defaults';
import { AuthSecurityFields1700000000002 } from '../database/migrations/003-auth-security-fields';
import { AuthSessions1700000000003 } from '../database/migrations/004-auth-sessions';
import { AccountStatusStaffPermissions1700000000004 } from '../database/migrations/005-account-status-staff-permissions';
import { EmailVerificationCodes1700000000005 } from '../database/migrations/006-email-verification-codes';
import { StaffPermission } from '../entities/staff-permission.entity';

const DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('SessionsRepository (PostgreSQL integration, #34)', () => {
  jest.setTimeout(30_000);

  let ds: DataSource;
  let repo: SessionsRepository;
  let sessions: SessionsService;
  let credentialId: string;

  beforeAll(async () => {
    ds = new DataSource(
      buildTypeOrmConfig(DATABASE_URL as string, [Credential, AuthSession, StaffPermission], {
        migrations: [InitialSchema1700000000000, UuidPrimaryKeyDefaults1700000000001, AuthSecurityFields1700000000002, AuthSessions1700000000003, AccountStatusStaffPermissions1700000000004, EmailVerificationCodes1700000000005],
        poolSize: 10,
      }),
    );
    await ds.initialize();
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
    repo = new SessionsRepository(ds.getRepository(AuthSession));
    sessions = new SessionsService(repo, { refreshTokenTtlDays: 30, sessionRetentionDays: 30 } as AppConfig);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    const [row] = await ds.query(`INSERT INTO "credentials" ("email", "passwordHash") VALUES ($1, 'x') RETURNING "id"`, [`${randomUUID()}@example.com`]);
    credentialId = row.id;
  });

  const row = (id: string) => repo.findById(id);

  it('lets exactly one of many concurrent rotations with the same token win', async () => {
    const { session, refreshToken } = await sessions.start(credentialId);

    const results = await Promise.allSettled(Array.from({ length: 8 }, () => sessions.rotate(refreshToken)));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // The losers presented the token the winner replaced: that is reuse, so the family is revoked.
    expect(await row(session.id)).toMatchObject({ revokedReason: 'reuse_detected', revokedAt: expect.any(Date) });
  });

  it('rotate is a compare-and-set: concurrent UPDATEs from the same token, exactly one applies', async () => {
    const { session } = await sessions.start(credentialId);
    const current = session.refreshTokenHash;
    const now = new Date();
    const later = new Date(now.getTime() + 86_400_000);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => repo.rotate(session.id, current, `${String(i).repeat(64)}`.slice(0, 64), now, later)),
    );

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(await row(session.id)).toMatchObject({ previousTokenHash: current, refreshTokenHash: winners[0]?.refreshTokenHash });
  });

  it('rotates in place, then revokes the family when the replaced token comes back', async () => {
    const first = await sessions.start(credentialId, { appId: 'customer', userAgent: 'CustomerApp' });
    const second = await sessions.rotate(first.refreshToken);
    const third = await sessions.rotate(second.refreshToken);

    expect(third.session.id).toBe(first.session.id);
    await expect(sessions.rotate(second.refreshToken)).rejects.toMatchObject({ error: 'InvalidRefreshToken' });
    await expect(sessions.rotate(third.refreshToken)).rejects.toMatchObject({ error: 'InvalidRefreshToken' });
    expect(await row(first.session.id)).toMatchObject({ revokedReason: 'reuse_detected', appId: 'customer', userAgent: 'CustomerApp' });
  });

  it('never rotates an expired or revoked session, even with the live token', async () => {
    const expired = await sessions.start(credentialId);
    await ds.query(`UPDATE "auth_sessions" SET "expiresAt" = now() - interval '1 second' WHERE id = $1`, [expired.session.id]);
    await expect(sessions.rotate(expired.refreshToken)).rejects.toMatchObject({ statusCode: 401 });

    const revoked = await sessions.start(credentialId);
    await repo.revoke(revoked.session.id, 'logout');
    await expect(sessions.rotate(revoked.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('revokes all of a user’s live sessions except one, keeps first reasons, and leaves other users alone', async () => {
    const keep = await sessions.start(credentialId);
    const loggedOut = await sessions.start(credentialId);
    await repo.revoke(loggedOut.session.id, 'logout');
    await sessions.start(credentialId);
    await sessions.start(credentialId);
    const [other] = await ds.query(`INSERT INTO "credentials" ("email", "passwordHash") VALUES ($1, 'x') RETURNING "id"`, [`${randomUUID()}@example.com`]);
    const otherSession = await sessions.start(other.id);

    await expect(repo.revokeAllForCredential(credentialId, 'password_changed', keep.session.id)).resolves.toBe(2);

    expect((await row(keep.session.id))?.revokedAt).toBeNull();
    expect((await row(loggedOut.session.id))?.revokedReason).toBe('logout');
    expect((await row(otherSession.session.id))?.revokedAt).toBeNull();
  });

  it('cleanup deletes sessions that ended before the cutoff and keeps the rest', async () => {
    const expiredLongAgo = await sessions.start(credentialId);
    const revokedLongAgo = await sessions.start(credentialId);
    const revokedRecently = await sessions.start(credentialId);
    const live = await sessions.start(credentialId);
    await ds.query(`UPDATE "auth_sessions" SET "expiresAt" = now() - interval '40 days' WHERE id = $1`, [expiredLongAgo.session.id]);
    await ds.query(`UPDATE "auth_sessions" SET "revokedAt" = now() - interval '40 days' WHERE id = $1`, [revokedLongAgo.session.id]);
    await ds.query(`UPDATE "auth_sessions" SET "revokedAt" = now() - interval '1 day' WHERE id = $1`, [revokedRecently.session.id]);

    await expect(sessions.deleteEnded()).resolves.toBe(2);

    expect(await row(expiredLongAgo.session.id)).toBeNull();
    expect(await row(revokedLongAgo.session.id)).toBeNull();
    expect(await row(revokedRecently.session.id)).not.toBeNull();
    expect(await row(live.session.id)).not.toBeNull();
  });

  it('stores hashes only, refuses an unknown app, and deletes sessions with their credential', async () => {
    const { session, refreshToken } = await sessions.start(credentialId);
    const [stored] = await ds.query(`SELECT * FROM "auth_sessions" WHERE id = $1`, [session.id]);
    expect(JSON.stringify(stored)).not.toContain(refreshToken.split('.')[1]);
    expect(stored.refreshTokenHash).toMatch(/^[0-9a-f]{64}$/);

    await expect(ds.query(`UPDATE "auth_sessions" SET "appId" = 'tv' WHERE id = $1`, [session.id])).rejects.toThrow(/CHK_auth_sessions_app/);

    await ds.query(`DELETE FROM "credentials" WHERE id = $1`, [credentialId]);
    expect(await row(session.id)).toBeNull();
  });
});
