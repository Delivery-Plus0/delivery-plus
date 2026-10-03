# Labs — Index and Environment

[Library index](../README.md)

Labs turn chapters into experiments on the real Delivery Plus stack. Each lab has a **goal**, **steps**, the **expected result**, **why it happens**, and links back to the books and case studies.

> Labs that create data use `lab`-prefixed tables or keys where possible and include cleanup steps. Run them on your **local dev stack** or the disposable **E2E stack**, never on shared environments.

## Lab environment

From the `delivery-plus` repository root (bash or Git Bash; Node 22 for `node -e/-p`):

```bash
alias dc='docker compose -f docker-compose.base.yml -f docker-compose.dev.yml'
dc up -d --build --wait            # all services healthy
npm ci && npm run seed             # owner@ / customer@ / driver@example.com, password123

# JSON helper: read a field from JSON on stdin, e.g. `curl … | j id` or `j "items[0].id"`
j() { node -pe "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); d.$1"; }

API=http://localhost:3000
login() { curl -s $API/api/auth/login -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"password123\"}"; }
CUSTOMER=$(login customer@example.com | j accessToken)
OWNER_JSON=$(login owner@example.com); OWNER=$(echo "$OWNER_JSON" | j accessToken); OWNER_ID=$(echo "$OWNER_JSON" | j userId)
DRIVER=$(login driver@example.com | j accessToken)

# the seeded restaurant owned by owner@example.com, and an available menu item
RID=$(curl -s "$API/api/restaurants/me" -H "Authorization: Bearer $OWNER" | j "find(r => r.status === 'OPEN').id")
ITEM=$(curl -s "$API/api/menus/restaurants/$RID/menu" | j "items.find(i => i.available).id")

# reset rate-limit counters (local stacks only)
reset_limits() { dc exec -T redis redis-cli EVAL "for _,k in ipairs(redis.call('KEYS','ratelimit:*')) do redis.call('DEL',k) end return 1" 0 >/dev/null; }

# place a paid order: sets ORDER and PAYMENT; $1 = true to simulate a decline
place_order() {
  curl -s -X DELETE $API/api/cart -H "Authorization: Bearer $CUSTOMER" >/dev/null
  curl -s -X POST $API/api/cart/items -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' \
       -d "{\"menuItemId\":\"$ITEM\",\"quantity\":1}" >/dev/null
  ORDER=$(curl -s -X POST $API/api/orders -H "Authorization: Bearer $CUSTOMER" \
       -H "Idempotency-Key: $(node -e 'console.log(crypto.randomUUID())')" | j id)
  PAYMENT=$(curl -s -X POST $API/api/payments -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' \
       -d "{\"orderId\":\"$ORDER\"}" | j id)
  curl -s -X POST $API/api/payments/$PAYMENT/process -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' \
       -d "{\"simulateFailure\":${1:-false}}" | j status
}

# restaurant + driver steps for $ORDER: sets DELIVERY; stops before pickup if $1 = assign-only
deliver_order() {
  for s in PREPARING READY_FOR_PICKUP; do
    curl -s -X PATCH $API/api/orders/$ORDER/status -H "Authorization: Bearer $OWNER" -H 'content-type: application/json' -d "{\"status\":\"$s\"}" >/dev/null
  done
  DELIVERY=$(curl -s -X POST $API/api/deliveries -H "Authorization: Bearer $OWNER" -H 'content-type: application/json' -d "{\"orderId\":\"$ORDER\"}" | j id)
  # assignment picks the most recently updated AVAILABLE driver: cycle ours so it wins
  curl -s -X POST $API/api/drivers/me/offline -H "Authorization: Bearer $DRIVER" >/dev/null
  curl -s -X POST $API/api/drivers/me/online  -H "Authorization: Bearer $DRIVER" >/dev/null
  curl -s -X POST $API/api/deliveries/$DELIVERY/assign -H "Authorization: Bearer $OWNER" >/dev/null
  [ "$1" = assign-only ] && return
  for a in pickup start complete; do
    curl -s -X POST $API/api/deliveries/$DELIVERY/$a -H "Authorization: Bearer $DRIVER" >/dev/null
  done
}

# database, Redis and Kafka shells
psql_db() { local db=$1; shift; dc exec postgres psql -U postgres -d "$db" "$@"; }   # psql_db order_service [-c "SQL"]
alias rcli='dc exec redis redis-cli'
alias kt='dc exec kafka kafka-topics --bootstrap-server localhost:9092'
alias kcc='dc exec kafka kafka-console-consumer --bootstrap-server localhost:9092'
alias kcp='dc exec -T kafka kafka-console-producer --bootstrap-server localhost:9092'
alias kcg='dc exec kafka kafka-consumer-groups --bootstrap-server localhost:9092'
```

Notes:
- Login is rate-limited (5 per minute per IP). Tokens last 1 hour; reuse the variables. Run `reset_limits` if you hit 429 while experimenting.
- Order creation is limited to 5 per minute per customer; labs that place many orders call `reset_limits` between batches.
- If the driver is left `BUSY` by an interrupted lab, finish that delivery (`pickup`, `start`, `complete`) or cancel it as the owner (`POST /api/deliveries/$DELIVERY/cancel`).
- The E2E stack (`npm run e2e:env:reset`, gateway `:3100`, project `delivery-plus-e2e`) is used by the E2E labs; see `docs/e2e.md`.

## Lab catalogue

| File | Labs |
| --- | --- |
| [database-labs.md](database-labs.md) | DB-01 … DB-13 — constraints, joins, indexes, isolation, CAS, pagination, deadlocks, trigram search, migrations, connections, MVCC, plans, locks |
| [redis-labs.md](redis-labs.md) | RD-01 … RD-08 — keyspace, cart race, stampede, rate limiter, persistence, GEO, Lua leases, Pub/Sub vs Streams |
| [kafka-labs.md](kafka-labs.md) | KF-01 … KF-14 — produce/consume, groups, partitions, rebalance, offsets, lag, redelivery, replay, DLQ, ordering, acks, contracts, lifecycle trace |
| [distributed-systems-labs.md](distributed-systems-labs.md) | DS-01 … DS-12 — timeouts, double submit, payment retry, duplicate events, concurrent writers, retry-safe delivery, consumer crash, declined payment, partial failure, saga, outbox, retry storm |
| [devops-labs.md](devops-labs.md) | OPS-01 … OPS-14 — containers, layers, shutdown, Kafka outage, load test, DNS/ports, backups, health, resources, paused services, emulator networking, Kubernetes translation, log correlation, polling load |
| [geo-and-algorithms-labs.md](geo-and-algorithms-labs.md) | GEO-01 … GEO-08 — complexity, sets, lifecycle graphs, Haversine, nearest-k, Dijkstra/A*, matching, geofencing |
| [security-labs.md](security-labs.md) | SEC-01 … SEC-08 — status codes, JWT, system tokens, brute force, uploads, least privilege, BOLA, self-registered admin |
| [e2e-labs.md](e2e-labs.md) | E2E-01 … E2E-05 — E2E environment, login/checkout, failure screenshots, business flow, driver-app suite design |

Lab-only code (Node snippets, SQL) lives inside the lab pages; nothing in this folder is executed by CI.

---

[Library index](../README.md)
