import { config } from '../config.js';

/**
 * Shared Origin allowlist for Express (app.ts) and Socket.IO (index.ts).
 * Explicit CLIENT_URLS allowlist only, plus the trusted Zoom client.
 * Never wildcard *.vercel.app — any attacker can deploy there and would
 * receive ACAO with Authorization/x-api-key.
 */
const getAllowedOrigins = (): Set<string> => {
  const allowedOrigin = config.clientUrl || 'http://localhost:5173';
  return new Set(
    [allowedOrigin, ...(process.env.CLIENT_URLS || '').split(',').map((s) => s.trim()).filter(Boolean)],
  );
};

const allowPreviewOrigins = (): boolean =>
  process.env.ALLOW_PREVIEW_ORIGINS !== undefined
    ? process.env.ALLOW_PREVIEW_ORIGINS === 'true'
    : !config.isProd;

export const isAllowedOrigin = (origin: string | undefined): boolean => {
  // Allow non-browser / same-origin requests with no Origin header.
  if (!origin) return true;
  if (getAllowedOrigins().has(origin)) return true;
  if (!allowPreviewOrigins()) return false;
  try {
    const hostname = new URL(origin).hostname;
    if (hostname === 'zoom.us' || hostname.endsWith('.zoom.us')) return true;
  } catch {
    // fall through to deny
  }
  return false;
};

// OAuth redirect re-validation (server M1): /start routes allowlist the
// redirect host, but the callback must re-validate the echoed state redirect —
// state is opaque to the IdP and can be swapped between start and callback.
// Centralized so Zoom + email callbacks share one allowlist.
export const isAllowedClientRedirect = (redirect: string | undefined | null): boolean => {
  if (!redirect || typeof redirect !== 'string') return false;
  try {
    const parsed = new URL(redirect);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const allowedHosts = new Set<string>(['localhost', '127.0.0.1']);
    const addHost = (url: string): void => {
      try {
        allowedHosts.add(new URL(url).hostname);
      } catch {
        // ignore malformed allowlist entries
      }
    };
    addHost(config.clientUrl);
    for (const o of getAllowedOrigins()) addHost(o);
    return allowedHosts.has(parsed.hostname);
  } catch {
    return false;
  }
};

export const defaultClientRedirect = (path = '/settings'): string =>
  `${config.clientUrl.replace(/\/$/, '')}${path}`;
