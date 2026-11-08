import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import {
  JwtAuthGuard,
  RolesGuard,
  Roles,
  CurrentUser,
  JwtPayload,
  UserRole,
  PermissionsGuard,
  RequirePermissions,
} from '@food-delivery/shared';
import { ReviewRestaurantApplicationDto } from '../dto/restaurant-application.dto';
import { InternalAuthGuard } from '../guards/internal-auth.guard';
import { RestaurantsService } from '../services/restaurants.service';
import { CreateRestaurantDto } from '../dto/create-restaurant.dto';
import { UpdateRestaurantDto } from '../dto/update-restaurant.dto';
import { UpdateRestaurantStatusDto } from '../dto/update-restaurant-status.dto';
import { ListRestaurantsQueryDto } from '../dto/list-restaurants-query.dto';
import { CreateRestaurantImageUploadUrlDto } from '../dto/create-restaurant-image-upload-url.dto';
import { ConfirmRestaurantImageUploadDto } from '../dto/confirm-restaurant-image-upload.dto';
import { UpdateDeliveryRadiusDto } from '../dto/update-delivery-radius.dto';
import { PublicRestaurantDto, PublicRestaurantListResponseDto } from '../dto/public-restaurant.dto';

@ApiTags('restaurants')
@Controller('restaurants')
export class RestaurantsController {
  constructor(private readonly restaurantsService: RestaurantsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create your restaurant as a DRAFT application (owner only; one per owner, 409 RestaurantLimitReached)' })
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateRestaurantDto) {
    return this.restaurantsService.create(user.sub, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List restaurants (public, paginated/filterable/sortable)' })
  @ApiOkResponse({ type: PublicRestaurantListResponseDto })
  list(@Query() query: ListRestaurantsQueryDto) {
    return this.restaurantsService.list(query);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Your restaurants with their application status, details and latest review note' })
  listMine(@CurrentUser() user: JwtPayload) {
    return this.restaurantsService.listMine(user.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an approved restaurant by id (public; 404 for one not approved)' })
  @ApiOkResponse({ type: PublicRestaurantDto })
  getById(@Param('id') id: string) {
    return this.restaurantsService.getById(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Update restaurant details (owner only; legal details only before approval, name/address/location not while submitted: 409 ApplicationNotEditable)',
  })
  update(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateRestaurantDto,
  ) {
    return this.restaurantsService.update(id, user.sub, dto);
  }

  @Post(':id/submit')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({ summary: 'Send your application for review, or resubmit a rejected one (422 ApplicationIncomplete with what is missing)' })
  submit(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtPayload) {
    return this.restaurantsService.submit(id, user.sub);
  }

  @Get(':id/application')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles(UserRole.ADMIN)
  @RequirePermissions('onboarding.review')
  @ApiBearerAuth()
  @ApiOperation({ summary: "A restaurant's application with its review history (staff with onboarding.review)" })
  getApplication(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.restaurantsService.getApplicationForStaff(id);
  }

  @Post(':id/review')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
  @Roles(UserRole.ADMIN)
  @RequirePermissions('onboarding.review')
  @ApiBearerAuth()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve or reject a submitted application (staff with onboarding.review; 409 ApplicationNotInReview, 422 ApplicationIncomplete)',
  })
  review(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtPayload, @Body() dto: ReviewRestaurantApplicationDto) {
    return this.restaurantsService.review(user.sub, id, dto);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER, UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update restaurant status (owner or admin; an owner opens only an APPROVED restaurant: 409 RestaurantNotApproved)' })
  updateStatus(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateRestaurantStatusDto,
  ) {
    return this.restaurantsService.updateStatus(id, user.sub, user.role, dto);
  }

  @Patch(':id/delivery-radius')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set a restaurant delivery radius (admin only)' })
  @ApiOkResponse({ type: PublicRestaurantDto })
  setDeliveryRadius(@Param('id') id: string, @Body() dto: UpdateDeliveryRadiusDto) {
    return this.restaurantsService.setDeliveryRadius(id, dto.deliveryRadiusKm);
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
  @UseGuards(InternalAuthGuard)
  @ApiOperation({
    summary: 'Internal: check whether userId owns restaurant id (used by menu-service and order-service)',
  })
  async checkOwnership(@Param('id') id: string, @Param('userId') userId: string) {
    await this.restaurantsService.assertOwnership(id, userId);
    return { owned: true };
  }
}
