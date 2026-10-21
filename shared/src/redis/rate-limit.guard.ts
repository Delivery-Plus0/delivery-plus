import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimiterService } from './rate-limiter.service';
import { AppError } from '../errors/app-error';
import { clientIpOf } from '../nest/auth/system-principal';

export const RATE_LIMIT_KEY = 'RATE_LIMIT';

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
  /**
   * Who the limit applies to, when neither the user id nor the IP is right. Behind the gateway every
   * anonymous caller has the gateway's IP, so a route like `/auth/refresh` keys on the session in the
   * body instead (#34). Returning undefined falls back to the user id, then the IP.
   */
  key?: (request: { body?: unknown; headers?: Record<string, unknown> }) => string | undefined;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimiter: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // A route-level @RateLimit wins; otherwise fall back to one declared on the controller class
    // (cart-service declares its limit there, which used to be silently ignored).
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const request = context.switchToHttp().getRequest();
    // The route's own key if it has one, else the user ID if authenticated, else the client's IP (the
    // gateway forwards it, #203; before that every anonymous caller shared the gateway's address).
    const identifier = options.key?.(request) || request.user?.sub || clientIpOf(request);
    
    // Key structure: ratelimit:{path}:{identifier}
    const path = request.route.path;
    const key = `ratelimit:${path}:${identifier}`;

    const allowed = await this.rateLimiter.incrementAndCheck(key, options.limit, options.windowSeconds);
    
    if (!allowed) {
      throw new AppError(429, 'TooManyRequests', 'Rate limit exceeded');
    }
    
    return true;
  }
}
