import axios from 'axios';
import { createHmac } from 'node:crypto';
import { Redis } from 'ioredis';
import { uploadImage } from './lib/gateway-seed';

const API_URL = process.env.API_URL || 'http://localhost:3000';
// docker-compose.test.yml publishes Redis; its user-service keeps texted codes there (SMS_PROVIDER=test, #153).
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
// The test and dev stacks' super admin (TEST_ADMIN_* in their compose overlays, #202).
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || 'qa.admin@delivery-plus.test';
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || 'Qa-Only-Admin-Passw0rd!';
// The test stack's SYSTEM_JWT_SECRET fallback: used only to prove the gateway refuses a real SYSTEM token.
const SYSTEM_JWT_SECRET = process.env.SYSTEM_JWT_SECRET || 'local-system-jwt-development-only';

// NOTE (CI tooling fix): this script previously could not get past the second
// or third step against the current API. Every service runs a global
// ValidationPipe with `forbidNonWhitelisted: true`, so extra/misnamed fields
// are rejected with 400 rather than ignored. Concretely, this script now:
//   - drops `restaurantId` from the add-to-cart body (AddCartItemDto only
//     accepts menuItemId + quantity; cart-service resolves the restaurant
//     from the menu item itself).
//   - calls GET /api/menus/restaurants/:id/menu (menu-service's route),
//     not /api/menus/restaurants/:id.
//   - actually settles the payment via POST /payments/:id/process. The old
//     script only ever called POST /payments (which just creates a PENDING
//     payment) and put `simulateFailure` on that call, where it isn't a
//     valid field; the order therefore never reached CONFIRMED.
//   - drives the order through PREPARING before READY_FOR_PICKUP -- the
//     shared ORDER_TRANSITIONS map does not allow CONFIRMED -> READY_FOR_PICKUP
//     directly.
//   - adds the delivery dispatch + driver lifecycle (assign/pickup/start/
//     complete) that the old script stopped short of, using the drive
//     seeded and brought online by scripts/seed.ts.
// Order/payment/delivery status propagation between services here happens
// mostly through direct, synchronous HTTP calls (see payments.service.ts's
// completeSideEffects and deliveries.service.ts), not only through Kafka, so
// this polls with a short timeout instead of trusting a fixed sleep().

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  label: string,
  fn: () => Promise<T>,
  isDone: (value: T) => boolean,
  { timeoutMs = 15_000, intervalMs = 500 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await fn();
    if (isDone(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${label} (last value: ${JSON.stringify(last)})`);
    }
    await sleep(intervalMs);
  }
}

/** HTTP status of a request, whether it succeeded or failed. */
type TrackingSnapshot = {
  tracking: string;
  status: string;
  driverId?: string;
  location: { latitude: number; longitude: number; updatedAt: string } | null;
};

/**
 * Minimal Server-Sent Events reader over fetch for GET /api/tracking/delivery/:id/stream (#135):
 * `next()` resolves with the next `tracking` event, `ended()` once the server closes the stream.
 */
async function openTrackingStream(deliveryId: string, token: string | null) {
  const controller = new AbortController();
  const response = await fetch(`${API_URL}/api/tracking/delivery/${deliveryId}/stream`, {
    headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal: controller.signal,
  });
  const queue: TrackingSnapshot[] = [];
  const waiters: ((snapshot: TrackingSnapshot) => void)[] = [];
  let finished = false;
  let onFinished: () => void = () => undefined;
  const finishedPromise = new Promise<void>((resolve) => (onFinished = resolve));

  if (response.ok && response.body) {
    void (async () => {
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event === 'tracking' && data) {
              const snapshot = JSON.parse(data) as TrackingSnapshot;
              const waiter = waiters.shift();
              if (waiter) waiter(snapshot);
              else queue.push(snapshot);
            }
          }
        }
      } catch {
        // aborted
      } finally {
        finished = true;
        onFinished();
      }
    })();
  } else {
    await response.body?.cancel();
    finished = true;
    onFinished();
  }

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    next(timeoutMs = 10_000): Promise<TrackingSnapshot> {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`No tracking event within ${timeoutMs} ms`)), timeoutMs);
        waiters.push((snapshot) => {
          clearTimeout(timer);
          resolve(snapshot);
        });
      });
    },
    async ended(timeoutMs = 10_000): Promise<boolean> {
      if (finished) return true;
      return Promise.race([finishedPromise.then(() => true), sleep(timeoutMs).then(() => false)]);
    },
    close: () => controller.abort(),
  };
}

async function statusOf(request: Promise<unknown>): Promise<number> {
  try {
    const response = (await request) as { status: number };
    return response.status;
  } catch (error: any) {
    if (error.response) return error.response.status;
    throw error;
  }
}

/**
 * Public registration must never yield admin privileges: asking for ADMIN is refused without
 * creating anything, and an ordinary sign-up cannot reach an admin-only route.
 */
async function assertNoSelfRegisteredAdmin() {
  const email = `e2e.no-admin.${Date.now()}@example.com`;
  const body = { email, password: 'password123', fullName: 'E2E No Admin' };

  const adminAttempt = await statusOf(axios.post(`${API_URL}/api/auth/register`, { ...body, role: 'ADMIN' }));
  if (adminAttempt !== 400) {
    throw new Error(`Registering with role ADMIN returned ${adminAttempt}, expected 400`);
  }

  // A 409 here would mean the refused attempt still created the account.
  const signup = await axios.post(`${API_URL}/api/auth/register`, body);
  if (signup.data.role !== 'CUSTOMER') {
    throw new Error(`Public registration produced role ${signup.data.role}, expected CUSTOMER`);
  }

  const adminRoute = await statusOf(
    axios.get(`${API_URL}/api/drivers/available`, {
      headers: { Authorization: `Bearer ${signup.data.accessToken}` },
    }),
  );
  if (adminRoute !== 403) {
    throw new Error(`A self-registered account got ${adminRoute} on an admin-only route, expected 403`);
  }
  console.log('Self-registration cannot obtain ADMIN (400 on request, 403 on admin route)');
}

/**
 * Refresh sessions (#34): refresh rotates and the old token stops working, reusing a rotated token
 * ends the whole session, logout ends one session and logout-all ends every session. Access tokens
 * keep working on existing routes. Uses a fresh account; two logins, because /auth/login allows 5
 * per minute and the seeded accounts already use 3.
 */
async function assertRefreshSessions() {
  const email = `e2e.sessions.${Date.now()}@example.com`;
  const refresh = (refreshToken: string) => axios.post(`${API_URL}/api/auth/refresh`, { refreshToken });
  const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

  const signup = (await axios.post(`${API_URL}/api/auth/register`, { email, password: 'password123', fullName: 'E2E Sessions', appId: 'customer' })).data;
  if (!signup.refreshToken || !signup.accessTokenExpiresAt) throw new Error(`Register did not sign in with a refresh token: ${JSON.stringify(Object.keys(signup))}`);

  // Refresh rotates; the new access token works on existing routes and names its session.
  const rotated = (await refresh(signup.refreshToken)).data;
  const me = (await axios.get(`${API_URL}/api/auth/me`, bearer(rotated.accessToken))).data;
  if (rotated.refreshToken === signup.refreshToken || me.sid !== signup.refreshToken.split('.')[0]) {
    throw new Error(`Refresh did not rotate within the session: ${JSON.stringify({ sid: me.sid })}`);
  }
  // The replaced token fails, and using it again ended the session: the newest token is dead too.
  const replayed = await statusOf(refresh(signup.refreshToken));
  const newestAfterReuse = await statusOf(refresh(rotated.refreshToken));

  // Logout ends one session; logout-all ends the rest. Issued access tokens expire on their own.
  const first = (await axios.post(`${API_URL}/api/auth/login`, { email, password: 'password123', appId: 'driver' })).data;
  const second = (await axios.post(`${API_URL}/api/auth/login`, { email, password: 'password123' })).data;
  const logout = await statusOf(axios.post(`${API_URL}/api/auth/logout`, { refreshToken: first.refreshToken }));
  const afterLogout = await statusOf(refresh(first.refreshToken));
  const stillLive = (await refresh(second.refreshToken)).data;
  const logoutAll = await statusOf(axios.post(`${API_URL}/api/auth/logout-all`, {}, bearer(stillLive.accessToken)));
  const afterLogoutAll = await statusOf(refresh(stillLive.refreshToken));
  const accessAfterLogoutAll = await statusOf(axios.get(`${API_URL}/api/auth/me`, bearer(stillLive.accessToken)));

  const got = { replayed, newestAfterReuse, logout, afterLogout, logoutAll, afterLogoutAll, accessAfterLogoutAll };
  const want = { replayed: 401, newestAfterReuse: 401, logout: 204, afterLogout: 401, logoutAll: 204, afterLogoutAll: 401, accessAfterLogoutAll: 200 };
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`Refresh sessions: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  console.log('Refresh sessions: refresh rotates, reuse ends the session, logout and logout-all revoke (401 on refresh)');
}

/**
 * Password change (#35): changing the password ends every OTHER session and keeps the one that made
 * the change. The old password stops working, the new one signs in, a wrong current password is 401
 * and an unchanged password is 400. Fresh account; two logins plus the register session stay under
 * the 5-a-minute login limit.
 */
async function assertPasswordChange() {
  await clearRateLimits();
  const email = `e2e.pwchange.${Date.now()}@example.com`;
  const oldPassword = 'password123';
  const newPassword = 'newpassword456';
  const refresh = (refreshToken: string) => axios.post(`${API_URL}/api/auth/refresh`, { refreshToken });
  const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
  const change = (token: string, body: Record<string, string>) =>
    axios.post(`${API_URL}/api/auth/password/change`, body, bearer(token));

  // Session A is the register session, session B a second login.
  const sessionA = (await axios.post(`${API_URL}/api/auth/register`, { email, password: oldPassword, fullName: 'E2E Password', appId: 'customer' })).data;
  const sessionB = (await axios.post(`${API_URL}/api/auth/login`, { email, password: oldPassword })).data;

  // Refused changes first: nothing may change for them.
  const wrongCurrent = await statusOf(change(sessionA.accessToken, { currentPassword: 'not-the-password', newPassword }));
  const unchanged = await statusOf(change(sessionA.accessToken, { currentPassword: oldPassword, newPassword: oldPassword }));
  const tooShort = await statusOf(change(sessionA.accessToken, { currentPassword: oldPassword, newPassword: 'short1' }));
  const noToken = await statusOf(axios.post(`${API_URL}/api/auth/password/change`, { currentPassword: oldPassword, newPassword }));
  const bStillLiveAfterRefusals = await statusOf(refresh(sessionB.refreshToken));
  await clearRateLimits();
  // The real change, made from session A. B's refresh token was rotated above, so log in again for a fresh B.
  const sessionB2 = (await axios.post(`${API_URL}/api/auth/login`, { email, password: oldPassword })).data;
  const changed = await statusOf(change(sessionA.accessToken, { currentPassword: oldPassword, newPassword }));
  const otherSession = await statusOf(refresh(sessionB2.refreshToken));
  const ownSession = await statusOf(refresh(sessionA.refreshToken));
  await clearRateLimits();
  const oldLogin = await statusOf(axios.post(`${API_URL}/api/auth/login`, { email, password: oldPassword }));
  const newLogin = await statusOf(axios.post(`${API_URL}/api/auth/login`, { email, password: newPassword }));
  const got = { wrongCurrent, unchanged, tooShort, noToken, bStillLiveAfterRefusals, changed, otherSession, ownSession, oldLogin, newLogin };
  const want = { wrongCurrent: 401, unchanged: 400, tooShort: 400, noToken: 401, bStillLiveAfterRefusals: 200, changed: 204, otherSession: 401, ownSession: 200, oldLogin: 401, newLogin: 200 };
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`Password change: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  console.log('Password change: wrong current 401, unchanged 400, other sessions revoked, own session kept, old password refused, new one signs in');
  await clearRateLimits();
}

/** #35: forgot + reset by SMS code. The test SMS sender keeps the text in Redis under test:sms:<phone>. */
async function assertPasswordReset() {
  await clearRateLimits();
  const stamp = Date.now().toString().slice(-7);
  const email = `e2e.pwreset.${Date.now()}@example.com`;
  const oldPassword = 'password123';
  const newPassword = 'newpassword456';
  const typedPhone = `0100${stamp}`; // what a user types
  const unknownPhone = `0155${stamp}`; // never registered
  const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
  const call = (path: string, body: unknown) => axios.post(`${API_URL}/api/auth/password/${path}`, body, { validateStatus: () => true });
  const refresh = (refreshToken: string) => statusOf(axios.post(`${API_URL}/api/auth/refresh`, { refreshToken }));
  const login = (password: string) => statusOf(axios.post(`${API_URL}/api/auth/login`, { email, password }));
  const withRedis = async <T>(fn: (redis: Redis) => Promise<T>): Promise<T> => {
    const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await redis.connect();
    try {
      return await fn(redis);
    } finally {
      redis.disconnect();
    }
  };
  const codeFor = async (phone: string, timeoutMs = 3000): Promise<string> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text = await withRedis((redis) => redis.get(`test:sms:${phone}`));
      const code = /\b(\d{6})\b/.exec(text ?? '')?.[1];
      if (code) return code;
      await sleep(100);
    }
    throw new Error('Timed out waiting for the text message');
  };

  // Two sessions, then a verified phone (reset only works for a verified phone).
  const sessionA = (await axios.post(`${API_URL}/api/auth/register`, { email, password: oldPassword, fullName: 'E2E Reset', appId: 'customer' })).data;
  const sessionB = (await axios.post(`${API_URL}/api/auth/login`, { email, password: oldPassword })).data;
  const auth = bearer(sessionA.accessToken);
  await axios.patch(`${API_URL}/api/users/me`, { phone: typedPhone }, auth);
  const otpStart = await axios.post(`${API_URL}/api/users/me/phone/verification`, {}, auth);
  const phone = otpStart.data.phone as string; // the stored form: the Redis key uses it
  const verifyCode = await codeFor(phone);
  await axios.post(`${API_URL}/api/users/me/phone/verify`, { code: verifyCode }, auth);

  // Forgot answers the same for an unknown phone and the real one.
  await clearRateLimits();
  await withRedis((redis) => redis.del(`test:sms:${phone}`)); // so the next text we read is the reset code
  const forgotUnknown = await call('forgot', { phone: unknownPhone });
  const forgotKnown = await call('forgot', { phone: typedPhone });
  const resetCode = await codeFor(phone);

  const wrongCode = (await call('reset', { phone: typedPhone, code: resetCode === '000000' ? '111111' : '000000', newPassword })).status;
  const reset = (await call('reset', { phone: typedPhone, code: resetCode, newPassword })).status;

  await clearRateLimits();
  const sessionARefresh = await refresh(sessionA.refreshToken);
  const sessionBRefresh = await refresh(sessionB.refreshToken);
  const oldLogin = await login(oldPassword);
  const newLogin = await login(newPassword);
  const reuse = (await call('reset', { phone: typedPhone, code: resetCode, newPassword: 'another-password-789' })).status;

  const got = {
    forgotUnknown: forgotUnknown.status,
    forgotKnown: forgotKnown.status,
    sameBody: JSON.stringify(forgotUnknown.data) === JSON.stringify(forgotKnown.data),
    wrongCode,
    reset,
    sessionARefresh,
    sessionBRefresh,
    oldLogin,
    newLogin,
    reuse,
  };
  const want = { forgotUnknown: 202, forgotKnown: 202, sameBody: true, wrongCode: 401, reset: 204, sessionARefresh: 401, sessionBRefresh: 401, oldLogin: 401, newLogin: 200, reuse: 401 };
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`Password reset: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  console.log('Password reset: same 202 for known and unknown phones, wrong code 401, reset 204, all sessions revoked, old password refused, new one signs in, code single use');
  await clearRateLimits();
}

/** Clears the rate-limit counters (test Redis only). /auth/login allows 5 a minute for every client behind the gateway. */
async function clearRateLimits() {
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis
    .connect()
    .then(async () => {
      const keys = await redis.keys('ratelimit:*');
      if (keys.length) await redis.del(...keys);
    })
    .finally(() => redis.disconnect());
}

/** An HS256 JWT, signed like SystemTokenService does. */
function signJwt(claims: object, secret: string): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

/** Status and error code of a request, whether it succeeded or failed. */
async function outcomeOf(request: Promise<{ status: number }>): Promise<{ status: number; error?: string }> {
  try {
    return { status: (await request).status };
  } catch (error: any) {
    if (!error.response) throw error;
    return { status: error.response.status, error: error.response.data?.error };
  }
}

/**
 * Account status and the SYSTEM principal (#202): staff tokens carry their permissions; suspending an
 * account ends its sessions and refuses login and refresh with 403 AccountSuspended (a wrong password
 * stays 401); reactivating lets the user sign in again. A real SYSTEM token never gets through the
 * gateway, and a staff token can't use a service-only route.
 */
async function assertAccountSuspension() {
  await clearRateLimits();
  const bearer = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
  const admin = (await axios.post(`${API_URL}/api/auth/login`, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).data;
  const claims = JSON.parse(Buffer.from(admin.accessToken.split('.')[1], 'base64url').toString('utf8'));
  if (claims.role !== 'ADMIN' || claims.perms?.length !== 10 || !claims.perms.includes('users.manage')) {
    throw new Error(`Admin token: role ${claims.role}, perms ${JSON.stringify(claims.perms)}`);
  }

  const email = `e2e.suspend.${Date.now()}@example.com`;
  const user = (await axios.post(`${API_URL}/api/auth/register`, { email, password: 'password123', fullName: 'E2E Suspended' })).data;
  const status = (body: object) => axios.patch(`${API_URL}/api/auth/users/${user.userId}/status`, body, bearer(admin.accessToken));

  const suspended = (await status({ status: 'SUSPENDED', reason: 'E2E check' })).data;
  const refreshAfter = await outcomeOf(axios.post(`${API_URL}/api/auth/refresh`, { refreshToken: user.refreshToken }));
  const loginAfter = await outcomeOf(axios.post(`${API_URL}/api/auth/login`, { email, password: 'password123' }));
  const strangerLogin = await outcomeOf(axios.post(`${API_URL}/api/auth/login`, { email, password: 'wrong-password' }));
  await status({ status: 'ACTIVE' });
  const loginAgain = await outcomeOf(axios.post(`${API_URL}/api/auth/login`, { email, password: 'password123' }));
  const oldSession = await outcomeOf(axios.post(`${API_URL}/api/auth/refresh`, { refreshToken: user.refreshToken }));

  const systemToken = signJwt({ sub: 'system:e2e', email: 'e2e@internal', role: 'SYSTEM', exp: Math.floor(Date.now() / 1000) + 60 }, SYSTEM_JWT_SECRET);
  const systemThroughGateway = await outcomeOf(axios.get(`${API_URL}/api/drivers/available`, bearer(systemToken)));
  const staffOnServiceRoute = await outcomeOf(axios.get(`${API_URL}/api/drivers/available`, bearer(admin.accessToken)));

  const got = {
    suspended: [suspended.status, suspended.sessionsRevoked],
    refreshAfter,
    loginAfter,
    strangerLogin: strangerLogin.status,
    loginAgain: loginAgain.status,
    oldSession,
    systemThroughGateway: systemThroughGateway.status,
    staffOnServiceRoute: staffOnServiceRoute.status,
  };
  const want = {
    suspended: ['SUSPENDED', 1],
    refreshAfter: { status: 403, error: 'AccountSuspended' },
    loginAfter: { status: 403, error: 'AccountSuspended' },
    strangerLogin: 401,
    loginAgain: 200,
    oldSession: { status: 401, error: 'InvalidRefreshToken' },
    systemThroughGateway: 401,
    staffOnServiceRoute: 403,
  };
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`Account status: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  console.log('Account status: staff perms in the token; suspension ends sessions (403 AccountSuspended), reactivation restores login; SYSTEM token refused at the gateway');
  await clearRateLimits();
}

/**
 * Verification email (#203): register → the test sender's email in Redis carries a 6-digit code →
 * a wrong code is refused → the right one verifies → login works. Resending within a minute is 429.
 */
async function assertEmailVerification() {
  const email = `e2e.verify.${Date.now()}@example.com`;
  await axios.post(`${API_URL}/api/auth/register`, { email, password: 'password123', fullName: 'E2E Verify' }, { headers: { 'Accept-Language': 'en' } });

  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();
  const stored = await redis.get(`test:email:${email}`).finally(() => redis.disconnect());
  const sent = stored ? (JSON.parse(stored) as { subject: string; text: string; html: string }) : null;
  const code = sent?.text.match(/\b\d{6}\b/)?.[0];
  if (!sent || !code || !sent.html.includes(code) || sent.subject !== 'Your Delivery Plus verification code') {
    throw new Error(`Verification email: none or no code in it (${stored ? 'stored' : 'missing'})`);
  }

  // Registering sent a code a moment ago: asking again within a minute is refused.
  const resendTooSoon = await outcomeOf(axios.post(`${API_URL}/api/auth/resend-verification`, { email }));
  const wrong = code === '000000' ? '000001' : '000000';
  const wrongCode = await outcomeOf(axios.post(`${API_URL}/api/auth/verify-email`, { email, token: wrong }));
  const verified = await outcomeOf(axios.post(`${API_URL}/api/auth/verify-email`, { email, token: code }));
  const reused = await outcomeOf(axios.post(`${API_URL}/api/auth/verify-email`, { email, token: code }));
  const login = await outcomeOf(axios.post(`${API_URL}/api/auth/login`, { email, password: 'password123' }));

  const got = { resendTooSoon: resendTooSoon.status, wrongCode: wrongCode.status, verified: verified.status, reused: reused.status, login: login.status };
  const want = { resendTooSoon: 429, wrongCode: 401, verified: 200, reused: 401, login: 200 };
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`Email verification: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  console.log('Email verification: the code arrives by the test sender; resend within a minute 429; a wrong code 401, the right one verifies once, login 200');
}

async function runE2E() {
  console.log('Starting E2E test...');

  try {
    // We assume scripts/seed.ts has already run: restaurant OPEN with a menu
    // item, and a driver profile registered and AVAILABLE.
    const customerLogin = await axios.post(`${API_URL}/api/auth/login`, {
      email: 'customer@example.com',
      password: 'password123',
    });
    const customerToken = customerLogin.data.accessToken;
    const customerAuth = { headers: { Authorization: `Bearer ${customerToken}` } };

    const ownerLogin = await axios.post(`${API_URL}/api/auth/login`, {
      email: 'owner@example.com',
      password: 'password123',
    });
    const ownerToken = ownerLogin.data.accessToken;
    const ownerAuth = { headers: { Authorization: `Bearer ${ownerToken}` } };

    const driverLogin = await axios.post(`${API_URL}/api/auth/login`, {
      email: 'driver@example.com',
      password: 'password123',
    });
    const driverToken = driverLogin.data.accessToken;
    const driverAuth = { headers: { Authorization: `Bearer ${driverToken}` } };

    // 0. Registration is a privilege boundary.
    await assertNoSelfRegisteredAdmin();
    await assertRefreshSessions();
    await assertPasswordChange();
    await assertPasswordReset();
    await assertAccountSuspension();
    await assertEmailVerification();

    // 1. Get Restaurants
    const restaurantsRes = await axios.get(`${API_URL}/api/restaurants`, customerAuth);
    const restaurant = restaurantsRes.data.items?.find((item: { name?: string }) => item.name === 'Burger Palace');
    if (!restaurant) {
      throw new Error('E2E setup failed: seeded restaurant "Burger Palace" not found. Run `npm run seed` first.');
    }
    const restaurantId = restaurant.id;

    // 2. Get Menu
    const menuRes = await axios.get(`${API_URL}/api/menus/restaurants/${restaurantId}/menu`, customerAuth);
    if (!menuRes.data.items?.length) {
      throw new Error('E2E setup failed: no menu items available. Run `npm run seed` first.');
    }
    const menuItemId = menuRes.data.items[0].id;

    // 3. Add to Cart
    await axios.post(`${API_URL}/api/cart/items`, { menuItemId, quantity: 2 }, customerAuth);

    // Delivery fee (#145): the quote, the order and the payment all carry the same fee and total.
    const quote = (await axios.get(`${API_URL}/api/orders/quote`, customerAuth)).data;
    const piasters = (amount: string) => Math.round(Number(amount) * 100);
    if (quote.currency !== 'EGP' || piasters(quote.totalAmount) !== piasters(quote.subtotalAmount) + piasters(quote.deliveryFee) || !(piasters(quote.deliveryFee) > 0)) {
      throw new Error(`Quote: ${JSON.stringify(quote)}`);
    }

    // 4. Create Order (CREATED)
    const orderRes = await axios.post(`${API_URL}/api/orders`, {}, customerAuth);
    const orderId = orderRes.data.id;
    console.log(`Order created: ${orderId} (status ${orderRes.data.status})`);

    // No address in the body, so the order must carry a copy of the profile address.
    const profile = await axios.get(`${API_URL}/api/users/me`, customerAuth);
    if (!profile.data.address || orderRes.data.deliveryAddress !== profile.data.address) {
      throw new Error(
        `Order delivery address ${JSON.stringify(orderRes.data.deliveryAddress)} does not match the profile address ${JSON.stringify(profile.data.address)}`,
      );
    }
    console.log(`Order delivery address: ${orderRes.data.deliveryAddress}`);

    // Egyptian mobiles (#152): any common form is stored as E.164; anything else is a 400.
    const phoneUpdate = await axios.patch(`${API_URL}/api/users/me`, { phone: '0020-109-278-4342' }, customerAuth);
    const landline = await statusOf(axios.patch(`${API_URL}/api/users/me`, { phone: '0223456789' }, customerAuth));
    if (phoneUpdate.data.phone !== '+201092784342' || landline !== 400) {
      throw new Error(`Phone normalization: expected +201092784342 and 400 for a landline, got ${phoneUpdate.data.phone} / ${landline}`);
    }
    console.log('Phone: 0020-109-278-4342 stored as +201092784342; landline 400');

    // Phone verification (#153): a code is texted (kept in Redis by the test sender), resending waits for
    // the cooldown, a wrong code is refused, the right one verifies, and changing the phone un-verifies it.
    const otpStart = await axios.post(`${API_URL}/api/users/me/phone/verification`, {}, customerAuth);
    const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
    const smsText = await redis.connect().then(() => redis.get(`test:sms:${otpStart.data.phone}`)).finally(() => redis.disconnect());
    const otpCode = /(\d{6})/.exec(smsText ?? '')?.[1];
    const resendTooSoon = await statusOf(axios.post(`${API_URL}/api/users/me/phone/verification`, {}, customerAuth));
    const wrongCode = await statusOf(
      axios.post(`${API_URL}/api/users/me/phone/verify`, { code: otpCode === '000000' ? '111111' : '000000' }, customerAuth),
    );
    const verified = otpCode ? (await axios.post(`${API_URL}/api/users/me/phone/verify`, { code: otpCode }, customerAuth)).data : null;
    const reverify = await statusOf(axios.post(`${API_URL}/api/users/me/phone/verification`, {}, customerAuth));
    const changed = (await axios.patch(`${API_URL}/api/users/me`, { phone: '01112345678' }, customerAuth)).data;
    if (
      otpStart.status !== 202 ||
      otpStart.data.phone !== '+201092784342' ||
      !otpCode ||
      resendTooSoon !== 429 ||
      wrongCode !== 400 ||
      !verified?.phoneVerifiedAt ||
      reverify !== 409 ||
      changed.phoneVerifiedAt !== null
    ) {
      throw new Error(
        `Phone verification: ${JSON.stringify({ start: otpStart.status, code: !!otpCode, resendTooSoon, wrongCode, verified: verified?.phoneVerifiedAt, reverify, afterChange: changed.phoneVerifiedAt })}`,
      );
    }
    console.log('Phone verification: code texted, resend 429, wrong code 400, verified; a new phone is unverified');

    const getOrder = async () => (await axios.get(`${API_URL}/api/orders/${orderId}`, customerAuth)).data;

    // 5. Create the payment. createPayment's own completeSideEffects call
    // synchronously moves the order to PAYMENT_PENDING via a direct HTTP call
    // to order-service, so this should already be true by the time it returns,
    // but poll briefly in case that side effect had to be retried.
    const paymentRes = await axios.post(`${API_URL}/api/payments`, { orderId }, customerAuth);
    const paymentId = paymentRes.data.id;
    if (
      orderRes.data.deliveryFee !== quote.deliveryFee ||
      orderRes.data.totalAmount !== quote.totalAmount ||
      Number(paymentRes.data.amount) !== Number(quote.totalAmount) ||
      'driverFeeShare' in orderRes.data
    ) {
      throw new Error(
        `Fee consistency: quote ${quote.totalAmount} (fee ${quote.deliveryFee}), order ${orderRes.data.totalAmount} (fee ${orderRes.data.deliveryFee}), payment ${paymentRes.data.amount}`,
      );
    }
    console.log(`Delivery fee: EGP ${quote.subtotalAmount} + EGP ${quote.deliveryFee} = EGP ${quote.totalAmount} in the quote, the order and the payment`);
    console.log(`Payment created: ${paymentId} (status ${paymentRes.data.status})`);

    await waitFor(
      'order to reach PAYMENT_PENDING',
      getOrder,
      (order) => order.status === 'PAYMENT_PENDING',
    );

    // 6. Process (settle) the payment. simulateFailure: false forces the
    // simulated-success branch. It is a test hook: the test stack sets
    // PAYMENT_TEST_HOOKS=true; anywhere else it is a 400 (#201).
    const processedPayment = await axios.post(
      `${API_URL}/api/payments/${paymentId}/process`,
      { simulateFailure: false },
      customerAuth,
    );
    console.log(`Payment processed: status ${processedPayment.data.status}`);
    if (processedPayment.data.status !== 'COMPLETED') {
      throw new Error(`Expected payment to complete, got status ${processedPayment.data.status}`);
    }

    const confirmedOrder = await waitFor(
      'order to reach CONFIRMED',
      getOrder,
      (order) => order.status === 'CONFIRMED',
    );
    console.log(`Order status after payment: ${confirmedOrder.status}`);

    // 7. Restaurant moves the order through its own kitchen states.
    // CONFIRMED -> PREPARING -> READY_FOR_PICKUP (ORDER_TRANSITIONS does not
    // allow skipping PREPARING).
    await axios.patch(`${API_URL}/api/orders/${orderId}/status`, { status: 'PREPARING' }, ownerAuth);
    // #210: keep the seeded driver's existing place in the longest-idle queue.
    const driverProfile = (await axios.get(`${API_URL}/api/drivers/me`, driverAuth)).data;
    if (driverProfile.status !== 'AVAILABLE') await axios.post(`${API_URL}/api/drivers/me/online`, {}, driverAuth);
    await axios.patch(`${API_URL}/api/orders/${orderId}/status`, { status: 'READY_FOR_PICKUP' }, ownerAuth);
    console.log('Order marked READY_FOR_PICKUP');

    // 8. No dispatch call: delivery-service creates the delivery and assigns a driver on
    // order.ready_for_pickup (auto-dispatch).
    const assignedDelivery = await waitFor(
      'auto-dispatch to create the delivery and assign a driver',
      async () => {
        const status = await statusOf(axios.get(`${API_URL}/api/deliveries/by-order/${orderId}`, ownerAuth));
        return status === 200 ? (await axios.get(`${API_URL}/api/deliveries/by-order/${orderId}`, ownerAuth)).data : null;
      },
      (delivery) => delivery?.status === 'DRIVER_ASSIGNED',
      { timeoutMs: 30_000 },
    );
    const deliveryId = assignedDelivery.id;
    if (assignedDelivery.driverId !== driverProfile.id) {
      throw new Error(`Auto-dispatch assigned driver ${assignedDelivery.driverId}, expected the seeded driver ${driverProfile.id}`);
    }
    console.log(`Delivery auto-dispatched: ${deliveryId}, driver ${assignedDelivery.driverId}`);

    // A manual dispatch for the same order can't create a second delivery.
    const manualCreate = await statusOf(axios.post(`${API_URL}/api/deliveries`, { orderId }, ownerAuth));
    if (manualCreate !== 409) {
      throw new Error(`A manual dispatch after auto-dispatch returned ${manualCreate}, expected 409`);
    }

    // The driver discovers the job from their own token alone, with pickup and drop-off details.
    const current = await axios.get(`${API_URL}/api/deliveries/me/current`, driverAuth);
    if (current.status !== 200 || current.data.id !== deliveryId) {
      throw new Error(`Driver current delivery: expected ${deliveryId}, got ${current.status} ${JSON.stringify(current.data)}`);
    }
    if (current.data.dropOff.address !== orderRes.data.deliveryAddress || current.data.nextActions[0] !== 'pickup') {
      throw new Error(`Driver current delivery is missing the drop-off or next action: ${JSON.stringify(current.data)}`);
    }
    const customerCurrent = await statusOf(axios.get(`${API_URL}/api/deliveries/me/current`, customerAuth));
    if (customerCurrent !== 403) {
      throw new Error(`A customer got ${customerCurrent} on the driver-only current-delivery route, expected 403`);
    }
    console.log(`Driver sees current delivery: pickup ${current.data.pickup.name}, drop-off ${current.data.dropOff.address}`);

    // Tracking lifecycle (#32): once the driver reports a position the customer sees it LIVE; after
    // delivery the same read is ENDED and returns no position, although Redis still holds the report.
    const trackingUrl = `${API_URL}/api/tracking/delivery/${deliveryId}`;
    const locationUrl = `${API_URL}/api/tracking/location`;

    // Trust boundaries (#60). Session binding: before the driver reports on this delivery, no position
    // is shown, even if Redis still holds a fresh one from the driver's previous delivery.
    const beforeReport = (await axios.get(trackingUrl, customerAuth)).data;
    if (beforeReport.tracking !== 'AWAITING_LOCATION' || beforeReport.location !== null) {
      throw new Error(`Before the first report on this delivery: expected AWAITING_LOCATION, got ${JSON.stringify(beforeReport)}`);
    }
    // Derived values are never accepted from a client; untrusted timestamps can only cause rejections.
    const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    const clientEta = await statusOf(axios.post(locationUrl, { latitude: 30.0444, longitude: 31.2357, etaSeconds: 60 }, driverAuth));
    const clientGeofence = await statusOf(axios.post(locationUrl, { latitude: 30.0444, longitude: 31.2357, arrived: true }, driverAuth));
    const futureReport = await statusOf(axios.post(locationUrl, { latitude: 30.0444, longitude: 31.2357, recordedAt: secondsAgo(-120) }, driverAuth));
    const staleReport = await statusOf(axios.post(locationUrl, { latitude: 30.0444, longitude: 31.2357, recordedAt: secondsAgo(600) }, driverAuth));
    if (clientEta !== 400 || clientGeofence !== 400 || futureReport !== 422 || staleReport !== 422) {
      throw new Error(`Location trust: client ETA ${clientEta}, client geofence ${clientGeofence} (expected 400); future ${futureReport}, stale ${staleReport} (expected 422)`);
    }
    if ((await axios.get(trackingUrl, customerAuth)).data.tracking !== 'AWAITING_LOCATION') {
      throw new Error('Location trust: a rejected report must not be stored');
    }
    const firstReport = { latitude: 30.0444, longitude: 31.2357, recordedAt: secondsAgo(1) };
    await axios.post(locationUrl, firstReport, driverAuth);
    const replay = await statusOf(axios.post(locationUrl, firstReport, driverAuth));
    if (replay !== 422) {
      throw new Error(`Location trust: a replayed report should be rejected with 422, got ${replay}`);
    }
    console.log('Location trust: no position before the first report on this delivery; client ETA/geofence 400; future, stale and replayed reports 422');

    const liveTracking = (await axios.get(trackingUrl, customerAuth)).data;
    if (liveTracking.tracking !== 'LIVE' || liveTracking.location?.latitude !== 30.0444) {
      throw new Error(`Customer tracking while on the job: expected LIVE with the position, got ${JSON.stringify(liveTracking)}`);
    }
    // Assignment + ETA contract (#46): the customer sees the same assignment delivery-service recorded
    // (and shows the driver in me/current); the ETA is derived, and without an estimator it says why.
    const assignedAt = current.data.assignedAt;
    if (!assignedAt || Number.isNaN(Date.parse(assignedAt)) || Date.parse(assignedAt) > Date.now() + 5_000) {
      throw new Error(`Driver current delivery: expected a server-recorded assignedAt, got ${JSON.stringify(assignedAt)}`);
    }
    if (
      liveTracking.assignment?.driverId !== assignedDelivery.driverId ||
      liveTracking.assignment?.assignedAt !== new Date(assignedAt).toISOString()
    ) {
      throw new Error(`Tracking assignment should match delivery-service, got ${JSON.stringify(liveTracking.assignment)}`);
    }
    if (liveTracking.eta?.status !== 'UNAVAILABLE' || liveTracking.eta?.reason !== 'NOT_ESTIMATED') {
      throw new Error(`Tracking ETA without an estimator should be UNAVAILABLE/NOT_ESTIMATED, got ${JSON.stringify(liveTracking.eta)}`);
    }
    console.log(`Assignment contract: driver ${liveTracking.assignment.driverId} assigned at ${liveTracking.assignment.assignedAt}; ETA ${liveTracking.eta.status} (${liveTracking.eta.reason})`);
    // While that position is live, another customer can read neither this delivery's tracking nor
    // the driver's raw location (#132: the customer map must not widen access).
    const outsider = await axios.post(`${API_URL}/api/auth/register`, {
      email: `e2e.outsider.${Date.now()}@example.com`,
      password: 'password123',
      fullName: 'E2E Outsider',
    });
    const outsiderAuth = { headers: { Authorization: `Bearer ${outsider.data.accessToken}` } };
    const outsiderTracking = await statusOf(axios.get(trackingUrl, outsiderAuth));
    if (outsiderTracking !== 403) {
      throw new Error(`Another customer got ${outsiderTracking} on this delivery's tracking, expected 403`);
    }
    const outsiderDriverLocation = await statusOf(
      axios.get(`${API_URL}/api/tracking/driver/${driverProfile.userId}`, outsiderAuth),
    );
    if (outsiderDriverLocation !== 403) {
      throw new Error(`Another customer got ${outsiderDriverLocation} on the driver's raw location, expected 403`);
    }
    console.log('Tracking authorization: another customer gets 403 on the delivery tracking and the raw driver location');

    // Driver card (#140): the order's customer sees who is coming (first name, photo, vehicle, plate)
    // and nothing else; another customer can't read the delivery at all.
    const byOrderUrl = `${API_URL}/api/deliveries/by-order/${orderId}`;
    const card = (await axios.get(byOrderUrl, customerAuth)).data.driver;
    if (!card || typeof card.displayName !== 'string' || card.displayName.length === 0) {
      throw new Error(`Driver card: expected the assigned driver's card, got ${JSON.stringify(card)}`);
    }
    const cardKeys = Object.keys(card).sort().join(',');
    if (cardKeys !== 'avatarUrl,displayName,licensePlate,vehicleType' || /@|\+20|userId/.test(JSON.stringify(card))) {
      throw new Error(`Driver card must expose only display fields, got ${JSON.stringify(card)}`);
    }
    const outsiderByOrder = await statusOf(axios.get(byOrderUrl, outsiderAuth));
    if (outsiderByOrder !== 403) {
      throw new Error(`Another customer got ${outsiderByOrder} on the delivery read, expected 403`);
    }
    console.log(`Driver card: ${card.displayName}, ${card.vehicleType ?? 'no vehicle'} ${card.licensePlate ?? ''}; another customer 403`);

    // Realtime stream (#135): authorized before streaming, then pushes what changes.
    const anonymousStream = await openTrackingStream(deliveryId, null);
    const outsiderStream = await openTrackingStream(deliveryId, outsider.data.accessToken);
    if (anonymousStream.status !== 401 || outsiderStream.status !== 403) {
      throw new Error(`Tracking stream: anonymous got ${anonymousStream.status} (expected 401), another customer got ${outsiderStream.status} (expected 403)`);
    }
    const trackingStream = await openTrackingStream(deliveryId, customerToken);
    if (trackingStream.status !== 200 || !trackingStream.contentType.startsWith('text/event-stream')) {
      throw new Error(`Tracking stream: expected 200 text/event-stream, got ${trackingStream.status} ${trackingStream.contentType}`);
    }
    const streamedFirst = await trackingStream.next();
    if (streamedFirst.tracking !== 'LIVE' || streamedFirst.location?.latitude !== 30.0444) {
      throw new Error(`Tracking stream: first event should be the current LIVE state, got ${JSON.stringify(streamedFirst)}`);
    }
    // A new report reaches the subscriber by push, well within the 10 s polling interval.
    const pushStartedAt = Date.now();
    await axios.post(`${API_URL}/api/tracking/location`, { latitude: 30.05, longitude: 31.24 }, driverAuth);
    const pushed = await trackingStream.next(5_000);
    if (pushed.tracking !== 'LIVE' || pushed.location?.latitude !== 30.05) {
      throw new Error(`Tracking stream: expected the new position pushed, got ${JSON.stringify(pushed)}`);
    }
    console.log(`Tracking stream: 401 anonymous, 403 another customer; new driver position pushed in ${Date.now() - pushStartedAt} ms`);

    await axios.post(`${API_URL}/api/deliveries/${deliveryId}/pickup`, {}, driverAuth);
    await axios.post(`${API_URL}/api/deliveries/${deliveryId}/start`, {}, driverAuth);
    await axios.post(`${API_URL}/api/deliveries/${deliveryId}/complete`, {}, driverAuth);

    const afterComplete = await axios.get(`${API_URL}/api/deliveries/me/current`, driverAuth);
    if (afterComplete.status !== 204) {
      throw new Error(`After completion the driver should have no current delivery (204), got ${afterComplete.status}`);
    }
    const endedTracking = (await axios.get(trackingUrl, customerAuth)).data;
    if (endedTracking.tracking !== 'ENDED' || endedTracking.location !== null) {
      throw new Error(`Customer tracking after delivery: expected ENDED without a position, got ${JSON.stringify(endedTracking)}`);
    }
    if (endedTracking.eta?.reason !== 'DELIVERY_ENDED' || endedTracking.assignment?.driverId !== assignedDelivery.driverId) {
      throw new Error(`After delivery the ETA must be gone (DELIVERY_ENDED) and the assignment kept, got ${JSON.stringify(endedTracking)}`);
    }
    // #60: with no active delivery the driver can't report a location any more.
    const afterEnd = await statusOf(axios.post(locationUrl, { latitude: 30.0444, longitude: 31.2357 }, driverAuth));
    if (afterEnd !== 409) {
      throw new Error(`Location trust: a report after delivery should be rejected with 409, got ${afterEnd}`);
    }

    // The stream followed pickup → transit → delivered by push and ends with ENDED (no position), then closes.
    const streamedStatuses: string[] = [];
    let streamed = await trackingStream.next(15_000);
    while (streamed.tracking !== 'ENDED') {
      streamedStatuses.push(streamed.status);
      streamed = await trackingStream.next(15_000);
    }
    if (streamed.location !== null) {
      throw new Error(`Tracking stream: ENDED must carry no position, got ${JSON.stringify(streamed)}`);
    }
    if (!(await trackingStream.ended(5_000))) {
      throw new Error('Tracking stream: the server did not close the stream after ENDED');
    }
    console.log(`Tracking stream: pushed ${streamedStatuses.join(' → ') || '(no intermediate states)'} → ENDED, then closed`);
    console.log('Tracking lifecycle: LIVE while on the job, ENDED (no position) after delivery');

    const deliveredOrder = await waitFor(
      'order to reach DELIVERED',
      getOrder,
      (order) => order.status === 'DELIVERED',
    );
    console.log(`Final order status: ${deliveredOrder.status}`);

    if (deliveredOrder.status !== 'DELIVERED') {
      throw new Error(`Expected order to be DELIVERED, got ${deliveredOrder.status}`);
    }

    // Driver history (#142): the delivery just completed is the newest completed one, with its stage
    // times and no customer identity; only DRIVER accounts may ask, and only about themselves.
    const history = await axios.get(`${API_URL}/api/deliveries/me/history?status=completed&limit=5`, driverAuth);
    const done = history.data.items[0];
    if (done?.id !== deliveryId || done.status !== 'DELIVERED' || !done.assignedAt || !done.pickedUpAt || !done.deliveredAt) {
      throw new Error(`Driver history: expected ${deliveryId} first with stage times, got ${JSON.stringify(done)}`);
    }
    if ('customerId' in done || JSON.stringify(done).includes('@') || 'deliveryNotes' in (done.order ?? {})) {
      throw new Error(`Driver history must not expose the customer: ${JSON.stringify(done)}`);
    }
    const customerHistory = await statusOf(axios.get(`${API_URL}/api/deliveries/me/history`, customerAuth));
    if (customerHistory !== 403) {
      throw new Error(`A customer got ${customerHistory} on the driver history, expected 403`);
    }
    console.log(`Driver history: ${done.restaurant?.name ?? '?'} delivered ${done.deliveredAt} (${history.data.total} completed); customer 403`);

    // Earnings ledger (#145): exactly one pending earning for this delivery, half the fee; the
    // balance equals the sum of the entries; only the driver can read it.
    const earnings = (await axios.get(`${API_URL}/api/deliveries/me/earnings?limit=50`, driverAuth)).data;
    const mine = earnings.entries.filter((entry: { deliveryId: string }) => entry.deliveryId === deliveryId);
    const expectedShare = (Math.floor(piasters(quote.deliveryFee) / 2) / 100).toFixed(2);
    if (mine.length !== 1 || mine[0].type !== 'DELIVERY_EARNING' || mine[0].amount !== expectedShare || mine[0].status !== 'PENDING') {
      throw new Error(`Earnings for ${deliveryId}: ${JSON.stringify(mine)}`);
    }
    if (piasters(earnings.pending) + piasters(earnings.available) !== piasters(earnings.balance)) {
      throw new Error(`Earnings totals don't add up: ${JSON.stringify({ pending: earnings.pending, available: earnings.available, balance: earnings.balance })}`);
    }
    const customerEarnings = await statusOf(axios.get(`${API_URL}/api/deliveries/me/earnings`, customerAuth));
    if (customerEarnings !== 403) throw new Error(`A customer got ${customerEarnings} on driver earnings, expected 403`);
    console.log(`Earnings: one PENDING EGP ${expectedShare} for this delivery (settles in ${earnings.settlementHours} h); customer 403`);

    // Ratings (#144): the order's customer rates the driver once; the driver's summary includes it.
    const ratingUrl = `${API_URL}/api/deliveries/${deliveryId}/rating`;
    const before = await axios.get(ratingUrl, customerAuth);
    if (before.data.canRate !== true || before.data.rating !== null) {
      throw new Error(`Rating: expected the customer to be able to rate, got ${JSON.stringify(before.data)}`);
    }
    const summaryBefore = (await axios.get(`${API_URL}/api/deliveries/me/rating-summary`, driverAuth)).data;
    const rated = await axios.post(ratingUrl, { score: 5, comment: 'E2E: quick and careful' }, customerAuth);
    const ratingReplay = await axios.post(ratingUrl, { score: 5, comment: 'E2E: quick and careful' }, customerAuth);
    const duplicate = await statusOf(axios.post(ratingUrl, { score: 2 }, customerAuth));
    const outsiderRating = await statusOf(axios.post(ratingUrl, { score: 1 }, outsiderAuth));
    const driverRating = await statusOf(axios.post(ratingUrl, { score: 5 }, driverAuth));
    if (rated.status !== 201 || ratingReplay.status !== 200 || duplicate !== 409 || outsiderRating !== 403 || driverRating !== 403) {
      throw new Error(
        `Rating: expected 201/200/409/403/403, got ${rated.status}/${ratingReplay.status}/${duplicate}/${outsiderRating}/${driverRating}`,
      );
    }
    const summary = (await axios.get(`${API_URL}/api/deliveries/me/rating-summary`, driverAuth)).data;
    if (summary.count !== summaryBefore.count + 1 || typeof summary.average !== 'number' || JSON.stringify(summary).includes('@')) {
      throw new Error(`Rating summary: expected count ${summaryBefore.count + 1}, got ${JSON.stringify(summary)}`);
    }
    console.log(`Rating: 5★ stored (201), retry 200, change 409, other customer 403, driver 403; driver now ${summary.average} over ${summary.count}`);

    // #5: one notification per customer-visible stage of this order, and no duplicates.
    const stages = ['PAYMENT_COMPLETED', 'ORDER_CONFIRMED', 'DRIVER_ASSIGNED', 'PICKED_UP', 'DELIVERED'];
    const forThisOrder = async () => {
      const page = (await axios.get(`${API_URL}/api/notifications?limit=50`, customerAuth)).data as {
        items: { type: string; message: string }[];
      };
      return page.items.filter((n) => n.message.includes(orderId));
    };
    const orderNotifications = await waitFor('a notification for every stage', forThisOrder, (items) =>
      stages.every((type) => items.some((n) => n.type === type)),
    );
    for (const type of stages) {
      const count = orderNotifications.filter((n) => n.type === type).length;
      if (count !== 1) throw new Error(`Expected exactly one ${type} notification for order ${orderId}, found ${count}`);
    }
    console.log(`Customer notified at every stage: ${stages.join(' → ')}`);

    // Order outcomes (#143): every unsuccessful end records who ended it and why, and the payment
    // status comes from payment events; the customer's list filters by outcome.
    const waitForOrderFields = async (id: string, done: (order: Record<string, unknown>) => boolean, label: string) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const order = (await axios.get(`${API_URL}/api/orders/${id}`, customerAuth)).data;
        if (done(order)) return order;
        if (Date.now() > deadline) throw new Error(`Order ${id}: ${label}, got ${JSON.stringify(order)}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };
    await axios.post(`${API_URL}/api/cart/items`, { menuItemId, quantity: 1 }, customerAuth);
    const declinedId = (await axios.post(`${API_URL}/api/orders`, {}, customerAuth)).data.id;
    const declinedPayment = (await axios.post(`${API_URL}/api/payments`, { orderId: declinedId }, customerAuth)).data;
    await axios.post(`${API_URL}/api/payments/${declinedPayment.id}/process`, { simulateFailure: true }, customerAuth);
    const declined = await waitForOrderFields(
      declinedId,
      (order) => order.status === 'FAILED' && order.paymentStatus === 'FAILED',
      'expected FAILED with payment FAILED',
    );
    if (declined.cancelledBy !== 'PAYMENT' || !String(declined.cancellationReason).includes('declined')) {
      throw new Error(`Declined order outcome: ${JSON.stringify({ by: declined.cancelledBy, reason: declined.cancellationReason })}`);
    }

    await axios.post(`${API_URL}/api/cart/items`, { menuItemId, quantity: 1 }, customerAuth);
    const cancelledId = (await axios.post(`${API_URL}/api/orders`, {}, customerAuth)).data.id;
    await axios.patch(`${API_URL}/api/orders/${cancelledId}/status`, { status: 'CANCELLED' }, customerAuth);
    const cancelled = await waitForOrderFields(cancelledId, (order) => order.status === 'CANCELLED', 'expected CANCELLED');
    if (cancelled.cancelledBy !== 'CUSTOMER' || cancelled.cancellationReason !== 'You cancelled this order.') {
      throw new Error(`Cancelled order outcome: ${JSON.stringify({ by: cancelled.cancelledBy, reason: cancelled.cancellationReason })}`);
    }
    if (deliveredOrder.cancelledBy !== null && deliveredOrder.cancelledBy !== undefined) {
      throw new Error(`A delivered order must have no cancellation, got ${deliveredOrder.cancelledBy}`);
    }

    const endedIds = ((await axios.get(`${API_URL}/api/orders?status=cancelled&limit=50`, customerAuth)).data.items as { id: string }[]).map(
      (order) => order.id,
    );
    const completedIds = ((await axios.get(`${API_URL}/api/orders?status=completed&limit=50`, customerAuth)).data.items as { id: string }[]).map(
      (order) => order.id,
    );
    if (!endedIds.includes(declinedId) || !endedIds.includes(cancelledId) || endedIds.includes(orderId) || !completedIds.includes(orderId)) {
      throw new Error('Order list filters: expected the declined and cancelled orders under cancelled, the delivered one under completed');
    }
    console.log('Order outcomes: declined → PAYMENT (payment FAILED), customer cancel → CUSTOMER; list filters completed/cancelled');

    // Menu management (#148): the owner creates, edits and archives an item; customers never see the
    // archived item, it can't be added to a cart, and another owner can't touch the menu.
    const category = (await axios.post(`${API_URL}/api/menus/categories`, { restaurantId, name: 'E2E Specials' }, ownerAuth)).data;
    const created = (
      await axios.post(
        `${API_URL}/api/menus/menu-items`,
        { restaurantId, categoryId: category.id, name: '  E2E Soup  ', description: 'Made for the test', price: 4.5 },
        ownerAuth,
      )
    ).data;
    const edited = (await axios.patch(`${API_URL}/api/menus/menu-items/${created.id}`, { name: 'E2E Soup of the day', price: 5 }, ownerAuth)).data;
    const nonEmptyCategoryDelete = await statusOf(axios.delete(`${API_URL}/api/menus/categories/${category.id}`, ownerAuth));
    const strangerOwner = await axios.post(`${API_URL}/api/auth/register`, {
      email: `e2e.owner.${Date.now()}@example.com`,
      password: 'password123',
      fullName: 'E2E Other Owner',
      role: 'RESTAURANT_OWNER',
    });
    const strangerAuth = { headers: { Authorization: `Bearer ${strangerOwner.data.accessToken}` } };
    const strangerEdit = await statusOf(axios.patch(`${API_URL}/api/menus/categories/${category.id}`, { name: 'Mine now' }, strangerAuth));
    const strangerArchive = await statusOf(axios.delete(`${API_URL}/api/menus/menu-items/${created.id}`, strangerAuth));
    await axios.delete(`${API_URL}/api/menus/menu-items/${created.id}`, ownerAuth);
    const publicMenu = (await axios.get(`${API_URL}/api/menus/restaurants/${restaurantId}/menu`, customerAuth)).data;
    const archivedToCart = await statusOf(axios.post(`${API_URL}/api/cart/items`, { menuItemId: created.id, quantity: 1 }, customerAuth));
    const editArchived = await statusOf(axios.patch(`${API_URL}/api/menus/menu-items/${created.id}`, { price: 6 }, ownerAuth));
    await axios.delete(`${API_URL}/api/menus/categories/${category.id}`, ownerAuth);
    if (
      created.name !== 'E2E Soup' ||
      edited.name !== 'E2E Soup of the day' ||
      nonEmptyCategoryDelete !== 409 ||
      strangerEdit !== 403 ||
      strangerArchive !== 403 ||
      publicMenu.items.some((menuItem: { id: string }) => menuItem.id === created.id) ||
      archivedToCart !== 400 ||
      editArchived !== 409
    ) {
      throw new Error(
        `Menu management: ${JSON.stringify({ created: created.name, edited: edited.name, nonEmptyCategoryDelete, strangerEdit, strangerArchive, archivedToCart, editArchived })}`,
      );
    }
    console.log('Menu management: create → edit → archive; hidden from customers, not addable (400), not editable (409); other owner 403');

    // Checkout re-validation (#42): a price changed after the item went into the cart is never charged
    // silently; the order is refused with what changed, the cart now holds the new price, and the retry
    // is priced from it. Quantities are capped.
    // Checkout allows 5 orders a minute per customer and this script places more: clear the counters (test Redis only).
    const checkoutLimits = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await checkoutLimits
      .connect()
      .then(async () => {
        const keys = await checkoutLimits.keys('ratelimit:*');
        if (keys.length) await checkoutLimits.del(...keys);
      })
      .finally(() => checkoutLimits.disconnect());
    const repriced =(await axios.post(`${API_URL}/api/menus/menu-items`, { restaurantId, name: 'E2E Repriced', price: 40 }, ownerAuth)).data;
    await axios.delete(`${API_URL}/api/cart`, customerAuth);
    await axios.post(`${API_URL}/api/cart/items`, { menuItemId: repriced.id, quantity: 2 }, customerAuth);
    await axios.patch(`${API_URL}/api/menus/menu-items/${repriced.id}`, { price: 45 }, ownerAuth);
    const staleCheckout = await axios.post(`${API_URL}/api/orders`, {}, customerAuth).then(
      () => ({ status: 201, data: null as any }),
      (error) => ({ status: error.response?.status, data: error.response?.data }),
    );
    const cartAfter = (await axios.get(`${API_URL}/api/cart`, customerAuth)).data;
    const retried = (await axios.post(`${API_URL}/api/orders`, {}, customerAuth)).data;
    const tooMany = await statusOf(axios.post(`${API_URL}/api/cart/items`, { menuItemId: repriced.id, quantity: 21 }, customerAuth));
    await axios.patch(`${API_URL}/api/orders/${retried.id}/status`, { status: 'CANCELLED' }, customerAuth);
    await axios.delete(`${API_URL}/api/menus/menu-items/${repriced.id}`, ownerAuth);
    const change = staleCheckout.data?.details?.changes?.[0];
    if (
      staleCheckout.status !== 409 ||
      staleCheckout.data?.error !== 'CartChanged' ||
      change?.change !== 'PRICE_CHANGED' ||
      change?.previousPrice !== 40 ||
      change?.currentPrice !== 45 ||
      cartAfter.items?.[0]?.price !== 45 ||
      retried.subtotalAmount !== '90.00' ||
      tooMany !== 400
    ) {
      throw new Error(`Checkout re-validation: ${JSON.stringify({ staleCheckout, cartAfter: cartAfter.items, subtotal: retried.subtotalAmount, tooMany })}`);
    }
    console.log('Checkout re-validation: price 40 → 45 after adding → 409 CartChanged, cart updated, retry priced at 2 × 45; 21 of one item 400');

    // Item images (#149): ordered images with the first mirrored into imageUrl; remove promotes the next.
    const photoItem = (
      await axios.post(`${API_URL}/api/menus/menu-items`, { restaurantId, name: 'E2E Photo Dish', price: 30 }, ownerAuth)
    ).data;
    const addPhoto = async () => {
      const presigned = (
        await axios.post(`${API_URL}/api/menus/menu-items/${photoItem.id}/image-upload-url`, { contentType: 'image/jpeg' }, ownerAuth)
      ).data;
      await uploadImage('restaurant-cover.jpg', presigned);
      return (await axios.post(`${API_URL}/api/menus/menu-items/${photoItem.id}/image-confirm`, { objectKey: presigned.objectKey }, ownerAuth)).data;
    };
    const first = await addPhoto();
    const second = await addPhoto();
    const badType = await statusOf(
      axios.post(`${API_URL}/api/menus/menu-items/${photoItem.id}/image-upload-url`, { contentType: 'image/gif' }, ownerAuth),
    );
    const afterRemove = (
      await axios.delete(`${API_URL}/api/menus/menu-items/${photoItem.id}/images/${second.images[0].id}`, ownerAuth)
    ).data;
    const shown = (await axios.get(`${API_URL}/api/menus/restaurants/${restaurantId}/menu`, customerAuth)).data.items.find(
      (menuItem: { id: string }) => menuItem.id === photoItem.id,
    );
    await axios.delete(`${API_URL}/api/menus/menu-items/${photoItem.id}`, ownerAuth);
    if (
      first.images.length !== 1 ||
      first.imageUrl !== first.images[0].url ||
      second.images.length !== 2 ||
      second.imageUrl !== first.images[0].url ||
      afterRemove.images.length !== 1 ||
      afterRemove.imageUrl !== second.images[1].url ||
      shown?.imageUrl !== afterRemove.imageUrl ||
      badType !== 400
    ) {
      throw new Error(`Item images: ${JSON.stringify({ first: first.images, second: second.images, afterRemove: afterRemove.images, shown: shown?.imageUrl, badType })}`);
    }
    console.log('Item images: two uploads ordered, first is the primary; removing it promotes the next; customers see it; GIF 400');

    // Driver profile (#147): the vehicle only changes while offline (the driver is AVAILABLE here).
    // Only a VERIFIED driver can be online (#206); the test stack verifies seeded drivers (DRIVER_AUTO_VERIFY).
    const vehicleWhileOnline = await statusOf(axios.patch(`${API_URL}/api/drivers/me/vehicle`, { vehicleType: 'Car', licensePlate: 'E2E-1' }, driverAuth));
    const ownProfile = (await axios.get(`${API_URL}/api/drivers/me`, driverAuth)).data;
    if (vehicleWhileOnline !== 409 || ownProfile.verificationStatus !== 'VERIFIED') {
      throw new Error(`Driver profile: vehicle change while online got ${vehicleWhileOnline}, verification ${ownProfile.verificationStatus}`);
    }
    console.log(`Driver profile: vehicle change while online 409; verification ${ownProfile.verificationStatus}`);

    // Restaurant operations (#154): reject only before preparing, with a reason the customer is told.
    await axios.post(`${API_URL}/api/cart/items`, { menuItemId, quantity: 1 }, customerAuth);
    const rejectId = (await axios.post(`${API_URL}/api/orders`, {}, customerAuth)).data.id;
    const rejectPayment = (await axios.post(`${API_URL}/api/payments`, { orderId: rejectId }, customerAuth)).data;
    await axios.post(`${API_URL}/api/payments/${rejectPayment.id}/process`, { simulateFailure: false }, customerAuth);
    await waitForOrderFields(rejectId, (order) => order.status === 'CONFIRMED', 'expected CONFIRMED');
    await axios.patch(`${API_URL}/api/orders/${rejectId}/status`, { status: 'CANCELLED', reason: 'Out of stock tonight' }, ownerAuth);
    const rejected = await waitForOrderFields(rejectId, (order) => order.status === 'CANCELLED', 'expected CANCELLED');
    const deadlineNote = Date.now() + 20_000;
    let rejectNote: { message?: string; messageKey?: string; params?: Record<string, string> } | undefined;
    while (!rejectNote && Date.now() < deadlineNote) {
      const notes = (await axios.get(`${API_URL}/api/notifications?limit=50`, customerAuth)).data;
      rejectNote = (notes.items ?? notes).find((note: { type?: string; message?: string }) => note.type === 'ORDER_CANCELLED' && note.message?.includes('Out of stock tonight'));
      if (!rejectNote) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const lateReject = await statusOf(axios.patch(`${API_URL}/api/orders/${orderId}/status`, { status: 'CANCELLED', reason: 'too late' }, ownerAuth));
    const summary154 = (await axios.get(`${API_URL}/api/orders/restaurant/${restaurantId}/summary`, ownerAuth)).data;
    if (
      rejected.cancelledBy !== 'RESTAURANT' ||
      rejected.cancellationReason !== 'The restaurant cancelled this order: Out of stock tonight' ||
      !rejectNote ||
      // #151: the owner's words are kept apart, and the notification carries a key + params for the apps.
      rejected.cancellationNote !== 'Out of stock tonight' ||
      rejectNote.messageKey !== 'order.cancelled' ||
      rejectNote.params?.note !== 'Out of stock tonight' ||
      rejectNote.params?.cancelledBy !== 'RESTAURANT' ||
      lateReject !== 409 ||
      !(summary154.orders >= 1) ||
      summary154.currency !== 'EGP'
    ) {
      throw new Error(`Restaurant ops: ${JSON.stringify({ by: rejected.cancelledBy, reason: rejected.cancellationReason, note: !!rejectNote, lateReject, summary154 })}`);
    }
    console.log(`Restaurant ops: rejected with a reason (customer notified), late reject 409, today: ${summary154.orders} orders, EGP ${summary154.revenue}`);

    // Cancellations and refunds (#53/#56, docs/business/cancellation-and-refunds.md).
    // Checkout is limited to 5 orders a minute per customer, and this script has just placed several:
    // clear the counters (test Redis only) rather than slow the run down.
    const limits = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });
    await limits
      .connect()
      .then(async () => {
        const keys = await limits.keys('ratelimit:*');
        if (keys.length) await limits.del(...keys);
      })
      .finally(() => limits.disconnect());
    const notificationOf = async (type: string, id: string) => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const notes = (await axios.get(`${API_URL}/api/notifications?limit=50`, customerAuth)).data;
        const found = (notes.items ?? notes).find(
          (note: { type?: string; params?: Record<string, string> | null }) => note.type === type && note.params?.orderId === id,
        );
        if (found) return found as { params: Record<string, string> };
        if (Date.now() > deadline) throw new Error(`No ${type} notification for order ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    };
    const paidOrder = async () => {
      await axios.post(`${API_URL}/api/cart/items`, { menuItemId, quantity: 1 }, customerAuth);
      const id = (await axios.post(`${API_URL}/api/orders`, {}, customerAuth)).data.id as string;
      const payment = (await axios.post(`${API_URL}/api/payments`, { orderId: id }, customerAuth)).data;
      await axios.post(`${API_URL}/api/payments/${payment.id}/process`, { simulateFailure: false }, customerAuth);
      await waitForOrderFields(id, (order) => order.status === 'CONFIRMED', 'expected CONFIRMED');
      return { id, payment };
    };

    // 1. The rejected (paid) order above is refunded in full, recorded as the restaurant's.
    const rejectRefunded = await waitForOrderFields(rejectId, (order) => order.paymentStatus === 'REFUNDED', 'expected payment REFUNDED');
    const rejectRefund = (await axios.get(`${API_URL}/api/payments/${rejectPayment.id}/refund`, customerAuth)).data;
    const rejectRefundNote = await notificationOf('PAYMENT_REFUNDED', rejectId);

    // 2. A customer cancels a paid order before preparation: full refund, once.
    const paid = await paidOrder();
    await axios.patch(`${API_URL}/api/orders/${paid.id}/status`, { status: 'CANCELLED' }, customerAuth);
    await waitForOrderFields(paid.id, (order) => order.status === 'CANCELLED' && order.paymentStatus === 'REFUNDED', 'expected CANCELLED + REFUNDED');
    const customerRefund = (await axios.get(`${API_URL}/api/payments/${paid.payment.id}/refund`, customerAuth)).data;
    const refundedPayment = (await axios.get(`${API_URL}/api/payments/${paid.payment.id}`, customerAuth)).data;
    const cancelAgain = await statusOf(axios.patch(`${API_URL}/api/orders/${paid.id}/status`, { status: 'CANCELLED' }, customerAuth));
    const supportRefundByCustomer = await statusOf(axios.post(`${API_URL}/api/payments/${paid.payment.id}/refund`, {}, customerAuth));

    // 3. Once the kitchen starts, the customer can no longer cancel (the API enforces the app's rule).
    const cooking = await paidOrder();
    await axios.patch(`${API_URL}/api/orders/${cooking.id}/status`, { status: 'PREPARING' }, ownerAuth);
    const lateCustomerCancel = await statusOf(axios.patch(`${API_URL}/api/orders/${cooking.id}/status`, { status: 'CANCELLED' }, customerAuth));
    const stillPaid = (await axios.get(`${API_URL}/api/payments/${cooking.payment.id}`, customerAuth)).data;

    // 4. Nothing collected, nothing refunded: the unpaid cancelled order and the declined one.
    const unpaidCancelled = (await axios.get(`${API_URL}/api/orders/${cancelledId}`, customerAuth)).data;
    const declinedRefund = await statusOf(axios.get(`${API_URL}/api/payments/${declinedPayment.id}/refund`, customerAuth));
    const declinedNote = await notificationOf('PAYMENT_FAILED', declinedId);

    if (
      rejectRefunded.status !== 'CANCELLED' ||
      rejectRefund.initiatedBy !== 'RESTAURANT' ||
      rejectRefund.amount !== rejectPayment.amount ||
      rejectRefund.currency !== 'EGP' ||
      rejectRefund.provider !== 'SIMULATED' ||
      rejectRefundNote.params.amount !== Number(rejectPayment.amount).toFixed(2) ||
      customerRefund.initiatedBy !== 'CUSTOMER' ||
      customerRefund.amount !== paid.payment.amount ||
      refundedPayment.status !== 'REFUNDED' ||
      cancelAgain !== 200 ||
      supportRefundByCustomer !== 403 ||
      lateCustomerCancel !== 409 ||
      stillPaid.status !== 'COMPLETED' ||
      unpaidCancelled.paymentStatus !== null ||
      declinedRefund !== 404 ||
      declinedNote.params.orderId !== declinedId
    ) {
      throw new Error(
        `Cancellations/refunds: ${JSON.stringify({ rejectRefund, customerRefund, refunded: refundedPayment.status, cancelAgain, supportRefundByCustomer, lateCustomerCancel, stillPaid: stillPaid.status, unpaid: unpaidCancelled.paymentStatus, declinedRefund })}`,
      );
    }
    console.log(
      `Refunds: restaurant reject → EGP ${rejectRefund.amount} refunded (customer notified); customer cancel → refunded once; cancel after PREPARING 409; unpaid/declined → no refund`,
    );

    console.log('E2E critical-path flow completed successfully!');
  } catch (error: any) {
    console.error('E2E failed:');
    if (error.response) {
      console.error(error.response.status, JSON.stringify(error.response.data));
    } else {
      console.error(error.message);
    }
    process.exit(1);
  }
}

runE2E();