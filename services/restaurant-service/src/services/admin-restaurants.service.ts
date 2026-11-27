import { Injectable } from '@nestjs/common';
import { AdminAudit, AuditActor, maskPhone, NotFoundError, PaginatedResult } from '@food-delivery/shared';
import { OutboxRelayService } from '../common/outbox.module';
import { RestaurantsRepository } from '../repositories/restaurants.repository';
import { Restaurant } from '../entities/restaurant.entity';
import { MenuReadiness, MenuServiceClient } from '../common/menu-service.client';
import { StaffLookupsClient } from '../common/staff-lookups.client';
import { RestaurantsService, StaffRestaurantApplicationDto } from './restaurants.service';
import { AdminListRestaurantsQueryDto, AdminRestaurantQueueQueryDto } from '../dto/admin-restaurants.dto';

/** One row of the staff restaurant list (#214). `ownerName` is null when user-service doesn't answer. */
export interface StaffRestaurantRow {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string | null;
  status: Restaurant['status'];
  approvalStatus: Restaurant['approvalStatus'];
  address: string;
  latitude: number | null;
  longitude: number | null;
  deliveryRadiusKm: string | null;
  contactPhone: string | null;
  submittedAt: Date | null;
  approvedAt: Date | null;
  createdAt: Date;
}

/**
 * The staff restaurant page (#214): the application with its review history, the owner, the menu
 * counts (from the public menu) and today's orders (order-service). A part whose service doesn't
 * answer is null.
 */
export interface StaffRestaurantDetail {
  restaurant: StaffRestaurantRow;
  application: StaffRestaurantApplicationDto;
  menu: MenuReadiness | null;
  ordersToday: number | null;
}

@Injectable()
export class AdminRestaurantsService {
  constructor(
    private readonly restaurants: RestaurantsRepository,
    private readonly restaurantsService: RestaurantsService,
    private readonly menu: MenuServiceClient,
    private readonly lookups: StaffLookupsClient,
    private readonly outbox: OutboxRelayService,
  ) {}

  /** #317: the contact phone of one restaurant, recorded as a `pii.reveal` audit event (never the value). */
  async revealContactPhone(actor: AuditActor, id: string, reason: string): Promise<{ field: 'contactPhone'; value: string | null }> {
    const restaurant = await this.restaurants.findById(id);
    if (!restaurant) throw new NotFoundError(`Restaurant ${id} not found`);
    await this.restaurants.transaction((manager) =>
      AdminAudit.record(manager, {
        actor,
        permission: 'support.read',
        action: 'pii.reveal',
        targetType: 'RESTAURANT',
        targetId: id,
        reason,
        after: { field: 'contactPhone' },
        service: 'restaurant-service',
      }),
    );
    this.outbox.kick();
    return { field: 'contactPhone', value: restaurant.contactPhone ?? null };
  }

  async list(query: AdminListRestaurantsQueryDto): Promise<PaginatedResult<StaffRestaurantRow>> {
    const near =
      query.nearLat !== undefined && query.nearLng !== undefined && query.withinKm !== undefined
        ? { latitude: query.nearLat, longitude: query.nearLng, withinKm: query.withinKm }
        : undefined;
    const [rows, total] = await this.restaurants.findForAdmin(
      { approvalStatus: query.approvalStatus, status: query.status, namePrefix: query.q, near },
      query.page,
      query.limit,
    );
    return this.page(rows, total, query.page, query.limit);
  }

  async queue(query: AdminRestaurantQueueQueryDto): Promise<PaginatedResult<StaffRestaurantRow>> {
    const [rows, total] = await this.restaurants.findForAdmin({ queue: true }, query.page, query.limit);
    return this.page(rows, total, query.page, query.limit);
  }

  async search(phone: string): Promise<{ items: StaffRestaurantRow[] }> {
    const rows = await this.restaurants.findByContactPhone(phone);
    const names = await this.lookups.names(rows.map((row) => row.ownerId));
    return { items: rows.map((row) => toRow(row, names)) };
  }

  async detail(id: string): Promise<StaffRestaurantDetail> {
    const application = await this.restaurantsService.getApplicationForStaff(id); // 404s an unknown id
    const restaurant = (await this.restaurants.findById(id)) as Restaurant;
    const [names, menu, ordersToday] = await Promise.all([
      this.lookups.names([restaurant.ownerId]),
      this.menu.menuReadiness(id).catch(() => null),
      this.lookups.ordersToday(id),
    ]);
    return { restaurant: toRow(restaurant, names), application, menu, ordersToday };
  }

  private async page(rows: Restaurant[], total: number, page: number, limit: number): Promise<PaginatedResult<StaffRestaurantRow>> {
    const names = await this.lookups.names(rows.map((row) => row.ownerId));
    return { items: rows.map((row) => toRow(row, names)), page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
  }
}

const toRow = (restaurant: Restaurant, names: Map<string, string> | null): StaffRestaurantRow => ({
  id: restaurant.id,
  name: restaurant.name,
  ownerId: restaurant.ownerId,
  ownerName: names?.get(restaurant.ownerId) ?? null,
  status: restaurant.status,
  approvalStatus: restaurant.approvalStatus,
  address: restaurant.address,
  latitude: restaurant.latitude,
  longitude: restaurant.longitude,
  deliveryRadiusKm: restaurant.deliveryRadiusKm,
  // #317 (owner decision): masked; POST /admin/restaurants/:id/reveal shows it, audited.
  contactPhone: maskPhone(restaurant.contactPhone),
  submittedAt: restaurant.submittedAt,
  approvedAt: restaurant.approvedAt,
  createdAt: restaurant.createdAt,
});
