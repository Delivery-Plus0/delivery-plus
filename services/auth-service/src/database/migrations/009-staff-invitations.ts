import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #216: staff invitations. Only the SHA-256 of the single-use token is stored; an invitation is
 * accepted once, before it expires (48 h), unless it was revoked by a newer invitation to the same
 * email. At most one invitation per email is pending.
 */
export class StaffInvitations1700000000008 implements MigrationInterface {
  name = 'StaffInvitations1700000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "staff_invitations" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "email" varchar(320) NOT NULL,
        "permissions" varchar(40)[] NOT NULL,
        "tokenHash" char(64) NOT NULL UNIQUE,
        "invitedBy" uuid NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "acceptedAt" timestamptz,
        "acceptedCredentialId" uuid,
        "revokedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_staff_invitations_pending_email" ON "staff_invitations" (lower("email")) WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "staff_invitations"`);
  }
}
