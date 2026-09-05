import { ReactNode, useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useStore } from '../../store';
import { db } from '../../services/local-db/db';

interface ProtectedRouteProps {
  children: ReactNode;
}

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const isAuthenticated = useStore((state) => state.isAuthenticated);
  const isAuthReady = useStore((state) => state.isAuthReady);
  const location = useLocation();
  const [onboardingChecked, setOnboardingChecked] = useState(false);
  const [onboardingComplete, setOnboardingComplete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function checkOnboarding() {
      try {
        const record = await db.settings.get('onboarding_complete');
        if (!cancelled) setOnboardingComplete(record?.value === true);
      } catch {
        // Fail open so a DB error can't lock users out of the app.
        if (!cancelled) setOnboardingComplete(true);
      } finally {
        if (!cancelled) setOnboardingChecked(true);
      }
    }
    if (isAuthReady && isAuthenticated) {
      checkOnboarding();
    }
    return () => {
      cancelled = true;
    };
  }, [isAuthReady, isAuthenticated]);

  if (!isAuthReady) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: '40px', height: '40px', border: '3px solid var(--border)', borderTopColor: 'var(--accent-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Loading...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (!onboardingChecked) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: '40px', height: '40px', border: '3px solid var(--border)', borderTopColor: 'var(--accent-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Loading...</p>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  const isOnboardingRoute = location.pathname.startsWith('/onboarding');

  if (!onboardingComplete && !isOnboardingRoute) {
    return <Navigate to="/onboarding" replace />;
  }

  if (onboardingComplete && isOnboardingRoute) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}
