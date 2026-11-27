import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CurrentUser,
  generateCorrelationId,
  JwtAuthGuard,
  JwtPayload,
  PermissionsGuard,
  RateLimit,
  RateLimitGuard,
  RequirePermissions,
  STAFF_ROLE_TEMPLATES,
} from '@food-delivery/shared';
import { StaffService } from '../services/staff.service';
import { AcceptStaffInvitationDto, InviteStaffDto, SetStaffPermissionsDto, StaffReasonDto } from '../dto/staff.dto';
import { localeFrom } from '../email/verification-email';

const actorOf = (user: JwtPayload) => ({ id: user.sub, email: user.email ?? null });

/** #216: staff accounts, published as /api/admin/auth/staff. Everything needs staff.manage. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, RateLimitGuard)
@Controller('admin/auth/staff')
export class AdminStaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @RequirePermissions('staff.manage')
  @ApiOperation({ summary: 'List staff with their permissions and status (staff.manage)' })
  list() {
    return this.staff.list();
  }

  @Get('role-templates')
  @RequirePermissions('staff.manage')
  @ApiOperation({ summary: 'The permission sets the staff tools offer as roles (staff.manage)' })
  templates() {
    return STAFF_ROLE_TEMPLATES;
  }

  @Post('invitations')
  @RequirePermissions('staff.manage')
  @ApiOperation({ summary: 'Invite someone by email with a set of permissions; the link works once, 48 h (staff.manage)' })
  invite(
    @Body() dto: InviteStaffDto,
    @CurrentUser() user: JwtPayload,
    @Headers('accept-language') acceptLanguage?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    return this.staff.invite(actorOf(user), dto.email, dto.permissions, dto.reason, localeFrom(acceptLanguage), correlationId ?? generateCorrelationId());
  }

  @Patch(':id/permissions')
  @RequirePermissions('staff.manage')
  @ApiOperation({ summary: "Replace a staff member's permissions; applies at their next token refresh (staff.manage)" })
  setPermissions(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: SetStaffPermissionsDto, @CurrentUser() user: JwtPayload) {
    return this.staff.setPermissions(actorOf(user), id, dto.permissions, dto.reason);
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('staff.manage')
  @ApiOperation({ summary: 'Disable a staff account and end its sessions (staff.manage)' })
  disable(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: StaffReasonDto, @CurrentUser() user: JwtPayload) {
    return this.staff.disable(actorOf(user), id, dto.reason);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('staff.manage')
  @ApiOperation({ summary: 'Enable a disabled staff account (staff.manage)' })
  enable(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: StaffReasonDto, @CurrentUser() user: JwtPayload) {
    return this.staff.enable(actorOf(user), id, dto.reason);
  }
}

/** #216: the invitee's side, public (the single-use token is the proof), rate-limited. */
@ApiTags('auth')
@Controller('auth/staff')
export class StaffInvitationController {
  constructor(private readonly staff: StaffService) {}

  @Post('accept-invitation')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  @ApiOperation({ summary: 'Accept a staff invitation: set the password (at least 12 characters), name and phone' })
  accept(@Body() dto: AcceptStaffInvitationDto, @Headers('x-correlation-id') correlationId?: string) {
    return this.staff.accept(dto.token, dto.password, dto.fullName, dto.phone, correlationId ?? generateCorrelationId());
  }
}
