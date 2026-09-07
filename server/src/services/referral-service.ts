import { getFirebaseFirestore } from './firebase-admin.js';
import { FREE_ANALYSIS_LIMIT } from './usage-service.js';
import log from '../utils/logger.js';

const CODE_PREFIX = 'DF-';
const CODE_LENGTH = 8;
const CODE_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MAX_CLAIMS_PER_USER = 10;
const MEETING_BONUS_DAYS = 90;
// free_month credits expire like meeting bonuses so sockpuppet-farmed credits
// can't stockpile indefinitely; billing consumes one fresh credit per paid
// verification. Outstanding (unconsumed) free months are capped separately.
const FREE_MONTH_EXPIRY_DAYS = 90;
const MAX_FREE_MONTH_CREDIT = 3;

export { FREE_MONTH_EXPIRY_DAYS, MAX_FREE_MONTH_CREDIT };

export type ReferralBenefitType = 'meeting_bonus' | 'free_month';

export interface ReferralClaim {
  code: string;
  claimedAt: string;
  benefit: ReferralBenefitType;
}

export type ClaimStatus = 'claimed' | 'already_claimed' | 'self_referral' | 'invalid_code' | 'limit_reached';

export interface ClaimResult {
  status: ClaimStatus;
  benefit: ReferralBenefitType | null;
  code: string;
}

export function isReferralCodeValid(code: string): boolean {
  return /^DF-[A-Z0-9]{8}$/i.test(code);
}

export function generateReferralCode(seed: string): string {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
  }
  let value = hash;
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARSET[value % CODE_CHARSET.length];
    value = Math.floor(value / CODE_CHARSET.length);
  }
  return `${CODE_PREFIX}${code}`;
}

async function withFallback<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.error('Referral service unavailable, failing open', { error: err });
    return fallback;
  }
}

export async function ensureReferralCode(uid: string): Promise<string> {
  return withFallback(generateReferralCode(uid), async () => {
    const firestore = getFirebaseFirestore();
    let code = generateReferralCode(uid);
    for (let attempt = 0; attempt < 5; attempt++) {
      const registryDoc = await firestore.collection('referrals').doc(code).get();
      if (registryDoc.exists) {
        if (registryDoc.data()?.uid === uid) {
          return code;
        }
      } else {
        await firestore.collection('referrals').doc(code).set({
          uid,
          createdAt: new Date().toISOString(),
        }, { merge: true });
        return code;
      }
      code = generateReferralCode(`${uid}-${attempt}`);
    }
    return generateReferralCode(uid);
  });
}

export async function getMyClaims(uid: string): Promise<ReferralClaim[]> {
  return withFallback([], async () => {
    const firestore = getFirebaseFirestore();
    const refs = await firestore
      .collection('users').doc(uid)
      .collection('referrals').doc('claimed').collection('codes')
      .listDocuments();
    const claims: ReferralClaim[] = [];
    for (const ref of refs) {
      const snap = await ref.get();
      if (snap.exists) {
        const data = snap.data() as { claimedAt?: string; benefit?: ReferralBenefitType };
        claims.push({ code: ref.id, claimedAt: data.claimedAt || new Date().toISOString(), benefit: data.benefit || 'meeting_bonus' });
      }
    }
    return claims;
  });
}

