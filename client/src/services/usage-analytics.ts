// Local product-event store (localStorage). Distinct from services/analytics.ts
// (Google Analytics) and utils/analytics.ts (chart data builders).
const STORAGE_KEY = 'dealforge_usage_events';
const MAX_EVENT_AGE_DAYS = 180;

export type UsageEvent =
  | 'meeting_created_manual'
  | 'transcript_uploaded'
  | 'analyze_clicked'
  | 'analyze_succeeded'
  | 'analyze_blocked_limit'
  | 'analyze_blocked_model'
  | 'analyze_blocked_no_key'
  | 'upgrade_prompt_shown'
  | 'upgrade_prompt_clicked'
  | 'email_drafted'
  | 'email_sent'
  | 'lead_rescored'
  | 'deal_created'
  | 'referral_created'
  | 'referral_claimed'
  | 'api_key_created'
  | 'api_sync_enabled'
  | 'api_sync_completed';

interface UsageRecord {
  count: number;
  lastTs: number;
}

type UsageStore = Partial<Record<UsageEvent, UsageRecord>>;

function load(): UsageStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as UsageStore;
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed;
  } catch {
    return {};
  }
}

function prune(store: UsageStore): UsageStore {
  const cutoff = Date.now() - MAX_EVENT_AGE_DAYS * 24 * 60 * 60 * 1000;
  for (const key of Object.keys(store) as UsageEvent[]) {
    const rec = store[key];
    if (rec && rec.lastTs < cutoff) {
      delete store[key];
    }
  }
  return store;
}

function save(store: UsageStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prune(store)));
  } catch {
    // Storage full or unavailable — analytics are best-effort
  }
}

export function trackEvent(event: UsageEvent): void {
  const store = load();
  const now = Date.now();
  const prev = store[event];
  store[event] = { count: (prev?.count || 0) + 1, lastTs: now };
  save(store);
}

export function getEventCount(event: UsageEvent): number {
  return prune(load())[event]?.count || 0;
}

export function getAllEvents(): Record<string, { count: number; lastTs: number }> {
  return prune(load()) as Record<string, { count: number; lastTs: number }>;
}
