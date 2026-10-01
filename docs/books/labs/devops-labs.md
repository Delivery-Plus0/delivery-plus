# DevOps, Operations & Reliability Labs

[Lab index](README.md) · Books: [14 Docker](../14-docker-and-containers.md), [15 Linux](../15-linux-and-os.md), [16 Networking](../16-networking.md), [19 Kubernetes](../19-kubernetes.md), [20 Observability](../20-observability.md), [21 Performance](../21-performance-engineering.md), [26 Reliability](../26-reliability-engineering.md)

Set up the [lab environment](README.md#lab-environment) first. Restore anything you stop with `dc up -d --wait`.

---

## OPS-01 Look inside a container

```bash
dc exec order-service sh -c 'ps -o pid,user,comm; cat /proc/1/status | grep -E "Name|VmRSS|Threads"; id'
docker top delivery-plus-order-service-1
dc exec postgres sh -c 'ps -o pid,user,args | head -15'
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.PIDs}}'
```
**Expected:** `node` is PID 1 inside the service container, running as `root`, with a handful of threads (libuv); the same process has a different PID on the host (`docker top`); PostgreSQL shows background workers plus one backend per connection.
**Links:** [Book 14 Ch. 1](../14-docker-and-containers.md#chapter-1--process-vs-container-namespaces-and-cgroups), [Book 15 Ch. 1](../15-linux-and-os.md#chapter-1--processes-threads-and-scheduling).

---

## OPS-02 Layer cache experiment

```bash
docker build --progress=plain --build-arg SERVICE_NAME=notification-service -t lab-notification . 2>&1 | grep -E "^#[0-9]+ (CACHED|DONE)" | tail -20
docker build --progress=plain --build-arg SERVICE_NAME=notification-service -t lab-notification . 2>&1 | grep -c CACHED
echo "// lab" >> services/menu-service/src/main.ts
docker build --progress=plain --build-arg SERVICE_NAME=notification-service -t lab-notification . 2>&1 | grep -E "CACHED|RUN" | head
git checkout services/menu-service/src/main.ts; docker rmi lab-notification
```
**Expected:** the second build is fully cached. After editing a file in a *different* service, the notification image rebuilds from the `COPY services ./services` step onward (the builder copies all services before `npm ci`), although the npm cache mount keeps `npm ci` fast.
**Why:** layer keys depend on everything copied so far ([Book 14 Ch. 2](../14-docker-and-containers.md#chapter-2--images-layers-multi-stage-builds-and-the-build-cache)).

---

## OPS-03 Graceful shutdown

```bash
time dc stop notification-service
docker inspect -f 'exit={{.State.ExitCode}}' delivery-plus-notification-service-1
kcg --describe --group notification-service-group --state       # still Stable for ~30 s
sleep 35; kcg --describe --group notification-service-group --state   # Empty
dc start notification-service
```
**Expected:** `stop` takes ~10 s and the exit code is 137 (SIGKILL after the grace period); the consumer group stays `Stable` until the session timeout.
**Why:** no `app.enableShutdownHooks()` in any `main.ts` — `onModuleDestroy` never runs on SIGTERM (issue #7).
**Links:** [Book 11 Ch. 5](../11-nestjs-typescript-backend.md#chapter-5--lifecycle-hooks-logging-and-graceful-shutdown).

---

## OPS-04 Kafka outage during checkout

```bash
reset_limits
curl -s -X DELETE $API/api/cart -H "Authorization: Bearer $CUSTOMER" >/dev/null
curl -s -X POST $API/api/cart/items -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d "{\"menuItemId\":\"$ITEM\",\"quantity\":1}" >/dev/null
dc stop kafka
KEY=$(node -e 'console.log(crypto.randomUUID())')
ORDER=$(curl -s -X POST $API/api/orders -H "Authorization: Bearer $CUSTOMER" -H "Idempotency-Key: $KEY" | j id)   # slow: kafkajs retries
echo "order=$ORDER"
curl -s -X POST $API/api/payments -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d "{\"orderId\":\"$ORDER\"}"; echo   # error
PAYMENT=$(psql_db payment_service -tAc "SELECT id FROM payments WHERE \"orderId\" = '$ORDER';")
psql_db payment_service -c "SELECT status, \"publishedEventStatus\", \"orderSyncedStatus\" FROM payments WHERE id = '$PAYMENT';"
dc start kafka; dc up -d --wait
curl -s -X POST $API/api/payments/$PAYMENT/process -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d '{"simulateFailure":false}' | j status
kcc --topic order.events --from-beginning --timeout-ms 8000 2>/dev/null | grep "$ORDER" | grep -o '"eventType":"[^"]*"'
kcc --topic payment.events --from-beginning --timeout-ms 8000 2>/dev/null | grep "$PAYMENT" | grep -o '"eventType":"[^"]*"'
```
**Expected (read the outcomes carefully):**
- The order is saved; because of the `Idempotency-Key`, `createFromCart`'s `catch` returns it despite the publish failure — but **`order.created` is never published** (no outbox).
- The payment row is saved too, and the create request fails at the publish step; the row shows the owed effects (`publishedEventStatus` NULL while `status` is PENDING). After Kafka is back, `process` first finishes what creation owed (`payment.created`, order → PAYMENT_PENDING), then settles: `payment.events` ends with `created` and `completed`; `order.events` has `payment_pending`, `confirmed` — and no `created`.
- Requests during the outage are slow (kafkajs retries) and may 5xx; consumers reconnect after the restart (containers with `restart: unless-stopped` may restart once).
**Why:** order-service has no outbox; payment-service emulates one with markers ([Book 07 Ch. 10](../07-kafka.md#chapter-10--observability-and-operational-failures), [case study 13](../case-studies/13-transactional-outbox.md)).

---

## OPS-05 Load test the restaurant list

```bash
npx autocannon -c 20 -d 20 "$API/api/restaurants?page=1&limit=20"
npx autocannon -c 100 -d 20 "$API/api/restaurants?page=1&limit=20"
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}' | grep -E "gateway|restaurant|postgres"
```
**Expected:** latency percentiles (p50, p97.5, p99 in autocannon's table) rise with concurrency while throughput plateaus; `docker stats` shows which container saturates first (often the gateway or restaurant-service Node process on a laptop).
**Report:** concurrency, req/s, p50/p99, errors, the saturated resource — and note that the load generator shares your CPU.
**Links:** [Book 21 Ch. 5](../21-performance-engineering.md#chapter-5--load-stress-and-benchmark-design), [Book 12 Ch. 6](../12-testing-engineering.md#chapter-6--performance-load-stress-soak-and-chaos-testing).

---

## OPS-06 Docker DNS and published ports

```bash
dc exec order-service sh -c 'cat /etc/resolv.conf; getent hosts cart-service postgres redis kafka'
dc exec order-service wget -qO- http://cart-service:3005/health; echo
dc exec order-service wget -qO- http://localhost:3005/health; echo "← refused: cart-service isn't in this container"
nc -z -w 2 localhost 3000 && echo "3000 published (gateway)"
nc -z -w 2 localhost 6379 || echo "6379 not published on the dev overlay (Redis is internal)"
docker network inspect delivery-plus_default --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}' | head
```
**Expected:** service names resolve through `127.0.0.11`; `localhost` inside a container is that container; only the gateway, Kafka (127.0.0.1:9092), Kafka UI and S3 are reachable from the host.
**Links:** [Book 14 Ch. 4](../14-docker-and-containers.md#chapter-4--networking-bridge-networks-dns-and-ports), [Book 15 Ch. 6](../15-linux-and-os.md#chapter-6--networking-from-the-os-ports-localhost-dns-routing).

---

## OPS-07 Backup and restore one service database

```bash
dc exec postgres pg_dump -U postgres -d order_service -Fc -f /tmp/order_service.dump
psql_db postgres -c "CREATE DATABASE order_service_restore;"
time dc exec postgres pg_restore -U postgres -d order_service_restore /tmp/order_service.dump
psql_db order_service -tAc "SELECT count(*) FROM orders;" ; psql_db order_service_restore -tAc "SELECT count(*) FROM orders;"
psql_db postgres -c "DROP DATABASE order_service_restore;"
```
**Expected:** equal counts; `time` gives your RTO for this database at this size; the dump time is your RPO (anything after it is lost).
**Discuss:** dumping nine databases one after another gives nine different points in time ([Book 05 Ch. 8](../05-postgresql-deep-dive.md#chapter-8--backups-restore-and-point-in-time-recovery)).

---

## OPS-08 Healthcheck and dependency failure

```bash
dc stop postgres
for s in order-service payment-service notification-service delivery-service; do
  port=$(dc exec -T $s sh -c 'echo $PORT'); [ -z "$port" ] && port=$(case $s in order-service) echo 3006;; payment-service) echo 3007;; delivery-service) echo 3008;; notification-service) echo 3011;; esac)
  echo "$s live=$(dc exec -T $s wget -qO- http://localhost:$port/health/live 2>&1 | head -c 60) ready=$(dc exec -T $s wget -qO- http://localhost:$port/health/ready 2>&1 | head -c 80)"
done
dc ps --format 'table {{.Name}}\t{{.Status}}' | head -20
dc start postgres; dc up -d --wait
```
**Expected:** `/health/live` keeps answering; `/health/ready` reports the database problem — as a non-2xx error in some services, and as HTTP 200 with `"status":"ERROR"` in notification-service (issue #8). Compose healthchecks (which call `/health`) may stay healthy.
**Links:** [Book 20 Ch. 5](../20-observability.md#chapter-5--health-checks-readiness-liveness-and-graceful-shutdown-in-production).

---

## OPS-09 Resource exhaustion

```bash
docker update --memory 128m --memory-swap 128m delivery-plus-menu-service-1
npx autocannon -c 100 -d 20 "$API/api/menus/restaurants/$RID/menu" >/dev/null
docker inspect -f 'OOMKilled={{.State.OOMKilled}} restarts={{.RestartCount}} exit={{.State.ExitCode}}' delivery-plus-menu-service-1
dc up -d --force-recreate --wait menu-service      # back to no limit
```
**Expected:** depending on your machine, the service either survives with high memory use or is OOM-killed (`OOMKilled=true`, exit 137) and restarted by `restart: unless-stopped`. Lower the limit until you see it.
**Links:** [Book 14 Ch. 7](../14-docker-and-containers.md#chapter-7--container-lifecycle-signals-graceful-shutdown-limits-and-logs), [Book 15 Ch. 2](../15-linux-and-os.md#chapter-2--memory-and-virtual-memory).

---

## OPS-10 Paused service versus stopped service

```bash
dc stop order-service
time curl -s -o /dev/null -w "stopped: %{http_code}\n" $API/api/orders -H "Authorization: Bearer $CUSTOMER"
dc start order-service; dc up -d --wait
docker pause delivery-plus-order-service-1
time curl -s -o /dev/null -w "paused: %{http_code}\n" --max-time 10 $API/api/orders -H "Authorization: Bearer $CUSTOMER"
docker unpause delivery-plus-order-service-1
```
**Expected:** stopped → an immediate proxy error from the gateway (connection refused); paused → the request hangs until the client's own timeout (`000` after 10 s), because the gateway has no upstream timeout.
**Why:** refused = nobody listening (fast RST); paused = the kernel accepts, the process never answers. Only timeouts bound the second case ([Book 16 Ch. 6](../16-networking.md#chapter-6--reverse-proxies-load-balancers-and-timeouts)).

---

## OPS-11 Emulator to host networking

Thought lab (or with an Android emulator if you have one):
1. Build the customer app with `EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:3000` (`delivery-plus-customer-app/.env.example`) — `10.0.2.2` is the host from the emulator. Alternative: `adb reverse tcp:3000 tcp:3000` and keep `localhost`.
2. Sign in and open a restaurant: data loads, **images don't** — media URLs are `http://localhost:9000/...` (`AWS_PUBLIC_BASE_URL`), which on the emulator means the emulator itself.
3. Fix: set `AWS_S3_PUBLIC_ENDPOINT`/`AWS_PUBLIC_BASE_URL` to an address the device can reach (LAN IP), or `adb reverse tcp:9000 tcp:9000`.
**Verification:** you can explain each failing URL in terms of "whose localhost?".
**Links:** [Book 16 Ch. 7](../16-networking.md#chapter-7--delivery-plus-network-paths-in-detail).

---

## OPS-12 Compose to Kubernetes translation

Write (do not commit) `order-service.k8s.yaml` from `docker-compose.prod.yml`: a `Deployment` (2 replicas, image tag = commit SHA, `envFrom` a ConfigMap + Secret, `readinessProbe` `/health/ready`, `livenessProbe` `/health/live`, resource requests/limits, `terminationGracePeriodSeconds`), a `ClusterIP` `Service` on 3006, and a `Job` that runs the migrations.
```bash
# validate offline if you have one of these tools
kubectl apply --dry-run=client -f order-service.k8s.yaml   # or: kubeconform order-service.k8s.yaml
```
**Verification:** every Compose key of `order-service` maps to a Kubernetes field or is consciously dropped (`depends_on`).
**Links:** [Book 19 Ch. 3](../19-kubernetes.md#chapter-3--translating-delivery-plus-from-compose-to-kubernetes-future-design).

---

## OPS-13 Follow one request through the logs

```bash
curl -s -D - -o /dev/null $API/api/restaurants -H 'X-Correlation-Id: lab-trace-1' | grep -i x-correlation-id
curl -s $API/api/orders/00000000-0000-4000-8000-000000000999 -H "Authorization: Bearer $CUSTOMER" -H 'X-Correlation-Id: lab-trace-2'
dc logs --since 1m order-service | grep lab-trace-2
dc logs --since 1m | grep -c lab-trace-1
```
**Expected:** the header is echoed back; the 404 for the unknown order is logged by order-service with `lab-trace-2`; the successful restaurant request appears in **no** log (services don't log successful requests).
**Then read the code:** which outbound clients forward `x-correlation-id`? Only `services/auth-service/src/common/user-service.client.ts`. Kafka events get a fresh `correlationId` in each producer. That's where a trace breaks today.
**Links:** [Book 20 Ch. 2](../20-observability.md#chapter-2--correlation-ids-request-ids-and-distributed-tracing).

---

## OPS-14 Measure polling load

The customer app polls `GET /api/deliveries/by-order/:orderId` every 10 s per active delivery. Simulate 2,000 active deliveries (≈ 200 req/s):
```bash
reset_limits; place_order >/dev/null; deliver_order assign-only
npx autocannon -R 200 -d 30 -H "Authorization=Bearer $CUSTOMER" "$API/api/deliveries/by-order/$ORDER"
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}' | grep -E "gateway|delivery|order"
```
**Expected:** each poll costs delivery-service *and* order-service work (the ownership check calls order-service with the customer's token) — watch both CPUs. Repeat with `-R 1000` (10,000 deliveries).
**Then:** finish the delivery (`pickup`, `start`, `complete` as the driver).
**Links:** [Book 22 Ch. 1](../22-real-time-systems.md#chapter-1--polling-long-polling-sse-and-websockets), [ADR 0005](../adrs/0005-polling-before-websockets.md).

---

[Lab index](README.md)
