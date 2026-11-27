import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, PermissionsGuard, RateLimitGuard, RequirePermissions } from '@food-delivery/shared';
import { AdminUsersService } from '../services/admin-users.service';
import { AdminListUsersQueryDto, AdminSearchUsersDto } from '../dto/admin-users.dto';

/** #214: the staff people directory, published as /api/admin/users. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, RateLimitGuard)
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @RequirePermissions('support.read')
  @ApiOperation({ summary: 'List people: role, status, verification, name prefix, creation range (support.read)' })
  list(@Query() query: AdminListUsersQueryDto, @Headers('x-correlation-id') correlationId?: string) {
    return this.users.list(query, correlationId);
  }

  /** POST so the phone or email stays out of URLs and access logs (#217 decision). */
  @Post('search')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('support.read')
  @ApiOperation({ summary: 'Find people by an exact phone or email (support.read)' })
  search(@Body() dto: AdminSearchUsersDto, @Headers('x-correlation-id') correlationId?: string) {
    return this.users.search(dto, correlationId);
  }

  @Get(':id')
  @RequirePermissions('support.read')
  @ApiOperation({ summary: 'One person: profile and account (support.read)' })
  detail(@Param('id', new ParseUUIDPipe()) id: string, @Headers('x-correlation-id') correlationId?: string) {
    return this.users.detail(id, correlationId);
  }
}
