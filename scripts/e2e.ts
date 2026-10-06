import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:3000';

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

    const getOrder = async () => (await axios.get(`${API_URL}/api/orders/${orderId}`, customerAuth)).data;

    // 5. Create the payment. createPayment's own completeSideEffects call
    // synchronously moves the order to PAYMENT_PENDING via a direct HTTP call
    // to order-service, so this should already be true by the time it returns,
    // but poll briefly in case that side effect had to be retried.
    const paymentRes = await axios.post(`${API_URL}/api/payments`, { orderId }, customerAuth);
    const paymentId = paymentRes.data.id;
    console.log(`Payment created: ${paymentId} (status ${paymentRes.data.status})`);

    await waitFor(
      'order to reach PAYMENT_PENDING',
      getOrder,
      (order) => order.status === 'PAYMENT_PENDING',
    );

    // 6. Process (settle) the payment. simulateFailure: false forces the
    // simulated-success branch rather than leaving it to PAYMENT_SUCCESS_RATE.
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
    // Auto-dispatch picks the most recently updated AVAILABLE driver: cycle the seeded driver
    // (scripts/seed.ts) just before the order becomes ready so it is the one picked.
    const driverProfile = (await axios.get(`${API_URL}/api/drivers/me`, driverAuth)).data;
    if (driverProfile.status === 'AVAILABLE') await axios.post(`${API_URL}/api/drivers/me/offline`, {}, driverAuth);
    await axios.post(`${API_URL}/api/drivers/me/online`, {}, driverAuth);
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