import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './index';

describe('Zustand Store', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
      user: null,
      isAuthenticated: false,
      openAiKey: '',
      anthropicKey: '',
      geminiKey: '',
      resendKey: '',
      error: null,
      isLoading: false,
      subscription: null,
      subscriptionLoading: false,
    });
  });

  it('has correct initial state', () => {
    const state = useStore.getState();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(state.openAiKey).toBe('');
    expect(state.anthropicKey).toBe('');
    expect(state.geminiKey).toBe('');
    expect(state.resendKey).toBe('');
    expect(state.subscription).toBeNull();
  });

  it('sets OpenAI key', () => {
    // Fixture values only — not real credentials.
    useStore.getState().setOpenAiKey('sk-test123');
    expect(useStore.getState().openAiKey).toBe('sk-test123');
  });

  it('sets Anthropic key', () => {
    useStore.getState().setAnthropicKey('sk-ant-test');
    expect(useStore.getState().anthropicKey).toBe('sk-ant-test');
  });

  it('sets Gemini key', () => {
    useStore.getState().setGeminiKey('AIza-test');
    expect(useStore.getState().geminiKey).toBe('AIza-test');
  });

  it('sets Resend key', () => {
    useStore.getState().setResendKey('re_test');
    expect(useStore.getState().resendKey).toBe('re_test');
  });

  it('sets error state', () => {
    useStore.getState().setError('Something failed');
    expect(useStore.getState().error).toBe('Something failed');
  });

  it('clears error state', () => {
    useStore.getState().setError('Something failed');
    useStore.getState().clearError();
    expect(useStore.getState().error).toBeNull();
  });

  it('sets and persists subscription via store', () => {
    useStore.getState().setSubscription({
      plan: 'pro',
      status: 'active',
      currentPeriodEnd: null,
      customerId: 'cus_123',
      subscriptionId: 'sub_123',
    });
    expect(useStore.getState().subscription?.plan).toBe('pro');
    expect(JSON.parse(localStorage.getItem('dealforge_subscription') || '{}').plan).toBe('pro');
  });

  it('clears subscription on logout', () => {
    useStore.setState({
      user: { uid: '123', email: 'test@test.com' } as never,
      isAuthenticated: true,
      openAiKey: 'sk-test',
      anthropicKey: 'sk-ant-test',
      geminiKey: 'AIza-test',
      resendKey: 're_test',
      subscription: { plan: 'pro', status: 'active', currentPeriodEnd: null, customerId: null, subscriptionId: null },
    });

    useStore.getState().logout();

    const state = useStore.getState();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(state.openAiKey).toBe('');
    expect(state.anthropicKey).toBe('');
    expect(state.geminiKey).toBe('');
    expect(state.resendKey).toBe('');
    expect(state.subscription).toBeNull();
  });
});
