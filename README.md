# DealForge

AI-powered Zoom Marketplace application for sales meeting intelligence, lead management, and automated email outreach.

## Features

- **Real-time Transcription** — Zoom RTMS integration for live meeting transcription
- **Manual Transcript Mode** — Paste or upload transcripts (.txt/.srt/.vtt) from any meeting source, no Zoom required
- **AI Analysis** — Automatic summarization, action items, and sentiment analysis (BYOK)
- **Lead Management** — Auto-create leads from meeting participants, scoring, pipeline tracking
- **Email Outreach** — Automated drip campaigns, email drafting with AI
- **Analytics Dashboard** — Meeting stats, conversion metrics, pipeline visualization
- **Referral Program** — Share a code, both sides get rewards (+1 meeting/month for free users, 1 month free for Pro)
- **API Access (Pro)** — Read-only API (`x-api-key`) to export meeting summaries, action items, and lead scores to your CRM. Opt-in sync sends derived data only — transcripts never leave your device
- **Zoom In-Meeting Panel** — Live suggestions and notes without leaving Zoom

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 19, TypeScript, Vite, Zustand, Dexie.js (IndexedDB) |
| Backend | Node.js, Express, TypeScript, Socket.io |
| Auth | Firebase Authentication |
| AI | OpenAI, Anthropic, Google Gemini (BYOK) |
| Email | Resend, Gmail (OAuth), Outlook (Microsoft Graph OAuth) |
| Payments | Dodo Payments |
| Database | IndexedDB (client-side), optional Redis |

## Architecture

Privacy-first design — sensitive data stored client-side in IndexedDB. Backend acts as a stateless relay with 24h temporary buffer.

Works with Zoom via the in-meeting panel, or standalone — paste or upload any transcript to get the same AI analysis.

Referrals: open the app with `?ref=DF-XXXXXXXX` to claim a referral code. Free users get +1 meeting analysis/month for 3 months per referral; Pro users get 1 month free credit. Codes are claimed server-side (Firestore, fails open), with benefits enforced in both the client limits and the server-side analysis limit middleware.

API Access: Pro users can generate read-only API keys in Settings → API Access and enable derived-data sync (summaries, action items, lead scores — never transcripts). Endpoints: `GET /api/v1/meetings`, `GET /api/v1/meetings/:id`, `GET /api/v1/leads`, `GET /api/v1/deals`, authenticated with the `x-api-key` header (60 req/min).

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Zoom Panel    │────▶│   Express API    │────▶│   Firebase      │
│   (Stateless)   │     │   (Relay)        │     │   (Auth Only)   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │
┌─────────────────┐           │
│  Web Dashboard  │───────────┘
│  (IndexedDB)    │
└─────────────────┘
```

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- Firebase project (for authentication)
- Optional: Zoom Developer account, Resend API key, Dodo Payments account

### Installation

```bash
git clone https://github.com/akshatsha5ill/dealforge1.git
cd dealforge1
npm install
```

### Environment Setup

```bash
# Copy example env files
cp server/.env.example server/.env
cp client/.env.example client/.env

# Edit with your credentials
```

### Development

```bash
# Start both client and server
npm run dev

# Or start individually
npm run dev:client   # Vite dev server on port 5173
npm run dev:server   # Express server on port 3000
```

### Testing

```bash
npm run test         # Run all tests
npm run test:client  # Client tests only
npm run test:server  # Server tests only
npm run typecheck    # Typecheck both workspaces
npm run lint         # Lint both workspaces
```

### Build

```bash
npm run build          # Build server + client
npm run build:client   # Build client for production
npm run build:server   # Build server
```

## Project Structure

```
├── client/                 # React frontend
│   ├── src/
│   │   ├── components/     # UI components
│   │   ├── pages/          # Route pages
│   │   ├── services/       # Business logic
│   │   ├── store/          # Zustand state
│   │   ├── hooks/          # Custom hooks
│   │   ├── utils/          # Utilities (transcript parser, etc.)
│   │   └── crypto/         # Client-side encryption
│   └── ...
├── server/                 # Express backend
│   ├── src/
│   │   ├── routes/         # API routes
│   │   ├── services/       # Business logic
│   │   ├── middleware/      # Express middleware
│   │   └── utils/          # Utilities
│   └── ...
├── docs/
│   ├── zoom-marketplace/   # Zoom Marketplace submission package
│   └── blog/               # SEO blog posts (markdown, frontmatter-ready)
└── ...
```

## API Documentation

Server includes OpenAPI/Swagger documentation at `/api/docs` when running.

## License

MIT — see [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately per [SECURITY.md](SECURITY.md).
