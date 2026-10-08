import { create } from 'zustand';
import { disconnectSocket } from '../hooks/useWebSocket';
import { createAuthSlice, AuthSlice } from './authSlice';
import { createKeySlice, KeySlice } from './keySlice';
import { createUiSlice, UiSlice } from './uiSlice';
import { createSubscriptionSlice, SubscriptionSlice, SUBSCRIPTION_CACHE_KEY } from './subscriptionSlice';
import { wipeLocalData } from '../services/local-db/db';

export type StoreState = AuthSlice & KeySlice & UiSlice & SubscriptionSlice;

export const useStore = create<StoreState>()((set, get, api) => ({
  ...createAuthSlice(set, get, api),
  ...createKeySlice(set, get, api),
  ...createUiSlice(set, get, api),
  ...createSubscriptionSlice(set, get, api),

  logout: () => {
    disconnectSocket();
    // Synchronous state + cache clear so UI gates fail-closed immediately.
    try {
      localStorage.removeItem(SUBSCRIPTION_CACHE_KEY);
    } catch {
      // ignore
    }
    set({ user: null, isAuthenticated: false, openAiKey: '', anthropicKey: '', geminiKey: '', resendKey: '', subscription: null, subscriptionLastFetched: null });
    // Async IndexedDB + Firebase persistence wipe (best-effort, never throws).
    // Also clears remaining sensitive localStorage keys + sessionStorage.
    void wipeLocalData();
  }
}));
