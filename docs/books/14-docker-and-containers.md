# Book 14 — Docker & Containers

[Library index](README.md) · Previous: [Book 13](13-e2e-ui-automation.md) · Next: [Book 15 — Linux & OS Fundamentals](15-linux-and-os.md)

**Level:** Junior → Intermediate · **Prerequisites:** basic shell; [Book 15](15-linux-and-os.md) is a good companion.

Every Delivery Plus component runs in a container: 12 service images built from one `Dockerfile`, plus PostgreSQL, Redis, ZooKeeper, Kafka, Kafka UI and SeaweedFS (S3). Six Compose files describe the environments. This book explains containers from the kernel up, then dissects those files.

| File | Purpose |
| --- | --- |
| `Dockerfile` | multi-stage build for any service (`SERVICE_NAME` build arg) |
| `.dockerignore` | keeps `node_modules`, `dist`, `.git`, `.env`, docs and scripts out of the build context |
| `docker-compose.base.yml` | infrastructure shared by all overlays: PostgreSQL 16, Redis 7 (AOF), ZooKeeper, Kafka 7.6.1; volumes `postgres_data`, `kafka_data`, `redis_data` |
| `docker-compose.dev.yml` | dev overlay: all services, SeaweedFS + bucket init, Kafka UI, gateway on `:3000` |
| `docker-compose.test.yml` | CI overlay used by the Integration workflow |
| `docker-compose.prod.yml` | production-oriented overlay: required secrets, no infrastructure ports |
| `docker-compose.e2e.yml` | isolated E2E stack (project `delivery-plus-e2e`) |
| `docker-compose.yml` | standalone full local stack |

---

## Chapter 1 — Process vs container: namespaces and cgroups

### 1. Why this exists
"It works on my machine" is a dependency and environment problem. Containers package an application with its user-space dependencies and run it isolated on a shared kernel.

### 2. Core concept
- A container is **a normal Linux process** with:
  - **namespaces** — its own view of PIDs, network interfaces, mounts, hostname, users, IPC;
  - **cgroups** — limits/accounting for CPU, memory, I/O, PIDs;
  - a **root filesystem** from an image (layered, copy-on-write);
  - optional capability drops and seccomp filters.
- Not a VM: there is no guest kernel.

### 3. Mental model
```text
host kernel
 ├─ process: postgres  (pid ns: sees itself as PID 1, net ns: own eth0, mnt ns: own /)
 ├─ process: node services/order-service/dist/main.js  (another set of namespaces)
 └─ process: redis-server …
```

### 4. Delivery Plus mapping — **CURRENT**
Every service container's main process is `node`: the `Dockerfile` `CMD` runs migrations with `sh -c`, then `exec node services/${SERVICE_NAME}/dist/main.js` — `exec` replaces the shell, so `node` is PID 1 and receives signals directly.

### 5. Example
```bash
alias dc='docker compose -f docker-compose.base.yml -f docker-compose.dev.yml'
dc exec order-service ps -o pid,comm      # node is PID 1 inside
docker top delivery-plus-order-service-1  # the same process seen from the host, with a host PID
```

### 6. Failure scenario
Without `exec`, `sh` would be PID 1; `SIGTERM` from `docker stop` goes to `sh`, which doesn't forward it; Node never shuts down cleanly and is killed with `SIGKILL` after the grace period.

### 7. Trade-offs — containers share the host kernel (lighter, less isolated than VMs); a kernel vulnerability affects all containers.
### 8. Performance — near-native CPU and memory; networking through a bridge adds a little latency.
### 9. Security — the production image runs as **root** inside the container (no `USER` instruction in the `Dockerfile`; issue #14). Root in a container is not host root, but it widens the impact of a container escape or a writable mount.
### 10. Operations — a container is as observable as its process: logs to stdout, health via HTTP, metrics via cgroups (`docker stats`).

