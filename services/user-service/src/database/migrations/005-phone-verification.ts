import { MigrationInterface, QueryRunner } from 'typeorm';

/** Phone verification by one-time code (#153): the verified state on profiles and the sent codes. */
export class PhoneVerification1700000000004 implements MigrationInterface {
  name = 'PhoneVerification1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "user_profiles" ADD COLUMN IF NOT EXISTS "phoneVerifiedAt" TIMESTAMP WITH TIME ZONE');
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "phone_verifications" (
        "id" uuid PRIMARY KEY,
        "userId" uuid NOT NULL,
        "phone" varchar(16) NOT NULL,
        "codeHash" varchar(64) NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "consumedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_phone_verifications_user_created" ON "phone_verifications" ("userId", "createdAt")',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_phone_verifications_phone_created" ON "phone_verifications" ("phone", "createdAt")',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "phone_verifications"');
    await queryRunner.query('ALTER TABLE "user_profiles" DROP COLUMN IF EXISTS "phoneVerifiedAt"');
  }
}
