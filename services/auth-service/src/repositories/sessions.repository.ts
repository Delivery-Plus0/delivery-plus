import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { AuthSession, SessionApp, SessionRevokeReason } from '../entities/auth-session.entity';

export interface NewSession {
  id: string;
  credentialId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  lastUsedAt: Date;
  userAgent: string | null;
  appId: SessionApp | null;
}

/** Every write that changes a session's state is a single conditional UPDATE (compare-and-set). */
@Injectable()
export class SessionsRepository {
  constructor(
    @InjectRepository(AuthSession)
    private readonly repo: Repository<AuthSession>,
  ) {}

  create(data: NewSession): Promise<AuthSession> {
    return this.repo.save(this.repo.create({ ...data, previousTokenHash: null, revokedAt: null, revokedReason: null }));
  }

  findById(id: string): Promise<AuthSession | null> {
    return this.repo.findOne({ where: { id } });
  }

  /**
   * Rotates the refresh token only while `currentHash` is still the live one and the session is
   * neither revoked nor expired. Two refreshes racing with the same token: exactly one wins.
   */
  async rotate(id: string, currentHash: string, nextHash: string, now: Date, expiresAt: Date): Promise<AuthSession | null> {
    const result = await this.repo
      .createQueryBuilder()
      .update(AuthSession)
      .set({ previousTokenHash: currentHash, refreshTokenHash: nextHash, lastUsedAt: now, expiresAt })
      .where('id = :id AND "refreshTokenHash" = :currentHash AND "revokedAt" IS NULL AND "expiresAt" > :now', { id, currentHash, now })
      .execute();
    return result.affected ? this.findById(id) : null;
  }

  /** Revokes one session; a session already revoked keeps its first reason. Returns whether it changed. */
  async revoke(id: string, reason: SessionRevokeReason, now = new Date()): Promise<boolean> {
    const result = await this.repo.update({ id, revokedAt: IsNull() }, { revokedAt: now, revokedReason: reason });
    return Boolean(result.affected);
  }

  /** Revokes every live session of a user, except `exceptSessionId` when given. Returns how many. */
  async revokeAllForCredential(credentialId: string, reason: SessionRevokeReason, exceptSessionId?: string, now = new Date()): Promise<number> {
    const result = await this.repo.update(
      { credentialId, revokedAt: IsNull(), ...(exceptSessionId ? { id: Not(exceptSessionId) } : {}) },
      { revokedAt: now, revokedReason: reason },
    );
    return result.affected ?? 0;
  }

  /** Deletes sessions that expired, or were revoked, before `before`. Returns how many. */
  async deleteEndedBefore(before: Date): Promise<number> {
    const expired = await this.repo.delete({ expiresAt: LessThan(before) });
    const revoked = await this.repo.delete({ revokedAt: LessThan(before) });
    return (expired.affected ?? 0) + (revoked.affected ?? 0);
  }
}
