import { Inject, Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AdminAudit, AppError, AuditActor, ConflictError, ForbiddenError, NotFoundError, STAFF_PERMISSIONS, StaffPermission } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { StaffMember, StaffRepository } from '../repositories/staff.repository';
import { SessionsRepository } from '../repositories/sessions.repository';
import { OutboxRelayService } from '../common/outbox.module';
import { UserServiceClient } from '../common/user-service.client';
import { EmailSender, EmailUnavailableError } from '../email/email-sender';
import { EmailLocale } from '../email/verification-email';
import { buildStaffInvitationEmail, hashInvitationToken, newInvitationToken } from '../email/staff-invitation-email';

const SERVICE = 'auth-service';
/** #216: staff passwords are longer than customers' (8). MFA for staff follows after launch (#232). */
export const STAFF_MIN_PASSWORD_LENGTH = 12;
const SALT_ROUNDS = 12;

export class InvitationInvalidError extends AppError {
  constructor() {
    super(410, 'InvitationInvalid', 'This invitation link is not valid any more. Ask for a new invitation.');
  }
}

export class LastSuperAdminError extends AppError {
  constructor() {
    super(409, 'LastSuperAdmin', 'This is the last active staff member who can manage staff: give staff.manage to someone else first');
  }
}

export interface InvitationView {
  id: string;
  email: string;
  permissions: StaffPermission[];
  expiresAt: Date;
}

/**
 * Staff accounts with least privilege (#216): invitations by email, acceptance, permission changes
 * and disabling. Every change is audited (#213) in its transaction. Guard rails: nobody removes their
 * own `staff.manage`, and the last active holder of `staff.manage` can't lose it or be disabled.
 * Permissions are read fresh at every login and refresh (#202), so a change applies at the next
 * refresh: the access token's TTL (JWT_EXPIRES_IN, 15 minutes by default) bounds the delay.
 */
