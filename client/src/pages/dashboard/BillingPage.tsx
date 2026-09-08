import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { apiClient } from '../../services/api/client';
import { PLAN_CONFIGS, SubscriptionPlan, SubscriptionStatus } from '../../types/billing';
import { useStore } from '../../store';
import { toast } from '../../components/common/Toast';
import styles from './BillingPage.module.css';

interface Subscription {
  plan: SubscriptionPlan;
  status: string;
  currentPeriodEnd: string | null;
  customerId: string | null;
  subscriptionId: string | null;
}

export default function BillingPage() {
  const setSubscription = useStore((state) => state.setSubscription);
  const [subscription, setSubscriptionLocal] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [verifyingPayment, setVerifyingPayment] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const updateSubscription = useCallback((data: Subscription | null) => {
    setSubscriptionLocal(data);
    if (data) {
      setSubscription({
        plan: data.plan,
        status: (['active', 'cancelled', 'past_due', 'trialing'].includes(data.status) ? data.status : 'active') as SubscriptionStatus,
        currentPeriodEnd: data.currentPeriodEnd,
        customerId: data.customerId,
        subscriptionId: data.subscriptionId,
      });
    }
  }, [setSubscription]);

  const fetchSubscription = useCallback(async () => {
    try {
      const data = await apiClient.get<Subscription>('/billing/subscription');
      updateSubscription(data);
      return data;
    } catch (err) {
      console.error('Failed to fetch subscription:', err);
      // Mirror subscriptionSlice: never keep a possibly-stale paid plan when
      // the server can't confirm it. Server remains the authority.
      setSubscription(null);
      return null;
    }
  }, [updateSubscription, setSubscription]);

  const refreshSubscription = async () => {
    setRefreshing(true);
    try {
      const data = await fetchSubscription();
      if (data && data.plan !== 'free') {
        toast.success('Subscription status updated!');
      } else {
        toast.info('No active subscription found.');
      }
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');

    if (!sessionId) {
      fetchSubscription().finally(() => setLoading(false));
      return;
    }
    setVerifyingPayment(true);
    const pendingPlan = localStorage.getItem('pending_plan') || 'pro';

    let attempts = 0;
    const maxAttempts = 10;
    let verified = false;
    let inFlight = false;

    const poll = setInterval(async () => {
      // Guard against overlapping ticks on slow networks.
      if (inFlight) return;
      inFlight = true;
      try {
        attempts++;

      if (!verified) {
        try {
          const result = await apiClient.verifyCheckout(sessionId, pendingPlan);
          // Server returns 200 { status: 'pending' } while payment is not
          // yet succeeded — only stop retrying once verify is terminal.
          if (result && (result as { status?: string }).status !== 'pending') {
            verified = true;
            localStorage.removeItem('pending_plan');
          }
        } catch (err) {
          // 409 = session already processed (idempotent replay) — treat as verified.
          const msg = err instanceof Error ? err.message : String(err ?? '');
          if (msg.includes('409') || msg.toLowerCase().includes('already processed')) {
            verified = true;
            localStorage.removeItem('pending_plan');
          }
          // Other transient verify errors (4xx/5xx/network) — retry next poll until timeout.
        }
      }

      const data = await fetchSubscription();

      if (data && data.plan !== 'free') {
        clearInterval(poll);
        pollingRef.current = null;
        setVerifyingPayment(false);
        setLoading(false);
        toast.success('Payment verified! Your subscription is now active.');
        window.history.replaceState({}, '', '/dashboard/billing');
        return;
      }

      if (attempts >= maxAttempts) {
        clearInterval(poll);
        pollingRef.current = null;
        setVerifyingPayment(false);
        setLoading(false);
        toast.info('Payment is still being processed. Please check back later.');
        window.history.replaceState({}, '', '/dashboard/billing');
      }
      } finally {
        inFlight = false;
      }
    }, 3000);

    pollingRef.current = poll;

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [fetchSubscription]);

  const handleCheckout = async (plan: SubscriptionPlan) => {
    if (plan === 'free') return;
    setCheckoutLoading(plan);
    try {
      const response = await apiClient.post<{ checkout_url: string }>('/billing/checkout', { plan });
      if (response.checkout_url) {
        localStorage.setItem('pending_plan', plan);
        window.location.href = response.checkout_url;
      }
    } catch (err) {
      console.error('Checkout failed:', err);
      toast.error('Failed to start checkout. Please try again.');
      setCheckoutLoading(null);
    }
  };

  const handleCancel = async () => {
    setCancelLoading(true);
    try {
      await apiClient.post('/billing/cancel');
      const updated = { ...(subscription || { plan: 'free' as SubscriptionPlan, status: '', currentPeriodEnd: null, customerId: null, subscriptionId: null }), status: 'cancelled' };
      updateSubscription(updated);
      toast.success('Subscription cancelled. It will remain active until the end of the billing period.');
    } catch (err) {
      console.error('Cancel failed:', err);
      toast.error('Failed to cancel subscription. Please try again.');
    } finally {
      setCancelLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="animate-fade-in">
        <div className={styles.loading}>Loading subscription...</div>
      </div>
    );
  }

  const currentPlan = subscription?.plan || 'free';
  const planConfig = PLAN_CONFIGS[currentPlan];

  return (
    <div className="animate-fade-in">
      <div className={styles.billingContainer}>
        <h1 className={styles.billingTitle}>Billing</h1>
        <p className={styles.billingSubtitle}>Manage your subscription and plan details.</p>
      </div>

      {verifyingPayment && (
        <div className={styles.verifyingBanner}>
          <span className={styles.verifyingSpinner} />
          Verifying your payment... This may take a moment.
        </div>
      )}

      <div className={`ds-panel ${styles.currentPlan}`}>
        <div className={styles.currentPlanHeader}>
          <span className={styles.currentPlanName}>Current Plan</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              className={styles.refreshButton}
              onClick={refreshSubscription}
              disabled={refreshing || verifyingPayment}
              title="Refresh subscription status"
            >
              <RefreshCw size={14} className={refreshing ? styles.spinning : ''} />
              {refreshing ? 'Refreshing...' : 'Refresh Status'}
            </button>
            <span className={`${styles.statusBadge} ${styles[subscription?.status || 'active']}`}>
              {subscription?.status || 'active'}
            </span>
          </div>
        </div>
        <div className={styles.planDetails}>
          <div>
            <div className={styles.planPrice}>{planConfig.priceLabel}</div>
            <div className={styles.planPeriod}>per month</div>
          </div>
          {subscription?.currentPeriodEnd && (
            <div className={styles.planRenewal}>
              {subscription.status === 'cancelled'
                ? `Expires ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
                : `Renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`}
            </div>
          )}
        </div>
      </div>

      <div className={styles.plansSection}>
        <h2 className={styles.plansSectionTitle}>Available Plans</h2>
        <div className={styles.plansGrid}>
          {(Object.entries(PLAN_CONFIGS) as [SubscriptionPlan, typeof planConfig][]).map(([key, plan]) => {
            const isCurrent = key === currentPlan;
            const isUpgrade = key !== 'free' && PLAN_CONFIGS[key].price > PLAN_CONFIGS[currentPlan].price;
            const isDowngrade = key !== 'free' && PLAN_CONFIGS[key].price < PLAN_CONFIGS[currentPlan].price;

            return (
              <div key={key} className={`${styles.planCard} ${isCurrent ? styles.current : ''}`}>
                <div className={styles.planCardHeader}>
                  {isCurrent && <div className={styles.currentLabel}>Current Plan</div>}
                  <div className={styles.planCardName}>{plan.name}</div>
                  <div className={styles.planCardPrice}>
                    {plan.priceLabel}
                    <span className={styles.planCardPeriod}>/mo</span>
                  </div>
                </div>
                <ul className={styles.planCardFeatures}>
                  {plan.features.map((feature) => (
                    <li key={feature} className={styles.planCardFeature}>
                      <Check size={14} style={{ color: 'var(--tertiary)', flexShrink: 0 }} />
                      {feature}
                    </li>
                  ))}
                </ul>
                {key === 'enterprise' && (
                  <div style={{ marginTop: '-4px', marginBottom: '12px', fontSize: '12px', color: 'var(--secondary)', fontWeight: 600 }}>
                    Team discount: $59/seat/mo for teams of 5+
                  </div>
                )}
                {isCurrent ? (
                  <button className={`${styles.planCardButton} ${styles.primary}`} disabled>
                    Current Plan
                  </button>
                ) : key === 'free' ? (
                  <button className={styles.planCardButton} disabled>
                    Free Forever
                  </button>
                ) : isUpgrade || currentPlan === 'free' ? (
                  <button
                    className={`${styles.planCardButton} ${styles.primary}`}
                    onClick={() => handleCheckout(key)}
                    disabled={checkoutLoading !== null}
                  >
                    {checkoutLoading === key ? 'Redirecting...' : 'Upgrade'}
                  </button>
                ) : isDowngrade ? (
                  <button
                    className={`${styles.planCardButton} ${styles.primary}`}
                    onClick={() => handleCheckout(key)}
                    disabled={checkoutLoading !== null}
                  >
                    {checkoutLoading === key ? 'Redirecting...' : 'Downgrade'}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {currentPlan !== 'free' && subscription?.status === 'active' && (
        <div className={`ds-panel ${styles.cancelSection}`}>
          <h3 className={styles.cancelSectionTitle}>Cancel Subscription</h3>
          <p className={styles.cancelDescription}>
            Your subscription will remain active until the end of the current billing period.
            You will not be charged again after cancellation.
          </p>
          <button
            className={styles.cancelButton}
            onClick={handleCancel}
            disabled={cancelLoading}
          >
            {cancelLoading ? 'Cancelling...' : 'Cancel Subscription'}
          </button>
        </div>
      )}
    </div>
  );
}
