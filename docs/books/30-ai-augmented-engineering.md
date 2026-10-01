# Book 30 — AI-Augmented Software Engineering

[Library index](README.md) · Previous: [Book 29](29-senior-engineering-judgment.md) · Next: [Checkpoints](checkpoints.md)

**Level:** all levels (read Chapter 1 early, the rest late).

Delivery Plus is developed with AI assistance. The repositories show it: `.project-context/` documents the backend for humans *and* agents; the customer app has `delivery-plus-customer-app/AGENTS.md`, `CLAUDE.md`, `.github/instructions/` and `.github/skills/`, plus `delivery-plus-customer-app/.project-context/07-ai-agent-architecture.md`; the backend has an automated PR reviewer configured in `.coderabbit.yaml`. This book teaches how to get leverage from AI without outsourcing judgment.

---

## Chapter 1 — Context is the product

### 1. Why this exists
An AI model knows general patterns, not *your* system. Without context it produces plausible code that contradicts your architecture.

### 2. Core concept — repository context: architecture docs, conventions, current state, known gaps, file paths, test commands. Good context is short, true and current.

### 3. Mental model — you are briefing a capable contractor who has never seen the codebase and can't ask the original authors.

### 4. Delivery Plus mapping — **CURRENT**: `.project-context/00-INDEX.md` → per-topic files (`05-event-driven-design.md`, `13-known-issues-and-gotchas.md`, `16-current-state.md`); customer-app agent instructions (`AGENTS.md`, `CLAUDE.md`, `.github/skills/*/SKILL.md`). `16-current-state.md` exists precisely because docs drift and agents (and people) need "what is true now".
### 5. Example — a good prompt includes the files: "Using `shared/src/kafka/kafka-consumer.service.ts` and `services/notification-service/src/services/notifications.service.ts`, list every way an `order.confirmed` event could produce two notifications."
### 6. Failure scenario — stale context: the docs said delivery events were "not published yet" after they were; an agent trusting the README would design around a limitation that no longer existed.
### 7. Trade-offs — more context = better grounding and more tokens/time; curate rather than dump.
### 8–10. n/a.

### 11. Lab — ask an AI assistant to explain the order lifecycle with and without `.project-context/` attached; compare against the code.
### 12. Verification — you list at least one claim in the context-free answer that the code contradicts.

### 13. Interview questions
- *Intermediate:* What makes repository context useful to an AI tool?
- *Senior:* How do you keep AI-facing documentation from drifting?

### 14. Senior discussion
Should "context for AI" and "documentation for humans" be the same files?

---

## Chapter 2 — Prompting for engineering work

### 1. Why this exists
Vague prompts get generic answers.
### 2. Core concept — state the goal, constraints, source of truth, definition of done, and how to verify; ask for evidence and alternatives; ask the model to say what it doesn't know.
### 3. Mental model — prompt like you write a good issue.
### 4. Delivery Plus mapping — the GitHub issues created in the reconciliation (#95–#100) follow this shape: why, current state (verified), proposal, acceptance criteria, dependencies — the same structure works as an AI task brief.
### 5. Example
```text
Goal: make GET /api/deliveries/me/current (issue #96).
Constraints: follow DeliveriesService patterns; ownership via driver-service system token; no schema change except an index if needed.
Source of truth: services/delivery-service/src/**, docs/openapi/delivery-plus-public.json.
Done when: unit tests for assigned/none/terminal/wrong-role pass; OpenAPI regenerated; a live curl as qa.driver returns the delivery.
Before coding: list the files you will change and any open questions.
```
### 6. Failure scenario — "make it production ready": the model adds caching, retries and abstractions nobody asked for (speculative architecture).
### 7. Trade-offs — very detailed prompts constrain creativity; very open ones produce noise.
### 8–10. n/a.

### 11. Lab — rewrite a vague prompt for issue #97 using the template; run both; compare.
### 12. Verification — the structured prompt's output names concrete files and tests.

### 13. Interview questions
- *Intermediate:* What belongs in a coding prompt?
- *Senior:* How do you prevent an assistant from implementing speculative architecture?

### 14. Senior discussion
When is it faster to write the code yourself than to write the prompt?

---

## Chapter 3 — Hallucinations, verification and keeping humans in the loop

### 1. Why this exists
Models state false things fluently: non-existent files, flags, APIs, guarantees.

### 2. Core concept — treat every AI claim as a hypothesis; verify against the code (grep, read), the running system (labs), and tests. Humans own decisions with one-way consequences.

### 3. Mental model
> **Beginner understanding:** "The AI read the code, so it's right."
> **Reality:** it predicts plausible text; it may not have read the file it cites.
> **Production issue:** a confident wrong claim gets merged into docs or code.
> **Senior concern:** what verification step makes the claim cheap to check, and who signs off on irreversible decisions?

