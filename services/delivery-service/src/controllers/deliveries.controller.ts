import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard, CurrentUser, JwtPayload, Roles, RolesGuard, UserRole } from '@food-delivery/shared';
import { DeliveriesService } from '../services/deliveries.service';
import { DriverCardService } from '../services/driver-card.service';
import { CreateDeliveryDto } from '../dto/create-delivery.dto';
import { DriverCurrentDeliveryDto } from '../dto/driver-current-delivery.dto';
import { DriverHistoryPageDto, DriverHistoryQueryDto } from '../dto/driver-delivery-history.dto';
import { DriverHistoryService } from '../services/driver-history.service';

@ApiTags('deliveries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('deliveries')
export class DeliveriesController {
  constructor(
    private readonly deliveriesService: DeliveriesService,
    private readonly driverCards: DriverCardService,
    private readonly driverHistory: DriverHistoryService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a delivery for an order that is READY_FOR_PICKUP' })
  create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateDeliveryDto,
    @Headers('authorization') authHeader: string,
  ) {
    return this.deliveriesService.create({ userId: user.sub, role: user.role, authHeader }, dto);
  }

  @Post(':id/assign')
  @ApiOperation({ summary: 'Auto-assign the next available driver to a delivery' })
  assign(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Headers('authorization') authHeader: string) {
    return this.deliveriesService.assignDriver(id, { userId: user.sub, role: user.role, authHeader });
  }

  @Post(':id/pickup')
  @ApiOperation({ summary: 'Driver marks the order as picked up from the restaurant' })
  pickup(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deliveriesService.pickup(id, user.sub, user.role);
  }

  @Post(':id/start')
  @ApiOperation({ summary: 'Driver starts the delivery run (PICKED_UP -> IN_TRANSIT)' })
  start(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deliveriesService.start(id, user.sub, user.role);
  }

  @Post(':id/complete')
  @ApiOperation({ summary: 'Driver marks the delivery as completed' })
  complete(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.deliveriesService.complete(id, user.sub, user.role);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel a delivery (dispatch role only)' })
  cancel(@Param('id') id: string, @CurrentUser() user: JwtPayload, @Headers('authorization') authHeader: string) {
    return this.deliveriesService.cancel(id, { userId: user.sub, role: user.role, authHeader });
  }

  @Get('me/current')
  @UseGuards(RolesGuard)
  @Roles(UserRole.DRIVER)
  @ApiOperation({ summary: "The calling driver's active delivery: pickup, drop-off, order summary and next actions" })
  @ApiOkResponse({ type: DriverCurrentDeliveryDto })
  @ApiNoContentResponse({ description: 'The driver has no active delivery (or no driver profile yet)' })
  async getMyCurrent(
    @Headers('authorization') authHeader: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DriverCurrentDeliveryDto | undefined> {
    const current = await this.deliveriesService.getCurrentForDriver(authHeader);
    if (!current) {
      res.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return current;
  }

  @Get('me/history')
  @UseGuards(RolesGuard)
  @Roles(UserRole.DRIVER)
  @ApiOperation({
    summary: "The calling driver's deliveries, newest first (#142)",
    description:
      'Filter with status=active|completed|cancelled. The driver comes from the token only. Rows carry stage times, the restaurant name and an order summary with the drop-off address (no customer name, phone, notes or coordinates).',
  })
  @ApiOkResponse({ type: DriverHistoryPageDto })
  getMyHistory(@Headers('authorization') authHeader: string, @Query() query: DriverHistoryQueryDto): Promise<DriverHistoryPageDto> {
    return this.driverHistory.getForDriver(authHeader, query);
  }

  @Get('by-order/:orderId')
  @ApiOperation({
    summary: 'Get the delivery for an order (order owner, its restaurant owner, the assigned driver, or admin)',
    description:
      'Includes `driver`: a customer-safe card (first name, photo, vehicle, plate) once a driver is assigned, null otherwise or when it cannot be composed (#140).',
  })
  async getByOrderId(
    @Param('orderId') orderId: string,
    @CurrentUser() user: JwtPayload,
    @Headers('authorization') authHeader: string,
  ) {
    // Authorization happens in getByOrderId; the card is only added to a delivery the reader may see.
    const delivery = await this.deliveriesService.getByOrderId(orderId, { userId: user.sub, role: user.role, authHeader });
    const driver = delivery.driverId ? await this.driverCards.getCard(delivery.driverId) : null;
    return { ...delivery, driver };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a delivery by id (order owner, its restaurant owner, the assigned driver, or admin)' })
  getById(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Headers('authorization') authHeader: string,
  ) {
    return this.deliveriesService.getById(id, { userId: user.sub, role: user.role, authHeader });
  }
}
