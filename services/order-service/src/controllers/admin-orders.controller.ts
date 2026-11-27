import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, PermissionsGuard, RateLimitGuard, RequirePermissions } from '@food-delivery/shared';
import { OrdersService } from '../services/orders.service';
import { AdminListOrdersQueryDto } from '../dto/admin-list-orders-query.dto';

/**
 * #212: staff admin routes. Each service owns its own `/admin` route space; the
 * gateway publishes it as `/api/admin/orders`. Staff JWT (role ADMIN) with the
 * `perms` claim required; SYSTEM tokens answer 401 (PermissionsGuard).
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, RateLimitGuard)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @RequirePermissions('support.read')
  @ApiOperation({
    summary: 'List all orders (staff with support.read)',
    description:
      'Page pagination: page + limit (max 100), explicit filters (id, customerId, restaurantId, status group) and q, which matches a full order id only. sort is createdAt:asc | createdAt:desc.',
  })
  list(@Query() query: AdminListOrdersQueryDto) {
    return this.ordersService.listForAdmin(query);
  }
}
