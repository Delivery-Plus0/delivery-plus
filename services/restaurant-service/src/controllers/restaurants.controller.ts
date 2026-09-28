import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, UserRole } from '@food-delivery/shared';
import { RestaurantsService } from '../services/restaurants.service';
import { CreateRestaurantDto } from '../dto/create-restaurant.dto';
import { UpdateRestaurantDto } from '../dto/update-restaurant.dto';
import { UpdateRestaurantStatusDto } from '../dto/update-restaurant-status.dto';
import { ListRestaurantsQueryDto } from '../dto/list-restaurants-query.dto';
import { CreateRestaurantImageUploadUrlDto } from '../dto/create-restaurant-image-upload-url.dto';
import { ConfirmRestaurantImageUploadDto } from '../dto/confirm-restaurant-image-upload.dto';

@ApiTags('restaurants')
@Controller('restaurants')
export class RestaurantsController {
  constructor(private readonly restaurantsService: RestaurantsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a restaurant (owner only)' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateRestaurantDto) {
    return this.restaurantsService.create(user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List restaurants (public, paginated/filterable/sortable)' })
  list(@Query() query: ListRestaurantsQueryDto) {
    return this.restaurantsService.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a restaurant by id (public)' })
  getById(@Param('id') id: string) {
    return this.restaurantsService.getById(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update restaurant details (owner only)' })
  update(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateRestaurantDto,
  ) {
    return this.restaurantsService.update(id, user.sub, dto);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER, UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update restaurant status (owner or admin)' })
  updateStatus(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateRestaurantStatusDto,
  ) {
    return this.restaurantsService.updateStatus(id, user.sub, user.role, dto);
  }

  @Post(':id/image-upload-url')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a presigned URL for a restaurant cover or logo image' })
  createImageUploadUrl(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateRestaurantImageUploadUrlDto,
  ) {
    return this.restaurantsService.createImageUploadUrl(id, user.sub, dto.imageType, dto.contentType);
  }

  @Post(':id/image-confirm')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm and save a restaurant cover or logo upload' })
  confirmImageUpload(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConfirmRestaurantImageUploadDto,
  ) {
    return this.restaurantsService.confirmImageUpload(id, user.sub, dto.imageType, dto.objectKey);
  }

  @Get(':id/ownership/:userId')
  @ApiOperation({
    summary: 'Internal: check whether userId owns restaurant id (used by menu-service)',
  })
  async checkOwnership(@Param('id') id: string, @Param('userId') userId: string) {
    await this.restaurantsService.assertOwnership(id, userId);
    return { owned: true };
  }
}
