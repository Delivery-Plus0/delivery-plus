import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #18: PROCESSING claims record when they were taken and by whom, so an abandoned claim can be taken
 * over and only the current holder can settle. Additive and nullable. Rows already stuck in
 * PROCESSING keep a null claim time, which the service treats as abandoned: they become recoverable
 * on the first retry (or the sweep) after this deploys, instead of staying stuck.
 */
export class PaymentProcessingClaim1700000000003 implements MigrationInterface {
  name = 'PaymentProcessingClaim1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "processingClaimedAt" TIMESTAMPTZ`);
    await queryRunner.query(`ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "processingToken" uuid`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "processingToken"`);
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "processingClaimedAt"`);
  }
}
