import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, PermissionsGuard, RateLimitGuard, RequirePermissions } from '@food-delivery/shared';
import { AdminRestaurantsService } from '../services/admin-restaurants.service';
import { AdminListRestaurantsQueryDto, AdminRestaurantQueueQueryDto, AdminSearchRestaurantsDto } from '../dto/admin-restaurants.dto';

/** #214: staff restaurant lists and the restaurant page, published as /api/admin/restaurants. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, RateLimitGuard)
@Controller('admin/restaurants')
export class AdminRestaurantsController {
  constructor(private readonly restaurants: AdminRestaurantsService) {}

  @Get()
  @RequirePermissions('support.read')
  @ApiOperation({ summary: 'List restaurants: approval, status, name prefix, area (support.read)' })
  list(@Query() query: AdminListRestaurantsQueryDto) {
    return this.restaurants.list(query);
  }

  /** Declared before :id so "queue" is never read as an id. */
  @Get('queue')
  @RequirePermissions('onboarding.review')
  @ApiOperation({ summary: 'Submitted applications waiting for a decision, oldest first (onboarding.review)' })
  queue(@Query() query: AdminRestaurantQueueQueryDto) {
    return this.restaurants.queue(query);
  }

  /** POST so the phone stays out of URLs and access logs (#217 decision). */
  @Post('search')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('support.read')
  @ApiOperation({ summary: 'Find restaurants by their exact contact phone (support.read)' })
  search(@Body() dto: AdminSearchRestaurantsDto) {
    return this.restaurants.search(dto.phone);
  }

  @Get(':id')
  @RequirePermissions('support.read')
  @ApiOperation({ summary: "One restaurant: application, reviews, owner, menu counts and today's orders (support.read)" })
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.restaurants.detail(id);
  }
}
