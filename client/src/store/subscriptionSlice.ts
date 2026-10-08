import { StateCreator } from 'zustand';
import { StoreState } from './index';
import { SubscriptionPlan, SubscriptionStatus, UserSubscription } from '../types/billing';
import { apiClient } from '../services/api/client';

export const SUBSCRIPTION_CACHE_KEY = 'dealforge_subscription';

/** Fail-closed free fallback: server is authoritative; unknown => free. */
export const FREE_SUBSCRIPTION: UserSubscription = {
  plan: 'free',
  status: 'active',
  currentPeriodEnd: null,
  customerId: null,
  subscriptionId: null,
};

const VALID_PLANS: ReadonlySet<string> = new Set(['free', 'pro', 'enterprise']);
const VALID_STATUSES: ReadonlySet<string> = new Set(['active', 'cancelled', 'past_due', 'trialing', 'expired']);

function sanitizeSubscription(data: unknown): UserSubscription {
  const d = (data ?? {}) as Record<string, unknown>;
  const plan = typeof d.plan === 'string' && VALID_PLANS.has(d.plan) ? (d.plan as SubscriptionPlan) : 'free';
  const status =
    typeof d.status === 'string' && VALID_STATUSES.has(d.status) ? (d.status as SubscriptionStatus) : 'active';
  return {
    plan,
    status,
    currentPeriodEnd: typeof d.currentPeriodEnd === 'string' ? d.currentPeriodEnd : null,
    customerId: typeof d.customerId === 'string' ? d.customerId : null,
    subscriptionId: typeof d.subscriptionId === 'string' ? d.subscriptionId : null,
  };
}

export interface SubscriptionSlice {
  subscription: UserSubscription | null;
  subscriptionLoading: boolean;
  subscriptionLastFetched: number | null;
  setSubscription: (subscription: UserSubscription | null) => void;
  fetchSubscription: () => Promise<UserSubscription | null>;
  /**
   * Re-fetch from the server before privileged actions (checkout-gated
   * features, AI/email sends, exports). Server is authoritative — never trust
   * the localStorage cache for gating. Returns the fresh subscription, or a
   * fail-closed free subscription on error. Refetches when state is missing
   * or older than maxAgeMs (default 60s).
   */
  ensureFreshSubscription: (maxAgeMs?: number) => Promise<UserSubscription>;
}

export const createSubscriptionSlice: StateCreator<StoreState, [], [], SubscriptionSlice> = (set, get) => ({
  subscription: null,
  subscriptionLoading: false,
  subscriptionLastFetched: null,
  setSubscription: (subscription) => {
    // localStorage is a non-authoritative opportunistic cache only (offline
    // paint). It is NEVER read back for gating decisions — every gate uses
    // in-memory state populated by fetchSubscription(), which is fail-closed
    // to free on error. Tampering with this key cannot elevate privileges
    // because server middleware (requirePlan) re-checks Firestore.
    try {
      if (subscription) {
        localStorage.setItem(SUBSCRIPTION_CACHE_KEY, JSON.stringify(subscription));
      } else {
        localStorage.removeItem(SUBSCRIPTION_CACHE_KEY);
      }
    } catch {
      // localStorage unavailable (e.g. privacy mode) — state still updates
    }
    set({ subscription });
  },
  fetchSubscription: async () => {
    set({ subscriptionLoading: true });
    try {
      const data = await apiClient.getSubscription();
      const subscription = sanitizeSubscription(data);
      try {
        localStorage.setItem(SUBSCRIPTION_CACHE_KEY, JSON.stringify(subscription));
      } catch {
        // ignore storage failures
      }
      set({ subscription, subscriptionLoading: false, subscriptionLastFetched: Date.now() });
      return subscription;
    } catch {
      // Fail-closed: on server error/offline, gate to free — never honor a
      // stale cached upgrade. Clear the cache so a reload cannot resurrect it.
      try {
        localStorage.removeItem(SUBSCRIPTION_CACHE_KEY);
      } catch {
        // ignore storage failures
      }
      set({ subscription: { ...FREE_SUBSCRIPTION }, subscriptionLoading: false, subscriptionLastFetched: null });
      return { ...FREE_SUBSCRIPTION };
    }
  },
  ensureFreshSubscription: async (maxAgeMs = 60_000) => {
    const state = get();
    const age = state.subscriptionLastFetched == null ? Infinity : Date.now() - state.subscriptionLastFetched;
    if (state.subscription && age < maxAgeMs) return state.subscription;
    const fresh = await state.fetchSubscription();
    return fresh ?? { ...FREE_SUBSCRIPTION };
  },
});
