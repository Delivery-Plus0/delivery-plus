# Book 00 — How to Use This Curriculum

[Library index](README.md) · Next: [Book 01 — Software Engineering Fundamentals](01-software-engineering-fundamentals.md)

---

This library turns **Delivery Plus** into an engineering laboratory. Every book teaches a topic from first principles, then shows where that topic lives in the real code, what goes wrong when it is done badly, and how you can break and fix it yourself on your own machine.

It is not product documentation. Product and operational documentation lives in [`docs/`](../README.md) and [`.project-context/`](../../.project-context/00-INDEX.md). This library *uses* the product as a case study.

## 1. What you are studying

Delivery Plus is a food-delivery platform made of:

| Part | What it is | Where |
| --- | --- | --- |
| Backend | 12 NestJS/TypeScript services behind an API Gateway, one shared library | `services/`, `shared/` |
| Data | PostgreSQL 16 (one database per service), Redis 7, Kafka (Confluent 7.6.1 + ZooKeeper), S3-compatible object storage (SeaweedFS locally) | `docker-compose.base.yml`, `docker/postgres/init.sql` |
| Delivery | Docker multi-stage image, Docker Compose overlays (dev, test, prod, e2e), six GitHub Actions workflows | `Dockerfile`, `docker-compose.*.yml`, `.github/workflows/` |
| Customer app | Expo / React Native app (web build tested with Maestro) | separate repository `delivery-plus-customer-app/` |

**Paths in this library.** Backend paths are relative to the `delivery-plus` repository root (for example `services/order-service/src/services/orders.service.ts`). Customer-app paths are written with the repository name in front (for example `delivery-plus-customer-app/src/services/api.ts`); clone that repository next to `delivery-plus` to follow them.

## 2. Status tags — current versus future

Delivery Plus is a real, evolving system. Many senior topics (outbox, WebSockets, geospatial dispatch, Kubernetes) are **not built yet**. To keep you from mistaking a design idea for working code, every project-specific statement carries a tag:

| Tag | Meaning |
| --- | --- |
| **CURRENT** | Exists in the code on `dev` today. You can read it and run it. |
| **PARTIAL** | Exists, but with known gaps that the text names. |
| **PLANNED** | Has a GitHub issue / milestone and an agreed design direction, no code yet. |
| **FUTURE** | A reasonable evolution discussed for learning; no commitment. |
| **NOT USED** | Deliberately not part of the design (and the book explains why). |

If a chapter shows code for a PLANNED or FUTURE idea, the code is illustrative and lives only in the book.

## 3. Levels

| Level | You can… | Typical books |
| --- | --- | --- |
| **Junior** — solid fundamentals | read a service end to end, write correct SQL, debug a failing HTTP request, write unit tests, run the stack in Docker | 01–05, 11, 12, 14, 15 |
| **Intermediate** — service ownership and debugging | own a service: its API, schema, cache, events, tests, CI; debug a cross-service bug from logs and data | 03, 06, 07, 08, 10, 13, 16, 17, 18 |
| **Advanced** — distributed systems and production trade-offs | reason about partial failure, duplicates, ordering, retries, lag, latency percentiles; design DLQ/outbox; build observability | 09, 19–23, 25–27 |
| **Senior** — architecture and judgement | design the platform, estimate scale, defend or reject complexity, plan migrations, lead incident reviews | 24, 28, 29, 30 |

