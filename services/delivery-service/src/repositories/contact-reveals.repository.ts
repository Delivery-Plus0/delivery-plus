import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ContactField } from '../entities/delivery-contact-reveal.entity';

/** #211: records that a viewer was shown participants' phones for a delivery (never the numbers). */
@Injectable()
export class ContactRevealsRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** One upsert per field: the first reveal inserts, later ones move `lastRevealedAt` and count. */
  async record(deliveryId: string, viewerUserId: string, viewerRole: string, fields: ContactField[]): Promise<void> {
    if (!fields.length) return;
    await this.dataSource.query(
      `INSERT INTO "delivery_contact_reveals" ("deliveryId", "viewerUserId", "viewerRole", "field")
       SELECT $1, $2, $3, field FROM unnest($4::varchar[]) AS field
       ON CONFLICT ("deliveryId", "viewerUserId", "field")
       DO UPDATE SET "lastRevealedAt" = now(), "revealCount" = "delivery_contact_reveals"."revealCount" + 1`,
      [deliveryId, viewerUserId, viewerRole, fields],
    );
  }
}
