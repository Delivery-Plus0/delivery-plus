import { NextFunction, Request, Response } from 'express';
import { GATEWAY_MARKER_HEADER, UserRole } from '@food-delivery/shared';

/** The role a bearer JWT claims, read without verifying it (the services verify signatures). */
export function claimedRole(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const [, payload] = authorization.slice('Bearer '.length).split('.');
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { role?: unknown };
    return typeof claims.role === 'string' ? claims.role : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs on every request before it is proxied (#202):
 * - The gateway marker is removed from whatever the client sent and set again, so every proxied
 *   request carries exactly the gateway's value and a client can't make itself look internal.
 * - A bearer token that claims the SYSTEM role is refused here: service identities never come from
 *   the internet. The services refuse SYSTEM tokens on marked requests as well.
 */
export function edgePolicy(request: Request, response: Response, next: NextFunction): void {
  delete request.headers[GATEWAY_MARKER_HEADER];
  request.headers[GATEWAY_MARKER_HEADER] = '1';

  if (claimedRole(request.headers.authorization) === UserRole.SYSTEM) {
    response.status(401).json({ statusCode: 401, error: 'Unauthorized', message: 'Service tokens are not accepted here' });
    return;
  }
  next();
}
