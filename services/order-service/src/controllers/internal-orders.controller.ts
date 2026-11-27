import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { JwtAuthGuard, Roles, RolesGuard, UserRole } from '@food-delivery/shared';
import { OrdersRepository } from '../repositories/orders.repository';

/**
 * Internal only (`/internal/...` is never reached through the gateway). restaurant-service's staff
 * restaurant page (#214) shows how many orders the restaurant received today.
 */
@ApiExcludeController()
@Controller('internal/orders')
export class InternalOrdersController {
  constructor(private readonly orders: OrdersRepository) {}

  @Get('restaurants/:restaurantId/today')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SYSTEM)
  async today(
    @Param('restaurantId', new ParseUUIDPipe()) restaurantId: string,
    @Req() request: { user?: { sub?: string } },
  ): Promise<{ restaurantId: string; ordersToday: number }> {
    if (request.user?.sub !== 'system:restaurant-service') throw new ForbiddenException('Only restaurant-service reads this');
    return { restaurantId, ordersToday: await this.orders.countTodayForRestaurant(restaurantId) };
  }
}
