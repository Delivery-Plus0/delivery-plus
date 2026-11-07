import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { DriverDocumentType } from '../common/driver-documents';

/**
 * Every staff read of a driver document (#207): who, which document, when. Never the URL. Append-only.
 * A stand-in until audit-service exists (#213); it has no foreign keys so the record outlives the
 * document it points at.
 */
@Entity('driver_document_access')
@Index('IDX_driver_document_access_driver', ['driverId', 'accessedAt'])
export class DriverDocumentAccess {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The staff member's user id (the token's `sub`). */
  @Column({ type: 'uuid' })
  staffUserId!: string;

  @Column({ type: 'uuid' })
  driverId!: string;

  @Column({ type: 'uuid' })
  documentId!: string;

  @Column({ type: 'varchar', length: 30 })
  documentType!: DriverDocumentType;

  @Column({ type: 'integer' })
  documentVersion!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  accessedAt!: Date;
}
