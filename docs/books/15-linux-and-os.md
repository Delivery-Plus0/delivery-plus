# Book 15 — Linux & Operating System Fundamentals

[Library index](README.md) · Previous: [Book 14](14-docker-and-containers.md) · Next: [Book 16 — Networking](16-networking.md)

**Level:** Junior → Intermediate · **Prerequisites:** a terminal. All commands run against the local Delivery Plus stack (`alias dc='docker compose -f docker-compose.base.yml -f docker-compose.dev.yml'`). Alpine-based images ship BusyBox versions of common tools; when a tool is missing, run it from the host or a debug container (`docker run --rm -it --network container:delivery-plus-order-service-1 nicolaka/netshoot`).

---

## Chapter 1 — Processes, threads and scheduling

### 1. Why this exists
Every performance and stability question eventually becomes "what are the processes doing with CPU and time?".

### 2. Core concept
- **Process**: an isolated address space with one or more **threads**; scheduled by the kernel.
- **Scheduling**: the kernel time-slices runnable threads across CPU cores.
- **Concurrency models** in this stack:
  - **Node.js** (all 12 services): one JavaScript thread with an **event loop**; I/O is asynchronous; a small libuv thread pool handles DNS, file system and crypto (e.g. bcrypt).
  - **PostgreSQL**: one process per connection.
  - **Redis**: one main thread executes commands.
  - **Kafka**: JVM with many threads.

### 3. Mental model
In Node, anything CPU-heavy on the main thread blocks *every* request in that process.

### 4. Delivery Plus mapping
- `bcrypt.hash(password, 10)` and `bcrypt.compare` in `services/auth-service/src/services/auth.service.ts` run on libuv's thread pool (async API) — good; a synchronous `hashSync` would block the event loop for ~50–100 ms per login.
- `JSON.parse` of large values (a big cart or menu) runs on the main thread.

### 5. Example
```bash
dc top order-service
docker stats --no-stream
```

### 6. Failure scenario — a synchronous CPU loop (e.g. computing distances to 100,000 drivers in JavaScript on every request) makes p99 latency of *all* endpoints in that service spike.
### 7. Trade-offs — Node's single thread is simple and great for I/O-bound services; CPU-bound work needs worker threads or a separate service.
### 8. Performance — measure event-loop lag (FUTURE metric, [Book 20](20-observability.md)).
### 9. Security — CPU-heavy endpoints are DoS amplifiers; rate-limit them (login is limited to 5/min partly for this reason).
### 10. Operations — `docker stats` CPU% above ~90% for a Node service usually means a blocked event loop, not "needs more cores".

