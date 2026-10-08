import { lazy, Suspense } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import DashboardLayout from './components/layout/DashboardLayout';
import ProtectedRoute from './components/layout/ProtectedRoute';
import ZoomPanelLayout from './components/layout/ZoomPanelLayout';
import LoginPage from './pages/auth/LoginPage';
import LandingPage from './pages/LandingPage';
import { ErrorBoundary } from './components/common';

// Lazy loaded components for code splitting
const DashboardPage = lazy(() => import('./pages/dashboard/DashboardPage'));
const OnboardingPage = lazy(() => import('./pages/onboarding/OnboardingPage'));
const MeetingsPage = lazy(() => import('./pages/dashboard/MeetingsPage'));
const MeetingDetailPage = lazy(() => import('./pages/dashboard/MeetingDetailPage'));
const LeadsPage = lazy(() => import('./pages/dashboard/LeadsPage'));
const LeadDetailPage = lazy(() => import('./pages/dashboard/LeadDetailPage'));
const SettingsPage = lazy(() => import('./pages/dashboard/SettingsPage'));
const AnalyticsPage = lazy(() => import('./pages/dashboard/AnalyticsPage'));
const PipelinePage = lazy(() => import('./pages/dashboard/PipelinePage'));
const EmailPage = lazy(() => import('./pages/dashboard/EmailPage'));
const BillingPage = lazy(() => import('./pages/dashboard/BillingPage'));

const PrivacyPolicy = lazy(() => import('./pages/landing/PrivacyPolicy'));
const TermsOfService = lazy(() => import('./pages/landing/TermsOfService'));
const Support = lazy(() => import('./pages/landing/Support'));

const TranscriptionView = lazy(() => import('./pages/zoom-panel/TranscriptionView'));
const SuggestionsView = lazy(() => import('./pages/zoom-panel/SuggestionsView'));
const NotesView = lazy(() => import('./pages/zoom-panel/NotesView'));

const SuspenseFallback = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', color: 'var(--text-muted)' }}>
    Loading...
  </div>
);

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/onboarding',
    element: (
      <ProtectedRoute>
        <Suspense fallback={<SuspenseFallback />}>
          <OnboardingPage />
        </Suspense>
      </ProtectedRoute>
    ),
  },
  { path: '/privacy', element: <Suspense fallback={<SuspenseFallback />}><PrivacyPolicy /></Suspense> },
  { path: '/terms', element: <Suspense fallback={<SuspenseFallback />}><TermsOfService /></Suspense> },
  { path: '/support', element: <Suspense fallback={<SuspenseFallback />}><Support /></Suspense> },
  {
    path: '/',
    element: <LandingPage />,
  },
  {
    path: '/dashboard',
    element: (
      <ProtectedRoute>
        <DashboardLayout />
      </ProtectedRoute>
    ),
    errorElement: <ErrorBoundary />,
    children: [
      { index: true, element: <Suspense fallback={<SuspenseFallback />}><DashboardPage /></Suspense> },
      { path: 'meetings', element: <Suspense fallback={<SuspenseFallback />}><MeetingsPage /></Suspense> },
      { path: 'meetings/:id', element: <Suspense fallback={<SuspenseFallback />}><MeetingDetailPage /></Suspense> },
      { path: 'leads', element: <Suspense fallback={<SuspenseFallback />}><LeadsPage /></Suspense> },
      { path: 'leads/:id', element: <Suspense fallback={<SuspenseFallback />}><LeadDetailPage /></Suspense> },
      { path: 'analytics', element: <Suspense fallback={<SuspenseFallback />}><AnalyticsPage /></Suspense> },
      { path: 'pipeline', element: <Suspense fallback={<SuspenseFallback />}><PipelinePage /></Suspense> },
      { path: 'emails', element: <Suspense fallback={<SuspenseFallback />}><EmailPage /></Suspense> },
      { path: 'settings', element: <Suspense fallback={<SuspenseFallback />}><SettingsPage /></Suspense> },
      { path: 'billing', element: <Suspense fallback={<SuspenseFallback />}><BillingPage /></Suspense> },

    ],
  },
  {
    path: '/zoom-panel',
    element: (
      <ProtectedRoute>
        <ZoomPanelLayout />
      </ProtectedRoute>
    ),
    errorElement: <ErrorBoundary />,
    children: [
      { index: true, element: <Suspense fallback={<SuspenseFallback />}><TranscriptionView /></Suspense> },
      { path: 'transcription', element: <Suspense fallback={<SuspenseFallback />}><TranscriptionView /></Suspense> },
      { path: 'suggestions', element: <Suspense fallback={<SuspenseFallback />}><SuggestionsView /></Suspense> },
      { path: 'notes', element: <Suspense fallback={<SuspenseFallback />}><NotesView /></Suspense> },
    ],
  },
]);
