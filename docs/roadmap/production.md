# Production roadmap

The plan that takes Delivery Plus from a working test stack to a paid pilot. It covers 10 milestones, **Production 0** to **Production 9**, across five repositories: this backend, the customer, driver and restaurant apps, and the admin app. GitHub milestones and issues are the source of truth. The tables at the end are a snapshot of them on 2026-10-22; when they disagree, GitHub wins.

Every session in any of the five repos reads this file first (see each repo's `CLAUDE.md`).

## Find the current milestone

It's the lowest-numbered open "Production N" milestone. Its open issues, across all repos:

```bash
for r in delivery-plus delivery-plus-customer-app delivery-plus-driver-app delivery-plus-restaurant-app delivery-plus-admin-app; do
  echo "== $r"; gh issue list --repo Delivery-Plus0/$r --state open --json number,title,milestone \
    --jq 'sort_by(.milestone.title) | .[] | "\(.milestone.title) | #\(.number) \(.title)"'
done
```

## Milestones

| # | Milestone | Due | What it unlocks |
| --- | --- | --- | --- |
| M0 | Production 0 · Hotfix | 2026-10-26 | Closes the cheap, dangerous holes: client-forced payment success, unverified drivers taking jobs, leaked 500 messages, rate-limit keys without TTL |
| M1 | Production 1 · Accounts & sessions | 2026-11-02 | Everyone stays signed in, can recover a password and can be suspended. Staff identities exist; services stop using ADMIN tokens; email verification works |
| M2 | Production 2 · Onboarding & service area | 2026-11-16 | Drivers and restaurants apply and wait for approval. Restaurants have a location and a delivery radius. Dispatch is fair and verified-only |
| M3 | Production 3 · Admin console I | 2026-11-30 | The new admin app: admin API conventions, the audit log, approval queues, the people directory, staff permissions |
| M4 | Production 4 · Admin console II | 2026-12-14 | Live operations board, Order 360 with support actions, finance views, restaurant and menu management |
| M5 | Production 5 · Platform hardening & staging | 2026-12-28 | Timeouts, graceful shutdown, readiness, non-root images, NestJS 12, backups, metrics, and a real staging environment with a deploy pipeline |
| M6 | Production 6 · Real money | 2027-01-11 | A payment provider and gateway, real refunds, restaurant settlements and driver payouts |
| M7 | Production 7 · Messaging & mobile | 2027-01-25 | Real SMS, push notifications, nearest-driver dispatch with background location, native builds |
| M8 | Production 8 · Launch readiness | 2027-02-08 | Load test, runbooks, legal pages and account deletion, production bootstrap, pilot go/no-go |
| M9 | Production 9 · After launch | 2027-03-31 | Valuable but not launch-blocking: operating hours, an event contract registry, the shared package contract |

**What sets the order:**
- M1 builds on M0.
- M3 needs M1 (staff identity) and M2 (approval states).
- M6 needs M5 (a public staging environment for payment webhooks) and M4 (finance views).
- M5 is infrastructure work and may run in parallel with M3 and M4.

## Rules for every issue

**Order**
- Run the milestones in order. Inside a milestone, backend issues come before app issues.
- Never start an issue whose **Depends on** issues are still open.
- App issues use the real backend contract (the OpenAPI spec on `dev`), never a mock.

**Decisions**
- If an issue says **decision** and no comment records one, stop and ask the owner. The open ones are listed below.
- Never change a rule in `docs/business/` without the owner's decision.
- Cash on delivery is out of scope.

**Building**
- One issue per branch and PR, branched from up-to-date `dev`: `feat/<name>` or `fix/<name>`.
- Every acceptance criterion needs a test. Follow the existing patterns:
  - compare-and-set status writes;
  - the transactional outbox for events;
  - durable consumer idempotency;
  - HMAC on internal routes (ADR 001);
  - the `shared/` helpers;
  - in the apps, the shared UI kit (`clients/kit-manifest.json`).
- Docs go in the same PR:
  - backend: the OpenAPI spec (`npm run openapi:generate`), `docs/services/*.md`, `.project-context/16-current-state.md`, and `docs/business/*.md` when the owner changed a rule;
  - apps: the README, `e2e/README.md` and `docs/ui-kit.md` where behaviour changed.
- Verify before opening the PR:
  - backend: `npm run verify`, plus the E2E stack (`npm run e2e:start`, then `npm run e2e`) for service behaviour;
  - apps: typecheck, lint, unit tests with translation coverage at 0 missing, `npm run kit:check -- --remote`, and Maestro against the backend E2E stack for user-visible flows.

**Done**
- An issue is done only when its PR is merged to `dev` with every required check green. Never merge red, pending or skipped required checks, and never bypass protection.
- Merge order inside a milestone: backend contract first, then the apps. After each merge, update the next PR from `dev` if it's behind, and let CI run again before merging it.
- Squash merge: the subject is the PR title with `(#N)`, and the body only the `Closes #N` lines. Write "Part of #N" for partial work, and never put the word "closes" before an issue number in the description of a partial PR: GitHub closes it anyway.
- After a merge, tick the issue's acceptance criteria, check that it closed, and delete the branch. When a milestone's last issue closes, close the milestone and update the workspace `planning.md` and `current-story.md`.

**Commits and safety**
- Commit as the owner's git identity. No `Co-Authored-By` lines for Claude or any AI tool, and no generated-by footers in commits or PRs.
- Conventional Commit subjects: `fix(payment-service): …`, `feat(auth): …`, `feat: …` in the apps.
- All repos except the admin app are public: never commit secrets, real customer data, `.env` files or production URLs.
- Never store raw tokens, OTP or email codes, document URLs or phone numbers in logs.
- Never weaken an existing guard (roles, ownership, HMAC, compare-and-set, rate limits) to make a test pass.

## Owner decisions

**Decided**
- **Password reset (#35):** over SMS. Every session is revoked after a change or reset.
- **Cancellation and refunds (#53, #56):** `docs/business/cancellation-and-refunds.md`.
- **Delivery fee (#145):** a flat, configurable fee split 50/50 between the platform and the driver.
- **Email provider (#203):** Amazon SES. The owner does the AWS setup in `docs/runbooks/email-ses.md`; bounces and complaints follow in #242.
- **The admin console** is a separate private app on Expo Router web.
- **No cash on delivery.**

**Still needed, before the milestone shown**

| Before | Decision |
| --- | --- |
| M2 | Default delivery radius and pilot area; mandatory restaurant registration fields; document retention; direct numbers or masked calling during a delivery |
| M4 | Partial refunds: yes or no |
| M5 | Hosting, region and domains; crash-reporting tool; admin app IP restriction |
| M6 | Payment gateway (Paymob assumed; merchant onboarding takes weeks); restaurant commission and settlement period; who carries the cost of a rejected order; driver payout method and cadence |
| M7 | SMS provider and sender ID; iOS at the pilot or later |
| M8 | Legal texts (terms, privacy, Egypt Law 151/2020); pilot size and exit criteria |

## Admin console: modules and permissions

| Module | Who | Permissions |
| --- | --- | --- |
| Operations board (KPIs, attention queues, live map) | Ops | `ops.read`, `ops.act` |
| Orders and Order 360 (timeline, cancel, refund, re-dispatch, notes) | Support, Ops | `support.read`, `support.act` |
| Onboarding queues (driver documents, restaurant review) | Onboarding | `onboarding.review` |
| People (customers, drivers, owners; suspend, sign out everywhere) | Support, Admin | `support.read`, `users.manage` |
| Restaurants and menus (status, radius, hiding items) | Ops | `ops.act` |
| Finance (daily report, refunds, balances, payout runs, reconciliation) | Finance | `finance.read`, `finance.act` |
| Staff and audit log | Super admin | `staff.manage`, `audit.read` |

- Every staff mutation needs a reason, and is written to the audit log in the same transaction (outbox).
- Personal data is masked by default.
- Service (SYSTEM) tokens can never call `/admin` routes.

## Issues by milestone

_Snapshot of GitHub on 2026-10-22. Issue numbers without a prefix are in this repo; `customer#`, `driver#`, `restaurant#` and `admin#` are in the app repos._

### Production 0 · Hotfix

3 of 3 closed.

| Issue | Repo | Title | Depends on | State |
| --- | --- | --- | --- | --- |
| #201 | backend | fix(payment-service): clients can force a simulated payment to succeed; refuse the simulator in production | not stated | ✅ closed |
| #204 | backend | fix(shared): close review findings F3, F7 and F8 | not stated | ✅ closed |
| #206 | backend | feat(driver-service): only VERIFIED drivers can go online or be dispatched | — | ✅ closed |

### Production 1 · Accounts & sessions

8 of 16 closed.

| Issue | Repo | Title | Depends on | State |
| --- | --- | --- | --- | --- |
| #34 | backend | feat(auth): add refresh token lifecycle and session rotation | not stated | ✅ closed |
| #35 | backend | feat(auth): add password change and recovery workflows | #34 | open |
| #202 | backend | feat(auth): account status, staff identities and a separate SYSTEM principal | #34 | ✅ closed |
| #203 | backend | feat(auth): actually deliver verification emails through an EmailSender port | — | ✅ closed |
| #205 | backend | fix(cart-service): lost updates on concurrent cart writes (F6) | not stated | ✅ closed |
| #251 | backend | fix(api-gateway): count the real client IP behind trusted proxies so rate limits are per client | — | ✅ closed |
| #252 | backend | feat(auth): 403 EmailNotVerified on sign-in, and a test-stack switch for email verification | #203 | open |
| customer#52 | customer | feat: refresh-token sessions, sign-out, change and forgotten password | #34, #35 | open |
| customer#53 | customer | fix: clipped tab-bar labels on web and unmirrored back arrows in Arabic | not stated | ✅ closed |
| customer#66 | customer | feat: email verification code screen after sign-up and on an unverified sign-in | #203, #252 | open |
| driver#44 | driver | feat: refresh-token sessions, sign-out, change and forgotten password | #34, #35 | open |
| driver#45 | driver | fix: clipped tab-bar labels on web and unmirrored back arrows in Arabic | not stated | ✅ closed |
| driver#58 | driver | feat: email verification code screen after sign-up and on an unverified sign-in | #203, #252 | open |
| restaurant#26 | restaurant | feat: refresh-token sessions, sign-out, change and forgotten password | #34, #35 | open |
| restaurant#27 | restaurant | fix: today summary "order/orders" not translated, back arrows not mirrored in Arabic | not stated | ✅ closed |
| restaurant#38 | restaurant | feat: email verification code screen after sign-up and on an unverified sign-in | #203, #252 | open |

### Production 2 · Onboarding & service area

0 of 8 closed.

| Issue | Repo | Title | Depends on | State |
| --- | --- | --- | --- | --- |
| #207 | backend | feat(driver-service): driver application with private documents and resubmission | #202, #206 | open |
| #208 | backend | feat(restaurant-service): restaurant application and approval lifecycle | #209 | open |
| #209 | backend | feat: restaurant location, delivery radius and out-of-area rejection | not stated | open |
| #210 | backend | fix(dispatch): pick the longest-idle verified driver instead of the most recently updated | not stated | open |
| #211 | backend | feat: contact between driver, customer and restaurant during an active delivery | #208 | open |
| customer#54 | customer | feat: delivery location first, out-of-area states and contact on the live order | not stated | open |
| driver#46 | driver | feat: driver application flow, review states and contact buttons | not stated | open |
| restaurant#28 | restaurant | feat: restaurant onboarding wizard and review states | not stated | open |

### Production 3 · Admin console I: foundation & approvals

0 of 9 closed.

| Issue | Repo | Title | Depends on | State |
| --- | --- | --- | --- | --- |
| #212 | backend | feat: admin API conventions, permission guard and gateway routing | #202 | open |
| #213 | backend | feat: audit-service with an append-only log of every staff action | #212 | open |
| #214 | backend | feat: admin read APIs for users, drivers and restaurants | #212, #207, #208 | open |
| #215 | backend | feat: admin actions for approvals, suspensions and session revocation | #212, #213, #206, #207, #208 | open |
| #216 | backend | feat(auth): staff accounts, invitations and permission management | #202, #203, #212, #213 | open |
| admin#1 | admin | chore: scaffold the admin app (Expo Router web, kit, i18n, Maestro, CI) | #212, #216 | open |
| admin#2 | admin | feat: approval queues for drivers and restaurants | #214, #215, admin#1 | open |
| admin#3 | admin | feat: people directory with suspend, reactivate and sign-out-everywhere | #214, #215, admin#1 | open |
| admin#4 | admin | feat: staff management and the audit log viewer | #213, #216, admin#1 | open |

### Production 4 · Admin console II: operations, support & finance views

0 of 8 closed.

| Issue | Repo | Title | Depends on | State |
| --- | --- | --- | --- | --- |
| #217 | backend | feat: order status history and an order 360 timeline API | #212, #202 | open |
| #218 | backend | feat: live operations API (queues, stuck orders, online drivers) | #212, #217 | open |
| #219 | backend | feat: support actions (cancel, refund, re-dispatch, internal notes) | #217, #213 | open |
| #220 | backend | feat: finance read APIs (daily totals, refunds, driver ledgers) | #212 | open |
| admin#5 | admin | feat: live operations board | #218, admin#1 | open |
| admin#6 | admin | feat: order search and order 360 with support actions | #217, #219, admin#1 | open |
| admin#7 | admin | feat: finance views and CSV export | #220, admin#1 | open |
| admin#8 | admin | feat: restaurant and menu management | #214, #215, admin#1 | open |

### Production 5 · Platform hardening & staging

0 of 14 closed.

| Issue | Repo | Title | Depends on | State |
| --- | --- | --- | --- | --- |
| #6 | backend | feat: add timeouts and bounded failure handling to internal HTTP clients | not stated | open |
| #7 | backend | feat: add graceful shutdown and Kafka consumer draining | not stated | open |
| #8 | backend | feat: standardize dependency-aware health and readiness checks | not stated | open |
| #14 | backend | security: harden production container and configuration defaults | not stated | open |
| #15 | backend | feat: add service metrics and actionable operational alerts | not stated | open |
| #16 | backend | ops: document and validate PostgreSQL backup and restore | not stated | open |
| #101 | backend | chore(deps): coordinated NestJS 12 and uuid upgrade | not stated | open |
| #221 | backend | feat(ops): image registry, staging environment and deploy pipeline with rollback | #14, #8, #101 | open |
| #222 | backend | chore(deps): clean up Dependabot across all repos and group updates | #101 | open |
| #242 | backend | feat(auth): handle SES bounces, complaints and the suppression list | #203, #221 | open |
| customer#55 | customer | chore: per-environment config, staging build and crash reporting | #221 | open |
| driver#47 | driver | chore: per-environment config, staging build and crash reporting | #221 | open |
| restaurant#29 | restaurant | chore: per-environment config, hosted staging and production web builds, crash reporting | #221 | open |
| admin#9 | admin | chore: per-environment config, hosted staging and production web builds, crash reporting | #221 | open |

### Production 6 · Real money

0 of 10 closed.

| Issue | Repo | Title | Depends on | State |
| --- | --- | --- | --- | --- |
| #20 | backend | test: add payment failure and retry integration coverage | not stated | open |
| #223 | backend | feat(payment-service): PaymentProvider port; the simulator can no longer run in production | — | open |
| #224 | backend | feat(payment-service): first real payment gateway with webhooks, reconciliation and refunds | #223, #221 | open |
| #225 | backend | feat: restaurant earnings ledger and settlements | #220, #213 | open |
| #226 | backend | feat(delivery-service): driver payouts in the earnings ledger | #220, #213 | open |
| #227 | backend | feat(notification-service): notify a declined payment and a completed refund | not stated | open |
| customer#56 | customer | feat: real payment checkout (method choice, provider page, pending and retry states) | #224, #227 | open |
| driver#48 | driver | feat: payouts in the wallet | #226 | open |
| restaurant#30 | restaurant | feat: earnings and settlements screen | #225 | open |
| admin#10 | admin | feat: payout runs and payment reconciliation | #224, #225, #226, admin#7 | open |

### Production 7 · Messaging & mobile

0 of 9 closed.

| Issue | Repo | Title | Depends on | State |
| --- | --- | --- | --- | --- |
| #51 | backend | feat(notification-service): define notification templates and user preference contracts | not stated | open |
| #228 | backend | feat(user-service): first real SMS provider behind SmsSender | #35, #221 | open |
| #229 | backend | feat(notification-service): push notifications with device tokens, retries and failure tracking | #6, #221 | open |
| #230 | backend | feat(dispatch): nearest available driver using recent locations (F11) | #209, #210 | open |
| customer#57 | customer | feat: push notifications and deep links | #229, customer#58 | open |
| customer#58 | customer | chore: native Android and iOS builds, brand icon and store listing | not stated | open |
| driver#49 | driver | feat: push for new jobs and background location during a job | #229, #230, driver#50 | open |
| driver#50 | driver | chore: native Android build, brand icon and store listing | not stated | open |
| restaurant#31 | restaurant | feat: new-order alert with sound and browser notification | not stated | open |

### Production 8 · Launch readiness

0 of 8 closed.

| Issue | Repo | Title | Depends on | State |
| --- | --- | --- | --- | --- |
| #231 | backend | test: load test checkout, dispatch and tracking | #221, #6, #7, #8, #15 | open |
| #232 | backend | docs(ops): production runbooks and on-call | #15, #16, #221 | open |
| #233 | backend | feat: account deletion and data export | #202, #207 | open |
| #234 | backend | chore: production bootstrap (first super admin, no seeds, launch config) | not stated | open |
| #235 | backend | chore: pilot launch plan and go/no-go checklist | not stated | open |
| customer#59 | customer | feat: legal pages and in-app account deletion | #233 | open |
| driver#51 | driver | feat: legal pages and in-app account deletion | #233 | open |
| restaurant#32 | restaurant | feat: legal pages and account deletion request | #233 | open |

### Production 9 · After launch

0 of 3 closed.

| Issue | Repo | Title | Depends on | State |
| --- | --- | --- | --- | --- |
| #23 | backend | feat: add a versioned Kafka event contract registry and runtime validation | not stated | open |
| #30 | backend | feat: harden the shared package runtime and export contract | not stated | open |
| #58 | backend | feat(restaurant-service): define explicit operating hours and availability policy | not stated | open |
