# Distributed Systems & Idempotency Labs

[Lab index](README.md) · Books: [08 Idempotency](../08-idempotency-and-distributed-operations.md), [09 Distributed Systems](../09-distributed-systems.md), [25 Payments](../25-payment-systems.md)

Set up the [lab environment](README.md#lab-environment) first. Several labs stop or pause containers — always restart them (`dc up -d --wait`) before moving on.

---

## DS-01 Timeout ambiguity

**Goal:** produce "the client timed out, but the server did the work".
```bash
reset_limits
curl -s -X DELETE $API/api/cart -H "Authorization: Bearer $CUSTOMER" >/dev/null
curl -s -X POST $API/api/cart/items -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d "{\"menuItemId\":\"$ITEM\",\"quantity\":1}" >/dev/null
ORDER=$(curl -s -X POST $API/api/orders -H "Authorization: Bearer $CUSTOMER" | j id)
PAYMENT=$(curl -s -X POST $API/api/payments -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d "{\"orderId\":\"$ORDER\"}" | j id)

docker pause delivery-plus-payment-service-1
curl -s --max-time 3 -X POST $API/api/payments/$PAYMENT/process -H "Authorization: Bearer $CUSTOMER" \
     -H 'content-type: application/json' -d '{"simulateFailure":false}'; echo "exit=$? (28 = timeout)"
docker unpause delivery-plus-payment-service-1; sleep 3
curl -s $API/api/payments/$PAYMENT -H "Authorization: Bearer $CUSTOMER" | j status
```
**Expected:** the client gives up (`exit=28`), yet the payment is typically `COMPLETED` afterwards — the request bytes were already in the paused process's socket buffer and were handled after unpause.
**Why:** a timeout means "unknown". The safe retry is possible because `process` returns the settled result for a COMPLETED payment instead of charging again.
**Links:** [Book 08 Ch. 2](../08-idempotency-and-distributed-operations.md#chapter-2--timeout-ambiguity-and-the-lost-acknowledgement).

---

## DS-02 Double-submit checkout

```bash
fill_cart() { curl -s -X DELETE $API/api/cart -H "Authorization: Bearer $CUSTOMER" >/dev/null
  curl -s -X POST $API/api/cart/items -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d "{\"menuItemId\":\"$ITEM\",\"quantity\":1}" >/dev/null; }

# with one idempotency key
reset_limits; fill_cart; KEY=$(node -e 'console.log(crypto.randomUUID())')
for i in 1 2 3 4 5; do curl -s -X POST $API/api/orders -H "Authorization: Bearer $CUSTOMER" -H "Idempotency-Key: $KEY" | j "id || message" & done; wait

# without a key
reset_limits; fill_cart
for i in 1 2 3 4 5; do curl -s -X POST $API/api/orders -H "Authorization: Bearer $CUSTOMER" | j "id || message" & done; wait
```
**Expected:** with the key, five identical order IDs (the losers of the insert race hit the unique index and return the winner). Without a key, often **more than one** order ID — requests that read the cart before the first one cleared it — plus `Cart is empty` for late ones.
**Why:** `UQ_orders_customer_idempotency_key` + the winner lookup in `createFromCart`; the cart clear only narrows the window, it doesn't close it.
**Links:** [Book 08 Ch. 3](../08-idempotency-and-distributed-operations.md#chapter-3--http-idempotency-keys).

---

## DS-03 Retry payment processing after a failure

```bash
reset_limits
curl -s -X DELETE $API/api/cart -H "Authorization: Bearer $CUSTOMER" >/dev/null
curl -s -X POST $API/api/cart/items -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d "{\"menuItemId\":\"$ITEM\",\"quantity\":1}" >/dev/null
ORDER=$(curl -s -X POST $API/api/orders -H "Authorization: Bearer $CUSTOMER" | j id)
PAYMENT=$(curl -s -X POST $API/api/payments -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d "{\"orderId\":\"$ORDER\"}" | j id)

dc stop order-service
curl -s -X POST $API/api/payments/$PAYMENT/process -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d '{"simulateFailure":false}'; echo
psql_db payment_service -c "SELECT status, \"publishedEventStatus\", \"orderSyncedStatus\" FROM payments WHERE id = '$PAYMENT';"
dc start order-service; sleep 15
curl -s -X POST $API/api/payments/$PAYMENT/process -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d '{"simulateFailure":false}' | j status
psql_db payment_service -c "SELECT status, \"publishedEventStatus\", \"orderSyncedStatus\" FROM payments WHERE id = '$PAYMENT';"
kcc --topic payment.events --from-beginning --timeout-ms 6000 2>/dev/null | grep "$PAYMENT" | grep -c payment.completed
```
**Expected:** first call fails; the row shows `COMPLETED / COMPLETED / PENDING` (event published, order sync owed). The retry returns `COMPLETED` and the row becomes `COMPLETED / COMPLETED / COMPLETED`. Exactly **one** `payment.completed` event.
**Why:** per-effect markers + lease (`completeSideEffects` in `services/payment-service/src/services/payments.service.ts`): the retry resumes at the step that failed.
**Links:** [Book 08 Ch. 6](../08-idempotency-and-distributed-operations.md#chapter-6--side-effects-markers-and-leases-payments).

---

## DS-04 Duplicate payment event

```bash
reset_limits; place_order >/dev/null
EVT=$(kcc --topic payment.events --from-beginning --timeout-ms 6000 2>/dev/null | grep "$PAYMENT" | grep payment.completed)
echo "$ORDER|$EVT" | kcp --topic payment.events --property parse.key=true --property key.separator='|'
sleep 5
dc logs --since 30s order-service | grep "already processed"
dc logs --since 30s notification-service | grep "already processed"
```
**Expected:** both consumer groups log the event ID as already processed; the order and notifications are unchanged.
**Why:** the same deterministic `eventId` (`paymentEventId`) + Redis markers per group.
**Links:** [Book 08 Ch. 5](../08-idempotency-and-distributed-operations.md#chapter-5--event-idempotency-deterministic-ids-and-consumer-deduplication).

---

## DS-05 Concurrent order confirmation

**Goal:** see compare-and-set choose one writer. (CONFIRMED is reserved for payment-service, so race the owner's `PREPARING` transition instead — same code path.)
```bash
reset_limits; place_order >/dev/null           # order is CONFIRMED
for i in 1 2 3 4; do
  curl -s -X PATCH $API/api/orders/$ORDER/status -H "Authorization: Bearer $OWNER" -H 'content-type: application/json' \
       -d '{"status":"PREPARING"}' | j status &
done; wait
kcc --topic order.events --from-beginning --timeout-ms 6000 2>/dev/null | grep "$ORDER" | grep -c order.preparing
```
**Expected:** all four responses say `PREPARING`; exactly **one** `order.preparing` event.
**Why:** the CAS `UPDATE … WHERE status = 'CONFIRMED'` succeeds once; losers re-read, find the target status, and return without publishing (`OrdersService.updateStatus`).
**Links:** [Book 04 Ch. 6](../04-database-fundamentals.md#chapter-6--concurrency-control-locks-cas-lost-updates-and-deadlocks), [case study 06](../case-studies/06-in-memory-idempotency.md).

---

## DS-06 Repeat delivery completion with a service down

```bash
reset_limits; place_order >/dev/null; deliver_order assign-only
for a in pickup start; do curl -s -X POST $API/api/deliveries/$DELIVERY/$a -H "Authorization: Bearer $DRIVER" >/dev/null; done

dc stop order-service
curl -s -o /dev/null -w "first complete: %{http_code}\n" -X POST $API/api/deliveries/$DELIVERY/complete -H "Authorization: Bearer $DRIVER"
curl -s $API/api/drivers/me -H "Authorization: Bearer $DRIVER" | j status        # AVAILABLE: released first
dc start order-service; sleep 15
curl -s -o /dev/null -w "retry: %{http_code}\n" -X POST $API/api/deliveries/$DELIVERY/complete -H "Authorization: Bearer $DRIVER"
curl -s $API/api/orders/$ORDER -H "Authorization: Bearer $CUSTOMER" | j status    # DELIVERED
kcc --topic delivery.events --from-beginning --timeout-ms 6000 2>/dev/null | grep "$DELIVERY" | grep delivery.completed | node -e 'require("readline").createInterface({input:process.stdin}).on("line",l=>console.log(JSON.parse(l).eventId))'
```
**Expected:** first `complete` fails (5xx); the driver is already AVAILABLE; the retry returns 201 and the order is DELIVERED; any re-published `delivery.completed` events carry the **same** `eventId`.
**Variant:** stop `driver-service` instead — the first attempt fails at the driver authorization lookup (nothing written); the retry after restart completes normally.
**Why:** retry-safe `advance()` in `services/delivery-service/src/services/deliveries.service.ts` ([case study 09](../case-studies/09-driver-availability-lifecycle.md)).

---

## DS-07 Consumer crash mid-handler

**Goal:** see how a claim left by a crashed consumer is handled. We fake the crashed consumer's lease by hand.
```bash
CUSTOMER_ID=$(login customer@example.com | j userId)
EID=$(node -e 'console.log(crypto.randomUUID())')
rcli SET kafka:idempotency:notification-service-group:$EID lease:crashed-consumer PX 20000
EVENT=$(node -e "console.log(JSON.stringify({eventId:'$EID',eventType:'order.confirmed',timestamp:new Date().toISOString(),correlationId:'lab',payload:{orderId:'00000000-0000-4000-8000-00000000c7a5',customerId:'$CUSTOMER_ID',restaurantId:'00000000-0000-4000-8000-000000000001',total:1,status:'CONFIRMED'}}))")
echo "00000000-0000-4000-8000-00000000c7a5|$EVENT" | kcp --topic order.events --property parse.key=true --property key.separator='|'
for i in 1 2 3 4 5; do sleep 5; psql_db notification_service -tAc "SELECT count(*) FROM notifications WHERE message LIKE '%c7a5%';"; done
psql_db notification_service -c "DELETE FROM notifications WHERE message LIKE '%c7a5%';"
```
**Expected:** the count stays 0 while the fake lease is alive (the consumer sees `in-progress` and polls, blocking the partition), then becomes 1 shortly after 20 s when the lease expires and it acquires the claim.
**Why:** leases make crashed consumers recoverable without letting two live consumers process the same event concurrently (`claim()` in `shared/src/kafka/kafka-consumer.service.ts`).

---

## DS-08 Declined payment end to end

```bash
reset_limits
place_order true                                         # → FAILED
curl -s $API/api/orders/$ORDER -H "Authorization: Bearer $CUSTOMER" | j status      # FAILED (not CANCELLED)
kcc --topic payment.events --from-beginning --timeout-ms 6000 2>/dev/null | grep "$PAYMENT" | grep -c payment.failed
curl -s -o /dev/null -w "%{http_code}\n" $API/api/deliveries/by-order/$ORDER -H "Authorization: Bearer $CUSTOMER"  # 404: no delivery
```
**Expected:** payment FAILED, order FAILED, one `payment.failed` event, no delivery.
**Links:** [case study 01](../case-studies/01-failed-payment-race.md), [Book 25 Ch. 1](../25-payment-systems.md#chapter-1--the-payment-lifecycle-and-its-state-machine).

---

## DS-09 Partial failure during checkout

```bash
reset_limits
curl -s -X DELETE $API/api/cart -H "Authorization: Bearer $CUSTOMER" >/dev/null
curl -s -X POST $API/api/cart/items -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d "{\"menuItemId\":\"$ITEM\",\"quantity\":1}" >/dev/null
dc stop kafka
curl -s -X POST $API/api/orders -H "Authorization: Bearer $CUSTOMER" | head -c 200; echo     # no key → 5xx (kafkajs retries first: can take ~30 s)
psql_db order_service -c "SELECT id, status, \"createdAt\" FROM orders ORDER BY \"createdAt\" DESC LIMIT 1;"
curl -s $API/api/cart -H "Authorization: Bearer $CUSTOMER" | j "items.length"                 # 0: cart already cleared
dc start kafka; dc up -d --wait
```
**Expected:** the API reports an error, yet the newest order exists in the database and the cart is empty — a retry now fails with "Cart is empty". No `order.created` event exists for it.
**Why:** DB write, cart clear (HTTP) and publish (Kafka) are separate steps with no shared transaction ([Book 09 Ch. 1](../09-distributed-systems.md#chapter-1--what-makes-distributed-systems-hard)). With an `Idempotency-Key`, the same retry would have returned the saved order.

---

## DS-10 Saga simulation: cancel a paid order

```bash
reset_limits; place_order >/dev/null                     # paid, CONFIRMED
curl -s -X PATCH $API/api/orders/$ORDER/status -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d '{"status":"CANCELLED"}' | j status
curl -s $API/api/payments/$PAYMENT -H "Authorization: Bearer $CUSTOMER" | j status   # still COMPLETED
```
**Expected:** the order is CANCELLED and the payment is still COMPLETED — no refund, no event that would trigger one.
**Exercise:** write the choreographed saga that should follow `order.cancelled` (refund if paid, cancel the delivery and free the driver if active), with the idempotency key of each step and what happens when the refund call fails. Compare with issue #53 and [Book 27 Ch. 3](../27-advanced-data-patterns.md#chapter-3--sagas-and-consistency-boundaries).

---

## DS-11 Outbox simulation

**Goal:** compare "commit then publish" with "commit outbox, relay later".
```sql
-- psql_db order_service
CREATE TABLE lab_outbox (id uuid PRIMARY KEY, topic text, key text, payload text, "sentAt" timestamptz);
CREATE TABLE lab_state (id uuid PRIMARY KEY, status text);
INSERT INTO lab_state VALUES ('00000000-0000-4000-8000-0000000000e1', 'PREPARING');

-- the state change and its event, atomically
BEGIN;
UPDATE lab_state SET status = 'READY_FOR_PICKUP' WHERE id = '00000000-0000-4000-8000-0000000000e1' AND status = 'PREPARING';
INSERT INTO lab_outbox VALUES (gen_random_uuid(), 'lab.outbox', '00000000-0000-4000-8000-0000000000e1', '{"eventType":"lab.ready"}', NULL);
COMMIT;
-- "crash" here: nothing was published, but the event is safe in the outbox
SELECT id, "sentAt" FROM lab_outbox;
```
Relay (run any time later):
```bash
kt --create --topic lab.outbox --partitions 1 --replication-factor 1 2>/dev/null
psql_db order_service -tAc "SELECT key || '|' || payload FROM lab_outbox WHERE \"sentAt\" IS NULL ORDER BY id" | \
  kcp --topic lab.outbox --property parse.key=true --property key.separator='|'
psql_db order_service -c "UPDATE lab_outbox SET \"sentAt\" = now() WHERE \"sentAt\" IS NULL;"
kcc --topic lab.outbox --from-beginning --timeout-ms 5000 --property print.key=true
```
**Expected:** the event is published after the "crash"; running the relay twice before marking `sentAt` would publish twice — consumers must dedup by an event ID (the outbox row ID).
**Cleanup:** `DROP TABLE lab_outbox, lab_state;`
**Links:** [Book 27 Ch. 1](../27-advanced-data-patterns.md#chapter-1--transactional-outbox), [case study 13](../case-studies/13-transactional-outbox.md).

---

## DS-12 Retry storm

**Goal:** see why retries need backoff and jitter. Pure simulation:
```bash
node -e '
const sim = (jitter) => { const capacity = 60; let pending = Array.from({length: 200}, () => 0); const load = [];
  for (let t = 0; t < 30; t++) {
    const due = pending.filter(d => d === t).length; load.push(due);
    const served = Math.min(due, capacity); let failed = due - served;
    pending = pending.filter(d => d !== t);
    for (let i = 0; i < failed; i++) { const attempt = 1 + Math.floor(t / 2);
      const delay = Math.min(8, 2 ** Math.min(attempt, 3));
      pending.push(t + (jitter ? 1 + Math.floor(Math.random() * delay) : delay)); } }
  return load.join(" "); };
console.log("no jitter:", sim(false)); console.log("jitter:   ", sim(true));'
```
**Expected:** without jitter, load arrives in synchronized spikes above capacity; with jitter, it spreads out and drains sooner.
**Why:** clients that fail together retry together. Delivery Plus's Kafka handler backoff has no jitter (200 ms, 400 ms); internal HTTP clients don't retry at all today ([Book 09 Ch. 7](../09-distributed-systems.md#chapter-7--timeouts-retries-jitter-backpressure-circuit-breakers-and-bulkheads)).

---

[Lab index](README.md)