### 11. Lab
[OPS-01 Look inside a container](labs/devops-labs.md#ops-01-look-inside-a-container).

### 12. Verification
You can list the process tree of the postgres container and explain the per-connection backends.

### 13. Interview questions
- *Beginner:* Process vs thread?
- *Intermediate:* Why does one slow synchronous function hurt all requests in Node?
- *Advanced:* What runs on libuv's thread pool?
- *Senior:* When would you move a computation out of a Node service?

### 14. Senior discussion
Nearest-driver ranking (future) is CPU work. Node worker thread, Redis GEO server-side, or a separate service in another language?

---

## Chapter 2 — Memory and virtual memory

### 1. Why this exists
"Out of memory" kills processes; "memory leak" kills them slowly.

### 2. Core concept
- **Virtual memory**: each process sees its own address space; the kernel maps pages to RAM (or swap).
- **RSS**: resident memory actually in RAM. **VSZ**: virtual size (often huge, mostly irrelevant).
- **Page cache**: file data cached in free RAM — PostgreSQL and Kafka rely on it heavily.
- **OOM killer**: under memory pressure (or a cgroup limit), the kernel kills a process (exit 137).
- **V8 heap**: Node's JS heap has its own limit (`--max-old-space-size`).

### 3. Mental model
Free memory is wasted memory — Linux fills it with page cache and gives it back on demand.

### 4. Delivery Plus mapping
- No container memory limits (Book 14 Ch. 7) — a leak can consume the host.
- Known unbounded in-process structures: the Kafka consumer's in-memory fallback `Set` (only used when durable idempotency is off); the customer app's resource cache is per device.
- Redis keeps its dataset in RAM with no `maxmemory` (Book 06 Ch. 3).

### 5. Example
```bash
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}'
dc exec redis redis-cli INFO memory | grep used_memory_human
```

### 6. Failure scenario — Kafka's JVM heap is small, but the broker relies on page cache; starving the host of RAM makes consumer reads hit disk and lag grows.
### 7. Trade-offs — memory limits protect neighbours but OOM-kill spikes; set them from measurement.
### 8. Performance — cache hit ratios (PostgreSQL buffers, page cache, Redis) are memory decisions.
### 9. Security — memory dumps contain secrets (JWT secret, DB passwords) — restrict core dumps in production.
### 10. Operations — track RSS over days; a slope is a leak.

### 11. Lab
[OPS-09 Resource exhaustion](labs/devops-labs.md#ops-09-resource-exhaustion).

### 12. Verification
You trigger an OOM kill of a service with a tiny memory limit and see exit code 137 and the restart.

### 13. Interview questions
- *Beginner:* RSS vs VSZ?
- *Intermediate:* What is the page cache?
- *Advanced:* Container memory limit vs V8 heap limit?
- *Senior:* How do you find a slow memory leak in production?

### 14. Senior discussion
Would you set `--max-old-space-size` explicitly for each service? How would it relate to the container limit?

---

## Chapter 3 — File descriptors, sockets, signals and exit codes

### 1. Why this exists
Every connection, file and pipe is a file descriptor; every container stop is a signal.

### 2. Core concept
- **File descriptor (fd)**: an integer handle to an open file, socket or pipe; limited per process (`ulimit -n`).
- **Socket**: an fd for network communication; TCP sockets have states (LISTEN, ESTABLISHED, TIME_WAIT…).
- **Signals**: `SIGTERM` (please stop), `SIGINT` (Ctrl-C), `SIGKILL` (cannot be caught), `SIGHUP`.
- **Exit codes**: 0 success, 1 generic error, 137 = 128 + 9 (SIGKILL), 143 = 128 + 15 (SIGTERM).

### 3. Mental model
A process's "open connections" are just fds. Running out of fds looks like "connection refused" or `EMFILE`.

### 4. Delivery Plus mapping
- Each service holds sockets to PostgreSQL (pool), Redis, Kafka (brokers), other services (keep-alive).
- Signals: no app handles `SIGTERM` gracefully (issue #7); Docker sends `SIGKILL` after 10 s → exit 137.
- `bootstrap()` in service `main.ts` files has no `.catch` (the gateway's does): a startup failure becomes an unhandled rejection.

### 5. Example
```bash
dc exec order-service sh -c 'ls /proc/1/fd | wc -l'      # open fds of the node process
dc exec order-service sh -c 'cat /proc/1/limits | grep "open files"'
```

### 6. Failure scenario — a connection leak (opening a new client per request and never closing it) grows fds until `EMFILE`; the service still answers `/health` (already-open socket) but fails every new outbound call.
### 7. Trade-offs — higher fd limits postpone the symptom; fixing the leak removes it.
### 8. Performance — reusing connections (keep-alive, pools) saves handshakes and fds.
### 9. Security — signals can only be sent by the same user or root; in containers that's mostly the runtime.
### 10. Operations — exit codes are the first clue in a crash loop.

### 11. Lab
[OPS-03 Graceful shutdown](labs/devops-labs.md#ops-03-graceful-shutdown).

### 12. Verification
You interpret exit codes 0, 1, 137 and 143 from real containers.

### 13. Interview questions
- *Beginner:* What is a file descriptor?
- *Intermediate:* What does exit code 137 mean?
- *Advanced:* SIGTERM vs SIGKILL handling?
- *Senior:* Debug "service healthy but all outbound calls fail".

### 14. Senior discussion
Should health checks verify outbound capacity (e.g. a Redis ping), or does that make liveness depend on dependencies?

---

## Chapter 4 — Permissions, ownership, namespaces and cgroups

### 1. Why this exists
Who can read what — on the host and in containers — decides the blast radius of a compromise.

### 2. Core concept
- Unix permissions (`rwx` for user/group/other), ownership (uid/gid), root (uid 0).
- **User namespaces** map container uids to host uids (rarely enabled by default in Docker).
- **Capabilities** split root's powers; Docker drops many by default.
- **cgroups v2**: CPU, memory, I/O, PID limits per container.

### 3. Mental model
Root inside a default Docker container is root on the host's files that are mounted into it.

### 4. Delivery Plus mapping — **CURRENT**: service images run as root (no `USER` in the `Dockerfile`, issue #14); infrastructure images (postgres, redis) drop to their own users internally; the PostgreSQL init script is mounted read-only (`:ro`).
### 5. Example
```bash
dc exec order-service id           # uid=0(root)
dc exec postgres id postgres       # postgres runs as uid 70 on Alpine
```
### 6. Failure scenario — a path-traversal bug writing files + root + a writable bind mount = arbitrary file write on the host directory.
### 7. Trade-offs — non-root images need correct file ownership at build time.
### 8. Performance — none.
### 9. Security — least privilege at the OS level mirrors least privilege in the database ([Book 04 Ch. 11](04-database-fundamentals.md#chapter-11--database-security-and-least-privilege)).
### 10. Operations — read-only root filesystems (`read_only: true`) prevent tampering; services here only need `/tmp`.

### 11. Lab
Run `id` in every service container (`for s in $(dc ps --services); do echo $s; dc exec $s id; done`) and list which run as root.

### 12. Verification
Your list matches: all Node services root; postgres/redis non-root processes.

### 13. Interview questions
- *Beginner:* What does `chmod 640` mean?
- *Intermediate:* Why run containers as non-root?
- *Advanced:* What are Linux capabilities?
- *Senior:* Container hardening checklist for production.

### 14. Senior discussion
Is a read-only root filesystem feasible for these services? What writes to disk at runtime (migrations? npm cache? logs)?

---

## Chapter 5 — CPU, memory, I/O pressure and disk usage

### 1. Why this exists
Most "the system is slow" problems are resource saturation somewhere.

### 2. Core concept — the **USE method**: for every resource, check **U**tilisation, **S**aturation (queueing), **E**rrors.
- CPU: `top`, load average, throttling (`cpu.stat` in cgroups).
- Memory: free, page cache, swap, OOM events.
- Disk: `df`, `du`, I/O wait, `iostat`.
- PSI (pressure stall information): `/proc/pressure/{cpu,memory,io}`.

### 3. Mental model
Utilisation tells you how busy; saturation tells you whether anyone is waiting.

### 4. Delivery Plus mapping
- Disk growers: Kafka log segments (`kafka_data`, 7-day retention), PostgreSQL (`postgres_data`, dead tuples until vacuum), Redis AOF (`redis_data`, rewritten periodically), container logs (no rotation).
- `docker system df` shows images, containers and volumes; images for 12 services add up quickly during development.

### 5. Example
```bash
docker system df -v | head -40
dc exec kafka du -sh /var/lib/kafka/data
cat /proc/pressure/cpu 2>/dev/null   # on a Linux host
```

### 6. Failure scenario — disk full on the Kafka volume: the broker stops accepting writes; every producer call in order/payment/delivery services fails (and without an outbox, those events are lost).
### 7. Trade-offs — retention vs disk: 7 days of events is cheap here, expensive at scale.
### 8. Performance — I/O saturation shows as latency with low CPU.
### 9. Security — full disks can be caused deliberately (log flooding).
### 10. Operations — alert on disk at 70/85/95%.

### 11. Lab
Measure disk usage of each volume after `npm run seed:demo` and after several `npm run e2e` runs; compute growth per order.

### 12. Verification
You report bytes per order for PostgreSQL, Kafka and Redis.

### 13. Interview questions
- *Beginner:* How do you check disk usage?
- *Intermediate:* What is the USE method?
- *Advanced:* What does PSI tell you that load average doesn't?
- *Senior:* Capacity-plan disk for Kafka at 1 million orders/day.

### 14. Senior discussion
Which resource will Delivery Plus exhaust first as it grows: PostgreSQL connections, Redis memory, Kafka disk, or Node CPU?

---

## Chapter 6 — Networking from the OS: ports, localhost, DNS, routing

### 1. Why this exists
"Connection refused", "timeout" and "name not resolved" are different problems with different fixes.

### 2. Core concept
- **Port**: a number identifying a socket on a host; a server **listens** on `IP:port`.
- **Loopback** `127.0.0.1` / `localhost`: traffic that never leaves the machine — and inside a container, "the machine" is the container.
- `0.0.0.0` listen address = all interfaces.
- **DNS**: name → IP; `/etc/resolv.conf`, `/etc/hosts`.
- **Routing**: the kernel picks an interface by the destination; `ip route`.
- Errors: *refused* (nothing listening — fast), *timeout* (packets dropped / host unreachable — slow), *ENOTFOUND* (DNS).

### 3. Mental model
`localhost` means "this network namespace". The customer app's `localhost:3000` is your laptop from a browser, but the emulator itself from an Android emulator.

### 4. Delivery Plus mapping
- Inside containers, services listen on `0.0.0.0:<port>`; they reach each other by DNS names, never `localhost`.
- Host tools reach published ports via `localhost` (gateway `:3000`, Kafka `127.0.0.1:9092`).
- Kafka's `PLAINTEXT_HOST://localhost:9092` listener is correct for the host but would be wrong for a container.
- Media URLs are `http://localhost:9000/...` in dev — unreachable from phones ([Book 16](16-networking.md)).

### 5. Example
```bash
dc exec order-service sh -c 'cat /etc/resolv.conf; getent hosts redis'
dc exec order-service wget -qO- http://localhost:3006/health     # itself
dc exec order-service wget -qO- http://localhost:3005/health     # refused: cart-service is not in this container
```

### 6. Failure scenario — configuring `REDIS_URL=redis://localhost:6379` for a container: connection refused, because Redis isn't in that container's namespace.
### 7. Trade-offs — host networking (`network_mode: host`) removes this confusion and also removes isolation.
### 8. Performance — loopback is fastest; the bridge adds a little; real networks add much more.
### 9. Security — binding to `0.0.0.0` on a host exposes a port to every network the host is on; the dev overlay binds Kafka, Kafka UI and S3 to `127.0.0.1`.
### 10. Operations — know which error you have before you debug it.

### 11. Lab
[OPS-06 Docker DNS and published ports](labs/devops-labs.md#ops-06-docker-dns-and-published-ports).

### 12. Verification
You reproduce "refused", "timeout" (e.g. to an unroutable IP like `10.255.255.1`) and "not found" and time each.

### 13. Interview questions
- *Beginner:* What does `localhost` mean inside a container?
- *Intermediate:* Connection refused vs timeout?
- *Advanced:* Why can't an Android emulator reach `localhost:3000`?
- *Senior:* Debug intermittent DNS failures between services.

### 14. Senior discussion
Should services read peer addresses from environment variables (current) or from a discovery system? When does the difference matter?

---

[Library index](README.md) · Previous: [Book 14](14-docker-and-containers.md) · Next: [Book 16 — Networking](16-networking.md)
