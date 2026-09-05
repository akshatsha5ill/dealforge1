import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isReferralCodeValid,
  generateReferralCode,
  ensureReferralCode,
  claimReferral,
  getMyClaims,
  getActiveMeetingBonus,
  getFreeMonthsCredit,
  getEffectiveAnalysisLimit,
  getReferralStatus,
} from './referral-service.js';

const registryGet = vi.fn();
const registrySet = vi.fn();
const claimsListForCode = vi.fn();
const claimSet = vi.fn();
const myClaimGet = vi.fn();
const myClaimSet = vi.fn();
const myClaimsList = vi.fn();
const txClaimsSnap = vi.fn();

const claimRef = (id: string, data: unknown) => ({
  id,
  get: vi.fn().mockResolvedValue({ exists: true, data: () => data }),
});

vi.mock('./firebase-admin.js', () => {
  return {
    getFirebaseFirestore: () => {
      const myClaimsCollection = {
        doc: (_code: string) => ({ get: myClaimGet, set: myClaimSet }),
        listDocuments: myClaimsList,
      };
      const myReferralsDoc = {
        get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
        set: vi.fn(),
        collection: () => myClaimsCollection,
      };
      const myReferralsCollection = {
        doc: (_code: string) => myReferralsDoc,
      };
      const claimsForCodeCollection = {
        doc: (_uid: string) => ({ set: claimSet }),
        listDocuments: claimsListForCode,
      };
      const registryDoc = {
        get: registryGet,
        set: registrySet,
        collection: () => claimsForCodeCollection,
      };
      // Transactional claim path: service calls tx.get 3x in order
      // (registry, myClaim, myClaims-count) then tx.set 2x (myClaim, claim).
      const runTransaction = async (fn: (tx: any) => Promise<any>) => {
        let getCalls = 0;
        let setCalls = 0;
        const tx = {
          get: async (_ref: unknown) => {
            getCalls += 1;
            if (getCalls === 1) return registryGet();
            if (getCalls === 2) return myClaimGet();
            return txClaimsSnap();
          },
          set: (..._args: unknown[]) => {
            setCalls += 1;
            if (setCalls === 1) return myClaimSet(...(_args.slice(1) as [any]));
            return claimSet(...(_args.slice(1) as [any]));
          },
        };
        return fn(tx);
      };
      return {
        collection: (name: string) => {
          if (name === 'referrals') {
            return { doc: (_code: string) => registryDoc };
          }
          if (name === 'users') {
            return { doc: (_uid: string) => ({ collection: () => myReferralsCollection }) };
          }
          throw new Error(`unexpected collection: ${name}`);
        },
        runTransaction,
      };
    },
  };
});

const registryDoc = (uid: string | null) => ({
  exists: uid !== null,
  data: () => (uid !== null ? { uid } : {}),
});

const claimDoc = (benefit: string | null) => ({
  exists: benefit !== null,
  data: () => (benefit !== null ? { benefit, claimedAt: new Date().toISOString() } : {}),
});

