import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, UserRole } from '@food-delivery/shared';
import { TrackingService } from '../services/tracking.service';
import { UpdateLocationDto } from '../dto/update-location.dto';

@ApiTags('tracking')
@Controller('tracking')
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Post('location')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Report the current driver location' })
  updateLocation(@CurrentUser() user: JwtPayload, @Body() dto: UpdateLocationDto) {
    return this.trackingService.updateLocation(user.sub, dto);
  }

  @Get('driver/:userId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER, UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Get a driver's last reported location (the driver themself or admin). Customers use /tracking/delivery/:id",
  })
  getDriverLocation(@Param('userId') userId: string, @CurrentUser() user: JwtPayload) {
    return this.trackingService.getDriverLocation(userId, user);
  }

  @Get('delivery/:deliveryId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get combined delivery status + driver location' })
  getDeliveryTracking(
    @Param('deliveryId') deliveryId: string,
    @Headers('authorization') authHeader: string,
  ) {
    return this.trackingService.getDeliveryTracking(deliveryId, authHeader);
  }
}