export async function claimReferral(uid: string, rawCode: string, plan: 'free' | 'pro' | 'enterprise'): Promise<ClaimResult> {
  const code = (typeof rawCode === 'string' ? rawCode : '').trim().toUpperCase();
  if (!isReferralCodeValid(code)) {
    return { status: 'invalid_code', benefit: null, code };
  }

  try {
    const myCode = await ensureReferralCode(uid);
    if (code === myCode) {
      return { status: 'self_referral', benefit: null, code };
    }

    const firestore = getFirebaseFirestore();
    const registryRef = firestore.collection('referrals').doc(code);
    const myClaimsRef = firestore
      .collection('users').doc(uid)
      .collection('referrals').doc('claimed').collection('codes');
    const myClaimRef = myClaimsRef.doc(code);
    const claimRef = firestore.collection('referrals').doc(code).collection('claims').doc(uid);
    const benefit: ReferralBenefitType = plan === 'free' ? 'meeting_bonus' : 'free_month';
    const claimedAt = new Date().toISOString();

    const result = await firestore.runTransaction(async (tx: any) => {
      // Must fetch referrals/{code} — unregistered DF-XXXXXXXX codes are brute-force attempts.
      const regSnap = await tx.get(registryRef);
      if (!regSnap.exists) {
        return { status: 'invalid_code', benefit: null, code } as ClaimResult;
      }
      if ((regSnap.data() as { uid?: string } | undefined)?.uid === uid) {
        return { status: 'self_referral', benefit: null, code } as ClaimResult;
      }

      const existing = await tx.get(myClaimRef);
      if (existing.exists) {
        const data = existing.data() as { benefit?: ReferralBenefitType } | undefined;
        return { status: 'already_claimed', benefit: data?.benefit || 'meeting_bonus', code } as ClaimResult;
      }

      const claimsSnap = await tx.get(myClaimsRef);
      const count = typeof claimsSnap?.size === 'number' ? claimsSnap.size : (claimsSnap?.docs?.length ?? 0);
      if (count >= MAX_CLAIMS_PER_USER) {
        return { status: 'limit_reached', benefit: null, code } as ClaimResult;
      }

      // Cap outstanding free_month credits: without this, one paid account
      // plus N sockpuppet codes stockpiles N bonus months. Counted from the
      // same snapshot (guarded reads: mock/partial docs count as non-credit).
      if (benefit === 'free_month') {
        const seen: Array<{ benefit?: unknown; claimedAt?: unknown }> = [];
        for (const doc of claimsSnap?.docs ?? []) {
          try {
            const d = (doc as { data?: () => unknown }).data?.() as { benefit?: unknown; claimedAt?: unknown } | undefined;
            if (d) seen.push(d);
          } catch {
            continue;
          }
        }
        if (countFreshFreeMonths(seen) >= MAX_FREE_MONTH_CREDIT) {
          return { status: 'limit_reached', benefit: null, code } as ClaimResult;
        }
      }

      tx.set(myClaimRef, { claimedAt, benefit });
      tx.set(claimRef, { claimedAt, benefit });
      return { status: 'claimed', benefit, code } as ClaimResult;
    });

    return result;
  } catch (err) {
    // Fail-closed: never grant a benefit when Firestore is unavailable.
    log.error('Referral claim failed, failing closed', { error: err, uid, code });
    return { status: 'invalid_code', benefit: null, code };
  }
}

export async function getActiveMeetingBonus(uid: string): Promise<number> {
  const claims = await getMyClaims(uid);
  const cutoff = Date.now() - MEETING_BONUS_DAYS * 24 * 60 * 60 * 1000;
  return claims.filter((c) => c.benefit === 'meeting_bonus' && new Date(c.claimedAt).getTime() > cutoff).length;
}

export function countFreshFreeMonths(
  claims: Array<{ benefit?: unknown; claimedAt?: unknown }>,
  nowMs = Date.now(),
): number {
  const cutoff = nowMs - FREE_MONTH_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  let n = 0;
  for (const c of claims) {
    try {
      if (c?.benefit !== 'free_month') continue;
      const t = typeof c.claimedAt === 'string' ? new Date(c.claimedAt).getTime() : NaN;
      if (Number.isFinite(t) && (t as number) > cutoff) n++;
    } catch {
      continue;
    }
  }
  return n;
}

export async function getFreeMonthsCredit(uid: string): Promise<number> {
  return countFreshFreeMonths(await getMyClaims(uid));
}

export async function getEffectiveAnalysisLimit(uid: string): Promise<number> {
  return FREE_ANALYSIS_LIMIT + (await getActiveMeetingBonus(uid));
}

export async function getReferralStatus(uid: string): Promise<{
  code: string;
  claims: ReferralClaim[];
  bonusMeetings: number;
  freeMonthsCredit: number;
  referralsMade: Array<{ uid: string; claimedAt: string }>;
}> {
  const code = await ensureReferralCode(uid);
  const claims = await getMyClaims(uid);
  const bonusMeetings = await getActiveMeetingBonus(uid);
  const freeMonthsCredit = await getFreeMonthsCredit(uid);
  const referralsMade = await withFallback<Array<{ uid: string; claimedAt: string }>>([], async () => {
    const refs = await getFirebaseFirestore().collection('referrals').doc(code).collection('claims').listDocuments();
    const result: Array<{ uid: string; claimedAt: string }> = [];
    for (const ref of refs) {
      const snap = await ref.get();
      const data = snap.data() as { claimedAt?: string } | undefined;
      result.push({ uid: ref.id, claimedAt: data?.claimedAt || new Date().toISOString() });
    }
    return result;
  });
  return { code, claims, bonusMeetings, freeMonthsCredit, referralsMade };
}