@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly staff: StaffRepository,
    private readonly sessions: SessionsRepository,
    private readonly outbox: OutboxRelayService,
    private readonly userService: UserServiceClient,
    private readonly emailSender: EmailSender,
  ) {}

  list(): Promise<StaffMember[]> {
    return this.staff.list();
  }

  async invite(actor: AuditActor, email: string, permissions: StaffPermission[], reason: string, locale: EmailLocale, correlationId: string): Promise<InvitationView> {
    if (!this.emailSender.enabled) throw new EmailUnavailableError('Email is not configured, so invitations can’t be sent.');
    if (!this.config.adminAppUrl) throw new EmailUnavailableError('ADMIN_APP_URL is not set, so an invitation link can’t be made.');
    const token = newInvitationToken();
    const invitation = await this.staff.transaction(async (manager) => {
      if (await this.staff.emailTaken(manager, email)) throw new ConflictError('That email already belongs to an account');
      const created = await this.staff.createInvitation(manager, {
        email,
        permissions: sortedUnique(permissions),
        tokenHash: hashInvitationToken(token),
        invitedBy: actor.id,
        expiresAt: new Date(Date.now() + this.config.staffInvitationTtlHours * 3_600_000),
      });
      await AdminAudit.record(manager, {
        actor,
        permission: 'staff.manage',
        action: 'staff.invite',
        targetType: 'STAFF',
        targetId: created.id,
        reason,
        after: { email, permissions: created.permissions },
        service: SERVICE,
        correlationId,
      });
      return created;
    });
    this.outbox.kick();
    const link = `${this.config.adminAppUrl}/accept-invitation?token=${encodeURIComponent(token)}`;
    await this.emailSender.send(buildStaffInvitationEmail(email, link, locale, this.config.staffInvitationTtlHours), { correlationId });
    this.logger.log(`staff.invited invitation=${invitation.id} by=${actor.id}`);
    return { id: invitation.id, email: invitation.email, permissions: invitation.permissions, expiresAt: invitation.expiresAt };
  }

  /** The invitee sets a password; the account is staff (ADMIN) with exactly the invited permissions. */
  async accept(token: string, password: string, fullName: string, phone: string | undefined, correlationId: string): Promise<{ userId: string; email: string; permissions: StaffPermission[] }> {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await this.staff.transaction(async (manager) => {
      const invitation = await this.staff.consumeInvitation(manager, hashInvitationToken(token), new Date());
      if (!invitation) throw new InvitationInvalidError();
      if (await this.staff.emailTaken(manager, invitation.email)) throw new ConflictError('That email already belongs to an account');
      const userId = await this.staff.createStaffCredential(manager, invitation.email, passwordHash);
      await this.staff.setPermissions(manager, userId, invitation.permissions);
      await this.staff.recordAcceptance(manager, invitation.id, userId);
      await AdminAudit.record(manager, {
        actor: { id: userId, email: invitation.email },
        permission: 'staff.manage',
        action: 'staff.accept',
        targetType: 'STAFF',
        targetId: userId,
        reason: `Accepted invitation ${invitation.id}`,
        after: { permissions: invitation.permissions, invitedBy: invitation.invitedBy },
        service: SERVICE,
        correlationId,
      });
      // The profile is created last, inside the transaction: if user-service refuses, nothing above stays.
      await this.userService.createProfile({ userId, email: invitation.email, fullName, phone }, correlationId);
      return { userId, email: invitation.email, permissions: invitation.permissions };
    });
    this.outbox.kick();
    return result;
  }

  async setPermissions(actor: AuditActor, id: string, permissions: StaffPermission[], reason: string): Promise<StaffMember> {
    const next = sortedUnique(permissions);
    const changed = await this.staff.transaction(async (manager) => {
      await this.staff.lock(manager);
      const member = await this.staff.find(manager, id);
      if (!member) throw new NotFoundError(`Staff member ${id} not found`);
      if (same(member.permissions, next)) return false;
      const losesManage = member.permissions.includes('staff.manage') && !next.includes('staff.manage');
      if (losesManage && id === actor.id) throw new ForbiddenError('You cannot remove your own staff.manage');
      if (losesManage && member.status === 'ACTIVE') {
        const managers = await this.staff.activeManagers(manager);
        if (managers.length <= 1) throw new LastSuperAdminError();
      }
      await this.staff.setPermissions(manager, id, next);
      await AdminAudit.record(manager, {
        actor,
        permission: 'staff.manage',
        action: 'staff.permissions_change',
        targetType: 'STAFF',
        targetId: id,
        reason,
        before: { permissions: member.permissions },
        after: { permissions: next },
        service: SERVICE,
      });
      return true;
    });
    if (changed) this.outbox.kick();
    return this.current(id);
  }

  async disable(actor: AuditActor, id: string, reason: string): Promise<StaffMember> {
    if (id === actor.id) throw new ForbiddenError('You cannot disable your own account');
    const changed = await this.staff.transaction(async (manager) => {
      await this.staff.lock(manager);
      const member = await this.staff.find(manager, id);
      if (!member) throw new NotFoundError(`Staff member ${id} not found`);
      if (member.status === 'ACTIVE' && member.permissions.includes('staff.manage')) {
        const managers = await this.staff.activeManagers(manager);
        if (managers.length <= 1) throw new LastSuperAdminError();
      }
      if (!(await this.staff.setStatus(manager, id, 'SUSPENDED', reason))) return false;
      const sessionsRevoked = await this.sessions.revokeAllForCredential(id, 'suspended', undefined, new Date(), manager);
      await AdminAudit.record(manager, {
        actor,
        permission: 'staff.manage',
        action: 'staff.disable',
        targetType: 'STAFF',
        targetId: id,
        reason,
        before: { status: 'ACTIVE' },
        after: { status: 'SUSPENDED', sessionsRevoked },
        service: SERVICE,
      });
      return true;
    });
    if (changed) this.outbox.kick();
    return this.current(id);
  }

  async enable(actor: AuditActor, id: string, reason: string): Promise<StaffMember> {
    const changed = await this.staff.transaction(async (manager) => {
      if (!(await this.staff.find(manager, id))) throw new NotFoundError(`Staff member ${id} not found`);
      if (!(await this.staff.setStatus(manager, id, 'ACTIVE', null))) return false;
      await AdminAudit.record(manager, {
        actor,
        permission: 'staff.manage',
        action: 'staff.enable',
        targetType: 'STAFF',
        targetId: id,
        reason,
        before: { status: 'SUSPENDED' },
        after: { status: 'ACTIVE' },
        service: SERVICE,
      });
      return true;
    });
    if (changed) this.outbox.kick();
    return this.current(id);
  }

  private async current(id: string): Promise<StaffMember> {
    return (await this.staff.transaction((manager) => this.staff.find(manager, id))) as StaffMember;
  }
}

const sortedUnique = (permissions: StaffPermission[]): StaffPermission[] =>
  [...new Set(permissions)].filter((p): p is StaffPermission => (STAFF_PERMISSIONS as readonly string[]).includes(p)).sort();
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
