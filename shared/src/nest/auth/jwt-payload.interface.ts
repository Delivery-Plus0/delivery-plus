import { UserRole } from '../../types/enums';

export interface JwtPayload {
  sub: string; // userId
  email: string;
  role: UserRole;
  /** The refresh session this access token was issued for (#34). Absent on system tokens. */
  sid?: string;
}

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}
