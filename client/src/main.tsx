import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.tsx'

if (import.meta.env.PROD && import.meta.env.VITE_SENTRY_DSN) {
  const scrub = (obj: unknown): unknown => {
    if (typeof obj === 'string') return obj.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(scrub);
    const out: Record<string, unknown> = { ...(obj as Record<string, unknown>) };
    for (const k of Object.keys(out)) {
      if (/api[-_]?key|transcript|email/i.test(k)) out[k] = '[Redacted]';
      else out[k] = scrub(out[k]);
    }
    return out;
  };
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.request?.data) event.request.data = scrub(event.request.data) as typeof event.request.data;
      if (event.extra) event.extra = scrub(event.extra) as typeof event.extra;
      const headers = (event.request as { headers?: Record<string, unknown> } | undefined)?.headers;
      if (headers && typeof headers === 'object') {
        for (const k of Object.keys(headers)) {
          if (/api[-_]?key|authorization|cookie|set-cookie/i.test(k)) headers[k] = '[Redacted]';
        }
      }
      return event;
    },
  });
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find root element');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
