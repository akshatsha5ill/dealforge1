# Email Deliverability (Resend — SPF / DKIM / DMARC)

Repo state verified:
- `EMAIL_FROM` default is `DealForge <support@dealforge.app>` (`server/src/config.ts:29`, `server/.env.example:32`).
- `render.yaml` sets `RESEND_API_KEY` (secret) and `healthCheckPath: /api/health`, but defines **no** `EMAIL_FROM` / tracking env vars.
- No existing SPF/DKIM/DMARC guide (`docs/` only contains `blog/`, `upsell/`, `zoom-marketplace/`).

If you send from `noreply@dealforge.app` (or any custom domain) via Resend without DNS auth, expect spam-foldering or bounces under Gmail bulk-sender rules. Do the steps below once per sending domain.

## 1. Add + verify domain in Resend

1. Resend Dashboard → **Domains → Add Domain**, enter the `EMAIL_FROM` domain (e.g. `dealforge.app`).
2. Resend shows the exact DNS records to add (values below are example shapes — **copy the actual values from the dashboard**):
   - **SPF** — `TXT` at `@` (or your sending subdomain, e.g. `send`):
     `v=spf1 include:amazonses.com ~all`
     Keep only **one** SPF TXT per hostname. If you already have one, merge the `include:` into it.
   - **DKIM** — one or more `TXT` (Resend shows host like `resend._domainkey`) with the provided public-key value. Do not truncate it.
   - **DMARC** — `TXT` at `_dmarc`, start with a monitoring policy:
     `v=DMARC1; p=none; rua=mailto:dmarc@dealforge.app; fo=1; adkim=r; aspf=r`
     Move `p=none` → `p=quarantine` → `p=reject` only after SPF+DKIM pass and you monitor `rua` reports.
3. Add the records at your DNS provider, then back in Resend click **Verify**. DNS can take minutes–48h to propagate.

Verify from a shell:

```bash
dig +short TXT dealforge.app
dig +short TXT resend._domainkey.dealforge.app
dig +short TXT _dmarc.dealforge.app
```

Resend domain status must show **Verified** before sending production mail from that domain.

## 2. Set `EMAIL_FROM` + `TRACKING_BASE_URL`

`server/src/routes/email.ts:26` resolves click/open tracking URLs as:

- `TRACKING_BASE_URL` (trimmed, trailing `/` stripped) when set — **preferred**;
- otherwise `req` host fallback: `{protocol}://{host}/api/tracking` (breaks behind proxies / leaks internal hosts).

Uids in tracking URLs are HMAC-signed with `TRACKING_SECRET || SESSION_SECRET` (`signTrackingUid`).

Set in Render (`dealforge-server` → Environment) and local `.env`:

```bash
EMAIL_FROM=DealForge <noreply@dealforge.app>
# Canonical public tracking base — must be HTTPS in prod:
TRACKING_BASE_URL=https://dealforge-server.onrender.com/api/tracking
# Optional: dedicated signing secret (else SESSION_SECRET is used):
TRACKING_SECRET=change-me-to-a-long-random-string
```

Notes:
- `TRACKING_BASE_URL` must be on the same registered domain family as your sending domain where possible, and must be publicly reachable (the open pixel + click wrapper live under `/open/:campaignId` and `/click/:campaignId`).
- Bulk sends require a replyable `Reply-To` (see `server/src/services/email-service.ts` — `assertBulkSender` rejects noreply bulk senders). Set `EMAIL_REPLY_TO=support@dealforge.app` if `EMAIL_FROM` stays noreply.

## 3. Health check (post-deploy + deliverability smoke test)

Health endpoint (`server/src/app.ts:213`, `render.yaml:12`, `server/Dockerfile:26`):

```bash
curl -fsS https://dealforge-server.onrender.com/api/health
# → {"status":"healthy","uptime":...}  (HTTP 200)
```

Then:

1. Send a test mail via `POST /api/email/send` (`via: "resend"`) to a mailbox you control.
2. Confirm: SPF **pass**, DKIM **pass**, DMARC **pass** in the received headers (Gmail → Show original).
3. Confirm `List-Unsubscribe` / one-click headers + footer present on bulk sends, open pixel + click links rewrite to `TRACKING_BASE_URL`, and bounces/complaints arrive at `POST /api/email/webhooks/resend` (needs `RESEND_WEBHOOK_SECRET` set for Svix verification).
