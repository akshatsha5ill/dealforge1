# Technical Design Document — DealForge AI

For the **Technical Design** section of the Zoom build flow. Answers the standard security review questions (architecture, data handling, OAuth scopes, third parties, retention, deletion).

## 1. Application Overview

DealForge is an AI meeting-intelligence and sales-CRM app for Zoom. It provides:

- Real-time transcription via Zoom RTMS and a live in-meeting panel (suggestions, notes, transcription)
- AI analysis: summaries, action items, sentiment, BANT lead scoring (user's own API key or server key)
- Lead/pipeline management and AI-drafted follow-up email drips
- Manual transcript mode: paste or upload transcripts from any source (no Zoom required)

**App type**: Zoom App with in-meeting panel (`onMeeting` capability) + companion web dashboard.

## 2. Architecture & Data Flow

```
Zoom Client (in-meeting panel)          Web Dashboard (React SPA)
        │  RTMS / SDK                        │
        ▼                                   ▼
Express API (stateless relay) ◀───── HTTPS ──┘
   │  │  │
   │  │  └── Firebase Auth (identity only — user account, plan)
   │  └────── 24h in-memory buffer (transcript segments, meeting context)
   └────────── Socket.io realtime fan-out to client
```

- **Primary data store: client-side IndexedDB** (Dexie.js). Transcripts, AI analyses, leads, pipeline, emails, and settings live in the user's browser.
- **Server stores only**: Firebase Auth identity, billing/plan state, OAuth link metadata (`zoomLinked`, tokens), and a **24-hour in-memory transcript buffer** to bridge the in-meeting panel to the dashboard. No permanent storage of meeting content.
- **AI inference**: requests go to the user's chosen provider (OpenAI / Anthropic / Gemini) either with the user's own API key (BYOK) or a server-side key; no meeting data is persisted server-side beyond the transient buffer.

## 3. OAuth Scopes — Justification (Least Privilege)

| Scope | Why Needed | In Use? |
|-------|-----------|---------|
| `meeting:read` | Read own-meeting context (ID, topic, participants) delivered via Event Subscriptions (`meeting.started` / `meeting.ended` / `meeting.participant_joined`) to drive transcription pipeline. User-level scope only — no org-wide meeting access needed. | Yes — webhook payload handling in `server/src/routes/zoom.ts` |
| `user:read` | Read the host's own Zoom user profile (`GET /v2/users/me`) to link accounts and handle deauth lookup. | Yes — `server/src/routes/zoom.ts` OAuth callback |

**Why `meeting:read`, not `meeting:read:admin`:** DealForge only needs the authorizing user's own meeting context. Meeting ID/topic/participants arrive in webhook payloads (`payload.object.id/topic/participant`); no admin-level REST listing of all users' meetings is ever called. Requesting `:admin` would over-scope to org-wide meeting data and fail least-privilege review. Source of truth: `zoom-manifest.json:8-11` (`meeting:read`, `user:read`).

**Why no `meeting:write`:** DealForge never creates/updates meetings via REST. Live transcription uses RTMS authenticated by SDK key/secret (`server/src/services/zoom-rtms.ts:69-75,159-181` — HMAC-signed `wss://rtms2.zoom.us` + `func: auth`), not OAuth `meeting:write`. The only Zoom REST call is `GET /v2/users/me` (`server/src/routes/zoom.ts:235`), which requires only `user:read`. No write operation exists, so `meeting:write` is omitted.

**Note for review**: The manifest previously listed `recording:read` — DealForge does **not** consume cloud recordings; it streams live transcription via RTMS. Do not request `recording:read`. Canonical scopes are `meeting:read` + `user:read` per `zoom-manifest.json`. Known drift (no code change this wave): `server/src/routes/zoom.ts:131` currently requests `meeting:read:admin meeting:write user:read` and `client/src/pages/landing/PrivacyPolicy.tsx:58-63` repeats the admin/write wording — both must be narrowed to `meeting:read` + `user:read` in the code wave to match this doc and the manifest.

## 4. OAuth Token Handling

- OAuth 2.0 authorization code flow (`/api/zoom/oauth/start` → zoom.us → `/api/zoom/oauth/callback`).
- Access/refresh tokens are stored in the user's Firestore doc (`users/{uid}`), encrypted at rest with AES-256 (`server/src/utils/crypto.ts`).
- Refresh flow reuses the stored refresh token until expiry — no per-request token generation (per Zoom security best practices).
- Re-authorization: if a user removes the app and tries to use a Zoom feature, the dashboard shows a "Reconnect Zoom" prompt which restarts OAuth.
- Deauth: Zoom calls `/api/zoom/deauth`, which verifies the HMAC signature and removes `zoomLinked`, tokens, and `zoomUserId` from Firestore (`server/src/routes/zoom.ts:283`).

## 5. Webhooks vs. Long Polling

- DealForge subscribes to Zoom **webhooks** (Event Subscriptions): `meeting.started`, `meeting.ended`, `meeting.participant_joined`. No long polling of Zoom APIs.
- HMAC signature validation (`v0:{timestamp}:{body}` SHA-256, timing-safe compare) on every webhook and deauth request (`server/src/routes/zoom.ts:187-196`).
- `endpoint.url_validation` challenge-response implemented (`server/src/routes/zoom.ts:199-206`).
- Real-time transcription uses **RTMS** (Zoom Real-Time Media Streaming) rather than polling.

## 6. Data Retention & Deletion

- **Server buffer**: transcript segments and meeting context are retained in-memory for **24 hours**, then purged (`server/src/services/buffer-service.ts`). Used only to bridge in-meeting panel → dashboard sync.
- **Client**: all meeting content persists in the user's browser (IndexedDB) until they delete it.
- **User deletion**: clearing the DealForge dashboard data (Settings → data controls / browser storage) removes all client data. Firebase account deletion is handled per Firebase console. DealForge never hosts meeting content, so no server-side content deletion is required.
- **Deauth**: on Zoom deauthorization, DealForge deletes all stored Zoom tokens and link metadata immediately.

## 7. Security Controls

| Control | Implementation |
|---------|----------------|
| TLS | All endpoints HTTPS (Render/Vercel), TLS 1.2+ |
| Input validation | Zod schemas on every route (`server/src/middleware/validateRequest.ts`) |
| AuthN | Firebase Auth ID tokens verified on all protected routes (`verifyAuth`) |
| Webhook integrity | HMAC SHA-256 timing-safe signature comparison |
| Encryption at rest | OAuth tokens AES-256 encrypted (`server/src/utils/crypto.ts`) |
| Rate limiting | Per-route limiters (auth, billing, ai, tracking, email) |
| Server-side plan enforcement | `requirePlan` + `enforceAiModelAccess` + `enforceAnalysisLimit` middleware |
| No sensitive data in logs | Structured logger, meeting content never logged |
| Dependency hygiene | npm audit run in CI; lockfile committed |

## 8. Third-Party Services

| Service | Purpose | Data shared |
|---------|---------|-------------|
| Firebase Auth + Firestore | Identity, plan state, encrypted OAuth tokens | Email, UID, plan; **no meeting content** |
| OpenAI / Anthropic / Google Gemini | Transcript analysis (BYOK or server key) | Transcript segments sent **only** to the user's chosen provider, **only** during active analysis |
| Resend | Transactional emails (password reset, notifications) | User email |
| Dodo Payments | Subscription billing | Email, billing info |
| Zoom | OAuth, RTMS, webhooks | OAuth tokens, meeting context (ID/topic/participants) |
| Sentry (optional) | Error monitoring | Stack traces (no meeting content; configured to redact) |

## 9. Monitoring & Logging

- Structured JSON logging (`server/src/utils/logger.ts`) of key events: auth, webhook receipt (event type only), analysis counts, errors. Meeting content is never logged.
- Optional Sentry error tracking (client + server) behind `SENTRY_DSN`.
- Health check endpoint `/api/health` for uptime monitoring.

## 10. Compliance & Legal

- Privacy Policy and Terms of Service hosted at `/privacy` and `/terms` (expand per Zoom guidelines before submission).
- DealForge obtains user consent for Zoom data access through the OAuth consent screen.
- Because meeting data is stored client-side, DealForge's data-processing footprint is minimal: the 24h relay buffer is the only server-side handling of meeting content.
