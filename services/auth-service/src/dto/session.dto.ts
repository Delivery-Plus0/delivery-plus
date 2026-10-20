import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { SESSION_APPS, SESSION_REVOKE_REASONS, SessionApp, SessionRevokeReason } from '../entities/auth-session.entity';

/** Optional on login and register: which app the session belongs to (#34). */
export class SessionAppField {
  @ApiPropertyOptional({ description: 'The app signing in, recorded on the session (#34).', enum: SESSION_APPS, example: 'customer' })
  @IsOptional()
  @IsIn(SESSION_APPS)
  appId?: SessionApp;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'The refresh token from login, register or the last refresh. Single use: every refresh returns a new one.' })
  @IsString()
  @MaxLength(200)
  refreshToken!: string;
}

/** Reasons other services may give; the user-facing ones (logout, reuse) are set by auth-service itself. */
export const INTERNAL_REVOKE_REASONS = SESSION_REVOKE_REASONS.filter(
  (reason): reason is Exclude<SessionRevokeReason, 'logout' | 'logout_all' | 'reuse_detected'> =>
    reason !== 'logout' && reason !== 'logout_all' && reason !== 'reuse_detected',
);

export class RevokeSessionsDto {
  @ApiProperty({ enum: INTERNAL_REVOKE_REASONS })
  @IsIn(INTERNAL_REVOKE_REASONS)
  reason!: (typeof INTERNAL_REVOKE_REASONS)[number];

  @ApiPropertyOptional({ description: 'Keep this session (e.g. the one that changed the password).', format: 'uuid' })
  @IsOptional()
  @IsUUID()
  exceptSessionId?: string;
}
