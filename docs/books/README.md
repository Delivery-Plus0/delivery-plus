# Delivery Plus Engineering Library

A curriculum that uses the **real Delivery Plus codebase** as its laboratory. It runs from software fundamentals to distributed systems, production engineering and architecture judgement. It has 31 books, 8 lab sets, 21 case studies, 10 teaching ADRs, checkpoints and a code-reading guide.

**Start here:** [Book 00 — How to Use This Curriculum](00-how-to-use-this-curriculum.md).

> **The code is the source of truth.** Every project-specific statement is tagged **CURRENT**, **PARTIAL**, **PLANNED**, **FUTURE** or **NOT USED**. Planned work is never presented as built. If this library and the code disagree, the code wins. Please fix the library.

---

## Books

| # | Book | Level | Focus in Delivery Plus |
| --- | --- | --- | --- |
| 00 | [How to Use This Curriculum](00-how-to-use-this-curriculum.md) | — | levels, tags, chapter template, study method |
| 01 | [Software Engineering Fundamentals](01-software-engineering-fundamentals.md) | Junior | modules, layering, errors, reading a service |
| 02 | [Data Structures & Algorithms](02-data-structures-and-algorithms.md) | Junior | state machines, sets, pagination, heaps for dispatch |
| 03 | [HTTP, APIs & Web Fundamentals](03-http-apis-and-web.md) | Junior | status codes, gateway, CORS, idempotency keys |
| 04 | [Database Fundamentals](04-database-fundamentals.md) | Junior | schemas per service, transactions, CAS, least privilege |
| 05 | [PostgreSQL Deep Dive](05-postgresql-deep-dive.md) | Junior | indexes, MVCC, plans, migrations, locks |
| 06 | [Redis](06-redis.md) | Intermediate | carts, cache-aside, rate limiting, Lua, AOF |
| 07 | [Kafka](07-kafka.md) | Intermediate | topics, keys, groups, offsets, DLQ, replay |
| 08 | [Idempotency & Distributed Operations](08-idempotency-and-distributed-operations.md) | Intermediate | idempotency keys, durable dedup, retry-safe actions |
| 09 | [Distributed Systems](09-distributed-systems.md) | Advanced | partial failure, ordering, sagas, convergence |
| 10 | [Microservices & Domain Design](10-microservices-and-domain-design.md) | Intermediate | boundaries, ownership, coupling, data per service |
| 11 | [NestJS / TypeScript Backend](11-nestjs-typescript-backend.md) | Junior | modules, DI, guards, pipes, filters |
| 12 | [Testing Engineering](12-testing-engineering.md) | Junior | unit, integration, contract, business-flow tests |
| 13 | [E2E / UI Automation](13-e2e-ui-automation.md) | Intermediate | Maestro, isolated E2E stack, stand-ins, fault injection |
| 14 | [Docker & Containers](14-docker-and-containers.md) | Junior | multi-stage image, Compose overlays, healthchecks |
| 15 | [Linux & OS Fundamentals](15-linux-and-os.md) | Junior | processes, signals, files, memory, PID 1 |
| 16 | [Networking](16-networking.md) | Intermediate | DNS, ports, proxies, TLS, timeouts |
| 17 | [Security Engineering](17-security-engineering.md) | Intermediate | authn/authz, BOLA, service identity, uploads, **open critical finding** |
| 18 | [CI/CD & DevOps](18-cicd-and-devops.md) | Intermediate | the six workflows, gates, releases |
| 19 | [Kubernetes](19-kubernetes.md) | Advanced | **FUTURE** for this project: what it would take |
| 20 | [Observability](20-observability.md) | Advanced | logs, correlation IDs, metrics and alerts (mostly missing) |
| 21 | [Performance Engineering](21-performance-engineering.md) | Advanced | latency percentiles, load tests, caching, pools |
| 22 | [Real-Time Systems](22-real-time-systems.md) | Advanced | polling today, WebSockets/SSE tomorrow |
| 23 | [Geo / Location Systems](23-geo-location-systems.md) | Advanced | driver location, nearest-driver search, ETA |
| 24 | [System Design](24-system-design.md) | Senior | estimating, designing and defending the platform |
| 25 | [Payment Systems](25-payment-systems.md) | Advanced | payment state, side effects, providers, reconciliation |
| 26 | [Reliability Engineering](26-reliability-engineering.md) | Advanced | failure modes, degradation, DLQs, incidents |
| 27 | [Advanced Data Patterns](27-advanced-data-patterns.md) | Advanced | outbox, CDC, read models, event sourcing |
| 28 | [Architecture & Evolution](28-architecture-evolution.md) | Senior | roadmap phases, migrations, technical debt |
| 29 | [Senior Engineering Judgment](29-senior-engineering-judgment.md) | Senior | trade-offs, saying no, reviews, ownership |
| 30 | [AI-Augmented Engineering](30-ai-augmented-engineering.md) | Senior | using AI assistants safely on this codebase |

## Practice

