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
