import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ordered menu item images (#149). Every item that already had an imageUrl gets it as its first
 * image, so the list and the mirrored primary agree from the start.
 */
export class MenuItemImages1700000000003 implements MigrationInterface {
  name = 'MenuItemImages1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "menu_item_images" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "menuItemId" uuid NOT NULL,
        "url" character varying(1024) NOT NULL,
        "position" integer NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_menu_item_images" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_menu_item_images_item_position" ON "menu_item_images" ("menuItemId", "position")`,
    );
    await queryRunner.query(`
      INSERT INTO "menu_item_images" ("menuItemId", "url", "position")
      SELECT "id", "imageUrl", 0 FROM "menu_items" m
       WHERE "imageUrl" IS NOT NULL AND "imageUrl" <> ''
         AND NOT EXISTS (SELECT 1 FROM "menu_item_images" i WHERE i."menuItemId" = m."id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "menu_item_images"`);
  }
}
