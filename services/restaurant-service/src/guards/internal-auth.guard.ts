import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  INTERNAL_AUTH_HEADERS,
  safeEqual,
  signInternalRequest,
} from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';

const MAX_CLOCK_SKEW_SECONDS = 300;
const NONCE_TTL_SECONDS = 600;

@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const service = request.headers[INTERNAL_AUTH_HEADERS.service];
    const timestamp = request.headers[INTERNAL_AUTH_HEADERS.timestamp];
    const nonce = request.headers[INTERNAL_AUTH_HEADERS.nonce];
    const signature = request.headers[INTERNAL_AUTH_HEADERS.signature];
    const allowedServices = new Set(this.config.internalAuthAllowedServices);

    if (
      !service ||
      !timestamp ||
      !nonce ||
      !signature ||
      !allowedServices.has(service)
    ) {
      throw new UnauthorizedException('Invalid internal service credentials');
    }

    const timestampNumber = Number(timestamp);
    if (!Number.isInteger(timestampNumber) || Math.abs(Math.floor(Date.now() / 1000) - timestampNumber) > MAX_CLOCK_SKEW_SECONDS) {
      throw new UnauthorizedException('Expired internal service credentials');
    }

    const expected = signInternalRequest({
      method: request.method,
      path: request.path,
      timestamp,
      nonce,
      body: request.body,
      service,
      secret: this.config.internalAuthSecret,
    });
    if (!safeEqual(signature, expected)) {
      throw new UnauthorizedException('Invalid internal service signature');
    }

    const nonceKey = `internal-auth:nonce:${service}:${nonce}`;
    const accepted = await this.redis.set(nonceKey, '1', 'EX', NONCE_TTL_SECONDS, 'NX');
    if (accepted !== 'OK') {
      throw new UnauthorizedException('Replayed internal service request');
    }

    request.internalService = service;
    return true;
  }
}
