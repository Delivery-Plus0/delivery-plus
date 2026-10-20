# Runbook: send verification emails through Amazon SES

auth-service sends the email-verification code (#203) through Amazon SES when `EMAIL_PROVIDER=ses`. This runbook covers the one-time AWS setup and the settings. Bounce and complaint handling and the suppression list are follow-up work (see "Not covered yet").

## What auth-service needs

| Setting | Value |
| --- | --- |
| `EMAIL_PROVIDER` | `ses` |
| `AWS_REGION` | The SES region you set up below, e.g. `eu-west-1`. Use the same region for every step. |
| `SES_FROM_ADDRESS` | The sender, on your verified domain, e.g. `no-reply@your-domain.example` |
| `SES_CONFIGURATION_SET` | Optional. A configuration set for sending metrics and, later, bounce events |
| `EMAIL_CODE_HASH_SECRET` | A random secret of at least 32 characters, e.g. `openssl rand -hex 32`. It isn't an AWS value. |
| `EMAIL_SEND_TIMEOUT_MS` | Optional, default `5000` |

**AWS credentials:**
- Never put access keys in the repository, in compose files or in `.env`.
- auth-service uses the default AWS provider chain only: the task or instance role on AWS, or `AWS_PROFILE`/SSO on a workstation.
- Give the role the policy below.

auth-service refuses to start in production when:
- `EMAIL_PROVIDER=ses` without `AWS_REGION` or `SES_FROM_ADDRESS`;
- `EMAIL_PROVIDER=test`;
- `EMAIL_VERIFICATION_REQUIRED=true` while the provider is `disabled`;
- a provider is set without a real `EMAIL_CODE_HASH_SECRET`.

## 1. Verify the sending domain (DKIM)

1. SES console → **Identities** → **Create identity** → **Domain**, for example `your-domain.example`.
2. Keep **Easy DKIM** with RSA 2048-bit, and let SES publish the records if the domain is in Route 53. Otherwise add the three `CNAME` records it shows at your DNS provider.
3. Wait until the identity shows **Verified** and DKIM shows **Successful**. That's usually minutes, but it can take up to 72 hours.

## 2. Custom MAIL FROM, SPF and DMARC

1. On the identity → **Custom MAIL FROM domain** → for example `mail.your-domain.example`.
   - Add the `MX` record it shows: `feedback-smtp.<region>.amazonses.com`, priority 10.
   - Add the `TXT` SPF record: `v=spf1 include:amazonses.com ~all`.
2. **DMARC.** Add a `TXT` record on `_dmarc.your-domain.example`, starting in monitoring mode:
   ```
   v=DMARC1; p=none; rua=mailto:dmarc-reports@your-domain.example; fo=1
   ```
3. Once the reports show only SES and your own senders passing, move to `p=quarantine`, then `p=reject`.

## 3. Leave the SES sandbox

In the sandbox, SES only delivers to verified addresses, and it caps how much you can send.

1. SES console → **Account dashboard** → **Request production access**.
2. Mail type: **Transactional**. Website: your app's site.
3. Use case, in your own words: account verification codes sent only when a user registers or asks for a new code; at most one a minute and five an hour per address; no marketing; how you will handle bounces and complaints (a suppression list, follow-up issue).
4. Wait for approval, usually within a day. Until then, test with verified recipient addresses only.

## 4. IAM policy: `ses:SendEmail` only

Attach this to auth-service's role. Replace the region, account id and domain.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendVerificationEmailOnly",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": "arn:aws:ses:eu-west-1:123456789012:identity/your-domain.example",
      "Condition": {
        "StringEquals": { "ses:FromAddress": "no-reply@your-domain.example" }
      }
    }
  ]
}
```

- If you use `SES_CONFIGURATION_SET`, add its ARN to `Resource`: `arn:aws:ses:<region>:<account>:configuration-set/<name>`.
- Don't grant `ses:*`, and nothing for identities or account settings.

## 5. Turn it on and check

1. Set the variables above on auth-service. Keep `EMAIL_VERIFICATION_REQUIRED=false` until a test send works.
2. Register a test account with an address you control.
   - The email arrives in Arabic, or in English when the app sends `Accept-Language: en`.
   - It carries a 6-digit code that works once, for 10 minutes.
3. Check the auth-service log.
   - Success shows `Email sent via SES (message …, correlation …)`.
   - A failure shows the SES error name and status with the correlation id, never the address or the code.
4. Then set `EMAIL_VERIFICATION_REQUIRED=true` if you want verification before the first login.

## How failures behave

- **Throttling or a 5xx from SES:** one retry after 250 ms.
- **Any other 4xx:** no retry. Examples are an unverified sender, the sandbox, or a suppressed address.
- **Timeout:** no retry either, because SES may already have accepted the message.
- **What the client sees:** every failure is `503 EmailUnavailable` with no provider detail.
  - At registration the account is still created, and the user can ask for a new code.

## Not covered yet

Bounce and complaint processing, plus honouring the SES suppression list, are tracked in a Production 5 follow-up issue. Until it lands, watch the SES reputation dashboard. SES pauses sending if the bounce rate goes over 10 % or the complaint rate over 0.5 %.
