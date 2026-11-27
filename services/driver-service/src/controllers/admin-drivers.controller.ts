import { Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtAuthGuard, JwtPayload, PermissionsGuard, RateLimit, RateLimitGuard, RequirePermissions } from '@food-delivery/shared';
import { AdminDriversService } from '../services/admin-drivers.service';
import { DriverApplicationService } from '../services/driver-application.service';
import { AdminDriverQueueQueryDto, AdminListDriversQueryDto } from '../dto/admin-drivers.dto';

/** #214: staff driver lists and the driver page, published as /api/admin/drivers. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, RateLimitGuard)
@Controller('admin/drivers')
export class AdminDriversController {
  constructor(
    private readonly drivers: AdminDriversService,
    private readonly applications: DriverApplicationService,
  ) {}

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

  /**
   * #323: a 5-minute URL to one of the driver's current documents, for the admin console's documents
   * viewer. The same call as POST /drivers/:id/documents/:type/read-url: every read is recorded in
   * driver_document_access, and neither the URL nor the key is logged. A POST so the read is never
   * cached or prefetched; it changes nothing, so it needs no reason.
   */
  @Post(':id/documents/:type/read-url')
  @RequirePermissions('onboarding.review')
  @RateLimit({ limit: 60, windowSeconds: 60 })
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @ApiOperation({ summary: "A 5-minute URL to view one of the driver's documents; every read is recorded (onboarding.review)" })
  documentReadUrl(@CurrentUser() user: JwtPayload, @Param('id', new ParseUUIDPipe()) id: string, @Param('type') type: string) {
    return this.applications.createReadUrl(user.sub, id, type);
  }
}
