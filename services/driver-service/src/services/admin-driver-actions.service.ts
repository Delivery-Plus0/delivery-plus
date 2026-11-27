import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminAudit, AppError, AuditActor, NotFoundError } from '@food-delivery/shared';
import { DriverApplicationRepository, UndoDriverOnDeliveryError, UndoNotAllowedError, UndoWindowClosedError } from '../repositories/driver-application.repository';
import { DriversRepository, DriverStatusChange } from '../repositories/drivers.repository';
import { Driver } from '../entities/driver.entity';
import { OutboxRelayService } from '../common/outbox.module';
import { DriverApplicationService, StaffDriverApplicationView } from './driver-application.service';
import { AdminReviewDriverDto } from '../dto/admin-driver-actions.dto';

const SERVICE = 'driver-service';
/** #318 (owner decision): how long after a decision its reviewer can undo it. */
export const REVIEW_UNDO_WINDOW_SECONDS = 10;

export class ReviewUndoRefusedError extends AppError {
  constructor(code: 'UndoNotAllowed' | 'UndoWindowClosed' | 'DriverOnDelivery', message: string) {
    super(409, code, message);
  }
}

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
    private readonly applicationRows: DriverApplicationRepository,
  ) {}

  /**
   * #318: the queue's Undo. The reviewer withdraws their own decision within 10 seconds; the
   * application is back in review, audited, and the driver is told. A repeat is a no-op.
   */
  async undoReview(actor: AuditActor, driverId: string, reason: string): Promise<{ driverId: string; undone: boolean }> {
    try {
      const outcome = await this.applicationRows.undoDecision(driverId, actor.id, REVIEW_UNDO_WINDOW_SECONDS, async (manager, driver, withdrawn) => {
        await AdminAudit.record(manager, {
          actor,
          permission: 'onboarding.review',
          action: 'driver.review_undo',
          targetType: 'DRIVER',
          targetId: driverId,
          reason,
          before: { verificationStatus: withdrawn },
          after: { verificationStatus: 'PENDING' },
          service: SERVICE,
          notify: { userId: driver.userId, messageKey: 'driver.review_withdrawn' },
        });
      });
      if (outcome === 'undone') this.outbox.kick();
      return { driverId, undone: outcome === 'undone' };
    } catch (error) {
      if (error instanceof UndoWindowClosedError) throw new ReviewUndoRefusedError('UndoWindowClosed', `A decision can only be undone within ${REVIEW_UNDO_WINDOW_SECONDS} seconds`);
      if (error instanceof UndoDriverOnDeliveryError) throw new ReviewUndoRefusedError('DriverOnDelivery', 'The driver already took a delivery; suspend them instead');
      if (error instanceof UndoNotAllowedError) throw new ReviewUndoRefusedError('UndoNotAllowed', 'Only your own latest decision on this driver can be undone');
      throw error;
    }
  }

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
