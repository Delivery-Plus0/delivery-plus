export const SERVICE_PREFIXES = [
  '/api/auth',
  '/api/users',
  '/api/restaurants',
  '/api/menus',
  '/api/cart',
  '/api/orders',
  '/api/payments',
  '/api/deliveries',
  '/api/drivers',
  '/api/tracking',
  '/api/notifications',
] as const;

export const SERVICE_DEFINITIONS = [
  {
    service: 'auth',
    publicPrefix: '/api/auth',
    routes: [
      { method: 'post', path: '/register', summary: 'Register a new account', auth: false, statusCode: 201 },
      { method: 'post', path: '/login', summary: 'Login and receive an access token and a refresh token', auth: false, statusCode: 200 },
      { method: 'post', path: '/refresh', summary: 'Exchange a refresh token for a new pair (single use; reuse ends the session)', auth: false, statusCode: 200 },
      { method: 'post', path: '/logout', summary: 'Sign out this device (always 204)', auth: false, statusCode: 204 },
      { method: 'post', path: '/logout-all', summary: 'Sign out on every device', auth: true, statusCode: 204 },
      { method: 'patch', path: '/users/:id/status', summary: 'Suspend or reactivate an account (staff with users.manage; suspending ends its sessions)', auth: true, statusCode: 200 },
      { method: 'post', path: '/verify-email', summary: 'Verify an email address with the 6-digit code from the verification email', auth: false, statusCode: 200 },
      { method: 'post', path: '/resend-verification', summary: 'Email a new verification code (one a minute per address)', auth: false, statusCode: 200 },
      { method: 'post', path: '/password/change', summary: 'Change the current user password; ends every other session', auth: true, statusCode: 204 },
      { method: 'post', path: '/password/forgot', summary: 'Request a password reset code by SMS', auth: false, statusCode: 202 },
      { method: 'post', path: '/password/reset', summary: 'Reset the password using the SMS code; ends every session', auth: false, statusCode: 204 },
      { method: 'get', path: '/me', summary: 'Get the current authenticated user', auth: true, statusCode: 200 },
      {
        method: 'post',
        path: '/staff/accept-invitation',
        summary: 'Accept a staff invitation: set a password (12+ characters), name and phone (#216)',
        auth: false,
        statusCode: 201,
      },
    ],
  },
  {
    service: 'users',
    publicPrefix: '/api/users',
    routes: [
      { method: 'get', path: '/me', summary: 'Get the current authenticated user profile', auth: true, statusCode: 200 },
      { method: 'patch', path: '/me', summary: 'Update the current authenticated user profile', auth: true, statusCode: 200 },
      { method: 'get', path: '/me/orders', summary: 'Get the current user order history', auth: true, statusCode: 200 },
      { method: 'get', path: '/:id', summary: 'Get a user profile by id', auth: true, statusCode: 200 },
      { method: 'post', path: '/me/avatar/image-upload-url', summary: 'Create a presigned avatar upload URL', auth: true, statusCode: 201 },
      { method: 'post', path: '/me/avatar/confirm', summary: 'Confirm and save an uploaded avatar', auth: true, statusCode: 201 },
      { method: 'delete', path: '/me/avatar', summary: 'Remove the current user avatar', auth: true, statusCode: 200 },
      { method: 'post', path: '/me/phone/verification', summary: 'Text a one-time code to verify a phone', auth: true, statusCode: 202 },
      { method: 'post', path: '/me/phone/verify', summary: 'Confirm a phone verification code', auth: true, statusCode: 200 },
    ],
  },
  {
    service: 'restaurants',
    publicPrefix: '/api/restaurants',
    routes: [
      { method: 'post', path: '', summary: 'Create your restaurant as a draft application (owner; one per owner)', auth: true, statusCode: 201 },
      { method: 'get', path: '', summary: 'List restaurants', auth: false, statusCode: 200 },
      { method: 'get', path: '/me', summary: 'Your restaurants with their application status and private details', auth: true, statusCode: 200 },
      { method: 'get', path: '/:id', summary: 'Get an approved restaurant by id', auth: false, statusCode: 200 },
      { method: 'patch', path: '/:id', summary: 'Update restaurant details', auth: true, statusCode: 200 },
      { method: 'post', path: '/:id/submit', summary: 'Send your restaurant application for review, or resubmit a rejected one', auth: true, statusCode: 200 },
      { method: 'get', path: '/:id/application', summary: "A restaurant's application with its review history (staff with onboarding.review)", auth: true, statusCode: 200 },
      { method: 'post', path: '/:id/review', summary: 'Approve or reject a submitted restaurant application (staff with onboarding.review)', auth: true, statusCode: 200 },
      { method: 'patch', path: '/:id/status', summary: 'Update restaurant status (an owner opens only an approved restaurant)', auth: true, statusCode: 200 },
      { method: 'patch', path: '/:id/delivery-radius', summary: 'Set a restaurant delivery radius (admin only)', auth: true, statusCode: 200 },
      { method: 'post', path: '/:id/image-upload-url', summary: 'Create a presigned restaurant image upload URL', auth: true, statusCode: 201 },
      { method: 'post', path: '/:id/image-confirm', summary: 'Confirm and save a restaurant image', auth: true, statusCode: 201 },
    ],
  },
  {
    service: 'menus',
    publicPrefix: '/api/menus',
    routes: [
      { method: 'post', path: '/categories', summary: 'Create a menu category', auth: true, statusCode: 201 },
      { method: 'patch', path: '/categories/:id', summary: 'Rename or move a menu category', auth: true, statusCode: 200 },
      { method: 'delete', path: '/categories/:id', summary: 'Delete an empty menu category (409 while it has items)', auth: true, statusCode: 200 },
      { method: 'patch', path: '/restaurants/:restaurantId/categories/order', summary: 'Reorder all menu categories of a restaurant', auth: true, statusCode: 200 },
      { method: 'get', path: '/restaurants/:restaurantId/menu', summary: 'List menu categories and items for a restaurant', auth: false, statusCode: 200 },
      { method: 'get', path: '/menu-items/:id', summary: 'Get a menu item by id', auth: false, statusCode: 200 },
      { method: 'post', path: '/menu-items', summary: 'Create a menu item', auth: true, statusCode: 201 },
      { method: 'patch', path: '/menu-items/:id', summary: 'Update a menu item', auth: true, statusCode: 200 },
      { method: 'delete', path: '/menu-items/:id', summary: 'Archive a menu item (leaves the menu, stays valid for past orders)', auth: true, statusCode: 200 },
      { method: 'patch', path: '/menu-items/:id/availability', summary: 'Update menu item availability', auth: true, statusCode: 200 },
      { method: 'post', path: '/menu-items/:id/image-upload-url', summary: 'Create a presigned menu item image upload URL', auth: true, statusCode: 201 },
      { method: 'delete', path: '/menu-items/:id/images/:imageId', summary: 'Remove one image of a menu item', auth: true, statusCode: 200 },
      { method: 'post', path: '/menu-items/:id/image-confirm', summary: 'Confirm and save a menu item image', auth: true, statusCode: 201 },
    ],
  },
  {
    service: 'cart',
    publicPrefix: '/api/cart',
    routes: [
      { method: 'get', path: '', summary: 'Get the current user cart', auth: true, statusCode: 200 },
      { method: 'post', path: '/items', summary: 'Add an item to the cart', auth: true, statusCode: 201 },
      { method: 'patch', path: '/items/:menuItemId', summary: 'Update the quantity of an item', auth: true, statusCode: 200 },
      { method: 'delete', path: '/items/:menuItemId', summary: 'Remove an item from the cart', auth: true, statusCode: 200 },
      { method: 'post', path: '/validate', summary: 'Re-check the cart against the menu (409 CartChanged lists what changed; the cart is updated)', auth: true, statusCode: 201 },
      { method: 'delete', path: '', summary: 'Clear the cart', auth: true, statusCode: 200 },
    ],
  },
  {
    service: 'orders',
    publicPrefix: '/api/orders',
    routes: [
      { method: 'post', path: '', summary: 'Create an order from the current cart', auth: true, statusCode: 201 },
      { method: 'get', path: '', summary: 'List the current customer orders', auth: true, statusCode: 200 },
      { method: 'get', path: '/restaurant/:restaurantId', summary: 'List orders for a restaurant', auth: true, statusCode: 200 },
      { method: 'get', path: '/restaurant/:restaurantId/summary', summary: "Today's orders and item revenue for a restaurant (owner)", auth: true, statusCode: 200 },
      { method: 'get', path: '/quote', summary: 'Price the current cart: subtotal, delivery fee and total (EGP)', auth: true, statusCode: 200 },
      { method: 'get', path: '/:id', summary: 'Get an order by id', auth: true, statusCode: 200 },
      { method: 'patch', path: '/:id/status', summary: 'Transition an order status', auth: true, statusCode: 200 },
    ],
  },
  {
    service: 'payments',
    publicPrefix: '/api/payments',
    routes: [
      { method: 'post', path: '', summary: 'Create a payment for an order', auth: true, statusCode: 201 },
      { method: 'post', path: '/:id/process', summary: 'Process a payment', auth: true, statusCode: 201 },
      { method: 'get', path: '/:id', summary: 'Get payment status', auth: true, statusCode: 200 },
      { method: 'post', path: '/:id/refund', summary: 'Refund a completed payment in full (support/admin only; cancelled orders are refunded automatically)', auth: true, statusCode: 201 },
      { method: 'get', path: '/:id/refund', summary: "Get a payment's refund record (the paying customer or admin)", auth: true, statusCode: 200 },
    ],
  },
  {
    service: 'deliveries',
    publicPrefix: '/api/deliveries',
    routes: [
      { method: 'post', path: '', summary: 'Create a delivery', auth: true, statusCode: 201 },
      { method: 'post', path: '/:id/assign', summary: 'Assign a delivery to a driver', auth: true, statusCode: 201 },
      { method: 'post', path: '/:id/pickup', summary: 'Mark a delivery as picked up', auth: true, statusCode: 201 },
      { method: 'post', path: '/:id/start', summary: 'Start a delivery run', auth: true, statusCode: 201 },
      { method: 'post', path: '/:id/complete', summary: 'Complete a delivery', auth: true, statusCode: 201 },
      { method: 'post', path: '/:id/cancel', summary: 'Cancel a delivery and its order (admin only; compensates the driver past pickup, refunds the customer)', auth: true, statusCode: 201 },
      { method: 'get', path: '/me/current', summary: "Get the calling driver's active delivery (204 when none)", auth: true, statusCode: 200 },
      { method: 'get', path: '/me/earnings', summary: "Get the calling driver's earnings: pending, available, balance and ledger entries", auth: true, statusCode: 200 },
      { method: 'get', path: '/me/history', summary: "List the calling driver's deliveries, newest first", auth: true, statusCode: 200 },
      { method: 'get', path: '/me/rating-summary', summary: "Get the calling driver's rating summary", auth: true, statusCode: 200 },
      { method: 'post', path: '/:id/rating', summary: 'Rate the driver who delivered this order', auth: true, statusCode: 201 },
      { method: 'get', path: '/:id/rating', summary: "Get a delivery's rating, or whether it can still be rated", auth: true, statusCode: 200 },
      { method: 'get', path: '/by-order/:orderId', summary: 'Get the delivery for an order', auth: true, statusCode: 200 },
      { method: 'get', path: '/:id', summary: 'Get a delivery by id', auth: true, statusCode: 200 },
    ],
  },
  {
    service: 'drivers',
    publicPrefix: '/api/drivers',
    routes: [
      { method: 'post', path: '/register', summary: 'Register a driver profile', auth: true, statusCode: 201 },
      { method: 'get', path: '/me', summary: 'Get the current driver profile', auth: true, statusCode: 200 },
      { method: 'patch', path: '/me/vehicle', summary: 'Change your vehicle (only while offline)', auth: true, statusCode: 200 },
      { method: 'post', path: '/me/online', summary: 'Go online (VERIFIED drivers only)', auth: true, statusCode: 201 },
      { method: 'post', path: '/me/offline', summary: 'Go offline', auth: true, statusCode: 201 },
      { method: 'post', path: '/me/status', summary: 'Set driver status explicitly', auth: true, statusCode: 201 },
      { method: 'get', path: '/me/application', summary: 'Your driver application: status, fields, documents (no URLs) and what is missing', auth: true, statusCode: 200 },
      { method: 'put', path: '/me/application', summary: 'Save your national ID and licence expiry dates (draft or rejected only)', auth: true, statusCode: 200 },
      { method: 'post', path: '/me/documents/:type/upload-url', summary: 'Get a presigned POST to upload one application document (JPEG, PNG or PDF, up to 10 MB; draft or rejected only)', auth: true, statusCode: 201 },
      { method: 'post', path: '/me/documents/:type/confirm', summary: 'Confirm an uploaded document: it is checked and becomes the current version (draft or rejected only)', auth: true, statusCode: 200 },
      { method: 'post', path: '/me/application/submit', summary: 'Send a complete application for review, or resubmit a corrected rejected one', auth: true, statusCode: 200 },
      { method: 'get', path: '/:id/application', summary: "A driver's application with its review history (staff with onboarding.review)", auth: true, statusCode: 200 },
      { method: 'post', path: '/:id/application/review', summary: 'Approve or reject a submitted driver application (staff with onboarding.review)', auth: true, statusCode: 200 },
      { method: 'post', path: '/:id/documents/:type/read-url', summary: "A 5-minute URL to view a driver's document (staff with onboarding.review; every read is recorded)", auth: true, statusCode: 200 },
      { method: 'get', path: '/available', summary: 'List available, verified drivers longest-idle first (availableSince ASC, id ASC; services only, SYSTEM token; not callable through the gateway)', auth: true, statusCode: 200 },
      { method: 'get', path: '/:id', summary: 'Get a driver by id (self or admin)', auth: true, statusCode: 200 },
      { method: 'patch', path: '/:id/status', summary: 'Claim or release a driver (services only, SYSTEM token; not callable through the gateway)', auth: true, statusCode: 200 },
      { method: 'patch', path: '/:id/verification', summary: "Set a driver's verification status (admin only; a decision is kept in the review history)", auth: true, statusCode: 200 },
    ],
  },
  {
    service: 'tracking',
    publicPrefix: '/api/tracking',
    routes: [
      { method: 'post', path: '/location', summary: 'Report the current driver location', auth: true, statusCode: 201 },
      { method: 'get', path: '/driver/:userId', summary: 'Get a driver location by user id', auth: true, statusCode: 200 },
      { method: 'get', path: '/delivery/:deliveryId', summary: 'Get combined delivery tracking', auth: true, statusCode: 200 },
      { method: 'get', path: '/delivery/:deliveryId/stream', summary: 'Stream delivery tracking updates (Server-Sent Events)', auth: true, statusCode: 200 },
    ],
  },
  {
    service: 'notifications',
    publicPrefix: '/api/notifications',
    routes: [
      { method: 'get', path: '', summary: 'List notifications for the current user', auth: true, statusCode: 200 },
      { method: 'patch', path: '/:id/read', summary: 'Mark a notification as read', auth: true, statusCode: 200 },
      { method: 'patch', path: '/read-all', summary: 'Mark all notifications as read', auth: true, statusCode: 200 },
    ],
  },
] as const;

