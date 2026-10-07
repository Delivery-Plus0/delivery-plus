/**
 * Rich demo data for manually testing the customer app (`npm run seed:demo`).
 *
 * Like `scripts/seed.ts` this goes through the API Gateway only — it never touches PostgreSQL —
 * so every record passes the real validation, ownership rules, and Kafka flows. It is a superset of
 * the base seed (same owner/driver accounts, Burger Palace + Classic Burger), so `npm run e2e` still
 * works afterwards.
 *
 * Safe to rerun: accounts, restaurants, categories, menu items, and images are reused by name, and
 * each order scenario (delivered, cancelled, failed payment, preparing, on the way) is only created
 * if the demo customer has no order in that state yet. Pass `--more-orders` to add a full batch.
 *
 * Deliveries use a dedicated demo driver so the base `driver@example.com` stays AVAILABLE for
 * `npm run seed` / `npm run e2e` while the demo's "on the way" order keeps the demo driver BUSY.
 */
import {
  del,
  dispatch,
  driveDelivery,
  ensureDriverProfile,
  get,
  log,
  loginOrRegister,
  patch,
  placeOrder,
  post,
  runSeed,
  seedRestaurant,
  sleep,
  tryImage,
  uploadAvatar,
  useGateway,
  waitForOrder,
  type Auth,
  type MenuItem,
  type Order,
  type RestaurantSeed,
} from './lib/gateway-seed';

const API_URL = process.env.API_URL || 'http://localhost:3000';
const PASSWORD = 'password123';
useGateway(API_URL);

