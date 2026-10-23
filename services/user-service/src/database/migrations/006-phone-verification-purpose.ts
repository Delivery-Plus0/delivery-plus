import { MigrationInterface, QueryRunner } from 'typeorm';

/** Password reset by SMS code (#35): what a code is for, so the two flows never share codes or limits. */
export class PhoneVerificationPurpose1700000000005 implements MigrationInterface {
  name = 'PhoneVerificationPurpose1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "phone_verifications" ADD COLUMN IF NOT EXISTS "purpose" varchar(32) NOT NULL DEFAULT 'phone_verification'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "phone_verifications" DROP COLUMN IF EXISTS "purpose"');
  }
}