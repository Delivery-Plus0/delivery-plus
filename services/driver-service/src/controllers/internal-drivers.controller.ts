import { Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { JwtAuthGuard, Roles, RolesGuard, UserRole } from '@food-delivery/shared';
import { DriversRepository } from '../repositories/drivers.repository';

/**
 * Internal only (`/internal/...` is never reached through the gateway). The person page of the staff
 * directory (#214) links a DRIVER account to its driver record.
 */
@ApiExcludeController()
@Controller('internal/drivers')
export class InternalDriversController {
  constructor(private readonly drivers: DriversRepository) {}

  @Get('by-user/:userId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SYSTEM)
  async byUser(@Param('userId', new ParseUUIDPipe()) userId: string, @Req() request: { user?: { sub?: string } }): Promise<{ id: string }> {
    if (request.user?.sub !== 'system:user-service') throw new ForbiddenException('Only user-service links people to drivers');
    const driver = await this.drivers.findByUserId(userId);
    if (!driver) throw new NotFoundException('No driver for this user');
    return { id: driver.id };
  }
}
