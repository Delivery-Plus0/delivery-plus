import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtAuthGuard, JwtPayload, PermissionsGuard, RateLimitGuard, RequirePermissions } from '@food-delivery/shared';
import { AdminDriverActionsService } from '../services/admin-driver-actions.service';
import { AdminReasonDto, AdminReviewDriverDto } from '../dto/admin-driver-actions.dto';

const actorOf = (user: JwtPayload) => ({ id: user.sub, email: user.email ?? null });

/** #215: staff decisions on drivers, published as /api/admin/drivers/:id/... Every one is audited. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, RateLimitGuard)
@Controller('admin/drivers')
export class AdminDriverActionsController {
  constructor(private readonly actions: AdminDriverActionsService) {}

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('onboarding.review')
  @ApiOperation({ summary: "Approve or reject the driver's submitted application (onboarding.review)" })
  review(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AdminReviewDriverDto, @CurrentUser() user: JwtPayload) {
    return this.actions.review(actorOf(user), id, dto);
  }

  @Post(':id/review/undo')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('onboarding.review')
  @ApiOperation({ summary: 'Undo your own review decision within 10 seconds; audited, the driver is told (onboarding.review)' })
  undoReview(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AdminReasonDto, @CurrentUser() user: JwtPayload) {
    return this.actions.undoReview(actorOf(user), id, dto.reason);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ops.act')
  @ApiOperation({ summary: 'Suspend a driver; one on a delivery finishes it first (ops.act)' })
  suspend(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AdminReasonDto, @CurrentUser() user: JwtPayload) {
    return this.actions.suspend(actorOf(user), id, dto.reason);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ops.act')
  @ApiOperation({ summary: 'Reactivate a suspended driver, or withdraw a pending suspension (ops.act)' })
  reactivate(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AdminReasonDto, @CurrentUser() user: JwtPayload) {
    return this.actions.reactivate(actorOf(user), id, dto.reason);
  }
}
