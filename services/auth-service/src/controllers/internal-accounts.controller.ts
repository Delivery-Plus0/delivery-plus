import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { JwtAuthGuard, Roles, RolesGuard, UserRole } from '@food-delivery/shared';
import { AccountQueryDto } from '../dto/account-query.dto';
import { AccountSummary, CredentialsRepository } from '../repositories/credentials.repository';

/** The only service that may read the account directory. */
export const ACCOUNT_DIRECTORY_CALLER = 'system:user-service';

/**
 * Internal only (the gateway blocks `/internal/*`, and SYSTEM tokens are refused on gateway
 * requests). The account side of the staff people directory (#214): user-service owns
 * `/admin/users` and asks here for the credential fields, which never leave auth-service otherwise.
 */
@ApiExcludeController()
@Controller('internal/auth')
export class InternalAccountsController {
  constructor(private readonly credentials: CredentialsRepository) {}

  @Post('accounts/query')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SYSTEM)
  @HttpCode(HttpStatus.OK)
  async query(
    @Body() dto: AccountQueryDto,
    @Req() request: { user?: { sub?: string } },
  ): Promise<{ items: AccountSummary[]; total: number }> {
    if (request.user?.sub !== ACCOUNT_DIRECTORY_CALLER) {
      throw new ForbiddenException('Only user-service reads the account directory');
    }
    const [items, total] = await this.credentials.queryAccounts({
      ids: dto.ids,
      roles: dto.roles,
      status: dto.status,
      emailVerified: dto.emailVerified,
      createdFrom: dto.createdFrom ? new Date(dto.createdFrom) : undefined,
      createdTo: dto.createdTo ? new Date(dto.createdTo) : undefined,
      page: dto.page,
      limit: dto.limit,
    });
    return { items, total };
  }
}
