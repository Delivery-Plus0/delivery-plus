import { Logger } from '@nestjs/common';
import { normalizeEgyptianMobile } from '@food-delivery/shared';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stores every profile phone as an Egyptian mobile in E.164 (#152), using the same rules the API now
 * enforces. A stored value that isn't an Egyptian mobile can't be kept: it is cleared, and how many
 * were cleared is logged (never the numbers themselves). Not reversible: the original forms are gone.
 */
export class NormalizePhones1700000000003 implements MigrationInterface {
  name = 'NormalizePhones1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: { id: string; phone: string }[] = await queryRunner.query(
      `SELECT "id", "phone" FROM "user_profiles" WHERE "phone" IS NOT NULL`,
    );
    let normalized = 0;
    let cleared = 0;
    for (const row of rows) {
      const e164 = normalizeEgyptianMobile(row.phone);
      if (e164 === row.phone) continue;
      await queryRunner.query(`UPDATE "user_profiles" SET "phone" = $1 WHERE "id" = $2`, [e164, row.id]);
      if (e164) normalized += 1;
      else cleared += 1;
    }
    new Logger(NormalizePhones1700000000003.name).log(
      `user.phone.normalized checked=${rows.length} normalized=${normalized} cleared_invalid=${cleared}`,
    );
  }

  public async down(): Promise<void> {
    // Nothing to undo safely: the original free-text forms were not kept.
  }
}
