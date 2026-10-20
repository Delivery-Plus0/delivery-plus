/**
 * The SYSTEM principal (#202, F5).
 *
 * Services call each other's JWT routes as `role: SYSTEM`, signed with SYSTEM_JWT_SECRET: a different
 * secret from the user tokens' JWT_SECRET, so a user-token secret can't mint a service identity and a
 * service token is never mistaken for a staff ADMIN. SYSTEM tokens are short-lived and only accepted
 * on requests that did not come through the public gateway.
 */

/** How long a minted SYSTEM token lives. Each call mints a fresh one. */
export const SYSTEM_TOKEN_TTL = '2m';

/**
 * Set by the API gateway on every request it proxies, after removing any copy the client sent, so a
 * service knows the request came from outside. SYSTEM tokens are refused on such requests.
 */
export const GATEWAY_MARKER_HEADER = 'x-delivery-plus-gateway';

/** The development/test value compose files fall back to. Refused in production. */
export const LOCAL_SYSTEM_JWT_SECRET = 'local-system-jwt-development-only';

const MIN_PRODUCTION_SECRET_LENGTH = 32;

/**
 * SYSTEM_JWT_SECRET for a service that mints or verifies SYSTEM tokens. Required in production, where
 * the local default, a copy of JWT_SECRET and anything shorter than 32 characters are refused.
 */
export function loadSystemJwtSecret(nodeEnv: string, env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.SYSTEM_JWT_SECRET;
  if (nodeEnv !== 'production') return secret || LOCAL_SYSTEM_JWT_SECRET;

  if (!secret) throw new Error('Missing required environment variables: SYSTEM_JWT_SECRET');
  if (secret === LOCAL_SYSTEM_JWT_SECRET) throw new Error('SYSTEM_JWT_SECRET is the local development default; set a real secret in production');
  if (secret.length < MIN_PRODUCTION_SECRET_LENGTH) throw new Error(`SYSTEM_JWT_SECRET must be at least ${MIN_PRODUCTION_SECRET_LENGTH} characters in production`);
  if (env.JWT_SECRET && secret === env.JWT_SECRET) throw new Error('SYSTEM_JWT_SECRET must differ from JWT_SECRET');
  return secret;
}

/**
 * The secret the shared JwtAuthGuard checks SYSTEM tokens with. Never throws: a service that receives
 * no system calls may run in production without SYSTEM_JWT_SECRET, and then accepts no SYSTEM token.
 * Services that do mint or verify them call loadSystemJwtSecret at startup, which enforces it.
 */
export function systemSecretForVerification(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SYSTEM_JWT_SECRET) return env.SYSTEM_JWT_SECRET;
  return (env.NODE_ENV || 'development') === 'production' ? undefined : LOCAL_SYSTEM_JWT_SECRET;
}

/**
 * The client's address as the gateway saw it (#203). Set by the gateway on every proxied request after
 * removing any copy the client sent. Behind the gateway, `request.ip` is the gateway itself.
 */
export const CLIENT_IP_HEADER = 'x-delivery-plus-client-ip';

/** The caller's IP: the gateway's record of it for proxied requests, else the socket address. */
export function clientIpOf(request: { headers?: Record<string, unknown>; ip?: string }): string {
  const forwarded = request.headers?.[CLIENT_IP_HEADER];
  if (cameThroughGateway(request.headers) && typeof forwarded === 'string' && forwarded) return forwarded;
  return request.ip || 'unknown-ip';
}

/** True when the request was proxied by the public gateway. */
export function cameThroughGateway(headers: Record<string, unknown> | undefined): boolean {
  return Boolean(headers && headers[GATEWAY_MARKER_HEADER]);
}
