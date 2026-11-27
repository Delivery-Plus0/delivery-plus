import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, PermissionsGuard, RateLimitGuard, RequirePermissions } from '@food-delivery/shared';
import { AdminDriversService } from '../services/admin-drivers.service';
import { AdminDriverQueueQueryDto, AdminListDriversQueryDto } from '../dto/admin-drivers.dto';

/** #214: staff driver lists and the driver page, published as /api/admin/drivers. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, RateLimitGuard)
@Controller('admin/drivers')
export class AdminDriversController {
  constructor(private readonly drivers: AdminDriversService) {}

  @Get()
  @RequirePermissions('support.read')
  @ApiOperation({ summary: 'List drivers: status, verification, licences expiring, plate prefix (support.read)' })
  list(@Query() query: AdminListDriversQueryDto) {
    return this.drivers.list(query);
  }

  /** Declared before :id so "queue" is never read as an id. */
  @Get('queue')
  @RequirePermissions('onboarding.review')
  @ApiOperation({ summary: 'Submitted applications waiting for a decision, oldest first (onboarding.review)' })
  queue(@Query() query: AdminDriverQueueQueryDto) {
    return this.drivers.queue(query);
  }

  @Get(':id')
  @RequirePermissions('support.read')
  @ApiOperation({ summary: 'One driver: application, reviews, documents, balance and rating (support.read)' })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.drivers.detail(id);
  }
}