### 11. Lab
[OPS-01 Look inside a container](labs/devops-labs.md#ops-01-look-inside-a-container).

### 12. Verification
You show the same process with two PIDs (container and host) and its memory usage from `docker stats`.

### 13. Interview questions
- *Beginner:* Container vs VM?
- *Intermediate:* What are namespaces and cgroups?
- *Advanced:* Why does `exec` in the CMD matter?
- *Senior:* What is the realistic isolation boundary of a container in production?

### 14. Senior discussion
Running as root in the image: how would you add a non-root user without breaking file permissions for migrations and the npm cache mount?

---

## Chapter 2 — Images, layers, multi-stage builds and the build cache

### 1. Why this exists
Images must be small (fast pulls, fewer vulnerabilities), reproducible, and fast to rebuild.

### 2. Core concept
- An image is a stack of read-only **layers**; each `Dockerfile` instruction adds one.
- **Cache**: a layer is reused if its instruction and inputs haven't changed — order instructions from least to most frequently changing.
- **Multi-stage**: build in a fat stage, copy only artifacts into a slim runtime stage.
- **BuildKit cache mounts** (`RUN --mount=type=cache,…`) persist package caches between builds without baking them into layers.

### 3. Mental model
```text
builder stage: package*.json → npm ci (cached) → shared → services → build shared → build ${SERVICE_NAME}
production:    package*.json + shared/package.json + service package.json → npm ci --omit=dev
               remove npm/npx → copy shared/dist + service dist → CMD migrate + exec node
```

### 4. Delivery Plus mapping — **CURRENT** (`Dockerfile`)
- Base `node:22-alpine` for both stages.
- Builder: `npm ci` with a cache mount and generous retry settings; builds `@food-delivery/shared`, then the service workspace.
- Runtime: production dependencies only; **removes `npm` and `npx`** from the image (smaller attack surface); copies `shared/dist` and the service's `dist`.
- One recipe, 12 images: `docker build --build-arg SERVICE_NAME=order-service .`
- CI builds every service in a matrix with GitHub Actions cache (`cache-from/cache-to: type=gha`) in `.github/workflows/docker.yml`.

### 5. Example
```bash
docker history food-delivery-order-service:ci   # or the dev image name from `dc images`
```

### 6. Failure scenario
The builder copies `package*.json`, `tsconfig.base.json`, `shared` **and** `services` before `npm ci`, so any source change in any service invalidates the dependency-install layer for every image. The npm cache mount keeps the reinstall fast, but a stricter layout (copy only the `package.json` files first, `npm ci`, then copy sources) would let Docker skip the step entirely when only code changed.

### 7. Trade-offs — one shared Dockerfile keeps builds consistent; per-service Dockerfiles allow per-service tuning.
### 8. Performance — image size ≈ Node runtime + production `node_modules` for the whole workspace lockfile; `npm ci --omit=dev` in a workspace still installs every workspace's prod dependencies listed in the root lockfile.
### 9. Security — fewer tools in the runtime image (no npm/npx) = fewer exploitable binaries; still Alpine + Node CVEs → scanning (Chapter 3).
### 10. Operations — tag images with commit SHAs, not just `latest`, to know exactly what runs.

### 11. Lab
[OPS-02 Layer cache experiment](labs/devops-labs.md#ops-02-layer-cache-experiment).

### 12. Verification
Changing a source file rebuilds from the `COPY services` layer onward; changing nothing rebuilds nothing.

### 13. Interview questions
- *Beginner:* What is an image layer?
- *Intermediate:* Why multi-stage builds?
- *Advanced:* How does a BuildKit cache mount differ from a layer?
- *Senior:* Design image tagging and promotion from CI to production.

### 14. Senior discussion
Should migrations run in the service image's entrypoint (current) or in a separate image/job? ([Book 04 Ch. 8](04-database-fundamentals.md#chapter-8--migrations-schema-evolution-and-zero-downtime-changes))

---

## Chapter 3 — Registries, image security and vulnerability scanning

### 1. Why this exists
An image contains an OS, a runtime and hundreds of packages — each a potential CVE.

### 2. Core concept
- **Registry**: stores and serves images (Docker Hub, GHCR, ECR).
- **Tags** are mutable pointers; **digests** (`sha256:…`) are immutable.
- **Scanning** (Trivy, Grype) checks OS and language packages against vulnerability databases.
- **Supply chain**: pin base images, verify signatures (cosign), generate SBOMs.

### 3. Mental model
A tag is a bookmark that can move; a digest is the book.

### 4. Delivery Plus mapping — **CURRENT**
- Every service image is built and scanned in CI with Trivy, failing on `CRITICAL` (`.github/workflows/docker.yml`); a filesystem + secret scan runs in `.github/workflows/security.yml`.
- Images are **not pushed** to a registry (`push: false`) — there is no deployment pipeline yet.
- Mutable tags in use: `provectuslabs/kafka-ui:latest` (dev and full local files; issue #14). Infrastructure images are otherwise version-pinned (`postgres:16-alpine`, `redis:7-alpine`, `confluentinc/cp-kafka:7.6.1`, `chrislusf/seaweedfs:4.47`).
- Why SeaweedFS instead of MinIO: MinIO images became gated for anonymous pulls, so CI couldn't pull them; SeaweedFS speaks the same S3 API (comment in `docker-compose.dev.yml`, details in `.project-context/15-media-and-storage.md`).

### 5. Example
```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy image --severity HIGH,CRITICAL <image>
```

### 6. Failure scenario — a `latest` tag silently changes between two deployments; the "same" config now runs different software.
### 7. Trade-offs — failing builds on HIGH vulnerabilities blocks releases for issues with no fix; failing only on CRITICAL (current) accepts some risk.
### 8. Performance — scans add a minute per image in CI.
### 9. Security — scan *and* update: Dependabot PRs are part of the loop (see issue #101 for a blocked major upgrade).
### 10. Operations — keep an exception list with expiry dates for accepted vulnerabilities.

### 11. Lab
Scan one locally built service image with Trivy and classify the top three findings: OS package, Node runtime, or npm dependency?

### 12. Verification
You can say which findings an `npm` upgrade would fix and which need a base-image update.

### 13. Interview questions
- *Beginner:* Tag vs digest?
- *Intermediate:* What does Trivy scan?
- *Advanced:* What is an SBOM?
- *Senior:* Vulnerability management policy for this project?

### 14. Senior discussion
`node:22-alpine` (musl) vs `node:22-slim` (glibc) vs distroless: which would you choose and why?

---

## Chapter 4 — Networking: bridge networks, DNS and ports

### 1. Why this exists
Services must find each other by name, and only some ports should be reachable from outside.

### 2. Core concept
- Compose creates a **bridge network** per project; containers get private IPs.
- Docker's embedded **DNS** resolves service names (`order-service`, `kafka`, `postgres`).
- **Port publishing** (`ports: '127.0.0.1:9092:9092'`) maps a host port to a container port; without it the port is reachable only inside the network.
- Binding to `127.0.0.1` on the host keeps a published port off the LAN.

### 3. Mental model
```text
Host (your laptop)
 ├─ 0.0.0.0:3000      → api-gateway:3000          (published)
 ├─ 127.0.0.1:9092    → kafka:9092  (PLAINTEXT_HOST)
 ├─ 127.0.0.1:8085    → kafka-ui:8080
 ├─ 127.0.0.1:9000    → media-storage:9000 (S3)
 └─ Docker network delivery-plus_default (not published)
      postgres:5432 · redis:6379 · kafka:29092 (PLAINTEXT, inside) · order-service:3006 · …
```

### 4. Delivery Plus mapping — **CURRENT**
- Service URLs via env vars using DNS names: `ORDER_SERVICE_URL=http://order-service:3006`, `KAFKA_BROKER=kafka:29092`, `REDIS_URL=redis://redis:6379`.
- Kafka has **two listeners** (`docker-compose.base.yml`): `PLAINTEXT://kafka:29092` for containers, `PLAINTEXT_HOST://localhost:9092` for tools on the host. A client connecting to the wrong one gets metadata pointing at an unreachable address.
- The E2E project has its own network and publishes only `127.0.0.1:3100` (gateway) and `127.0.0.1:9100` (S3) — `ports: !reset []` removes the others.

### 5. Example
```bash
dc exec order-service getent hosts cart-service postgres kafka
dc exec order-service wget -qO- http://cart-service:3005/health
```

### 6. Failure scenario
Kafka advertised listeners: a host-side tool connecting to `localhost:9092` is told "the leader is at `kafka:29092`" if the listeners are misconfigured — the name doesn't resolve on the host and every request times out. The dual-listener setup exists to prevent exactly this.

### 7. Trade-offs — publishing infrastructure ports is convenient for debugging and dangerous on shared networks; the prod overlay publishes none.
### 8. Performance — bridge networking adds microseconds; DNS lookups are cached by the runtime.
### 9. Security — every container on the bridge can reach every other (no network policies); a compromised service can talk to PostgreSQL and Redis directly.
### 10. Operations — `docker network inspect` shows who is attached; useful when two projects collide.

### 11. Lab
[OPS-06 Docker DNS and published ports](labs/devops-labs.md#ops-06-docker-dns-and-published-ports).

### 12. Verification
From the host, `nc -z localhost 6379` fails on the dev overlay (Redis not published) while `dc exec redis redis-cli ping` works.

### 13. Interview questions
- *Beginner:* How does one container find another?
- *Intermediate:* What does `127.0.0.1:9092:9092` mean?
- *Advanced:* Why does Kafka need two listeners here?
- *Senior:* What network segmentation would you add in production?

### 14. Senior discussion
Should internal service-to-service traffic be encrypted even inside one Docker network or cluster? What threat does it address?

---

## Chapter 5 — Volumes, bind mounts and data lifecycle

### 1. Why this exists
Containers are disposable; data is not.

### 2. Core concept
- Container filesystem: ephemeral; lost when the container is removed.
- **Named volume**: managed by Docker, survives container recreation (`postgres_data`).
- **Bind mount**: a host path mounted into the container (`./docker/postgres/init.sql`).
- `docker compose down` keeps volumes; `down -v` deletes them.

### 3. Mental model
Ask of every piece of data: "If I `down -v`, is losing this acceptable?"

### 4. Delivery Plus mapping — **CURRENT**
| Data | Storage | Survives `down` | Survives `down -v` |
| --- | --- | --- | --- |
| PostgreSQL | volume `postgres_data` | yes | no |
| Kafka log | volume `kafka_data` | yes | no |
| Redis (AOF) | volume `redis_data` | yes | no |
| S3 objects (SeaweedFS) | volume in the dev overlay | yes | no |
| PostgreSQL init script | bind mount `./docker/postgres/init.sql` (read-only) | n/a | n/a |
| Service containers | none (stateless) | — | — |

`npm run e2e:env:down` uses `down --volumes`, so the E2E stack always starts empty.

### 5. Example — `dc down && dc up -d --wait` keeps all data; `dc down -v` is a factory reset (the runbook `docs/runbooks/local-stack-troubleshooting.md` warns about it).
### 6. Failure scenario — before AOF and `redis_data`, recreating the Redis container lost every cart and every Kafka processed marker; a redelivery then re-ran side effects.
### 7. Trade-offs — volumes are portable within Docker; bind mounts are handy for development but tie the container to host paths and permissions.
### 8. Performance — volumes on Docker Desktop (macOS/Windows) are faster than bind mounts of large trees.
### 9. Security — volumes hold unencrypted data on the host disk.
### 10. Operations — back up volumes (or better, use the database's own backup tools — [Book 05 Ch. 8](05-postgresql-deep-dive.md#chapter-8--backups-restore-and-point-in-time-recovery)).

### 11. Lab
[RD-05 Restart Redis with and without AOF](labs/redis-labs.md#rd-05-restart-redis-with-and-without-aof).

### 12. Verification
A cart survives `dc restart redis` and `dc up -d --force-recreate redis`, but not `dc down -v`.

### 13. Interview questions
- *Beginner:* Volume vs bind mount?
- *Intermediate:* What does `down -v` delete?
- *Advanced:* Why are service containers stateless here?
- *Senior:* How do you run stateful infrastructure in containers in production — or should you?

### 14. Senior discussion
Would you run PostgreSQL, Kafka and Redis in containers in production, or use managed services? What changes in backups, upgrades and on-call?

---

## Chapter 6 — Compose: overlays, healthchecks and startup order

### 1. Why this exists
Twenty containers must start in the right order with the right config for four environments.

### 2. Core concept
- **Overlays**: `-f base -f dev` merges files; later files override earlier ones; `!reset`/`!override` tags replace lists.
- **Healthcheck**: a command Docker runs periodically; the container is `healthy`, `unhealthy` or `starting`.
- `depends_on: condition: service_healthy` waits for dependencies' health, not just their start.
- `up --wait` blocks until everything is healthy (used by CI and E2E scripts).

### 3. Mental model
Compose builds a dependency graph; health checks are the edges' "ready" signals.

### 4. Delivery Plus mapping — **CURRENT**
- Infrastructure health checks in `docker-compose.base.yml`: `pg_isready`, `redis-cli ping`, ZooKeeper `srvr`, `kafka-topics --list`.
- Service health checks: `wget --spider -q http://localhost:<port>/health`, every 5 s, 10 retries; services `depends_on` PostgreSQL/Redis/Kafka (and other services) with `service_healthy`.
- `/health` is a **liveness-style** check (process answers); `/health/ready` checks the database in some services; dependency-aware readiness is issue #8 (e.g. notification-service's `/health/ready` returns 200 with `status: "ERROR"` when the DB is down).
- E2E overlay uses `ports: !override` / `!reset` to change published ports without copying the files.

### 5. Example
```bash
dc ps --format 'table {{.Name}}\t{{.Status}}'
docker inspect -f '{{json .State.Health}}' delivery-plus-order-service-1 | head -c 400
```

### 6. Failure scenario — a service healthy by `/health` but unable to reach PostgreSQL still receives traffic; with readiness checks that test dependencies, the orchestrator would stop routing to it.
### 7. Trade-offs — dependency checks in health endpoints can cause cascading "unhealthy" when a shared dependency blips; liveness should not depend on dependencies, readiness should.
### 8. Performance — health checks every 5 s × 12 services is negligible.
### 9. Security — health endpoints are public through the gateway's own `/health`; service health endpoints aren't exposed by the gateway routes.
### 10. Operations — `up --wait --wait-timeout 300` makes CI fail clearly when something never becomes healthy.

### 11. Lab
[OPS-08 Healthcheck and dependency failure](labs/devops-labs.md#ops-08-healthcheck-and-dependency-failure).

### 12. Verification
Stopping PostgreSQL makes `/health/ready` change (where implemented) while `/health` stays 200 — you can explain the difference.

### 13. Interview questions
- *Beginner:* What does a healthcheck do?
- *Intermediate:* `depends_on` with and without `service_healthy`?
- *Advanced:* Liveness vs readiness?
- *Senior:* What should each service's readiness check verify?

### 14. Senior discussion
Compose overlays (base + env) vs one file per environment vs Helm/Kustomize: what scales to staging and production?

---

## Chapter 7 — Container lifecycle, signals, graceful shutdown, limits and logs

### 1. Why this exists
Containers are started, stopped and replaced constantly. Each stop is a small failure your system must absorb.

### 2. Core concept
- `docker stop` sends `SIGTERM`, waits (default 10 s), then `SIGKILL`.
- **Restart policies**: `unless-stopped` restarts crashed containers.
- **Resource limits**: `mem_limit`/`cpus` (or `deploy.resources`) — without them, one container can starve the host.
- **Logging**: stdout/stderr captured by the Docker logging driver (`json-file` by default, rotated only if configured).
- **OOM kill**: exceeding the memory limit kills the process (exit code 137).

### 3. Mental model
Design every process for "kill -TERM at any moment, kill -KILL 10 s later".

### 4. Delivery Plus mapping — **CURRENT**
- `restart: unless-stopped` on services and infrastructure.
- No resource limits in any Compose file.
- No log rotation configured (default `json-file` without `max-size`).
- No graceful shutdown in the apps (no `enableShutdownHooks`, issue #7) → Kafka consumers don't leave their group; in-flight requests are cut.

### 5. Example
```bash
time dc stop notification-service      # ~10 s: SIGTERM ignored by the app, then SIGKILL
docker inspect -f '{{.State.ExitCode}}' delivery-plus-notification-service-1   # 137 = killed
```

### 6. Failure scenario — no memory limit + a memory leak in one service = the whole laptop/VM swaps, every container slows down, health checks time out, everything restarts.
### 7. Trade-offs — tight limits catch leaks early but OOM-kill legitimate spikes; set limits from measured usage plus headroom.
### 8. Performance — CPU limits throttle (latency spikes), memory limits kill.
### 9. Security — limits are also a DoS defence (a fork bomb or runaway allocation stays inside its cgroup).
### 10. Operations — unrotated `json-file` logs fill disks on long-running hosts.

### 11. Lab
[OPS-03 Graceful shutdown](labs/devops-labs.md#ops-03-graceful-shutdown) and [OPS-09 Resource exhaustion](labs/devops-labs.md#ops-09-resource-exhaustion).

### 12. Verification
You show exit code 137 after `docker stop` and an OOM kill after setting a tiny memory limit.

### 13. Interview questions
- *Beginner:* What does `docker stop` do?
- *Intermediate:* What does exit code 137 mean?
- *Advanced:* Why do apps need to handle SIGTERM?
- *Senior:* Resource requests/limits policy for these 12 services?

### 14. Senior discussion
If you add graceful shutdown with a 25 s drain, what must change in Docker's stop timeout, the Kafka session timeout and the health checks for a zero-error rolling restart?

---

[Library index](README.md) · Previous: [Book 13](13-e2e-ui-automation.md) · Next: [Book 15 — Linux & OS Fundamentals](15-linux-and-os.md)
