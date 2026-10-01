# Case Study 07 — DLQ Implementation

**Status: CURRENT (commits `8adecc7`, `f4ac451`, `9f09b07`)** · [Case studies](README.md) · Books: [07](../07-kafka.md), [26](../26-reliability-engineering.md) · Labs: [KF-09](../labs/kafka-labs.md#kf-09-poison-message-to-the-dlq), [KF-10](../labs/kafka-labs.md#kf-10-handler-failure-dlq-and-replay)

## Symptom (before)

Two failure modes, both bad:
- A message that a handler could never process (a poison message: unparseable, or a handler bug for one specific payload) either **blocked its partition forever**, because the consumer retried it endlessly, or
- was **skipped silently**, because the error was swallowed and the offset committed. The event was lost with no record.

## Root cause

The shared consumer had no policy for "this message has failed N times". With one partition per topic, a single stuck message stops *every* order's events.

## Why the naive version looked reasonable

- In development, handlers rarely fail, and when they do, a developer restarts the service.
- "Just log and continue" keeps the pipeline moving and looks robust.

## Impact

- **Head-of-line blocking:** one bad event freezes order or notification processing for everyone.
- **Silent loss:** a skipped `payment.completed` leaves an order unconfirmed, with no trace.

## Fix

In `shared/src/kafka/kafka-consumer.service.ts`:
- A handler is tried `maxHandlerAttempts` times (default **3**, configurable), with exponential backoff.
- After that, the message is published to **`<topic>.dlq`** with `dlq-*` headers: original topic, partition and offset, consumer group, reason, error, and failure time.
- Unparseable messages go straight to the DLQ.
- The idempotency claim is **released**, so a later replay can run the handler.
- The offset is committed only after a successful DLQ send. If the DLQ send or Redis fails, the offset stays uncommitted and the message will be redelivered.
- `subscribe()` creates the `.dlq` topic too.
- `npm run kafka:dlq -- <topic> [--replay]` (`scripts/kafka-dlq.ts`) lists and replays dead letters ([case study 16](16-kafka-replay.md)).

## Tests

- `shared/src/kafka/kafka-consumer.service.spec.ts` covers:
  - retries then DLQ;
  - unparseable → DLQ;
  - DLQ send failure → no commit;
  - the claim is released after dead-lettering.
- Live: [KF-09](../labs/kafka-labs.md#kf-09-poison-message-to-the-dlq) (poison message) and [KF-10](../labs/kafka-labs.md#kf-10-handler-failure-dlq-and-replay) (handler failure → DLQ → fix → replay).

## Trade-offs

- **Ordering.** Dead-lettering message N lets N+1 for the same order be processed first. Lifecycle events tolerate this (stale events are skipped and CAS writes protect state), but not every domain would.
- **Retry budget.** Three in-process attempts handle blips, not outages. A down dependency sends everything to the DLQ quickly. That is visible and replayable, which is better than blocking.
- One DLQ per source topic, shared by all consumer groups; the `dlq-consumer-group` header tells you whose handler failed.

## What can still go wrong

- **Nobody watches the DLQ.** There is no metric or alert on DLQ depth yet ([case study 17](17-consumer-lag.md), [Book 20](../20-observability.md)). A DLQ that nobody reads is silent loss with extra steps.
- **Retention.** Keep `.dlq` topics at least as long as source topics (`docs/deployment.md`).
- **Replaying before fixing the cause** dead-letters the message again.

## What a senior engineer would ask

1. Which errors are *retryable* (timeouts) and which are *permanent* (validation)? Should permanent ones skip the retries?
2. Who gets paged when DLQ depth > 0, and what is their runbook?
3. If a payment event sits in the DLQ for six hours, what does the customer see?
4. Why release the idempotency claim on dead-letter? What would break if you didn't?
