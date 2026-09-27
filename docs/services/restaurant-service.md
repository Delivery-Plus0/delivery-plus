# Restaurant Service

## Purpose
Maintains restaurant records, status, and ownership checks for menu and ordering flows.

## Main REST endpoints
From `services/restaurant-service/src/controllers/restaurants.controller.ts`:

- `POST /restaurants` – create a restaurant (owner only)
- `GET /restaurants` – list restaurants (public, paginated/filterable)
- `GET /restaurants/:id` – fetch a restaurant by ID
- `PATCH /restaurants/:id` – update restaurant details (owner only)
- `PATCH /restaurants/:id/status` – update status (owner or admin)
- `GET /restaurants/:id/ownership/:userId` – internal ownership verification used by menu-service
- `POST /restaurants/:id/image-upload-url` – create a presigned cover/logo POST policy (owner only)
- `POST /restaurants/:id/image-confirm` – verify the uploaded cover/logo and save its public URL (owner only)

## Dependencies
- Uses PostgreSQL for restaurant data
- Uses the shared S3 storage service for restaurant cover and logo objects
- `menu-service` checks ownership via this service
- No Kafka usage is implemented here

## Events published/consumed
- No Kafka events are published or consumed by this service.

## Required env vars
From `services/restaurant-service/src/config/app-config.ts`:

- `DATABASE_URL`
- `JWT_SECRET`
- `PORT` (default: `3003`)
- `NODE_ENV` (default: `development`)
- `AWS_REGION`, `AWS_S3_BUCKET`, and `AWS_PUBLIC_BASE_URL`; S3 endpoint and credentials are configurable for local MinIO or a cloud provider

## Notes
The service enforces restaurant ownership rules and is a central dependency for menu and order flows.

Only the restaurant owner can request or confirm an image upload. The five-minute presigned POST policy enforces a 10 MiB limit and exact content type. Confirmation validates the staging key under `pending/restaurants/{restaurantId}/{cover|logo}/`, checks the image bytes, and copies it to a separate permanent key before persisting `coverImageUrl` or `logoUrl`; both nullable columns are added by a forward TypeORM migration. Staging objects expire after one day.
