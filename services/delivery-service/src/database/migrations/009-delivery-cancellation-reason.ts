import { MigrationInterface, QueryRunner } from 'typeorm';

/** #53: the platform's reason for cancelling a delivery, carried on delivery.cancelled. Additive, nullable. */
export class DeliveryCancellationReason1700000000008 implements MigrationInterface {
  name = 'DeliveryCancellationReason1700000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "cancellationReason" character varying(200)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "cancellationReason"`);
  }
}
