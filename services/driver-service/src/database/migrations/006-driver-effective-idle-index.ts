import { MigrationInterface, QueryRunner } from 'typeorm';

/** #210: legacy NULL timestamps use their historical update time, not UUID priority. */
export class DriverEffectiveIdleIndex1700000000005 implements MigrationInterface {
  name = 'DriverEffectiveIdleIndex1700000000005';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_drivers_available_queue"');
    await queryRunner.query(`CREATE INDEX "IDX_drivers_available_queue" ON "drivers" (COALESCE("availableSince", "updatedAt") ASC, "id" ASC) WHERE "status" = 'AVAILABLE' AND "verificationStatus" = 'VERIFIED'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX "IDX_drivers_available_queue"');
    await queryRunner.query(`CREATE INDEX "IDX_drivers_available_queue" ON "drivers" ("availableSince" ASC NULLS FIRST, "id" ASC) WHERE "status" = 'AVAILABLE' AND "verificationStatus" = 'VERIFIED'`);
  }
}
