import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #214: when an account last signed in, for the staff people directory, and an index for the
 * directory's filters (role and status, newest first). Additive; old rows stay NULL ("never").
 */
export class CredentialLastLogin1700000000007 implements MigrationInterface {
  name = 'CredentialLastLogin1700000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "lastLoginAt" timestamptz`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_credentials_role_status_created" ON "credentials" ("role", "status", "createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_credentials_role_status_created"`);
    await queryRunner.query(`ALTER TABLE "credentials" DROP COLUMN IF EXISTS "lastLoginAt"`);
  }
}
