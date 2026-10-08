import { ReactNode, useEffect } from 'react';
import { useStore } from '../../store';
import { canUseFeature, FeatureKey } from '../../services/feature-gate';
import UpgradePrompt from './UpgradePrompt';

interface FeatureGateProps {
  feature: FeatureKey;
  children: ReactNode;
  description?: string;
  compact?: boolean;
}

/**
 * Server-authoritative, fail-closed feature gate.
 * - The displayed plan comes ONLY from in-memory state populated by
 *   fetchSubscription() (server). The localStorage snapshot is never trusted
 *   for gating; tampering with it cannot elevate privileges (server
 *   requirePlan middleware re-checks Firestore on every privileged API call).
 * - Fail-closed: while subscription is loading/unfetched, pro/enterprise
 *   features render the UpgradePrompt (free treatment), never the gated
 *   content. Free features render immediately.
 * - Re-fetches before privileged actions: on mount, refresh if missing/stale
 *   so recently expired/cancelled plans are not honored from stale state.
 */
export default function FeatureGate({ feature, children, description, compact }: FeatureGateProps) {
  const plan = useStore((state) => state.subscription?.plan);
  const subscriptionLoading = useStore((state) => state.subscriptionLoading);
  const subscriptionLastFetched = useStore((state) => state.subscriptionLastFetched);

  useEffect(() => {
    const state = useStore.getState();
    const age =
      state.subscriptionLastFetched == null ? Infinity : Date.now() - state.subscriptionLastFetched;
    if (state.subscription == null || age > 60_000) {
      void state.ensureFreshSubscription().catch(() => {
        // fail-closed: fetch errors resolve to free inside the slice
      });
    }
  }, [subscriptionLastFetched]);

  if (subscriptionLoading && !plan) {
    return <UpgradePrompt feature={feature} description={description} compact={compact} />;
  }

  if (canUseFeature(plan, feature)) {
    return <>{children}</>;
  }

  return <UpgradePrompt feature={feature} description={description} compact={compact} />;
}
