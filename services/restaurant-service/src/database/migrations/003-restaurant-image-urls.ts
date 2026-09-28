import { MigrationInterface, QueryRunner } from 'typeorm';

export class RestaurantImageUrls1700000000002 implements MigrationInterface {
  name = 'RestaurantImageUrls1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "restaurants"
        ADD COLUMN "coverImageUrl" text,
        ADD COLUMN "logoUrl" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "restaurants"
        DROP COLUMN IF EXISTS "coverImageUrl",
        DROP COLUMN IF EXISTS "logoUrl"
    `);
  }
}