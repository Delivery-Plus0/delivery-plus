import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Driver verification status (#147): PENDING until an admin verifies or rejects the driver. Existing
 * drivers start PENDING too: nobody has verified them yet. No identity documents are stored (see
 * docs/services/driver-service.md): the business doesn't require them today.
 */
export class DriverVerification1700000000002 implements MigrationInterface {
  name = 'DriverVerification1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "verificationStatus" character varying(20) NOT NULL DEFAULT 'PENDING'`,
    );
    await queryRunner.query(`ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "verificationNote" character varying(300)`);
    await queryRunner.query(`ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "drivers" ADD CONSTRAINT "CHK_drivers_verification" CHECK ("verificationStatus" IN ('PENDING', 'VERIFIED', 'REJECTED'));
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "drivers" DROP CONSTRAINT IF EXISTS "CHK_drivers_verification"`);
    await queryRunner.query(`ALTER TABLE "drivers" DROP COLUMN IF EXISTS "verifiedAt"`);
    await queryRunner.query(`ALTER TABLE "drivers" DROP COLUMN IF EXISTS "verificationNote"`);
    await queryRunner.query(`ALTER TABLE "drivers" DROP COLUMN IF EXISTS "verificationStatus"`);
  }
}
