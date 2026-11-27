import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #215: staff can suspend a driver who is on a delivery. The driver finishes it first: the request is
 * kept here, and the release at the end of the job lands on SUSPENDED instead of AVAILABLE.
 */
export class DriverSuspensionRequest1700000000009 implements MigrationInterface {
  name = 'DriverSuspensionRequest1700000000009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "drivers" ADD COLUMN IF NOT EXISTS "suspensionRequestedAt" timestamptz`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "drivers" DROP COLUMN IF EXISTS "suspensionRequestedAt"`);
  }
}
