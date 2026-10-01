# Algorithms & Geo Labs

[Lab index](README.md) · Books: [02 Data Structures & Algorithms](../02-data-structures-and-algorithms.md), [23 Geo / Location Systems](../23-geo-location-systems.md)

Most labs here are self-contained Node scripts (Node 22): save the snippet as `/tmp/lab.js` (or anywhere outside the repo) and run `node /tmp/lab.js`. Labs marked *stack* also use the [lab environment](README.md#lab-environment).

---

## GEO-01 Complexity of offset pagination

*Stack.* Generate data as in [DB-03](database-labs.md#db-03-index-vs-sequential-scan), then:
```bash
for off in 0 1000 10000 100000 190000; do
  printf "offset %6s: " $off
  psql_db notification_service -tAc "EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM notifications ORDER BY \"createdAt\" DESC OFFSET $off LIMIT 20" | \
    node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"))[0]; console.log(p["Execution Time"].toFixed(1)+" ms")'
done
```
**Expected:** execution time grows roughly linearly with the offset — O(offset + limit).
**Why:** PostgreSQL must produce and discard every skipped row; see [DB-06](database-labs.md#db-06-offset-vs-keyset-pagination) for the keyset fix.

---

## GEO-02 Set vs array membership

```js
for (const n of [1e3, 1e4, 1e5, 1e6]) {
  const ids = Array.from({ length: n }, (_, i) => `evt-${i}`);
  const set = new Set(ids);
  const probes = Array.from({ length: 1000 }, (_, i) => `evt-${(i * 7919) % (2 * n)}`);
  let t = performance.now(); probes.forEach(p => ids.includes(p)); const arr = performance.now() - t;
  t = performance.now(); probes.forEach(p => set.has(p)); const st = performance.now() - t;
  console.log(`n=${n}`.padEnd(10), `array ${arr.toFixed(2)} ms`.padEnd(18), `set ${st.toFixed(3)} ms`);
}
```
**Expected:** array time grows ~10× per row; set time stays flat.
**Connect:** the Kafka consumer's in-process fallback (`processedInMemory`) is a `Set` — O(1) lookups, but unbounded memory and per-process ([Book 02 Ch. 2](../02-data-structures-and-algorithms.md#chapter-2--arrays-hash-maps-and-sets)).

---

## GEO-03 Validate the lifecycle graphs

*Uses the real transition tables.* From the `delivery-plus` root:
```bash
npm run build --workspace=@food-delivery/shared >/dev/null
node -e '
const s = require("./shared/dist");
const graphs = { order: s.ORDER_TRANSITIONS, delivery: s.DELIVERY_TRANSITIONS, payment: s.PAYMENT_TRANSITIONS, driver: s.DRIVER_TRANSITIONS };
for (const [name, g] of Object.entries(graphs)) {
  const nodes = Object.keys(g), color = {}; let cycle = false;
  const dfs = (n) => { color[n] = 1; for (const m of g[n] || []) { if (color[m] === 1) cycle = true; else if (!color[m]) dfs(m); } color[n] = 2; };
  nodes.forEach(n => color[n] || dfs(n));
  const terminal = nodes.filter(n => (g[n] || []).length === 0);
  console.log(name.padEnd(9), cycle ? "CYCLIC " : "acyclic", "terminal:", terminal.join(","));
}
const reach = (g, start) => { const seen = new Set([start]), q = [start]; while (q.length) { const n = q.shift(); for (const m of g[n] || []) if (!seen.has(m)) { seen.add(m); q.push(m); } } return seen; };
console.log("statuses that can still reach DELIVERED:", Object.keys(s.ORDER_TRANSITIONS).filter(n => reach(s.ORDER_TRANSITIONS, n).has("DELIVERED")).join(","));'
```
**Expected:** order, delivery and payment are acyclic; driver is cyclic (AVAILABLE ↔ BUSY); order terminals are DELIVERED, CANCELLED, FAILED.
**Why it matters:** acyclic lifecycles are what make `lifecycleEventId(entity, type)` unique per entity ([Book 02 Ch. 6](../02-data-structures-and-algorithms.md#chapter-6--graphs-state-machines-bfs-and-dfs)).

---

## GEO-04 Haversine and bounding box

```js
const R = 6371, rad = d => d * Math.PI / 180;
const haversine = (a, b) => { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)); };
const bbox = (c, km) => { const dLat = km / 111.32, dLng = km / (111.32 * Math.cos(rad(c.lat)));
  return { minLat: c.lat - dLat, maxLat: c.lat + dLat, minLng: c.lng - dLng, maxLng: c.lng + dLng }; };

const pickup = { lat: 30.0444, lng: 31.2357 };                       // Cairo
const points = Array.from({ length: 200000 }, () => ({ lat: 30 + Math.random() * 0.2, lng: 31.15 + Math.random() * 0.2 }));
let t = performance.now(); const brute = points.filter(p => haversine(pickup, p) <= 3).length; const tb = performance.now() - t;
t = performance.now(); const b = bbox(pickup, 3);
const pre = points.filter(p => p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng);
const filtered = pre.filter(p => haversine(pickup, p) <= 3).length; const tf = performance.now() - t;
console.log({ brute, filtered, candidatesAfterBox: pre.length, bruteMs: tb.toFixed(1), boxedMs: tf.toFixed(1) });
console.log("naive Euclid on degrees (wrong):", (Math.hypot(0.01, 0.01) * 111.32).toFixed(3), "km vs haversine",
  haversine(pickup, { lat: pickup.lat + 0.01, lng: pickup.lng + 0.01 }).toFixed(3), "km");
```
**Expected:** both methods find the same count; the bounding box cuts exact computations to a small fraction; the naive degree distance is noticeably wrong east–west.
**Stack check:** `rcli GEOADD lab:g 31.2357 30.0444 a 31.2457 30.0544 b; rcli GEODIST lab:g a b km` ≈ your Haversine for the same pair; `rcli DEL lab:g`.

---

## GEO-05 Nearest K drivers

```js
const R = 6371, rad = d => d * Math.PI / 180;
const dist = (a, b) => { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const drivers = Array.from({ length: 50000 }, (_, i) => ({ id: `d${i}`, lat: 29.9 + Math.random() * 0.3, lng: 31.1 + Math.random() * 0.3 }));
const pickup = { lat: 30.0444, lng: 31.2357 }, K = 5;

let t = performance.now();
const bySort = drivers.map(d => ({ id: d.id, km: dist(pickup, d) })).sort((a, b) => a.km - b.km).slice(0, K);
const sortMs = performance.now() - t;

t = performance.now();                       // bounded max-heap of size K
const heap = []; const up = i => { while (i > 0) { const p = (i - 1) >> 1; if (heap[p].km >= heap[i].km) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
const down = i => { for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].km > heap[m].km) m = l; if (r < heap.length && heap[r].km > heap[m].km) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } };
for (const d of drivers) { const c = { id: d.id, km: dist(pickup, d) };
  if (heap.length < K) { heap.push(c); up(heap.length - 1); } else if (c.km < heap[0].km) { heap[0] = c; down(0); } }
const byHeap = heap.sort((a, b) => a.km - b.km); const heapMs = performance.now() - t;
console.log("same result:", JSON.stringify(bySort.map(x => x.id)) === JSON.stringify(byHeap.map(x => x.id)), { sortMs: sortMs.toFixed(1), heapMs: heapMs.toFixed(1) });
require("fs").writeFileSync("/tmp/geoadd.txt", drivers.map(d => `GEOADD lab:drivers ${d.lng} ${d.lat} ${d.id}`).join("\n"));
console.log("expected nearest:", byHeap.map(x => `${x.id}:${x.km.toFixed(3)}`).join(" "));
```
*Stack:* load the same drivers into Redis and ask Redis:
```bash
dc exec -T redis redis-cli < /tmp/geoadd.txt > /dev/null
rcli GEOSEARCH lab:drivers FROMLONLAT 31.2357 30.0444 BYRADIUS 50 km ASC COUNT 5 WITHDIST
rcli DEL lab:drivers
```
**Expected:** heap and sort agree; Redis returns the same five IDs (distances within metres).
**Discuss:** today's dispatch ignores distance entirely (`ORDER BY "updatedAt" DESC LIMIT 1`); see [case study 20](../case-studies/20-nearest-driver-search.md).

---

## GEO-06 Dijkstra vs A* on a grid

```js
const W = 120, H = 120, wall = new Set();
for (let y = 10; y < 110; y++) wall.add(`60,${y}`);            // a river with a bridge at the top and bottom
const start = [5, 60], goal = [115, 60];
const key = (x, y) => `${x},${y}`, nbrs = ([x, y]) => [[1,0],[-1,0],[0,1],[0,-1]].map(([dx, dy]) => [x + dx, y + dy])
  .filter(([a, b]) => a >= 0 && b >= 0 && a < W && b < H && !wall.has(key(a, b)));
function search(h) {
  const dist = new Map([[key(...start), 0]]), open = [[h(start), start]]; let expanded = 0;
  while (open.length) { open.sort((a, b) => a[0] - b[0]); const [, cur] = open.shift(); expanded++;
    if (cur[0] === goal[0] && cur[1] === goal[1]) return { cost: dist.get(key(...cur)), expanded };
    for (const n of nbrs(cur)) { const d = dist.get(key(...cur)) + 1;
      if (d < (dist.get(key(...n)) ?? Infinity)) { dist.set(key(...n), d); open.push([d + h(n), n]); } } }
}
console.log("dijkstra", search(() => 0));
console.log("A*      ", search(([x, y]) => Math.abs(goal[0] - x) + Math.abs(goal[1] - y)));
console.log("straight-line distance:", goal[0] - start[0]);
```
**Expected:** the same path cost (well above the straight-line 110 because of the river); A* expands far fewer nodes.
**Why:** an admissible heuristic steers the search without losing optimality — and straight-line distance is a poor ETA ([Book 02 Ch. 7](../02-data-structures-and-algorithms.md#chapter-7--shortest-paths-dijkstra-and-a-routing--eta)).

---

## GEO-07 Greedy vs batch assignment

```js
const orders = { O1: [0, 10], O2: [0, -10], O3: [6, 0], O4: [-6, 0] };
const drivers = { D1: [0, 1], D2: [0, 14], D3: [5, -2], D4: [-9, 0] };
const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const greedy = () => { const free = new Set(Object.keys(drivers)); let total = 0; const plan = [];
  for (const [o, p] of Object.entries(orders)) { const best = [...free].sort((a, b) => d(drivers[a], p) - d(drivers[b], p))[0];
    free.delete(best); total += d(drivers[best], p); plan.push(`${o}→${best}`); } return { plan, total: total.toFixed(1) }; };
const perms = a => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
const optimal = () => { const os = Object.keys(orders); let best;
  for (const p of perms(Object.keys(drivers))) { const total = os.reduce((s, o, i) => s + d(drivers[p[i]], orders[o]), 0);
    if (!best || total < best.total) best = { plan: os.map((o, i) => `${o}→${p[i]}`), total }; }
  return { ...best, total: best.total.toFixed(1) }; };
console.log("greedy (arrival order):", greedy());
console.log("batch optimal:         ", optimal());
```
**Expected:** batch optimal total ≤ greedy total, often clearly lower; brute force is 4! = 24 permutations — fine here, impossible for 50 (use the Hungarian algorithm, O(n³)).
**Discuss:** batching means waiting a few seconds to collect orders — a latency/quality trade-off ([Book 02 Ch. 8](../02-data-structures-and-algorithms.md#chapter-8--greedy-algorithms-ranking-and-matching-dispatch), [case study 19](../case-studies/19-driver-dispatch.md)).

---

## GEO-08 Geofence with hysteresis

```js
const R = 6371000, rad = x => x * Math.PI / 180;
const dist = (a, b) => { const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const restaurant = { lat: 30.0444, lng: 31.2357 };
const track = []; for (let i = 0; i < 120; i++) {               // approach, linger at ~80 m, leave; with 15 m GPS noise
  const base = i < 40 ? 400 - i * 8 : i < 80 ? 80 : 80 + (i - 80) * 8;
  const noisy = base + (Math.random() - 0.5) * 30; track.push({ lat: restaurant.lat + noisy / 111320, lng: restaurant.lng });
}
let naiveEvents = 0, inside = false; for (const p of track) { const now = dist(p, restaurant) < 80; if (now !== inside) { naiveEvents++; inside = now; } }
let hystEvents = 0, state = "out", streak = 0;
for (const p of track) { const m = dist(p, restaurant);
  if (state === "out") { streak = m < 80 ? streak + 1 : 0; if (streak >= 3) { state = "in"; hystEvents++; streak = 0; } }
  else { streak = m > 150 ? streak + 1 : 0; if (streak >= 3) { state = "out"; hystEvents++; streak = 0; } } }
console.log({ naiveEvents, hysteresisEvents: hystEvents });
```
**Expected:** the naive single-threshold fence flips many times while the driver lingers near 80 m; hysteresis (enter < 80 m for 3 points, exit > 150 m for 3 points) produces 2 events.
**Why:** GPS noise near a boundary; geofence decisions must also run server-side on trusted data (issue #60, [Book 23 Ch. 5](../23-geo-location-systems.md#chapter-5--geofencing)).

---

[Lab index](README.md)
