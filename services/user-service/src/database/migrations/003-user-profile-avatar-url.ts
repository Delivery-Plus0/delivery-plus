import { MigrationInterface, QueryRunner } from 'typeorm';

export class UserProfileAvatarUrl1700000000002 implements MigrationInterface {
  name = 'UserProfileAvatarUrl1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "user_profiles" ADD COLUMN "avatarUrl" text');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "user_profiles" DROP COLUMN IF EXISTS "avatarUrl"');
  }
}