const RESTAURANTS: RestaurantSeed[] = [
  {
    // Name, owner, and "Mains/Classic Burger" match scripts/seed.ts so e2e keeps working.
    name: 'Burger Palace',
    description: 'Best burgers in town — smashed to order.',
    address: '123 Main St',
    status: 'OPEN',
    categories: [
      {
        name: 'Mains',
        items: [
          {
            name: 'Classic Burger',
            description: 'Beef patty, lettuce, tomato, cheese',
            price: 12.99,
          },
          {
            name: 'Double Smash',
            description: 'Two smashed patties, American cheese, pickles, house sauce',
            price: 15.49,
          },
          {
            name: 'Mushroom Swiss',
            description: 'Sautéed mushrooms, Swiss cheese, garlic aioli',
            price: 14.25,
          },
          {
            name: 'Crispy Chicken Sandwich',
            description: 'Buttermilk fried chicken, slaw, spicy mayo',
            price: 13.5,
          },
        ],
      },
      {
        name: 'Sides',
        items: [
          { name: 'Fries', description: 'Skin-on, sea salt', price: 3.99 },
          { name: 'Onion Rings', description: 'Beer-battered', price: 4.49 },
          {
            name: 'Sweet Potato Fries',
            description: 'With chipotle dip',
            price: 4.99,
            available: false,
          },
        ],
      },
      {
        name: 'Drinks',
        items: [
          { name: 'Cola', description: '330ml can', price: 1.99 },
          { name: 'Vanilla Shake', description: 'Real vanilla bean ice cream', price: 5.49 },
        ],
      },
    ],
    uncategorized: [
      { name: "Chef's Special", description: 'Ask what the grill is doing today', price: 16.99 },
    ],
  },
  {
    name: 'Pizza Napoli',
    description: 'Wood-fired Neapolitan pizza and fresh pasta.',
    address: '48 Via Roma Ave',
    status: 'OPEN',
    coverImage: 'restaurant-cover.jpg',
    categories: [
      {
        name: 'Pizza',
        items: [
          {
            name: 'Margherita',
            description: 'San Marzano tomato, fior di latte, basil',
            price: 11.5,
          },
          { name: 'Diavola', description: 'Spicy salami, chili oil, mozzarella', price: 13.75 },
          {
            name: 'Quattro Formaggi',
            description: 'Mozzarella, gorgonzola, parmesan, fontina',
            price: 14.0,
          },
          {
            name: 'Truffle Funghi',
            description: 'Wild mushrooms, truffle cream',
            price: 16.5,
            available: false,
          },
        ],
      },
      {
        name: 'Pasta',
        items: [
          {
            name: 'Spaghetti Carbonara',
            description: 'Guanciale, egg yolk, pecorino',
            price: 13.0,
          },
          { name: 'Penne Arrabbiata', description: 'Tomato, garlic, chili', price: 10.5 },
        ],
      },
      {
        name: 'Desserts',
        items: [{ name: 'Tiramisu', description: 'Mascarpone, espresso, cocoa', price: 6.5 }],
      },
    ],
  },
  {
    name: 'Cairo Kitchen',
    description: 'Home-style Egyptian classics.',
    address: '9 Nile Corniche',
    status: 'OPEN',
    categories: [
      {
        name: 'Mains',
        items: [
          {
            name: 'Koshari',
            description: 'Rice, lentils, pasta, crispy onions, tomato sauce',
            price: 7.5,
          },
          {
            name: 'Chicken Shawarma Plate',
            description: 'With tahini, pickles, and rice',
            price: 11.25,
          },
          {
            name: 'Molokhia with Rice',
            description: 'Jute leaf stew, garlic, coriander',
            price: 9.0,
          },
        ],
      },
      {
        name: 'Starters',
        items: [
          { name: 'Falafel (6 pcs)', description: 'Fava bean ta’ameya with tahini', price: 4.5 },
          { name: 'Baba Ghanoush', description: 'Smoky eggplant dip with pita', price: 5.0 },
        ],
      },
      {
        name: 'Desserts',
        items: [{ name: 'Om Ali', description: 'Warm pastry pudding with nuts', price: 5.75 }],
      },
    ],
  },
  {
    name: 'Taco Fiesta',
    description: 'Street tacos, burritos, and fresh salsas.',
    address: '77 Sunset Blvd',
    status: 'OPEN',
    categories: [
      {
        name: 'Tacos',
        items: [
          {
            name: 'Al Pastor Tacos',
            description: 'Marinated pork, pineapple, onion, cilantro',
            price: 9.5,
          },
          {
            name: 'Baja Fish Tacos',
            description: 'Beer-battered fish, cabbage, lime crema',
            price: 10.75,
          },
        ],
      },
      {
        name: 'Burritos',
        items: [
          {
            name: 'Carne Asada Burrito',
            description: 'Steak, rice, beans, pico de gallo',
            price: 12.25,
          },
        ],
      },
      {
        name: 'Sides',
        items: [{ name: 'Chips & Guacamole', description: 'Made fresh every hour', price: 5.5 }],
      },
    ],
  },
  {
    name: 'Sakura Sushi',
    description: 'Nigiri, rolls, and ramen. Busy at peak hours.',
    address: '5 Cherry Blossom Lane',
    status: 'BUSY',
    categories: [
      {
        name: 'Rolls',
        items: [
          { name: 'California Roll', description: 'Crab, avocado, cucumber', price: 8.5 },
          { name: 'Spicy Tuna Roll', description: 'Tuna, spicy mayo, scallion', price: 9.75 },
        ],
      },
      {
        name: 'Ramen',
        items: [
          { name: 'Tonkotsu Ramen', description: 'Pork broth, chashu, soft egg', price: 14.5 },
        ],
      },
    ],
  },
  {
    name: 'Green Bowl',
    description: 'Salads and grain bowls. Currently closed.',
    address: '300 Garden St',
    status: 'CLOSED',
    categories: [
      {
        name: 'Bowls',
        items: [
          {
            name: 'Quinoa Power Bowl',
            description: 'Quinoa, chickpeas, kale, lemon tahini',
            price: 11.0,
          },
          {
            name: 'Caesar Salad',
            description: 'Romaine, parmesan, sourdough croutons',
            price: 9.25,
          },
        ],
      },
    ],
  },
];

