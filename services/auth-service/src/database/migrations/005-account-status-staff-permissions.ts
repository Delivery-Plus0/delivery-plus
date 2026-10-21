import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #202: an account can be suspended, and staff (role ADMIN) hold explicit permissions.
 * Existing accounts are ACTIVE. The permission list matches STAFF_PERMISSIONS in `shared`.
 */
export class AccountStatusStaffPermissions1700000000004 implements MigrationInterface {
  name = 'AccountStatusStaffPermissions1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credentials"
      ADD COLUMN IF NOT EXISTS "status" character varying(20) NOT NULL DEFAULT 'ACTIVE',
      ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS "suspendedReason" character varying(300)
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "credentials" ADD CONSTRAINT "CHK_credentials_status" CHECK ("status" IN ('ACTIVE', 'SUSPENDED'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "staff_permissions" (
        "credentialId" uuid NOT NULL,
        "permission" character varying(40) NOT NULL,
        "grantedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_staff_permissions" PRIMARY KEY ("credentialId", "permission"),
        CONSTRAINT "FK_staff_permissions_credential" FOREIGN KEY ("credentialId") REFERENCES "credentials" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_staff_permissions_permission" CHECK ("permission" IN (
          'support.read', 'support.act', 'ops.read', 'ops.act', 'finance.read', 'finance.act',
          'onboarding.review', 'users.manage', 'staff.manage', 'audit.read'
        ))
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "staff_permissions"`);
    await queryRunner.query(`ALTER TABLE "credentials" DROP CONSTRAINT IF EXISTS "CHK_credentials_status"`);
    await queryRunner.query(`
      ALTER TABLE "credentials"
      DROP COLUMN IF EXISTS "suspendedReason",
      DROP COLUMN IF EXISTS "suspendedAt",
      DROP COLUMN IF EXISTS "status"
    `);
  }
}
