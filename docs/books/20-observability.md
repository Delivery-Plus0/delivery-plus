# Book 20 — Observability & Production Engineering

[Library index](README.md) · Previous: [Book 19](19-kubernetes.md) · Next: [Book 21 — Performance Engineering](21-performance-engineering.md)

**Level:** Intermediate → Senior · **Prerequisites:** [Book 07](07-kafka.md), [Book 11](11-nestjs-typescript-backend.md).

Observability is the ability to answer *new* questions about a running system from the outside. Delivery Plus has the beginnings — structured logs, correlation IDs, health endpoints, Kafka UI — and lacks metrics, tracing and alerting (issue #15). This book teaches the full discipline and designs what's missing on top of what exists.

---

## Chapter 1 — Logs, metrics and traces

### 1. Why this exists
Without telemetry, every incident starts with "can you reproduce it?".

### 2. Core concept
| Signal | What | Good for | Cost |
| --- | --- | --- | --- |
| **Logs** | discrete events with context | "what happened to *this* request?" | storage per event |
| **Metrics** | numeric time series (counters, gauges, histograms) | trends, alerts, "how many / how slow" | cheap, low detail |
| **Traces** | a request's path across services as spans with timing | "where did the time go?" | sampling needed |

### 3. Mental model
Metrics tell you **that** something is wrong, traces tell you **where**, logs tell you **why**.

### 4. Delivery Plus mapping
| Signal | Status |
| --- | --- |
| Structured JSON logs (Winston: `timestamp`, `level`, `service`, `environment`, message, context) — `shared/src/logging/logger.ts` | **CURRENT** for startup and the global error filter |
| Plain-text Nest `Logger` lines (e.g. `KafkaConsumerService`) | **CURRENT, inconsistent** (two formats in one stream; Book 11 Ch. 5) |
| Metrics (Prometheus, OpenTelemetry) | **NOT IMPLEMENTED** (#15) |
| Distributed tracing | **NOT IMPLEMENTED** |
| Kafka visibility: Kafka UI (`:8085`), `kafka-consumer-groups`, `npm run kafka:dlq` | **CURRENT** (manual) |
| Health: `/health`, `/health/live`, `/health/ready` per service | **CURRENT** (readiness semantics uneven, #8) |

### 5. Example
```bash
alias dc='docker compose -f docker-compose.base.yml -f docker-compose.dev.yml'
dc logs --since 5m order-service | grep '"level":"warn"'
```
### 6. Failure scenario — logs only: "checkout is slow" — you can grep individual requests, but you cannot see p95 over the last hour or which service got slower.
### 7. Trade-offs — logs are flexible and expensive at volume; metrics are cheap and rigid; traces are insightful and need instrumentation everywhere.
### 8. Performance — logging every request body at `info` costs CPU, I/O and money; log decisions and failures, sample the rest.
### 9. Security — never log tokens, passwords, presigned URLs or full addresses.
### 10. Operations — choose a log pipeline (Loki, Elasticsearch, a cloud service) before you need it at 3 a.m.

### 11. Lab — [OPS-13 Follow one request through the logs](labs/devops-labs.md#ops-13-follow-one-request-through-the-logs).
### 12. Verification — you find every log line for one checkout and note where the trail breaks.

### 13. Interview questions
- *Beginner:* Logs vs metrics?
- *Intermediate:* What is a histogram metric for?
- *Advanced:* Why are traces sampled?
- *Senior:* Minimum observability for production launch?

### 14. Senior discussion
Which one signal would you add first to Delivery Plus with one week of effort — metrics, tracing, or log aggregation? Why?

---

## Chapter 2 — Correlation IDs, request IDs and distributed tracing

### 1. Why this exists
One customer action touches up to eight services and three topics. You need a thread to pull.

### 2. Core concept
- **Request ID**: unique per HTTP request hop.
- **Correlation ID**: shared by everything caused by one user action, propagated across hops (headers, event envelopes).
- **Distributed tracing** (OpenTelemetry): trace ID + span IDs with parent links and timings; W3C `traceparent` header; context propagated into Kafka headers.

### 3. Mental model
```text
App ─(x-correlation-id: C)─► order-service ─(C)─► cart-service
                               └─ order.created (correlationId: C) ─► notification-service (logs C)
```
That is the goal. Today the thread breaks at most hops.

### 4. Delivery Plus mapping
- **CURRENT:** `CorrelationIdMiddleware` reuses an incoming `x-correlation-id` or creates one, adds a `requestId`, echoes the header; the error filter includes `correlationId` in every error body.
- **CURRENT, propagated:** only auth-service → user-service profile creation forwards `x-correlation-id` (`services/auth-service/src/common/user-service.client.ts`).
- **CURRENT, not propagated:** every other service client (`services/*/src/common/*.client.ts`) and every Kafka event — events get a fresh `generateCorrelationId()` in the producer code (`orders.service.ts`, `payments.service.ts`, `deliveries.service.ts`).
- **NOT IMPLEMENTED:** OpenTelemetry.

### 5. Example — the fix in two lines per client (FUTURE): pass the current correlation ID into `headers: { 'x-correlation-id': id }`, and into `BaseEvent.correlationId` instead of a new one; consumers then log it. OpenTelemetry auto-instrumentation for HTTP, Express, `pg`, ioredis and kafkajs does this and more.
### 6. Failure scenario — a customer reports "my order was never confirmed". Support has the error's correlation ID from the app, but the payment and Kafka hops have different IDs; reconstructing the path takes an hour of timestamp matching instead of one search.
### 7. Trade-offs — manual propagation is simple and partial; OpenTelemetry is complete and adds a dependency, collectors and storage.
### 8. Performance — tracing overhead is small with sampling (1–10%), plus 100% for errors.
### 9. Security — correlation IDs are not secrets but must not be used for authorization.
### 10. Operations — make the correlation ID visible to support (shown in the app's error screen or copied with "report a problem").

### 11. Lab — [OPS-13 Follow one request through the logs](labs/devops-labs.md#ops-13-follow-one-request-through-the-logs).
### 12. Verification — you identify exactly which hop drops the correlation ID.

### 13. Interview questions
- *Beginner:* What is a correlation ID?
- *Intermediate:* How do you propagate context through Kafka?
- *Advanced:* What is W3C trace context?
- *Senior:* Plan OpenTelemetry adoption across 12 services.

### 14. Senior discussion
Event `correlationId` vs trace ID: are they the same thing? Should events carry both a causation ID (the event that caused this one) and a correlation ID?

---

## Chapter 3 — Metrics that matter: RED, USE, percentiles and cardinality

### 1. Why this exists
Averages lie; the wrong labels bankrupt your metrics system.

### 2. Core concept
- **RED** (for services): **R**ate, **E**rrors, **D**uration per endpoint.
- **USE** (for resources): Utilisation, Saturation, Errors.
- **Percentiles**: p50 (typical), p95/p99 (tail). Averages hide the slow 1% — which, across 8 hops, hits many users.
- **Cardinality**: number of unique label combinations. `userId` or `orderId` as a label = millions of series = an outage of your metrics system.

### 3. Mental model — label by route template, status class, service; never by IDs.

### 4. Delivery Plus mapping — **FUTURE** metric catalogue
| Metric | Type | Labels |
| --- | --- | --- |
| `http_server_requests_seconds` | histogram | service, method, route template (`/orders/:id`), status class |
| `http_client_requests_seconds` | histogram | service, target service, outcome |
| `kafka_consumer_lag` | gauge | group, topic, partition |
| `kafka_handler_seconds`, `kafka_handler_attempts_total`, `kafka_dead_letter_total` | histogram/counters | group, event type, reason |
| `kafka_idempotency_skipped_total` | counter | group, event type |
| `orders_status_transitions_total` | counter | from, to |
| `payments_outcome_total` | counter | status |
| `deliveries_retry_resumed_total` | counter | action |
| `rate_limit_rejections_total` | counter | service, route |
| `db_pool_in_use`, `db_pool_waiting` | gauges | service |

### 5. Example — why p99 matters: if each of 8 hops has p99 = 100 ms, the chance a request avoids every hop's slow 1% is 0.99⁸ ≈ 92% — so ~8% of checkouts see at least one 100 ms+ hop.
### 6. Failure scenario — labelling `kafka_handler_seconds` with `eventId`: one new series per event, forever.
### 7. Trade-offs — histograms with fixed buckets (Prometheus) vs summaries/sketches; more buckets = more precision and more series.
### 8. Performance — metric collection is cheap; scraping thousands of series per pod adds up.
### 9. Security — metrics endpoints can leak internals; don't expose them through the gateway.
### 10. Operations — dashboards per service (RED) + per resource (USE) + per business flow.

### 11. Lab — [OPS-05 Load test the restaurant list](labs/devops-labs.md#ops-05-load-test-the-restaurant-list) (compute p50/p95/p99 by hand from the results).
### 12. Verification — you can explain why your p99 is much higher than your average.

### 13. Interview questions
- *Beginner:* What is p95?
- *Intermediate:* RED vs USE?
- *Advanced:* What is metric cardinality and how does it fail?
- *Senior:* Design the metrics for the delivery lifecycle.

### 14. Senior discussion
Which business metrics (orders/minute, payment failure rate, time-to-dispatch) belong in the same system as technical metrics, and who should see them?

---

## Chapter 4 — SLIs, SLOs, SLAs, error budgets and alerting

### 1. Why this exists
"Is the system healthy?" needs a definition agreed with the business, or every alert is an argument.

### 2. Core concept
- **SLI**: a measured indicator (e.g. % of checkout requests that succeed in < 2 s).
- **SLO**: the target (99.5% over 28 days).
- **SLA**: a contract with consequences (usually looser than the SLO).
- **Error budget**: 100% − SLO; spending it fast triggers action (freeze risky releases).
- **Alerting**: page on symptoms that hurt users (SLO burn rate), not on every cause; tickets for the rest.

### 3. Mental model — alert on what customers feel; investigate causes with dashboards.

### 4. Delivery Plus mapping — **FUTURE** proposal
| User journey | SLI | SLO (example) |
| --- | --- | --- |
| Checkout | successful `POST /api/orders` + payment process < 3 s | 99.5% |
| Order status freshness | time from `delivery.*` event to order status updated | 99% < 30 s |
| Notification | time from `order.confirmed` to notification row | 99% < 60 s (consumer lag) |
| Browse | `GET /api/restaurants` < 500 ms | 99.9% |
| Dead letters | messages in any `.dlq` older than 1 h | 0 (ticket, not page) |

### 5. Example — burn-rate alert: page if the checkout error budget would be exhausted in < 2 days at the current rate (multi-window: 1 h and 6 h).
### 6. Failure scenario — alerting on CPU > 80% for every service: pages at night for harmless spikes, ignored pages during real incidents.
### 7. Trade-offs — strict SLOs cost engineering time and infrastructure; loose ones cost customers.
### 8. Performance — SLOs turn performance work into a budgeted decision.
### 9. Security — security events (spikes of 401/403, lockouts) deserve their own alerts.
### 10. Operations — every alert needs a runbook (`docs/runbooks/` is the place).

### 11. Lab — write SLOs for the driver app's "current delivery" endpoint (#96) and the alert you'd page on.
### 12. Verification — your SLO has an SLI with a numerator, denominator and window.

### 13. Interview questions
- *Beginner:* SLA vs SLO?
- *Intermediate:* What is an error budget?
- *Advanced:* Why alert on burn rate rather than raw error rate?
- *Senior:* Who decides SLOs and what happens when they're missed?

### 14. Senior discussion
Before real customers exist, are SLOs useful? What would you measure in the E2E environment instead?

---

## Chapter 5 — Health checks, readiness, liveness and graceful shutdown in production

### 1. Why this exists
Orchestrators and load balancers act on health signals; wrong signals cause outages.

### 2. Core concept
- **Liveness**: "is the process stuck?" → restart. Must not depend on external systems.
- **Readiness**: "can I serve traffic now?" → route or not. May check dependencies (carefully).
- **Startup**: "still booting" → wait.
- **Graceful shutdown**: readiness false → drain → stop consumers → close connections → exit.

### 3. Mental model — liveness protects the process; readiness protects the users.

### 4. Delivery Plus mapping
- **CURRENT:** every service except the gateway exposes `/health`, `/health/live`, `/health/ready`; the gateway exposes `/health` and `/health/live`. Compose uses `/health`.
- **PARTIAL:** readiness semantics differ per service; notification-service returns HTTP 200 with `status: "ERROR"` when the DB is down; Kafka-backed services don't check Kafka (#8).
- **NOT IMPLEMENTED:** graceful shutdown (#7).

### 5. Example
```bash
dc stop postgres
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/health          # gateway still OK
dc exec order-service wget -qO- http://localhost:3006/health/ready        # what does it say?
dc start postgres
```
### 6. Failure scenario — readiness that fails when Kafka is briefly unavailable takes *every* Kafka-using pod out of rotation → total outage of HTTP endpoints that didn't need Kafka.
### 7. Trade-offs — dependency checks in readiness: accurate routing vs correlated failures.
### 8. Performance — probes must be cheap and time-bounded.
### 9. Security — health endpoints shouldn't reveal versions or internal hostnames.
### 10. Operations — health status changes are events worth logging.

### 11. Lab — [OPS-08 Healthcheck and dependency failure](labs/devops-labs.md#ops-08-healthcheck-and-dependency-failure).
### 12. Verification — you tabulate each service's `/health/ready` response with PostgreSQL stopped.

### 13. Interview questions
- *Beginner:* Liveness vs readiness?
- *Intermediate:* Why must liveness not check the database?
- *Advanced:* What should notification-service's readiness check?
- *Senior:* Design health semantics for all services (#8).

### 14. Senior discussion
Should a service whose Kafka consumer is disconnected but whose HTTP API works be "ready"?

---

## Chapter 6 — Consumer lag, throughput, retries and failure rates

### 1. Why this exists
Asynchronous systems fail quietly; the signals are lag, retries and dead letters.

### 2. Core concept — lag (messages and time), processing rate vs arrival rate, retry rate, DLQ rate, rebalance rate, saturation (handler concurrency).
### 3. Mental model — lag grows when arrival rate > processing rate; time-lag (age of oldest unprocessed message) is what users feel.
### 4. Delivery Plus mapping — **CURRENT, manual**: `kafka-consumer-groups --describe`, Kafka UI, consumer warn/error logs, `npm run kafka:dlq`. **FUTURE**: lag exporter + alerts. See [case study 17](case-studies/17-consumer-lag.md).
### 5. Example — stop notification-service for 2 minutes during `npm run e2e`; lag rises; restart; it drains in seconds.
### 6. Failure scenario — a poison message before DLQs existed: offset committed after 3 failures with only a log line — silent data loss. Now: a DLQ entry an alert can watch.
### 7. Trade-offs — lag alerts by count vs by age: count is easy, age matches user impact.
### 8. Performance — per-message commits limit throughput; batch commits raise it.
### 9. Security — n/a.
### 10. Operations — runbook in [Book 07 Ch. 10](07-kafka.md#chapter-10--observability-and-operational-failures).

### 11. Lab — [KF-06 Consumer lag](labs/kafka-labs.md#kf-06-consumer-lag).
### 12. Verification — you measure drain rate (messages/second) after restart.

### 13. Interview questions
- *Beginner:* What is consumer lag?
- *Intermediate:* Lag in messages vs lag in time?
- *Advanced:* Lag is rising but CPU is low — causes?
- *Senior:* Autoscale consumers on lag — what can go wrong?

### 14. Senior discussion
Retries inside the consumer hide transient failures from metrics unless you count them. What retry and DLQ rates would you consider healthy?

---

[Library index](README.md) · Previous: [Book 19](19-kubernetes.md) · Next: [Book 21 — Performance Engineering](21-performance-engineering.md)
