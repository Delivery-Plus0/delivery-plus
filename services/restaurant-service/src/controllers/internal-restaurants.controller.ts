import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { JwtAuthGuard, Roles, RolesGuard, UserRole } from '@food-delivery/shared';
import { RestaurantsRepository } from '../repositories/restaurants.repository';

/**
 * Internal only (`/internal/...` is never reached through the gateway). The person page of the staff
 * directory (#214) links a RESTAURANT_OWNER account to the restaurant it owns.
 */
@ApiExcludeController()
@Controller('internal/restaurants')
export class InternalRestaurantsController {
  constructor(private readonly restaurants: RestaurantsRepository) {}

  @Get('by-owner/:ownerId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SYSTEM)
  async byOwner(@Param('ownerId', new ParseUUIDPipe()) ownerId: string, @Req() request: { user?: { sub?: string } }): Promise<{ ids: string[] }> {
    if (request.user?.sub !== 'system:user-service') throw new ForbiddenException('Only user-service links people to restaurants');
    return { ids: (await this.restaurants.findByOwner(ownerId)).map((restaurant) => restaurant.id) };
  }
}
