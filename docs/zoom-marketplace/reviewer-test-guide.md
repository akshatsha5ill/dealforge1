# Reviewer Test Guide — DealForge AI

Paste this into the **Release notes for app reviewer** field of the Zoom build flow, and provide the test account credentials alongside.

---

## Overview

DealForge is an AI meeting-intelligence and sales-CRM app. Testers need a Zoom account with the app installed, plus the test credentials below.

**Test account**: provided in the submission (Firebase email/password account with a free plan; a Pro plan account may also be provided).

**Quick smoke test (2 min)**: Sign in → Settings → Connect Zoom → Open a Zoom meeting → Panel shows Transcription/Suggestions/Notes → Back in dashboard, meeting appears with analysis.

## Environment

| Item | Value |
|------|-------|
| Web app URL | `https://<client-domain>/` |
| API base | `https://<server-domain>/api` |
| OAuth callback | `https://<server-domain>/api/zoom/oauth/callback` |
| Webhook URL | `https://<server-domain>/api/zoom/webhook` |
| Deauth URL | `https://<server-domain>/api/zoom/deauth` |
| Verification endpoint | `https://<server-domain>/zoomverify/verifyzoom.html` (must return `ZOOM_VERIFY_TOKEN`) |

## Test Plan

### 1. Account Creation & Sign-In

1. Open the web app URL. Landing page loads with a sign-in panel on the right.
2. Create an account with email/password (or sign in with the provided test account).
3. You land on the dashboard. The onboarding prompts can be skipped.

### 2. Install & Connect the Zoom App

1. From the Zoom App Marketplace, install "DealForge AI" (or use the provided authorization URL).
2. In the web dashboard, go to **Settings → Integrations → Zoom**.
3. Click **Connect Zoom** → Zoom OAuth consent screen appears with scopes `meeting:read`, `user:read` (least-privilege; see `zoom-manifest.json`) → Approve.
4. You are redirected back; Settings shows the Zoom account as **linked**.

### 3. In-Meeting Panel (Real-Time)

1. Start a Zoom meeting (as host) on the desktop client where the app is installed.
2. Open the DealForge panel in the meeting (Apps → DealForge AI).
3. **Transcription view**: live transcript segments appear as you speak (RTMS).
4. **Suggestions view**: after a few segments, AI suggestions render (note: requires an AI key — the test account ships with one configured; otherwise add a key in Settings → AI).
5. **Notes view**: type a note; it saves.
6. End the meeting. The panel disconnects cleanly.

### 4. Meeting Analysis (Dashboard)

1. In the dashboard → **Meetings**, the meeting from step 3 appears (synced via webhook).
2. Open the meeting → click **Analyze**.
3. The analysis renders: summary, action items, sentiment, and lead scores.
4. **Manual transcript mode** (standalone): click **New Meeting → Paste Transcript**; paste any plain-text dialogue, or upload a `.txt`/`.srt`/`.vtt` file; click **Analyze**. Analysis completes with the same output. This works with no Zoom at all.

### 5. Leads & Pipeline

1. From an analyzed meeting, leads are auto-created with BANT scores.
2. **Leads** page shows scored leads (lead name, score, source meeting).
3. **Pipeline** page shows deal cards; drag-and-drop a card to another stage (Pro plan; read-only on Free with an upgrade prompt).

### 6. Email Follow-Up (Pro)

1. **Emails** page → connect Gmail or Outlook via OAuth (Settings → Integrations).
2. Draft an AI follow-up email referencing the analyzed meeting → send.
3. A drip campaign can be scheduled from the email page.

### 7. Billing (Pro)

1. **Billing** page shows Free plan with an **Upgrade** CTA.
2. Checkout completes via Dodo Payments test mode; after success the plan upgrades to Pro and gated features (pipeline edit, email outreach, all AI models) unlock.

### 8. Uninstall / Deauthorization

1. Remove DealForge from your Zoom account (Zoom Marketplace → Manage → Uninstall).
2. DealForge receives the deauth notification: Settings → Integrations → Zoom shows **disconnected**, and stored Zoom tokens are deleted server-side.

## Privacy Verification (Key Selling Point)

1. Open DevTools → Application → IndexedDB: all meeting transcripts, analyses, and leads are stored client-side (`dealforge` DB).
2. The server never stores meeting content beyond a 24-hour in-memory relay buffer.
3. BYOK: in Settings → AI, users can add their own OpenAI/Anthropic/Gemini API keys so their data goes straight from the browser to their chosen provider.

## Known Notes for Reviewers

- RTMS live transcription requires the Zoom desktop client (web client uses cloud-recording-free fallback: manual transcript mode).
- AI analysis requires an AI provider key; the provided test account includes one.
- Free plan: 3 analyzed meetings/month, transcript history 30 days, OpenAI model only, pipeline read-only. Pro: unlimited meetings, all 3 AI models, email outreach, full pipeline.
