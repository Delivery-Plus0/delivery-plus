import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #19: the side-effects lease records its holder, so a holder whose lease was taken over can't
 * release it or write the markers. Additive and nullable: a lease held during the deploy has no token
 * and simply expires (at most SIDE_EFFECTS_LEASE_MS), after which the next holder gets one.
 */
export class PaymentSideEffectsLeaseToken1700000000004 implements MigrationInterface {
  name = 'PaymentSideEffectsLeaseToken1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "sideEffectsLeaseToken" uuid`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN IF EXISTS "sideEffectsLeaseToken"`);
  }
}
