# Case Study 17 — Consumer Lag

**Status: PARTIAL (lag is observable by hand; no metrics or alerts)** · [Case studies](README.md) · Books: [07](../07-kafka.md), [20](../20-observability.md) · Lab: [KF-06](../labs/kafka-labs.md#kf-06-consumer-lag)

## Symptom (a scenario you can reproduce)

Customers say "payment went through but my order still says *Payment pending*" for minutes. Every service is healthy and nothing is in the logs.

## Root cause candidates

**Lag** = the newest offset in the partition minus the group's committed offset. It grows when consumption is slower than production, or stops. In Delivery Plus:

| Cause | Why it applies here |
| --- | --- |
| **one partition per topic** | a consumer group can use at most one consumer per partition, so adding replicas doesn't add throughput |
| slow handler | each handler makes synchronous HTTP calls and Redis round trips (idempotency acquire and mark) |
| retries with backoff | a failing message holds its partition through 3 attempts before being dead-lettered |
| Redis unavailable | the offset is deliberately not committed; processing stalls (correctness over availability, [case study 06](06-in-memory-idempotency.md)) |
| rebalance storms | consumers restarting without graceful shutdown (#7) leave the group stuck for ~30 s each time |

## How to see it today

```bash
kcg --describe --group order-service-group     # LAG column per partition (alias from the lab README)
```
Or use kafka-ui on `:8085`. **No service exports lag, and no alert exists.** You find out from customers.

## What good looks like (PLANNED, Book 20)

- Export per-group, per-partition lag (from a Kafka exporter or the consumer itself) as a metric.
- Alert on **lag growing for N minutes**, not on a fixed number. A burst is fine; steady growth is not.
- Alert on **DLQ depth > 0**.
- Add the **age of the oldest unprocessed message** (time lag). It is closer to what the customer feels than a message count.
- Dashboards: production rate and consumption rate side by side.

## Fixes by cause

- **More partitions** plus more consumer replicas. Keys stay `orderId`, so per-order ordering holds. Changing the partition count remaps keys, so plan it ([ADR 0004](../adrs/0004-orderid-partition-key.md)).
- Faster handlers: fewer synchronous calls, batch idempotency checks.
- Separate consumer groups for slow side effects (notifications) and critical state (orders), which is already the case.

## What a senior engineer would ask

1. What's the SLO: "an order reflects payment within 30 s for 99% of orders"? How do you measure it end to end?
2. If lag is 10,000 and growing, what do you do in the first 5 minutes?
3. How many partitions should `order.events` have, and how did you decide?
4. Why is "lag in messages" a weak signal on its own?