/**
 * Staff admin routes (#212). Each service owns its own `/admin/...` routes; the
 * gateway publishes them under `/api/admin/<service>/...`. They never appear in
 * the public spec — this is a separate contract (`docs/openapi/admin.json`).
 */
export const ADMIN_SERVICE_PREFIXES = [
  '/api/admin/auth',
  '/api/admin/users',
  '/api/admin/restaurants',
  '/api/admin/menus',
  '/api/admin/cart',
  '/api/admin/orders',
  '/api/admin/payments',
  '/api/admin/deliveries',
  '/api/admin/drivers',
  '/api/admin/tracking',
  '/api/admin/notifications',
  '/api/admin/audit',
] as const;

/** A query parameter of an admin route, as it appears in docs/openapi/admin.json. */
export type AdminQueryParameter = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
};

/** One admin route. Each route declares its own parameters and body; nothing is shared by default. */
export type AdminRouteDefinition = {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  /** Relative to the service's admin prefix; `{id}` path parameters are documented automatically. */
  path: string;
  summary: string;
  /** Staff permissions the route requires (PermissionsGuard). */
  permissions: readonly string[];
  statusCode: number;
  query?: readonly AdminQueryParameter[];
  /** JSON body schema for mutations; every mutation carries a `reason` (ADR 002). */
  requestBody?: Record<string, unknown>;
  /** The audit action a mutation records with `AdminAudit.record` (#213), e.g. `driver.approve`. */
  auditAction?: string;
  /**
   * A POST that only reads, such as a search whose value must stay out of URLs and logs (#214):
   * it needs no reason and records no audit event.
   */
  readOnly?: boolean;
  /** `paginated` is a PaginatedResult<T>; `object` a single resource. */
  response: 'paginated' | 'object';
};

/** Page pagination shared by every admin list route (ADR 002: limit capped at 100). */
/** The staff permissions (shared STAFF_PERMISSIONS), for the admin contract's enums. */
export const STAFF_PERMISSION_NAMES = [
  'support.read',
  'support.act',
  'ops.read',
  'ops.act',
  'finance.read',
  'finance.act',
  'onboarding.review',
  'users.manage',
  'staff.manage',
  'audit.read',
] as const;

