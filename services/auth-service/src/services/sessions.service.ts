import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError, safeEqual } from '@food-delivery/shared';
import { SessionsRepository } from '../repositories/sessions.repository';
import { AuthSession, SessionApp, SessionRevokeReason } from '../entities/auth-session.entity';
import { APP_CONFIG, AppConfig } from '../config/app-config';

/** One answer for every refresh token that can't be used, so a client learns nothing from it. */
export class InvalidRefreshTokenError extends AppError {
  constructor() {
    super(401, 'InvalidRefreshToken', 'Your session has ended. Please sign in again.');
  }
}

export interface SessionContext {
  userAgent?: string | null;
  appId?: SessionApp | null;
}

export interface IssuedRefresh {
  session: AuthSession;
  /** `<sessionId>.<secret>`: returned to the client once, never stored or logged. */
  refreshToken: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const USER_AGENT_MAX = 255;

/** The session id the token names, or undefined: used to rate-limit refreshes per session. */
export function sessionIdOf(refreshToken: unknown): string | undefined {
  return parseRefreshToken(refreshToken)?.sessionId;
}

function parseRefreshToken(refreshToken: unknown): { sessionId: string; secret: string } | null {
  if (typeof refreshToken !== 'string') return null;
  const [sessionId, secret, ...rest] = refreshToken.split('.');
  if (rest.length > 0 || !sessionId || !secret || !UUID.test(sessionId) || !SECRET.test(secret)) return null;
  return { sessionId: sessionId.toLowerCase(), secret };
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Refresh sessions (#34), stored in auth-service Postgres.
 *
 * - The refresh token is `<sessionId>.<secret>`. Only `sha256(secret)` is stored, and hashes are
 *   compared in constant time.
 * - Every refresh rotates the secret in a compare-and-set UPDATE and slides the expiry.
 * - Presenting the token a refresh replaced revokes the whole session (the token family): either
 *   the user or a thief holds a copy, and the server can't tell which.
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly sessions: SessionsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async start(credentialId: string, context: SessionContext = {}, now = new Date()): Promise<IssuedRefresh> {
    const secret = this.newSecret();
    const session = await this.sessions.create({
      id: randomUUID(),
      credentialId,
      refreshTokenHash: hashSecret(secret),
      expiresAt: this.expiryFrom(now),
      lastUsedAt: now,
      userAgent: context.userAgent ? context.userAgent.slice(0, USER_AGENT_MAX) : null,
      appId: context.appId ?? null,
    });
    return { session, refreshToken: `${session.id}.${secret}` };
  }

  /** Rotates a live refresh token. Any token that can't be used throws InvalidRefreshTokenError. */
  async rotate(refreshToken: string, now = new Date()): Promise<IssuedRefresh> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw new InvalidRefreshTokenError();
    const session = await this.sessions.findById(parsed.sessionId);
    if (!session) throw new InvalidRefreshTokenError();

    const presented = hashSecret(parsed.secret);
    if (this.isReplaced(session, presented)) {
      await this.revokeForReuse(session);
      throw new InvalidRefreshTokenError();
    }
    if (!this.isLive(session, presented, now)) throw new InvalidRefreshTokenError();

    const secret = this.newSecret();
    const rotated = await this.sessions.rotate(session.id, presented, hashSecret(secret), now, this.expiryFrom(now));
    if (rotated) return { session: rotated, refreshToken: `${rotated.id}.${secret}` };

    // Lost a race. If another refresh with this same token won, the token is now the replaced one:
    // two holders used it, which is exactly what reuse detection is for.
    const fresh = await this.sessions.findById(session.id);
    if (fresh && this.isReplaced(fresh, presented)) await this.revokeForReuse(fresh);
    throw new InvalidRefreshTokenError();
  }

  /**
   * Ends the session the token belongs to. Both the live token and the one it replaced count, so a
   * client that missed a refresh response can still sign out. Unknown tokens are ignored.
   */
  async endByToken(refreshToken: string, reason: SessionRevokeReason, now = new Date()): Promise<void> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) return;
    const session = await this.sessions.findById(parsed.sessionId);
    if (!session) return;
    const presented = hashSecret(parsed.secret);
    if (safeEqual(presented, session.refreshTokenHash) || this.isReplaced(session, presented)) {
      await this.sessions.revoke(session.id, reason, now);
    }
  }

  /** Ends every live session of a user, except `exceptSessionId` when given. Returns how many. */
  revokeAll(credentialId: string, reason: SessionRevokeReason, exceptSessionId?: string): Promise<number> {
    return this.sessions.revokeAllForCredential(credentialId, reason, exceptSessionId);
  }

  /** Revokes the session; used when the credential behind it is gone. */
  async end(sessionId: string, reason: SessionRevokeReason): Promise<void> {
    await this.sessions.revoke(sessionId, reason);
  }

  /** Deletes sessions that ended more than SESSION_RETENTION_DAYS ago. */
  deleteEnded(now = new Date()): Promise<number> {
    return this.sessions.deleteEndedBefore(new Date(now.getTime() - this.config.sessionRetentionDays * 86_400_000));
  }

  private isReplaced(session: AuthSession, presentedHash: string): boolean {
    return Boolean(session.previousTokenHash) && safeEqual(presentedHash, session.previousTokenHash as string);
  }

  private isLive(session: AuthSession, presentedHash: string, now: Date): boolean {
    return !session.revokedAt && session.expiresAt.getTime() > now.getTime() && safeEqual(presentedHash, session.refreshTokenHash);
  }

  private async revokeForReuse(session: AuthSession): Promise<void> {
    if (await this.sessions.revoke(session.id, 'reuse_detected')) {
      // Ids only: tokens are never logged.
      this.logger.warn(`Refresh token reuse: revoked session ${session.id} of credential ${session.credentialId}`);
    }
  }

  private newSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  private expiryFrom(now: Date): Date {
    return new Date(now.getTime() + this.config.refreshTokenTtlDays * 86_400_000);
  }
}
