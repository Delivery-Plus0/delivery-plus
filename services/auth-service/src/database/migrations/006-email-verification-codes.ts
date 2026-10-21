import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #203: email verification moves to 6-digit codes (HMAC-stored in the existing verificationTokenHash),
 * with a per-code attempt counter and the time the last code was sent. Codes issued before this
 * migration were never emailed, so they are cleared: those users ask for a new one.
 */
export class EmailVerificationCodes1700000000005 implements MigrationInterface {
  name = 'EmailVerificationCodes1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credentials"
      ADD COLUMN IF NOT EXISTS "verificationAttempts" integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "verificationSentAt" TIMESTAMPTZ
    `);
    await queryRunner.query(`
      UPDATE "credentials" SET "verificationTokenHash" = NULL, "verificationTokenExpiresAt" = NULL
      WHERE "emailVerified" = false AND "verificationTokenHash" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credentials"
      DROP COLUMN IF EXISTS "verificationSentAt",
      DROP COLUMN IF EXISTS "verificationAttempts"
    `);
  }
}
