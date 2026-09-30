import { Controller, Get, Patch, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { NotificationsService } from '../services/notifications.service';
import { JwtAuthGuard, CurrentUser, JwtPayload } from '@food-delivery/shared';
import { ListNotificationsQueryDto } from '../dto/list-notifications-query.dto';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'List notifications for the authenticated user',
    description: 'Returns the current user notification history with pagination.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1, description: 'Page number to fetch.' })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20, description: 'Items per page.' })
  @ApiResponse({ status: 200, description: 'Notifications returned successfully.' })
  async listNotifications(
    @CurrentUser() user: JwtPayload,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.notificationsService.listForUser(user.sub, query.page || 1, query.limit || 20);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read', description: 'Marks a specific notification as read.' })
  @ApiParam({ name: 'id', description: 'The notification id to mark as read.' })
  @ApiResponse({ status: 200, description: 'Notification marked as read.' })
  async markAsRead(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: JwtPayload) {
    await this.notificationsService.markAsRead(id, user.sub);
    return { success: true };
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  @ApiResponse({ status: 200, description: 'All notifications marked as read.' })
  async markAllAsRead(@CurrentUser() user: JwtPayload) {
    await this.notificationsService.markAllAsRead(user.sub);
    return { success: true };
  }
}
