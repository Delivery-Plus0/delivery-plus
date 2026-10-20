import { AuthSession, SessionRevokeReason } from '../entities/auth-session.entity';
import { NewSession } from '../repositories/sessions.repository';

/** Test support: an in-memory SessionsRepository with the same conditions as its SQL; every call yields once, like a query. */
export class InMemorySessions {
  readonly rows = new Map<string, AuthSession>();
  private readonly tick = () => new Promise((resolve) => setImmediate(resolve));

  async create(data: NewSession): Promise<AuthSession> {
    await this.tick();
    const row = { ...data, previousTokenHash: null, revokedAt: null, revokedReason: null, createdAt: new Date() } as AuthSession;
    this.rows.set(row.id, row);
    return { ...row };
  }

  async findById(id: string): Promise<AuthSession | null> {
    await this.tick();
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async rotate(id: string, currentHash: string, nextHash: string, now: Date, expiresAt: Date): Promise<AuthSession | null> {
    await this.tick();
    const row = this.rows.get(id);
    if (!row || row.refreshTokenHash !== currentHash || row.revokedAt || row.expiresAt <= now) return null;
    Object.assign(row, { previousTokenHash: currentHash, refreshTokenHash: nextHash, lastUsedAt: now, expiresAt });
    return { ...row };
  }

  async revoke(id: string, reason: SessionRevokeReason, now = new Date()): Promise<boolean> {
    await this.tick();
    const row = this.rows.get(id);
    if (!row || row.revokedAt) return false;
    Object.assign(row, { revokedAt: now, revokedReason: reason });
    return true;
  }

  async revokeAllForCredential(credentialId: string, reason: SessionRevokeReason, exceptSessionId?: string, now = new Date()): Promise<number> {
    await this.tick();
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.credentialId === credentialId && !row.revokedAt && row.id !== exceptSessionId) {
        Object.assign(row, { revokedAt: now, revokedReason: reason });
        count++;
      }
    }
    return count;
  }

  async deleteEndedBefore(before: Date): Promise<number> {
    await this.tick();
    let count = 0;
    for (const [id, row] of this.rows) {
      if (row.expiresAt < before || (row.revokedAt && row.revokedAt < before)) {
        this.rows.delete(id);
        count++;
      }
    }
    return count;
  }
}
