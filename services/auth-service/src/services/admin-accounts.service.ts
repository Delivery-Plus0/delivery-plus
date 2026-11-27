import { Injectable } from '@nestjs/common';
import { AdminAudit, AuditActor, ForbiddenError, NotFoundError, UserRole } from '@food-delivery/shared';
import { CredentialsRepository } from '../repositories/credentials.repository';
import { SessionsRepository } from '../repositories/sessions.repository';
import { OutboxRelayService } from '../common/outbox.module';
import { Credential } from '../entities/credential.entity';

const SERVICE = 'auth-service';

export interface AccountActionResult {
  userId: string;
  status: Credential['status'];
  sessionsRevoked: number;
  changed: boolean;
}

/**
 * #215: staff actions on people's accounts: suspend, reactivate, sign out everywhere. Each changes
 * the credential (and its sessions) and stages its audit event in one transaction; a repeat changes
 * nothing and records nothing. Staff accounts are managed with the staff tools (#216), and nobody acts
 * on their own account.
 */
@Injectable()
export class AdminAccountsService {
  constructor(
    private readonly credentials: CredentialsRepository,
    private readonly sessions: SessionsRepository,
    private readonly outbox: OutboxRelayService,
  ) {}

  async suspend(actor: AuditActor, userId: string, reason: string): Promise<AccountActionResult> {
    const credential = await this.target(actor, userId);
    const outcome = await this.credentials.transaction(async (manager) => {
      if (!(await this.credentials.setStatusIfChanged(manager, userId, 'SUSPENDED', reason))) return null;
      const sessionsRevoked = await this.sessions.revokeAllForCredential(userId, 'suspended', undefined, new Date(), manager);
      await AdminAudit.record(manager, {
        actor,
        permission: 'users.manage',
        action: 'user.suspend',
        targetType: 'USER',
        targetId: userId,
        reason,
        before: { status: 'ACTIVE' },
        after: { status: 'SUSPENDED', sessionsRevoked },
        service: SERVICE,
        // No notice: a suspended account can't sign in, and is told so when it tries (#202).
      });
      return sessionsRevoked;
    });
    return this.result(credential, outcome);
  }

  async reactivate(actor: AuditActor, userId: string, reason: string): Promise<AccountActionResult> {
    const credential = await this.target(actor, userId);
    const outcome = await this.credentials.transaction(async (manager) => {
      if (!(await this.credentials.setStatusIfChanged(manager, userId, 'ACTIVE', null))) return null;
      await AdminAudit.record(manager, {
        actor,
        permission: 'users.manage',
        action: 'user.reactivate',
        targetType: 'USER',
        targetId: userId,
        reason,
        before: { status: 'SUSPENDED' },
        after: { status: 'ACTIVE' },
        service: SERVICE,
        notify: { userId, messageKey: 'account.reactivated' },
      });
      return 0;
    });
    return this.result(credential, outcome);
  }

  /** Ends every refresh session (#34). Access tokens already issued last until they expire. */
  async revokeSessions(actor: AuditActor, userId: string, reason: string): Promise<AccountActionResult> {
    const credential = await this.target(actor, userId);
    const outcome = await this.credentials.transaction(async (manager) => {
      const sessionsRevoked = await this.sessions.revokeAllForCredential(userId, 'admin', undefined, new Date(), manager);
      if (sessionsRevoked === 0) return null;
      await AdminAudit.record(manager, {
        actor,
        permission: 'users.manage',
        action: 'user.revoke_sessions',
        targetType: 'USER',
        targetId: userId,
        reason,
        after: { sessionsRevoked },
        service: SERVICE,
      });
      return sessionsRevoked;
    });
    return this.result(credential, outcome);
  }

  private async target(actor: AuditActor, userId: string): Promise<Credential> {
    if (userId === actor.id) throw new ForbiddenError('You cannot act on your own account');
    const credential = await this.credentials.findById(userId);
    if (!credential) throw new NotFoundError(`User ${userId} not found`);
    if (credential.role === UserRole.ADMIN) throw new ForbiddenError('Staff accounts are managed with the staff tools');
    return credential;
  }

  private async result(credential: Credential, outcome: number | null): Promise<AccountActionResult> {
    if (outcome !== null) this.outbox.kick();
    const current = (await this.credentials.findById(credential.id)) ?? credential;
    return { userId: credential.id, status: current.status, sessionsRevoked: outcome ?? 0, changed: outcome !== null };
  }
}
