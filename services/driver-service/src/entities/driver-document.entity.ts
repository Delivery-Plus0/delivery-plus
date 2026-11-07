import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { DriverDocumentType } from '../common/driver-documents';

/**
 * One uploaded version of one document (#207). Only the object key is stored, never a URL. Replacing a
 * document adds a version and clears `isCurrent` on the previous one, which stays for the review that
 * used it.
 */
@Entity('driver_documents')
@Index('UQ_driver_documents_current', ['driverId', 'type'], { unique: true, where: '"isCurrent"' })
@Index('UQ_driver_documents_version', ['driverId', 'type', 'version'], { unique: true })
export class DriverDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  driverId!: string;

  @Column({ type: 'varchar', length: 30 })
  type!: DriverDocumentType;

  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'boolean', default: true })
  isCurrent!: boolean;

  /** In the private bucket. Never returned to the driver or written to a log. */
  @Column({ type: 'varchar', length: 255, unique: true, select: false })
  objectKey!: string;

  @Column({ type: 'varchar', length: 30 })
  contentType!: 'image/jpeg' | 'image/png' | 'application/pdf';

  @Column({ type: 'integer' })
  sizeBytes!: number;

  /** SHA-256 of the bytes: which exact file a review looked at. */
  @Column({ type: 'char', length: 64 })
  sha256!: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  uploadedAt!: Date;
}
