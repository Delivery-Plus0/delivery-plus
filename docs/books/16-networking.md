# Book 16 — Networking for Backend & DevOps Engineers

[Library index](README.md) · Previous: [Book 15](15-linux-and-os.md) · Next: [Book 17 — Security Engineering](17-security-engineering.md)

**Level:** Intermediate → Advanced · **Prerequisites:** [Book 03](03-http-apis-and-web.md), [Book 15 Ch. 6](15-linux-and-os.md#chapter-6--networking-from-the-os-ports-localhost-dns-routing).

Five network paths matter in Delivery Plus. This book explains the layers underneath them and the failures each one produces.

```text
① Customer app ──► API gateway (:3000 dev, :3100 E2E)        browser / emulator / device → host
② Gateway ──► services (order-service:3006 …)               Docker bridge network, DNS
③ Services ──► PostgreSQL / Redis / Kafka                    long-lived TCP connections, pools
④ App (and presigned uploads) ──► S3 (SeaweedFS :9000)       direct client → storage
⑤ Host tools ──► Kafka (127.0.0.1:9092), Kafka UI (:8085)    advertised listeners
```

---

## Chapter 1 — Layers: from packets to HTTP

### 1. Why this exists
When "the API is slow" or "the connection drops", the cause can be at any layer. Knowing the layers tells you which tool to use.

### 2. Core concept
| TCP/IP layer | OSI | Examples here | Tools |
| --- | --- | --- | --- |
| Application | 5–7 | HTTP (REST), Kafka protocol, Redis RESP, PostgreSQL wire protocol, DNS | `curl`, `redis-cli`, `psql`, `kcat` |
| Transport | 4 | TCP (everything above), UDP (DNS, QUIC/HTTP3) | `ss`, `netstat` |
| Internet | 3 | IPv4 addresses on the Docker bridge (`172.x.x.x`), routing, NAT | `ip addr`, `ip route` |
| Link | 1–2 | virtual Ethernet pairs (`veth`) to the bridge, ARP | `ip link`, `arp` |

- **Packet**: a unit at the IP layer; **MTU** (usually 1500 bytes) bounds its size; larger messages are split into many packets.
- **ARP**: maps IP → MAC on a local network.

### 3. Mental model
Each layer wraps the one above: HTTP inside TCP segments inside IP packets inside Ethernet frames.

### 4. Delivery Plus mapping — every service-to-service call (② and ③) traverses: Node → TCP socket → container `eth0` → veth → Docker bridge → other container's veth → `eth0` → listening socket.
### 5. Example
```bash
alias dc='docker compose -f docker-compose.base.yml -f docker-compose.dev.yml'
docker network inspect delivery-plus_default --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'
```
### 6. Failure scenario — MTU mismatch (common with VPNs and some cloud overlays): small requests work, large responses (a big menu JSON) hang — the classic "only big responses fail" symptom.
### 7. Trade-offs — n/a (conceptual).
### 8. Performance — every layer adds headers; TLS adds handshakes; small chatty calls are dominated by round trips, not bytes.
### 9. Security — plain TCP inside the Docker network: anyone on that network can sniff traffic (`tcpdump` in a container with `NET_RAW`).
### 10. Operations — match the tool to the layer: DNS error → `getent`/`dig`; refused → `ss -ltn`; slow → `curl -w` timings.

### 11. Lab
[OPS-06 Docker DNS and published ports](labs/devops-labs.md#ops-06-docker-dns-and-published-ports).

### 12. Verification
You list every container's IP on the bridge and resolve each service name from inside another container.

### 13. Interview questions
- *Beginner:* What are the TCP/IP layers?
- *Intermediate:* What is MTU and what breaks when it's wrong?
- *Advanced:* What does ARP do on a Docker bridge?
- *Senior:* "Only large responses time out" — walk through your diagnosis.

### 14. Senior discussion
Would you ever use UDP for anything in Delivery Plus (e.g. high-frequency driver locations)? What would you lose?

---

## Chapter 2 — IP, subnets, routing and NAT

### 1. Why this exists
Addresses decide what can talk to what; NAT decides what the outside world sees.

### 2. Core concept
- **IPv4 + CIDR**: `172.18.0.0/16` = 65,536 addresses sharing the first 16 bits.
- **Routing table**: which interface/gateway for each destination.
- **NAT**: rewriting addresses. Docker uses **DNAT** for published ports (host:3000 → container:3000) and **SNAT/masquerade** for outbound traffic from containers.
- Private ranges: `10/8`, `172.16/12`, `192.168/16`.

### 3. Mental model
A published port is a NAT rule on the host. An unpublished port has no rule — unreachable from outside.

### 4. Delivery Plus mapping — **CURRENT**: each Compose project gets its own subnet (the dev and E2E stacks don't share one); published ports are the only NAT entries.
### 5. Example
```bash
docker network inspect delivery-plus_default --format '{{(index .IPAM.Config 0).Subnet}}'
docker network inspect delivery-plus-e2e_default --format '{{(index .IPAM.Config 0).Subnet}}'
```
### 6. Failure scenario — a corporate VPN routes `172.16.0.0/12` → Docker's default subnets collide → containers can't reach VPN resources (or vice versa). Fix: configure Docker's default address pools.
### 7. Trade-offs — NAT hides internal addresses (good) and breaks end-to-end addressing (logs show the gateway's IP, not the client's, unless proxies forward `X-Forwarded-For`).
### 8. Performance — NAT adds negligible latency.
### 9. Security — rate limiting by IP behind NAT/proxies limits everyone together ([Book 06 Ch. 5](06-redis.md#chapter-5--counters-and-rate-limiting)).
### 10. Operations — record client IPs at the edge (gateway) with trusted `X-Forwarded-For` handling.

### 11. Lab — run the commands above and explain why both stacks can run at once.
### 12. Verification — two different subnets; no port conflicts because the E2E stack publishes `3100`/`9100` instead of `3000`/`9000`.

### 13. Interview questions
- *Beginner:* What does `/16` mean?
- *Intermediate:* How does Docker publish a port?
- *Advanced:* SNAT vs DNAT?
- *Senior:* How should the gateway learn the real client IP behind a cloud load balancer?

### 14. Senior discussion
`RateLimitGuard` uses `request.ip` for anonymous routes. What exactly must be configured at the load balancer and in Express (`trust proxy`) for that to identify real clients, and what are the spoofing risks?

---

## Chapter 3 — TCP: handshakes, states, keep-alive and connection pools

### 1. Why this exists
Every request in this system rides on TCP; how connections are opened, reused and closed decides latency and stability.

### 2. Core concept
- **3-way handshake** (SYN, SYN-ACK, ACK): 1 RTT before any data.
- **States**: LISTEN, SYN_SENT, ESTABLISHED, FIN_WAIT, TIME_WAIT (the closer waits ~60 s), CLOSE_WAIT (peer closed, we haven't — a leak sign).
- **Keep-alive** (HTTP): reuse a connection for many requests.
- **Connection pool**: a set of open connections reused by an application (PostgreSQL pool, Redis client).
- **Head-of-line blocking**: one slow request blocks the ones behind it on the same connection (HTTP/1.1).

### 3. Mental model
Opening a connection is expensive; keeping one open is cheap. Pools and keep-alive turn N handshakes into 1.

### 4. Delivery Plus mapping
- **CURRENT:** PostgreSQL via TypeORM/`pg` pool (default 10 per service); one long-lived ioredis connection per service; kafkajs keeps connections to brokers.
- **CURRENT:** service clients use Node's global `fetch` (undici), which keeps connections alive and pools them per origin by default.
- **CURRENT:** the gateway proxies with `http-proxy-middleware` (Node `http` agent behaviour applies).

### 5. Example
```bash
dc exec order-service sh -c 'cat /proc/net/tcp | wc -l'   # rough count of TCP sockets
# on the host with ss available:
ss -tan state established '( dport = :3000 or sport = :3000 )' | head
```

### 6. Failure scenario — CLOSE_WAIT accumulation: an app that never closes sockets after the peer closed; fds run out (Book 15 Ch. 3).
### 7. Trade-offs — long-lived connections are efficient but must survive idle timeouts in NATs and load balancers (send keep-alives or reconnect).
### 8. Performance — on mobile, connection setup (TCP + TLS) can cost 200–600 ms; reuse is critical for the customer app.
### 9. Security — SYN floods target the handshake; mitigated at the load balancer/kernel (SYN cookies).
### 10. Operations — watch connection counts per service; a sudden jump means a pool or keep-alive misconfiguration.

### 11. Lab
Time `curl -w "%{time_connect} %{time_starttransfer}\n"` twice to the gateway with `--http1.1`, then 10 requests in one `curl` invocation (reuse) vs 10 separate invocations.

### 12. Verification
Reused-connection requests show `time_connect` ≈ 0 after the first.

### 13. Interview questions
- *Beginner:* Describe the TCP handshake.
- *Intermediate:* What is TIME_WAIT and why does it exist?
- *Advanced:* What does many CLOSE_WAIT sockets indicate?
- *Senior:* Connection management for 50,000 driver apps holding WebSockets.

### 14. Senior discussion
Idle timeouts differ at every hop (mobile NAT, load balancer, gateway, service). How do you choose WebSocket heartbeat intervals ([Book 22](22-real-time-systems.md))?

---

## Chapter 4 — DNS

### 1. Why this exists
Every hostname in this system (`order-service`, `kafka`, `localhost`, a future `api.deliveryplus.example`) is resolved by DNS.

### 2. Core concept
- Resolver order: `/etc/hosts`, then DNS servers in `/etc/resolv.conf`.
- Records: A/AAAA (address), CNAME (alias), SRV, TXT.
- **TTL**: how long answers are cached; stale caches after changes.
- Docker's embedded DNS server (`127.0.0.11` inside containers) answers service names.

### 3. Mental model
DNS is a distributed, cached phone book; caches make it fast and make changes slow.

### 4. Delivery Plus mapping — **CURRENT**: all internal addressing is Docker DNS service names from env vars (`*_SERVICE_URL`, `KAFKA_BROKER`, `REDIS_URL`, `DATABASE_URL` host `postgres`).
### 5. Example
```bash
dc exec order-service cat /etc/resolv.conf     # nameserver 127.0.0.11
dc exec order-service getent hosts payment-service
```
### 6. Failure scenario — a service starts before its dependency's container exists: DNS returns "not found" → the client throws `ENOTFOUND`. Compose health-based `depends_on` mostly prevents this at startup; at runtime, a restarted container may change IP and long-lived clients must reconnect by name, not cached IP.
### 7. Trade-offs — DNS-based discovery is simple; it has no health awareness (Kubernetes Services/Endpoints add that).
### 8. Performance — DNS lookups add latency on the first call; Node caches through the OS resolver only if configured (undici does not cache DNS by itself).
### 9. Security — DNS spoofing inside a network; in production use private DNS zones.
### 10. Operations — `ENOTFOUND` vs `ECONNREFUSED` vs `ETIMEDOUT` tell you DNS vs listener vs routing.

### 11. Lab — stop `cart-service` and call `GET /api/cart` with a customer token; read order-service's / cart's error and the gateway response.
### 12. Verification — you identify the error class from the logs (the gateway's proxy reports the upstream connection failure).

### 13. Interview questions
- *Beginner:* What does DNS do?
- *Intermediate:* What is a TTL?
- *Advanced:* Why can long-lived clients break after a container restart?
- *Senior:* Service discovery options beyond DNS.

### 14. Senior discussion
In Kubernetes, `order-service` would resolve to a ClusterIP. What changes for connection pooling and load distribution compared with Docker DNS?

---

## Chapter 5 — TLS and certificates

### 1. Why this exists
Without TLS, anyone on the path can read and modify traffic — JWTs, passwords, payment data.

### 2. Core concept
- TLS provides **confidentiality** (encryption), **integrity**, and **server authentication** (certificate chain to a trusted CA).
- TLS 1.3 handshake: 1 RTT (0-RTT resumption possible).
- **mTLS**: both sides present certificates (service identity).
- **Termination**: where TLS is decrypted (load balancer, gateway, service).

### 3. Mental model
A certificate is a CA-signed statement "this public key belongs to this hostname".

### 4. Delivery Plus mapping
- **NOT IN THE REPOSITORY:** no TLS anywhere locally; no certificates; production TLS termination is not defined yet.
- **FUTURE design:** TLS terminated at a cloud load balancer/ingress in front of the gateway; internal traffic either plain inside a private network or mTLS via a service mesh; managed PostgreSQL/Redis/Kafka with TLS.

### 5. Example
```bash
curl -v https://example.com 2>&1 | grep -E "SSL connection|subject:|issuer:"
```
### 6. Failure scenario — expired certificate at the edge: every client fails at once; mobile apps show a generic network error. Automate renewal (ACME) and alert on expiry.
### 7. Trade-offs — TLS at the edge only (simple) vs end-to-end/mTLS (stronger, certificate management burden).
### 8. Performance — TLS 1.3 costs one RTT on new connections and negligible CPU on modern hardware.
### 9. Security — presigned S3 URLs and JWTs must only travel over TLS in production; otherwise they are bearer secrets in clear text.
### 10. Operations — certificate inventory, expiry alerts, rotation runbooks.

### 11. Lab — inspect the certificate chain of any public HTTPS site with `openssl s_client -connect example.com:443 -servername example.com`.
### 12. Verification — you identify leaf, intermediate and root, and the expiry date.

### 13. Interview questions
- *Beginner:* What does TLS protect?
- *Intermediate:* What is TLS termination?
- *Advanced:* mTLS vs JWT service tokens?
- *Senior:* TLS design for the Delivery Plus production platform.

### 14. Senior discussion
If internal traffic stays unencrypted inside a private network, what compensating controls must exist?

---

## Chapter 6 — Reverse proxies, load balancers and timeouts

### 1. Why this exists
A single entry point lets you route, balance, terminate TLS and protect services — and introduces new timeouts and failure modes.

### 2. Core concept
- **Reverse proxy**: accepts client connections, forwards to upstreams.
- **Load balancer**: distributes across replicas (L4 by connection, L7 by request); health checks remove bad replicas.
- **Timeouts at every hop**: client, LB idle timeout, proxy upstream timeout, service handler, database statement timeout. The *inner* timeouts should be shorter than the *outer* ones.
- **502** (bad gateway: upstream refused/crashed), **504** (gateway timeout: upstream too slow).

### 3. Mental model
```text
app (15 s) ─► LB (60 s idle) ─► gateway (no timeout) ─► service (no timeout) ─► DB (no statement timeout)
              ideal: app 15 s > gateway 10 s > service 8 s > DB statement 5 s
```

### 4. Delivery Plus mapping
- **CURRENT:** the gateway (`services/api-gateway/src/main.ts`) is a reverse proxy without upstream timeouts or load balancing (one instance per service).
- **CURRENT:** the customer app times out at 15 s; nothing inside does (issues #6, #38).

### 5. Example — stop order-service and call `GET /api/orders`: the gateway returns a proxy error quickly (connection refused). Pause it instead (`docker pause`) and the request hangs until the client gives up — no 504 because the gateway has no timeout.
### 6. Failure scenario — inverted timeouts (inner longer than outer): the client gives up, the server keeps working, and retries pile duplicate work on a struggling service.
### 7. Trade-offs — per-route timeouts (checkout may take longer than browsing) vs one global value.
### 8. Performance — timeouts bound tail latency and free resources.
### 9. Security — proxies must strip/override `X-Forwarded-*` from clients; LBs absorb some DoS.
### 10. Operations — distinguish 502 vs 504 in dashboards: crash vs slowness.

### 11. Lab
[OPS-10 Paused service versus stopped service](labs/devops-labs.md#ops-10-paused-service-versus-stopped-service).

### 12. Verification
Stopped → fast error; paused → hang until the client timeout; you explain the difference in TCP terms (RST vs no response).

### 13. Interview questions
- *Beginner:* Reverse proxy vs forward proxy?
- *Intermediate:* 502 vs 504?
- *Advanced:* How should timeouts nest across hops?
- *Senior:* Design the edge (LB, gateway, rate limits, TLS) for production.

### 14. Senior discussion
`docker pause` simulates a frozen process (GC pause, deadlock). Which Delivery Plus components would detect it, and how quickly?

---

## Chapter 7 — Delivery Plus network paths in detail

### 7.1 Customer app → gateway (①)
- Web: `http://localhost:3000` (CORS origins `localhost/127.0.0.1:8081–8083`).
- Android emulator: the host is `10.0.2.2` → `EXPO_PUBLIC_API_BASE_URL=http://10.0.2.2:3000` (`delivery-plus-customer-app/.env.example`).
- Physical device: the laptop's LAN IP, and the gateway port must be reachable on the LAN (dev overlay publishes `3000` on all interfaces).
- The URL is baked into the build (`delivery-plus-customer-app/src/config/api.ts`, default `http://localhost:3000`).

### 7.2 Gateway → services (②) — Docker DNS, plain HTTP, `changeOrigin: true`, path rewrite per prefix.

### 7.3 Services → PostgreSQL / Redis / Kafka (③)
- Kafka listeners: containers use `kafka:29092`; host tools use `localhost:9092`. The broker *advertises* these addresses in metadata; a client connecting through the wrong listener receives an address it can't reach.

### 7.4 Clients → S3 (④)
- Presigned POST URLs are signed for `AWS_S3_PUBLIC_ENDPOINT` (dev default `http://localhost:9000`, E2E `http://localhost:9100`) and served from `AWS_PUBLIC_BASE_URL` — the *client* must reach that host. On an emulator or device, `localhost` points at the device itself, so uploads and images fail unless the endpoint is set to a reachable host.
- Services reach SeaweedFS internally by its service name for HEAD/GET/COPY during confirmation.

### 7.5 Host tools → Kafka UI and Kafka (⑤) — `127.0.0.1` bindings keep them off the LAN.

### Lab
[OPS-11 Emulator to host networking](labs/devops-labs.md#ops-11-emulator-to-host-networking) (thought lab if you don't have an emulator).

---

[Library index](README.md) · Previous: [Book 15](15-linux-and-os.md) · Next: [Book 17 — Security Engineering](17-security-engineering.md)
