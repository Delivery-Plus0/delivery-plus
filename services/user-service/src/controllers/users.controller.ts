import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser, JwtPayload } from '@food-delivery/shared';
import { UsersService } from '../services/users.service';
import { CreateProfileDto } from '../dto/create-profile.dto';
import { CreateAvatarUploadUrlDto } from '../dto/create-avatar-upload-url.dto';
import { ConfirmAvatarUploadDto } from '../dto/confirm-avatar-upload.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { UserProfile } from '../entities/user-profile.entity';
import { InternalAuthGuard } from '../guards/internal-auth.guard';

@ApiTags('users')
@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('internal/users')
  @UseGuards(InternalAuthGuard)
  @ApiOperation({
    summary: 'Internal: create a profile (called synchronously by auth-service on registration)',
  })
  createProfile(
    @Body() dto: CreateProfileDto,
    @Req() request: { internalService?: string },
  ): Promise<UserProfile> {
    return this.usersService.createProfile(dto, request.internalService ?? '');
  }

  @Get('users/me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the current authenticated user profile' })
  getMe(@CurrentUser() user: JwtPayload): Promise<UserProfile> {
    return this.usersService.getOwnProfile(user);
  }

  @Patch('users/me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update the current authenticated user profile' })
  updateMe(@CurrentUser() user: JwtPayload, @Body() dto: UpdateProfileDto): Promise<UserProfile> {
    return this.usersService.updateOwnProfile(user, dto);
  }

  @Post('users/me/avatar/image-upload-url')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a presigned URL for the current user avatar' })
  createAvatarUploadUrl(@CurrentUser() user: JwtPayload, @Body() dto: CreateAvatarUploadUrlDto) {
    return this.usersService.createAvatarUploadUrl(user, dto.contentType);
  }

  @Post('users/me/avatar/confirm')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm and save the current user avatar upload' })
  confirmAvatarUpload(@CurrentUser() user: JwtPayload, @Body() dto: ConfirmAvatarUploadDto) {
    return this.usersService.confirmAvatarUpload(user, dto.objectKey);
  }

  @Get('users/me/orders')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the current user order history (proxied from order-service)' })
  getMyOrders(
    @CurrentUser() user: JwtPayload,
    @Headers('authorization') authHeader: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.usersService.getOrderHistory(user, authHeader, parseInt(page, 10), parseInt(limit, 10));
  }

  @Get('users/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a user profile by id (self or admin)' })
  getById(@Param('id') id: string, @CurrentUser() user: JwtPayload): Promise<UserProfile> {
    return this.usersService.getProfileById(id, user);
  }
}
