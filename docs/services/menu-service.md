# Menu Service

## Purpose
Owns menu categories, menu items, and restaurant menu availability logic.

## Main REST endpoints
From `services/menu-service/src/controllers/menu.controller.ts`:

- `POST /categories` – create a menu category (owner only)
- `GET /restaurants/:restaurantId/menu` – fetch a restaurant menu
- `GET /menu-items/:id` – fetch one menu item
- `POST /menu-items` – create a menu item (owner only)
- `PATCH /menu-items/:id` – update a menu item (owner only)
- `DELETE /menu-items/:id` – delete a menu item (owner only)
- `PATCH /menu-items/:id/availability` – toggle item availability (owner only)
- `POST /menu-items/:id/image-upload-url` – create a presigned item-image POST policy (restaurant owner only)
- `POST /menu-items/:id/image-confirm` – verify the uploaded image and save its public URL (restaurant owner only)

## Dependencies
- Calls `restaurant-service` to validate ownership via `src/common/restaurant-service.client.ts`
- Uses the shared S3 storage service for menu item image objects
- Stores menu data in PostgreSQL
- Used by `cart-service` during cart item validation through `menu-service.client.ts`

## Events published/consumed
- No Kafka events are published or consumed by this service.

## Required env vars
From `services/menu-service/src/config/app-config.ts`:

- `DATABASE_URL`
- `JWT_SECRET`
- `RESTAURANT_SERVICE_URL` (default: `http://localhost:3003`)
- `PORT` (default: `3004`)
- `NODE_ENV` (default: `development`)
- `AWS_REGION`, `AWS_S3_BUCKET`, and `AWS_PUBLIC_BASE_URL`; S3 endpoint and credentials are configurable for local MinIO or a cloud provider

## Notes
This service is a key dependency for carting and ordering because item availability and pricing are validated here.

Image uploads check ownership against the item’s stored `restaurantId`, then use `pending/restaurants/{restaurantId}/menu-items/{menuItemId}/` as the staging prefix. The five-minute presigned POST policy enforces a 10 MiB limit and exact content type. Confirmation validates the image bytes and copies them to a separate permanent key before updating the existing nullable `MenuItem.imageUrl` and invalidating menu caches. Staging objects expire after one day. The column already existed, so no menu-service schema migration was needed. Uploads accept JPEG, PNG, or WebP.
The create/update DTOs reject caller-supplied `imageUrl` values; only the verified confirmation flow can write that field.
