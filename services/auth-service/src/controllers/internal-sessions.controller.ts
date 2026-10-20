import { Body, Controller, HttpCode, HttpStatus, Logger, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InternalAuthGuard } from '../guards/internal-auth.guard';
import { RevokeSessionsDto } from '../dto/session.dto';
import { SessionsService } from '../services/sessions.service';

/**
 * Internal only (the gateway blocks `/internal/*`): ends a user's refresh sessions for password
 * change and reset (#35), suspension (#202) and staff actions (#215). Access tokens already issued
 * stay valid until they expire (JWT_EXPIRES_IN, 15 minutes by default).
 */
@ApiExcludeController()
@Controller('internal/auth')
export class InternalSessionsController {
  private readonly logger = new Logger(InternalSessionsController.name);

  constructor(private readonly sessions: SessionsService) {}

  @Post('users/:id/revoke-sessions')
  @UseGuards(InternalAuthGuard)
  @HttpCode(HttpStatus.OK)
  async revokeSessions(
    @Param('id', new ParseUUIDPipe()) userId: string,
    @Body() dto: RevokeSessionsDto,
    @Req() request: { internalService?: string },
  ): Promise<{ revoked: number }> {
    const revoked = await this.sessions.revokeAll(userId, dto.reason, dto.exceptSessionId);
    this.logger.log(`${request.internalService} revoked ${revoked} sessions of ${userId} (${dto.reason})`);
    return { revoked };
  }
}
