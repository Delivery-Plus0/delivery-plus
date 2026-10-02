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
  Delivery[Delivery service] -->|delivery.events| Kafka
  Kafka --> Notification[Notification service]
  Kafka --> Order
  Services -->|user, restaurant, menu media| S3[(S3-compatible storage)]
  Client -.->|presigned POST upload| S3
```

Every service image is built from the root `Dockerfile` on `node:22-alpine`. For a status snapshot of what is implemented, partial, and missing, see [project context: current state](../.project-context/16-current-state.md).

## Communication

- HTTP is used by the gateway and for synchronous service-to-service checks such as menu ownership, cart reads, order validation, and delivery updates.
- Kafka carries order, payment, and delivery event topics, all keyed by `orderId`. Consumers deduplicate per consumer group in Redis (`DurableEventIdempotencyService`), retry a handler up to three times, then send the message to `<topic>.dlq`; `npm run kafka:dlq` lists and replays dead-lettered messages. Publication happens after each service's database write, without a transactional outbox.
- Redis stores carts, cache entries, rate-limit state, internal-auth nonces, and recent driver locations with a TTL.
- PostgreSQL stores credentials, profiles, restaurants, menu data, orders, payments, deliveries, drivers, and notifications. Docker initializes separate logical databases from `docker/postgres/init.sql`.
- User, restaurant, and menu services issue short-lived presigned POST policies for media; clients upload directly to S3-compatible object storage. The policies enforce upload-size limits, and the services verify object bytes before copying them from expiring staging keys to permanent public/CDN URLs. The dev and test Compose overlays use SeaweedFS's S3 gateway (service name `media-storage`), not MinIO; see `.project-context/15-media-and-storage.md` for why.

## Main Flow

1. A customer adds a menu item to the Redis cart.
2. Order Service validates the cart and restaurant, persists an order, clears the cart, and publishes order events.
3. Payment Service creates and processes a simulated payment, then publishes success or failure. Order Service consumes the result and changes order state.
4. A restaurant owner advances the order to preparation and pickup readiness. Delivery Service consumes `order.ready_for_pickup`, creates the delivery and assigns an available driver by itself (automatic dispatch; a delivery with no free driver waits and is retried), and updates the order through HTTP clients. The driver finds the job with `GET /deliveries/me/current`, including the drop-off address the order copied at checkout.
5. Drivers report locations to Tracking Service, which stores the latest location in Redis. Tracking combines delivery data with the driver location.
6. Delivery completion updates delivery, order, and driver state through the implemented service calls, and every delivery transition is published to `delivery.events` (order-service converges from them).

The current implementation does not provide a real payment provider, push/email delivery, or a transactional outbox for Kafka events. Those are roadmap items.

## Media storage

Media bytes live in an S3-compatible bucket rather than service databases or application request bodies. The shared `S3StorageService` signs POST policies for JPEG, PNG, and WebP objects with a five-minute expiry and an enforced content-length range. Clients submit the returned fields as multipart form data. Confirmation validates the staged object bytes and copies them to a content-addressed permanent key before persisting a public/CDN URL; unconfirmed staging objects expire after one day.

Temporary objects use random keys beneath `pending/`; confirmed objects use content-addressed keys scoped by service-owned resources: `users/{userId}/avatar/{sha256}.{ext}`, `restaurants/{restaurantId}/{cover|logo}/{sha256}.{ext}`, and `restaurants/{restaurantId}/menu-items/{menuItemId}/{sha256}.{ext}`. User profiles and restaurants gained nullable URL columns; menu items reuse their existing nullable `imageUrl` column. See [project context: media and storage](../.project-context/15-media-and-storage.md) for the complete security and environment contract.
