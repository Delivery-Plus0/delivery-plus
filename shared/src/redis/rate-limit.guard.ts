import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimiterService } from './rate-limiter.service';
import { AppError } from '../errors/app-error';

export const RATE_LIMIT_KEY = 'RATE_LIMIT';

export interface RateLimitOptions {
  limit: number;
  windowSeconds: number;
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
    // Use user ID if authenticated, else use IP address
    const identifier = request.user?.sub || request.ip || 'unknown-ip';
    
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
