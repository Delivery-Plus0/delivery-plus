import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, Roles, CurrentUser, JwtPayload, UserRole } from '@food-delivery/shared';
import { MenuService } from '../services/menu.service';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { CreateMenuItemDto } from '../dto/create-menu-item.dto';
import { UpdateMenuItemDto } from '../dto/update-menu-item.dto';
import { UpdateAvailabilityDto } from '../dto/update-availability.dto';
import { CreateItemImageUploadUrlDto } from '../dto/create-item-image-upload-url.dto';
import { ConfirmItemImageUploadDto } from '../dto/confirm-item-image-upload.dto';

@ApiTags('menu')
@Controller()
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Post('categories')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a menu category (owner only)' })
  createCategory(@CurrentUser() user: JwtPayload, @Body() dto: CreateCategoryDto) {
    return this.menuService.createCategory(user.sub, dto);
  }

  @Get('restaurants/:restaurantId/menu')
  @ApiOperation({ summary: 'Get the full menu (categories + items) for a restaurant (public)' })
  getMenu(@Param('restaurantId') restaurantId: string) {
    return this.menuService.getMenu(restaurantId);
  }

  @Get('menu-items/:id')
  @ApiOperation({ summary: 'Get a single menu item (public)' })
  getItem(@Param('id') id: string) {
    return this.menuService.getItem(id);
  }

  @Post('menu-items')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a menu item (owner only)' })
  createItem(@CurrentUser() user: JwtPayload, @Body() dto: CreateMenuItemDto) {
    return this.menuService.createItem(user.sub, dto);
  }

  @Patch('menu-items/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a menu item (owner only)' })
  updateItem(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateMenuItemDto,
  ) {
    return this.menuService.updateItem(id, user.sub, dto);
  }

  @Delete('menu-items/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a menu item (owner only)' })
  deleteItem(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.menuService.deleteItem(id, user.sub);
  }

  @Patch('menu-items/:id/availability')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update menu item availability (owner only)' })
  updateAvailability(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateAvailabilityDto,
  ) {
    return this.menuService.updateAvailability(id, user.sub, dto);
  }

  @Post('menu-items/:id/image-upload-url')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a presigned URL for a menu item image' })
  createItemImageUploadUrl(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateItemImageUploadUrlDto,
  ) {
    return this.menuService.createItemImageUploadUrl(id, user.sub, dto.contentType);
  }

  @Post('menu-items/:id/image-confirm')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.RESTAURANT_OWNER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm and save a menu item image upload' })
  confirmItemImageUpload(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ConfirmItemImageUploadDto,
  ) {
    return this.menuService.confirmItemImageUpload(id, user.sub, dto.objectKey);
  }
}
