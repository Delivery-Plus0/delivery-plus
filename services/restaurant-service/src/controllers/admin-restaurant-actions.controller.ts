import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, JwtAuthGuard, JwtPayload, PermissionsGuard, RateLimitGuard, RequirePermissions } from '@food-delivery/shared';
import { AdminRestaurantActionsService } from '../services/admin-restaurant-actions.service';
import { AdminRestaurantReasonDto, AdminReviewRestaurantDto } from '../dto/admin-restaurant-actions.dto';

const actorOf = (user: JwtPayload) => ({ id: user.sub, email: user.email ?? null });

/** #215: staff decisions on restaurants, published as /api/admin/restaurants/:id/... Every one is audited. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, RateLimitGuard)
@Controller('admin/restaurants')
export class AdminRestaurantActionsController {
  constructor(private readonly actions: AdminRestaurantActionsService) {}

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('onboarding.review')
  @ApiOperation({ summary: "Approve or reject the restaurant's submitted application (onboarding.review)" })
  review(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AdminReviewRestaurantDto, @CurrentUser() user: JwtPayload) {
    return this.actions.review(actorOf(user), id, dto);
  }

  @Post(':id/review/undo')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('onboarding.review')
  @ApiOperation({ summary: 'Undo your own review decision within 10 seconds; audited, the owner is told (onboarding.review)' })
  undoReview(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AdminRestaurantReasonDto, @CurrentUser() user: JwtPayload) {
    return this.actions.undoReview(actorOf(user), id, dto.reason);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ops.act')
  @ApiOperation({ summary: 'Suspend a restaurant: it disappears from customers at once (ops.act)' })
  suspend(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AdminRestaurantReasonDto, @CurrentUser() user: JwtPayload) {
    return this.actions.suspend(actorOf(user), id, dto.reason);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('ops.act')
  @ApiOperation({ summary: 'Lift a suspension; the restaurant comes back CLOSED (ops.act)' })
  reactivate(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AdminRestaurantReasonDto, @CurrentUser() user: JwtPayload) {
    return this.actions.reactivate(actorOf(user), id, dto.reason);
  }
}