const DRIVER = {
  email: 'demo.driver@example.com',
  fullName: 'Demo Driver',
  licensePlate: 'DMO-2030',
};

const CUSTOMER = {
  email: 'demo.customer@example.com',
  fullName: 'Sara Demo',
  phone: '+20 101 234 5678',
  address: '742 Evergreen Terrace, Apt 3B',
};

// ---------------------------------------------------------------------------------------------
// Order scenarios
// ---------------------------------------------------------------------------------------------

async function seedOrders(
  customer: Auth,
  owner: Auth,
  driver: Auth,
  catalog: Map<string, Map<string, MenuItem>>,
  missing: (status: string) => boolean,
) {
  const item = (restaurant: string, name: string) => {
    const found = catalog.get(restaurant)?.get(name);
    if (!found) throw new Error(`Missing menu item ${restaurant} / ${name}`);
    return found;
  };

  const driverProfile = await get<{ id: string }>('/api/drivers/me', driver);

  if (missing('DELIVERED')) await seedDelivered();
  if (missing('CANCELLED')) await seedCancelled();
  if (missing('FAILED')) await seedFailedPayment();
  if (missing('PREPARING')) await seedPreparing();
  // Last, because it leaves the demo driver BUSY with an in-transit delivery.
  if (missing('PICKED_UP')) await seedOnTheWay();

  async function seedDelivered() {
    log('• Delivered order (Burger Palace)');
    const delivered = await placeOrder(
      customer,
      [
        { item: item('Burger Palace', 'Double Smash'), quantity: 2 },
        { item: item('Burger Palace', 'Fries'), quantity: 2 },
        { item: item('Burger Palace', 'Vanilla Shake'), quantity: 1 },
      ],
      'success',
    );
    const deliveredDelivery = await dispatch(delivered.id, owner, driver, driverProfile.id);
    await post('/api/tracking/location', { latitude: 36.1627, longitude: -86.7816 }, driver);
    await driveDelivery(deliveredDelivery, driver, true);
    await waitForOrder(delivered.id, customer, 'DELIVERED');
  }

  async function seedCancelled() {
    log('• Cancelled order (Taco Fiesta)');
    const cancelled = await placeOrder(
      customer,
      [{ item: item('Taco Fiesta', 'Al Pastor Tacos'), quantity: 2 }],
      'success',
    );
    await patch(`/api/orders/${cancelled.id}/status`, { status: 'CANCELLED' }, customer);
  }

  async function seedFailedPayment() {
    log('• Failed payment (Cairo Kitchen)');
    await placeOrder(
      customer,
      [{ item: item('Cairo Kitchen', 'Koshari'), quantity: 1 }],
      'failure',
    );
  }

  async function seedPreparing() {
    log('• Order being prepared (Cairo Kitchen)');
    const preparing = await placeOrder(
      customer,
      [
        { item: item('Cairo Kitchen', 'Chicken Shawarma Plate'), quantity: 1 },
        { item: item('Cairo Kitchen', 'Falafel (6 pcs)'), quantity: 1 },
        { item: item('Cairo Kitchen', 'Om Ali'), quantity: 2 },
      ],
      'success',
    );
    await patch(`/api/orders/${preparing.id}/status`, { status: 'PREPARING' }, owner);
  }

  async function seedOnTheWay() {
    log('• Order on the way (Pizza Napoli)');
    const onTheWay = await placeOrder(
      customer,
      [
        { item: item('Pizza Napoli', 'Margherita'), quantity: 1 },
        { item: item('Pizza Napoli', 'Diavola'), quantity: 1 },
        { item: item('Pizza Napoli', 'Tiramisu'), quantity: 2 },
      ],
      'success',
    );
    const liveDelivery = await dispatch(onTheWay.id, owner, driver, driverProfile.id);
    await driveDelivery(liveDelivery, driver, false);
    await post('/api/tracking/location', { latitude: 36.1581, longitude: -86.7762 }, driver);
    await waitForOrder(onTheWay.id, customer, 'PICKED_UP');
  }
}

