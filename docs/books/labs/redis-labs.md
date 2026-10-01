# Redis Labs

[Lab index](README.md) · Book: [06 Redis](../06-redis.md)

Set up the [lab environment](README.md#lab-environment) first (`rcli` = `redis-cli` inside the Redis container).

---

## RD-01 Tour the keyspace

**Goal:** find every key pattern the platform uses and its lifetime.
```bash
npm run e2e >/dev/null 2>&1; reset_limits
place_order >/dev/null
rcli --scan --count 1000 | sed -E 's/[0-9a-f-]{36}/<id>/g' | sort | uniq -c | sort -rn
for k in $(rcli --scan --pattern 'cart:*' | head -1) $(rcli --scan --pattern 'restaurant:*' | head -1) \
         $(rcli --scan --pattern 'kafka:idempotency:*' | head -1); do
  echo "$k  type=$(rcli TYPE $k)  ttl=$(rcli TTL $k)s"; done
```
**Expected:** patterns from the key table in [Book 06](../06-redis.md): `cart:<id>`, `ratelimit:/…:<id>`, `restaurant:<id>`, `menu:<id>`, `menuitem:<id>`, `kafka:idempotency:<group>:<id>`, `internal-auth:nonce:…` (after a registration), `driver:location:<id>` (after a location post). Restaurant TTL ≤ 30 s, menu ≤ 60 s, cart ≤ 86400 s, idempotency markers ≈ 7 days.
**Why:** every Redis use in Delivery Plus is a string key with a TTL; the TTL encodes how long the data is "true".

---

## RD-02 Lost update in the cart

**Goal:** reproduce the read-modify-write race in `CartService.addItem`.
```bash
ITEM2=$(curl -s -X POST $API/api/menus/menu-items -H "Authorization: Bearer $OWNER" -H 'content-type: application/json' \
  -d "{\"restaurantId\":\"$RID\",\"name\":\"Lab Fries\",\"price\":3.5}" | j id)
lost=0
for n in $(seq 1 8); do
  reset_limits
  curl -s -X DELETE $API/api/cart -H "Authorization: Bearer $CUSTOMER" >/dev/null
  for it in $ITEM $ITEM2; do
    curl -s -X POST $API/api/cart/items -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' \
         -d "{\"menuItemId\":\"$it\",\"quantity\":1}" >/dev/null &
  done; wait
  lines=$(curl -s $API/api/cart -H "Authorization: Bearer $CUSTOMER" | j "items.length")
  [ "$lines" -lt 2 ] && lost=$((lost+1))
done
echo "lost updates: $lost / 8"
```
**Expected:** some runs end with **one** line instead of two (timing-dependent; the HTTP call to menu-service between `GET` and `SET` widens the window).
**Why:** `addItem` does `find` → modify in Node → `save` (full JSON `SET`). Two requests read the same old cart and the second write overwrites the first.
**The fix, by hand:**
```text
rcli HSET labcart:u1 burger 1
rcli HINCRBY labcart:u1 fries 1      # each line updated atomically, no read-modify-write
rcli HGETALL labcart:u1 ; rcli DEL labcart:u1
```
(or `WATCH cart:<id>` + `MULTI/EXEC` with retry).
**Cleanup:** `curl -s -X DELETE $API/api/menus/menu-items/$ITEM2 -H "Authorization: Bearer $OWNER"`.
**Links:** [Book 06 Ch. 6](../06-redis.md#chapter-6--atomicity-lua-watch-and-distributed-locks).

---

## RD-03 Cache stampede on the menu

**Goal:** count database queries during concurrent cache misses.
```bash
psql_db postgres -c "ALTER SYSTEM SET log_min_duration_statement = 0;" -c "SELECT pg_reload_conf();"
rcli DEL menu:$RID
for i in $(seq 1 50); do curl -s -o /dev/null "$API/api/menus/restaurants/$RID/menu" & done; wait
dc logs --since 30s postgres 2>&1 | grep -c 'FROM "categories"'
psql_db postgres -c "ALTER SYSTEM RESET log_min_duration_statement;" -c "SELECT pg_reload_conf();"
```
**Expected:** many (up to 50) category queries instead of one — every concurrent miss rebuilt the same key.
**Why:** `CacheService.getOrSet` (`shared/src/redis/cache.service.ts`) is plain cache-aside: no lock, no request coalescing.
**Extension:** sketch single-flight — `SET lock:menu:<id> 1 NX PX 2000`; the winner rebuilds, others wait briefly and re-read the cache.
**Links:** [Book 06 Ch. 4](../06-redis.md#chapter-4--caching-patterns-and-invalidation), [Book 02 Ch. 9](../02-data-structures-and-algorithms.md#chapter-9--caching-algorithms).

---

## RD-04 Fixed-window rate limiter

**Goal:** observe the limiter's algorithm and its two weaknesses.
```bash
reset_limits
for i in $(seq 1 35); do printf "%s " $(curl -s -o /dev/null -w "%{http_code}" $API/api/cart -H "Authorization: Bearer $CUSTOMER"); done; echo
rcli --scan --pattern 'ratelimit:*' | while read k; do echo "$k = $(rcli GET $k) ttl=$(rcli TTL $k)"; done
```
**Expected:** `200` ×30 then `429`; one key `ratelimit:/cart:<customerId>` (the route path as seen by cart-service after the gateway strips `/api`) with a value ~35 and a TTL ≤ 60.
**Boundary burst:** wait until the TTL is ~1 s, send 30 requests, then 30 more right after expiry → 60 accepted requests in ~2 seconds.
**Atomicity gap (simulated crash between `INCR` and `EXPIRE`):**
```bash
rcli INCR ratelimit:/lab:demo ; rcli TTL ratelimit:/lab:demo     # TTL -1: this key never expires
rcli DEL ratelimit:/lab:demo
```
**Why:** `RateLimiterService.incrementAndCheck` runs `INCR`, then `EXPIRE` only when the count is 1, as two commands. A one-round-trip Lua version is in [Book 06 Ch. 5](../06-redis.md#chapter-5--counters-and-rate-limiting).

---

## RD-05 Restart Redis with and without AOF

**Goal:** see what persistence (and the volume) buys.
```bash
place_order >/dev/null                                   # creates a cart and idempotency markers…
curl -s -X POST $API/api/cart/items -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' \
     -d "{\"menuItemId\":\"$ITEM\",\"quantity\":2}" >/dev/null   # …and a fresh cart line
rcli CONFIG GET appendonly
dc up -d --force-recreate --wait redis                   # new container, same redis_data volume
curl -s $API/api/cart -H "Authorization: Bearer $CUSTOMER" | j "items.length"
rcli DBSIZE
```
Compare with a throwaway Redis without a volume:
```bash
docker run -d --name lab-redis redis:7-alpine
docker exec lab-redis redis-cli SET lab:key 1
docker rm -f lab-redis && docker run -d --name lab-redis redis:7-alpine
docker exec lab-redis redis-cli GET lab:key            # (nil)
docker rm -f lab-redis
```
**Expected:** the platform's cart survives container recreation; the throwaway key doesn't.
**Why:** `--appendonly yes` + the `redis_data` volume (`docker-compose.base.yml`). Without them, processed-event markers vanish too, and a Kafka replay would re-run side effects.

---

## RD-06 Redis GEO nearest drivers

**Goal:** try the future nearest-driver data structure on the real Redis.
```bash
rcli GEOADD lab:drivers 31.2357 30.0444 d1 31.2400 30.0500 d2 31.3000 30.1000 d3 31.2200 30.0300 d4
rcli GEOSEARCH lab:drivers FROMLONLAT 31.24 30.05 BYRADIUS 3 km ASC WITHDIST COUNT 3
rcli GEODIST lab:drivers d1 d2 km
node -e '
const R=6371,r=d=>d*Math.PI/180,h=(a,b)=>{const dl=r(b[1]-a[1]),dg=r(b[0]-a[0]);const x=Math.sin(dl/2)**2+Math.cos(r(a[1]))*Math.cos(r(b[1]))*Math.sin(dg/2)**2;return 2*R*Math.asin(Math.sqrt(x));};
console.log(h([31.2357,30.0444],[31.2400,30.0500]).toFixed(4),"km");'
rcli DEL lab:drivers
```
**Expected:** results sorted by distance; `d3` excluded beyond 3 km; `GEODIST` and the Haversine value agree within a few metres.
**Why:** a GEO set is a sorted set scored by geohash; `GEOSEARCH` checks the covering cells. Note the `longitude latitude` argument order.
**Stale-location variant:** `rcli TTL driver:location:<driverUserId>` after posting a location (`POST /api/tracking/location {"latitude":30.04,"longitude":31.23}` with the driver token); wait 300 s → the key is gone and `GET /api/tracking/delivery/<id>` returns `location: null`.
**Links:** [Book 23 Ch. 2](../23-geo-location-systems.md#chapter-2--radius-search-bounding-boxes-and-spatial-indexes).

---

## RD-07 Idempotency lease with Lua

**Goal:** run the exact scripts behind durable Kafka idempotency (`shared/src/kafka/durable-event-idempotency.scripts.ts`).
```bash
ACQ="if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then return 'acquired' end
local c = redis.call('GET', KEYS[1]) if c == ARGV[1] then return 'acquired' end
if c == 'processed' then return 'processed' end return 'in-progress'"
MARK="local c = redis.call('GET', KEYS[1]) if c == 'processed' then return 0 end
redis.call('SET', KEYS[1], 'processed', 'PX', ARGV[2]) if c == ARGV[1] then return 1 end return 0"
REL="if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0"
K=kafka:idempotency:lab-group:evt-1
rcli EVAL "$ACQ" 1 $K lease:A 60000     # acquired
rcli EVAL "$ACQ" 1 $K lease:B 60000     # in-progress (A holds it)
rcli EVAL "$REL" 1 $K lease:B           # 0 — B can't release A's lease
rcli EVAL "$MARK" 1 $K lease:A 604800000  # 1 — A still owned it
rcli EVAL "$ACQ" 1 $K lease:C 60000     # processed — redelivery skipped
rcli DEL $K
```
**Expected:** `acquired`, `in-progress`, `0`, `1`, `processed`.
**Expiry variant:** acquire with a 2000 ms lease, wait 3 s, acquire as B → `acquired`; then `MARK` as A → `0` ("my lease had expired; the handler may have run twice").
**Links:** [Book 06 Ch. 6–7](../06-redis.md#chapter-7--idempotency-records-and-nonces-in-redis), [Book 09 Ch. 9](../09-distributed-systems.md#chapter-9--distributed-locks-leases-and-fencing-tokens).

---

## RD-08 Pub/Sub vs Streams

```bash
# Pub/Sub: publish before subscribing — the message is lost
rcli PUBLISH lab:delivery:1 '{"lat":30.04}'
dc exec redis sh -c 'timeout 5 redis-cli SUBSCRIBE lab:delivery:1' &   # starts listening now
sleep 1; rcli PUBLISH lab:delivery:1 '{"lat":30.05}'; wait            # only the second message arrives

# Streams: a late reader still gets everything
rcli XADD lab:stream '*' lat 30.04
rcli XADD lab:stream '*' lat 30.05
rcli XGROUP CREATE lab:stream lab-group 0
rcli XREADGROUP GROUP lab-group c1 COUNT 10 STREAMS lab:stream '>'
rcli XPENDING lab:stream lab-group
rcli DEL lab:stream
```
**Expected:** Pub/Sub delivers only to subscribers present at publish time; the stream returns both entries to a group created afterwards, and tracks them as pending until `XACK`.
**Why:** Pub/Sub fits ephemeral live locations; streams (or Kafka) fit data that must not be lost.
**Links:** [Book 06 Ch. 9](../06-redis.md#chapter-9--pubsub-vs-streams-and-redis-high-availability), [Book 22 Ch. 3](../22-real-time-systems.md#chapter-3--fan-out-pubsub-presence-and-backpressure).

---

[Lab index](README.md)
