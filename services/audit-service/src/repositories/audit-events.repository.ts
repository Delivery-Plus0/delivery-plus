import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, FindOptionsWhere, LessThan, MoreThanOrEqual, Repository } from 'typeorm';
import { AdminActionEvent } from '@food-delivery/shared';
import { AuditEvent } from '../entities/audit-event.entity';
import { ListAuditQueryDto } from '../dto/list-audit-query.dto';

@Injectable()
export class AuditEventsRepository {
  constructor(@InjectRepository(AuditEvent) private readonly repo: Repository<AuditEvent>) {}

  /** Stores the event once: a redelivery (same eventId) is a no-op. Returns whether it was new. */
  async append(event: AdminActionEvent): Promise<boolean> {
    const p = event.payload;
    const rows: { id: string }[] = await this.repo.query(
      `INSERT INTO "audit_events"
         ("id", "actorId", "actorEmail", "permission", "action", "targetType", "targetId", "reason",
          "before", "after", "service", "correlationId", "occurredAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT ("id") DO NOTHING
       RETURNING "id"`,
      [
        event.eventId,
        p.actorId,
        p.actorEmail ?? null,
        p.permission,
        p.action,
        p.targetType,
        p.targetId,
        p.reason,
        p.before ? JSON.stringify(p.before) : null,
        p.after ? JSON.stringify(p.after) : null,
        p.service,
        event.correlationId,
        p.occurredAt,
      ],
    );
    return rows.length > 0;
  }

  async list(query: ListAuditQueryDto): Promise<[AuditEvent[], number]> {
    const where: FindOptionsWhere<AuditEvent> = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.targetType) where.targetType = query.targetType;
    if (query.targetId) where.targetId = query.targetId;
    if (query.action) where.action = query.action;
    if (query.from && query.to) where.occurredAt = And(MoreThanOrEqual(new Date(query.from)), LessThan(new Date(query.to)));
    else if (query.from) where.occurredAt = MoreThanOrEqual(new Date(query.from));
    else if (query.to) where.occurredAt = LessThan(new Date(query.to));

    return this.repo.findAndCount({
      where,
      order: { occurredAt: 'DESC', id: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
  }
}
