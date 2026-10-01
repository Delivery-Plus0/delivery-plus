# Kafka Labs

[Lab index](README.md) · Book: [07 Kafka](../07-kafka.md)

Set up the [lab environment](README.md#lab-environment) first. Aliases: `kt` (topics), `kcc` (console consumer), `kcp` (console producer), `kcg` (consumer groups). Kafka UI is on `http://localhost:8085`. Lab topics start with `lab.`; delete them at the end with `kt --delete --topic 'lab.*'`.

---

## KF-01 Produce and consume by hand

```bash
kt --create --topic lab.events --partitions 1 --replication-factor 1
printf 'hello\nworld\n' | kcp --topic lab.events
kcc --topic lab.events --from-beginning --timeout-ms 5000
# the real thing
npm run e2e >/dev/null 2>&1
kcc --topic order.events --from-beginning --property print.key=true --property print.offset=true --max-messages 10
```
**Expected:** your two lines; then real `order.*` events, each printed with its key (an order ID) and offset.
**Why:** a topic is a log; consumers read from a position. The key you see is `eventPartitionKey(event)` = `payload.orderId` (`shared/src/events/event-identity.ts`).

---

## KF-02 Consumer groups read independently

```bash
kcc --topic lab.events --from-beginning --group lab-a --timeout-ms 5000
kcc --topic lab.events --from-beginning --group lab-b --timeout-ms 5000
printf 'third\n' | kcp --topic lab.events
kcc --topic lab.events --group lab-a --timeout-ms 5000      # only "third"
kcg --describe --group lab-a ; kcg --describe --group lab-b
```
**Expected:** both groups read everything once; `lab-a` then reads only the new message; `lab-b` shows a lag of 1.
**Why:** each group stores its own committed offset — exactly how `order-service-group` and `notification-service-group` both receive `payment.events`.

---

## KF-03 Partitions and keys

```bash
kt --create --topic lab.keyed --partitions 3 --replication-factor 1
printf 'order-1:a\norder-2:b\norder-1:c\norder-3:d\norder-1:e\n' | \
  kcp --topic lab.keyed --property parse.key=true --property key.separator=:
kcc --topic lab.keyed --from-beginning --property print.key=true --property print.partition=true --timeout-ms 5000
```
**Expected:** every `order-1` record is in the same partition, in order `a, c, e`; other keys may land elsewhere.
**Why:** `partition = hash(key) mod partitions`. Delivery Plus topics have one partition today, which hid the old random-key bug ([ADR 0004](../adrs/0004-orderid-partition-key.md)).

---

## KF-04 Rebalance by adding a consumer

Terminal 1 and 2 (same group):
```bash
kcc --topic lab.keyed --group lab-rb
```
Terminal 3:
```bash
kcg --describe --group lab-rb --members --verbose   # partition assignment per member
```
Stop terminal 2 (Ctrl-C) and describe again.
**Expected:** with two members the 3 partitions are split (2 + 1); after one leaves, the survivor owns all 3. Consumption pauses briefly during each rebalance.
**Why:** a group assigns each partition to one member. With one partition per topic (Delivery Plus today), a second notification-service replica would sit idle.

---

## KF-05 Offsets and commits

```bash
kcg --describe --group notification-service-group
place_order >/dev/null
kcg --describe --group notification-service-group
```
**Expected:** `CURRENT-OFFSET` for `order.events` advances to `LOG-END-OFFSET` (LAG 0) — even for event types notification-service ignores, because the shared consumer commits those too.
**Why:** `autoCommit: false`; `KafkaConsumerService` commits each message after handling, skipping, or dead-lettering (`shared/src/kafka/kafka-consumer.service.ts`).

---

## KF-06 Consumer lag

```bash
dc stop notification-service
reset_limits; place_order >/dev/null; place_order >/dev/null
kcg --describe --group notification-service-group      # LAG > 0, no active members
psql_db notification_service -c "SELECT count(*) FROM notifications;"
dc start notification-service; sleep 20
kcg --describe --group notification-service-group      # LAG 0
psql_db notification_service -c "SELECT count(*) FROM notifications;"
```
**Expected:** lag grows while the service is down; after restart it drains and two new "Order Confirmed" notifications appear.
**Why:** Kafka retains events; the group resumes from its committed offset. Lag is the primary health signal ([case study 17](../case-studies/17-consumer-lag.md)).

---

## KF-07 Redelivery after restart is skipped

```bash
psql_db notification_service -c "SELECT count(*) FROM notifications;"
dc stop notification-service
until kcg --describe --group notification-service-group --state | grep -q Empty; do sleep 5; done   # ~30 s: no graceful shutdown
kcg --group notification-service-group --topic order.events --reset-offsets --shift-by -20 --execute
dc start notification-service; sleep 20
dc logs --since 1m notification-service | grep -c "already processed"
psql_db notification_service -c "SELECT count(*) FROM notifications;"
```
**Expected:** many "already processed" log lines; the notification count is unchanged.
**Why:** the redelivered events' IDs have `processed` markers in Redis (`kafka:idempotency:notification-service-group:<eventId>`).
**Destructive variant (dev data only):** delete the markers (`rcli EVAL "for _,k in ipairs(redis.call('KEYS','kafka:idempotency:notification-service-group:*')) do redis.call('DEL',k) end return 1" 0`) and repeat — duplicates appear. Remove them afterwards: `DELETE FROM notifications a USING notifications b WHERE a.id > b.id AND a."userId" = b."userId" AND a.message = b.message;`
**Links:** [Book 08 Ch. 5](../08-idempotency-and-distributed-operations.md#chapter-5--event-idempotency-deterministic-ids-and-consumer-deduplication).

---

## KF-08 Replay by rewinding offsets

```bash
psql_db order_service -c "SELECT status, count(*) FROM orders GROUP BY 1;" > /tmp/before.txt
dc stop order-service
until kcg --describe --group order-service-group --state | grep -q Empty; do sleep 5; done
kcg --group order-service-group --topic payment.events --reset-offsets --to-earliest --execute
dc start order-service; sleep 30
psql_db order_service -c "SELECT status, count(*) FROM orders GROUP BY 1;" | diff /tmp/before.txt - && echo "no change"
dc logs --since 2m order-service | grep -cE "already processed|Ignoring stale event"
```
**Expected:** no order changes; log lines show events skipped by markers (processed within the last 7 days) or by business rules (`syncStatusFromEvent`: same status → no-op, illegal transition → "Ignoring stale event").
**Why:** two layers of idempotency: event markers and state-machine convergence.
**Links:** [Book 07 Ch. 8](../07-kafka.md#chapter-8--retention-compaction-and-replay).

---

## KF-09 Poison message to the DLQ

```bash
echo "not json at all" | kcp --topic order.events
sleep 5
dc logs --since 1m notification-service | grep -i "unparseable"
npm run kafka:dlq -- order.events
```
**Expected:** notification-service logs "Unparseable message … dead-lettering it"; the tool lists one pending message with `reason=unparseable` and `group=notification-service-group`.
**Why:** the consumer never blocks the partition on garbage and never drops it silently (`handleMessage` in `shared/src/kafka/kafka-consumer.service.ts`).

---

## KF-10 Handler failure, DLQ and replay

```bash
CUSTOMER_ID=$(login customer@example.com | j userId)     # (counts against the login rate limit)
EVENT=$(node -e "console.log(JSON.stringify({eventId:crypto.randomUUID(),eventType:'order.confirmed',timestamp:new Date().toISOString(),correlationId:'lab',payload:{orderId:'00000000-0000-4000-8000-00000000d1a0',customerId:'$CUSTOMER_ID',restaurantId:'00000000-0000-4000-8000-000000000001',total:1,status:'CONFIRMED'}}))")
psql_db notification_service -c 'ALTER TABLE notifications RENAME TO notifications_offline;'
echo "00000000-0000-4000-8000-00000000d1a0|$EVENT" | kcp --topic order.events --property parse.key=true --property key.separator='|'
sleep 8
psql_db notification_service -c 'ALTER TABLE notifications_offline RENAME TO notifications;'
npm run kafka:dlq -- order.events                # pending: reason=handler-failed, error: relation "notifications" does not exist
npm run kafka:dlq -- order.events --replay
sleep 5
psql_db notification_service -c "SELECT title, message FROM notifications WHERE message LIKE '%00000000d1a0%';"
npm run kafka:dlq -- order.events                # nothing pending
psql_db notification_service -c "DELETE FROM notifications WHERE message LIKE '%00000000d1a0%';"
```
**Expected:** 3 attempts logged, then dead-lettered; replay creates exactly one notification; a second listing finds nothing pending. (Any unparseable message from KF-09 is listed and skipped on replay.)
**Why:** the failed group released its claim (not marked processed), so the replayed event is handled; any group that had already handled it would skip it.
**Links:** [case study 07](../case-studies/07-dlq-implementation.md), [case study 16](../case-studies/16-kafka-replay.md).

---

## KF-11 Ordering per key

```bash
kt --create --topic lab.ordered --partitions 3 --replication-factor 1
for i in 1 2 3 4 5; do echo "order-1:$i"; echo "order-2:$i"; echo "order-3:$i"; done | \
  kcp --topic lab.ordered --property parse.key=true --property key.separator=:
# two terminals, same group:
kcc --topic lab.ordered --group lab-ord --from-beginning --property print.key=true --property print.partition=true
```
**Expected:** each consumer prints some keys; for every key the values arrive `1 2 3 4 5` in order; different keys interleave freely.
**Why:** ordering is per partition, and a key always maps to one partition — the reason Delivery Plus keys events by `orderId`.

---

## KF-12 Producer acks and durability with one broker

```bash
kt --create --topic lab.rf2 --partitions 1 --replication-factor 2          # fails: only 1 broker
kt --create --topic lab.minisr --partitions 1 --replication-factor 1 --config min.insync.replicas=2
echo x | kcp --topic lab.minisr --producer-property acks=all              # error: NOT_ENOUGH_REPLICAS
echo y | kcp --topic lab.minisr --producer-property acks=1                # succeeds
```
**Expected:** replication factor 2 is impossible locally; `acks=all` with `min.insync.replicas=2` is refused rather than silently weaker.
**Why:** durability = replication factor × acks × min ISR. The dev cluster is RF 1 — any broker disk loss loses events ([Book 07 Ch. 3](../07-kafka.md#chapter-3--replication-acknowledgements-and-durability)).

---

## KF-13 Event contract change

**Goal:** see why payload contracts need validation. Predict first, then run.
```bash
psql_db order_service -c "SELECT status, count(*) FROM orders GROUP BY 1;" > /tmp/before.txt
EVENT=$(node -e "console.log(JSON.stringify({eventId:crypto.randomUUID(),eventType:'payment.completed',timestamp:new Date().toISOString(),correlationId:'lab',payload:{paymentId:'00000000-0000-4000-8000-0000000000b1',order_id:'00000000-0000-4000-8000-0000000000b2',amount:1,status:'COMPLETED'}}))")
echo "lab|$EVENT" | kcp --topic payment.events --property parse.key=true --property key.separator='|'
sleep 10
dc logs --since 1m order-service | grep -E "Ignoring|attempt|dead-letter" | head
psql_db order_service -c "SELECT status, count(*) FROM orders GROUP BY 1;" | diff /tmp/before.txt - && echo "no order changed"
npm run kafka:dlq -- payment.events
```
**What to predict:** order-service calls `syncStatusFromEvent(event.payload.orderId /* undefined */, CONFIRMED)`. With TypeORM 0.3, `findOne({ where: { id: undefined } })` **drops the undefined condition** (default `invalidWhereValuesBehavior`) and returns an *arbitrary* order. The compare-and-set `UPDATE … WHERE id = $1 AND status = $2` binds `NULL` for `id` and matches nothing. So expect either an "Ignoring stale event: order undefined …" warning, or a handler failure (`InvalidStateTransition`) dead-lettered after 3 attempts — but **no order changed**.
**Why it matters:** the CAS update saves the day; a plain `findById` used for a *read* response would have returned someone else's order. Two fixes: validate payloads at the consumer boundary (issue #23), and set `invalidWhereValuesBehavior: { undefined: 'throw', null: 'throw' }` in `buildTypeOrmConfig` so the ORM fails loudly.
**Cleanup:** `npm run kafka:dlq -- payment.events --replay` is pointless here (it will fail again); leave it or recreate the stack.
**Links:** [Book 07 Ch. 9](../07-kafka.md#chapter-9--event-envelopes-contracts-versioning-and-schema-evolution).

---

## KF-14 Delivery lifecycle trace

```bash
reset_limits; place_order >/dev/null; deliver_order
for t in order.events payment.events delivery.events; do
  echo "== $t"
  kcc --topic $t --from-beginning --timeout-ms 8000 --property print.key=true 2>/dev/null | grep "$ORDER" | \
    node -e 'require("readline").createInterface({input:process.stdin}).on("line",l=>{const [k,...v]=l.split("\t");const e=JSON.parse(v.join("\t"));console.log(k.slice(0,8),e.eventType,e.eventId)})'
done
kcg --describe --group order-service-group ; kcg --describe --group notification-service-group
```
**Expected:** 8 order events (`created` … `delivered`), 2 payment events, 5 delivery events (`created`, `driver_assigned`, `picked_up`, `in_transit`, `completed`), all with the same key (the order ID); both groups at lag 0.
**Why:** one order's whole story, partitioned by `orderId`, consumed by two independent groups.
**Links:** [Book 07 Ch. 11](../07-kafka.md#chapter-11--kafka-in-delivery-plus-complete-reference), [case study 08](../case-studies/08-delivery-lifecycle-events.md).

---

[Lab index](README.md)