The full reading order, with prerequisites, is in the [library index](README.md#learning-roadmap). Checkpoints that tell you when you have finished a level are in [checkpoints.md](checkpoints.md).

## 4. How every chapter is built

Each chapter follows the same 14 parts so you always know where to look:

1. **Why this exists** — the engineering problem.
2. **Core concept** — taught from first principles.
3. **Mental model** — how to think about it.
4. **Delivery Plus mapping** — real files, tagged CURRENT/PARTIAL/PLANNED/FUTURE.
5. **Example** — small and concrete.
6. **Failure scenario** — what breaks when it is done badly.
7. **Trade-offs** — alternatives and when they win.
8. **Performance** — complexity, latency, throughput.
9. **Security** — what an attacker or a mistake can do.
10. **Operations** — what it looks like in production.
11. **Lab** — something you run (usually linked to [labs/](labs/README.md)).
12. **Verification** — the observable result that proves you understood.
13. **Interview questions** — beginner → senior.
14. **Senior discussion** — an open question with no single right answer.

Where a part does not apply (for example "Security" for Big-O notation) the chapter says so in one line instead of padding.

Many chapters also contain a box like this:

> **Beginner understanding:** what people usually think.
> **Reality:** what actually happens.
> **Production issue:** what fails at scale.
> **Senior concern:** what an experienced engineer weighs.

## 5. Theory-first, lab-first and project-first topics

| Kind | Topics | How to study |
| --- | --- | --- |
| Theory-first | algorithms (02), networking (16), OS (15), distributed-systems theory (09) | read, draw the diagrams yourself, then do the lab |
| Lab-first | PostgreSQL (04–05), Redis (06), Kafka (07), Docker (14), E2E (13) | start the stack, run the lab, then read the chapter that explains what you saw |
| Project-first | idempotency (08), security (17), payments (25), case studies | read the [case study](case-studies/README.md) first, then the chapter |
| Future-architecture | Kubernetes (19), real-time (22), geo (23), advanced data patterns (27) | compare the current design with the proposed one; never assume the proposal exists |

## 6. Setting up the laboratory

You need Docker, Node.js 22, and the repository. From the `delivery-plus` root:

```bash
cp .env.example .env            # local defaults only
alias dc='docker compose -f docker-compose.base.yml -f docker-compose.dev.yml'
dc up -d --build --wait         # builds and starts every service
npm ci && npm run seed          # creates owner/customer/driver accounts and a full order
```

All labs assume this alias and this stack. The [lab index](labs/README.md#lab-environment) lists the helper commands (getting a JWT, opening `psql`, `redis-cli`, Kafka tools).

The isolated E2E stack (`npm run e2e:env:reset`, gateway on `:3100`) is used by the testing and E2E books; see [`docs/e2e.md`](../e2e.md).

## 7. Using AI without outsourcing your understanding

This project is developed with AI assistance, and [Book 30](30-ai-augmented-engineering.md) is dedicated to doing that well. For learning, the rules are:

1. **Predict before you ask.** Write down what you think the answer is, then ask. Compare.
2. **Ask for evidence, not conclusions.** "Show me the lines in `orders.service.ts` that prevent a double confirm" beats "is this safe?".
3. **Verify every claim against the code or a running system.** An AI may invent a file, a flag, or a guarantee. The codebase is the source of truth; the labs are how you check.
4. **Never paste generated code you cannot explain line by line.** If you cannot explain it, you cannot debug it at 3 a.m.
5. **Use AI to generate *questions*.** "Give me five ways this consumer could process an event twice" is a superb study prompt; you then check each one against `shared/src/kafka/kafka-consumer.service.ts`.

## 8. How to verify you actually understand a topic

For any topic (idempotency, indexes, consumer groups, outbox, Redis GEO…), you understand it when you can answer, without notes:

1. What problem does it solve?
2. Why do we need it here?
3. How does it work internally?
4. Where is it used in Delivery Plus (file and function)?
5. What is the simplest implementation?
6. What breaks at scale?
7. What are the alternatives?
8. What are the trade-offs?
9. How do I test it?
10. How do I observe it in production?
11. How do I debug it?
12. What would a senior engineer worry about?
13. What can I experiment with locally?

If you get stuck on 4, use the [code-reading guide](code-reading-guide.md). If you get stuck on 13, use the [labs](labs/README.md).

## 9. Turning chapters into practical work

Every chapter ends with a lab, and many link to a real GitHub issue. A good weekly rhythm:

1. Read one chapter.
2. Do its lab and write down the verification result.
3. Read the related [case study](case-studies/README.md) or [ADR](adrs/README.md).
4. Pick a small change (a test, a log line, a doc fix, or an issue from the current milestone) and make it on a branch.
5. Explain the change to someone else — or write the explanation in the pull request description.

## 10. What this library deliberately does not do

- It does not rewrite application code to make examples nicer. Where the code has a weakness, the book shows it as it is and explains the fix.
- It does not present planned architecture as built. Check the tag.
- It does not replace the official documentation of PostgreSQL, Redis, Kafka, NestJS, or Kubernetes. It tells you which parts matter here and why.

---

[Library index](README.md) · Next: [Book 01 — Software Engineering Fundamentals](01-software-engineering-fundamentals.md)
