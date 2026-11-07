import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  JwtAuthGuard,
  JwtPayload,
  PermissionsGuard,
  RateLimit,
  RateLimitGuard,
  RequirePermissions,
  Roles,
  RolesGuard,
  UserRole,
} from '@food-delivery/shared';
import { DriversService } from '../services/drivers.service';
import { DriverApplicationService } from '../services/driver-application.service';
import {
  ConfirmDocumentUploadDto,
  RequestDocumentUploadDto,
  SaveDriverApplicationDto,
} from '../dto/driver-application.dto';

/**
 * The driver application (#207). The `me/…` routes are declared before the staff `:id/…` routes so
 * `me` is never read as a driver id.
 */
@ApiTags('driver-application')
@ApiBearerAuth()
@Controller('drivers')
export class DriverApplicationController {
  constructor(
    private readonly drivers: DriversService,
    private readonly applications: DriverApplicationService,
  ) {}

  @Get('me/application')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER)
  @ApiOperation({ summary: 'Your application: status, fields, uploaded documents (no URLs) and what is missing' })
  async getMine(@CurrentUser() user: JwtPayload) {
    return this.applications.getApplication((await this.drivers.getByUserId(user.sub)).id);
  }

  @Put('me/application')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER)
  @ApiOperation({ summary: 'Save your national ID and licence expiry dates (draft only; 409 NationalIdAlreadyRegistered, 409 ApplicationNotEditable)' })
  async saveMine(@CurrentUser() user: JwtPayload, @Body() dto: SaveDriverApplicationDto) {
    return this.applications.saveApplication((await this.drivers.getByUserId(user.sub)).id, dto);
  }

  @Post('me/documents/:type/upload-url')
  @UseGuards(JwtAuthGuard, RolesGuard, RateLimitGuard)
  @Roles(UserRole.DRIVER)
  @RateLimit({ limit: 20, windowSeconds: 3600 })
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Get a presigned POST to upload one document (JPEG, PNG or PDF, up to 10 MB; draft only)' })
  async createUpload(@CurrentUser() user: JwtPayload, @Param('type') type: string, @Body() dto: RequestDocumentUploadDto) {
    return this.applications.createUpload((await this.drivers.getByUserId(user.sub)).id, type, dto.contentType);
  }

  @Post('me/documents/:type/confirm')
  @UseGuards(JwtAuthGuard, RolesGuard, RateLimitGuard)
  @Roles(UserRole.DRIVER)
  @RateLimit({ limit: 30, windowSeconds: 3600 })
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm an upload: the file is checked and becomes the current version of the document (draft only)' })
  async confirmUpload(@CurrentUser() user: JwtPayload, @Param('type') type: string, @Body() dto: ConfirmDocumentUploadDto) {
    return this.applications.confirmUpload((await this.drivers.getByUserId(user.sub)).id, type, dto.objectKey);
  }

  @Post('me/application/submit')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.DRIVER)
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a complete application for review (422 ApplicationIncomplete with what is missing)' })
  async submitMine(@CurrentUser() user: JwtPayload) {
    return this.applications.submit((await this.drivers.getByUserId(user.sub)).id);
  }

  @Get(':id/application')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles(UserRole.ADMIN)
  @RequirePermissions('onboarding.review')
  @ApiOperation({ summary: "A driver's application (staff with onboarding.review)" })
  getForStaff(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.applications.getApplication(id);
  }

  @Post(':id/documents/:type/read-url')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, RateLimitGuard)
  @Roles(UserRole.ADMIN)
  @RequirePermissions('onboarding.review')
  @RateLimit({ limit: 60, windowSeconds: 60 })
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @ApiOperation({ summary: "A 5-minute URL to view a driver's document (staff with onboarding.review; every read is recorded)" })
  createReadUrl(
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('type') type: string,
  ) {
    return this.applications.createReadUrl(user.sub, id, type);
  }
}
