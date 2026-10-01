# Book 18 — CI/CD & DevOps

[Library index](README.md) · Previous: [Book 17](17-security-engineering.md) · Next: [Book 19 — Kubernetes & Orchestration](19-kubernetes.md)

**Level:** Junior → Senior · **Prerequisites:** Git basics, [Book 14](14-docker-and-containers.md).

Delivery Plus has a substantial **CI** (six workflows) and **no CD** yet: images are built and scanned but never pushed or deployed. This book teaches both halves using the real workflows, then designs the missing half.

---

## Chapter 1 — Git, branching, commits and pull requests

### 1. Why this exists
Version control is the audit log of every decision. Bad history makes bugs untraceable and rollbacks risky.

### 2. Core concept
- **Commit**: a snapshot with a message; good commits are small, coherent and explain *why*.
- **Branching models**: trunk-based (short branches into main), GitFlow (long-lived develop/release branches), environment branches.
- **Pull request**: proposal + review + automated checks before merging.
- **Merge strategies**: merge commit (keeps history), squash (one commit per PR), rebase (linear history).
- **Stacked PRs**: PR B built on PR A; merged in order.

### 3. Mental model
`main` (or the default branch) must always be releasable; branches are cheap, merges are reviewed.

### 4. Delivery Plus mapping — **CURRENT**
- Long-lived branches: `main`, `testing`, `dev` (the default branch); feature branches like `feat/...`, `fix/...`, `docs/...` merge into `dev` via PRs with merge commits ("Merge pull request #102 …").
- Conventional-commit style messages (`fix(security): …`, `feat(kafka): …`, `docs: …`).
- PR template: `.github/PULL_REQUEST_TEMPLATE.md` (summary, related issue, changes, testing, breaking changes, docs, checklist). Ownership: `.github/CODEOWNERS`. Issue templates: `.github/ISSUE_TEMPLATE/`.
- Stacked work example: hardening (#102) → Kafka reliability (#103), the second built on the first and opened after it merged.
- Issues are organised into "Phase N · …" milestones.

### 5. Example
```bash
git log --oneline --graph -15 origin/dev
```
### 6. Failure scenario — a PR mixing a refactor, a bug fix and a feature: reviewers can't tell which line changes behaviour; reverting the bug fix also reverts the feature.
### 7. Trade-offs — merge commits keep the PR boundary visible (easy to revert a whole PR); squash gives a clean log but loses intermediate commits.
### 8. Performance — n/a.
### 9. Security — branch protection and required reviews stop one compromised account from pushing to the default branch (configured on GitHub, not in the repo).
### 10. Operations — every production artifact should be traceable to one commit SHA.

### 11. Lab — find the commit that made order status writes compare-and-set (`git log -S "updateStatus(id: string, from" -- services/order-service`) and the PR that merged it.
### 12. Verification — you can name the commit, the PR and the issue it closed.

### 13. Interview questions
- *Beginner:* What makes a good commit message?
- *Intermediate:* Merge vs squash vs rebase?
- *Advanced:* When are stacked PRs worth it?
- *Senior:* Branching strategy for 3 apps + 12 services + 1 shared library.

### 14. Senior discussion
`main`, `testing` and `dev` as long-lived branches: what does each represent, and would trunk-based development with environment *deployments* (not branches) be simpler?

---

## Chapter 2 — Continuous integration: the six workflows

### 1. Why this exists
Every change must prove it doesn't break the build, the tests, the contracts, the migrations or the security baseline — automatically.

### 2. Core concept
CI = build + test + check on every change, fast enough that developers wait for it. Gates should be **reliable**, **fast** and **meaningful**.

### 3. Mental model
Cheap checks run on every PR; expensive checks run when relevant files change.

### 4. Delivery Plus mapping — **CURRENT** (`.github/workflows/`)
| Workflow | Triggers | What it proves |
| --- | --- | --- |
| `ci.yml` | every PR; push to main/testing/dev | `npm ci`, lint, all workspace tests (with a Redis service so the idempotency Lua scripts run for real), build; Compose config; gateway image Trivy scan |
| `pr-quality.yml` | every PR; push | lint, unit tests, build, **OpenAPI drift** (`openapi:generate` + `git diff --exit-code` + `openapi:validate`), Compose config for every overlay |
| `security.yml` | every PR; push; weekly cron; manual | CodeQL, `npm audit` (blocks on critical), Trivy filesystem + secret scan |
| `docker.yml` | PRs/pushes touching Dockerfile, Compose, `shared/`, `services/`, lockfiles | builds all 12 service images (matrix, GHA cache) and Trivy-scans each (fail on CRITICAL) |
| `integration.yml` | PRs/pushes to main/dev except docs-only changes; manual | full Compose test stack with `--wait`, `npm run seed`, Redis `FLUSHDB`, `npm run e2e`, diagnostics artifact on failure, teardown |
| `migration-verification.yml` | PRs/pushes touching migrations, entities, data sources | runs all migrations on fresh DBs, asserts none pending; legacy payment-schema upgrade test (runs `payments.repository.integration.spec.ts`) |

Concurrency groups with `cancel-in-progress: true` stop superseded runs. Customer app: `delivery-plus-customer-app/.github/workflows/ci.yml` (typecheck, lint, unit tests, web export) and `e2e.yml` (Maestro; not yet running — no remote).

### 5. Example — the PR for the Kafka reliability work ran 24 checks (every workflow plus the per-service Docker matrix).
### 6. Failure scenario — path filters that are too narrow: a change to `scripts/seed.ts` doesn't trigger `docker.yml` (correct) but would also skip a workflow that depended on it if filters were copied carelessly. Review filters whenever a workflow's inputs change.
### 7. Trade-offs — more gates = safer and slower; flaky gates get bypassed.
### 8. Performance — caching (`actions/setup-node` cache, Docker GHA cache, npm cache mounts) keeps runs in minutes.
### 9. Security — workflows run with `permissions:` scoped down; secrets are not needed for CI (test credentials only).
### 10. Operations — a red default branch is an incident for the team.

### 11. Lab — open the latest merged PR on GitHub and match each check to a row in the table above.
### 12. Verification — every check maps to a workflow job; you can explain why `integration.yml` doesn't run for docs-only PRs.

### 13. Interview questions
- *Beginner:* What is CI?
- *Intermediate:* Why check OpenAPI drift in CI?
- *Advanced:* What should run on every PR vs nightly?
- *Senior:* How do you keep CI under 10 minutes as the system grows?

### 14. Senior discussion
`ci.yml` and `pr-quality.yml` both lint, test and build. Is the duplication protective (different contexts) or waste? How would you consolidate?

---

## Chapter 3 — Artifacts, caching, environments and configuration

### 1. Why this exists
What you test must be what you ship, configured for where it runs.

### 2. Core concept
- **Build once, deploy many**: the same image digest goes to dev → staging → production; only configuration differs.
- **Artifacts**: images, test reports, diagnostics.
- **Environments**: dev, test/CI, staging, production — each with its own config and secrets.
- **12-factor config**: configuration in environment variables.

### 3. Mental model
Code + config = release. Changing either is a deployment.

### 4. Delivery Plus mapping
- **CURRENT:** environment overlays (`docker-compose.dev.yml`, `test.yml`, `prod.yml`, `e2e.yml`) over `docker-compose.base.yml`; config via env vars with fail-fast `loadConfig()`.
- **CURRENT:** CI artifacts: integration diagnostics (Compose logs), E2E artifacts in the app repo workflow.
- **NOT IMPLEMENTED:** pushed images, staging, production deployment.

### 5. Example — the prod overlay pins behaviour (`NODE_ENV: production`) and requires `JWT_SECRET`, `POSTGRES_PASSWORD`, `CORS_ORIGINS`, S3 settings with `${VAR:?message}`.
### 6. Failure scenario — rebuilding images per environment: staging tested image A, production runs image B built later with a different transitive dependency.
### 7. Trade-offs — env vars are simple; config files/secret managers add validation and rotation.
### 8. Performance — n/a.
### 9. Security — secrets per environment; never reuse dev secrets.
### 10. Operations — record which image digest and config version run in each environment.

### 11. Lab — run `POSTGRES_PASSWORD= docker compose -f docker-compose.base.yml -f docker-compose.prod.yml config` and read the error.
### 12. Verification — Compose refuses with the `must be set` message — config validation before anything starts.

### 13. Interview questions
- *Beginner:* What is a build artifact?
- *Intermediate:* Why "build once, deploy many"?
- *Advanced:* How do you promote an image across environments?
- *Senior:* Design the environment strategy for Delivery Plus.

### 14. Senior discussion
Is the isolated E2E Compose project a reasonable seed for a staging environment, or should staging be built from the production deployment tooling?

---

## Chapter 4 — Continuous delivery and deployment strategies (FUTURE for this project)

### 1. Why this exists
Shipping must be routine, reversible and observable.

### 2. Core concept
| Strategy | How | Rollback | Risk |
| --- | --- | --- | --- |
| Recreate | stop old, start new | redeploy old | downtime |
| Rolling | replace instances gradually | roll back gradually | mixed versions run together |
| Blue/green | full new environment, switch traffic | switch back | double resources |
| Canary | small % of traffic to new version, watch metrics, expand | route back | needs good metrics |
| Feature flags | deploy dark, enable per user | toggle off | flag debt |

### 3. Mental model
Deployment (shipping code) and release (exposing behaviour) are separate steps.

### 4. Delivery Plus mapping — **NOT IMPLEMENTED**. Prerequisites the repo already has: images per service, prod overlay, health endpoints, migrations, CI. Missing: registry push, environments, deploy job, health-gated rollout, metrics for canary analysis ([Book 20](20-observability.md)), graceful shutdown (#7).
### 5. Example — FUTURE pipeline sketch:
```text
merge to dev → CI green → build + push images (tag = SHA) → deploy to staging → run E2E (Maestro + npm run e2e) →
manual approval → run migrations job → rolling deploy production → watch error rate/latency 15 min → done or rollback
```
### 6. Failure scenario — rolling deploy with incompatible event payloads: old consumers receive new events they can't parse → DLQ (good) or wrong behaviour (bad) — another reason for additive-only contract changes (Book 07 Ch. 9).
### 7. Trade-offs — canaries need traffic and metrics; with low traffic, blue/green or plain rolling is simpler.
### 8. Performance — rolling deploys temporarily reduce capacity.
### 9. Security — deploy credentials are the most powerful secrets in CI; use OIDC and least privilege.
### 10. Operations — every deploy should be one click to roll back.

### 11. Lab — write the deploy workflow skeleton (YAML) for one service in a scratch branch; don't merge it.
### 12. Verification — your skeleton includes image tag = commit SHA, a migration step before rollout, a health gate and a rollback path.

### 13. Interview questions
- *Beginner:* What is a rolling deployment?
- *Intermediate:* Blue/green vs canary?
- *Advanced:* Deploy vs release?
- *Senior:* Design CD for Delivery Plus with a team of three.

### 14. Senior discussion
Twelve services released together from one repo: deploy all on every merge, or only changed services? How do you know what "changed" when `shared/` changes?

---

## Chapter 5 — Migrations, release safety and rollback

### 1. Why this exists
Code can be rolled back in seconds; data changes often can't.

### 2. Core concept — expand/contract migrations, forward-only policy, migrations as a separate pre-deploy step, backups before risky changes, feature flags for behaviour changes.
### 3. Mental model — every release must work with the *previous* schema and the *next* code.

### 4. Delivery Plus mapping — **CURRENT**: migrations verified in CI (`migration-verification.yml`), forward-only expectations documented in `docs/deployment.md`, but executed at container start by each service (`Dockerfile` `CMD`). **NOT IMPLEMENTED:** backups before deploy, rollback runbook.
### 5. Example — rolling back code after an "expand" migration is safe (old code ignores the new nullable column); rolling back after a "contract" migration (dropped column) is not.
### 6. Failure scenario — a migration that rewrites a large table runs at container start in production; the new container never becomes healthy; the orchestrator restarts it; the migration restarts.
### 7. Trade-offs — automatic migrations are convenient; explicit migration jobs are controllable.
### 8. Performance — schedule heavy migrations off-peak, or make them online.
### 9. Security — migration credentials should be separate from runtime credentials.
### 10. Operations — a release checklist: migration reviewed, backward compatible, backup taken, rollback plan written.

### 11. Lab — [DB-09 Write and run a migration](labs/database-labs.md#db-09-write-and-run-a-migration).
### 12. Verification — old code still runs against your new schema.

### 13. Interview questions
- *Beginner:* Why are database rollbacks hard?
- *Intermediate:* What is expand/contract?
- *Advanced:* Migrations in the entrypoint vs a job?
- *Senior:* Rollback strategy for a release that included a data migration.

### 14. Senior discussion
Should the CI pipeline block any PR that contains both a destructive migration and code that depends on it?

---

## Chapter 6 — Branch protection, approvals and supply-chain security

### 1. Why this exists
The pipeline itself is an attack surface: whoever can change it can ship anything.

### 2. Core concept — required checks, required reviews, CODEOWNERS, signed commits, pinned actions (by SHA), least-privilege `GITHUB_TOKEN`, dependency review, Dependabot.
### 3. Mental model — protect the default branch like production, because it will become production.
### 4. Delivery Plus mapping — **CURRENT**: CODEOWNERS, PR template, Dependabot, CodeQL, npm audit, Trivy (fs, secret, image). Actions are referenced by tag (e.g. `aquasecurity/trivy-action@v0.36.0`), not by SHA. Branch-protection settings live in GitHub, not in the repository.
### 5. Example — Dependabot PRs that can't pass on their own (#92, #93) were closed in favour of a coordinated upgrade issue (#101) — dependency updates need ownership, not just automation.
### 6. Failure scenario — a compromised third-party action tag is re-pointed to malicious code; every workflow using the tag runs it with repository permissions. Pinning to a commit SHA prevents silent changes.
### 7. Trade-offs — SHA pinning is safer and noisier to update (Dependabot can update SHAs).
### 8. Performance — n/a.
### 9. Security — this chapter.
### 10. Operations — review workflow changes as carefully as production code.

### 11. Lab — list every third-party action used in `.github/workflows/` and whether it is pinned by tag or SHA.
### 12. Verification — your list is complete (grep `uses:`).

### 13. Interview questions
- *Beginner:* What is branch protection?
- *Intermediate:* Why pin actions by SHA?
- *Advanced:* What does CodeQL find that unit tests don't?
- *Senior:* Supply-chain security plan for this repository.

### 14. Senior discussion
Automated dependency updates for a microservice monorepo: group by ecosystem (all `@nestjs/*` together), by service, or by risk? (See issue #101.)

---

[Library index](README.md) · Previous: [Book 17](17-security-engineering.md) · Next: [Book 19 — Kubernetes & Orchestration](19-kubernetes.md)
