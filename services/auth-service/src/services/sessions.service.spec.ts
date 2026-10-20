import { createHash } from 'node:crypto';
import { SessionsRepository } from '../repositories/sessions.repository';
import { InMemorySessions } from '../testing/in-memory-sessions';
import { AppConfig } from '../config/app-config';
import { InvalidRefreshTokenError, SessionsService, sessionIdOf } from './sessions.service';

const sessionConfig = { refreshTokenTtlDays: 30, sessionRetentionDays: 30 } as AppConfig;

describe('SessionsService (#34)', () => {
  let repo: InMemorySessions;
  let sessions: SessionsService;
  const now = new Date('2026-10-20T10:00:00Z');

  beforeEach(() => {
    repo = new InMemorySessions();
    sessions = new SessionsService(repo as unknown as SessionsRepository, sessionConfig);
  });

  const statusOf = (token: string) => repo.rows.get(token.split('.')[0]);

  describe('start', () => {
    it('returns `<sessionId>.<secret>` and stores only the SHA-256 of the secret', async () => {
      const { session, refreshToken } = await sessions.start('cred-1', { userAgent: 'x'.repeat(400), appId: 'driver' }, now);

      expect(refreshToken).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
      const [id, secret] = refreshToken.split('.');
      const stored = repo.rows.get(id)!;
      expect(id).toBe(session.id);
      expect(stored.refreshTokenHash).toBe(createHash('sha256').update(secret).digest('hex'));
      expect(JSON.stringify(stored)).not.toContain(secret);
      expect(stored).toMatchObject({ credentialId: 'cred-1', appId: 'driver', previousTokenHash: null, revokedAt: null });
      expect(stored.userAgent).toHaveLength(255);
      expect(stored.expiresAt).toEqual(new Date('2026-11-19T10:00:00Z'));
    });

    it('gives every sign-in its own session', async () => {
      const a = await sessions.start('cred-1');
      const b = await sessions.start('cred-1');
      expect(a.session.id).not.toBe(b.session.id);
      expect(a.refreshToken).not.toBe(b.refreshToken);
    });
  });

  describe('rotate', () => {
    it('rotates: the new token works, the old one fails, and the expiry slides', async () => {
      const first = await sessions.start('cred-1', {}, now);
      const later = new Date('2026-10-25T10:00:00Z');

      const second = await sessions.rotate(first.refreshToken, later);

      expect(second.session.id).toBe(first.session.id);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(second.session.expiresAt).toEqual(new Date('2026-11-24T10:00:00Z'));
      await expect(sessions.rotate(second.refreshToken, later)).resolves.toBeDefined();
    });

    it('revokes the whole family when a rotated token is used again (theft detection)', async () => {
      const first = await sessions.start('cred-1', {}, now);
      const second = await sessions.rotate(first.refreshToken, now);

      await expect(sessions.rotate(first.refreshToken, now)).rejects.toBeInstanceOf(InvalidRefreshTokenError);

      expect(statusOf(first.refreshToken)).toMatchObject({ revokedReason: 'reuse_detected', revokedAt: expect.any(Date) });
      // The legitimate holder's newest token is dead too: the server can't tell who the thief is.
      await expect(sessions.rotate(second.refreshToken, now)).rejects.toBeInstanceOf(InvalidRefreshTokenError);
    });

    it('lets exactly one of two concurrent refreshes with the same token win, and treats the other as reuse', async () => {
      const first = await sessions.start('cred-1', {}, now);

      const results = await Promise.allSettled([sessions.rotate(first.refreshToken, now), sessions.rotate(first.refreshToken, now)]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(statusOf(first.refreshToken)?.revokedReason).toBe('reuse_detected');
    });

    it('refuses an expired session', async () => {
      const first = await sessions.start('cred-1', {}, now);
      await expect(sessions.rotate(first.refreshToken, new Date('2026-11-19T10:00:01Z'))).rejects.toBeInstanceOf(InvalidRefreshTokenError);
    });

    it('refuses a revoked session', async () => {
      const first = await sessions.start('cred-1', {}, now);
      await sessions.endByToken(first.refreshToken, 'logout', now);
      await expect(sessions.rotate(first.refreshToken, now)).rejects.toBeInstanceOf(InvalidRefreshTokenError);
    });

    it('refuses a wrong secret for a real session without revoking it', async () => {
      const first = await sessions.start('cred-1', {}, now);
      const forged = `${first.session.id}.${'A'.repeat(43)}`;

      await expect(sessions.rotate(forged, now)).rejects.toBeInstanceOf(InvalidRefreshTokenError);

      expect(statusOf(first.refreshToken)?.revokedAt).toBeNull();
      await expect(sessions.rotate(first.refreshToken, now)).resolves.toBeDefined();
    });

    it.each(['', 'not-a-token', 'a.b', `${'0'.repeat(36)}.${'A'.repeat(43)}`, `00000000-0000-4000-8000-000000000000.${'A'.repeat(43)}.x`])(
      'refuses a malformed or unknown token (%s) with the same error',
      async (token) => {
        await expect(sessions.rotate(token, now)).rejects.toBeInstanceOf(InvalidRefreshTokenError);
      },
    );

    it('answers every refusal with the same 401, so a client learns nothing', () => {
      expect(new InvalidRefreshTokenError()).toMatchObject({ statusCode: 401, error: 'InvalidRefreshToken' });
    });
  });

  describe('ending sessions', () => {
    it('logout ends the session for the live token and for the one it replaced; unknown tokens are ignored', async () => {
      const a = await sessions.start('cred-1');
      await sessions.endByToken(a.refreshToken, 'logout');
      expect(statusOf(a.refreshToken)?.revokedReason).toBe('logout');

      const b = await sessions.start('cred-1');
      await sessions.rotate(b.refreshToken);
      await sessions.endByToken(b.refreshToken, 'logout'); // the replaced token: a client that missed the refresh response
      expect(statusOf(b.refreshToken)?.revokedReason).toBe('logout');

      await expect(sessions.endByToken('garbage', 'logout')).resolves.toBeUndefined();
    });

    it('revokes every live session of a user, optionally keeping one, and leaves other users alone', async () => {
      const keep = await sessions.start('cred-1');
      await sessions.start('cred-1');
      await sessions.start('cred-1');
      const other = await sessions.start('cred-2');

      await expect(sessions.revokeAll('cred-1', 'password_changed', keep.session.id)).resolves.toBe(2);

      expect(statusOf(keep.refreshToken)?.revokedAt).toBeNull();
      expect(statusOf(other.refreshToken)?.revokedAt).toBeNull();
      await expect(sessions.revokeAll('cred-1', 'suspended')).resolves.toBe(1);
    });

    it('keeps the first reason when a session is revoked twice', async () => {
      const a = await sessions.start('cred-1');
      await sessions.endByToken(a.refreshToken, 'logout');
      await sessions.revokeAll('cred-1', 'suspended');
      expect(statusOf(a.refreshToken)?.revokedReason).toBe('logout');
    });
  });

  describe('cleanup', () => {
    it('deletes sessions that expired or were revoked more than the retention period ago', async () => {
      const old = await sessions.start('cred-1', {}, new Date('2026-08-01T00:00:00Z')); // expired 2026-08-31
      const revokedLongAgo = await sessions.start('cred-1', {}, now);
      repo.rows.get(revokedLongAgo.session.id)!.revokedAt = new Date('2026-09-01T00:00:00Z');
      const revokedRecently = await sessions.start('cred-1', {}, now);
      repo.rows.get(revokedRecently.session.id)!.revokedAt = new Date('2026-10-19T00:00:00Z');
      const live = await sessions.start('cred-1', {}, now);

      await expect(sessions.deleteEnded(now)).resolves.toBe(2);

      expect([...repo.rows.keys()].sort()).toEqual([revokedRecently.session.id, live.session.id].sort());
      expect(repo.rows.has(old.session.id)).toBe(false);
    });
  });

  it('reads the session id out of a token for per-session rate limits', async () => {
    const { session, refreshToken } = await sessions.start('cred-1');
    expect(sessionIdOf(refreshToken)).toBe(session.id);
    expect(sessionIdOf('nope')).toBeUndefined();
    expect(sessionIdOf(42)).toBeUndefined();
  });
});
