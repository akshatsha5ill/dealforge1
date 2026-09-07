import { db } from './local-db/db';
import { apiClient } from './api/client';
import { auth } from './firebase/config';
import { trackEvent } from './usage-analytics';
import { getMeetingLimit } from './feature-gate';
import type { SubscriptionPlan } from '../types/billing';

const CODE_PREFIX = 'DF-';
const CODE_LENGTH = 8;
const CODE_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const MEETING_BONUS_MONTHS = 3;

const CODE_KEY = 'dealforge_referral_code';
const BENEFITS_KEY = 'dealforge_referral_benefits';
const CLAIMED_KEY = 'dealforge_referral_claimed';
const PENDING_KEY = 'dealforge_referral_pending';

export type ReferralBenefitType = 'meeting_bonus' | 'free_month';

export interface ReferralBenefit {
  id: string;
  code: string;
  benefit: ReferralBenefitType;
  claimedAt: string;
  expiresAt: string | null;
}

export interface ReferralStatus {
  code: string;
  claims: Array<{ code: string; claimedAt: string; benefit: ReferralBenefitType }>;
  bonusMeetings: number;
  freeMonthsCredit: number;
  referralsMade: Array<{ uid: string; claimedAt: string }>;
}

let loaded = false;
let codeCache: string | null = null;
let benefitsCache: ReferralBenefit[] = [];
let claimedCache: string[] = [];

export function isReferralCodeValid(code: string): boolean {
  return /^DF-[A-Z0-9]{8}$/i.test(code);
}

export function deriveReferralCode(seed: string): string {
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

async function readSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const row = await db.settings.get(key);
    return (row?.value as T) ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeSetting(key: string, value: unknown): Promise<void> {
  try {
    await db.settings.put({ key, value });
  } catch {
    // IndexedDB unavailable — benefits still apply for the session
  }
}

export async function loadReferrals(): Promise<void> {
  if (loaded) return;
  const [code, benefits, claimed] = await Promise.all([
    readSetting<string | null>(CODE_KEY, null),
    readSetting<ReferralBenefit[]>(BENEFITS_KEY, []),
    readSetting<string[]>(CLAIMED_KEY, []),
  ]);
  codeCache = code;
  benefitsCache = benefits;
  claimedCache = claimed;
  loaded = true;
}

export async function getOrCreateReferralCode(uid: string | null | undefined): Promise<string> {
  await loadReferrals();
  if (codeCache) return codeCache;
  const code = uid ? deriveReferralCode(uid) : deriveReferralCode(`${Date.now()}-${Math.random()}`);
  codeCache = code;
  await writeSetting(CODE_KEY, code);
  return code;
}

function persistBenefits(): Promise<void> {
  return writeSetting(BENEFITS_KEY, benefitsCache);
}

function persistClaimed(): Promise<void> {
  return writeSetting(CLAIMED_KEY, claimedCache);
}

export function getReferralBenefits(): ReferralBenefit[] {
  return benefitsCache;
}

export function getActiveMeetingBonusCount(): number {
  const now = Date.now();
  return benefitsCache.filter(
    (b) => b.benefit === 'meeting_bonus' && (!b.expiresAt || new Date(b.expiresAt).getTime() > now)
  ).length;
}

export function getFreeMonthCredits(): number {
  return benefitsCache.filter((b) => b.benefit === 'free_month').length;
}

export function getEffectiveMeetingLimit(plan: SubscriptionPlan | string | null | undefined): number | null {
  const base = getMeetingLimit(plan);
  if (base === null) return null;
  return base + getActiveMeetingBonusCount();
}

export function getReferralShareUrl(code: string): string {
  return `${window.location.origin}/?ref=${encodeURIComponent(code)}`;
}

function makeLocalBenefit(code: string, benefit: ReferralBenefitType): ReferralBenefit {
  return {
    id: `${code}-${Date.now()}`,
    code,
    benefit,
    claimedAt: new Date().toISOString(),
    expiresAt:
      benefit === 'free_month'
        ? null
        : new Date(Date.now() + MEETING_BONUS_MONTHS * 30 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

export async function claimReferralCode(code: string): Promise<ReferralBenefit | null> {
  await loadReferrals();
  const normalized = code.trim().toUpperCase();
  if (!isReferralCodeValid(normalized) || claimedCache.includes(normalized)) return null;

  // Server is the source of truth for benefits: only grant locally after the
  // server confirms the claim. Granting first (and keeping it on server
  // failure/offline/IndexedDB wipe) inflates limits client-side and lets
  // unconfirmed codes masquerade as benefits.
  if (!auth.currentUser) {
    await writeSetting(PENDING_KEY, normalized);
    return null;
  }

  const ownCode = await getOrCreateReferralCode(auth.currentUser.uid);
  if (normalized === ownCode) return null;

  try {
    const res = await apiClient.post<{ claimStatus: string; benefit: ReferralBenefitType }>('/referrals/claim', { code: normalized });
    if (res.claimStatus !== 'claimed') {
      if (res.claimStatus === 'already_claimed') {
        claimedCache.push(normalized);
        await persistClaimed();
      }
      return null;
    }
    const benefit = makeLocalBenefit(normalized, res.benefit === 'free_month' ? 'free_month' : 'meeting_bonus');
    claimedCache.push(normalized);
    benefitsCache.push(benefit);
    await Promise.all([persistClaimed(), persistBenefits()]);
    trackEvent('referral_claimed');
    return benefit;
  } catch {
    await writeSetting(PENDING_KEY, normalized);
    return null;
  }
}

export async function retryPendingReferral(): Promise<void> {
  if (!auth.currentUser) return;
  await loadReferrals();
  const pending = await readSetting<string | null>(PENDING_KEY, null);
  if (!pending) return;
  try {
    const res = await apiClient.post<{ claimStatus: string; benefit: ReferralBenefitType }>('/referrals/claim', { code: pending });
    // Server-confirmed only: materialize the local benefit on 'claimed' (and
    // record already-claimed codes so they aren't retried/granted again).
    if (res.claimStatus === 'claimed') {
      if (!claimedCache.includes(pending)) {
        claimedCache.push(pending);
        await persistClaimed();
      }
      if (!benefitsCache.some((b) => b.code === pending)) {
        benefitsCache.push(makeLocalBenefit(pending, res.benefit === 'free_month' ? 'free_month' : 'meeting_bonus'));
        await persistBenefits();
        trackEvent('referral_claimed');
      }
    } else if (res.claimStatus === 'already_claimed') {
      if (!claimedCache.includes(pending)) {
        claimedCache.push(pending);
        await persistClaimed();
      }
    }
    // Terminal statuses (invalid_code/self_referral/limit_reached) clear the
    // queue too — retrying cannot change the outcome. Only network errors
    // (catch above) keep the pending code.
  } catch {
    return;
  }
  await writeSetting(PENDING_KEY, null);
}

export async function initReferrals(): Promise<ReferralBenefit | null> {
  await loadReferrals();
  const params = new URLSearchParams(window.location.search);
  const ref = params.get('ref');
  if (!ref) return null;
  const cleanUrl = window.location.pathname + window.location.search.replace(/[?&]ref=[^&]*/, '').replace(/^&/, '') + window.location.hash;
  window.history.replaceState({}, '', cleanUrl);
  return claimReferralCode(ref);
}

export async function fetchReferralStatus(): Promise<ReferralStatus | null> {
  try {
    const res = await apiClient.get<ReferralStatus>('/referrals/status');
    return res;
  } catch {
    return null;
  }
}

export function trackReferralCreated(): void {
  trackEvent('referral_created');
}
