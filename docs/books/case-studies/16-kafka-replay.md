# Case Study 16 — Kafka Replay

**Status: CURRENT (`npm run kafka:dlq`, commit `f4ac451`)** · [Case studies](README.md) · Books: [07](../07-kafka.md), [26](../26-reliability-engineering.md) · Labs: [KF-08](../labs/kafka-labs.md#kf-08-replay-by-rewinding-offsets), [KF-10](../labs/kafka-labs.md#kf-10-handler-failure-dlq-and-replay)

## The situation

A bug in order-service's `payment.completed` handler ships. For 20 minutes, every payment-completed event fails three times and lands in `payment.events.dlq` ([case study 07](07-dlq-implementation.md)). The fix is deployed. Now what?

## Two kinds of replay

| | DLQ replay (`npm run kafka:dlq -- <topic> --replay`) | Offset rewind (`kafka-consumer-groups --reset-offsets`) |
| --- | --- | --- |
| What is re-run | only dead-lettered messages | **everything** after the chosen offset, for one group |
| Who sees it | republished to the original topic, so **every** group sees it; groups that already handled it skip it through durable idempotency | only the rewound group |
| Needs | the fix deployed; the DLQ still retained | the group stopped (no graceful shutdown: wait ~30 s for `Empty`); idempotency markers not expired |
| Risk | low: duplicates are skipped | high if handlers aren't idempotent or markers have expired (7 days) |

## How the DLQ replay works (`scripts/kafka-dlq.ts`)

- Without `--replay`, the script is **read-only**: it lists pending dead letters with their `dlq-*` headers.
- With `--replay`, each message is republished to `dlq-original-topic` with its **original key, value and headers**. The same `orderId` key means the same partition and the same per-order ordering.
- Progress is tracked by its own consumer group (`delivery-plus-dlq-replay`), so each dead letter is replayed **once**.
- Unparseable messages can't be replayed. They are listed, and marked as seen on `--replay`.
- When the consumer dead-lettered the message, it **released** the failed group's idempotency claim. That's what lets the replay run the handler again in the group that failed, while groups that succeeded skip the message.

## Why it works: the preconditions

1. Deterministic event IDs (the same event keeps the same ID).
2. Durable per-group idempotency in Redis, persisted with AOF.
3. Handlers that tolerate late or stale events: CAS writes and `syncStatusFromEvent` skip.

Remove any one of these and replay becomes dangerous.

## What can still go wrong

- **Replaying old events into a newer world.** A `payment.completed` from 20 minutes ago arrives after the customer cancelled. The stale-event skip handles order status, but a handler that *sends money* or *notifies* would need its own check.
- **Retention.** If `.dlq` retention is shorter than your detection time, the messages are gone (`docs/deployment.md`: keep DLQs at least as long as source topics).
- **Marker expiry.** Replaying something older than 7 days re-runs handlers in groups that had succeeded.
- **Replaying before the fix** sends the messages straight back to the DLQ. That's harmless, but noisy.

## What a senior engineer would ask

1. Write the runbook: detect → stop the bleeding → fix → verify on one message → replay all → confirm DLQ empty → postmortem.
2. How do you replay **one** message to test the fix first?
3. Who is allowed to run `--replay` in production, and is it audited?
4. When would you choose an offset rewind instead (for example, a bug that silently *succeeded* with wrong results)?
