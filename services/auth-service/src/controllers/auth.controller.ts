import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser, JwtPayload, RateLimit, RateLimitGuard } from '@food-delivery/shared';
import { AuthService } from '../services/auth.service';
import { RegisterDto } from '../dto/register.dto';
import { LoginDto } from '../dto/login.dto';
import { VerifyEmailDto } from '../dto/verify-email.dto';
import { ResendVerificationDto } from '../dto/resend-verification.dto';
import { AuthResponseDto, VerificationRequiredResponseDto } from '../dto/auth-response.dto';
import { RefreshTokenDto } from '../dto/session.dto';
import { RequestWithContext } from '@food-delivery/shared';
import { SessionContext, sessionIdOf } from '../services/sessions.service';

/** What a session records about the client; the app id comes from the body. */
function sessionContext(req: { headers: Record<string, string | string[] | undefined> }): SessionContext {
  const userAgent = req.headers['user-agent'];
  return { userAgent: typeof userAgent === 'string' ? userAgent : null };
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 5, windowSeconds: 60 })
  @ApiOperation({ summary: 'Register a new user (creates credentials + profile); signs in unless email verification is required' })
  register(@Body() dto: RegisterDto, @Req() req: RequestWithContext): Promise<AuthResponseDto | VerificationRequiredResponseDto> {
    return this.authService.register(dto, req.correlationId, sessionContext(req as never));
  }

  @Post('login')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 5, windowSeconds: 60 })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login and receive an access token and a refresh token' })
  login(@Body() dto: LoginDto, @Req() req: RequestWithContext): Promise<AuthResponseDto> {
    return this.authService.login(dto, sessionContext(req as never));
  }

  /** Limited per session, not per IP: behind the gateway every client has the gateway's IP. */
  @Post('refresh')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 10, windowSeconds: 60, key: (request) => sessionIdOf((request.body as { refreshToken?: unknown } | undefined)?.refreshToken) })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exchange a refresh token for a new access and refresh token (the old refresh token stops working)' })
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthResponseDto> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 10, windowSeconds: 60, key: (request) => sessionIdOf((request.body as { refreshToken?: unknown } | undefined)?.refreshToken) })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out this device: ends the session of the refresh token (always 204)' })
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out everywhere: ends every session of the current user' })
  async logoutAll(@CurrentUser() user: JwtPayload): Promise<void> {
    await this.authService.logoutAll(user.sub);
  }

  @Post('verify-email')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 5, windowSeconds: 60 })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify an email using a one-time verification token' })
  verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ message: string }> {
    return this.authService.verifyEmail(dto);
  }

  @Post('resend-verification')
  @UseGuards(RateLimitGuard)
  @RateLimit({ limit: 5, windowSeconds: 60 })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend a verification email if the account is not already verified' })
  resendVerification(@Body() dto: ResendVerificationDto): Promise<{ message: string }> {
    return this.authService.resendVerification(dto);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Return the current JWT payload' })
  me(@CurrentUser() user: JwtPayload): JwtPayload {
    return user;
  }
}
