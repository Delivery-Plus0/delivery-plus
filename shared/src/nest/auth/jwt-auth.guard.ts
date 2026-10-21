import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from './jwt-payload.interface';
import { UserRole } from '../../types/enums';
import { cameThroughGateway, systemSecretForVerification } from './system-principal';

/**
 * Accepts user tokens signed with the module's JWT_SECRET and, on requests that did not come through
 * the public gateway, SYSTEM tokens signed with SYSTEM_JWT_SECRET (#202). A user-secret token that
 * claims `role: SYSTEM` is forged and refused.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const token = authHeader.slice('Bearer '.length);

    const user = await this.verify(token);
    if (user && user.role !== UserRole.SYSTEM) {
      request.user = user;
      return true;
    }

    const systemSecret = systemSecretForVerification();
    if (!user && systemSecret && !cameThroughGateway(request.headers)) {
      const system = await this.verify(token, systemSecret);
      if (system?.role === UserRole.SYSTEM) {
        request.user = system;
        return true;
      }
    }

    throw new UnauthorizedException('Invalid or expired token');
  }

  private async verify(token: string, secret?: string): Promise<JwtPayload | null> {
    try {
      return await this.jwtService.verifyAsync<JwtPayload>(token, secret ? { secret } : undefined);
    } catch {
      return null;
    }
  }
}
