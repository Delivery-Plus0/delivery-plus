import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, PermissionsGuard, RateLimitGuard, RequirePermissions } from '@food-delivery/shared';
import { AuditService } from '../services/audit.service';
import { ListAuditQueryDto } from '../dto/list-audit-query.dto';

/** #213: the staff audit log, published by the gateway as `/api/admin/audit`. Read-only by design. */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, RateLimitGuard)
@Controller('admin/audit')
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  @ApiOperation({ summary: 'List staff actions, newest first (audit.read)' })
  list(@Query() query: ListAuditQueryDto) {
    return this.audit.list(query);
  }
}
