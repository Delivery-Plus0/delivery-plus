import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Menu management (#148): archiving replaces deleting, so an item that was ordered stays a valid
 * reference. Additive and nullable; nothing existing is archived.
 */
export class MenuItemArchive1700000000002 implements MigrationInterface {
  name = 'MenuItemArchive1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_menu_items_restaurant_archived" ON "menu_items" ("restaurantId", "archivedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_menu_items_restaurant_archived"`);
    await queryRunner.query(`ALTER TABLE "menu_items" DROP COLUMN IF EXISTS "archivedAt"`);
  }
}
