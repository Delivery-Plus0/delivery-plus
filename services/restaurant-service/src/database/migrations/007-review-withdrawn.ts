import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #318 (owner decision): the review queue's Undo is a second, recorded action. A withdrawn decision
 * is a new `WITHDRAWN` row in the append-only review history, never an edit or a delete.
 */
export class ReviewWithdrawn1700000000006 implements MigrationInterface {
  name = 'ReviewWithdrawn1700000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "restaurant_reviews" DROP CONSTRAINT "CHK_restaurant_reviews_decision"`);
    await queryRunner.query(
      `ALTER TABLE "restaurant_reviews" ADD CONSTRAINT "CHK_restaurant_reviews_decision" CHECK ("decision" IN ('APPROVED', 'REJECTED', 'WITHDRAWN'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "restaurant_reviews" DROP CONSTRAINT "CHK_restaurant_reviews_decision"`);
    await queryRunner.query(
      `ALTER TABLE "restaurant_reviews" ADD CONSTRAINT "CHK_restaurant_reviews_decision" CHECK ("decision" IN ('APPROVED', 'REJECTED')) NOT VALID`,
    );
  }
}
