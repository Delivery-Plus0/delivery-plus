/**
 * The first-admin bootstrap (#202) against a real PostgreSQL: the "only once" rule is a transaction
 * with an advisory lock, which only a real database can prove under concurrency.
 *
 * Opt-in with AUTH_TEST_DATABASE_URL (a DISPOSABLE database; the schema is dropped). See
 * sessions.repository.integration.spec.ts for how to create one.
 */
import 'reflect-metadata';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { STAFF_PERMISSIONS } from '@food-delivery/shared';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { Credential } from '../entities/credential.entity';
import { AuthSession } from '../entities/auth-session.entity';
import { StaffPermission } from '../entities/staff-permission.entity';
import { InitialSchema1700000000000 } from '../database/migrations/001-initial-schema';
import { UuidPrimaryKeyDefaults1700000000001 } from '../database/migrations/002-uuid-primary-key-defaults';
import { AuthSecurityFields1700000000002 } from '../database/migrations/003-auth-security-fields';
import { AuthSessions1700000000003 } from '../database/migrations/004-auth-sessions';
import { AccountStatusStaffPermissions1700000000004 } from '../database/migrations/005-account-status-staff-permissions';
import { BootstrapRefusedError, bootstrapAdmin } from './bootstrap-admin';
import { main } from './cli';

const DATABASE_URL = process.env.AUTH_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;
const PASSWORD = 'correct-horse-battery';

describeDb('bootstrapAdmin (PostgreSQL integration, #202)', () => {
  jest.setTimeout(30_000);
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource(
      buildTypeOrmConfig(DATABASE_URL as string, [Credential, AuthSession, StaffPermission], {
        migrations: [
          InitialSchema1700000000000,
          UuidPrimaryKeyDefaults1700000000001,
          AuthSecurityFields1700000000002,
          AuthSessions1700000000003,
          AccountStatusStaffPermissions1700000000004,
        ],
        poolSize: 10,
      }),
    );
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
  });

  it('creates one verified, active super admin with every permission, storing only a hash', async () => {
    const admin = await bootstrapAdmin(ds, { email: 'ops@example.com', password: PASSWORD });

    const [row] = await ds.query(`SELECT * FROM "credentials" WHERE id = $1`, [admin.userId]);
    expect(row).toMatchObject({ email: 'ops@example.com', role: 'ADMIN', emailVerified: true, status: 'ACTIVE' });
    expect(JSON.stringify(row)).not.toContain(PASSWORD);
    await expect(bcrypt.compare(PASSWORD, row.passwordHash)).resolves.toBe(true);

    const permissions = (await ds.query(`SELECT permission FROM "staff_permissions" WHERE "credentialId" = $1`, [admin.userId])).map((r: { permission: string }) => r.permission);
    expect(permissions.sort()).toEqual([...STAFF_PERMISSIONS].sort());
  });

  it('refuses a second run once any admin exists', async () => {
    await bootstrapAdmin(ds, { email: 'ops@example.com', password: PASSWORD });

    await expect(bootstrapAdmin(ds, { email: 'other@example.com', password: PASSWORD })).rejects.toThrow(/Staff already exist/);
    expect((await ds.query(`SELECT count(*)::int AS n FROM "credentials" WHERE role = 'ADMIN'`))[0].n).toBe(1);
  });

  it('creates exactly one admin when several bootstraps run at the same time', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => bootstrapAdmin(ds, { email: `ops${i}@example.com`, password: PASSWORD })),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof BootstrapRefusedError)).toHaveLength(4);
    expect((await ds.query(`SELECT count(*)::int AS n FROM "credentials" WHERE role = 'ADMIN'`))[0].n).toBe(1);
  });

  it('refuses a password under 12 characters, a bad email and an email that already has an account', async () => {
    await expect(bootstrapAdmin(ds, { email: 'ops@example.com', password: 'elevenchars' })).rejects.toThrow('at least 12 characters');
    await expect(bootstrapAdmin(ds, { email: 'not-an-email', password: PASSWORD })).rejects.toThrow('valid email');
    await ds.query(`INSERT INTO "credentials" ("email", "passwordHash") VALUES ('taken@example.com', 'x')`);
    await expect(bootstrapAdmin(ds, { email: 'taken@example.com', password: PASSWORD })).rejects.toThrow('already belongs');
    expect((await ds.query(`SELECT count(*)::int AS n FROM "credentials" WHERE role = 'ADMIN'`))[0].n).toBe(0);
  });

  it('the CLI never prints the password, exits 0 once and 1 on the second run', async () => {
    const out: string[] = [];
    const log = jest.spyOn(console, 'log').mockImplementation((...args) => void out.push(args.join(' ')));
    const err = jest.spyOn(console, 'error').mockImplementation((...args) => void out.push(args.join(' ')));
    try {
      const env = { DATABASE_URL, BOOTSTRAP_ADMIN_EMAIL: 'ops@example.com', BOOTSTRAP_ADMIN_PASSWORD: PASSWORD } as NodeJS.ProcessEnv;
      await expect(main(env)).resolves.toBe(0);
      await expect(main(env)).resolves.toBe(1);
      await expect(main({ ...env, BOOTSTRAP_ADMIN_PASSWORD: 'short' })).resolves.toBe(1);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
    expect(out.join('\n')).toMatch(/Created the first super admin ops@example.com/);
    expect(out.join('\n')).toMatch(/Refused: Staff already exist/);
    expect(out.join('\n')).not.toContain(PASSWORD);
  });
});
