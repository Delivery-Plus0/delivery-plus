import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, JwtAuthGuard, JwtPayload, PermissionsGuard, RateLimitGuard, RequirePermissions } from '@food-delivery/shared';
import { AdminAccountsService } from '../services/admin-accounts.service';

/** Every staff mutation carries a reason for the audit log (ADR 002). */
export class AccountActionReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 300, description: 'Why, for the audit log. A suspension also stores it on the account.' })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

const actorOf = (user: JwtPayload) => ({ id: user.sub, email: user.email ?? null });

/**
 * #215: staff actions on accounts. auth-service owns credentials and sessions, so they live here and
 * the gateway publishes them as /api/admin/auth/users/:id/... (ADR 002: each service owns its admin routes).
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, RateLimitGuard)
@Controller('admin/auth/users')
export class AdminAccountsController {
  constructor(private readonly accounts: AdminAccountsService) {}

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Suspend an account and end its sessions (users.manage)' })
  suspend(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AccountActionReasonDto, @CurrentUser() user: JwtPayload) {
    return this.accounts.suspend(actorOf(user), id, dto.reason);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Reactivate a suspended account (users.manage)' })
  reactivate(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AccountActionReasonDto, @CurrentUser() user: JwtPayload) {
    return this.accounts.reactivate(actorOf(user), id, dto.reason);
  }

  @Post(':id/revoke-sessions')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('users.manage')
  @ApiOperation({ summary: 'Sign the person out everywhere: end every refresh session (users.manage)' })
  revokeSessions(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AccountActionReasonDto, @CurrentUser() user: JwtPayload) {
    return this.accounts.revokeSessions(actorOf(user), id, dto.reason);
  }
}
