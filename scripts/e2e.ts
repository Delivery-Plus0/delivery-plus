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
    await axios.patch(`${API_URL}/api/orders/${orderId}/status`, { status: 'READY_FOR_PICKUP' }, ownerAuth);
    console.log('Order marked READY_FOR_PICKUP');

    // 8. Dispatch a delivery for the order (restaurant owner / dispatch role).
    const deliveryRes = await axios.post(`${API_URL}/api/deliveries`, { orderId }, ownerAuth);
    const deliveryId = deliveryRes.data.id;
    console.log(`Delivery created: ${deliveryId} (status ${deliveryRes.data.status})`);

    // 9. Auto-assign the next available driver (seeded and brought online by
    // scripts/seed.ts) and drive the delivery to completion.
    const assigned = await axios.post(`${API_URL}/api/deliveries/${deliveryId}/assign`, {}, ownerAuth);
    console.log(`Driver assigned: ${assigned.data.driverId}`);

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

    await axios.post(`${API_URL}/api/deliveries/${deliveryId}/pickup`, {}, driverAuth);
    await axios.post(`${API_URL}/api/deliveries/${deliveryId}/start`, {}, driverAuth);
    await axios.post(`${API_URL}/api/deliveries/${deliveryId}/complete`, {}, driverAuth);

    const afterComplete = await axios.get(`${API_URL}/api/deliveries/me/current`, driverAuth);
    if (afterComplete.status !== 204) {
      throw new Error(`After completion the driver should have no current delivery (204), got ${afterComplete.status}`);
    }

    const deliveredOrder = await waitFor(
      'order to reach DELIVERED',
      getOrder,
      (order) => order.status === 'DELIVERED',
    );
    console.log(`Final order status: ${deliveredOrder.status}`);

    if (deliveredOrder.status !== 'DELIVERED') {
      throw new Error(`Expected order to be DELIVERED, got ${deliveredOrder.status}`);
    }

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