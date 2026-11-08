# Restaurant Service

## Purpose
Maintains restaurant records, status, and ownership checks for menu and ordering flows.

## Main REST endpoints
From `services/restaurant-service/src/controllers/restaurants.controller.ts`:

- `POST /restaurants` – create your restaurant as a draft application (owner only; one per owner, #208)
- `GET /restaurants` – list approved restaurants (public, paginated/filterable)
- `GET /restaurants/me` – the owner's restaurants with the application status, private details and latest review (owner only)
- `GET /restaurants/:id` – fetch an approved restaurant by ID (404 for one not approved)
- `PATCH /restaurants/:id` – update restaurant and application details (owner only; see "Applications")
- `POST /restaurants/:id/submit` – send the application for review, or resubmit a rejected one (owner only)
- `GET /restaurants/:id/application` – the application with its review history (staff with `onboarding.review`)
- `POST /restaurants/:id/review` – approve or reject a submitted application (staff with `onboarding.review`)
- `PATCH /restaurants/:id/status` – update status (owner or admin; an owner opens only an approved restaurant)
- `PATCH /restaurants/:id/delivery-radius` – set the delivery radius in kilometers (admin only; staff permission support arrives with #212)
- `GET /restaurants/:id/ownership/:userId` – internal ownership verification used by menu-service and order-service; requires the shared HMAC internal-auth guard and Redis nonce replay protection
- `POST /restaurants/:id/image-upload-url` – create a presigned cover/logo POST policy (owner only)
- `POST /restaurants/:id/image-confirm` – verify the uploaded cover/logo and save its public URL (owner only)

## Dependencies
- Uses PostgreSQL for restaurant data
- Uses the shared S3 storage service for restaurant cover and logo objects
- `menu-service` and `order-service` check ownership via this service using signed HMAC internal-auth requests
- Reads the restaurant's public menu from `menu-service` (`MENU_SERVICE_URL`) when an application is submitted or approved (#208)
- No Kafka usage is implemented here

## Events published/consumed
- No Kafka events are published or consumed by this service.

## Required env vars
From `services/restaurant-service/src/config/app-config.ts`:

- `DATABASE_URL`
- `JWT_SECRET`
- `PORT` (default: `3003`)
- `NODE_ENV` (default: `development`)
- `INTERNAL_AUTH_SECRET` (required in production; local Compose provides a default)
- `INTERNAL_AUTH_ALLOWED_SERVICES` or legacy `INTERNAL_AUTH_ALLOWED_SERVICE` (comma-delimited trusted internal callers; default: `menu-service,order-service`)
- `DEFAULT_DELIVERY_RADIUS_KM` (default: `5`; must be greater than 0 and no more than 50)
- `MENU_SERVICE_URL` (default: `http://localhost:3004`; #208, the submit and approval menu check)
- `AWS_REGION`, `AWS_S3_BUCKET`, and `AWS_PUBLIC_BASE_URL`; S3 endpoint and credentials are configurable for the local media-storage service (SeaweedFS's S3 gateway) or a cloud provider

## Notes
The service enforces restaurant ownership rules and is a central dependency for menu and order flows.

Only the restaurant owner can request or confirm an image upload. The five-minute presigned POST policy enforces a 10 MiB limit and exact content type. Confirmation validates the staging key under `pending/restaurants/{restaurantId}/{cover|logo}/`, checks the image bytes, and copies it to a separate permanent key before persisting `coverImageUrl` or `logoUrl`; both nullable columns are added by a forward TypeORM migration. Staging objects expire after one day.

Public restaurant reads are intentionally DTO-stripped to prevent leaking `ownerId` or other management metadata. `GET /restaurants/me` returns only the currently authenticated owner’s restaurants. The `GET /restaurants/:id/ownership/:userId` route is internal-only: the API Gateway blocks public probes, and restaurant-service still rejects unauthenticated, untrusted, expired, or replayed HMAC-signed requests before asserting ownership.

Restaurants may have a latitude/longitude pair; both values must be supplied together and fall within valid coordinate ranges. Restaurant owners can set or update the pair, but only admins can override `deliveryRadiusKm` (0.01–50 km). A null stored radius uses `DEFAULT_DELIVERY_RADIUS_KM`; public restaurant DTOs expose the effective radius. The database migration keeps existing restaurant coordinates and overrides null.

`GET /restaurants?lat=<latitude>&lng=<longitude>` filters to located restaurants whose configured (or default) radius covers the requested point, orders by straight-line distance and stable restaurant id, and returns `distanceKm` for each result. Without both query parameters, the existing list filters, sort and pagination behavior is unchanged. Delivery fee remains flat; list distance does not price delivery. Optional polygons and city service areas are out of scope.

## Applications and approval (#208)

The business rules are in [restaurant-onboarding.md](../business/restaurant-onboarding.md). How the service applies them:

- **`approvalStatus`** (`DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED`, a CHECK) is a column separate from the operating `status`. Migration 005 adds it with `APPROVED` for every existing row, then makes `DRAFT` the default for new ones.
- **Application fields** (all nullable): `legalName`, `commercialRegistrationNumber`, `taxCardNumber`, `contactPhone` (an Egyptian mobile stored as E.164 by the shared `EgyptianMobile` rule, and a CHECK), `cuisineTags` (up to 5, a CHECK), plus `submittedAt`, `approvedAt` and `approvalNote`. They are sent with create or `PATCH /restaurants/:id`; a blank optional value clears it.
- **One restaurant per owner:** `createForOwner` takes a Postgres advisory lock per owner and counts the owner's restaurants in the same transaction, so two creates at once can't both pass. No unique index: owners from before #208 may have several.
- **Customers see only APPROVED restaurants:** the list query filters on it, and `GET /restaurants/:id` answers 404 for any other state. order-service also refuses a restaurant whose `approvalStatus` isn't APPROVED (defense in depth; a missing field from an older version counts as approved).
- **Opening:** the owner's status write is one compare-and-set that, for `OPEN` and `BUSY`, also needs `approvalStatus = 'APPROVED'` at write time (`409 RestaurantNotApproved`, with `details.approvalStatus`). `CLOSED` stays allowed. The admin route is unchanged.
- **Editing** is a compare-and-set on the approval status: legal details only in `DRAFT` or `REJECTED`; name, address and location in anything but `SUBMITTED`; everything else any time. A refusal is `409 ApplicationNotEditable` with `details.approvalStatus` and `details.fields`.
- **Submit** (`DRAFT` or `REJECTED` → `SUBMITTED`, compare-and-set) needs the legal name, the contact phone, both coordinates, and from menu-service at least one category and one available item. Otherwise `422 ApplicationIncomplete` with `details.missing` (`legalName`, `contactPhone`, `location`, `menuCategory`, `availableMenuItem`). It clears the previous note.
- **Review** (`POST /restaurants/:id/review`, `{ decision: APPROVED | REJECTED, note?, submittedAt }`): under a row lock, only a `SUBMITTED` restaurant with exactly that `submittedAt` is decided, so a resubmission and a decision never interleave and of two racing reviewers one wins (`409 ApplicationNotInReview` otherwise). A rejection needs a note; an approval re-checks the submit requirements (`422`). The same decision repeated on the same submission is a no-op. Each decision is a row in `restaurant_reviews` (reviewer, decision, note, the submission, time), append-only through an `UPDATE` trigger and deleted only with the restaurant. The owner sees the latest as `approvalNote` and `lastReview`, never the reviewer; staff get the whole history with the owner id.
- Not here yet: the review queue listing (#214), notifying the owner (#215), the audit event (#213).

