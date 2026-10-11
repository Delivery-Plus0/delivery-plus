import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #151: the restaurant's or platform's own words when it cancels, kept apart from the English
 * `cancellationReason` so the apps can show the reason in Arabic with the note inside it. Older
 * orders stay null and keep their English reason.
 */
export class CancellationNote1700000000007 implements MigrationInterface {
  name = 'CancellationNote1700000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancellationNote" character varying(200)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "cancellationNote"`);
  }
}
