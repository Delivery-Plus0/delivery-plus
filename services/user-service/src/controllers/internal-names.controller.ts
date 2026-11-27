import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';
import { JwtAuthGuard, Roles, RolesGuard, UserRole } from '@food-delivery/shared';
import { ProfilesRepository } from '../repositories/profiles.repository';

/** The services whose staff lists show people's names (#214). */
export const NAME_LOOKUP_CALLERS = ['system:driver-service', 'system:restaurant-service'];

export class NameLookupDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  ids!: string[];
}

/**
 * Internal only: full names for a page of staff list rows (drivers, restaurant owners), #214.
 * Names only: no email, phone or address, which stay behind /admin/users.
 */
@ApiExcludeController()
@Controller('internal/users')
export class InternalNamesController {
  constructor(private readonly profiles: ProfilesRepository) {}

  @Post('names')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SYSTEM)
  @HttpCode(HttpStatus.OK)
  async names(@Body() dto: NameLookupDto, @Req() request: { user?: { sub?: string } }): Promise<{ items: { id: string; fullName: string }[] }> {
    if (!NAME_LOOKUP_CALLERS.includes(request.user?.sub ?? '')) throw new ForbiddenException('Not allowed to look up names');
    const profiles = await this.profiles.findByIds(dto.ids);
    return { items: profiles.map((p) => ({ id: p.id, fullName: p.fullName })) };
  }
}