export const ADMIN_PAGE_QUERY: readonly AdminQueryParameter[] = [
  { name: 'page', description: 'Page number, starting at 1.', schema: { type: 'integer', minimum: 1, default: 1 } },
  { name: 'limit', description: 'Page size, at most 100.', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
];

export const ADMIN_SERVICE_DEFINITIONS: readonly {
  service: string;
  publicPrefix: string;
  routes: readonly AdminRouteDefinition[];
}[] = [
  {
    service: 'orders',
    publicPrefix: '/api/admin/orders',
    routes: [
      {
        method: 'get',
        path: '',
        summary: 'List all orders (staff with support.read)',
        permissions: ['support.read'],
        statusCode: 200,
        response: 'paginated',
        query: [
          ...ADMIN_PAGE_QUERY,
          { name: 'q', description: 'A full order id; anything else matches nothing.', schema: { type: 'string', maxLength: 100 } },
          { name: 'id', description: 'One order.', schema: { type: 'string', format: 'uuid' } },
          { name: 'customerId', description: 'Orders of one customer.', schema: { type: 'string', format: 'uuid' } },
          { name: 'restaurantId', description: 'Orders of one restaurant.', schema: { type: 'string', format: 'uuid' } },
          {
            name: 'status',
            description: 'active = not finished, completed = DELIVERED, cancelled = CANCELLED or FAILED.',
            schema: { type: 'string', enum: ['active', 'completed', 'cancelled'] },
          },
          { name: 'sort', description: 'Order by creation time.', schema: { type: 'string', enum: ['createdAt:asc', 'createdAt:desc'], default: 'createdAt:desc' } },
        ],
      },
    ],
  },
  {
    service: 'users',
    publicPrefix: '/api/admin/users',
    routes: [
      {
        method: 'get',
        path: '',
        summary: 'List people with their account status (staff with support.read)',
        permissions: ['support.read'],
        statusCode: 200,
        response: 'paginated',
        query: [
          ...ADMIN_PAGE_QUERY,
          { name: 'role', description: 'Account role.', schema: { type: 'string', enum: ['CUSTOMER', 'DRIVER', 'RESTAURANT_OWNER', 'ADMIN'] } },
          { name: 'status', description: 'Account status.', schema: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'] } },
          { name: 'emailVerified', description: 'Email verified or not.', schema: { type: 'boolean' } },
          { name: 'phoneVerified', description: 'Phone verified or not.', schema: { type: 'boolean' } },
          {
            name: 'q',
            description: 'The start of the full name or of a later word, case-insensitive. Phone and email: POST /api/admin/users/search.',
            schema: { type: 'string', minLength: 2, maxLength: 60 },
          },
          { name: 'createdFrom', description: 'Accounts created at or after, ISO 8601.', schema: { type: 'string', format: 'date-time' } },
          { name: 'createdTo', description: 'Accounts created before, ISO 8601.', schema: { type: 'string', format: 'date-time' } },
        ],
      },
      {
        method: 'post',
        path: '/search',
        summary: 'Find people by an exact phone or email, in the body so it never reaches a URL or log (staff with support.read)',
        permissions: ['support.read'],
        statusCode: 200,
        response: 'object',
        readOnly: true,
        requestBody: {
          type: 'object',
          description: 'Exactly one of phone (Egyptian mobile, normalized to E.164) or email (lowercased).',
          properties: { phone: { type: 'string', example: '01012345678' }, email: { type: 'string', format: 'email' } },
        },
      },
      {
        method: 'get',
        path: '/{id}',
        summary: 'One person: profile and account (staff with support.read)',
        permissions: ['support.read'],
        statusCode: 200,
        response: 'object',
      },
      {
        method: 'post',
        path: '/{id}/reveal',
        summary: "Reveal one of a person's masked values; audited as pii.reveal (staff with support.read)",
        permissions: ['support.read'],
        statusCode: 200,
        response: 'object',
        auditAction: 'pii.reveal',
        requestBody: {
          type: 'object',
          required: ['field', 'reason'],
          properties: {
            field: { type: 'string', enum: ['phone', 'email', 'address'] },
            reason: { type: 'string', minLength: 3, maxLength: 300, description: 'Why, for the audit log.' },
          },
        },
      },
    ],
  },
  {
    service: 'drivers',
    publicPrefix: '/api/admin/drivers',
    routes: [
      {
        method: 'get',
        path: '',
        summary: 'List drivers: status, verification, licences expiring, plate prefix (staff with support.read)',
        permissions: ['support.read'],
        statusCode: 200,
        response: 'paginated',
        query: [
          ...ADMIN_PAGE_QUERY,
          { name: 'status', description: 'Work status.', schema: { type: 'string', enum: ['OFFLINE', 'AVAILABLE', 'BUSY', 'SUSPENDED'] } },
          { name: 'verificationStatus', description: 'Application status.', schema: { type: 'string', enum: ['PENDING', 'VERIFIED', 'REJECTED'] } },
          {
            name: 'licenceExpiringWithinDays',
            description: 'Driving or vehicle licence ends within this many days (Cairo dates).',
            schema: { type: 'integer', minimum: 0, maximum: 365 },
          },
          { name: 'q', description: 'The start of the licence plate, any case.', schema: { type: 'string', maxLength: 20 } },
        ],
      },
      {
        method: 'get',
        path: '/queue',
        summary: 'Submitted applications waiting for a decision, oldest first (staff with onboarding.review)',
        permissions: ['onboarding.review'],
        statusCode: 200,
        response: 'paginated',
        query: [...ADMIN_PAGE_QUERY],
      },
      {
        method: 'get',
        path: '/{id}',
        summary: 'One driver: application, reviews, documents, ledger balance and rating (staff with support.read)',
        permissions: ['support.read'],
        statusCode: 200,
        response: 'object',
      },
      {
        method: 'post',
        path: '/{id}/review',
        summary: "Approve or reject the driver's submitted application (staff with onboarding.review)",
        permissions: ['onboarding.review'],
        statusCode: 200,
        response: 'object',
        auditAction: 'driver.approve',
        requestBody: {
          type: 'object',
          required: ['reason', 'decision', 'submittedAt'],
          properties: {
            decision: { type: 'string', enum: ['VERIFIED', 'REJECTED'] },
            note: { type: 'string', maxLength: 300, description: 'Shown to the person; required to reject.' },
            submittedAt: { type: 'string', format: 'date-time', description: 'The submission the reviewer looked at.' },
            reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Why, for the audit log. Never shown to the person.' },
          },
        },
      },
      {
        method: 'post',
        path: '/{id}/suspend',
        summary: "Suspend a driver; one on a delivery finishes it first (staff with ops.act)",
        permissions: ['ops.act'],
        statusCode: 200,
        response: 'object',
        auditAction: 'driver.suspend',
        requestBody: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Why, for the audit log. Never shown to the person.' },
          },
        },
      },
      {
        method: 'post',
        path: '/{id}/reactivate',
        summary: "Reactivate a suspended driver, or withdraw a pending suspension (staff with ops.act)",
        permissions: ['ops.act'],
        statusCode: 200,
        response: 'object',
        auditAction: 'driver.reactivate',
        requestBody: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Why, for the audit log. Never shown to the person.' },
          },
        },
      },
    ],
  },
  {
    service: 'restaurants',
    publicPrefix: '/api/admin/restaurants',
    routes: [
      {
        method: 'get',
        path: '',
        summary: 'List restaurants of every approval status: status, name prefix, area (staff with support.read)',
        permissions: ['support.read'],
        statusCode: 200,
        response: 'paginated',
        query: [
          ...ADMIN_PAGE_QUERY,
          { name: 'approvalStatus', description: 'Application status.', schema: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] } },
          { name: 'status', description: 'Operating status.', schema: { type: 'string', enum: ['OPEN', 'CLOSED', 'BUSY', 'SUSPENDED'] } },
          { name: 'q', description: 'The start of the name or of a later word, case-insensitive.', schema: { type: 'string', minLength: 2, maxLength: 60 } },
          { name: 'nearLat', description: 'Area centre latitude (with nearLng and withinKm).', schema: { type: 'number', minimum: -90, maximum: 90 } },
          { name: 'nearLng', description: 'Area centre longitude.', schema: { type: 'number', minimum: -180, maximum: 180 } },
          { name: 'withinKm', description: 'Area radius in km; results nearest first.', schema: { type: 'number', minimum: 0.1, maximum: 50 } },
        ],
      },
      {
        method: 'get',
        path: '/queue',
        summary: 'Submitted applications waiting for a decision, oldest first (staff with onboarding.review)',
        permissions: ['onboarding.review'],
        statusCode: 200,
        response: 'paginated',
        query: [...ADMIN_PAGE_QUERY],
      },
      {
        method: 'post',
        path: '/search',
        summary: 'Find restaurants by their exact contact phone, in the body (staff with support.read)',
        permissions: ['support.read'],
        statusCode: 200,
        response: 'object',
        readOnly: true,
        requestBody: { type: 'object', required: ['phone'], properties: { phone: { type: 'string', example: '01012345678' } } },
      },
      {
        method: 'get',
        path: '/{id}',
        summary: "One restaurant: application, reviews, owner, menu counts and today's orders (staff with support.read)",
        permissions: ['support.read'],
        statusCode: 200,
        response: 'object',
      },
      {
        method: 'post',
        path: '/{id}/review',
        summary: "Approve or reject the restaurant's submitted application (staff with onboarding.review)",
        permissions: ['onboarding.review'],
        statusCode: 200,
        response: 'object',
        auditAction: 'restaurant.approve',
        requestBody: {
          type: 'object',
          required: ['reason', 'decision', 'submittedAt'],
          properties: {
            decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
            note: { type: 'string', maxLength: 300, description: 'Shown to the person; required to reject.' },
            submittedAt: { type: 'string', format: 'date-time', description: 'The submission the reviewer looked at.' },
            reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Why, for the audit log. Never shown to the person.' },
          },
        },
      },
      {
        method: 'post',
        path: '/{id}/suspend',
        summary: "Suspend a restaurant: it disappears from customers at once (staff with ops.act)",
        permissions: ['ops.act'],
        statusCode: 200,
        response: 'object',
        auditAction: 'restaurant.suspend',
        requestBody: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Why, for the audit log. Never shown to the person.' },
          },
        },
      },
      {
        method: 'post',
        path: '/{id}/reactivate',
        summary: "Lift a suspension; the restaurant comes back CLOSED (staff with ops.act)",
        permissions: ['ops.act'],
        statusCode: 200,
        response: 'object',
        auditAction: 'restaurant.reactivate',
        requestBody: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Why, for the audit log. Never shown to the person.' },
          },
        },
      },
      {
        method: 'post',
        path: '/{id}/reveal',
        summary: "Reveal a restaurant's masked contact phone; audited as pii.reveal (staff with support.read)",
        permissions: ['support.read'],
        statusCode: 200,
        response: 'object',
        auditAction: 'pii.reveal',
        requestBody: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 300, description: 'Why, for the audit log.' },
          },
        },
      },
    ],
  },
  {
    service: 'auth',
    publicPrefix: '/api/admin/auth',
    routes: [
      {
        method: 'post',
        path: '/users/{id}/suspend',
        summary: "Suspend an account and end its sessions (staff with users.manage)",
        permissions: ['users.manage'],
        statusCode: 200,
        response: 'object',
        auditAction: 'user.suspend',
        requestBody: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Why, for the audit log. Never shown to the person.' },
          },
        },
      },
      {
        method: 'post',
        path: '/users/{id}/reactivate',
        summary: "Reactivate a suspended account (staff with users.manage)",
        permissions: ['users.manage'],
        statusCode: 200,
        response: 'object',
        auditAction: 'user.reactivate',
        requestBody: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Why, for the audit log. Never shown to the person.' },
          },
        },
      },
      {
        method: 'post',
        path: '/users/{id}/revoke-sessions',
        summary: "Sign the person out everywhere (staff with users.manage)",
        permissions: ['users.manage'],
        statusCode: 200,
        response: 'object',
        auditAction: 'user.revoke_sessions',
        requestBody: {
          type: 'object',
          required: ['reason'],
          properties: {
            reason: { type: 'string', minLength: 3, maxLength: 500, description: 'Why, for the audit log. Never shown to the person.' },
          },
        },
      },
      {
        method: 'get',
        path: '/staff',
        summary: 'List staff with their permissions and status (staff with staff.manage)',
        permissions: ['staff.manage'],
        statusCode: 200,
        response: 'object',
      },
      {
        method: 'get',
        path: '/staff/role-templates',
        summary: 'The permission sets offered as roles (staff with staff.manage)',
        permissions: ['staff.manage'],
        statusCode: 200,
        response: 'object',
      },
      {
        method: 'post',
        path: '/staff/invitations',
        summary: 'Invite someone by email with a set of permissions; the link works once, 48 h (staff with staff.manage)',
        permissions: ['staff.manage'],
        statusCode: 201,
        response: 'object',
        auditAction: 'staff.invite',
        requestBody: {
          type: 'object',
          required: ['email', 'permissions', 'reason'],
          properties: { email: { type: 'string', format: 'email' }, permissions: { type: 'array', minItems: 1, items: { type: 'string', enum: [...STAFF_PERMISSION_NAMES] } }, reason: { type: 'string', minLength: 3, maxLength: 300, description: 'Why, for the audit log.' } },
        },
      },
      {
        method: 'patch',
        path: '/staff/{id}/permissions',
        summary: "Replace a staff member's permissions; applies at their next refresh (staff with staff.manage)",
        permissions: ['staff.manage'],
        statusCode: 200,
        response: 'object',
        auditAction: 'staff.permissions_change',
        requestBody: { type: 'object', required: ['permissions', 'reason'], properties: { permissions: { type: 'array', minItems: 1, items: { type: 'string', enum: [...STAFF_PERMISSION_NAMES] } }, reason: { type: 'string', minLength: 3, maxLength: 300, description: 'Why, for the audit log.' } } },
      },
      {
        method: 'post',
        path: '/staff/{id}/disable',
        summary: 'Disable a staff account and end its sessions (staff with staff.manage)',
        permissions: ['staff.manage'],
        statusCode: 200,
        response: 'object',
        auditAction: 'staff.disable',
        requestBody: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 3, maxLength: 300, description: 'Why, for the audit log.' } } },
      },
      {
        method: 'post',
        path: '/staff/{id}/enable',
        summary: 'Enable a disabled staff account (staff with staff.manage)',
        permissions: ['staff.manage'],
        statusCode: 200,
        response: 'object',
        auditAction: 'staff.enable',
        requestBody: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 3, maxLength: 300, description: 'Why, for the audit log.' } } },
      },
    ],
  },
  {
    service: 'audit',
    publicPrefix: '/api/admin/audit',
    routes: [
      {
        method: 'get',
        path: '',
        summary: 'List staff actions, newest first (staff with audit.read)',
        permissions: ['audit.read'],
        statusCode: 200,
        response: 'paginated',
        query: [
          { name: 'page', description: 'Page number, starting at 1.', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', description: 'Page size, at most 100.', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
          { name: 'actorId', description: 'The staff member who acted.', schema: { type: 'string', format: 'uuid' } },
          {
            name: 'targetType',
            description: 'What was acted on.',
            schema: { type: 'string', enum: ['USER', 'DRIVER', 'RESTAURANT', 'ORDER', 'DELIVERY', 'PAYMENT', 'MENU_ITEM', 'STAFF'] },
          },
          { name: 'targetId', description: 'The id of what was acted on.', schema: { type: 'string', maxLength: 100 } },
          { name: 'action', description: 'A dotted action, e.g. driver.approve.', schema: { type: 'string', pattern: '^[a-z_]+(\\.[a-z_]+)+$' } },
          { name: 'from', description: 'Inclusive, ISO 8601.', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', description: 'Exclusive, ISO 8601.', schema: { type: 'string', format: 'date-time' } },
        ],
      },
    ],
  },
];

export function extractPathParameters(path: string): string[] {
  const matches = Array.from(path.matchAll(/\/(?:\{([^}]+)\}|:([A-Za-z0-9_]+))/g));
  const names = matches.map((match) => match[1] ?? match[2]).filter((value): value is string => Boolean(value));
  return names.filter((name, index) => names.indexOf(name) === index);
}

export function joinPublicPath(prefix: string, relativePath: string): string {
  if (!relativePath) {
    return prefix;
  }

  const normalized = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  return `${prefix}${normalized.replace(/\/:([A-Za-z0-9_]+)/g, '/{$1}')}`;
}

