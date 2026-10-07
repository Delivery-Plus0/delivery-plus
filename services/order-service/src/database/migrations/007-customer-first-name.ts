import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The customer's first name, copied at checkout (#154) so the restaurant can call out the order
 * without another service lookup. Only the first name: no surname, phone or email. Older orders
 * stay null.
 */
export class CustomerFirstName1700000000006 implements MigrationInterface {
  name = 'CustomerFirstName1700000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "customerFirstName" character varying(60)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "customerFirstName"`);
  }
}
