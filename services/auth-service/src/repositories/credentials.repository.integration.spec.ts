/**
 * Email verification codes (#203) against a real PostgreSQL: a code works once under a race, and the
 * attempt that reaches the limit clears it. Opt-in with AUTH_TEST_DATABASE_URL (a DISPOSABLE database;
 * run with --runInBand, the auth Postgres specs share it).
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { Credential } from '../entities/credential.entity';
import { AuthSession } from '../entities/auth-session.entity';
import { StaffPermission } from '../entities/staff-permission.entity';
import { InitialSchema1700000000000 } from '../database/migrations/001-initial-schema';
import { UuidPrimaryKeyDefaults1700000000001 } from '../database/migrations/002-uuid-primary-key-defaults';
import { AuthSecurityFields1700000000002 } from '../database/migrations/003-auth-security-fields';
import { AuthSessions1700000000003 } from '../database/migrations/004-auth-sessions';
import { AccountStatusStaffPermissions1700000000004 } from '../database/migrations/005-account-status-staff-permissions';
import { EmailVerificationCodes1700000000005 } from '../database/migrations/006-email-verification-codes';
import { OutboxEvents1700000000006 } from '../database/migrations/007-outbox-events';
import { CredentialLastLogin1700000000007 } from '../database/migrations/008-credential-last-login';
import { CredentialsRepository } from './credentials.repository';

const DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('CredentialsRepository verification codes (PostgreSQL integration, #203)', () => {
  jest.setTimeout(30_000);
  let ds: DataSource;
  let repo: CredentialsRepository;
  let id: string;

  beforeAll(async () => {
    ds = new DataSource(
      buildTypeOrmConfig(DATABASE_URL as string, [Credential, AuthSession, StaffPermission], {
        migrations: [
          InitialSchema1700000000000,
          UuidPrimaryKeyDefaults1700000000001,
          AuthSecurityFields1700000000002,
          AuthSessions1700000000003,
          AccountStatusStaffPermissions1700000000004,
          EmailVerificationCodes1700000000005,
          OutboxEvents1700000000006,
          CredentialLastLogin1700000000007,
        ],
        poolSize: 10,
      }),
    );
    await ds.initialize();
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
    repo = new CredentialsRepository(ds.getRepository(Credential));
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    const [row] = await ds.query(`INSERT INTO "credentials" ("email", "passwordHash") VALUES ($1, 'x') RETURNING "id"`, [`${Date.now()}-${Math.random()}@example.com`]);
    id = row.id;
    await repo.setVerificationCode(id, 'a'.repeat(64), new Date(Date.now() + 600_000), new Date());
  });

  it('verifies with the live code exactly once when two requests race', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => repo.consumeVerificationCode(id, 'a'.repeat(64), new Date())));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repo.findById(id)).toMatchObject({ emailVerified: true, verificationTokenHash: null, verificationAttempts: 0 });
  });

  it('never verifies with an expired code', async () => {
    await expect(repo.consumeVerificationCode(id, 'a'.repeat(64), new Date(Date.now() + 700_000))).resolves.toBe(false);
    expect((await repo.findById(id))?.emailVerified).toBe(false);
  });

  it('clears the code on the 5th wrong attempt, even when the attempts arrive together', async () => {
    await Promise.all(Array.from({ length: 4 }, () => repo.recordWrongVerificationCode(id, 5)));
    expect(await repo.findById(id)).toMatchObject({ verificationAttempts: 4, verificationTokenHash: 'a'.repeat(64) });

    await Promise.all(Array.from({ length: 3 }, () => repo.recordWrongVerificationCode(id, 5)));

    const row = await repo.findById(id);
    expect(row).toMatchObject({ verificationAttempts: 5, verificationTokenHash: null, verificationTokenExpiresAt: null });
    await expect(repo.consumeVerificationCode(id, 'a'.repeat(64), new Date())).resolves.toBe(false);
  });

  it('a new code resets the attempts', async () => {
    await repo.recordWrongVerificationCode(id, 5);
    await repo.setVerificationCode(id, 'b'.repeat(64), new Date(Date.now() + 600_000), new Date());
    expect(await repo.findById(id)).toMatchObject({ verificationAttempts: 0, verificationTokenHash: 'b'.repeat(64), verificationSentAt: expect.any(Date) });
  });
});

describeDb('CredentialsRepository account directory (PostgreSQL integration, #214)', () => {
  jest.setTimeout(30_000);
  let ds: DataSource;
  let repo: CredentialsRepository;

  beforeAll(async () => {
    ds = new DataSource(
      buildTypeOrmConfig(DATABASE_URL as string, [Credential, AuthSession, StaffPermission], {
        migrations: [
          InitialSchema1700000000000,
          UuidPrimaryKeyDefaults1700000000001,
          AuthSecurityFields1700000000002,
          AuthSessions1700000000003,
          AccountStatusStaffPermissions1700000000004,
          EmailVerificationCodes1700000000005,
          OutboxEvents1700000000006,
          CredentialLastLogin1700000000007,
        ],
      }),
    );
    await ds.initialize();
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
    repo = new CredentialsRepository(ds.getRepository(Credential));
    const insert = (email: string, role: string, status: string, verified: boolean, created: string) =>
      ds.query(
        `INSERT INTO "credentials" ("email", "passwordHash", "role", "status", "emailVerified", "createdAt") VALUES ($1, 'secret-hash', $2, $3, $4, $5)`,
        [email, role, status, verified, created],
      );
    await insert('a@example.com', 'CUSTOMER', 'ACTIVE', true, '2026-11-01T10:00:00Z');
    await insert('b@example.com', 'CUSTOMER', 'SUSPENDED', true, '2026-11-02T10:00:00Z');
    await insert('c@example.com', 'DRIVER', 'ACTIVE', false, '2026-11-03T10:00:00Z');
    await insert('d@example.com', 'RESTAURANT_OWNER', 'ACTIVE', true, '2026-11-04T10:00:00Z');
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('filters by role, status, email verification and a half-open creation range, newest first', async () => {
    const [customers, total] = await repo.queryAccounts({ roles: ['CUSTOMER' as never], page: 1, limit: 20 });
    expect(total).toBe(2);
    expect(customers.map((a) => a.email)).toEqual(['b@example.com', 'a@example.com']);

    const [suspended] = await repo.queryAccounts({ status: 'SUSPENDED', page: 1, limit: 20 });
    expect(suspended.map((a) => a.email)).toEqual(['b@example.com']);

    const [unverified] = await repo.queryAccounts({ emailVerified: false, page: 1, limit: 20 });
    expect(unverified.map((a) => a.email)).toEqual(['c@example.com']);

    const [range] = await repo.queryAccounts({ createdFrom: new Date('2026-11-02T10:00:00Z'), createdTo: new Date('2026-11-04T10:00:00Z'), page: 1, limit: 20 });
    expect(range.map((a) => a.email)).toEqual(['c@example.com', 'b@example.com']);
  });

  it('narrows to the given ids, and an empty id set matches nothing', async () => {
    const [all] = await repo.queryAccounts({ page: 1, limit: 20 });
    const [one] = await repo.queryAccounts({ ids: [all[0].id], page: 1, limit: 20 });
    expect(one.map((a) => a.id)).toEqual([all[0].id]);
    expect(await repo.queryAccounts({ ids: [], page: 1, limit: 20 })).toEqual([[], 0]);
  });

  it('returns staff-safe fields only, and records the last sign-in', async () => {
    const [[first]] = await repo.queryAccounts({ page: 1, limit: 1 });
    expect(Object.keys(first).sort()).toEqual(['createdAt', 'email', 'emailVerified', 'id', 'lastLoginAt', 'role', 'status', 'suspendedAt', 'suspendedReason']);
    expect(JSON.stringify(first)).not.toContain('secret-hash');

    await repo.recordLogin(first.id, new Date('2026-11-27T08:00:00Z'));
    const [[again]] = await repo.queryAccounts({ ids: [first.id], page: 1, limit: 1 });
    expect(again.lastLoginAt?.toISOString()).toBe('2026-11-27T08:00:00.000Z');
  });
});

