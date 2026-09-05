# Deployment Credentials Checklist

Every secret DealForge needs, where to get it, and where to paste it.
**Never commit real values.** Local files (`server/.env`, `client/.env`) are gitignored.
`sync: false` entries in `render.yaml` make the Render dashboard prompt for them.

## 0. Local files (already created, gitignored)

| File | State |
|------|-------|
| `server/.env` | Created from `.env.example`; `SESSION_SECRET` / `ENCRYPTION_KEY` / `TRACKING_SECRET` pre-generated with 32 random bytes |
| `client/.env` | Created; `VITE_API_URL` deliberately **commented out** so local dev keeps using the Vite proxy |

## 1. Firebase (required — auth is the backbone)

| Credential | Get it from | Set it in |
|------------|-------------|-----------|
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID` | Firebase console → Project settings → General → Your apps → Web app config | `client/.env` locally; Vercel env vars for prod |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Firebase console → Project settings → Service accounts → Generate new private key (keep `\n` newlines, quoted) | `server/.env` locally; Render env vars for prod |
| Google sign-in provider | Firebase console → Authentication → Sign-in method → enable Google | Firebase console (no env var) |

## 2. Zoom (required for prod)

| Credential | Get it from | Set it in |
|------------|-------------|-----------|
| `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | Zoom Marketplace dashboard → your app → Credentials | `server/.env` + Render |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | Same page → Webhooks → Secret Token | `server/.env` + Render |
| `ZOOM_SDK_KEY`, `ZOOM_SDK_SECRET` | Zoom Marketplace → SDK credentials (Meeting SDK / RTMS) | `server/.env` + Render |
| `ZOOM_VERIFY_TOKEN` | Zoom Marketplace → domain verification | `server/.env` + Render |
| `ZOOM_REDIRECT_URI` | Must be whitelisted in the Zoom app: prod `https://<api-host>/api/zoom/oauth/callback` | Zoom dashboard whitelist + `server/.env` + Render |
| Redirect/webhook/deauth URLs | Register prod URLs in the Zoom app (`redirectUris`, `webhookUris`, `deauthUri`, `verificationUri` — see `zoom-manifest.json`) | Zoom dashboard |

## 3. Email

| Credential | Get it from | Set it in |
|------------|-------------|-----------|
| `RESEND_API_KEY` (prod-required), `EMAIL_FROM` | Resend dashboard → API keys; verify `noreply@dealforge.app` domain | `server/.env` + Render |
| `EMAIL_REPLY_TO`, `EMAIL_COMPANY_NAME`, `EMAIL_PHYSICAL_ADDRESS` | Your own company details (CAN-SPAM footer) | `server/.env` + Render |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud console → APIs & Services → Credentials (OAuth client); authorize the `OAUTH_REDIRECT_BASE/gmail/callback` URI | `server/.env` + Render |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | Azure portal → App registrations; authorize the `.../outlook/callback` URI | `server/.env` + Render |
| `OAUTH_REDIRECT_BASE`, `UNSUBSCRIBE_BASE_URL` | Derived from prod API host, e.g. `https://<api-host>/api/email/oauth` | `server/.env` + Render |

## 4. Billing — Dodo Payments (required once billing is enabled)

| Credential | Get it from | Set it in |
|------------|-------------|-----------|
| `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY` | Dodo dashboard → API keys / Webhooks | `server/.env` + Render |
| `DODO_PRO_PRODUCT_ID`, `DODO_ENTERPRISE_PRODUCT_ID` | Dodo dashboard → Products (replaces the current `null` placeholders in `client/src/types/billing.ts`) | `server/.env` + Render |
| Webhook URL | Register `https://<api-host>/api/billing/webhook` in Dodo | Dodo dashboard |

## 5. AI providers (optional — BYOK: users bring their own keys)

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` (+ `*_MODEL` overrides).
Server keys are only defaults. Set in `server/.env` + Render if you want server-side fallback.

## 6. Security tokens (generated — already filled in local `server/.env`)

| Credential | Set it in |
|------------|-----------|
| `SESSION_SECRET`, `ENCRYPTION_KEY`, `TRACKING_SECRET` | Generate fresh per environment (`openssl rand -hex 32`); set in Render. **Never reuse dev values in prod.** |
| `TRACKING_BASE_URL` (prod-required — prevents Host-header poisoning) | `https://<api-host>/api/tracking` in Render |
| `API_BASE_URL`, `CLIENT_URLS`, `ALLOW_PREVIEW_ORIGINS=false` | Render (prod hardening) |

## 7. Infra / observability (optional)

| Credential | Get it from | Set it in |
|------------|-------------|-----------|
| `REDIS_URL` | Redis provider (e.g. Upstash/Render Redis); unset = in-memory fallback | `server/.env` + Render |
| `SENTRY_DSN` / `VITE_SENTRY_DSN` | Sentry → project settings → DSN | `server/.env` + Render / Vercel |
| `VITE_GA_ID` | Google Analytics → stream ID | Vercel |

## 8. Vercel (client) env vars for prod

In the Vercel dashboard (or `vercel env add <NAME> production`) set:
`VITE_API_URL` (= `https://<api-host>`), all six `VITE_FIREBASE_*`,
`VITE_SENTRY_DSN`, `VITE_GA_ID`. Then redeploy.

## 9. Pre-push sanity

- [ ] `git status --short` shows **no** `.env` files (they're gitignored — verify with `git check-ignore server/.env client/.env`)
- [ ] `server/.env.example` lists every var in §1–7 (it does — updated alongside this doc)
- [ ] Prod secrets differ from local dev secrets
- [ ] Zoom redirect/webhook URLs + Dodo webhook URL point at prod hosts
- [ ] `npm run typecheck --workspace=server` + `npx vitest run` (server) green before pushing
