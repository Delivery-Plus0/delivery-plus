/**
 * Shared helpers for the gateway-only seed scripts (`seed-demo.ts`, `seed-e2e.ts`).
 *
 * Everything goes through the public API Gateway — never PostgreSQL — so seeded records pass the
 * same validation, ownership rules, and Kafka flows as real traffic.
 */
import axios, { AxiosError, type AxiosRequestConfig } from 'axios';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Auth = { headers: { Authorization: string }; userId: string };
export type RestaurantStatus = 'OPEN' | 'BUSY' | 'CLOSED';
export type MenuItemSeed = {
  name: string;
  description: string;
  price: number;
  available?: boolean;
};
export type RestaurantSeed = {
  name: string;
  description: string;
  address: string;
  status: RestaurantStatus;
  /** File name under scripts/seed-assets. */
  coverImage?: string;
  categories: { name: string; items: MenuItemSeed[] }[];
  /** Items with no category, to exercise the app's uncategorized "More" section. */
  uncategorized?: MenuItemSeed[];
};
export type Restaurant = {
  id: string;
  ownerId: string;
  name: string;
  status: string;
  coverImageUrl?: string | null;
};
export type MenuItem = { id: string; name: string; available: boolean; categoryId?: string | null };
export type Order = { id: string; status: string };
type Menu = { categories: { id: string; name: string }[]; items: MenuItem[] };
type Payment = { id: string; status: string };
type PresignedUpload = { uploadUrl: string; objectKey: string; fields: Record<string, string> };

const ASSETS_DIR = join(__dirname, '..', 'seed-assets');
const RATE_LIMIT_WAIT_MS = 61_000;
const MAX_RATE_LIMIT_RETRIES = 3;

const http = axios.create({ timeout: 20_000 });

/** Points every helper at a gateway (e.g. :3000 for dev, :3100 for the E2E environment). */
export function useGateway(apiUrl: string) {
  http.defaults.baseURL = apiUrl;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function log(message: string) {
  console.log(message);
}

/** Retries requests that hit the gateway's per-route rate limits instead of failing the seed. */
export async function send<T>(config: AxiosRequestConfig): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await http.request<T>(config)).data;
    } catch (error) {
      if (
        error instanceof AxiosError &&
        error.response?.status === 429 &&
        attempt < MAX_RATE_LIMIT_RETRIES
      ) {
        log(
          `  rate limited on ${config.method?.toUpperCase()} ${config.url} — waiting ${RATE_LIMIT_WAIT_MS / 1000}s`,
        );
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }
      throw error;
    }
  }
}

export const get = <T>(url: string, auth?: Auth) =>
  send<T>({ method: 'GET', url, headers: auth?.headers });
export const post = <T>(
  url: string,
  data: unknown,
  auth?: Auth,
  headers: Record<string, string> = {},
) => send<T>({ method: 'POST', url, data, headers: { ...auth?.headers, ...headers } });
export const patch = <T>(url: string, data: unknown, auth: Auth) =>
  send<T>({ method: 'PATCH', url, data, headers: auth.headers });
export const del = <T>(url: string, auth: Auth) =>
  send<T>({ method: 'DELETE', url, headers: auth.headers });

export function statusOf(error: unknown): number | undefined {
  return error instanceof AxiosError ? error.response?.status : undefined;
}

export async function loginOrRegister(
  email: string,
  password: string,
  fullName: string,
  role: string,
  phone?: string,
): Promise<Auth> {
  type AuthResponse = { accessToken: string; userId: string };
  let response: AuthResponse;
  try {
    response = await post<AuthResponse>('/api/auth/login', { email, password });
  } catch (error) {
    if (statusOf(error) !== 401) throw error;
    log(`  registering ${email}`);
    response = await post<AuthResponse>('/api/auth/register', {
      email,
      password,
      fullName,
      role,
      phone,
    });
  }
  return { headers: { Authorization: `Bearer ${response.accessToken}` }, userId: response.userId };
}

// --- Media (presigned S3 POST → confirm), best-effort so a storage hiccup never blocks a seed ---

