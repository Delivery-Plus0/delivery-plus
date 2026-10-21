import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '../../errors/app-error';
import { UserRole } from '../../types/enums';

/**
 * What a staff member (role ADMIN) may do (#202). Stored per person in auth-service's
 * `staff_permissions` and carried in the access token's `perms` claim; non-staff tokens carry none.
 */
export const STAFF_PERMISSIONS = [
  'support.read',
  'support.act',
  'ops.read',
  'ops.act',
  'finance.read',
  'finance.act',
  'onboarding.review',
  'users.manage',
  'staff.manage',
  'audit.read',
] as const;
export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

export const PERMISSIONS_KEY = 'permissions';

/** The route needs a staff token holding every listed permission. Use with JwtAuthGuard. */
export const RequirePermissions = (...permissions: StaffPermission[]) => SetMetadata(PERMISSIONS_KEY, permissions);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<StaffPermission[] | undefined>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as { role?: UserRole; perms?: string[] } | undefined;
    const held = new Set(user?.role === UserRole.ADMIN ? user.perms ?? [] : []);
    const missing = required.filter((permission) => !held.has(permission));
    if (missing.length > 0) throw new ForbiddenError(`Requires staff permission: ${missing.join(', ')}`);
    return true;
  }
}
