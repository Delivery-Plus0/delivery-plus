import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AdminAudit, AuditActor, NotFoundError } from '@food-delivery/shared';
import { RestaurantsRepository } from '../repositories/restaurants.repository';
import { OutboxRelayService } from '../common/outbox.module';
import { RestaurantsService, StaffRestaurantApplicationDto } from './restaurants.service';
import { AdminReviewRestaurantDto } from '../dto/admin-restaurant-actions.dto';

const SERVICE = 'restaurant-service';

export interface RestaurantActionResult {
  restaurant: { id: string; status: string };
  changed: boolean;
}

/**
 * #215: staff decisions on restaurants. Each one changes the restaurant and stages its audit event
 * (with the owner's notice) in one transaction; repeating an action is a no-op that records nothing.
 * The cached copy is dropped right after, so customers see the change at once.
 */
@Injectable()
export class AdminRestaurantActionsService {
  constructor(
    private readonly restaurants: RestaurantsRepository,
    private readonly restaurantsService: RestaurantsService,
    private readonly outbox: OutboxRelayService,
  ) {}

  async review(actor: AuditActor, id: string, dto: AdminReviewRestaurantDto): Promise<StaffRestaurantApplicationDto> {
    const approve = dto.decision === 'APPROVED';
    const view = await this.restaurantsService.review(actor.id, id, dto, async (manager, restaurant) => {
      await AdminAudit.record(manager, {
        actor,
        permission: 'onboarding.review',
        action: approve ? 'restaurant.approve' : 'restaurant.reject',
        targetType: 'RESTAURANT',
        targetId: id,
        reason: dto.reason,
        before: { approvalStatus: restaurant.approvalStatus },
        after: { approvalStatus: dto.decision, note: dto.note ?? null },
        service: SERVICE,
        notify: {
          userId: restaurant.ownerId,
          messageKey: approve ? 'restaurant.application_approved' : 'restaurant.application_rejected',
          params: { restaurantName: restaurant.name, ...(dto.note ? { note: dto.note } : {}) },
        },
      });
    });
    this.outbox.kick();
    return view;
  }

  /** Any status → SUSPENDED; the restaurant disappears from customers at once (#215 owner decision). */
  suspend(actor: AuditActor, id: string, reason: string): Promise<RestaurantActionResult> {
    return this.act(actor, id, reason, 'restaurant.suspend', 'restaurant.suspended', (manager) => this.restaurants.suspend(manager, id));
  }

  /** SUSPENDED → CLOSED; the owner opens it when ready. */
  reactivate(actor: AuditActor, id: string, reason: string): Promise<RestaurantActionResult> {
    return this.act(actor, id, reason, 'restaurant.reactivate', 'restaurant.reactivated', (manager) => this.restaurants.reactivate(manager, id));
  }

  private async act(
    actor: AuditActor,
    id: string,
    reason: string,
    action: string,
    messageKey: string,
    change: (manager: EntityManager) => Promise<{ before: { status: string }; after: { status: string } } | null>,
  ): Promise<RestaurantActionResult> {
    const restaurant = await this.restaurants.findById(id);
    if (!restaurant) throw new NotFoundError(`Restaurant ${id} not found`);
    const changed = await this.restaurants.transaction(async (manager) => {
      const result = await change(manager);
      if (!result) return false;
      await AdminAudit.record(manager, {
        actor,
        permission: 'ops.act',
        action,
        targetType: 'RESTAURANT',
        targetId: id,
        reason,
        before: result.before,
        after: result.after,
        service: SERVICE,
        notify: { userId: restaurant.ownerId, messageKey, params: { restaurantName: restaurant.name } },
      });
      return true;
    });
    await this.restaurantsService.forget(id);
    if (changed) this.outbox.kick();
    const current = await this.restaurants.findById(id);
    return { restaurant: { id, status: current?.status ?? restaurant.status }, changed };
  }
}
