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
      { method: 'post', path: '/login', summary: 'Login and receive a JWT', auth: false, statusCode: 200 },
      { method: 'post', path: '/verify-email', summary: 'Verify an email address with a token', auth: false, statusCode: 200 },
      { method: 'post', path: '/resend-verification', summary: 'Resend email verification', auth: false, statusCode: 200 },
      { method: 'get', path: '/me', summary: 'Get the current authenticated user', auth: true, statusCode: 200 },
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
    ],
  },
  {
    service: 'restaurants',
    publicPrefix: '/api/restaurants',
    routes: [
      { method: 'post', path: '', summary: 'Create a restaurant', auth: true, statusCode: 201 },
      { method: 'get', path: '', summary: 'List restaurants', auth: false, statusCode: 200 },
      { method: 'get', path: '/me', summary: 'List restaurants owned by the current restaurant owner', auth: true, statusCode: 200 },
      { method: 'get', path: '/:id', summary: 'Get a restaurant by id', auth: false, statusCode: 200 },
      { method: 'patch', path: '/:id', summary: 'Update restaurant details', auth: true, statusCode: 200 },
      { method: 'patch', path: '/:id/status', summary: 'Update restaurant status', auth: true, statusCode: 200 },
      { method: 'post', path: '/:id/image-upload-url', summary: 'Create a presigned restaurant image upload URL', auth: true, statusCode: 201 },
      { method: 'post', path: '/:id/image-confirm', summary: 'Confirm and save a restaurant image', auth: true, statusCode: 201 },
    ],
  },
  {
    service: 'menus',
    publicPrefix: '/api/menus',
    routes: [
      { method: 'post', path: '/categories', summary: 'Create a menu category', auth: true, statusCode: 201 },
      { method: 'get', path: '/restaurants/:restaurantId/menu', summary: 'List menu categories and items for a restaurant', auth: false, statusCode: 200 },
      { method: 'get', path: '/menu-items/:id', summary: 'Get a menu item by id', auth: false, statusCode: 200 },
      { method: 'post', path: '/menu-items', summary: 'Create a menu item', auth: true, statusCode: 201 },
      { method: 'patch', path: '/menu-items/:id', summary: 'Update a menu item', auth: true, statusCode: 200 },
      { method: 'delete', path: '/menu-items/:id', summary: 'Delete a menu item', auth: true, statusCode: 200 },
      { method: 'patch', path: '/menu-items/:id/availability', summary: 'Update menu item availability', auth: true, statusCode: 200 },
      { method: 'post', path: '/menu-items/:id/image-upload-url', summary: 'Create a presigned menu item image upload URL', auth: true, statusCode: 201 },
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
      { method: 'post', path: '/:id/refund', summary: 'Refund a payment (support/admin only)', auth: true, statusCode: 201 },
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
      { method: 'post', path: '/:id/cancel', summary: 'Cancel a delivery', auth: true, statusCode: 201 },
      { method: 'get', path: '/me/current', summary: "Get the calling driver's active delivery (204 when none)", auth: true, statusCode: 200 },
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
      { method: 'post', path: '/me/online', summary: 'Go online', auth: true, statusCode: 201 },
      { method: 'post', path: '/me/offline', summary: 'Go offline', auth: true, statusCode: 201 },
      { method: 'post', path: '/me/status', summary: 'Set driver status explicitly', auth: true, statusCode: 201 },
      { method: 'get', path: '/available', summary: 'List available drivers (admin/system only)', auth: true, statusCode: 200 },
      { method: 'get', path: '/:id', summary: 'Get a driver by id (self or admin)', auth: true, statusCode: 200 },
      { method: 'patch', path: '/:id/status', summary: 'Set a driver status as admin', auth: true, statusCode: 200 },
    ],
  },
  {
    service: 'tracking',
    publicPrefix: '/api/tracking',
    routes: [
      { method: 'post', path: '/location', summary: 'Report the current driver location', auth: true, statusCode: 201 },
      { method: 'get', path: '/driver/:userId', summary: 'Get a driver location by user id', auth: true, statusCode: 200 },
      { method: 'get', path: '/delivery/:deliveryId', summary: 'Get combined delivery tracking', auth: true, statusCode: 200 },
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
  LoginRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', format: 'password' },
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
    },
  },
  VerifyEmailRequest: {
    type: 'object',
    required: ['email', 'token'],
    properties: {
      email: { type: 'string', format: 'email' },
      token: { type: 'string' },
    },
  },
  ResendVerificationRequest: {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', format: 'email' },
    },
  },
  AuthResponse: {
    type: 'object',
    required: ['accessToken', 'userId', 'email', 'role'],
    properties: {
      accessToken: { type: 'string' },
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

      if (route.method === 'get' && service.service === 'deliveries' && route.path === '/me/current') {
        operation.responses['200'] = {
          description: "The calling driver's active delivery (DRIVER role only)",
          content: { 'application/json': { schema: { $ref: '#/components/schemas/DriverCurrentDelivery' } } },
        };
        operation.responses['204'] = { description: 'No active delivery (or no driver profile yet)' };
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
          description: 'Registration successful',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } },
          },
        };
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
      }

      if (route.method === 'post' && service.service === 'auth' && route.path === '/resend-verification') {
        operation.requestBody = {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ResendVerificationRequest' } },
          },
        };
        operation.responses[String(route.statusCode || 200)] = {
          description: 'Verification email queued or resent',
          content: {
            'application/json': { schema: { type: 'object', properties: { message: { type: 'string' } } } },
          },
        };
      }

      if (!publicSpec.paths[pathKey]) {
        publicSpec.paths[pathKey] = {};
      }

      publicSpec.paths[pathKey][route.method] = operation;
    }
  }

  return publicSpec;
}

export function validatePublicOpenApiDocument(doc: Record<string, any>, servicePrefixes: readonly string[] = SERVICE_PREFIXES): void {
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

  for (const prefix of servicePrefixes) {
    assert(
      pathNames.some((path) => path === prefix || path.startsWith(`${prefix}/`)),
      `Missing public routes for service prefix: ${prefix}`,
    );
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

  assert(Array.isArray(doc.tags) && doc.tags.length >= servicePrefixes.length, 'Public OpenAPI must include service tags');
}
