# Architecture

The platform is a NestJS 10 / TypeScript monorepo with one API Gateway and eleven domain services. Nine domain services own PostgreSQL databases; cart and tracking use Redis; the gateway owns no persistence. The `shared` workspace contains cross-cutting infrastructure, not business workflows.

```mermaid
graph TD
  Client --> Gateway[API Gateway :3000]
  Gateway --> Services[Domain services]
  Services --> Postgres[(PostgreSQL databases)]
  Services --> Redis[(Redis)]
  Order[Order service] -->|order.events| Kafka[(Kafka)]
  Payment[Payment service] -->|payment.events| Kafka
  Delivery[Delivery service] -. delivery.events wiring .-> Kafka
  Kafka --> Driver[Driver service]
  Kafka --> Notification[Notification service]
  Kafka --> Order
```

## Communication

- HTTP is used by the gateway and for synchronous service-to-service checks such as menu ownership, cart reads, order validation, and delivery updates.
- Kafka carries order, payment, and delivery event topics. Order and payment publication is implemented; delivery has event-building and Kafka wiring code, but its lifecycle methods currently do not invoke publication. Consumers retry locally up to three times, use an in-memory event-id set, and commit exhausted messages instead of writing to a real DLQ.
- Redis stores carts, cache entries, rate-limit state, and recent driver locations with a TTL.
- PostgreSQL stores credentials, profiles, restaurants, menu data, orders, payments, deliveries, drivers, and notifications. Docker initializes separate logical databases from `docker/postgres/init.sql`.
- User, restaurant, and menu services issue short-lived presigned POST policies for media; clients upload directly to S3-compatible object storage. The policies enforce upload-size limits, and the services verify object bytes before copying them from expiring staging keys to permanent public/CDN URLs. The dev and test Compose overlays use SeaweedFS's S3 gateway (service name `media-storage`), not MinIO; see `.project-context/15-media-and-storage.md` for why.

## Main Flow

1. A customer adds a menu item to the Redis cart.
2. Order Service validates the cart and restaurant, persists an order, clears the cart, and publishes order events.
3. Payment Service creates and processes a simulated payment, then publishes success or failure. Order Service consumes the result and changes order state.
4. A restaurant owner advances the order to preparation and pickup readiness. Delivery Service creates a delivery, assigns an available driver, and updates the order through HTTP clients.
5. Drivers report locations to Tracking Service, which stores the latest location in Redis. Tracking combines delivery data with the driver location.
6. Delivery completion updates delivery, order, and driver state through the implemented service calls. Delivery event publication is currently partial, so downstream event propagation should not be assumed for every lifecycle transition.

The current implementation does not provide a real payment provider, push/email delivery, durable Kafka idempotency store, or production dead-letter queue. Those are roadmap items.

## Media storage

Media bytes live in an S3-compatible bucket rather than service databases or application request bodies. The shared `S3StorageService` signs POST policies for JPEG, PNG, and WebP objects with a five-minute expiry and an enforced content-length range. Clients submit the returned fields as multipart form data. Confirmation validates the staged object bytes and copies them to a content-addressed permanent key before persisting a public/CDN URL; unconfirmed staging objects expire after one day.

Temporary objects use random keys beneath `pending/`; confirmed objects use content-addressed keys scoped by service-owned resources: `users/{userId}/avatar/{sha256}.{ext}`, `restaurants/{restaurantId}/{cover|logo}/{sha256}.{ext}`, and `restaurants/{restaurantId}/menu-items/{menuItemId}/{sha256}.{ext}`. User profiles and restaurants gained nullable URL columns; menu items reuse their existing nullable `imageUrl` column. See [project context: media and storage](../.project-context/15-media-and-storage.md) for the complete security and environment contract.
