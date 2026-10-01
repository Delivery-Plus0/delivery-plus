# Book 19 — Kubernetes & Orchestration

[Library index](README.md) · Previous: [Book 18](18-cicd-and-devops.md) · Next: [Book 20 — Observability & Production Engineering](20-observability.md)

**Level:** Advanced · **Prerequisites:** [Book 14](14-docker-and-containers.md), [Book 16](16-networking.md), [Book 18](18-cicd-and-devops.md).

> **Status: FUTURE.** Delivery Plus runs on Docker Compose. Nothing in this book exists in the repository: no manifests, no Helm charts, no cluster. Every Kubernetes object below is a *design exercise* derived from the real Compose files.

---

## Chapter 1 — Why orchestration exists

### 1. Why this exists
Compose runs containers on one machine. Production needs several machines, self-healing, rolling updates, scaling, service discovery and secret distribution — automatically.

### 2. Core concept
An orchestrator continuously reconciles **desired state** (declared in YAML) with **actual state** (what's running), across a cluster of nodes.

### 3. Mental model
```text
you: "3 replicas of order-service, image sha256:…, 512 Mi each, ready when /health/ready is 200"
controller loop: observe → compare → act (start, kill, reschedule) → repeat
```

### 4. Delivery Plus mapping — what Compose already gives, and what's missing
| Need | Compose today | Kubernetes |
| --- | --- | --- |
| Restart on crash | `restart: unless-stopped` | Deployment/ReplicaSet |
| Multiple hosts | no | scheduler |
| Rolling update | no (recreate) | Deployment strategy |
| Health-gated traffic | `depends_on: service_healthy` at startup only | readiness probes continuously |
| Scaling | manual `--scale` | HPA |
| Secrets | env vars / `.env` | Secrets (+ external secret managers) |
| Discovery | Docker DNS | Services + cluster DNS |

### 5. Example — see Chapter 3 for the full translation.
### 6. Failure scenario — adopting Kubernetes before having graceful shutdown, readiness checks and stateless services: rolling updates drop requests and duplicate Kafka processing on every deploy.
### 7. Trade-offs — Kubernetes is powerful and operationally expensive; for a small team, a managed container platform (Cloud Run, ECS, App Platform) may deliver 80% of the value with 20% of the effort.
### 8. Performance — scheduling overhead is small; the cost is cluster capacity and people.
### 9. Security — RBAC, network policies, pod security standards, secret encryption at rest — each a new skill.
### 10. Operations — someone owns upgrades, node pools, ingress controllers, certificates and cost.

### 11. Lab — write down three Delivery Plus problems that Kubernetes would solve, and three it would not (hint: outbox, idempotency, authorization).
### 12. Verification — your "would not" list contains application-level problems.

### 13. Interview questions
- *Beginner:* What is a pod?
- *Intermediate:* What does "desired state" mean?
- *Advanced:* What application changes are prerequisites for safe rolling updates?
- *Senior:* Kubernetes vs a managed container platform for this team?

### 14. Senior discussion
What is the smallest production deployment of Delivery Plus that would be safe? Does it need Kubernetes?

---

## Chapter 2 — Core objects

### 1. Why this exists
You need the vocabulary to read and write manifests.

### 2. Core concept
| Object | Purpose |
| --- | --- |
| **Pod** | one or more containers sharing network/storage; the unit of scheduling |
| **Deployment** | manages ReplicaSets of stateless pods; rolling updates, rollbacks |
| **StatefulSet** | stable identities and per-pod volumes (databases, brokers) |
| **Service** | stable virtual IP + DNS name in front of pods (ClusterIP, NodePort, LoadBalancer) |
| **Ingress** / Gateway API | HTTP routing from outside into Services, TLS termination |
| **ConfigMap / Secret** | configuration and secrets injected as env vars or files |
| **Probes** | liveness (restart if failing), readiness (remove from Service if failing), startup (allow slow boot) |
| **Resources** | requests (scheduling guarantee), limits (hard cap) |
| **HPA** | scale replicas on CPU/memory/custom metrics |
| **Job / CronJob** | run-to-completion tasks, scheduled tasks |
| **Namespace** | isolation and quota boundary |
| **PodDisruptionBudget** | how many pods may be down during voluntary disruptions |
| **NetworkPolicy** | which pods may talk to which |

### 3. Mental model — Deployments for code, StatefulSets for data, Services for addresses, Ingress for the front door.
### 4. Delivery Plus mapping — **FUTURE** (Chapter 3).
### 5. Example — a readiness probe for order-service:
```yaml
readinessProbe:
  httpGet: { path: /health/ready, port: 3006 }
  periodSeconds: 5
  failureThreshold: 3
livenessProbe:
  httpGet: { path: /health/live, port: 3006 }
  periodSeconds: 10
```
### 6. Failure scenario — liveness probes that check the database: a PostgreSQL blip restarts *every* pod of every service at once (restart storm). Liveness must check only the process.
### 7. Trade-offs — StatefulSets for PostgreSQL/Kafka in-cluster vs managed services outside the cluster.
### 8. Performance — requests too low → noisy neighbours; too high → wasted nodes.
### 9. Security — Secrets are base64, not encrypted, unless encryption at rest or an external secret store is configured.
### 10. Operations — `kubectl rollout status/undo`, `kubectl describe`, events.

### 11. Lab — map each Compose key of `order-service` in `docker-compose.prod.yml` to a Kubernetes field.
### 12. Verification — `environment` → env/ConfigMap/Secret, `healthcheck` → probes, `depends_on` → (nothing: readiness + retries), `restart` → Deployment.

### 13. Interview questions
- *Beginner:* Deployment vs StatefulSet?
- *Intermediate:* Liveness vs readiness?
- *Advanced:* Requests vs limits and their effect on scheduling and throttling?
- *Senior:* What does Kubernetes do with `depends_on`?

### 14. Senior discussion
Kubernetes has no startup ordering. How must Delivery Plus services behave when their dependencies are not yet available (retry with backoff, readiness false)?

---

## Chapter 3 — Translating Delivery Plus from Compose to Kubernetes (FUTURE design)

```text
Namespace delivery-plus-prod
 ├─ Ingress  api.example.com  (TLS)  ─► Service api-gateway ─► Deployment api-gateway (2+ replicas)
 ├─ Deployments + ClusterIP Services (3001–3011):
 │    auth, user, restaurant, menu, cart, order, payment, delivery, driver, tracking, notification
 ├─ Jobs: migrate-<service>  (run before each rollout; replaces migrations in the Dockerfile CMD)
 ├─ CronJobs: dlq-report (npm run kafka:dlq), backups (if self-hosted PostgreSQL)
 ├─ ConfigMaps: service URLs, Kafka broker list, TTLs, rate limits
 ├─ Secrets (from an external secret manager): JWT signing key, INTERNAL_AUTH_SECRET, DB credentials per service, S3 keys
 ├─ HPA: gateway & read-heavy services on CPU; notification-service on Kafka consumer lag (custom metric)
 ├─ PodDisruptionBudgets: minAvailable 1 per service
 └─ NetworkPolicies: only gateway ← ingress; services ← gateway/allowed callers; DB/Redis/Kafka ← owning services
External (managed): PostgreSQL (or 9 DBs on one managed instance), Redis, Kafka (MSK/Confluent), object storage + CDN
```

| Compose (`docker-compose.prod.yml`) | Kubernetes |
| --- | --- |
| `services.order-service.environment` | ConfigMap + Secret, `envFrom` |
| `healthcheck: wget … /health` | `readinessProbe: /health/ready`, `livenessProbe: /health/live` |
| `depends_on: postgres: service_healthy` | none — readiness false until dependencies answer |
| `restart: unless-stopped` | Deployment controller |
| Docker DNS `http://order-service:3006` | Service DNS `http://order-service.delivery-plus-prod.svc:3006` (short name works in-namespace) |
| `ports: []` for infrastructure | no Ingress/LoadBalancer for them; NetworkPolicy |
| migrations in container `CMD` | a `Job` per service before the Deployment rollout (or a Helm pre-upgrade hook) |
| Kafka consumers in-process | same; HPA on lag needs partitions ≥ replicas to help |

Prerequisite application changes (all tracked as issues):
1. Graceful shutdown with `enableShutdownHooks` (#7) and a `terminationGracePeriodSeconds` that covers it.
2. Dependency-aware readiness (#8); liveness without dependencies.
3. Migrations out of the container entrypoint.
4. Timeouts on internal calls (#6) so a slow pod doesn't hang its callers.
5. More Kafka partitions before scaling consumers horizontally.

Lab: [OPS-12 Compose to Kubernetes translation](labs/devops-labs.md#ops-12-compose-to-kubernetes-translation).

---

## Chapter 4 — Rollouts, autoscaling and stateful workloads

### 1. Why this exists
Changing and scaling running systems without downtime is the main reason to orchestrate.

### 2. Core concept
- Rolling update parameters: `maxSurge`, `maxUnavailable`; rollback with `kubectl rollout undo`.
- HPA: target utilisation or custom metrics (via Prometheus adapter / KEDA for Kafka lag).
- StatefulSets: ordered start, stable network IDs, PVCs; operators (Strimzi for Kafka, CloudNativePG for PostgreSQL) automate failover.

### 3. Mental model — scale stateless things freely; treat stateful things as products with owners.
### 4. Delivery Plus mapping — **FUTURE**: notification-service is the natural lag-based autoscaling target; tracking-service would scale on request rate once drivers send locations.
### 5. Example — KEDA `ScaledObject` (sketch):
```yaml
triggers:
  - type: kafka
    metadata: { bootstrapServers: kafka:9092, consumerGroup: notification-service-group, topic: order.events, lagThreshold: "100" }
```
### 6. Failure scenario — scaling a consumer group beyond the partition count: extra pods sit idle (one partition per topic today).
### 7. Trade-offs — in-cluster databases with operators vs managed databases: control vs operational load.
### 8. Performance — HPA reacts in tens of seconds to minutes; it doesn't absorb sudden spikes — capacity headroom does.
### 9. Security — PVCs hold data; storage classes must encrypt.
### 10. Operations — rehearse a rollback and a node failure before launch.

### 11. Lab — calculate how many partitions `order.events` needs so notification-service can scale to 6 replicas, and what changes in key distribution when you add them.
### 12. Verification — ≥ 6 partitions; existing keys may map to new partitions → per-key ordering is preserved only for new events after the change.

### 13. Interview questions
- *Beginner:* What is a rolling update?
- *Intermediate:* What does HPA scale on?
- *Advanced:* Why can't you scale a Kafka consumer beyond its partitions?
- *Senior:* Run PostgreSQL in Kubernetes or managed — decide for Delivery Plus.

### 14. Senior discussion
Would you adopt Kubernetes before or after the driver app launches? What risk does each order create?

---

[Library index](README.md) · Previous: [Book 18](18-cicd-and-devops.md) · Next: [Book 20 — Observability & Production Engineering](20-observability.md)