describe('referral-service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('generateReferralCode', () => {
    it('produces a valid DF- code', () => {
      const code = generateReferralCode('user-1');
      expect(isReferralCodeValid(code)).toBe(true);
    });

    it('is deterministic for the same seed', () => {
      expect(generateReferralCode('user-1')).toBe(generateReferralCode('user-1'));
    });

    it('differs for different seeds', () => {
      expect(generateReferralCode('user-1')).not.toBe(generateReferralCode('user-2'));
    });
  });

  describe('isReferralCodeValid', () => {
    it('accepts uppercase codes', () => {
      expect(isReferralCodeValid('DF-ABCD2345')).toBe(true);
    });

    it('accepts lowercase codes', () => {
      expect(isReferralCodeValid('df-abcd2345')).toBe(true);
    });

    it('rejects malformed codes', () => {
      expect(isReferralCodeValid('')).toBe(false);
      expect(isReferralCodeValid('ABCD2345')).toBe(false);
      expect(isReferralCodeValid('DF-AB12')).toBe(false);
      expect(isReferralCodeValid('DF-ABCD23456')).toBe(false);
    });
  });

  describe('ensureReferralCode', () => {
    it('creates a registry entry when the code is free', async () => {
      registryGet.mockResolvedValueOnce(registryDoc(null));
      registrySet.mockResolvedValueOnce(undefined);
      const code = await ensureReferralCode('user-1');
      expect(code).toBe(generateReferralCode('user-1'));
      expect(registrySet).toHaveBeenCalledWith(expect.objectContaining({ uid: 'user-1' }), { merge: true });
    });

    it('reuses an existing registry entry owned by the user', async () => {
      registryGet.mockResolvedValueOnce(registryDoc('user-1'));
      const code = await ensureReferralCode('user-1');
      expect(code).toBe(generateReferralCode('user-1'));
      expect(registrySet).not.toHaveBeenCalled();
    });

    it('regenerates when the code is taken by another user', async () => {
      registryGet.mockResolvedValueOnce(registryDoc('other-user')).mockResolvedValueOnce(registryDoc(null));
      registrySet.mockResolvedValueOnce(undefined);
      const code = await ensureReferralCode('user-1');
      expect(code).not.toBe(generateReferralCode('user-1'));
      expect(isReferralCodeValid(code)).toBe(true);
    });

    it('fails open to a deterministic code when Firestore is unavailable', async () => {
      registryGet.mockRejectedValueOnce(new Error('not configured'));
      const code = await ensureReferralCode('user-1');
      expect(code).toBe(generateReferralCode('user-1'));
    });
  });

  describe('claimReferral', () => {
    it('rejects invalid codes', async () => {
      const result = await claimReferral('user-1', 'not-a-code', 'free');
      expect(result.status).toBe('invalid_code');
    });

    it('rejects self-referrals', async () => {
      registryGet.mockResolvedValue(registryDoc('user-1'));
      const myCode = generateReferralCode('user-1');
      const result = await claimReferral('user-1', myCode, 'free');
      expect(result.status).toBe('self_referral');
    });

    it('grants a meeting bonus to free users and records both documents', async () => {
      registryGet.mockResolvedValue(registryDoc('referrer-1'));
      myClaimGet.mockResolvedValueOnce(claimDoc(null));
      txClaimsSnap.mockResolvedValueOnce({ size: 0, docs: [] });
      myClaimSet.mockResolvedValueOnce(undefined);
      claimSet.mockResolvedValueOnce(undefined);

      const result = await claimReferral('user-1', 'DF-ABCD2345', 'free');
      expect(result.status).toBe('claimed');
      expect(result.benefit).toBe('meeting_bonus');
      expect(myClaimSet).toHaveBeenCalledWith(expect.objectContaining({ benefit: 'meeting_bonus', claimedAt: expect.any(String) }));
      expect(claimSet).toHaveBeenCalledWith(expect.objectContaining({ benefit: 'meeting_bonus' }));
    });

    it('grants a free month to paid users', async () => {
      registryGet.mockResolvedValue(registryDoc('referrer-1'));
      myClaimGet.mockResolvedValueOnce(claimDoc(null));
      txClaimsSnap.mockResolvedValueOnce({ size: 0, docs: [] });

      const result = await claimReferral('user-1', 'DF-ABCD2345', 'pro');
      expect(result.status).toBe('claimed');
      expect(result.benefit).toBe('free_month');
    });

    it('returns already_claimed with the stored benefit on duplicate claims', async () => {
      registryGet.mockResolvedValue(registryDoc('referrer-1'));
      myClaimGet.mockResolvedValueOnce(claimDoc('meeting_bonus'));

      const result = await claimReferral('user-1', 'DF-ABCD2345', 'free');
      expect(result.status).toBe('already_claimed');
      expect(result.benefit).toBe('meeting_bonus');
      expect(myClaimSet).not.toHaveBeenCalled();
    });

    it('rejects claims beyond the per-user cap', async () => {
      registryGet.mockResolvedValue(registryDoc('referrer-1'));
      myClaimGet.mockResolvedValueOnce(claimDoc(null));
      txClaimsSnap.mockResolvedValueOnce({ size: 10, docs: new Array(10).fill({ id: 'x' }) });

      const result = await claimReferral('user-1', 'DF-ABCD2345', 'free');
      expect(result.status).toBe('limit_reached');
    });

    it('fails closed when Firestore is unavailable (no benefit granted)', async () => {
      registryGet.mockResolvedValue(registryDoc('referrer-1'));
      myClaimGet.mockRejectedValueOnce(new Error('not configured'));

      const result = await claimReferral('user-1', 'DF-ABCD2345', 'free');
      expect(result.status).toBe('invalid_code');
      expect(result.benefit).toBeNull();
    });
  });

  describe('getMyClaims / bonuses', () => {
    const oldClaim = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const newClaim = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    it('counts only active meeting bonuses (within 90 days)', async () => {
      myClaimsList.mockResolvedValueOnce([
        claimRef('DF-AAAA1111', { benefit: 'meeting_bonus', claimedAt: newClaim }),
        claimRef('DF-BBBB2222', { benefit: 'meeting_bonus', claimedAt: oldClaim }),
        claimRef('DF-CCCC3333', { benefit: 'free_month', claimedAt: newClaim }),
      ]);
      expect(await getActiveMeetingBonus('user-1')).toBe(1);
    });

    it('counts free month credits separately', async () => {
      myClaimsList.mockResolvedValueOnce([
        claimRef('DF-AAAA1111', { benefit: 'free_month', claimedAt: newClaim }),
        claimRef('DF-BBBB2222', { benefit: 'meeting_bonus', claimedAt: newClaim }),
      ]);
      expect(await getFreeMonthsCredit('user-1')).toBe(1);
    });

    it('adds the bonus to the free analysis limit', async () => {
      myClaimsList.mockResolvedValueOnce([
        claimRef('DF-AAAA1111', { benefit: 'meeting_bonus', claimedAt: newClaim }),
      ]);
      expect(await getEffectiveAnalysisLimit('user-1')).toBe(4);
    });

    it('fails open to zero bonus', async () => {
      myClaimsList.mockRejectedValueOnce(new Error('not configured'));
      expect(await getActiveMeetingBonus('user-1')).toBe(0);
      expect(await getEffectiveAnalysisLimit('user-1')).toBe(3);
    });
  });

  describe('getReferralStatus', () => {
    it('returns code, claims, and referrals made', async () => {
      registryGet.mockResolvedValue(registryDoc('user-1'));
      myClaimsList.mockResolvedValue([
        claimRef('DF-AAAA1111', { benefit: 'meeting_bonus', claimedAt: new Date().toISOString() }),
      ]);
      claimsListForCode.mockResolvedValue([claimRef('claimant-9', { claimedAt: new Date().toISOString() })]);

      const status = await getReferralStatus('user-1');
      expect(status.code).toBe(generateReferralCode('user-1'));
      expect(status.claims).toHaveLength(1);
      expect(status.bonusMeetings).toBe(1);
      expect(status.freeMonthsCredit).toBe(0);
      expect(status.referralsMade).toEqual([expect.objectContaining({ uid: 'claimant-9' })]);
    });
  });
});
