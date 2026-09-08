import { NavLink } from 'react-router-dom';
import { Home, Video, Users, Settings, BarChart3, Mail, GitBranch, CreditCard, Lock } from 'lucide-react';
import { useStore } from '../../store';
import { canUseFeature } from '../../services/feature-gate';
import { APP_VERSION } from '../../version';
import './Sidebar.css';

const navItems = [
  { to: '/dashboard', icon: Home, label: 'Dashboard', end: true, num: '01' },
  { to: '/dashboard/meetings', icon: Video, label: 'Meetings', num: '02' },
  { to: '/dashboard/leads', icon: Users, label: 'Leads', num: '03' },
  { to: '/dashboard/pipeline', icon: GitBranch, label: 'Pipeline', num: '04', feature: 'pipeline' as const },
  { to: '/dashboard/emails', icon: Mail, label: 'Emails', num: '05', feature: 'emailOutreach' as const },
  { to: '/dashboard/analytics', icon: BarChart3, label: 'Analytics', num: '06' },
  { to: '/dashboard/billing', icon: CreditCard, label: 'Billing', num: '07' },
  { to: '/dashboard/settings', icon: Settings, label: 'Settings', num: '08' },
];

export default function Sidebar() {
  const plan = useStore((state) => state.subscription?.plan);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark">D.</span>
          <span className="sidebar-brand-name">DealForge</span>
        </div>
        <span className="sidebar-brand-tagline">local operating system</span>
      </div>

      <div className="sidebar-section-label">
        <span className="label-text" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>I. Modules</span>
      </div>

      <nav className="sidebar-nav">
        {navItems.map(({ to, icon: Icon, label, end, num, feature }) => {
          const locked = feature ? !canUseFeature(plan, feature) : false;
          return (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
            >
              {({ isActive }) => (
                <>
                  <span className="sidebar-link-num">{num}</span>
                  <Icon size={16} color={isActive ? "var(--primary)" : "currentColor"} />
                  <span className="sidebar-link-label">{label}</span>
                  {locked && <Lock size={12} color="var(--text-muted)" className="sidebar-link-lock" style={{ opacity: 0.7 }} />}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        v{APP_VERSION}
      </div>
    </div>
  );
}
