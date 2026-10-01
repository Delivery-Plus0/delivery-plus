# Book 25 — Payment Systems

[Library index](README.md) · Previous: [Book 24](24-system-design.md) · Next: [Book 26 — Reliability Engineering](26-reliability-engineering.md)

**Level:** Advanced · **Prerequisites:** [Book 04 Ch. 6](04-database-fundamentals.md#chapter-6--concurrency-control-locks-cas-lost-updates-and-deadlocks), [Book 08](08-idempotency-and-distributed-operations.md).

Payments are where distributed-systems mistakes cost money. Delivery Plus has a **simulated** payment provider wrapped in a carefully engineered state machine. This book dissects it and then evolves it, step by step, towards a real payment gateway.

**What exists — CURRENT** (`services/payment-service/`):
| Endpoint | Who | What |
| --- | --- | --- |
| `POST /api/payments` (`Idempotency-Key`) | customer who owns the order | creates a `PENDING` payment for an order in `CREATED`; order → `PAYMENT_PENDING` |
| `POST /api/payments/:id/process` `{ simulateFailure? }` | owner | `PENDING → PROCESSING → COMPLETED/FAILED`; order → `CONFIRMED`/`FAILED` |
| `GET /api/payments/:id` | owner or admin | status |
| `POST /api/payments/:id/refund` | **admin only** | `COMPLETED → REFUNDED` (no event, no order change) |

Simulation: `simulateFailure: true` → decline, `false` → success, omitted → `Math.random() < PAYMENT_SUCCESS_RATE` (default 0.9; 1 in the E2E stack).

---

## Chapter 1 — The payment lifecycle and its state machine

### 1. Why this exists
A payment passes through states that external systems observe (the customer, the order, the bank). Each transition must happen once and in order.

### 2. Core concept — real-world card lifecycle
```text
created ─► authorized (funds reserved) ─► captured (money moved) ─► settled ─► (refunded / partially refunded / charged back)
        └► declined                     └► voided (authorization released)
```
Food delivery usually **authorizes at checkout** and **captures at delivery or dispatch** (the final amount can change, e.g. a sold-out item).

### 3. Mental model — the payment row is the source of truth; every external effect is derived from its status.

### 4. Delivery Plus mapping — **CURRENT**
- States: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `REFUNDED` (`payment_status` enum; `PAYMENT_TRANSITIONS` in `shared/src/types/enums.ts`): PENDING → PROCESSING/FAILED; PROCESSING → COMPLETED/FAILED; COMPLETED → REFUNDED.
- No authorization/capture split: "COMPLETED" means "charged" in the simulator.
- Effects per status (`SIDE_EFFECTS` in `services/payment-service/src/services/payments.service.ts`): PENDING → `payment.created` + order `PAYMENT_PENDING`; COMPLETED → `payment.completed` + order `CONFIRMED`; FAILED → `payment.failed` + order `FAILED`; PROCESSING and REFUNDED → none.

### 5. Example — a decline end to end: process with `simulateFailure: true` → CAS PENDING→PROCESSING → CAS PROCESSING→FAILED with `failureReason: 'Simulated payment decline'` → publish `payment.failed` → sync order to FAILED → order-service's consumer receives `payment.failed` and finds the order already FAILED (no-op).
### 6. Failure scenario — the original race ([case study 01](case-studies/01-failed-payment-race.md)): order-service's consumer turned `payment.failed` into `CANCELLED` while payment-service's HTTP sync tried `FAILED`; whichever came second hit an invalid transition → `/process` returned 500 for a decline that had actually been recorded.
### 7. Trade-offs — a simple "charged/declined" model is enough for a simulator; real providers force authorize/capture, asynchronous outcomes (3-D Secure) and webhooks.
### 8. Performance — payment latency is dominated by the provider (hundreds of ms to seconds).
### 9. Security — only the order's customer may pay; amounts come from the order, never from the client (`amount: order.totalAmount`).
### 10. Operations — every non-terminal payment older than a few minutes is an anomaly to investigate.

### 11. Lab — [DS-08 Declined payment end to end](labs/distributed-systems-labs.md#ds-08-declined-payment-end-to-end).
### 12. Verification — payment FAILED, order FAILED (not CANCELLED), exactly one `payment.failed` event.

### 13. Interview questions
- *Beginner:* Authorize vs capture?
- *Intermediate:* Why is the amount taken from the order and not the request?
- *Advanced:* Why must the payment and order agree on the failure status?
- *Senior:* Design the payment state machine for authorize-at-checkout, capture-at-dispatch.

### 14. Senior discussion
When should capture happen for food delivery — on confirmation, on pickup, or on delivery? What does each mean for refunds and disputes?

---

## Chapter 2 — Idempotency, duplicates and concurrency in payments

### 1. Why this exists
A double charge is the most visible bug a delivery platform can have.

### 2. Core concept — three independent defences: request idempotency (keys), state idempotency (CAS + settled-result replay), and database invariants (unique indexes).

### 3. Mental model
```text
POST /payments (key K)         → existing for (customer, K)? return it (and finish owed effects)
                                 else insert … unique (customer, K) and unique active payment per order
POST /payments/:id/process     → settled? return result (+ owed effects)
                                 PROCESSING? 409 (someone is settling)
                                 PENDING → CAS to PROCESSING (one winner) → outcome → CAS to final
```

### 4. Delivery Plus mapping — **CURRENT**: `createPayment` (`replayCreate` checks the order matches the key), `UQ_payments_customer_idempotency_key`, `UQ_payments_active_order` (`WHERE status IN ('PENDING','PROCESSING','COMPLETED')` — a FAILED payment allows a new attempt), `processPayment` with two CAS steps, deterministic `paymentEventId`.
### 5. Example — ten concurrent `process` calls: one claims PROCESSING, the others get 409 or (if they arrive after settlement) the settled result.
### 6. Failure scenario — **PARTIAL** (issue #18): a crash between the two CAS steps leaves the payment in PROCESSING forever; every retry answers 409. A recovery needs a claim timestamp (`processingStartedAt`) and a rule to reclaim after a timeout — and, with a real provider, a status query to the provider before deciding.
### 7. Trade-offs — returning 409 for in-progress vs waiting: 409 keeps servers simple and pushes retry to the client.
### 8. Performance — CAS updates are single statements.
### 9. Security — keys are scoped per customer; another customer's key can't return your payment.
### 10. Operations — dashboards: payments stuck in PROCESSING, payments with owed side effects.

### 11. Lab — [DS-03 Retry payment processing after a failure](labs/distributed-systems-labs.md#ds-03-retry-payment-processing-after-a-failure).
### 12. Verification — after an order-service outage, a retry completes the sync without a second event or charge.

### 13. Interview questions
- *Intermediate:* Why a partial unique index on active payments?
- *Advanced:* What happens when two `process` calls race?
- *Senior:* How would you recover a payment stuck in PROCESSING when the provider's outcome is unknown?

### 14. Senior discussion
With a real provider, the provider's idempotency key should be derived from what — the payment ID, the attempt, or the client's key? Why?

---

## Chapter 3 — Order/payment consistency and side effects

### 1. Why this exists
A payment's outcome must reach the order exactly once, even if order-service or Kafka is down at that moment.

### 2. Core concept — per-effect markers + lease + resume (Book 08 Ch. 6); two writers converging on the same status (HTTP sync + Kafka consumer) safely thanks to CAS and same-status no-ops.

### 3. Mental model — "the payment owes these effects for its current status until both markers equal the status".

### 4. Delivery Plus mapping — **CURRENT**: `completeSideEffects` (lease → re-read → publish if `publishedEventStatus ≠ status` → mark → sync order if `orderSyncedStatus ≠ status` → mark → release); `syncOrder` tolerates a FAILED payment whose order is already terminal (customer cancelled first) but **not** a COMPLETED payment on a closed order: "that money needs a refund, and silently marking it synced would hide it".
### 5. Example — the customer cancels while the payment is pending, then the payment succeeds: sync fails with a conflict; the payment stays COMPLETED with an owed order sync — visible, not hidden. Resolution today is manual (admin refund).
### 6. Failure scenario — lease without owner (issue #19), see [Book 09 Ch. 9](09-distributed-systems.md#chapter-9--distributed-locks-leases-and-fencing-tokens).
### 7. Trade-offs — markers per row emulate an outbox for exactly two effects; a general outbox (#98) would replace them.
### 8. Performance — 2–4 extra small updates per payment.
### 9. Security — "paid but order closed" must alert someone; silent states are where money gets lost.
### 10. Operations — query: `SELECT id, status, "publishedEventStatus", "orderSyncedStatus" FROM payments WHERE status IN ('PENDING','COMPLETED','FAILED') AND ("publishedEventStatus" IS DISTINCT FROM status OR "orderSyncedStatus" IS DISTINCT FROM status);`

### 11. Lab — run the query above after [DS-03](labs/distributed-systems-labs.md#ds-03-retry-payment-processing-after-a-failure) with order-service stopped.
### 12. Verification — the payment appears with an owed sync and disappears after the successful retry.

### 13. Interview questions
- *Intermediate:* Why track the published event and the order sync separately?
- *Advanced:* Why refuse to mark a COMPLETED payment synced when the order is closed?
- *Senior:* Design automatic compensation for "paid, then cancelled" (issue #53).

### 14. Senior discussion
Who should own the decision to refund — payment-service, order-service, or a separate cancellation saga?

---

## Chapter 4 — Refunds, partial refunds and reconciliation

### 1. Why this exists
Refunds move money back; reconciliation proves your records match the provider's.

### 2. Core concept
- **Full/partial refunds**, multiple partial refunds up to the captured amount.
- **Ledger**: append-only records of money movements (charge, refund, fee) instead of mutating one status.
- **Reconciliation**: daily comparison of your ledger with the provider's settlement report.

### 3. Mental model — statuses describe the *present*; a ledger describes *history*. Money needs history.

### 4. Delivery Plus mapping
- **CURRENT:** `refund` (admin only) moves COMPLETED → REFUNDED via CAS; no event, no order change, no amount, no reason, no audit trail.
- **NOT IMPLEMENTED:** partial refunds, ledger, reconciliation, refund policy (#53, #56).
### 5. Example — a ledger table (FUTURE):
```sql
CREATE TABLE payment_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "paymentId" uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('charge','refund','fee')),
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  "providerReference" text,
  reason text,
  "createdBy" uuid,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
```
### 6. Failure scenario — refund recorded locally, provider call failed (or vice versa): without reconciliation nobody notices until a customer complains.
### 7. Trade-offs — a status column is simple; a ledger is auditable and supports partial operations.
### 8. Performance — ledgers grow; index by payment and date.
### 9. Security — refunds are privileged: authorize, require a reason, audit who did it.
### 10. Operations — reconciliation mismatches open tickets automatically.

### 11. Lab — design the refund API with idempotency key, amount, reason and the events it would publish.
### 12. Verification — your design prevents refunding more than was captured even with concurrent requests.

### 13. Interview questions
- *Intermediate:* Why a ledger instead of a status?
- *Advanced:* How do you make partial refunds concurrency-safe?
- *Senior:* Design reconciliation with a provider's daily settlement file.

### 14. Senior discussion
Should refunds be able to happen automatically (policy-driven) or always need a human at this stage of the business?

---

## Chapter 5 — Evolving to a real gateway: provider abstraction, webhooks and signatures

### 1. Why this exists
The simulator decides outcomes synchronously and instantly; real providers decide asynchronously, sometimes minutes later, and tell you by webhook.

### 2. Core concept
- **Provider abstraction** (port): `authorize`, `capture`, `void`, `refund`, `getStatus` — with sandbox and production adapters.
- **Webhooks**: provider → your endpoint with event type and payment reference; at-least-once, possibly out of order, possibly before your API call returns.
- **Signature verification**: HMAC of the raw body with a shared secret plus a timestamp tolerance — reject anything unsigned or stale.
- **Provider idempotency keys** on every mutating call.
- **PCI DSS**: never let card data touch your servers; use hosted fields/SDKs/tokens so you stay in the smallest compliance scope (SAQ A).

### 3. Mental model
```text
app ──► payment-service: create intent ──► provider (idempotency key = paymentId)
app ──► provider SDK (card details never reach us) ──► provider decides
provider ──webhook──► payment-service: verify signature → dedup by provider event id → CAS status → effects
reconciliation job ──► provider API: fix anything webhooks missed
```

### 4. Delivery Plus mapping — **FUTURE**. What can be reused as-is: the state machine with CAS, idempotency keys, side-effect markers/outbox, deterministic event IDs, durable consumer dedup. What must be added: the adapter, webhook endpoint (public, unauthenticated by JWT, authenticated by signature — compare with the HMAC internal-auth guard in `services/user-service/src/guards/internal-auth.guard.ts`), webhook dedup table, reconciliation, PROCESSING recovery via `getStatus` (#18).
### 5. Example — webhook verification sketch:
```ts
const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
if (Math.abs(nowSeconds - Number(timestamp)) > 300 || !safeEqual(expected, signature)) throw new UnauthorizedError('Bad signature');
```
### 6. Failure scenario — the webhook "succeeded" arrives before the `process` HTTP call returns; naive code processes the webhook, then the HTTP response tries PENDING→PROCESSING and fails. CAS-based convergence (same target status = no-op) handles it.
### 7. Trade-offs — webhooks only (fast, can be missed) vs polling the provider (reliable, slow) → use both: webhooks for speed, reconciliation for correctness.
### 8. Performance — provider latency moves checkout from ~100 ms to seconds; the UI must show a pending state.
### 9. Security — webhook endpoints are public; signatures, timestamp windows and replay protection are mandatory; secrets per environment.
### 10. Operations — sandbox in staging, production keys only in production, alerts on webhook failure rates.

### 11. Lab — implement (locally, not committed) a fake provider with delayed webhooks and observe how the current CAS handles out-of-order outcomes.
### 12. Verification — duplicate and out-of-order webhooks never produce a second charge or a wrong final status.

### 13. Interview questions
- *Intermediate:* Why verify webhook signatures?
- *Advanced:* How do you handle a webhook that arrives before your API response?
- *Senior:* Migration plan from the simulator to a production gateway.

### 14. Senior discussion
Which parts of today's payment-service design would you keep unchanged when a real gateway arrives, and which would you rewrite? Why?

---

[Library index](README.md) · Previous: [Book 24](24-system-design.md) · Next: [Book 26 — Reliability Engineering](26-reliability-engineering.md)
