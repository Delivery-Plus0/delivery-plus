# Teaching ADRs

[Library index](../README.md)

An **Architecture Decision Record** captures one decision: its context, the choice, the alternatives and the consequences. It is written so a future engineer understands *why* without having to ask.

The project's official ADRs live in [`docs/adr/`](../../adr/README.md). Today that folder has one, [ADR 001: Internal Service Authentication](../../adr/001-internal-service-authentication.md), and a template.

The ADRs in this folder are **teaching ADRs**:
- **Reconstructed** (0001–0009): the decision is already in the code but was never written down. Each one records what the code does and the reasoning that best explains it. Where the original motive is unknown, the ADR says so instead of inventing a history.
- **Proposed** (0010): not implemented; tracked in an issue.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-kafka-for-lifecycle-events.md) | Kafka for order, payment and delivery lifecycle events | Accepted (reconstructed) |
| [0002](0002-redis-for-carts.md) | Carts live in Redis, not PostgreSQL | Accepted (reconstructed) |
| [0003](0003-redis-for-current-location.md) | Driver's current location in Redis with a TTL | Accepted (reconstructed) |
| [0004](0004-orderid-partition-key.md) | Every event keyed by `orderId` | Accepted (reconstructed) |
| [0005](0005-polling-before-websockets.md) | Customer app polls; no WebSockets yet | Accepted (reconstructed) |
| [0006](0006-no-deliveryid-on-order.md) | Orders don't store `deliveryId`; look up by order | Accepted (reconstructed) |
| [0007](0007-presigned-s3-uploads.md) | Media through presigned POST to S3-compatible storage | Accepted (reconstructed) |
| [0008](0008-payment-state-ownership.md) | Payment-service owns payment state; order status converges by CAS | Accepted (reconstructed) |
| [0009](0009-delivery-ownership-enforcement.md) | Delivery access delegated to order-service ownership | Accepted (reconstructed) |
| [0010](0010-transactional-outbox.md) | Transactional outbox for events | **Proposed** (#98) |

## Exercise

Pick one teaching ADR and argue the opposite decision in writing. Then list what would have to be true for your alternative to win. That habit is what [Book 29](../29-senior-engineering-judgment.md) is about.

When a teaching ADR is adopted by the team, copy it into `docs/adr/` with the next number and the template's format.
