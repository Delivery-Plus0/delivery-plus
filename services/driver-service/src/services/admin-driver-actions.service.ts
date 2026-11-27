import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminAudit, AuditActor, NotFoundError } from '@food-delivery/shared';
import { DriversRepository, DriverStatusChange } from '../repositories/drivers.repository';
import { Driver } from '../entities/driver.entity';
import { OutboxRelayService } from '../common/outbox.module';
import { DriverApplicationService, StaffDriverApplicationView } from './driver-application.service';
import { AdminReviewDriverDto } from '../dto/admin-driver-actions.dto';

const SERVICE = 'driver-service';

/** The outcome of a suspend or reactivate: the driver now, and whether this request changed anything. */
export interface DriverActionResult {
  driver: Pick<Driver, 'id' | 'status' | 'suspensionRequestedAt'>;
  changed: boolean;
}

/**
 * #215: staff decisions on drivers. Each one changes the driver and stages its audit event (with the
 * driver's notice) in one transaction; repeating an action is a no-op that records nothing.
 */
@Injectable()
export class AdminDriverActionsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly drivers: DriversRepository,
    private readonly applications: DriverApplicationService,
    private readonly outbox: OutboxRelayService,
  ) {}

  /** Approve (VERIFIED) or reject the submission the reviewer looked at (#207 compare-and-set). */
  async review(actor: AuditActor, driverId: string, dto: AdminReviewDriverDto): Promise<StaffDriverApplicationView> {
    const approve = dto.decision === 'VERIFIED';
    const view = await this.applications.review(actor.id, driverId, dto, new Date(), async (manager, driver) => {
      await AdminAudit.record(manager, {
        actor,
        permission: 'onboarding.review',
        action: approve ? 'driver.approve' : 'driver.reject',
        targetType: 'DRIVER',
        targetId: driverId,
        reason: dto.reason,
        before: { verificationStatus: driver.verificationStatus },
        after: { verificationStatus: dto.decision, note: dto.note ?? null },
        service: SERVICE,
        notify: {
          userId: driver.userId,
          messageKey: approve ? 'driver.application_approved' : 'driver.application_rejected',
          ...(dto.note ? { params: { note: dto.note } } : {}),
        },
      });
    });
    this.outbox.kick();
    return view;
  }

  /** SUSPENDED now when off duty; a BUSY driver finishes the current delivery first. */
  suspend(actor: AuditActor, driverId: string, reason: string): Promise<DriverActionResult> {
    return this.act(actor, driverId, reason, 'driver.suspend', 'driver.suspended', (manager) => this.drivers.suspend(manager, driverId));
  }

  /** SUSPENDED → OFFLINE (the driver goes online again themselves), or a pending suspension withdrawn. */
  reactivate(actor: AuditActor, driverId: string, reason: string): Promise<DriverActionResult> {
    return this.act(actor, driverId, reason, 'driver.reactivate', 'driver.reactivated', (manager) => this.drivers.reactivate(manager, driverId));
  }

  private async act(
    actor: AuditActor,
    driverId: string,
    reason: string,
    action: string,
    messageKey: string,
    change: (manager: import('typeorm').EntityManager) => Promise<DriverStatusChange | null>,
  ): Promise<DriverActionResult> {
    const driver = await this.drivers.findById(driverId);
    if (!driver) throw new NotFoundError(`Driver ${driverId} not found`);
    const changed = await this.dataSource.transaction(async (manager) => {
      const result = await change(manager);
      if (!result) return false;
      await AdminAudit.record(manager, {
        actor,
        permission: 'ops.act',
        action,
        targetType: 'DRIVER',
        targetId: driverId,
        reason,
        before: result.before,
        after: result.after,
        service: SERVICE,
        notify: { userId: driver.userId, messageKey },
      });
      return true;
    });
    if (changed) this.outbox.kick();
    const current = (await this.drivers.findById(driverId)) as Driver;
    return { driver: { id: current.id, status: current.status, suspensionRequestedAt: current.suspensionRequestedAt }, changed };
  }
}
