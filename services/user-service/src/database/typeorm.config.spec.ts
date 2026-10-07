import { join } from 'node:path';
import { QueryRunner } from 'typeorm';
import { UserProfile } from '../entities/user-profile.entity';
import defaultDataSource from './data-source';
import { InitialSchema1700000000000 } from './migrations/001-initial-schema';
import { ProfileOwnershipMetadata1700000000001 } from './migrations/002-profile-ownership-metadata';
import { buildTypeOrmConfig } from './typeorm.config';

const AppDataSource = defaultDataSource;

const databaseUrl = 'postgres://db.example.test:5432/user';

describe('buildTypeOrmConfig', () => {
  it('builds a production-safe PostgreSQL configuration', () => {
    const config = buildTypeOrmConfig(databaseUrl, [UserProfile]);
    expect(config).toMatchObject({
      type: 'postgres',
      url: databaseUrl,
      entities: [UserProfile],
      synchronize: false,
      migrationsRun: false,
      logging: false,
    });
    expect(config.migrations).toEqual([
      join(__dirname, 'migrations', '*.ts'),
      join(__dirname, 'migrations', '*.js'),
    ]);
  });

  it('preserves entity globs and merges optional data-source settings', () => {
    const entities = ['dist/entities/*.js'];
    const config = buildTypeOrmConfig(databaseUrl, entities, {
      migrationsTableName: 'service_migrations',
      ssl: true,
    });
    expect(config.entities).toBe(entities);
    expect(config).toMatchObject({
      migrationsTableName: 'service_migrations',
      ssl: true,
      synchronize: false,
      migrationsRun: false,
    });
  });
});

describe('AppDataSource', () => {
  it('exposes exactly one default DataSource export for the migration CLI', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(Object.keys(require('./data-source')).sort()).toEqual(['default']);
  });

  it('wires the service entity without connecting or enabling implicit schema changes', () => {
    const entities = AppDataSource.options.entities as Array<{ name?: string }>;
    expect(defaultDataSource).toBe(AppDataSource);
    expect(entities.map((entity) => entity.name)).toEqual(['UserProfile', 'PhoneVerification']);
    expect(AppDataSource.options.synchronize).toBe(false);
    expect(AppDataSource.options.migrationsRun).toBe(false);
    expect(AppDataSource.isInitialized).toBe(false);
  });
});

describe('InitialSchema1700000000000', () => {
  it('executes reversible migration probes through the supplied query runner', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const queryRunner = { query } as unknown as QueryRunner;
    const migration = new InitialSchema1700000000000();
    await migration.up(queryRunner);
    await migration.down(queryRunner);
    expect(migration.name).toBe('InitialSchema1700000000000');
    expect(query.mock.calls.length).toBeGreaterThan(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('CREATE TABLE'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DROP TABLE IF EXISTS'))).toBe(true);
  });
});

describe('ProfileOwnershipMetadata1700000000001', () => {
  it('adds reversible credential mapping and ownership columns', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const queryRunner = { query } as unknown as QueryRunner;
    const migration = new ProfileOwnershipMetadata1700000000001();
    await migration.up(queryRunner);
    await migration.down(queryRunner);
    expect(migration.name).toBe('ProfileOwnershipMetadata1700000000001');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('authCredentialId'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('createdByService'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DROP COLUMN'))).toBe(true);
  });
});