- **[Labs](labs/README.md):** environment setup and the full catalogue.
  - [Database](labs/database-labs.md) (DB-01 … DB-13)
  - [Redis](labs/redis-labs.md) (RD-01 … RD-08)
  - [Kafka](labs/kafka-labs.md) (KF-01 … KF-14)
  - [Distributed systems](labs/distributed-systems-labs.md) (DS-01 … DS-12)
  - [DevOps](labs/devops-labs.md) (OPS-01 … OPS-14)
  - [Geo & algorithms](labs/geo-and-algorithms-labs.md) (GEO-01 … GEO-08)
  - [E2E](labs/e2e-labs.md) (E2E-01 … E2E-05)
  - [Security](labs/security-labs.md) (SEC-01 … SEC-08)
- **[Case studies](case-studies/README.md):** 21 real problems, from symptom to what a senior engineer would ask. Case study 21 ([self-registered admin](case-studies/21-self-registered-admin.md)) is an **open, critical** finding.
- **[Teaching ADRs](adrs/README.md):** nine reconstructed decisions and one proposal (outbox). The project's official ADRs are in [`docs/adr/`](../adr/README.md).
- **[Checkpoints](checkpoints.md):** Junior, Intermediate, Advanced and Senior.
- **[Code-reading guide](code-reading-guide.md):** service layout, plus request paths for orders, payments, Kafka, delivery and the customer app.

---

## Learning roadmap

Times assume about 8–10 focused hours a week. Each stage ends with its checkpoint. Books can be read in parallel within a stage.

```text
Stage 1  Foundations (Junior)                  ~8–10 weeks
  00 → 01 → 11 → 03 → 04 → 05 → 12 → 14 → 15 → 02
  Checkpoint: Junior

Stage 2  Owning a service (Intermediate)        ~8–10 weeks
  06 → 07 → 08 → 10 → 16 → 17 → 13 → 18
  Case studies 01–07, 10, 14, 15 · ADRs 0001–0004, 0006–0009
  Checkpoint: Intermediate

Stage 3  Distributed & production (Advanced)    ~10–12 weeks
  09 → 26 → 20 → 21 → 25 → 27 → 22 → 23 → 19
  Case studies 08, 09, 11–13, 16–20 · ADRs 0005, 0010
  Checkpoint: Advanced

Stage 4  Architecture & judgement (Senior)      ongoing
  24 → 28 → 29 → 30
  Case study 21 · every ADR again, arguing the other side
  Checkpoint: Senior
```

**Prerequisites that matter:**

| Book | Read first |
| --- | --- |
| 07 Kafka | 03, 04 |
| 08 Idempotency | 04, 06, 07 |
| 09 Distributed systems | 07, 08 |
| 13 E2E | 12, 14 |
| 17 Security | 03, 11 |
| 19 Kubernetes | 14, 15, 16 |
| 22 Real-time, 23 Geo | 06, 21 |
| 24 System design | Stages 1–3 |
| 25 Payments | 08, 09 |
| 27 Data patterns | 05, 07, 08 |

**Fast tracks:**
- **Backend developer joining the team:** 00, 01, 11, 04, 08, then the [code-reading guide](code-reading-guide.md) and case studies 01, 02, 08.
- **QA / test automation:** 00, 03, 12, 13, 14, then the [E2E labs](labs/e2e-labs.md) and case study 15.
- **DevOps / SRE:** 00, 14, 15, 16, 18, 20, 26, 19, then the [DevOps labs](labs/devops-labs.md) and case studies 07, 16, 17.

---

## How this library is verified

What was checked, and how:

1. **Paths.** Every backtick path that looks like a repository file (`services/…`, `shared/…`, `scripts/…`, `docs/…`, `docker-compose.*`, `delivery-plus-customer-app/…`) was checked to exist by a script. Deliberate exceptions:
   - illustrative paths for PLANNED or FUTURE code, which are labelled as such in the text;
   - one intentionally fake path in [Book 30](30-ai-augmented-engineering.md), used as an example of an AI hallucination.
2. **Links.** Every relative Markdown link and `#anchor` was checked to resolve to an existing file and heading (GitHub slug rules).
3. **Claims.** Facts about behaviour (TTLs, limits, keys, transitions, defaults, event names) were checked against the source while writing, and corrected where earlier drafts were wrong.
4. **Labs.**
   - The Node-only labs (GEO-02 … GEO-08 and GEO-03's lifecycle graph check) were **executed** and pass.
   - The stack labs (DB, RD, KF, DS, OPS, SEC, E2E) were written against the code, the Compose files and the scripts, but **were not executed end to end while writing**, because no Docker daemon was available.
   - Expected outputs in those labs are predictions. If you find one wrong, fix the lab.
5. **Not verified:** the open finding in [case study 21](case-studies/21-self-registered-admin.md) is confirmed by reading the code, not reproduced live.

Re-verify after big changes: re-run the path and link checks, and spot-check the labs of the areas that changed.

---

Related documentation: [`docs/`](../README.md) (product and operations), [`.project-context/`](../../.project-context/00-INDEX.md) (project context).
