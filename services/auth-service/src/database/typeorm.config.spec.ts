import { join } from 'node:path';
import { QueryRunner } from 'typeorm';
import { Credential } from '../entities/credential.entity';
import defaultDataSource from './data-source';
import { InitialSchema1700000000000 } from './migrations/001-initial-schema';
import { buildTypeOrmConfig } from './typeorm.config';

const AppDataSource = defaultDataSource;

const databaseUrl = 'postgres://db.example.test:5432/auth';

describe('buildTypeOrmConfig', () => {
  it('makes an undefined where value throw, and keeps it whatever options are passed (F8, #204)', () => {
    expect(buildTypeOrmConfig(databaseUrl, []).invalidWhereValuesBehavior).toEqual({ undefined: 'throw' });
    expect(buildTypeOrmConfig(databaseUrl, [], { invalidWhereValuesBehavior: { undefined: 'ignore' } }).invalidWhereValuesBehavior).toEqual({
      undefined: 'throw',
    });
  });

  it('builds a production-safe PostgreSQL configuration', () => {
    const config = buildTypeOrmConfig(databaseUrl, [Credential]);

    expect(config).toMatchObject({
      type: 'postgres',
      url: databaseUrl,
      entities: [Credential],
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
    expect(entities.map((entity) => entity.name)).toEqual(['Credential', 'AuthSession', 'StaffPermission']);
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
