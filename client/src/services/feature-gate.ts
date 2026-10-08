import { PLAN_CONFIGS, SubscriptionPlan } from '../types/billing';

/**
 * Client-side plan mirror — DISPLAY ONLY, never authoritative.
 * - Server (Firestore subscription doc + requirePlan middleware) is the source
 *   of truth and enforces every privileged API route. Client checks only hide
 *   UI; bypassing them grants nothing without a server-side plan.
 * - Fail-closed: unknown/null/undefined plans resolve to 'free' via getPlan().
 *   Callers MUST call useStore.getState().ensureFreshSubscription() before
 *   privileged actions (checkout, AI/email sends, exports) so stale state
 *   cannot honor an expired/cancelled plan.
 */

export type FeatureKey =
  | 'emailOutreach'
  | 'pipeline'
  | 'customStages'
  | 'allAiModels'
  | 'prioritySupport'
  | 'teamFeatures'
  | 'apiAccess';

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  emailOutreach: 'Email Outreach',
  pipeline: 'Pipeline Management',
  customStages: 'Custom Pipeline Stages',
  allAiModels: 'All AI Models',
  prioritySupport: 'Priority Support',
  teamFeatures: 'Team Features',
  apiAccess: 'API Access',
};

export const FEATURE_MIN_PLAN: Record<FeatureKey, SubscriptionPlan> = {
  emailOutreach: 'pro',
  pipeline: 'pro',
  customStages: 'enterprise',
  allAiModels: 'pro',
  prioritySupport: 'enterprise',
  teamFeatures: 'enterprise',
  apiAccess: 'pro',
};

const LIMIT_KEYS: Record<FeatureKey, keyof (typeof PLAN_CONFIGS)['pro']['limits']> = {
  emailOutreach: 'emailOutreach',
  pipeline: 'pipeline',
  customStages: 'customStages',
  allAiModels: 'aiModels',
  prioritySupport: 'prioritySupport',
  teamFeatures: 'teamFeatures',
  apiAccess: 'apiAccess',
};

export const getPlan = (plan: SubscriptionPlan | string | null | undefined): SubscriptionPlan =>
  plan && plan in PLAN_CONFIGS ? (plan as SubscriptionPlan) : 'free';

export const canUseFeature = (plan: SubscriptionPlan | string | null | undefined, feature: FeatureKey): boolean => {
  const limits = PLAN_CONFIGS[getPlan(plan)].limits;
  if (feature === 'allAiModels') {
    return limits.aiModels >= 3;
  }
  return !!limits[LIMIT_KEYS[feature]];
};

export const getMeetingLimit = (plan: SubscriptionPlan | string | null | undefined): number | null =>
  PLAN_CONFIGS[getPlan(plan)].limits.meetingsPerMonth;

export const getAiModelLimit = (plan: SubscriptionPlan | string | null | undefined): number =>
  PLAN_CONFIGS[getPlan(plan)].limits.aiModels;

export const isAtMeetingLimit = (plan: SubscriptionPlan | string | null | undefined, used: number): boolean => {
  const limit = getMeetingLimit(plan);
  return limit !== null && used >= limit;
};

export const getTranscriptHistoryDays = (plan: SubscriptionPlan | string | null | undefined): number | null =>
  PLAN_CONFIGS[getPlan(plan)].limits.transcriptHistoryDays;

export const isTranscriptExpired = (
  plan: SubscriptionPlan | string | null | undefined,
  meetingStartTime: string | undefined
): boolean => {
  const days = getTranscriptHistoryDays(plan);
  if (days === null || !meetingStartTime) return false;
  const ageMs = Date.now() - new Date(meetingStartTime).getTime();
  return ageMs > days * 24 * 60 * 60 * 1000;
};
