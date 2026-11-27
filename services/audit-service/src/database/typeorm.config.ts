import { Type } from '@nestjs/common';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { join } from 'node:path';
import { DataSourceOptions } from 'typeorm';
import { STRICT_WHERE_VALUES } from '@food-delivery/shared';

/**
 * Builds the TypeORM options shared by the Nest application and migration CLI.
 * Custom options are applied last and override the service defaults, except the strict `where`
 * rule (F8, #204), which every DataSource keeps: an `undefined` criterion throws instead of matching any row.
 */
export function buildTypeOrmConfig(
  databaseUrl: string,
  entities: Array<Type<unknown> | string>,
  options: Partial<DataSourceOptions> = {},
): TypeOrmModuleOptions & DataSourceOptions {
  return {
    type: 'postgres' as const,
    url: databaseUrl,
    entities,
    synchronize: false,
    migrationsRun: false,
    logging: false,
    migrations: [
      join(__dirname, 'migrations', '*.ts'),
      join(__dirname, 'migrations', '*.js'),
    ],
    ...options,
    invalidWhereValuesBehavior: STRICT_WHERE_VALUES,
  } as TypeOrmModuleOptions & DataSourceOptions;
}
