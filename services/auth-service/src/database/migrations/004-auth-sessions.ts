import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Refresh sessions (#34): one row per sign-in, rotated in place on every refresh. Deleting a
 * credential (the registration rollback) deletes its sessions.
 */
export class AuthSessions1700000000003 implements MigrationInterface {
  name = 'AuthSessions1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "auth_sessions" (
        "id" uuid NOT NULL,
        "credentialId" uuid NOT NULL,
        "refreshTokenHash" character varying(64) NOT NULL,
        "previousTokenHash" character varying(64),
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "revokedAt" TIMESTAMPTZ,
        "revokedReason" character varying(40),
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "lastUsedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "userAgent" character varying(255),
        "appId" character varying(20),
        CONSTRAINT "PK_auth_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_auth_sessions_credential" FOREIGN KEY ("credentialId") REFERENCES "credentials" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_auth_sessions_app" CHECK ("appId" IS NULL OR "appId" IN ('customer', 'driver', 'restaurant', 'admin'))
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_auth_sessions_credential" ON "auth_sessions" ("credentialId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_auth_sessions_expires" ON "auth_sessions" ("expiresAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "auth_sessions"`);
  }
}
