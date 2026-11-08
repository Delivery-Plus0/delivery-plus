export interface CartItem {
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  /** The menu item's photo when added or last validated (#286); null without one. Older carts may lack it. */
  imageUrl?: string | null;
}

export interface Cart {
  userId: string;
  restaurantId: string | null;
  items: CartItem[];
  updatedAt: string;
}

export interface CartWithTotal extends Cart {
  total: number;
}

export function emptyCart(userId: string): Cart {
  return { userId, restaurantId: null, items: [], updatedAt: new Date().toISOString() };
}

export function calculateTotal(cart: Cart): number {
  const total = cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return Math.round(total * 100) / 100;
}

export function withTotal(cart: Cart): CartWithTotal {
  return { ...cart, total: calculateTotal(cart) };
}