export function buildPathParameter(name: string) {
  return {
    name,
    in: 'path',
    required: true,
    schema: {
      type: 'string',
    },
  };
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const baseSchemas = {
  ErrorResponse: {
    type: 'object',
    properties: {
      statusCode: { type: 'integer', example: 400 },
      message: { type: 'string', example: 'Bad Request' },
      error: { type: 'string', nullable: true },
    },
  },
  CartChangedError: {
    type: 'object',
    description: '#42: 409 when the cart no longer matches the menu. The cart has already been updated.',
    properties: {
      statusCode: { type: 'integer', example: 409 },
      error: { type: 'string', example: 'CartChanged' },
      message: { type: 'string' },
      details: {
        type: 'object',
        properties: {
          changes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['menuItemId', 'name', 'change'],
              properties: {
                menuItemId: { type: 'string', format: 'uuid' },
                name: { type: 'string' },
                change: { type: 'string', enum: ['PRICE_CHANGED', 'UNAVAILABLE', 'REMOVED', 'QUANTITY_LIMITED'] },
                previousPrice: { type: 'number' },
                currentPrice: { type: 'number' },
                previousQuantity: { type: 'integer' },
                currentQuantity: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  },
  DriverNotVerifiedError: {
    type: 'object',
    description: '#206: 403 when a driver who is not VERIFIED tries to go online. The app shows "waiting for review" (PENDING) or "not approved" (REJECTED).',
    properties: {
      statusCode: { type: 'integer', example: 403 },
      error: { type: 'string', example: 'DriverNotVerified' },
      message: { type: 'string' },
      details: {
        type: 'object',
        required: ['verificationStatus'],
        properties: {
          verificationStatus: { type: 'string', enum: ['PENDING', 'REJECTED'] },
        },
      },
    },
  },
  RestaurantUnavailableError: {
    type: 'object',
    required: ['statusCode', 'error', 'message', 'details'],
    properties: {
      statusCode: { type: 'integer', example: 409 },
      error: { type: 'string', enum: ['RestaurantBusy', 'RestaurantClosed'], description: 'RestaurantBusy: try again in a few minutes. RestaurantClosed: CLOSED or SUSPENDED.' },
      message: { type: 'string' },
      details: {
        type: 'object',
        required: ['restaurantStatus'],
        properties: {
          restaurantStatus: { type: 'string', enum: ['BUSY', 'CLOSED', 'SUSPENDED'] },
        },
      },
    },
  },
  OutOfDeliveryAreaError: {
    type: 'object',
    required: ['statusCode', 'error', 'message', 'details'],
    properties: {
      statusCode: { type: 'integer', example: 409 },
      error: { type: 'string', example: 'OutOfDeliveryArea' },
      message: { type: 'string' },
      details: {
        type: 'object',
        required: ['distanceKm', 'maxRadiusKm'],
        properties: {
          distanceKm: { type: 'number', description: 'Straight-line distance rounded to two decimals.' },
          maxRadiusKm: { type: 'number', description: 'Effective restaurant radius rounded to two decimals.' },
        },
      },
    },
  },
  LoginRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', format: 'password' },
      appId: { type: 'string', enum: ['customer', 'driver', 'restaurant', 'admin'], description: '#34: the app signing in, recorded on the session.' },
    },
  },
  AccountStatusRequest: {
    type: 'object',
    description: '#202: staff with users.manage. Staff accounts and your own account are refused (403).',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'] },
      reason: { type: 'string', maxLength: 300, description: 'Why it is suspended; for staff, not shown to the user.' },
    },
  },
  AccountStatusResponse: {
    type: 'object',
    required: ['userId', 'status', 'suspendedAt', 'suspendedReason', 'sessionsRevoked'],
    properties: {
      userId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED'] },
      suspendedAt: { type: 'string', format: 'date-time', nullable: true },
      suspendedReason: { type: 'string', nullable: true },
      sessionsRevoked: { type: 'integer', description: 'Refresh sessions ended by this change.' },
    },
  },
  RefreshTokenRequest: {
    type: 'object',
    required: ['refreshToken'],
    properties: {
      refreshToken: { type: 'string', maxLength: 200, description: 'The latest refresh token. Each one works once.' },
    },
  },
  VerificationRequiredResponse: {
    type: 'object',
    description: '#34: register while email verification is required. No tokens until the email is verified and the user logs in.',
    required: ['userId', 'verificationRequired'],
    properties: {
      userId: { type: 'string', format: 'uuid' },
      verificationRequired: { type: 'boolean', enum: [true] },
    },
  },
  RegisterRequest: {
    type: 'object',
    required: ['fullName', 'email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', format: 'password' },
      fullName: { type: 'string' },
      phone: { type: 'string', nullable: true },
      // ADMIN is deliberately absent: it cannot be self-assigned at registration.
      role: { type: 'string', enum: ['CUSTOMER', 'RESTAURANT_OWNER', 'DRIVER'] },
      appId: { type: 'string', enum: ['customer', 'driver', 'restaurant', 'admin'], description: '#34: the app signing up, recorded on the session.' },
    },
  },
  CreateOrderRequest: {
    type: 'object',
    description:
      "Optional. Without deliveryAddress the customer's profile address is used; the address is copied onto the order. 400 if neither has one.",
    properties: {
      deliveryAddress: { type: 'string', maxLength: 500 },
      deliveryNotes: { type: 'string', maxLength: 500 },
      deliveryLatitude: { type: 'number', minimum: -90, maximum: 90, description: 'Requires deliveryAddress and deliveryLongitude.' },
      deliveryLongitude: { type: 'number', minimum: -180, maximum: 180, description: 'Requires deliveryAddress and deliveryLatitude.' },
    },
  },
  DriverCurrentDelivery: {
    type: 'object',
    required: ['id', 'status', 'orderId', 'pickup', 'dropOff', 'order', 'nextActions'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['DRIVER_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] },
      orderId: { type: 'string', format: 'uuid' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      pickup: {
        type: 'object',
        properties: { restaurantId: { type: 'string', format: 'uuid' }, name: { type: 'string' }, address: { type: 'string' } },
      },
      dropOff: {
        type: 'object',
        properties: {
          address: { type: 'string', nullable: true },
          notes: { type: 'string', nullable: true },
          latitude: { type: 'number', nullable: true },
          longitude: { type: 'number', nullable: true },
        },
      },
      order: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, quantity: { type: 'integer' } } } },
          totalAmount: { type: 'string', example: '19.98' },
        },
      },
      nextActions: { type: 'array', items: { type: 'string', enum: ['pickup', 'start', 'complete'] } },
      customerPhone: {
        type: 'string',
        nullable: true,
        example: '+201012345678',
        description: "#211: the customer's phone while the delivery is active, only for its driver; every reveal is recorded. Null when unknown.",
      },
      restaurantPhone: {
        type: 'string',
        nullable: true,
        example: '+201112345678',
        description: "#211: the restaurant's contact phone while the delivery is active, only for its driver. Null when unknown.",
      },
    },
  },
  DeliveryForOrder: {
    type: 'object',
    description: 'The delivery of an order, with the customer-safe driver card (#140) and, for the order\'s customer only, the driver\'s phone (#211).',
    required: ['id', 'orderId', 'status', 'driver', 'driverPhone'],
    additionalProperties: true,
    properties: {
      id: { type: 'string', format: 'uuid' },
      orderId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['CREATED', 'DRIVER_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'] },
      driver: {
        type: 'object',
        nullable: true,
        properties: {
          displayName: { type: 'string' },
          avatarUrl: { type: 'string', nullable: true },
          vehicleType: { type: 'string', nullable: true },
          licensePlate: { type: 'string', nullable: true },
        },
      },
      driverPhone: {
        type: 'string',
        nullable: true,
        example: '+201012345678',
        description:
          "#211: the driver's phone, for the order's customer only and only while the delivery is active (DRIVER_ASSIGNED, PICKED_UP, IN_TRANSIT); null otherwise. Every reveal is recorded.",
      },
    },
  },
  DriverHistoryPage: {
    type: 'object',
    required: ['items', 'page', 'limit', 'total', 'totalPages'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'orderId', 'status', 'updatedAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            orderId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['DRIVER_ASSIGNED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'] },
            assignedAt: { type: 'string', format: 'date-time', nullable: true },
            pickedUpAt: { type: 'string', format: 'date-time', nullable: true },
            deliveredAt: { type: 'string', format: 'date-time', nullable: true },
            cancelledAt: { type: 'string', format: 'date-time', nullable: true },
            updatedAt: { type: 'string', format: 'date-time' },
            restaurant: {
              type: 'object',
              nullable: true,
              properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
            },
            order: {
              type: 'object',
              nullable: true,
              properties: {
                items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, quantity: { type: 'integer' } } } },
                totalAmount: { type: 'string', example: '19.98' },
                dropOffAddress: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      total: { type: 'integer', minimum: 0 },
      totalPages: { type: 'integer', minimum: 1 },
    },
  },
  CreateRatingRequest: {
    type: 'object',
    required: ['score'],
    properties: {
      score: { type: 'integer', minimum: 1, maximum: 5, example: 5 },
      comment: { type: 'string', maxLength: 500 },
    },
  },
  Rating: {
    type: 'object',
    required: ['score', 'comment', 'createdAt'],
    properties: {
      score: { type: 'integer', minimum: 1, maximum: 5 },
      comment: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  DeliveryRatingStatus: {
    type: 'object',
    required: ['rating', 'canRate', 'reason', 'closesAt'],
    properties: {
      rating: { allOf: [{ $ref: '#/components/schemas/Rating' }], nullable: true },
      canRate: { type: 'boolean' },
      reason: { type: 'string', nullable: true },
      closesAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  DriverRatingSummary: {
    type: 'object',
    required: ['average', 'count', 'recentComments'],
    properties: {
      average: { type: 'number', nullable: true, example: 4.7 },
      count: { type: 'integer', minimum: 0 },
      recentComments: { type: 'array', items: { $ref: '#/components/schemas/Rating' } },
    },
  },
  VerifyEmailRequest: {
    type: 'object',
    required: ['email', 'token'],
    properties: {
      email: { type: 'string', format: 'email' },
      token: {
        type: 'string',
        pattern: '^\\d{6}$',
        description: '#203: the 6-digit code from the email. It works once, for 10 minutes; the 5th wrong code invalidates it.',
      },
    },
  },
  ResendVerificationRequest: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', format: 'email' },
    },
  },
    ChangePasswordRequest: {
    type: 'object',
    required: ['currentPassword', 'newPassword'],
    properties: {
      currentPassword: { type: 'string', minLength: 1 },
      newPassword: { type: 'string', minLength: 8 },
    },
  },
  ForgotPasswordRequest: {
    type: 'object',
    required: ['phone'],
    properties: {
      phone: {
        type: 'string',
        description: 'Egyptian mobile number associated with the account.',
      },
    },
  },
  ResetPasswordRequest: {
    type: 'object',
    required: ['phone', 'code', 'newPassword'],
    properties: {
      phone: { type: 'string', description: 'Egyptian mobile number.' },
      code: { type: 'string', pattern: '^\\d{6}$', description: 'Six-digit SMS password-reset code.' },
      newPassword: { type: 'string', minLength: 8 },
    },
  },
  AuthResponse: {
    type: 'object',
    description: '#34: a short-lived access token (Bearer) and a single-use refresh token.',
    required: ['accessToken', 'accessTokenExpiresAt', 'refreshToken', 'refreshTokenExpiresAt', 'userId', 'email', 'role'],
    properties: {
      accessToken: { type: 'string', description: 'JWT for Authorization: Bearer. 15 minutes by default.' },
      accessTokenExpiresAt: { type: 'string', format: 'date-time' },
      refreshToken: { type: 'string', description: 'Opaque. Send it to POST /api/auth/refresh; it works once.' },
      refreshTokenExpiresAt: { type: 'string', format: 'date-time', description: '30 days after the last refresh by default (sliding).' },
      userId: { type: 'string' },
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['CUSTOMER', 'RESTAURANT_OWNER', 'DRIVER', 'ADMIN'] },
    },
  },
  ImageUploadUrlRequest: {
    type: 'object',
    required: ['contentType'],
    properties: {
      contentType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] },
    },
  },
  RestaurantImageUploadUrlRequest: {
    type: 'object',
    required: ['imageType', 'contentType'],
    properties: {
      imageType: { type: 'string', enum: ['cover', 'logo'] },
      contentType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] },
    },
  },
  RestaurantCreateRequest: {
    type: 'object',
    required: ['name', 'address'],
    properties: {
      name: { type: 'string', minLength: 2 },
      description: { type: 'string' },
      address: { type: 'string' },
      latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Requires longitude.' },
      longitude: { type: 'number', minimum: -180, maximum: 180, description: 'Requires latitude.' },
      legalName: { type: 'string', minLength: 2, maxLength: 200, nullable: true, description: '#208: the registered name; the only legal detail required to submit. Never public.' },
      commercialRegistrationNumber: { type: 'string', maxLength: 50, nullable: true, description: '#208: optional. Never public.' },
      taxCardNumber: { type: 'string', maxLength: 50, nullable: true, description: '#208: optional. Never public.' },
      contactPhone: { type: 'string', nullable: true, example: '01012345678', description: '#208: an Egyptian mobile, stored as E.164; required to submit. Never public.' },
      cuisineTags: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 2, maxLength: 30 }, example: ['Burgers'] },
    },
  },
  RestaurantUpdateRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      address: { type: 'string' },
      latitude: { type: 'number', minimum: -90, maximum: 90, description: 'Requires longitude.' },
      longitude: { type: 'number', minimum: -180, maximum: 180, description: 'Requires latitude.' },
      legalName: { type: 'string', minLength: 2, maxLength: 200, nullable: true, description: '#208: the registered name; the only legal detail required to submit. Never public.' },
      commercialRegistrationNumber: { type: 'string', maxLength: 50, nullable: true, description: '#208: optional. Never public.' },
      taxCardNumber: { type: 'string', maxLength: 50, nullable: true, description: '#208: optional. Never public.' },
      contactPhone: { type: 'string', nullable: true, example: '01012345678', description: '#208: an Egyptian mobile, stored as E.164; required to submit. Never public.' },
      cuisineTags: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 2, maxLength: 30 }, example: ['Burgers'] },
    },
  },
  UpdateDeliveryRadiusRequest: {
    type: 'object',
    required: ['deliveryRadiusKm'],
    properties: {
      deliveryRadiusKm: { type: 'number', exclusiveMinimum: 0, maximum: 50, example: 5 },
    },
  },
  PublicRestaurant: {
    type: 'object',
    required: ['id', 'name', 'address', 'latitude', 'longitude', 'deliveryRadiusKm', 'status'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: 'string', nullable: true },
      coverImageUrl: { type: 'string', nullable: true },
      logoUrl: { type: 'string', nullable: true },
      address: { type: 'string' },
      latitude: { type: 'number', nullable: true },
      longitude: { type: 'number', nullable: true },
      deliveryRadiusKm: { type: 'number', description: 'Effective radius, including the configured default.' },
      distanceKm: { type: 'number', description: 'Present only when lat and lng are supplied to the list endpoint.' },
      status: { type: 'string', enum: ['OPEN', 'CLOSED', 'BUSY', 'SUSPENDED'] },
      approvalStatus: {
        type: 'string',
        enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'],
        description: '#208: always APPROVED on public routes; customers never see a restaurant that is not approved.',
      },
      cuisineTags: { type: 'array', items: { type: 'string' } },
    },
  },
  OwnerRestaurant: {
    description: '#208: the owner\'s view of their restaurant: the public card plus the application.',
    allOf: [
      { $ref: '#/components/schemas/PublicRestaurant' },
      {
        type: 'object',
        required: ['approvalStatus', 'submittedAt', 'approvedAt', 'approvalNote', 'legalName', 'commercialRegistrationNumber', 'taxCardNumber', 'contactPhone', 'lastReview'],
        properties: {
          approvalStatus: {
            type: 'string',
            enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'],
            description: 'DRAFT: fill in and submit. SUBMITTED: waiting for review. APPROVED: can open. REJECTED: fix what the note says and submit again.',
          },
          submittedAt: { type: 'string', format: 'date-time', nullable: true },
          approvedAt: { type: 'string', format: 'date-time', nullable: true },
          approvalNote: { type: 'string', nullable: true, description: "The reviewer's latest note, e.g. what to fix." },
          legalName: { type: 'string', nullable: true },
          commercialRegistrationNumber: { type: 'string', nullable: true },
          taxCardNumber: { type: 'string', nullable: true },
          contactPhone: { type: 'string', nullable: true, example: '+201012345678' },
          lastReview: {
            type: 'object',
            nullable: true,
            required: ['decision', 'reviewedAt'],
            properties: {
              decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
              note: { type: 'string', nullable: true },
              reviewedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    ],
  },
  StaffRestaurantApplication: {
    description: '#208: the application as staff see it, with the owner and every decision, newest first.',
    allOf: [
      { $ref: '#/components/schemas/OwnerRestaurant' },
      {
        type: 'object',
        required: ['ownerId', 'reviews'],
        properties: {
          ownerId: { type: 'string', format: 'uuid' },
          reviews: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'decision', 'reviewerUserId', 'applicationSubmittedAt', 'reviewedAt'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
                note: { type: 'string', nullable: true },
                reviewerUserId: { type: 'string', format: 'uuid' },
                applicationSubmittedAt: { type: 'string', format: 'date-time' },
                reviewedAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
    ],
  },
  RestaurantReviewRequest: {
    type: 'object',
    required: ['decision', 'submittedAt'],
    properties: {
      decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
      note: { type: 'string', minLength: 3, maxLength: 300, description: 'Shown to the owner. Required to reject.' },
      submittedAt: { type: 'string', format: 'date-time', description: "The application's submittedAt as the reviewer saw it." },
    },
  },
  RestaurantApplicationIncompleteError: {
    type: 'object',
    description: '#208: 422 when submit (or an approval) finds the application incomplete.',
    properties: {
      statusCode: { type: 'integer', example: 422 },
      error: { type: 'string', example: 'ApplicationIncomplete' },
      message: { type: 'string' },
      details: {
        type: 'object',
        properties: {
          missing: {
            type: 'array',
            items: { type: 'string', enum: ['legalName', 'contactPhone', 'location', 'menuCategory', 'availableMenuItem'] },
          },
        },
      },
    },
  },
  PublicRestaurantList: {
    type: 'object',
    required: ['items', 'page', 'limit', 'total', 'totalPages'],
    properties: {
      items: { type: 'array', items: { $ref: '#/components/schemas/PublicRestaurant' } },
      page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1 },
      total: { type: 'integer', minimum: 0 },
      totalPages: { type: 'integer', minimum: 1 },
    },
  },
  ImageConfirmRequest: {
    type: 'object',
    required: ['objectKey'],
    properties: {
      objectKey: { type: 'string' },
    },
  },
  RestaurantImageConfirmRequest: {
    type: 'object',
    required: ['imageType', 'objectKey'],
    properties: {
      imageType: { type: 'string', enum: ['cover', 'logo'] },
      objectKey: { type: 'string' },
    },
  },
  DriverDocumentType: {
    type: 'string',
    description: '#207: the documents a driver application needs; all five are required.',
    enum: ['national-id-front', 'national-id-back', 'driving-licence', 'vehicle-licence', 'selfie'],
  },
  SaveDriverApplicationRequest: {
    type: 'object',
    required: ['nationalIdNumber', 'drivingLicenceExpiresOn', 'vehicleLicenceExpiresOn'],
    properties: {
      nationalIdNumber: {
        type: 'string',
        pattern: '^[23]\\d{13}$',
        writeOnly: true,
        description: 'The 14-digit Egyptian national ID. Only its last 4 digits and a keyed hash are stored; it is never returned.',
      },
      drivingLicenceExpiresOn: { type: 'string', format: 'date', description: 'Cairo date; not in the past, at most 15 years ahead.' },
      vehicleLicenceExpiresOn: { type: 'string', format: 'date', description: 'Cairo date; not in the past, at most 15 years ahead.' },
    },
  },
  DriverDocumentUploadUrlRequest: {
    type: 'object',
    required: ['contentType'],
    properties: { contentType: { type: 'string', enum: ['image/jpeg', 'image/png', 'application/pdf'] } },
  },
  DriverDocumentConfirmRequest: {
    type: 'object',
    required: ['objectKey'],
    properties: { objectKey: { type: 'string', maxLength: 255, description: 'The objectKey the upload URL returned.' } },
  },
  DriverApplication: {
    type: 'object',
    description: '#207: a driver application. Never contains a document URL or object key.',
    required: ['driverId', 'status', 'documents', 'missingDocuments', 'canSubmit', 'expiringLicences'],
    properties: {
      driverId: { type: 'string', format: 'uuid' },
      status: {
        type: 'string',
        enum: ['DRAFT', 'SUBMITTED', 'VERIFIED', 'REJECTED'],
        description:
          'DRAFT: the driver can edit and submit. SUBMITTED: in the review queue. VERIFIED: approved. REJECTED: the driver can correct the application and submit it again.',
      },
      submittedAt: { type: 'string', format: 'date-time', nullable: true, description: 'The latest submission. A reviewer sends it back with the decision.' },
      verificationNote: { type: 'string', nullable: true, description: "The reviewer's note, e.g. why the application was rejected." },
      lastReview: {
        type: 'object',
        nullable: true,
        description: 'The latest decision, kept after a resubmission.',
        required: ['decision', 'reviewedAt'],
        properties: {
          decision: { type: 'string', enum: ['VERIFIED', 'REJECTED'] },
          note: { type: 'string', nullable: true },
          reviewedAt: { type: 'string', format: 'date-time' },
        },
      },
      nationalIdLast4: { type: 'string', nullable: true, example: '4567' },
      drivingLicenceExpiresOn: { type: 'string', format: 'date', nullable: true },
      vehicleLicenceExpiresOn: { type: 'string', format: 'date', nullable: true },
      documents: {
        type: 'array',
        description: 'The current version of each uploaded document.',
        items: {
          type: 'object',
          required: ['type', 'version', 'contentType', 'sizeBytes', 'uploadedAt'],
          properties: {
            type: { $ref: '#/components/schemas/DriverDocumentType' },
            version: { type: 'integer', minimum: 1, maximum: 5 },
            contentType: { type: 'string', enum: ['image/jpeg', 'image/png', 'application/pdf'] },
            sizeBytes: { type: 'integer' },
            uploadedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
      missingDocuments: { type: 'array', items: { $ref: '#/components/schemas/DriverDocumentType' } },
      canSubmit: { type: 'boolean' },
      expiringLicences: {
        type: 'array',
        description:
          'Licences valid today that expire within 14 days (Cairo), soonest first. Once one has expired, a VERIFIED driver goes back to DRAFT for re-review and offline.',
        items: {
          type: 'object',
          required: ['field', 'expiresOn'],
          properties: {
            field: { type: 'string', enum: ['drivingLicenceExpiresOn', 'vehicleLicenceExpiresOn'] },
            expiresOn: { type: 'string', format: 'date' },
          },
        },
      },
    },
  },
  StaffDriverApplication: {
    description: '#207: the application as staff see it, with every decision, newest first.',
    allOf: [
      { $ref: '#/components/schemas/DriverApplication' },
      {
        type: 'object',
        required: ['reviews'],
        properties: {
          reviews: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'decision', 'reviewedAt', 'reviewerUserId', 'documents'],
              properties: {
                id: { type: 'string', format: 'uuid' },
                decision: { type: 'string', enum: ['VERIFIED', 'REJECTED'] },
                note: { type: 'string', nullable: true },
                reviewedAt: { type: 'string', format: 'date-time' },
                reviewerUserId: { type: 'string', format: 'uuid' },
                applicationSubmittedAt: {
                  type: 'string',
                  format: 'date-time',
                  nullable: true,
                  description: 'The submission decided; null for a decision made with PATCH /drivers/:id/verification on a driver who never applied.',
                },
                documents: {
                  type: 'array',
                  description: 'The document versions that were current when the decision was made.',
                  items: {
                    type: 'object',
                    required: ['type', 'version'],
                    properties: { type: { $ref: '#/components/schemas/DriverDocumentType' }, version: { type: 'integer' } },
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
  DriverApplicationReviewRequest: {
    type: 'object',
    required: ['decision', 'submittedAt'],
    properties: {
      decision: { type: 'string', enum: ['VERIFIED', 'REJECTED'] },
      note: { type: 'string', minLength: 3, maxLength: 300, description: 'Shown to the driver. Required to reject.' },
      submittedAt: {
        type: 'string',
        format: 'date-time',
        description: "The application's submittedAt as the reviewer saw it; if the driver resubmitted since, the review is refused.",
      },
    },
  },
  ApplicationIncompleteError: {
    type: 'object',
    description: '#207: 422 when submit is called before every field and document is in place, or a reviewer approves an application that is no longer valid.',
    properties: {
      statusCode: { type: 'integer', example: 422 },
      error: { type: 'string', example: 'ApplicationIncomplete' },
      message: { type: 'string' },
      details: {
        type: 'object',
        properties: {
          missingFields: { type: 'array', items: { type: 'string', enum: ['nationalIdNumber', 'drivingLicenceExpiresOn', 'vehicleLicenceExpiresOn'] } },
          missingDocuments: { type: 'array', items: { $ref: '#/components/schemas/DriverDocumentType' } },
          expiredLicences: { type: 'array', items: { type: 'string', enum: ['drivingLicenceExpiresOn', 'vehicleLicenceExpiresOn'] } },
        },
      },
    },
  },
  DriverDocumentReadUrl: {
    type: 'object',
    required: ['type', 'version', 'contentType', 'url', 'expiresIn'],
    properties: {
      type: { $ref: '#/components/schemas/DriverDocumentType' },
      version: { type: 'integer' },
      contentType: { type: 'string', enum: ['image/jpeg', 'image/png', 'application/pdf'] },
      url: { type: 'string', format: 'uri', description: 'A presigned GET. A bearer credential: never log or store it.' },
      expiresIn: { type: 'integer', maximum: 300, example: 300 },
    },
  },
  PresignedImageUpload: {
    type: 'object',
    required: ['uploadUrl', 'objectKey', 'expiresIn', 'method', 'fields'],
    properties: {
      uploadUrl: {
        type: 'string',
        format: 'uri',
        description: 'POST multipart form data to this object-storage URL.',
      },
      objectKey: { type: 'string', description: 'Temporary key to submit to the corresponding confirmation endpoint.' },
      expiresIn: { type: 'integer', example: 300 },
      method: { type: 'string', enum: ['POST'], description: 'HTTP method for the upload request.' },
      fields: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Include every field in the multipart form before adding the image file.',
      },
    },
  },
};

export function generatePublicOpenApiDocument() {
  const publicSpec = {
    openapi: '3.0.3',
    info: {
      title: 'Delivery Plus Public API',
      version: '1.0.0',
      description:
        'Public Gateway contract for the Delivery Plus food delivery platform. This specification exposes the canonical public paths behind the API Gateway and intentionally excludes internal-only service routes.',
    },
    servers: [{ url: 'http://localhost:3000' }],
    tags: SERVICE_DEFINITIONS.map(({ service }) => ({ name: service, description: `${service} service endpoints` })),
    paths: {} as Record<string, Record<string, any>>,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: baseSchemas,
    },
  };

  for (const service of SERVICE_DEFINITIONS) {
    for (const route of service.routes) {
      const pathKey = joinPublicPath(service.publicPrefix, route.path);
      const operationId = `${service.service}_${route.method}_${pathKey.replace(/[/:{}-]+/g, '_').replace(/^_+|_+$/g, '')}`;

      const operation: Record<string, any> = {
        summary: route.summary,
        tags: [service.service],
        operationId,
        responses: {
          [String(route.statusCode || 200)]: { description: 'Successful response' },
          '400': { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '401': { description: 'Unauthorized' },
          '403': { description: 'Forbidden' },
        },
      };

      const pathParameters = extractPathParameters(pathKey);
      if (pathParameters.length > 0) {
        operation.parameters = pathParameters.map((name) => buildPathParameter(name));
      }

      if (route.auth) {
        operation.security = [{ bearerAuth: [] }];
        operation.responses['401'] = { description: 'Missing or invalid JWT' };
      } else {
        operation.security = [];
      }

      if (service.service === 'restaurants' && route.method === 'get' && route.path === '') {
        operation.parameters = [
          ...(operation.parameters ?? []),
          { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 20 } },
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['OPEN', 'CLOSED', 'BUSY', 'SUSPENDED'] } },
          { name: 'search', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'sortBy', in: 'query', required: false, schema: { type: 'string', enum: ['name', 'createdAt'], default: 'createdAt' } },
          { name: 'sortOrder', in: 'query', required: false, schema: { type: 'string', enum: ['ASC', 'DESC'], default: 'DESC' } },
          { name: 'lat', in: 'query', required: false, schema: { type: 'number', minimum: -90, maximum: 90, description: 'Requires lng; filters to restaurants covering this point.' } },
          { name: 'lng', in: 'query', required: false, schema: { type: 'number', minimum: -180, maximum: 180, description: 'Requires lat; returns distanceKm and sorts by distance.' } },
        ];
        operation.responses['200'] = {
          description: 'Restaurants, optionally filtered by delivery location.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PublicRestaurantList' } } },
        };
      }

      const errorContent = { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } };

      if (service.service === 'restaurants' && route.method === 'post' && route.path === '') {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RestaurantCreateRequest' } } },
        };
        operation.responses['201'].content = {
          'application/json': { schema: { $ref: '#/components/schemas/OwnerRestaurant' } },
        };
        operation.responses['409'] = { description: 'RestaurantLimitReached: the owner already has a restaurant (#208)', content: errorContent };
      }

      if (service.service === 'restaurants' && route.method === 'get' && route.path === '/me') {
        operation.responses['200'].content = {
          'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/OwnerRestaurant' } } },
        };
      }

      if (service.service === 'restaurants' && route.method === 'patch' && route.path === '/:id') {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RestaurantUpdateRequest' } } },
        };
        operation.responses['200'].content = {
          'application/json': { schema: { $ref: '#/components/schemas/OwnerRestaurant' } },
        };
        operation.responses['409'] = {
          description:
            'ApplicationNotEditable: legal details change only before approval, and name, address and location not while submitted (details.approvalStatus, details.fields)',
          content: errorContent,
        };
      }

      if (service.service === 'restaurants' && route.method === 'get' && route.path === '/:id') {
        operation.responses['200'].content = {
          'application/json': { schema: { $ref: '#/components/schemas/PublicRestaurant' } },
        };
        operation.responses['404'] = { description: 'No such restaurant, or it is not approved (#208)' };
      }

      if (service.service === 'restaurants' && route.path === '/:id/submit') {
        operation.responses['200'].content = {
          'application/json': { schema: { $ref: '#/components/schemas/OwnerRestaurant' } },
        };
        operation.responses['409'] = { description: 'ApplicationNotEditable: already submitted or approved (details.approvalStatus)', content: errorContent };
        operation.responses['422'] = {
          description: 'ApplicationIncomplete: details.missing lists what is needed',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RestaurantApplicationIncompleteError' } } },
        };
      }

      if (service.service === 'restaurants' && (route.path === '/:id/application' || route.path === '/:id/review')) {
        operation.responses['200'].content = {
          'application/json': { schema: { $ref: '#/components/schemas/StaffRestaurantApplication' } },
        };
        operation.responses['403'] = { description: 'Requires an ADMIN token with onboarding.review' };
        operation.responses['404'] = { description: 'No such restaurant' };
        if (route.path === '/:id/review') {
          operation.requestBody = {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RestaurantReviewRequest' } } },
          };
          operation.responses['200'].description = 'Decided, or the same decision on the same submission repeated (no-op)';
          operation.responses['409'] = {
            description: 'ApplicationNotInReview: not waiting for review, or resubmitted since (details.approvalStatus)',
            content: errorContent,
          };
          operation.responses['422'] = {
            description: 'ApplicationIncomplete: an approval re-checks the application and the menu',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RestaurantApplicationIncompleteError' } } },
          };
        }
      }

      if (service.service === 'restaurants' && route.path === '/:id/status') {
        operation.responses['409'] = {
          description: 'RestaurantNotApproved: an owner can open (OPEN or BUSY) only an approved restaurant (details.approvalStatus)',
          content: errorContent,
        };
      }

      if (service.service === 'restaurants' && route.method === 'patch' && route.path === '/:id/delivery-radius') {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateDeliveryRadiusRequest' } } },
        };
        operation.responses['200'].content = {
          'application/json': { schema: { $ref: '#/components/schemas/PublicRestaurant' } },
        };
        operation.responses['403'] = { description: 'Admin role required' };
      }

      if (route.method === 'post' && route.path.endsWith('/image-upload-url')) {
        const requestSchema = service.service === 'restaurants'
          ? 'RestaurantImageUploadUrlRequest'
          : 'ImageUploadUrlRequest';
        operation.requestBody = {
          required: true,
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${requestSchema}` } },
          },
        };
        operation.responses[String(route.statusCode || 201)].content = {
          'application/json': { schema: { $ref: '#/components/schemas/PresignedImageUpload' } },
        };
      }

      if (
        route.method === 'post' &&
        (route.path.endsWith('/image-confirm') || route.path.endsWith('/avatar/confirm'))
      ) {
        const requestSchema = service.service === 'restaurants'
          ? 'RestaurantImageConfirmRequest'
          : 'ImageConfirmRequest';
        operation.requestBody = {
          required: true,
          content: {
            'application/json': { schema: { $ref: `#/components/schemas/${requestSchema}` } },
          },
        };
      }

      if (route.method === 'get' && service.service === 'deliveries' && route.path === '/by-order/:orderId') {
        operation.responses['200'] = {
          description: 'The delivery, with the driver card and the driver\'s phone for the customer during an active delivery',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/DeliveryForOrder' } } },
        };
      }

      if (route.method === 'get' && service.service === 'deliveries' && route.path === '/me/current') {
        operation.responses['200'] = {
          description: "The calling driver's active delivery (DRIVER role only)",
          content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverCurrentDelivery' } } },
        };
        operation.responses['204'] = { description: 'No active delivery (or no driver profile yet)' };
      }

      if (route.method === 'get' && service.service === 'deliveries' && route.path === '/me/history') {
        operation.parameters = [
          ...(operation.parameters ?? []),
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['active', 'completed', 'cancelled'] } },
          { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 } },
        ];
        operation.responses['200'] = {
          description: "The calling driver's deliveries, newest first (DRIVER role only; no customer identity)",
          content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverHistoryPage' } } },
        };
      }

      if (service.service === 'deliveries' && route.path === '/:id/rating') {
        if (route.method === 'post') {
          operation.requestBody = {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateRatingRequest' } } },
          };
          operation.responses['201'] = {
            description: "Rating stored (the order's customer, after delivery, within 14 days)",
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Rating' } } },
          };
          operation.responses['200'] = {
            description: 'Identical retry: the stored rating',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Rating' } } },
          };
          operation.responses['409'] = { description: 'Already rated with a different score or comment' };
          operation.responses['422'] = { description: 'Not delivered yet, or the 14-day window has closed' };
        } else {
          operation.responses['200'] = {
            description: "The rating, or whether the order's customer can still rate",
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DeliveryRatingStatus' } } },
          };
        }
      }

      if (route.method === 'get' && service.service === 'deliveries' && route.path === '/me/rating-summary') {
        operation.responses['200'] = {
          description: "The calling driver's average, count and recent comments (DRIVER role only; no customer identity)",
          content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverRatingSummary' } } },
        };
      }

      // #201: the only field is a test hook, refused outside the test and E2E stacks.
      if (route.method === 'post' && service.service === 'payments' && route.path === '/:id/process') {
        operation.requestBody = {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  simulateFailure: {
                    type: 'boolean',
                    description:
                      'Test hook, test and E2E stacks only (PAYMENT_TEST_HOOKS=true): true forces a decline, false forces success. ' +
                      'Anywhere else sending it returns 400 "simulateFailure is a test hook and is disabled". Clients must omit it.',
                  },
                },
              },
            },
          },
        };
        operation.responses['400'] = { description: 'simulateFailure sent while test hooks are disabled' };
      }

      // #53/#56: optional reasons on platform cancellations and support refunds; the refund audit record.
      if (route.method === 'post' && (route.path === '/:id/cancel' || route.path === '/:id/refund') && ['deliveries', 'payments'].includes(service.service)) {
        operation.requestBody = {
          required: false,
          content: {
            'application/json': {
              schema: { type: 'object', properties: { reason: { type: 'string', maxLength: service.service === 'deliveries' ? 200 : 300 } } },
            },
          },
        };
      }
      if (route.method === 'get' && service.service === 'payments' && route.path === '/:id/refund') {
        operation.responses['200'] = {
          description: 'The refund (one per payment, always the whole amount; simulated until a payment gateway exists)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  paymentId: { type: 'string', format: 'uuid' },
                  orderId: { type: 'string', format: 'uuid' },
                  amount: { type: 'string', example: '225.00' },
                  currency: { type: 'string', example: 'EGP' },
                  initiatedBy: { type: 'string', enum: ['CUSTOMER', 'RESTAURANT', 'SYSTEM', 'SUPPORT'] },
                  reason: { type: 'string' },
                  provider: { type: 'string', example: 'SIMULATED' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        };
        operation.responses['404'] = { description: 'The payment has not been refunded' };
      }

      // F6 (#205): cart writes have two different 409s; clients must tell them apart by `error`.
      if (service.service === 'cart' && ['post', 'patch', 'delete'].includes(route.method) && route.path.startsWith('/items')) {
        operation.responses['409'] = {
          description:
            route.method === 'post'
              ? 'Conflict: the cart holds items from another restaurant (offer to start a new cart); CartWriteConflict: the cart kept changing at the same time (just try again)'
              : 'CartWriteConflict: the cart kept changing at the same time; try again',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        };
      }

      // #42: checkout re-checks the cart; what changed comes back in details.changes.
      if (route.method === 'post' && ((service.service === 'orders' && route.path === '') || (service.service === 'cart' && route.path === '/validate'))) {
        operation.responses['409'] = {
          description: service.service === 'orders'
            ? 'CartChanged: the cart was out of date with the menu; OutOfDeliveryArea: the drop-off exceeds the restaurant radius; RestaurantBusy / RestaurantClosed: the restaurant is not taking orders right now (#286).'
            : 'CartChanged: the cart was out of date with the menu and has been updated; review it and try again',
          content: {
            'application/json': {
              schema: service.service === 'orders'
                ? {
                    oneOf: [
                      { $ref: '#/components/schemas/CartChangedError' },
                      { $ref: '#/components/schemas/OutOfDeliveryAreaError' },
                      { $ref: '#/components/schemas/RestaurantUnavailableError' },
                    ],
                  }
                : { $ref: '#/components/schemas/CartChangedError' },
            },
          },
        };
      }

      // #207: the driver application.
      if (service.service === 'drivers' && /\/(application|documents)/.test(route.path)) {
        const typeParameter = operation.parameters?.find((parameter: { name: string }) => parameter.name === 'type');
        if (typeParameter) typeParameter.schema = { $ref: '#/components/schemas/DriverDocumentType' };
        const success = String(route.statusCode || 200);
        const notEditable = {
          description: 'ApplicationNotEditable: the application is submitted or verified (details.applicationStatus)',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        };

        if (route.path.endsWith('/read-url')) {
          operation.responses[success] = {
            description: 'A 5-minute presigned URL (Cache-Control: no-store). The read is recorded first.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverDocumentReadUrl' } } },
          };
          operation.responses['403'] = { description: 'Requires an ADMIN token with onboarding.review' };
          operation.responses['404'] = { description: 'No such driver, or no document of this type' };
          operation.responses['429'] = { description: 'Too many document reads (60 a minute)' };
        } else if (route.path.endsWith('/upload-url')) {
          operation.requestBody = {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverDocumentUploadUrlRequest' } } },
          };
          operation.responses[success] = {
            description: 'POST the file with every field to uploadUrl, then confirm objectKey',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/PresignedImageUpload' } } },
          };
          operation.responses['409'] = notEditable;
          operation.responses['429'] = { description: 'Too many upload URLs (20 an hour)' };
        } else if (route.path.startsWith('/:id/application')) {
          operation.responses[success] = {
            description: 'The application with its review history',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/StaffDriverApplication' } } },
          };
          operation.responses['403'] = { description: 'Requires an ADMIN token with onboarding.review' };
          if (route.path.endsWith('/review')) {
            operation.requestBody = {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverApplicationReviewRequest' } } },
            };
            operation.responses['200'].description =
              'Decided, or the same decision on the same submission repeated (no-op). The application with its review history';
            operation.responses['409'] = {
              description:
                'ApplicationNotInReview: the application is not waiting for review, or the driver resubmitted since (details.applicationStatus)',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            };
            operation.responses['422'] = {
              description: 'ApplicationIncomplete: an approval needs every document and no expired licence',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ApplicationIncompleteError' } } },
            };
          }
        } else {
          operation.responses[success] = {
            description: 'The application',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverApplication' } } },
          };
          if (route.method === 'put') {
            operation.requestBody = {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/SaveDriverApplicationRequest' } } },
            };
            operation.responses['409'] = {
              description: 'NationalIdAlreadyRegistered: the national ID is on another driver account; ApplicationNotEditable: submitted or verified',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            };
          }
          if (route.path.endsWith('/confirm')) {
            operation.requestBody = {
              required: true,
              content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverDocumentConfirmRequest' } } },
            };
            operation.responses['409'] = {
              description: 'DocumentVersionLimitReached: 5 uploads of this type already; ApplicationNotEditable: submitted or verified',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
            };
            operation.responses['429'] = { description: 'Too many confirms (30 an hour)' };
          }
          if (route.path.endsWith('/submit')) {
            operation.responses['409'] = notEditable;
            operation.responses['422'] = {
              description: 'ApplicationIncomplete: what is missing or expired is in details',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ApplicationIncompleteError' } } },
            };
          }
        }
      }

      // #206 and #153: going online needs a VERIFIED driver, then a verified phone when that gate is on.
      if (route.method === 'post' && service.service === 'drivers' && (route.path === '/me/online' || route.path === '/me/status')) {
        operation.responses['403'] = {
          description:
            'DriverNotVerified: an admin has not verified the driver (details.verificationStatus is PENDING or REJECTED); PhoneNotVerified: the phone gate is on and the phone is not verified; or the driver is on an active delivery',
          content: {
            'application/json': {
              schema: { oneOf: [{ $ref: '#/components/schemas/DriverNotVerifiedError' }, { $ref: '#/components/schemas/ErrorResponse' }] },
            },
          },
        };
      }

      if (route.method === 'post' && service.service === 'orders' && route.path === '') {
        operation.requestBody = {
          required: false,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateOrderRequest' } },
          },
        };
      }

      if (route.method === 'post' && service.service === 'auth' && route.path === '/register') {
        operation.requestBody = {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/RegisterRequest' } },
          },
        };
        operation.responses[String(route.statusCode || 201)] = {
          description: 'Registered. Signed in (AuthResponse), or, while email verification is required, VerificationRequiredResponse with no tokens',
          content: {
            'application/json': {
              schema: { oneOf: [{ $ref: '#/components/schemas/AuthResponse' }, { $ref: '#/components/schemas/VerificationRequiredResponse' }] },
            },
          },
        };
      }

      // #34: refresh rotates the token; logout ends the session of a refresh token.
      if (route.method === 'post' && service.service === 'auth' && (route.path === '/refresh' || route.path === '/logout')) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RefreshTokenRequest' } } },
        };
        if (route.path === '/refresh') {
          operation.responses['200'] = {
            description: 'A new access token and a new refresh token; the one sent no longer works',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } },
          };
          operation.responses['401'] = {
            description: 'InvalidRefreshToken: unknown, expired, revoked or already used (reusing one ends its session). Sign in again',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
          };
          operation.responses['429'] = { description: 'Too many refreshes for this session' };
        } else {
          operation.responses['204'] = { description: 'Signed out (also returned for an unknown token)' };
        }
      }

      if (route.method === 'patch' && service.service === 'auth' && route.path === '/users/:id/status') {
        operation.requestBody = { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AccountStatusRequest' } } } };
        operation.responses['200'] = { description: 'The account status now', content: { 'application/json': { schema: { $ref: '#/components/schemas/AccountStatusResponse' } } } };
        operation.responses['403'] = { description: 'Not staff, no users.manage permission, a staff account, or your own account' };
        operation.responses['404'] = { description: 'No such user' };
      }

      // #202: a suspended account gets 403 AccountSuspended, only once its credentials checked out.
      // #252: login also answers 403 EmailNotVerified, under the same condition.
      if (route.method === 'post' && service.service === 'auth' && (route.path === '/login' || route.path === '/refresh')) {
        operation.responses['403'] = {
          description:
            route.path === '/login'
              ? 'AccountSuspended: the account is suspended (show the suspended screen). EmailNotVerified: email verification is required and this email is not verified yet (show the code screen). Both only after the password checked out'
              : 'AccountSuspended: the account is suspended (show the suspended screen)',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        };
      }

      if (route.method === 'post' && service.service === 'auth' && route.path === '/logout-all') {
        operation.responses['204'] = { description: 'Every session of the user ended. Access tokens already issued expire on their own' };
      }

      if (route.method === 'post' && service.service === 'auth' && route.path === '/login') {
        operation.requestBody = {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } },
          },
        };
        operation.responses[String(route.statusCode || 200)] = {
          description: 'Authenticated response',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } },
          },
        };
      }

      if (route.method === 'post' && service.service === 'auth' && route.path === '/verify-email') {
        operation.requestBody = {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/VerifyEmailRequest' } },
          },
        };
        operation.responses[String(route.statusCode || 200)] = {
          description: 'Verification successful',
          content: {
            'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } },
          },
        };
        operation.responses['401'] = { description: 'Invalid or expired verification code (wrong, used, expired or invalidated): ask for a new one' };
      }

      if (route.method === 'post' && service.service === 'auth' && route.path === '/resend-verification') {
        operation.requestBody = {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ResendVerificationRequest' } },
          },
        };
        operation.responses[String(route.statusCode || 200)] = {
          description: 'The same answer whether or not the address has an account',
          content: {
            'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } },
          },
        };
        operation.responses['429'] = { description: 'Too soon: one code a minute per address, 5 an hour; and 20 an hour per client IP' };
        operation.responses['503'] = {
          description: 'EmailUnavailable: email is not set up yet, or the provider failed (show "try again later")',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        };
      }

      if (route.method === 'post' && service.service === 'auth' && route.path === '/password/change') {
        operation.requestBody = {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ChangePasswordRequest' } },
          },
        };
        operation.responses[String(route.statusCode || 204)] = {
          description: 'Password changed. Every other session is revoked; the current one stays signed in.',
        };
        operation.responses['400'] = {
          description:
            'CurrentPasswordIncorrect: the current password is wrong (or the account is locked); counts as a failed sign-in attempt. Or a validation error: the new password is under 8 characters or equals the current one',
        };
        operation.responses['401'] = { description: 'Not signed in (missing, expired or revoked access token)' };
        operation.responses['403'] = { description: 'AccountSuspended' };
        operation.responses['429'] = { description: 'Too many attempts: 5 a minute per user' };
      }

       if (route.method === 'post' && service.service === 'auth' && route.path === '/password/forgot') {
        operation.requestBody = {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ForgotPasswordRequest' } },
          },
        };
        operation.responses[String(route.statusCode || 202)] = {
          description: 'The same answer whether or not the phone has an account',
          content: {
            'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } },
          },
        };
        operation.responses['400'] = { description: 'Validation error: not an Egyptian mobile number' };
        operation.responses['429'] = { description: 'Too many requests: 5 a minute per client, and hourly limits per client IP (20) and per phone (5)' };
        operation.responses['503'] = {
          description: 'SmsUnavailable: SMS is not set up yet. A provider failure still answers 202 so nothing reveals the account (show "try again later")',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        };
      }

      if (route.method === 'post' && service.service === 'auth' && route.path === '/password/reset') {
        operation.requestBody = {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ResetPasswordRequest' } },
          },
        };
        operation.responses[String(route.statusCode || 204)] = {
          description: 'Password reset. Every session of the account is revoked and the lockout is cleared.',
        };
        operation.responses['400'] = { description: 'Validation error: bad phone, code is not 6 digits, or password under 8 characters' };
        operation.responses['401'] = { description: 'Invalid or expired code (wrong, used, expired or out of attempts): ask for a new one' };
        operation.responses['403'] = { description: 'AccountSuspended' };
        operation.responses['429'] = { description: 'Too many attempts: 10 a minute per client' };
      }

      if (!publicSpec.paths[pathKey]) {
        publicSpec.paths[pathKey] = {};
      }

      publicSpec.paths[pathKey][route.method] = operation;
    }
  }

  return publicSpec;
}

