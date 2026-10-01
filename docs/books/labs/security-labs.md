# Security Labs

[Lab index](README.md) · Books: [03 HTTP](../03-http-apis-and-web.md), [17 Security Engineering](../17-security-engineering.md)

Set up the [lab environment](README.md#lab-environment) first. These labs attack **your local stack only**.

---

## SEC-01 Status code tour

```bash
code() { curl -s -o /dev/null -w "%{http_code}\n" "$@"; }
reset_limits
code -X POST $API/api/cart/items -H "Authorization: Bearer $CUSTOMER" -H 'content-type: application/json' -d '{"menuItemId":"nope","quantity":0}'   # 400 validation
code $API/api/orders                                                                    # 401 no token
code $API/api/drivers/available -H "Authorization: Bearer $CUSTOMER"                    # 403 role
code $API/api/orders/00000000-0000-4000-8000-000000000999 -H "Authorization: Bearer $CUSTOMER"   # 404
place_order >/dev/null; deliver_order assign-only
code -X POST $API/api/deliveries -H "Authorization: Bearer $OWNER" -H 'content-type: application/json' -d "{\"orderId\":\"$ORDER\"}"   # 409 delivery exists
for i in $(seq 1 31); do c=$(code $API/api/cart -H "Authorization: Bearer $CUSTOMER"); done; echo $c        # 429 on the 31st
for a in pickup start complete; do curl -s -o /dev/null -X POST $API/api/deliveries/$DELIVERY/$a -H "Authorization: Bearer $DRIVER"; done
```
**Expected:** 400, 401, 403, 404, 409, 429 in that order.
**Then decide for each:** should a client retry? (Only 429 after waiting, and 5xx/timeouts for idempotent calls.)
**Links:** [Book 03 Ch. 1](../03-http-apis-and-web.md#chapter-1--requests-responses-methods-status-codes-and-headers).

---

## SEC-02 Inspect and tamper with a JWT

```bash
echo "$CUSTOMER" | cut -d. -f2 | node -e 'const s=require("fs").readFileSync(0,"utf8").trim(); console.log(JSON.parse(Buffer.from(s,"base64url").toString()))'
FORGED=$(node -e '
const [h,p,sig]=process.argv[1].split(".");
const payload=JSON.parse(Buffer.from(p,"base64url")); payload.role="ADMIN";
console.log([h, Buffer.from(JSON.stringify(payload)).toString("base64url"), sig].join("."));' "$CUSTOMER")
curl -s -o /dev/null -w "forged token: %{http_code}\n" $API/api/drivers/available -H "Authorization: Bearer $FORGED"
```
**Expected:** the payload (`sub`, `email`, `role: "CUSTOMER"`, `iat`, `exp`) is readable by anyone; the edited token is rejected with **401** (signature mismatch).
**Why:** a JWT is signed, not encrypted. Never put secrets in it; never trust it without verifying the signature (`JwtAuthGuard` in `shared/src/nest/auth/jwt-auth.guard.ts`).

---

## SEC-03 Mint and inspect a system token

**Goal:** understand the blast radius of the shared `JWT_SECRET`.
```bash
SECRET=$(dc exec -T order-service printenv JWT_SECRET)
SYSTEM=$(node -e '
const jwt=require("jsonwebtoken");
console.log(jwt.sign({ sub: "system:lab", email: "system@lab", role: "ADMIN" }, process.argv[1], { expiresIn: "5m" }));' "$SECRET")
curl -s $API/api/drivers/available -H "Authorization: Bearer $SYSTEM" | j "items.length"
```
**Expected:** the hand-minted ADMIN token lists available drivers — exactly what delivery- and tracking-service's `SystemTokenService` does (`services/delivery-service/src/common/system-token.service.ts`).
**Why it matters:** every service holding `JWT_SECRET` can mint *any* identity, including ADMIN, and receivers can't tell a service from a human admin ([case study 18](../case-studies/18-system-token.md)). Remedies: asymmetric signing, a distinct service role, per-route permissions ([Book 17 Ch. 3](../17-security-engineering.md#chapter-3--service-identity-secrets-and-key-rotation)).
**Note:** `jsonwebtoken` is resolvable from the repository root because `@nestjs/jwt` depends on it; this is a local experiment only.

---

## SEC-04 Brute force versus lockout

```bash
reset_limits
curl -s $API/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"lab.lockout@example.com","password":"password123","fullName":"Lab Lockout"}' | j "userId || message"
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "%{http_code} " $API/api/auth/login -H 'content-type: application/json' -d '{"email":"lab.lockout@example.com","password":"wrong"}'; done; echo
reset_limits
curl -s $API/api/auth/login -H 'content-type: application/json' -d '{"email":"lab.lockout@example.com","password":"password123"}' | j "message || 'logged in'"
psql_db auth_service -c "SELECT \"failedLoginCount\", \"lockedUntil\" FROM credentials WHERE email = 'lab.lockout@example.com';"
```
**Expected:** five 401s; then even the **correct** password is refused while `lockedUntil` is in the future (15 minutes by default); the message stays generic ("Invalid email or password").
**Discuss:** the same mechanism lets an attacker lock a *victim* out ([Book 17 Ch. 1](../17-security-engineering.md#chapter-1--authentication-passwords-lockout-verification-and-tokens)).
**Cleanup:** `psql_db auth_service -c "DELETE FROM credentials WHERE email = 'lab.lockout@example.com';"` (and the matching row in `user_service.user_profiles`).

---

## SEC-05 Presigned upload end to end

Save as `/tmp/upload.mjs` and run `CUSTOMER=$CUSTOMER node /tmp/upload.mjs` from the `delivery-plus` root:
```js
import { readFileSync } from 'node:fs';
const API = 'http://localhost:3000', auth = { Authorization: `Bearer ${process.env.CUSTOMER}` };
const json = { ...auth, 'content-type': 'application/json' };
async function attempt(label, bytes, type, tamperKey) {
  const presign = await (await fetch(`${API}/api/users/me/avatar/image-upload-url`, { method: 'POST', headers: json, body: JSON.stringify({ contentType: 'image/jpeg' }) })).json();
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.fields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type }), 'avatar.jpg');
  const up = await fetch(presign.uploadUrl, { method: 'POST', body: form });
  const objectKey = tamperKey ? presign.objectKey.replace(/users\/[^/]+\//, 'users/00000000-0000-4000-8000-000000000000/') : presign.objectKey;
  const confirm = await fetch(`${API}/api/users/me/avatar/confirm`, { method: 'POST', headers: json, body: JSON.stringify({ objectKey }) });
  console.log(label.padEnd(24), 'upload', up.status, 'confirm', confirm.status, (await confirm.text()).slice(0, 90));
}
const jpeg = readFileSync('scripts/seed-assets/customer-avatar.jpg');
await attempt('real JPEG', jpeg, 'image/jpeg');
await attempt('HTML disguised as JPEG', Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg');
await attempt('someone else\'s key', jpeg, 'image/jpeg', true);
```
**Expected:** the real JPEG uploads (204/200 from storage) and confirms (2xx); the HTML upload reaches storage but **confirm rejects** it ("bytes do not match an allowed image format"); the tampered key is rejected ("outside the authorized resource prefix").
**Why:** the service never trusts the client's content type or key; confirm re-reads the bytes and checks the prefix (`shared/src/storage/s3-storage.service.ts`, [case study 14](../case-studies/14-s3-presigned-uploads.md)).

---

## SEC-06 Least-privilege role for one service

```sql
-- psql_db postgres
CREATE ROLE lab_order_app LOGIN PASSWORD 'lab-only';
REVOKE CONNECT ON DATABASE auth_service FROM PUBLIC;
GRANT CONNECT ON DATABASE order_service TO lab_order_app;
\c order_service
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lab_order_app;
```
```bash
dc exec -e PGPASSWORD=lab-only postgres psql -h localhost -U lab_order_app -d order_service -c "SELECT count(*) FROM orders;"
dc exec -e PGPASSWORD=lab-only postgres psql -h localhost -U lab_order_app -d auth_service -c "SELECT email FROM credentials LIMIT 1;"
```
**Expected:** the first works; the second fails (`permission denied for database auth_service`).
**Cleanup:**
```sql
-- psql_db postgres
GRANT CONNECT ON DATABASE auth_service TO PUBLIC;
\c order_service
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM lab_order_app;
\c postgres
REVOKE CONNECT ON DATABASE order_service FROM lab_order_app;
DROP ROLE lab_order_app;
```
**Why:** today every service connects as the `postgres` superuser; per-service roles turn "one bug = all data" into "one bug = one service's data" ([Book 04 Ch. 11](../04-database-fundamentals.md#chapter-11--database-security-and-least-privilege)).

---

## SEC-07 Reproduce a BOLA check

```bash
reset_limits
curl -s $API/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"lab.other@example.com","password":"password123","fullName":"Lab Other"}' >/dev/null
OTHER=$(login lab.other@example.com | j accessToken)
place_order >/dev/null; deliver_order assign-only
NOTIF=$(curl -s "$API/api/notifications?page=1&limit=1" -H "Authorization: Bearer $CUSTOMER" | j "items[0].id")
curl -s -o /dev/null -w "order:          %{http_code}\n" $API/api/orders/$ORDER -H "Authorization: Bearer $OTHER"
curl -s -o /dev/null -w "delivery:       %{http_code}\n" $API/api/deliveries/$DELIVERY -H "Authorization: Bearer $OTHER"
curl -s -o /dev/null -w "by-order:       %{http_code}\n" $API/api/deliveries/by-order/$ORDER -H "Authorization: Bearer $OTHER"
curl -s -o /dev/null -w "tracking:       %{http_code}\n" $API/api/tracking/delivery/$DELIVERY -H "Authorization: Bearer $OTHER"
curl -s -o /dev/null -w "notif read:     %{http_code}\n" -X PATCH $API/api/notifications/$NOTIF/read -H "Authorization: Bearer $OTHER"
curl -s -o /dev/null -w "payment:        %{http_code}\n" $API/api/payments/$PAYMENT -H "Authorization: Bearer $OTHER"
```
**Expected:** 403 for order, delivery, by-order, tracking and payment; **404** for someone else's notification (existence is not revealed).
**Then finish the delivery** (`pickup`, `start`, `complete` as `$DRIVER`).
**Why:** ownership is checked on every object, often by asking the owning service with the caller's own token ([case studies 02](../case-studies/02-delivery-ownership-bug.md) and [04](../case-studies/04-notification-ownership.md)).

---

## SEC-08 Self-registered admin

**Goal:** confirm the most severe open finding, on your local stack only.
```bash
reset_limits
curl -s $API/api/auth/register -H 'content-type: application/json'   -d '{"email":"lab.admin@example.com","password":"password123","fullName":"Lab Admin","role":"ADMIN"}' | j role
LABADMIN=$(login lab.admin@example.com | j accessToken)
curl -s -o /dev/null -w "admin-only route: %{http_code}
" $API/api/drivers/available -H "Authorization: Bearer $LABADMIN"
```
**Expected (from reading the code):** the response role is `ADMIN` and the admin-only route answers 200 — i.e. self-service privilege escalation.
**Why:** `RegisterDto.role` is validated only as "any `UserRole`" and `AuthService.register` uses it directly. The fix is to accept only self-service roles at public registration (e.g. CUSTOMER, and DRIVER/RESTAURANT_OWNER behind an approval step) and create admins through a separate, protected path — with a negative test.
**Cleanup:** delete the account from `auth_service.credentials` and `user_service.user_profiles`.
**Links:** [case study 21](../case-studies/21-self-registered-admin.md), [Book 17 Ch. 2](../17-security-engineering.md#chapter-2--authorization-rbac-ownership-and-idorbola).

---

[Lab index](README.md)
