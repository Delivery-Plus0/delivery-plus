import { randomUUID } from 'node:crypto';
import { BaseEvent } from '../events/base-event';
import { TOPICS } from '../events/topics';
import { SqlExecutor, stageEvent } from '../outbox/outbox';

/**
 * The staff audit log (#213). Every admin mutation records one event in the same database
 * transaction as the change, through the service's transactional outbox (#98). audit-service
 * consumes `admin.actions` and stores it append-only.
 */

export const ADMIN_ACTION_EVENT_TYPE = 'admin.action';

/** What the staff member acted on. */
export type AuditTargetType = 'USER' | 'DRIVER' | 'RESTAURANT' | 'ORDER' | 'DELIVERY' | 'PAYMENT' | 'MENU_ITEM' | 'STAFF';

/** The staff member behind an admin request: the JWT of a PermissionsGuard-protected route. */
export interface AuditActor {
  /** `sub` of the staff token. */
  id: string;
  email?: string | null;
}

export interface AdminActionPayload {
  actorId: string;
  actorEmail: string | null;
  /** The staff permission the route required, e.g. `onboarding.review`. */
  permission: string;
  /** Dotted verb, e.g. `driver.approve`, `user.suspend`. */
  action: string;
  targetType: AuditTargetType;
  targetId: string;
  /** Required on every admin mutation (ADR 002). */
  reason: string;
  /** Only the fields the action changed, redacted. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** The service that made the change. */
  service: string;
  occurredAt: string;
  /**
   * #215: the person told about the action in the app (notification-service consumes the same event,
   * so an action gives exactly one audit row and one notification). Params never hold personal data.
   */
  notify?: AdminActionNotice;
}

/** An in-app notice of a staff action, rendered by its message key (#151) in the reader's language. */
export interface AdminActionNotice {
  userId: string;
  messageKey: string;
  params?: Record<string, string>;
}

export type AdminActionEvent = BaseEvent<AdminActionPayload>;

export interface AdminAuditInput {
  actor: AuditActor;
  permission: string;
  action: string;
  targetType: AuditTargetType;
  targetId: string;
  reason: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  service: string;
  correlationId?: string;
  /** Pass a deterministic id when the action can be retried; a retry is then one event, not two. */
  eventId?: string;
  occurredAt?: Date;
  notify?: AdminActionNotice;
}

export const REDACTED = '[redacted]';

/**
 * Keys whose values never enter the audit log: secrets and credentials, verification codes, private
 * document locations (any `...Url`/`...Key` of a stored object), and phone numbers, which the
 * project never writes to a log (CLAUDE.md).
 */
const SECRET_KEY = /(password|passcode|secret|token|hash|^otp|verificationcode|apikey|api_key|signature|url$|uri$|documentkey|objectkey|^key$|phone)/i;

/** Replaces secret values with REDACTED, recursively; other values are kept as they are. */
export function redactAuditFields(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => redactAuditFields(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? REDACTED : redactAuditFields(item, depth + 1),
    ]),
  );
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Keeps only the fields that differ between `before` and `after`, redacted. Without a `before`
 * (a creation), `after` is kept whole; without an `after` (a removal), `before` is.
 */
export function auditDiff(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): { before?: Record<string, unknown>; after?: Record<string, unknown> } {
  if (!before && !after) return {};
  if (!before) return { after: redactAuditFields(after) as Record<string, unknown> };
  if (!after) return { before: redactAuditFields(before) as Record<string, unknown> };
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => !same(before[key], after[key]));
  if (keys.length === 0) return {};
  const pick = (source: Record<string, unknown>) =>
    redactAuditFields(Object.fromEntries(keys.map((key) => [key, source[key] ?? null]))) as Record<string, unknown>;
  return { before: pick(before), after: pick(after) };
}

/** Builds the event without staging it (tests and the contract check use this). */
export function buildAdminActionEvent(input: AdminAuditInput): AdminActionEvent {
  if (!input.reason?.trim()) throw new Error(`Admin action ${input.action} needs a reason (ADR 002)`);
  if (!input.actor?.id) throw new Error(`Admin action ${input.action} needs the staff actor`);
  const occurredAt = (input.occurredAt ?? new Date()).toISOString();
  return {
    eventId: input.eventId ?? randomUUID(),
    eventType: ADMIN_ACTION_EVENT_TYPE,
    timestamp: occurredAt,
    correlationId: input.correlationId ?? randomUUID(),
    payload: {
      actorId: input.actor.id,
      actorEmail: input.actor.email ?? null,
      permission: input.permission,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason.trim(),
      ...auditDiff(input.before, input.after),
      service: input.service,
      occurredAt,
      ...(input.notify ? { notify: input.notify } : {}),
    },
  };
}

export const AdminAudit = {
  /**
   * Stages the audit event in the caller's transaction (`tx` is the TypeORM EntityManager of the
   * mutation). If the transaction rolls back, no event exists; if it commits, the outbox relay
   * publishes it even after a crash. Call it inside the same `transaction(...)` as the change.
   */
  async record(tx: SqlExecutor, input: AdminAuditInput): Promise<AdminActionEvent> {
    const event = buildAdminActionEvent(input);
    await stageEvent(tx, TOPICS.ADMIN_ACTIONS, event);
    return event;
  },
};
