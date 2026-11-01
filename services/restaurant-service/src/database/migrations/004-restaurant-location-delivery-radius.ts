import { MigrationInterface, QueryRunner } from 'typeorm';

export class RestaurantLocationDeliveryRadius1700000000003 implements MigrationInterface {
  name = 'RestaurantLocationDeliveryRadius1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "restaurants"
        ADD COLUMN "latitude" double precision,
        ADD COLUMN "longitude" double precision,
        ADD COLUMN "deliveryRadiusKm" numeric(5, 2),
        ADD CONSTRAINT "CHK_restaurants_latitude_range"
          CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
        ADD CONSTRAINT "CHK_restaurants_longitude_range"
          CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180),
        ADD CONSTRAINT "CHK_restaurants_delivery_radius"
          CHECK ("deliveryRadiusKm" IS NULL OR ("deliveryRadiusKm" > 0 AND "deliveryRadiusKm" <= 50)),
        ADD CONSTRAINT "CHK_restaurants_coordinates_pair"
          CHECK (("latitude" IS NULL AND "longitude" IS NULL) OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "restaurants"
        DROP COLUMN IF EXISTS "deliveryRadiusKm",
        DROP COLUMN IF EXISTS "longitude",
        DROP COLUMN IF EXISTS "latitude"
    `);
  }
}