export async function uploadImage(file: string, presigned: PresignedUpload): Promise<void> {
  const form = new FormData();
  for (const [key, value] of Object.entries(presigned.fields)) form.append(key, value);
  form.append(
    'file',
    new Blob([readFileSync(join(ASSETS_DIR, file))], { type: 'image/jpeg' }),
    file,
  );

  const response = await fetch(presigned.uploadUrl, { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error(`storage upload failed: ${response.status} ${await response.text()}`);
  }
}

export async function tryImage(label: string, action: () => Promise<void>) {
  try {
    await action();
    log(`  ${label} uploaded`);
  } catch (error) {
    const detail =
      error instanceof AxiosError ? JSON.stringify(error.response?.data) : (error as Error).message;
    log(`  ! skipped ${label}: ${detail}`);
  }
}

export async function uploadAvatar(customer: Auth, file: string) {
  const presigned = await post<PresignedUpload>(
    '/api/users/me/avatar/image-upload-url',
    { contentType: 'image/jpeg' },
    customer,
  );
  await uploadImage(file, presigned);
  await post('/api/users/me/avatar/confirm', { objectKey: presigned.objectKey }, customer);
}

// --- Catalog ---

/** Creates or reuses (by name + owner) a restaurant, its categories, items, availability and status. */
export async function seedRestaurant(
  seed: RestaurantSeed,
  owner: Auth,
): Promise<{ restaurant: Restaurant; items: Map<string, MenuItem> }> {
  log(`• ${seed.name}`);
  const existing = await get<{ items: Restaurant[] }>(
    `/api/restaurants?search=${encodeURIComponent(seed.name)}&limit=50`,
  );
  let restaurant = existing.items.find(
    (item) => item.name === seed.name && item.ownerId === owner.userId,
  );

  if (!restaurant) {
    restaurant = await post<Restaurant>(
      '/api/restaurants',
      { name: seed.name, description: seed.description, address: seed.address },
      owner,
    );
    log('  created');
  }

  if (seed.coverImage && !restaurant.coverImageUrl) {
    const restaurantId = restaurant.id;
    await tryImage('cover image', async () => {
      const presigned = await post<PresignedUpload>(
        `/api/restaurants/${restaurantId}/image-upload-url`,
        { imageType: 'cover', contentType: 'image/jpeg' },
        owner,
      );
      await uploadImage(seed.coverImage!, presigned);
      await post(
        `/api/restaurants/${restaurantId}/image-confirm`,
        { imageType: 'cover', objectKey: presigned.objectKey },
        owner,
      );
    });
  }

  const menu = await get<Menu>(`/api/menus/restaurants/${restaurant.id}/menu`);
  const categoryIds = new Map(menu.categories.map((category) => [category.name, category.id]));

  for (const [index, category] of seed.categories.entries()) {
    if (!categoryIds.has(category.name)) {
      const created = await post<{ id: string }>(
        '/api/menus/categories',
        { restaurantId: restaurant.id, name: category.name, displayOrder: index + 1 },
        owner,
      );
      categoryIds.set(category.name, created.id);
    }
  }

  const items = new Map(menu.items.map((item) => [item.name, item]));
  const wanted = [
    ...seed.categories.flatMap((category) =>
      category.items.map((item) => ({ ...item, categoryId: categoryIds.get(category.name) })),
    ),
    ...(seed.uncategorized ?? []).map((item) => ({ ...item, categoryId: undefined })),
  ];

  let createdCount = 0;
  for (const item of wanted) {
    if (items.has(item.name)) continue;
    const created = await post<MenuItem>(
      '/api/menus/menu-items',
      {
        restaurantId: restaurant.id,
        categoryId: item.categoryId,
        name: item.name,
        description: item.description,
        price: item.price,
      },
      owner,
    );
    items.set(created.name, created);
    createdCount += 1;
  }
  if (createdCount) log(`  ${createdCount} menu items created`);

  for (const item of wanted) {
    const desired = item.available ?? true;
    const current = items.get(item.name)!;
    if (current.available !== desired) {
      await patch(
        `/api/menus/menu-items/${current.id}/availability`,
        { available: desired },
        owner,
      );
      items.set(item.name, { ...current, available: desired });
      log(`  ${item.name} marked ${desired ? 'available' : 'sold out'}`);
    }
  }

  if (restaurant.status !== seed.status) {
    restaurant = await patch<Restaurant>(
      `/api/restaurants/${restaurant.id}/status`,
      { status: seed.status },
      owner,
    );
    log(`  status → ${seed.status}`);
  }

  return { restaurant, items };
}

// --- Orders, payments, dispatch ---

export async function waitForOrder(
  orderId: string,
  auth: Auth,
  ...statuses: string[]
): Promise<Order> {
  const deadline = Date.now() + 20_000;
  let last = '';
  while (Date.now() < deadline) {
    const order = await get<Order>(`/api/orders/${orderId}`, auth);
    if (statuses.includes(order.status)) return order;
    last = order.status;
    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for order ${orderId} to reach ${statuses.join('/')} (last seen ${last})`,
  );
}

/** Cart → order → payment (settled as success or a simulated decline). */
export async function placeOrder(
  customer: Auth,
  lines: { item: MenuItem; quantity: number }[],
  paymentOutcome: 'success' | 'failure',
): Promise<Order> {
  await del('/api/cart', customer);
  for (const { item, quantity } of lines) {
    await post('/api/cart/items', { menuItemId: item.id, quantity }, customer);
  }

  const order = await post<Order>('/api/orders', {}, customer, {
    'Idempotency-Key': `seed-${Date.now()}-${Math.random()}`,
  });
  const payment = await post<Payment>('/api/payments', { orderId: order.id }, customer);
  await waitForOrder(order.id, customer, 'PAYMENT_PENDING');

  await post(
    `/api/payments/${payment.id}/process`,
    { simulateFailure: paymentOutcome === 'failure' },
    customer,
  );
  return waitForOrder(order.id, customer, paymentOutcome === 'failure' ? 'FAILED' : 'CONFIRMED');
}

/**
 * delivery-service assigns the most recently updated AVAILABLE driver, so cycle the driver
 * offline → online right before the order becomes ready to make sure it is the one picked.
 */
export async function prepareDriver(driver: Auth) {
  const { status } = await get<{ status: string }>('/api/drivers/me', driver);
  if (status === 'BUSY' || status === 'SUSPENDED') {
    throw new Error(`Driver is ${status}; it must be AVAILABLE to take a new delivery.`);
  }
  if (status === 'AVAILABLE') await post('/api/drivers/me/offline', {}, driver);
  await post('/api/drivers/me/online', {}, driver);
}

/** Polls the order's delivery until a driver is assigned (auto-dispatch creates and assigns it). */
export async function waitForAssignment(
  orderId: string,
  auth: Auth,
): Promise<{ id: string; driverId?: string; status: string }> {
  const deadline = Date.now() + 30_000;
  let last = 'no delivery yet';
  while (Date.now() < deadline) {
    try {
      const delivery = await get<{ id: string; driverId?: string; status: string }>(
        `/api/deliveries/by-order/${orderId}`,
        auth,
      );
      if (delivery.status !== 'CREATED') return delivery;
      last = 'delivery waiting for a driver';
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for a driver to be assigned to order ${orderId} (${last})`);
}

/**
 * Restaurant side: prepare and mark ready. delivery-service then creates the delivery and assigns a
 * driver by itself (auto-dispatch). `driver` is brought online last so it is the one picked.
 * Returns the delivery id.
 */
export async function dispatch(
  orderId: string,
  owner: Auth,
  driver: Auth,
  driverId: string,
): Promise<string> {
  await patch(`/api/orders/${orderId}/status`, { status: 'PREPARING' }, owner);
  await prepareDriver(driver);
  await patch(`/api/orders/${orderId}/status`, { status: 'READY_FOR_PICKUP' }, owner);
  const delivery = await waitForAssignment(orderId, owner);
  if (delivery.driverId !== driverId) {
    throw new Error(
      `Delivery was assigned to driver ${delivery.driverId}, not the expected driver — another driver went online at the same moment; rerun.`,
    );
  }
  return delivery.id;
}

/** Driver side: pickup → start (in transit) → optionally complete. */
export async function driveDelivery(deliveryId: string, driver: Auth, complete: boolean) {
  await post(`/api/deliveries/${deliveryId}/pickup`, {}, driver);
  await post(`/api/deliveries/${deliveryId}/start`, {}, driver);
  if (complete) await post(`/api/deliveries/${deliveryId}/complete`, {}, driver);
}

export async function ensureDriverProfile(driver: Auth, vehicleType: string, licensePlate: string) {
  try {
    await get('/api/drivers/me', driver);
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
    await post('/api/drivers/register', { vehicleType, licensePlate }, driver);
  }
}

/** Standard CLI wrapper: prints a useful gateway error and exits non-zero. */
export function runSeed(name: string, main: () => Promise<void>) {
  main().catch((error: unknown) => {
    console.error(`\n${name} failed:`);
    if (error instanceof AxiosError && error.response) {
      console.error(
        error.config?.method?.toUpperCase(),
        error.config?.url,
        error.response.status,
        JSON.stringify(error.response.data),
      );
    } else {
      console.error(error instanceof Error ? error.message : error);
    }
    process.exit(1);
  });
}