/** Notifications arrive asynchronously over Kafka; mark the oldest ones read so both states show. */
async function markSomeNotificationsRead(customer: Auth, expectedAtLeast: number) {
  type Notifications = { items: { id: string; isRead: boolean }[] };
  const deadline = Date.now() + 20_000;
  let list: Notifications = { items: [] };
  while (Date.now() < deadline) {
    list = await get<Notifications>('/api/notifications?page=1&limit=50', customer);
    if (list.items.length >= expectedAtLeast) break;
    await sleep(1_000);
  }

  const oldest = list.items.slice(-2).filter((item) => !item.isRead);
  for (const notification of oldest) {
    await patch(`/api/notifications/${notification.id}/read`, {}, customer);
  }
  log(`• ${list.items.length} notifications (${oldest.length} marked read)`);
}

// ---------------------------------------------------------------------------------------------

async function seedDemo() {
  const moreOrders = process.argv.includes('--more-orders');
  log(`Seeding demo data through ${API_URL}
`);

  log('Accounts');
  const owner = await loginOrRegister(
    'owner@example.com',
    PASSWORD,
    'Restaurant Owner',
    'RESTAURANT_OWNER',
  );
  const driver = await loginOrRegister(DRIVER.email, PASSWORD, DRIVER.fullName, 'DRIVER');
  const customer = await loginOrRegister(
    CUSTOMER.email,
    PASSWORD,
    CUSTOMER.fullName,
    'CUSTOMER',
    CUSTOMER.phone,
  );

  await patch(
    '/api/users/me',
    { fullName: CUSTOMER.fullName, phone: CUSTOMER.phone, address: CUSTOMER.address },
    customer,
  );
  const profile = await get<{ avatarUrl?: string | null }>('/api/users/me', customer);
  if (!profile.avatarUrl) {
    await tryImage('customer avatar', () => uploadAvatar(customer, 'customer-avatar.jpg'));
  }

  await ensureDriverProfile(driver, 'Scooter', DRIVER.licensePlate);

  log('\nRestaurants');
  const catalog = new Map<string, Map<string, MenuItem>>();
  for (const seed of RESTAURANTS) {
    const { items } = await seedRestaurant(seed, owner);
    catalog.set(seed.name, items);
  }

  log('\nOrders');
  const existing = await get<{ items: Order[] }>('/api/orders?limit=100', customer);
  const statuses = new Set(existing.items.map((order) => order.status));
  const missing = (status: string) => moreOrders || !statuses.has(status);
  if (['DELIVERED', 'CANCELLED', 'FAILED', 'PREPARING', 'PICKED_UP'].some(missing)) {
    await seedOrders(customer, owner, driver, catalog, missing);
    await markSomeNotificationsRead(customer, 4);
  } else {
    log(
      `• every scenario already exists (${existing.items.length} orders) — pass --more-orders to add another batch`,
    );
  }

  log('\nCart');
  await del('/api/cart', customer);
  const pizza = catalog.get('Pizza Napoli')!;
  await post(
    '/api/cart/items',
    { menuItemId: pizza.get('Spaghetti Carbonara')!.id, quantity: 1 },
    customer,
  );
  await post(
    '/api/cart/items',
    { menuItemId: pizza.get('Quattro Formaggi')!.id, quantity: 2 },
    customer,
  );
  log('• 3 items from Pizza Napoli waiting in the cart');

  log(`
Demo data ready.
  Customer login:  ${CUSTOMER.email} / ${PASSWORD}
  Owner login:     owner@example.com / ${PASSWORD}
  Driver login:    ${DRIVER.email} / ${PASSWORD}`);
}

runSeed('Demo seed', seedDemo);
