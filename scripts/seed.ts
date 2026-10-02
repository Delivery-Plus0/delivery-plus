import axios, { AxiosError } from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:3000';
type Auth = { headers: { Authorization: string } };

async function loginOrRegister(email: string, fullName: string, role: string): Promise<Auth> {
  try {
    const response = await axios.post(`${API_URL}/api/auth/login`, { email, password: 'password123' });
    return { headers: { Authorization: `Bearer ${response.data.accessToken}` } };
  } catch (error) {
    if (!(error instanceof AxiosError) || error.response?.status !== 401) throw error;
    const response = await axios.post(`${API_URL}/api/auth/register`, {
      email,
      password: 'password123',
      fullName,
      role,
    });
    return { headers: { Authorization: `Bearer ${response.data.accessToken}` } };
  }
}

async function waitForOrder(orderId: string, auth: Auth, status: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await axios.get(`${API_URL}/api/orders/${orderId}`, auth);
    if (response.data.status === status) return response.data;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for order ${orderId} to reach ${status}`);
}

/** delivery-service creates and assigns the delivery by itself once the order is ready (auto-dispatch). */
async function waitForAssignment(orderId: string, auth: Auth) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await axios.get(`${API_URL}/api/deliveries/by-order/${orderId}`, auth);
      if (response.data.status !== 'CREATED') return response.data;
    } catch (error) {
      if (!(error instanceof AxiosError) || error.response?.status !== 404) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for a driver to be assigned to order ${orderId}`);
}

async function seed() {
  console.log('Starting seed process...');

  try {
    console.log('Registering owner...');
    const ownerAuth = await loginOrRegister('owner@example.com', 'Restaurant Owner', 'RESTAURANT_OWNER');
    console.log('Registering customer...');
    const customerAuth = await loginOrRegister('customer@example.com', 'Hungry Customer', 'CUSTOMER');
    // Checkout needs a drop-off address; without one in the body, orders copy the profile address.
    await axios.patch(`${API_URL}/api/users/me`, { address: '1 Seed Street, Apt 2' }, customerAuth);
    console.log('Registering driver...');
    const driverAuth = await loginOrRegister('driver@example.com', 'Speedy Driver', 'DRIVER');

    const restaurantsResponse = await axios.get(`${API_URL}/api/restaurants`);
    let restaurant = restaurantsResponse.data.items?.find((item: any) => item.name === 'Burger Palace');
    if (!restaurant) {
      console.log('Creating restaurant...');
      restaurant = (
        await axios.post(
          `${API_URL}/api/restaurants`,
          { name: 'Burger Palace', description: 'Best burgers in town', address: '123 Main St' },
          ownerAuth,
        )
      ).data;
    }
    const restaurantId = restaurant.id;

    if (restaurant.status !== 'OPEN') {
      console.log('Opening restaurant...');
      await axios.patch(`${API_URL}/api/restaurants/${restaurantId}/status`, { status: 'OPEN' }, ownerAuth);
    }

    let menu = (await axios.get(`${API_URL}/api/menus/restaurants/${restaurantId}/menu`)).data;
    let category = menu.categories?.find((item: any) => item.name === 'Mains');
    if (!category) {
      console.log('Creating menu category...');
      category = (
        await axios.post(`${API_URL}/api/menus/categories`, { restaurantId, name: 'Mains', displayOrder: 1 }, ownerAuth)
      ).data;
      menu = (await axios.get(`${API_URL}/api/menus/restaurants/${restaurantId}/menu`)).data;
    }

    let menuItem = menu.items?.find((item: any) => item.name === 'Classic Burger');
    if (!menuItem) {
      console.log('Creating menu item...');
      menuItem = (
        await axios.post(
          `${API_URL}/api/menus/menu-items`,
          {
            restaurantId,
            categoryId: category.id,
            name: 'Classic Burger',
            description: 'Beef patty, lettuce, tomato, cheese',
            price: 12.99,
          },
          ownerAuth,
        )
      ).data;
    }
    const menuItemId = menuItem.id;

    console.log('Registering driver profile...');
    try {
      await axios.get(`${API_URL}/api/drivers/me`, driverAuth);
    } catch (error) {
      if (!(error instanceof AxiosError) || error.response?.status !== 404) throw error;
      await axios.post(`${API_URL}/api/drivers/register`, { vehicleType: 'Sedan', licensePlate: 'ABC-1234' }, driverAuth);
    }
    console.log('Bringing driver online...');
    const driverStatus = await axios.get(`${API_URL}/api/drivers/me`, driverAuth);
    if (driverStatus.data.status !== 'AVAILABLE') {
      await axios.post(`${API_URL}/api/drivers/me/online`, {}, driverAuth);
    }

    console.log('Seeding cart...');
    await axios.post(`${API_URL}/api/cart/items`, { menuItemId, quantity: 1 }, customerAuth);
    console.log('Seeding order...');
    const order = (
      await axios.post(`${API_URL}/api/orders`, {}, {
        ...customerAuth,
        headers: { ...customerAuth.headers, 'Idempotency-Key': `seed-${Date.now()}` },
      })
    ).data;
    const payment = (await axios.post(`${API_URL}/api/payments`, { orderId: order.id }, customerAuth)).data;
    await waitForOrder(order.id, customerAuth, 'PAYMENT_PENDING');
    console.log('Processing payment...');
    await axios.post(`${API_URL}/api/payments/${payment.id}/process`, { simulateFailure: false }, customerAuth);
    await waitForOrder(order.id, customerAuth, 'CONFIRMED');
    await axios.patch(`${API_URL}/api/orders/${order.id}/status`, { status: 'PREPARING' }, ownerAuth);
    // Auto-dispatch picks the most recently updated AVAILABLE driver: cycle ours just before "ready".
    await axios.post(`${API_URL}/api/drivers/me/offline`, {}, driverAuth).catch(() => undefined);
    await axios.post(`${API_URL}/api/drivers/me/online`, {}, driverAuth);
    await axios.patch(`${API_URL}/api/orders/${order.id}/status`, { status: 'READY_FOR_PICKUP' }, ownerAuth);

    console.log('Waiting for auto-dispatch to assign the driver...');
    const assigned = await waitForAssignment(order.id, ownerAuth);
    const delivery = assigned;
    await axios.post(`${API_URL}/api/tracking/location`, { latitude: 36.1627, longitude: -86.7816 }, driverAuth);
    await axios.post(`${API_URL}/api/deliveries/${delivery.id}/pickup`, {}, driverAuth);
    await axios.post(`${API_URL}/api/deliveries/${delivery.id}/start`, {}, driverAuth);
    await axios.post(`${API_URL}/api/deliveries/${delivery.id}/complete`, {}, driverAuth);
    await waitForOrder(order.id, customerAuth, 'DELIVERED');

    console.log('Seed completed successfully!');
    console.log(JSON.stringify({ restaurantId, menuItemId, orderId: order.id, paymentId: payment.id, deliveryId: delivery.id, driverId: assigned.driverId }, null, 2));
  } catch (error: any) {
    console.error('Seed failed:');
    if (error.response) console.error(error.response.status, error.response.data);
    else console.error(error.message);
    process.exit(1);
  }
}

seed();
