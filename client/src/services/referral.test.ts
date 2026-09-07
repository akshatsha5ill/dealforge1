import { describe, it, expect, vi, beforeEach } from 'vitest';

const { settingsStore, authHolder } = vi.hoisted(() => ({
  settingsStore: new Map<string, unknown>(),
  authHolder: { currentUser: null as null | { uid: string } },
}));

vi.mock('./local-db/db', () => ({
  db: {
    settings: {
      get: vi.fn(async (key: string) => {
        if (!settingsStore.has(key)) return undefined;
        return { key, value: settingsStore.get(key) };
      }),
      put: vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
        settingsStore.set(key, value);
      }),
    },
  },
}));

vi.mock('./firebase/config', () => ({
  auth: authHolder,
}));

vi.mock('./api/client', () => ({
  apiClient: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('./usage-analytics', () => ({
  trackEvent: vi.fn(),
}));

async function freshModule() {
  vi.resetModules();
  authHolder.currentUser = null;
  const referral = await import('./referral');
  const { apiClient } = await import('./api/client');
  const { trackEvent } = await import('./usage-analytics');
  return { referral, auth: authHolder, apiClient, trackEvent };
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsStore.clear();
  authHolder.currentUser = null;
});

describe('referral code utilities', () => {
  it('validates DF- codes', async () => {
    const { referral } = await freshModule();
    expect(referral.isReferralCodeValid('DF-ABCD2345')).toBe(true);
    expect(referral.isReferralCodeValid('df-abcd2345')).toBe(true);
    expect(referral.isReferralCodeValid('bad-code')).toBe(false);
    expect(referral.isReferralCodeValid('ABCD2345')).toBe(false);
  });

  it('derives deterministic codes from a seed', async () => {
    const { referral } = await freshModule();
    const a = referral.deriveReferralCode('user-1');
    expect(a).toBe(referral.deriveReferralCode('user-1'));
    expect(referral.isReferralCodeValid(a)).toBe(true);
    expect(a).not.toBe(referral.deriveReferralCode('user-2'));
  });
});

describe('getOrCreateReferralCode', () => {
  it('derives a code from the uid and persists it', async () => {
    const { referral } = await freshModule();
    const code = await referral.getOrCreateReferralCode('user-1');
    expect(code).toBe(referral.deriveReferralCode('user-1'));
    expect(settingsStore.get('dealforge_referral_code')).toBe(code);
  });

  it('reuses a previously stored code', async () => {
    settingsStore.set('dealforge_referral_code', 'DF-ABC12345');
    const { referral } = await freshModule();
    expect(await referral.getOrCreateReferralCode('user-1')).toBe('DF-ABC12345');
  });
});

describe('claimReferralCode', () => {
  it('ignores invalid codes', async () => {
    const { referral } = await freshModule();
    expect(await referral.claimReferralCode('nope')).toBeNull();
    expect(referral.getReferralBenefits()).toHaveLength(0);
  });

  it('claims a meeting bonus with a 3-month expiry and tracks the event', async () => {
    const { referral, trackEvent, apiClient, auth } = await freshModule();
    auth.currentUser = { uid: 'user-1' };
    vi.mocked(apiClient.post).mockResolvedValueOnce({ claimStatus: 'claimed', benefit: 'meeting_bonus' } as never);
    const before = Date.now();
    const benefit = await referral.claimReferralCode('DF-ABCD2345');

    expect(benefit).not.toBeNull();
    expect(benefit!.benefit).toBe('meeting_bonus');
    expect(benefit!.code).toBe('DF-ABCD2345');
    const expiresInDays = (new Date(benefit!.expiresAt!).getTime() - before) / (24 * 60 * 60 * 1000);
    expect(expiresInDays).toBeGreaterThan(85);
    expect(expiresInDays).toBeLessThan(95);
    expect(referral.getActiveMeetingBonusCount()).toBe(1);
    expect(trackEvent).toHaveBeenCalledWith('referral_claimed');
  });

  it('grants nothing until the server confirms (unauthenticated queues pending)', async () => {
    const { referral, apiClient } = await freshModule();
    const benefit = await referral.claimReferralCode('DF-ABCD2345');
    expect(benefit).toBeNull();
    expect(referral.getReferralBenefits()).toHaveLength(0);
    expect(referral.getActiveMeetingBonusCount()).toBe(0);
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(settingsStore.get('dealforge_referral_pending')).toBe('DF-ABCD2345');
  });

  it('grants nothing when the server rejects the claim', async () => {
    const { referral, apiClient, auth } = await freshModule();
    auth.currentUser = { uid: 'user-1' };
    vi.mocked(apiClient.post).mockResolvedValueOnce({ claimStatus: 'invalid_code', benefit: null } as never);
    expect(await referral.claimReferralCode('DF-ABCD2345')).toBeNull();
    expect(referral.getReferralBenefits()).toHaveLength(0);
  });

  it('deduplicates repeat claims of the same code', async () => {
    const { referral, apiClient, auth } = await freshModule();
    auth.currentUser = { uid: 'user-1' };
    vi.mocked(apiClient.post).mockResolvedValueOnce({ claimStatus: 'claimed', benefit: 'meeting_bonus' } as never);
    await referral.claimReferralCode('DF-ABCD2345');
    expect(await referral.claimReferralCode('DF-ABCD2345')).toBeNull();
    expect(referral.getReferralBenefits()).toHaveLength(1);
  });

  it('ignores self-referrals', async () => {
    const { referral, auth } = await freshModule();
    auth.currentUser = { uid: 'user-1' };
    const own = referral.deriveReferralCode('user-1');
    expect(await referral.claimReferralCode(own)).toBeNull();
    expect(referral.getReferralBenefits()).toHaveLength(0);
  });

  it('upgrades the benefit to a free month when the server says so', async () => {
    const { referral, apiClient, auth } = await freshModule();
    auth.currentUser = { uid: 'user-1' };
    vi.mocked(apiClient.post).mockResolvedValueOnce({ claimStatus: 'claimed', benefit: 'free_month' } as never);
    const benefit = await referral.claimReferralCode('DF-ABCD2345');
    expect(benefit!.benefit).toBe('free_month');
    expect(benefit!.expiresAt).toBeNull();
    expect(apiClient.post).toHaveBeenCalledWith('/referrals/claim', { code: 'DF-ABCD2345' });
  });

  it('queues a pending claim when not logged in', async () => {
    const { referral } = await freshModule();
    await referral.claimReferralCode('DF-ABCD2345');
    expect(settingsStore.get('dealforge_referral_pending')).toBe('DF-ABCD2345');
  });
});

describe('benefit calculations', () => {
  it('adds active bonuses to the free meeting limit', async () => {
    const { referral, apiClient, auth } = await freshModule();
    expect(referral.getEffectiveMeetingLimit('free')).toBe(3);
    auth.currentUser = { uid: 'user-1' };
    vi.mocked(apiClient.post).mockResolvedValueOnce({ claimStatus: 'claimed', benefit: 'meeting_bonus' } as never);
    await referral.claimReferralCode('DF-ABCD2345');
    expect(referral.getEffectiveMeetingLimit('free')).toBe(4);
  });

  it('keeps paid plans unlimited', async () => {
    const { referral } = await freshModule();
    await referral.claimReferralCode('DF-ABCD2345');
    expect(referral.getEffectiveMeetingLimit('pro')).toBeNull();
  });

  it('does not count expired meeting bonuses', async () => {
    settingsStore.set('dealforge_referral_benefits', [
      {
        id: 'old-1',
        code: 'DF-OLD12345',
        benefit: 'meeting_bonus',
        claimedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    ]);
    const { referral } = await freshModule();
    await referral.loadReferrals();
    expect(referral.getActiveMeetingBonusCount()).toBe(0);
    expect(referral.getEffectiveMeetingLimit('free')).toBe(3);
  });

  it('counts free month credits separately', async () => {
    settingsStore.set('dealforge_referral_benefits', [
      {
        id: 'c-1',
        code: 'DF-FREE12345',
        benefit: 'free_month',
        claimedAt: new Date().toISOString(),
        expiresAt: null,
      },
    ]);
    const { referral } = await freshModule();
    await referral.loadReferrals();
    expect(referral.getFreeMonthCredits()).toBe(1);
    expect(referral.getActiveMeetingBonusCount()).toBe(0);
  });
});

describe('initReferrals', () => {
  it('claims a referral code from the URL and cleans it', async () => {
    const { referral, apiClient, auth } = await freshModule();
    auth.currentUser = { uid: 'user-1' };
    vi.mocked(apiClient.post).mockResolvedValueOnce({ claimStatus: 'claimed', benefit: 'meeting_bonus' } as never);
    window.history.pushState({}, '', '/?ref=DF-ABCD2345');
    const benefit = await referral.initReferrals();
    expect(benefit).not.toBeNull();
    expect(window.location.search).toBe('');
    expect(referral.getActiveMeetingBonusCount()).toBe(1);
  });

  it('does nothing without a ref parameter', async () => {
    const { referral } = await freshModule();
    window.history.pushState({}, '', '/dashboard/meetings');
    expect(await referral.initReferrals()).toBeNull();
    expect(referral.getReferralBenefits()).toHaveLength(0);
  });

  it('builds share links with the ref parameter', async () => {
    const { referral } = await freshModule();
    const url = referral.getReferralShareUrl('DF-ABCD2345');
    expect(url).toContain('/?ref=DF-ABCD2345');
  });
});

describe('retryPendingReferral', () => {
  it('claims a pending referral once authenticated', async () => {
    const { referral, apiClient, auth } = await freshModule();
    vi.mocked(apiClient.post).mockResolvedValueOnce({ claimStatus: 'claimed', benefit: 'meeting_bonus' } as never);
    settingsStore.set('dealforge_referral_pending', 'DF-ABCD2345');
    auth.currentUser = { uid: 'user-1' };

    await referral.retryPendingReferral();

    expect(apiClient.post).toHaveBeenCalledWith('/referrals/claim', { code: 'DF-ABCD2345' });
    expect(settingsStore.get('dealforge_referral_pending')).toBeNull();
    expect(referral.getActiveMeetingBonusCount()).toBe(1);
  });

  it('keeps the pending claim when the server is unreachable', async () => {
    const { referral, apiClient, auth } = await freshModule();
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('network down') as never);
    settingsStore.set('dealforge_referral_pending', 'DF-ABCD2345');
    auth.currentUser = { uid: 'user-1' };

    await referral.retryPendingReferral();

    expect(settingsStore.get('dealforge_referral_pending')).toBe('DF-ABCD2345');
  });

  it('does nothing when not authenticated', async () => {
    const { referral, apiClient } = await freshModule();
    settingsStore.set('dealforge_referral_pending', 'DF-ABCD2345');
    await referral.retryPendingReferral();
    expect(apiClient.post).not.toHaveBeenCalled();
    expect(settingsStore.get('dealforge_referral_pending')).toBe('DF-ABCD2345');
  });
});
