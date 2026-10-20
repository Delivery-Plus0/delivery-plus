import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/** The apps a session can belong to (shown to staff later; no behavior depends on it). */
export const SESSION_APPS = ['customer', 'driver', 'restaurant', 'admin'] as const;
export type SessionApp = (typeof SESSION_APPS)[number];

/**
 * Why a session ended. The first three come from the user or from theft detection; the rest are for
 * the internal revoke-sessions route (#35 password change/reset, #202 suspension, #215 staff action).
 */
export const SESSION_REVOKE_REASONS = [
  'logout',
  'logout_all',
  'reuse_detected',
  'password_changed',
  'password_reset',
  'suspended',
  'admin',
] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

/**
 * One sign-in on one device (#34). The id is the refresh-token family: every refresh rotates the
 * token inside the same row, and reusing the token it replaced revokes the row.
 * Only SHA-256 hashes of the token secrets are stored.
 */
@Entity('auth_sessions')
export class AuthSession {
  @PrimaryColumn('uuid')
  id!: string;

  @Index('IDX_auth_sessions_credential')
  @Column('uuid')
  credentialId!: string;

  @Column({ type: 'varchar', length: 64 })
  refreshTokenHash!: string;

  /** The token the last refresh replaced. Presenting it again means it was stolen. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  previousTokenHash!: string | null;

  @Index('IDX_auth_sessions_expires')
  @Column({ type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  revokedReason!: SessionRevokeReason | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz' })
  lastUsedAt!: Date;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  appId!: SessionApp | null;
}
