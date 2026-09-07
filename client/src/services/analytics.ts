/// <reference types="vite/client" />
// Google Analytics (third-party pageviews). Distinct from usage-analytics.ts
// (local product-event store) and utils/analytics.ts (chart data builders).
import { readConsent } from './cookie-consent';

const GA_MEASUREMENT_ID = import.meta.env.VITE_GA_ID as string | undefined;

declare global {
  interface Window {
    dataLayer: any[];
    gtag: (...args: any[]) => void;
  }
}

function injectGAScript() {
  if (document.getElementById('ga-script')) return;

  const s = document.createElement('script');
  s.id = 'ga-script';
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag('js', new Date());
  window.gtag('config', GA_MEASUREMENT_ID, { anonymize_ip: true });
}

export function initAnalytics() {
  if (!GA_MEASUREMENT_ID) return;
  if (readConsent() === 'accepted') {
    injectGAScript();
  }
}

export function enableAnalytics() {
  if (!GA_MEASUREMENT_ID) return;
  injectGAScript();
}

export function disableAnalytics() {
  // Cannot truly "unload" GA, but we stop sending events
  // by nulling the gtag function
  window.gtag = () => {};
}

export function trackEvent(name: string, params?: Record<string, any>) {
  if (readConsent() !== 'accepted') return;
  if (typeof window.gtag === 'function') {
    window.gtag('event', name, params);
  }
}

export function trackPageView(path: string) {
  if (readConsent() !== 'accepted') return;
  if (typeof window.gtag === 'function') {
    window.gtag('event', 'page_view', { page_path: path });
  }
}
