/* eslint-disable no-console */
/**
 * Creates the first super admin (#202). See docs/runbooks/bootstrap-admin.md.
 *
 *   BOOTSTRAP_ADMIN_EMAIL=ops@example.com DATABASE_URL=postgres://… node dist/bootstrap/cli.js
 *
 * The password comes from BOOTSTRAP_ADMIN_PASSWORD or, when that is unset and a terminal is
 * attached, from a prompt that does not echo. It is never printed or logged.
 */
import 'reflect-metadata';
import { createInterface } from 'node:readline';
import { DataSource } from 'typeorm';
import { buildTypeOrmConfig } from '../database/typeorm.config';
import { Credential } from '../entities/credential.entity';
import { AuthSession } from '../entities/auth-session.entity';
import { StaffPermission } from '../entities/staff-permission.entity';
import { BootstrapRefusedError, bootstrapAdmin } from './bootstrap-admin';

/** Reads a line from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = rl as unknown as { _writeToOutput: (text: string) => void };
    let asked = false;
    output._writeToOutput = (text: string) => {
      if (!asked) {
        process.stdout.write(text);
        asked = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const databaseUrl = env.DATABASE_URL;
  const email = env.BOOTSTRAP_ADMIN_EMAIL;
  if (!databaseUrl || !email) {
    console.error('Set DATABASE_URL (auth-service database) and BOOTSTRAP_ADMIN_EMAIL.');
    return 2;
  }
  let password = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!password) {
    if (!process.stdin.isTTY) {
      console.error('Set BOOTSTRAP_ADMIN_PASSWORD, or run in a terminal to be prompted.');
      return 2;
    }
    password = await promptHidden(`Password for ${email} (not shown): `);
  }

  const dataSource = new DataSource(buildTypeOrmConfig(databaseUrl, [Credential, AuthSession, StaffPermission]));
  await dataSource.initialize();
  try {
    const admin = await bootstrapAdmin(dataSource, { email, password });
    console.log(`Created the first super admin ${admin.email} (${admin.userId}) with ${admin.permissions.length} permissions.`);
    return 0;
  } catch (error) {
    if (error instanceof BootstrapRefusedError) {
      console.error(`Refused: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await dataSource.destroy();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      // The message only: a driver error can echo query parameters, and one of them is the hash.
      console.error('Bootstrap failed:', error instanceof Error ? error.message.split('\n')[0] : 'unknown error');
      process.exit(1);
    });
}