export function validatePublicOpenApiDocument(
  doc: Record<string, any>,
  servicePrefixes: readonly string[] = SERVICE_PREFIXES,
  options: { forbidAdmin?: boolean } = {},
): void {
  assert(doc.openapi === '3.0.3', 'OpenAPI version must be 3.0.3');
  assert(doc.servers?.[0]?.url === 'http://localhost:3000', 'Gateway server URL must point to localhost:3000');
  assert(doc.paths && typeof doc.paths === 'object', 'paths must exist');

  const pathNames = Object.keys(doc.paths);
  const seenMethods = new Set<string>();
  const seenOperationIds = new Set<string>();
  const refs = new Set<string>();

  for (const path of pathNames) {
    assert(path.startsWith('/api/'), `Public path must start with /api/: ${path}`);
    assert(!path.includes('/internal'), `Internal-only route leaked into public OpenAPI: ${path}`);
    // #212: admin routes are a separate contract (docs/openapi/admin.json), never public.
    assert(options.forbidAdmin === false || !path.startsWith('/api/admin/'), `Admin route leaked into public OpenAPI: ${path}`);
    assert(!path.toLowerCase().includes('docs-json'), `Docs JSON route leaked into business contract: ${path}`);
    assert(!/\/:[A-Za-z0-9_]+/.test(path), `Express-style path params are not valid in OpenAPI paths: ${path}. Use /{parameter} instead.`);

    const expectedParameters = extractPathParameters(path);
    const methods = Object.keys(doc.paths[path] ?? {});
    for (const method of methods) {
      const key = `${path}::${method}`;
      assert(!seenMethods.has(key), `Duplicate path/method combination found: ${key}`);
      seenMethods.add(key);

      const operation = doc.paths[path][method];
      if (!operation || typeof operation !== 'object') {
        throw new Error(`Operation missing for ${method.toUpperCase()} ${path}`);
      }

      assert(operation.operationId, `OperationId missing for ${method.toUpperCase()} ${path}`);
      assert(!seenOperationIds.has(operation.operationId), `Duplicate operationId: ${operation.operationId}`);
      seenOperationIds.add(operation.operationId);

      const parameterList = Array.isArray(operation.parameters) ? operation.parameters : [];
      const declaredPathParams = parameterList.filter((parameter: any) => parameter && parameter.in === 'path');

      const missing = expectedParameters.filter((name) => !declaredPathParams.some((parameter: any) => parameter.name === name));
      assert(
        missing.length === 0,
        `Path ${path} is missing required OpenAPI path parameter definitions for: ${missing.join(', ')}`,
      );

      const unused = declaredPathParams.filter((parameter: any) => !expectedParameters.includes(parameter.name));
      assert(
        unused.length === 0,
        `Path ${path} declares unused path parameters: ${unused.map((parameter: any) => parameter.name).join(', ')}`,
      );

      for (const parameter of declaredPathParams) {
        assert(parameter.in === 'path', `Path parameter ${parameter.name} for ${method.toUpperCase()} ${path} must use in: path`);
        assert(parameter.required === true, `Path parameter ${parameter.name} for ${method.toUpperCase()} ${path} must be required: true`);
      }
    }
  }

  // Coverage over every service prefix is a public-spec rule. The admin contract grows
  // service by service (#212: one example route first), so it only checks what it declares.
  if (options.forbidAdmin !== false) {
    for (const prefix of servicePrefixes) {
      assert(
        pathNames.some((path) => path === prefix || path.startsWith(`${prefix}/`)),
        `Missing public routes for service prefix: ${prefix}`,
      );
    }
  }

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const value of node) visit(value);
      return;
    }

    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === '$ref' && typeof value === 'string') {
          refs.add(value);
        }
        visit(value);
      }
    }
  };

  visit(doc);

  for (const ref of refs) {
    if (!ref.startsWith('#/components/')) {
      throw new Error(`Unsupported $ref found in public OpenAPI: ${ref}`);
    }
    const segments = ref.replace('#/', '').split('/');
    let current: any = doc;
    for (const segment of segments) {
      if (current && typeof current === 'object' && segment in current) {
        current = current[segment];
      } else {
        throw new Error(`Broken $ref in public OpenAPI: ${ref}`);
      }
    }
  }

  assert(Array.isArray(doc.tags) && doc.tags.length >= (options.forbidAdmin === false ? 1 : servicePrefixes.length), 'Public OpenAPI must include service tags');
}


