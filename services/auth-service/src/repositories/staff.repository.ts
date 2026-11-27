import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { StaffPermission as Permission, UserRole } from '@food-delivery/shared';
import { Credential } from '../entities/credential.entity';
import { StaffInvitation } from '../entities/staff-invitation.entity';

/** One staff member as the staff tools show it (#216): never hashes, tokens or lockout counters. */
export interface StaffMember {
  id: string;
  email: string;
  status: Credential['status'];
  permissions: Permission[];
  lastLoginAt: Date | null;
  createdAt: Date;
}

/** Serializes the "last super admin" checks: one staff change at a time. */
const STAFF_LOCK = 'staff-accounts';

@Injectable()
export class StaffRepository {
  constructor(
    @InjectRepository(Credential) private readonly credentials: Repository<Credential>,
    @InjectRepository(StaffInvitation) private readonly invitations: Repository<StaffInvitation>,
  ) {}

  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.credentials.manager.transaction(work);
  }

  /** Taken first in every staff change, so two changes can't both pass a "not the last one" check. */
  async lock(manager: EntityManager): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [STAFF_LOCK]);
  }

  async list(): Promise<StaffMember[]> {
    const rows: (StaffMember & { permissions: Permission[] | null })[] = await this.credentials.query(
      `SELECT c."id", c."email", c."status", c."lastLoginAt", c."createdAt",
              COALESCE(array_agg(p."permission" ORDER BY p."permission") FILTER (WHERE p."permission" IS NOT NULL), '{}') AS "permissions"
         FROM "credentials" c
         LEFT JOIN "staff_permissions" p ON p."credentialId" = c."id"
        WHERE c."role" = $1
        GROUP BY c."id"
        ORDER BY c."createdAt" ASC`,
      [UserRole.ADMIN],
    );
    return rows.map((row) => ({ ...row, permissions: row.permissions ?? [] }));
  }

  async find(manager: EntityManager, id: string): Promise<StaffMember | null> {
    const credential = await manager.findOne(Credential, { where: { id, role: UserRole.ADMIN } });
    if (!credential) return null;
    return { id, email: credential.email, status: credential.status, permissions: await this.permissions(manager, id), lastLoginAt: credential.lastLoginAt, createdAt: credential.createdAt };
  }

  async permissions(manager: EntityManager, id: string): Promise<Permission[]> {
    const rows: { permission: Permission }[] = await manager.query(`SELECT "permission" FROM "staff_permissions" WHERE "credentialId" = $1 ORDER BY "permission"`, [id]);
    return rows.map((row) => row.permission);
  }

  /** Replaces a staff member's permissions. */
  async setPermissions(manager: EntityManager, id: string, permissions: readonly Permission[]): Promise<void> {
    await manager.query(`DELETE FROM "staff_permissions" WHERE "credentialId" = $1`, [id]);
    for (const permission of [...new Set(permissions)].sort()) {
      await manager.query(`INSERT INTO "staff_permissions" ("credentialId", "permission") VALUES ($1, $2)`, [id, permission]);
    }
  }

  /** ACTIVE staff holding `staff.manage`, the ones who can manage the others ("super admins"). */
  async activeManagers(manager: EntityManager): Promise<string[]> {
    const rows: { id: string }[] = await manager.query(
      `SELECT c."id" FROM "credentials" c JOIN "staff_permissions" p ON p."credentialId" = c."id"
        WHERE c."role" = $1 AND c."status" = 'ACTIVE' AND p."permission" = 'staff.manage'`,
      [UserRole.ADMIN],
    );
    return rows.map((row) => row.id);
  }

  async emailTaken(manager: EntityManager, email: string): Promise<boolean> {
    const [row] = await manager.query(`SELECT 1 FROM "credentials" WHERE lower("email") = lower($1)`, [email]);
    return !!row;
  }

  /** A new invitation replaces any pending one to the same email. */
  async createInvitation(manager: EntityManager, data: Pick<StaffInvitation, 'email' | 'permissions' | 'tokenHash' | 'invitedBy' | 'expiresAt'>): Promise<StaffInvitation> {
    await manager.query(`UPDATE "staff_invitations" SET "revokedAt" = now() WHERE lower("email") = lower($1) AND "acceptedAt" IS NULL AND "revokedAt" IS NULL`, [data.email]);
    return manager.save(manager.create(StaffInvitation, { ...data, acceptedAt: null, acceptedCredentialId: null, revokedAt: null }));
  }

  /** Consumes a live invitation (compare-and-set): null when unknown, used, revoked or expired. */
  async consumeInvitation(manager: EntityManager, tokenHash: string, now: Date): Promise<StaffInvitation | null> {
    const [rows]: [StaffInvitation[], number] = await manager.query(
      `UPDATE "staff_invitations" SET "acceptedAt" = $2
        WHERE "tokenHash" = $1 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL AND "expiresAt" > $2
       RETURNING *`,
      [tokenHash, now],
    );
    return rows[0] ?? null;
  }

  async recordAcceptance(manager: EntityManager, invitationId: string, credentialId: string): Promise<void> {
    await manager.query(`UPDATE "staff_invitations" SET "acceptedCredentialId" = $2 WHERE "id" = $1`, [invitationId, credentialId]);
  }

  async createStaffCredential(manager: EntityManager, email: string, passwordHash: string): Promise<string> {
    const [row] = await manager.query(
      `INSERT INTO "credentials" ("email", "passwordHash", "role", "emailVerified", "status") VALUES ($1, $2, $3, true, 'ACTIVE') RETURNING "id"`,
      [email, passwordHash, UserRole.ADMIN],
    );
    return row.id as string;
  }

  /** Disable or enable (compare-and-set on the status). False when it already had that status. */
  async setStatus(manager: EntityManager, id: string, status: 'ACTIVE' | 'SUSPENDED', reason: string | null): Promise<boolean> {
    const result = await manager.update(
      Credential,
      { id, role: UserRole.ADMIN, status: status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED' },
      status === 'SUSPENDED' ? { status, suspendedAt: new Date(), suspendedReason: reason } : { status, suspendedAt: null, suspendedReason: null },
    );
    return (result.affected ?? 0) > 0;
  }
}
