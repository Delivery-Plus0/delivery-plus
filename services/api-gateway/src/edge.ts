import { NextFunction, Request, Response } from 'express';
import { CLIENT_IP_HEADER, GATEWAY_MARKER_HEADER, UserRole } from '@food-delivery/shared';

const MAX_TRUSTED_PROXY_HOPS = 5;

/**
 * #251: how many reverse proxies in front of the gateway append the client's address to
 * X-Forwarded-For (a load balancer is 1, a CDN in front of it 2). 0, the default, trusts none: the
 * socket address counts and a client's own X-Forwarded-For is ignored. Anything else stops startup.
 */
export function trustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim() ?? '';
  if (raw === '') return 0;
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_TRUSTED_PROXY_HOPS) {
    throw new Error(`TRUSTED_PROXY_HOPS must be a whole number from 0 to ${MAX_TRUSTED_PROXY_HOPS} (got "${raw}")`);
  }
  return Number(raw);
}

/**
 * Express's `trust proxy` with a hop count makes `request.ip` the address that many hops from the
 * right of X-Forwarded-For. The trusted proxies append those entries, so whatever a client puts in
 * front of them can't change the result.
 */
export function configureTrustProxy(app: { set(setting: string, value: unknown): unknown }, env: NodeJS.ProcessEnv = process.env): number {
  const hops = trustedProxyHops(env);
  app.set('trust proxy', hops);
  return hops;
}

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
 * - The client IP header is replaced the same way, so rate limits count real clients (#203). Behind
 *   trusted proxies it is the client's address from X-Forwarded-For (#251).
 * - A bearer token that claims the SYSTEM role is refused here: service identities never come from
 *   the internet. The services refuse SYSTEM tokens on marked requests as well.
 */
export function edgePolicy(request: Request, response: Response, next: NextFunction): void {
  delete request.headers[GATEWAY_MARKER_HEADER];
  request.headers[GATEWAY_MARKER_HEADER] = '1';
  // #203: the client's address for per-IP limits, replaced the same way. `request.ip` is the socket
  // address unless TRUSTED_PROXY_HOPS says proxies in front of the gateway report it (#251).
  delete request.headers[CLIENT_IP_HEADER];
  request.headers[CLIENT_IP_HEADER] = request.ip || request.socket.remoteAddress || 'unknown-ip';

  if (claimedRole(request.headers.authorization) === UserRole.SYSTEM) {
    response.status(401).json({ statusCode: 401, error: 'Unauthorized', message: 'Service tokens are not accepted here' });
    return;
  }
  next();
}