/**
 * The admin API contract (#212): `/api/admin/<service>/...` at the gateway,
 * `/admin/...` inside each service. Staff-only, bearer JWT with role ADMIN and
 * the `perms` claim; SYSTEM tokens answer 401. Kept out of the public spec.
 */
export function generateAdminOpenApiDocument() {
  const adminSpec = {
    openapi: '3.0.3',
    info: {
      title: 'Delivery Plus Admin API',
      version: '1.0.0',
      description:
        'Staff admin contract for the Delivery Plus platform (#212). Each service owns its own /admin routes; the gateway publishes them under /api/admin/<service>. Requires a staff JWT (role ADMIN) carrying the route\'s permissions; SYSTEM tokens are refused with 401. Every mutation requires a reason and goes through the audit hook (#213).',
    },
    servers: [{ url: 'http://localhost:3000' }],
    tags: ADMIN_SERVICE_DEFINITIONS.map(({ service }) => ({ name: service, description: `${service} admin endpoints` })),
    paths: {} as Record<string, Record<string, any>>,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            statusCode: { type: 'integer' },
            error: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  };

  for (const service of ADMIN_SERVICE_DEFINITIONS) {
    for (const route of service.routes) {
      const pathKey = joinPublicPath(service.publicPrefix, route.path);
      const operationId = `admin_${service.service}_${route.method}_${pathKey.replace(/[/:{}-]+/g, '_').replace(/^_+|_+$/g, '')}`;

      const pathParameters = extractPathParameters(pathKey).map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      }));
      const queryParameters = (route.query ?? []).map(({ name, description, schema }) => ({
        name,
        in: 'query',
        required: false,
        description,
        schema,
      }));
      const okSchema =
        route.response === 'paginated'
          ? {
              type: 'object',
              required: ['items', 'page', 'limit', 'total', 'totalPages'],
              properties: {
                items: { type: 'array', items: { type: 'object' } },
                page: { type: 'integer' },
                limit: { type: 'integer' },
                total: { type: 'integer' },
                totalPages: { type: 'integer' },
              },
            }
          : { type: 'object' };

      const operation: Record<string, any> = {
        summary: route.summary,
        description: `Requires staff permission: ${route.permissions.join(', ')}.`,
        tags: [service.service],
        operationId,
        security: [{ bearerAuth: [] }],
        'x-permissions': [...route.permissions],
        parameters: [...pathParameters, ...queryParameters],
        responses: {
          [String(route.statusCode)]: {
            description: route.response === 'paginated' ? 'A PaginatedResult<T>' : 'The resource',
            content: { 'application/json': { schema: okSchema } },
          },
          '400': { description: 'Invalid parameters or body', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
          '401': { description: 'Missing or invalid JWT, or a SYSTEM token on an admin route' },
          '403': { description: 'Staff token without the required permission' },
        },
      };
      if (route.requestBody) {
        operation.requestBody = { required: true, content: { 'application/json': { schema: route.requestBody } } };
      }
      if (route.auditAction) {
        operation['x-audit-action'] = route.auditAction;
      }
      if (route.readOnly) {
        operation['x-read-only'] = true;
      }

      if (!adminSpec.paths[pathKey]) {
        adminSpec.paths[pathKey] = {};
      }
      adminSpec.paths[pathKey][route.method] = operation;
    }
  }

  return adminSpec;
}

