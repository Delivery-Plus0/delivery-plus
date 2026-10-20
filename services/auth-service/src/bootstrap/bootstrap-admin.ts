import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { STAFF_PERMISSIONS, UserRole } from '@food-delivery/shared';

/** #202 (moved from #234): the first super admin, created out of band, never through the API. */
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/** A fixed key for pg_advisory_xact_lock, so two bootstraps at once can't both create an admin. */
const BOOTSTRAP_LOCK_KEY = 2_024_202;

export class BootstrapRefusedError extends Error {}

export interface BootstrapAdminInput {
  email: string;
  password: string;
}

export interface BootstrapAdminResult {
  userId: string;
  email: string;
  permissions: string[];
}

/**
 * Creates the first super admin: role ADMIN, email verified, every staff permission.
 *
 * Runs only when no ADMIN exists. Everything happens in one transaction holding an advisory lock, so a
 * second run (or two at once) refuses instead of creating another admin. The password is only ever
 * hashed: it is never logged, printed or returned.
 */
export async function bootstrapAdmin(dataSource: DataSource, input: BootstrapAdminInput): Promise<BootstrapAdminResult> {
  const email = input.email?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BootstrapRefusedError('Give a valid email address for the admin');
  }
  if (!input.password || input.password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new BootstrapRefusedError(`The admin password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`);
  }
  const passwordHash = await bcrypt.hash(input.password, 12);

  return dataSource.transaction(async (manager) => {
    await manager.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);

    const [{ count }] = await manager.query(`SELECT count(*)::int AS count FROM "credentials" WHERE "role" = $1`, [UserRole.ADMIN]);
    if (count > 0) {
      throw new BootstrapRefusedError('Staff already exist: the first admin was created before, so bootstrap refuses to run again');
    }
    const [taken] = await manager.query(`SELECT 1 FROM "credentials" WHERE "email" = $1`, [email]);
    if (taken) {
      throw new BootstrapRefusedError('That email already belongs to an account; use a dedicated staff address');
    }

    const [created] = await manager.query(
      `INSERT INTO "credentials" ("email", "passwordHash", "role", "emailVerified", "status")
       VALUES ($1, $2, $3, true, 'ACTIVE') RETURNING "id"`,
      [email, passwordHash, UserRole.ADMIN],
    );
    for (const permission of STAFF_PERMISSIONS) {
      await manager.query(`INSERT INTO "staff_permissions" ("credentialId", "permission") VALUES ($1, $2)`, [created.id, permission]);
    }
    return { userId: created.id as string, email, permissions: [...STAFF_PERMISSIONS] };
  });
}
