/**
 * The staff people directory's profile queries (#214) against real PostgreSQL: the name-prefix match
 * (with LIKE wildcards in the input taken literally), the phone-verified filter, and the exact
 * phone/email search. The real migrations build the schema.
 *
 * Opt-in: set USER_TEST_DATABASE_URL to a DISPOSABLE database (the public schema is dropped and
 * recreated). Without it the suite is skipped so `npm test` works without Postgres.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { UserProfile } from '../entities/user-profile.entity';
import { PhoneVerification } from '../entities/phone-verification.entity';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { ProfilesRepository } from './profiles.repository';

const DATABASE_URL = process.env.USER_TEST_DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('ProfilesRepository staff directory (PostgreSQL integration, #214)', () => {
  jest.setTimeout(30_000);
  let ds: DataSource;
  let repo: ProfilesRepository;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ds = new DataSource(buildTypeOrmConfig(DATABASE_URL as string, [UserProfile, PhoneVerification]));
    await ds.initialize();
    await ds.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await ds.runMigrations();
    repo = new ProfilesRepository(ds.getRepository(UserProfile));
    const add = async (key: string, fullName: string, email: string, phone: string | null, verified: boolean, created: string) => {
      ids[key] = randomUUID();
      await ds.query(
        `INSERT INTO "user_profiles" ("id", "authCredentialId", "createdByService", "email", "fullName", "phone", "phoneVerifiedAt", "createdAt")
         VALUES ($1, $1, 'auth-service', $2, $3, $4, $5, $6)`,
        [ids[key], email, fullName, phone, verified ? created : null, created],
      );
    };
    await add('ahmed', 'Ahmed Hassan', 'ahmed@example.com', '+201011111111', true, '2026-11-01T00:00:00Z');
    await add('mona', 'Mona Ahmed', 'Mona@Example.com', '+201022222222', false, '2026-11-02T00:00:00Z');
    await add('percent', '100% Real', 'p@example.com', null, false, '2026-11-03T00:00:00Z');
    await add('sara', 'Sara Ali', 'sara@example.com', '+201033333333', true, '2026-11-04T00:00:00Z');
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('matches the start of the name or of a later word, case-insensitively, newest first', async () => {
    const [rows, total] = await repo.pageForAdmin({ namePrefix: 'ahm' }, 1, 20);
    expect(total).toBe(2);
    expect(rows.map((r) => r.fullName)).toEqual(['Mona Ahmed', 'Ahmed Hassan']);
    expect((await repo.pageForAdmin({ namePrefix: 'hass' }, 1, 20))[1]).toBe(1);
    expect((await repo.pageForAdmin({ namePrefix: 'ssan' }, 1, 20))[1]).toBe(0); // not a substring search
  });

  it('takes LIKE wildcards in the input literally', async () => {
    expect((await repo.pageForAdmin({ namePrefix: '%' }, 1, 20))[0].map((r) => r.fullName)).toEqual([]);
    expect((await repo.pageForAdmin({ namePrefix: '100%' }, 1, 20))[0].map((r) => r.fullName)).toEqual(['100% Real']);
    expect((await repo.pageForAdmin({ namePrefix: '_a' }, 1, 20))[1]).toBe(0);
  });

  it('filters by phone verification, and caps the id set at cap + 1', async () => {
    const [verified] = await repo.pageForAdmin({ phoneVerified: true }, 1, 20);
    expect(verified.map((r) => r.fullName)).toEqual(['Sara Ali', 'Ahmed Hassan']);
    const [unverified] = await repo.pageForAdmin({ phoneVerified: false }, 1, 20);
    expect(unverified.map((r) => r.fullName)).toEqual(['100% Real', 'Mona Ahmed']);
    expect(await repo.idsForAdmin({}, 2)).toHaveLength(3);
    expect(await repo.idsForAdmin({ namePrefix: 'sara' }, 2)).toEqual([ids.sara]);
  });

  it('finds by an exact E.164 phone, verified or not, and by an email in any case', async () => {
    expect((await repo.findForAdminSearch({ phone: '+201022222222' })).map((r) => r.id)).toEqual([ids.mona]);
    expect(await repo.findForAdminSearch({ phone: '+2010222' })).toEqual([]); // no prefix search
    expect((await repo.findForAdminSearch({ email: 'mona@example.com' })).map((r) => r.id)).toEqual([ids.mona]);
    expect(await repo.findForAdminSearch({})).toEqual([]);
  });
});