/** Same contract rules as the public spec, plus: every path is an /api/admin path. */
export function validateAdminOpenApiDocument(doc: Record<string, any>): void {
  validatePublicOpenApiDocument(doc, ADMIN_SERVICE_PREFIXES, { forbidAdmin: false });
  for (const [path, operations] of Object.entries(doc.paths as Record<string, Record<string, any>>)) {
    assert(path.startsWith('/api/admin/'), `Admin path must start with /api/admin/: ${path}`);
    for (const [method, operation] of Object.entries(operations)) {
      assert(
        Array.isArray(operation['x-permissions']) && operation['x-permissions'].length > 0,
        `Admin route must declare its staff permissions: ${method.toUpperCase()} ${path}`,
      );
      if (method !== 'get' && operation['x-read-only'] !== true) {
        const body = operation.requestBody?.content?.['application/json']?.schema;
        assert(
          Array.isArray(body?.required) && body.required.includes('reason'),
          `Admin mutation must require a reason (ADR 002): ${method.toUpperCase()} ${path}`,
        );
        assert(
          typeof operation['x-audit-action'] === 'string' && /^[a-z_]+(\.[a-z_]+)+$/.test(operation['x-audit-action']),
          `Admin mutation must name the audit action it records (#213): ${method.toUpperCase()} ${path}`,
        );
      }
    }
  }
}
