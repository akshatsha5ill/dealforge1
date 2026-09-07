/**
 * Canonical tracking/HMAC secret used by tracking, email, and unsubscribe routes.
 * Falls back to SESSION_SECRET for backwards compatibility.
 */
export const getTrackingSecret = (): string =>
  process.env.TRACKING_SECRET || process.env.SESSION_SECRET || '';
