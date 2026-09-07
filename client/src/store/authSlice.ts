import { StateCreator } from 'zustand';
import { StoreState } from './index';
import { User } from 'firebase/auth';

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
    set({ user: null, isAuthenticated: false, openAiKey: '', anthropicKey: '', geminiKey: '', resendKey: '', subscription: null });
  },
});
