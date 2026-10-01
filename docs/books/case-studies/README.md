# Case Studies

[Library index](../README.md)

Each case study takes one real problem in Delivery Plus. Most are bugs that have been found and fixed; some are still open or planned. Each one walks through the same questions:

**Symptom → Root cause → Why the naive version looked reasonable → Impact → Fix → Tests → Trade-offs → What can still go wrong → What a senior engineer would ask.**

Status tags: **CURRENT** (fixed and in the code), **PARTIAL** (partly addressed), **OPEN** (a known defect, not fixed), **PLANNED** (designed or tracked in an issue, not built), **FUTURE** (a design exercise).

| # | Case study | Status | Main books |
| --- | --- | --- | --- |
| 01 | [Failed-payment race](01-failed-payment-race.md) | CURRENT | 08, 09, 25 |
| 02 | [Delivery ownership bug](02-delivery-ownership-bug.md) | CURRENT | 17, 10 |
| 03 | [Public driver endpoint](03-public-driver-endpoint.md) | CURRENT | 17, 03 |
| 04 | [Notification ownership](04-notification-ownership.md) | CURRENT | 17, 04 |
| 05 | [Rate-limit mismatch](05-rate-limit-mismatch.md) | CURRENT | 06, 11, 17 |
| 06 | [In-memory idempotency](06-in-memory-idempotency.md) | CURRENT | 07, 08 |
| 07 | [DLQ implementation](07-dlq-implementation.md) | CURRENT | 07, 26 |
| 08 | [Delivery lifecycle events](08-delivery-lifecycle-events.md) | CURRENT | 07, 09, 10 |
| 09 | [Driver availability lifecycle](09-driver-availability-lifecycle.md) | PARTIAL | 09, 10, 23 |
| 10 | [Order-to-delivery lookup](10-order-to-delivery-lookup.md) | CURRENT | 10, 03 |
| 11 | [Customer delivery polling](11-customer-delivery-polling.md) | CURRENT | 22, 21 |
| 12 | [Future WebSocket tracking](12-future-websocket-tracking.md) | FUTURE | 22, 24 |
| 13 | [Transactional outbox](13-transactional-outbox.md) | PLANNED | 08, 27 |
| 14 | [S3 presigned uploads](14-s3-presigned-uploads.md) | CURRENT | 17, 03 |
| 15 | [E2E environment](15-e2e-environment.md) | CURRENT | 13, 14 |
| 16 | [Kafka replay](16-kafka-replay.md) | CURRENT | 07, 26 |
| 17 | [Consumer lag](17-consumer-lag.md) | PARTIAL | 07, 20 |
| 18 | [System token](18-system-token.md) | CURRENT (weakness) | 17, 10 |
| 19 | [Driver dispatch](19-driver-dispatch.md) | PARTIAL | 23, 24 |
| 20 | [Nearest-driver search](20-nearest-driver-search.md) | FUTURE | 23, 02 |
| 21 | [Self-registered admin](21-self-registered-admin.md) | CURRENT (fixed, PR #105; was critical) | 17 |

## How to use them

1. Read the **Symptom** and stop. Write down what you would check first.
2. Read the code it points to *before* the root-cause section.
3. Compare your reasoning with the **Root cause** and **Fix**.
4. Answer the **What a senior engineer would ask** questions in writing. They are also checkpoint material ([checkpoints](../checkpoints.md)).

Paths are relative to the `delivery-plus` repository root unless they start with `delivery-plus-customer-app/`.