### 4. Delivery Plus mapping — real verification habits used while building this project:
- Every path in this library was checked to exist (see [README — How this library is verified](README.md#how-this-library-is-verified)).
- The GitHub issue reconciliation closed issues only after checking code for each claim; several draft statements were corrected before posting (e.g. a refund "returns the refunded payment" claim was wrong — a sequential repeat returns 409).
- An analysis of `createFromCart` initially said a Kafka failure always returns 500; reading the `catch` showed that with an `Idempotency-Key` it returns the saved order instead.
- Retry-safety claims were verified by stopping services mid-flow, not just by unit tests.
### 5. Example — "Kafka guarantees exactly-once delivery to notification-service" → check `kafka-consumer.service.ts`: at-least-once + Redis dedup with a known window. The claim is false.
### 6. Failure scenario — an AI-written doc cites `services/order-service/src/events/outbox.ts` (doesn't exist); a reader wastes an hour, trust in the docs drops.
### 7. Trade-offs — verification takes time; skipping it costs more later.
### 8. Performance — n/a.
### 9. Security — never paste secrets or production data into prompts; seed accounts only.
### 10. Operations — label AI-generated content in PRs so reviewers calibrate.

### 11. Lab — ask an assistant for five facts about Delivery Plus's Redis usage; verify each with `grep` and the [Redis book](06-redis.md) key table.
### 12. Verification — a table: claim, verified (yes/no), evidence.

### 13. Interview questions
- *Beginner:* What is a hallucination?
- *Senior:* What decisions should never be delegated to an AI tool?

### 14. Senior discussion
How do you build a team culture where "I verified it" is expected for AI output without slowing everything down?

---

## Chapter 4 — AI for code review, tests and refactoring

### 1. Why this exists
AI is strongest at breadth (scanning many files, listing edge cases) and weakest at judgment about *this* business.
### 2. Core concept
- **Review**: use AI to find candidate issues (missing ownership checks, unhandled errors, race windows); a human decides.
- **Tests**: AI drafts tests quickly, but tends to test the implementation it sees ("mirror tests") rather than the requirement. Write the cases (especially negative/authorization cases) yourself; let AI fill boilerplate.
- **Refactoring**: AI can do mechanical refactors; behaviour must be protected by tests first.
### 3. Mental model — AI multiplies the reviewer; it doesn't replace the reviewer.
### 4. Delivery Plus mapping — CodeRabbit is configured (`.coderabbit.yaml`) on the backend; the team's merge policy treats it as advisory and gates merges on CI pipelines. The delivery retry-safety tests (`services/delivery-service/src/services/deliveries.service.spec.ts`) are examples of requirement-driven tests (scenarios like "driver-service down during completion"), not mirror tests.
### 5. Example — a mirror test asserts `transition` was called with `{ status: 'DELIVERED' }` — it passes even if the driver is never released. A requirement test asserts the driver is released on retry.
### 6. Failure scenario — AI refactor "simplifies" `OrdersRepository.updateStatus` to `repo.update({ id }, { status })` — tests with mocks still pass; duplicate notifications return in production.
### 7. Trade-offs — AI-generated tests increase coverage numbers faster than confidence.
### 8. Performance — ask AI to explain an `EXPLAIN ANALYZE` plan, then verify its reading node by node.
### 9. Security — AI security reviews find common patterns (injection, missing guards) and miss business-logic authorization; combine with the BOLA checklist in [Book 17](17-security-engineering.md).
### 10. Operations — AI-assisted incident analysis: paste sanitised logs and timelines, ask for hypotheses, test each.

### 11. Lab — check out a commit from before the issue #33 fix (`git log -- services/driver-service/src/common/driver-transition-rules.ts`), then ask an AI tool to review `services/driver-service/src/services/drivers.service.ts` for authorization issues. Does it find the bug (a BUSY driver can set themselves AVAILABLE)?
### 12. Verification — whether it finds it or not, you can explain the bug from the code.

### 13. Interview questions
- *Intermediate:* What is a mirror test?
- *Advanced:* How do you review an AI-generated refactor?
- *Senior:* Policy for AI code review bots in a team.

### 14. Senior discussion
If an AI reviewer finds a real bug in 1 of 20 comments, is it worth the noise?

---

## Chapter 5 — AI for architecture, documentation and learning

### 1. Why this exists
AI can draft ADRs, compare designs and explain code — and can also confidently recommend complexity the system doesn't need.
### 2. Core concept — use AI to enumerate options and failure modes; decide with evidence (measurements, constraints, team capacity); record decisions in ADRs written by people.
### 3. Mental model — AI is a sparring partner for architecture, not an architect.
### 4. Delivery Plus mapping — this library itself is AI-assisted documentation grounded in the code, with status tags (CURRENT/PARTIAL/PLANNED/FUTURE) so suggestions are never mistaken for reality.
### 5. Example — "Should Delivery Plus move to Kubernetes?" An AI will happily produce manifests. The judgment questions (Book 29 Ch. 9) — team size, prerequisites like graceful shutdown — are yours.
### 6. Failure scenario — accepting an AI-proposed event-sourcing rewrite because the explanation was convincing.
### 7. Trade-offs — AI speeds up drafting; it doesn't own consequences.
### 8. Performance — n/a.
### 9. Security — threat-model prompts are useful; validate every claimed control exists.
### 10. Operations — keep generated docs reviewable and tagged.

### 11. Lab — ask an AI for three architectures for nearest-driver search; evaluate each with [Book 23](23-geo-location-systems.md) and [case study 20](case-studies/20-nearest-driver-search.md); pick one and write an ADR.
### 12. Verification — your ADR rejects at least one AI option with evidence.

### 13. Interview questions
- *Senior:* How do you use AI in system design without being led by it?

### 14. Senior discussion
How should a team measure the quality of AI-generated code over time (defect rate, review time, rework), and what result would make you change how you use it?

---

[Library index](README.md) · Previous: [Book 29](29-senior-engineering-judgment.md) · Next: [Checkpoints](checkpoints.md)
