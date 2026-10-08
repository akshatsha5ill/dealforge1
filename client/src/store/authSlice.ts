import { StateCreator } from 'zustand';
import { StoreState } from './index';
import { User } from 'firebase/auth';
import { SUBSCRIPTION_CACHE_KEY } from './subscriptionSlice';
import { wipeLocalData } from '../services/local-db/db';

export interface AuthSlice {
  user: User | null; 
  isAuthenticated: boolean;
  isAuthReady: boolean;
  setUser: (user: User | null) => void;
  setAuthReady: (status: boolean) => void;
  logout: () => void;
}

export const createAuthSlice: StateCreator<StoreState, [], [], AuthSlice> = (set) => ({
  user: null,
  isAuthenticated: false,
  isAuthReady: false,
  setUser: (user) => set({ user, isAuthenticated: !!user }),
  setAuthReady: (status) => set({ isAuthReady: status }),
  logout: () => {
    try {
      localStorage.removeItem(SUBSCRIPTION_CACHE_KEY);
    } catch {
      // ignore
    }
    set({ user: null, isAuthenticated: false, openAiKey: '', anthropicKey: '', geminiKey: '', resendKey: '', subscription: null, subscriptionLastFetched: null });
    void wipeLocalData();
  },
});
