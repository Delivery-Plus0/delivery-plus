import { MigrationInterface, QueryRunner } from 'typeorm';

/** #210: preserve the best known idle time for existing online drivers. */
export class DriverAvailableSince1700000000004 implements MigrationInterface {
  name = 'DriverAvailableSince1700000000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "drivers" ADD COLUMN "availableSince" timestamptz');
    await queryRunner.query(`UPDATE "drivers" SET "availableSince" = "updatedAt" WHERE "status" = 'AVAILABLE'`);
    await queryRunner.query(`CREATE INDEX "IDX_drivers_available_queue" ON "drivers" ("availableSince" ASC NULLS FIRST, "id" ASC) WHERE "status" = 'AVAILABLE' AND "verificationStatus" = 'VERIFIED'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_drivers_available_queue"');
    await queryRunner.query('ALTER TABLE "drivers" DROP COLUMN "availableSince"');
  }
}
