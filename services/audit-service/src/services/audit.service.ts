import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ADMIN_ACTION_EVENT_TYPE,
  AdminActionEvent,
  AdminActionPayload,
  KafkaConsumerService,
  PaginatedResult,
  TOPICS,
} from '@food-delivery/shared';
import { AuditEventsRepository } from '../repositories/audit-events.repository';
import { AuditEvent } from '../entities/audit-event.entity';
import { ListAuditQueryDto } from '../dto/list-audit-query.dto';

/** Consumes `admin.actions` (#213) and serves the staff audit log. */
@Injectable()
export class AuditService implements OnModuleInit {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly events: AuditEventsRepository,
    private readonly kafkaConsumer: KafkaConsumerService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.kafkaConsumer.subscribe<AdminActionPayload>(TOPICS.ADMIN_ACTIONS, ADMIN_ACTION_EVENT_TYPE, (event) =>
      this.record(event),
    );
    await this.kafkaConsumer.start();
  }

  /** Idempotent on eventId, on top of the consumer's durable idempotency. */
  async record(event: AdminActionEvent): Promise<void> {
    const stored = await this.events.append(event);
    // Ids and the action only: the reason and the before/after values stay in the table, not in logs.
    this.logger.log(
      `${stored ? 'audit.recorded' : 'audit.duplicate'} event=${event.eventId} action=${event.payload.action} target=${event.payload.targetType}:${event.payload.targetId} actor=${event.payload.actorId}`,
    );
  }

  async list(query: ListAuditQueryDto): Promise<PaginatedResult<AuditEvent>> {
    const [items, total] = await this.events.list(query);
    return { items, page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) || 1 };
  }
}
