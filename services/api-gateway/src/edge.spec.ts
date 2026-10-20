import express from 'express';
import { createServer, IncomingHttpHeaders, request as httpRequest, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { GATEWAY_MARKER_HEADER } from '@food-delivery/shared';
import { claimedRole, edgePolicy } from './edge';

/**
 * http-proxy-middleware v4 is ESM only and Jest runs CommonJS (see main.spec.ts), so this stands in
 * for it: forward the request with the incoming headers, which is what the proxy does. The real
 * gateway is covered end to end by scripts/e2e.ts.
 */
function forwardTo(target: string): express.RequestHandler {
  return (req, res) => {
    const upstreamReq = httpRequest(`${target}${req.originalUrl}`, { method: req.method, headers: req.headers }, (upstreamRes) => {
      res.status(upstreamRes.statusCode ?? 502);
      upstreamRes.pipe(res);
    });
    req.pipe(upstreamReq);
  };
}

const token = (claims: object) => `Bearer h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('gateway edge policy (#202)', () => {
  let upstream: Server;
  let gateway: Server;
  let gatewayUrl: string;
  let received: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    // A stand-in service that records what the gateway forwarded.
    upstream = createServer((req, res) => {
      received.push(req.headers);
      res.end('ok');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    // The same order as main.ts: edge policy, then the proxy.
    const app = express();
    app.use(edgePolicy);
    app.use('/api/orders', forwardTo(target));
    gateway = createServer(app);
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => gateway.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  });

  beforeEach(() => {
    received = [];
  });

  it('marks every proxied request as coming through the gateway', async () => {
    const response = await fetch(`${gatewayUrl}/api/orders/1`);

    expect(response.status).toBe(200);
    expect(received[0][GATEWAY_MARKER_HEADER]).toBe('1');
  });

  it.each([
    ['an empty value', ''],
    ['"0"', '0'],
    ['"false"', 'false'],
    ['a long value', 'x'.repeat(200)],
  ])('replaces a client-supplied marker (%s): the client is still treated as external', async (_label, value) => {
    await fetch(`${gatewayUrl}/api/orders/1`, { headers: { [GATEWAY_MARKER_HEADER]: value, 'X-Delivery-Plus-Gateway': value } });

    expect(received[0][GATEWAY_MARKER_HEADER]).toBe('1');
  });

  it('refuses a bearer token claiming the SYSTEM role and never proxies it', async () => {
    const response = await fetch(`${gatewayUrl}/api/orders/1`, { headers: { Authorization: token({ sub: 'system:x', role: 'SYSTEM' }) } });

    expect(response.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('proxies user tokens unchanged', async () => {
    const authorization = token({ sub: 'u1', role: 'CUSTOMER' });

    expect((await fetch(`${gatewayUrl}/api/orders/1`, { headers: { Authorization: authorization } })).status).toBe(200);
    expect(received[0].authorization).toBe(authorization);
  });

  it('reads the claimed role without verifying, and ignores anything that is not a JWT', () => {
    expect(claimedRole(token({ role: 'SYSTEM' }))).toBe('SYSTEM');
    expect(claimedRole(token({ role: 'ADMIN' }))).toBe('ADMIN');
    expect(claimedRole('Bearer not-a-jwt')).toBeUndefined();
    expect(claimedRole('Bearer a.%%%.c')).toBeUndefined();
    expect(claimedRole('Basic abc')).toBeUndefined();
    expect(claimedRole(undefined)).toBeUndefined();
  });
});
