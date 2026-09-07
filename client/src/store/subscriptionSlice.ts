import { StateCreator } from 'zustand';
import { StoreState } from './index';
import { SubscriptionPlan, SubscriptionStatus, UserSubscription } from '../types/billing';
import { apiClient } from '../services/api/client';

const CACHE_KEY = 'dealforge_subscription';

export interface SubscriptionSlice {
  subscription: UserSubscription | null;
  subscriptionLoading: boolean;
  setSubscription: (subscription: UserSubscription | null) => void;
  fetchSubscription: () => Promise<UserSubscription | null>;
}

export const createSubscriptionSlice: StateCreator<StoreState, [], [], SubscriptionSlice> = (set) => ({
  subscription: null,
  subscriptionLoading: false,
  setSubscription: (subscription) => {
    try {
      if (subscription) {
        localStorage.setItem(CACHE_KEY, JSON.stringify(subscription));
      } else {
        localStorage.removeItem(CACHE_KEY);
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
      const subscription: UserSubscription = {
        plan: (data.plan as SubscriptionPlan) || 'free',
        status: (data.status as SubscriptionStatus) || 'active',
        currentPeriodEnd: data.currentPeriodEnd,
        customerId: data.customerId,
        subscriptionId: data.subscriptionId,
      };
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(subscription));
      } catch {
        // ignore storage failures
      }
      set({ subscription, subscriptionLoading: false });
      return subscription;
    } catch {
      try {
        localStorage.removeItem(CACHE_KEY);
      } catch {
        // ignore storage failures
      }
      set({ subscription: null, subscriptionLoading: false });
      return null;
    }
  },
});
