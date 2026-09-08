import { useState, useRef, useEffect } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Calendar, Zap, Mail, ChevronDown } from 'lucide-react';
import { useStore } from '../store';
import { loginWithGoogle, loginWithEmail, registerWithEmail } from '../services/firebase/auth';
import { APP_VERSION } from '../version';
import GoogleIcon from '../components/GoogleIcon';

function NavDropdown({ label, items }: { label: string; items: { label: string; to: string }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: '4px',
          fontSize: '14px', color: 'var(--text-secondary)', padding: '6px 0',
          transition: 'color 0.2s',
        }}
        onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
        onMouseLeave={e => e.currentTarget.style.color = 'var(--text-secondary)'}
      >
        {label}
        <ChevronDown size={14} style={{ transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: '50%', transform: 'translateX(-50%)',
          background: 'var(--bg-secondary)', border: '1px solid var(--border)', padding: '8px 0',
          minWidth: '180px', zIndex: 200,
        }}>
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              onClick={() => setOpen(false)}
              style={{
                display: 'block', padding: '10px 20px', fontSize: '14px', color: 'var(--text-secondary)',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--text-primary)'; e.currentTarget.style.background = 'var(--bg-tertiary)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.background = 'transparent'; }}
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function AuthPanel() {
  const navigate = useNavigate();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleGoogleLogin = async () => {
    setError('');
    setLoading(true);
    try {
      await loginWithGoogle();
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Google sign in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleEmailSubmit = async (e: any) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isRegister) {
        await registerWithEmail(email, password);
      } else {
        await loginWithEmail(email, password);
      }
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div style={{ fontSize: '11px', fontVariant: 'small-caps', letterSpacing: '0.12em', color: 'var(--text-muted)', paddingBottom: '14px', borderBottom: '1px solid var(--border)', marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="label-text">{isRegister ? 'Initialize Account' : 'Authenticate'}</span>
        <em style={{ fontFamily: 'var(--font-body)', fontStyle: 'italic', fontSize: '12px', fontVariant: 'normal', letterSpacing: 0, textTransform: 'none' }}>{isRegister ? 'create access' : 'credentials'}</em>
      </div>

      {error && (
        <div style={{ backgroundColor: 'rgba(138, 35, 23, 0.08)', borderLeft: '2px solid var(--primary)', padding: '10px 14px', marginBottom: '16px', color: 'var(--primary)', fontSize: '13px' }}>
          {error}
        </div>
      )}

      <form onSubmit={handleEmailSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <input
          className="ds-input"
          type="email"
          placeholder="Email Address"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="ds-input"
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit" className="ds-btn-primary" style={{ marginTop: '4px', width: '100%', justifyContent: 'center' }} disabled={loading}>
          {loading ? 'Please wait…' : isRegister ? 'Create Account' : 'Sign In'}
        </button>
      </form>

      <div style={{ display: 'flex', alignItems: 'center', margin: '20px 0', gap: '16px' }}>
        <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--border)' }}></div>
        <span className="label-text" style={{ color: 'var(--text-muted)', fontSize: '10px' }}>OR</span>
        <div style={{ flex: 1, height: '1px', backgroundColor: 'var(--border)' }}></div>
      </div>

      <button
        onClick={handleGoogleLogin}
        className="ds-btn-ghost"
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', border: '1px solid var(--border)' }}
        disabled={loading}
      >
        <GoogleIcon /> Sign in with Google
      </button>

      <div style={{ marginTop: '20px', textAlign: 'center' }}>
        <button
          onClick={() => { setIsRegister(!isRegister); setError(''); }}
          className="ds-btn-ghost"
          style={{ fontSize: '13px', borderBottom: 'none' }}
        >
          {isRegister ? 'Already have an account? Sign In' : 'Need an account? Sign Up'}
        </button>
      </div>
    </div>
  );
}

export default function LandingPage() {
  const isAuthenticated = useStore((state) => state.isAuthenticated);
  const isAuthReady = useStore((state) => state.isAuthReady);
  
  if (isAuthReady && isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }
  
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      
      {/* Masthead */}
      <header style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-primary)', position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '0 36px', height: '64px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>

          {/* Logo */}
          <Link to="/" style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexShrink: 0 }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '26px', color: 'var(--primary)', letterSpacing: '-0.06em', lineHeight: 1 }}>D.</span>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '20px', letterSpacing: '-0.015em' }}>DealForge</span>
          </Link>

          {/* Center Nav */}
          <nav style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>
            <a href="#features" style={{ fontSize: '14px', color: 'var(--text-secondary)', transition: 'color 0.2s' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-secondary)'}
            >Features</a>
            <NavDropdown
              label="Product"
              items={[
                { label: 'Pipeline', to: '/login' },
                { label: 'Lead Scoring', to: '/login' },
                { label: 'Email Drips', to: '/login' },
              ]}
            />
            <a href="#features" style={{ fontSize: '14px', color: 'var(--text-secondary)', transition: 'color 0.2s' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-secondary)'}
            >Pricing</a>
            <NavDropdown
              label="Resources"
              items={[
                { label: 'Support', to: '/support' },
                { label: 'Privacy Policy', to: '/privacy' },
                { label: 'Terms of Service', to: '/terms' },
              ]}
            />
          </nav>

          {/* Right Auth */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexShrink: 0 }}>
            <Link to="/login" style={{ fontSize: '14px', color: 'var(--text-secondary)', transition: 'color 0.2s' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--text-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-secondary)'}
            >Sign In</Link>
            <Link to="/login" style={{
              fontSize: '14px', fontWeight: 500, padding: '10px 20px',
              background: 'var(--text-primary)', color: 'var(--bg-primary)',
              transition: 'background 0.2s',
            }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--primary)'}
              onMouseLeave={e => e.currentTarget.style.background = 'var(--text-primary)'}
            >Get Started</Link>
          </div>

        </div>
      </header>

      {/* Hero Section */}
      <section style={{ padding: '72px 0 96px', borderBottom: '1px solid var(--border)', position: 'relative' }}>
        <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '0 36px' }}>
          
          <div style={{ display: 'grid', gridTemplateColumns: '7fr 5fr', gap: '72px' }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingBottom: '16px', borderBottom: '1px solid var(--border)', marginBottom: '28px' }}>
                <span className="label-text" style={{ color: 'var(--primary)' }}>Currently Operating</span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-muted)' }}>v{APP_VERSION} · local-first</span>
              </div>
              
              <h1 className="display-text" style={{ fontSize: 'clamp(46px, 7.4vw, 92px)', lineHeight: 0.94, marginBottom: '32px' }}>
                Turn Your Zoom Meetings<br />
                <em>Into Revenue.</em>
              </h1>
              
              <p style={{ fontSize: '19px', lineHeight: 1.55, maxWidth: '560px', marginBottom: '40px', color: 'var(--text-secondary)' }}>
                The ultimate AI-powered CRM that runs right inside your meetings. Automate lead scoring, pipeline management, and follow-up drip campaigns without ever switching tabs.
              </p>
              
              <div style={{ display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap' }}>
                <Link to="/login" className="ds-btn-primary">
                  Start Operating <span className="arrow">→</span>
                </Link>
                <Link to="#features" className="ds-btn-ghost">
                  View the architecture
                </Link>
              </div>
            </div>
            
            <aside style={{ borderLeft: '1px solid var(--border)', paddingLeft: '36px' }}>
              <AuthPanel />
            </aside>
          </div>
        </div>
      </section>

      {/* Details Section */}
      <section id="features" style={{ padding: '80px 0', borderBottom: '1px solid var(--border)' }}>
        <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '0 36px' }}>
          
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '48px', alignItems: 'end', paddingBottom: '40px', borderBottom: '1px solid var(--border)', marginBottom: '48px' }}>
            <div>
              <div className="label-text" style={{ color: 'var(--primary)', marginBottom: '14px' }}>II. The Machinery</div>
              <h2 className="display-text" style={{ fontSize: 'clamp(28px, 3.4vw, 40px)', lineHeight: 1.08, maxWidth: '720px', fontWeight: 500 }}>
                Data processing, <em>made rigorous.</em>
              </h2>
              <p style={{ fontSize: '16px', color: 'var(--text-secondary)', maxWidth: '560px', marginTop: '14px' }}>
                Every meeting is an asset. DealForge extracts commitments, scores intent, and drafts follow-ups automatically.
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '48px' }}>
             {[
              { icon: <Zap size={24} />, num: 'i.', title: 'AI Lead Scoring', desc: 'Automatically score prospects based on live conversation context and sentiment analysis.' },
              { icon: <Calendar size={24} />, num: 'ii.', title: 'Pipeline Velocity', desc: 'Track your meetings and deal stages visually to close deals faster than ever.' },
              { icon: <Mail size={24} />, num: 'iii.', title: 'Automated Drips', desc: 'Set up hyper-personalized email sequences that follow up for you on autopilot.' }
            ].map((feat, idx) => (
              <div key={idx} className="ds-panel">
                <div className="ds-panel-head">
                  <span className="ds-panel-title">{feat.title}</span>
                  <span className="ds-panel-hint" style={{ fontFamily: 'var(--font-display)', fontSize: '18px', fontStyle: 'italic' }}>{feat.num}</span>
                </div>
                <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                  <div style={{ color: 'var(--primary)' }}>{feat.icon}</div>
                  <p className="ds-panel-body">{feat.desc}</p>
                </div>
              </div>
            ))}
          </div>

        </div>
      </section>

      {/* Footer */}
      <footer style={{ background: 'var(--bg-secondary)', padding: '56px 0 32px' }}>
        <div style={{ maxWidth: '1280px', margin: '0 auto', padding: '0 36px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: '48px', marginBottom: '40px' }}>
            <div>
              <h4 className="label-text" style={{ color: 'var(--primary)', marginBottom: '12px' }}>Colophon</h4>
              <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Set in <em>Fraunces</em> for display, <em>Newsreader</em> for body, and <em>JetBrains Mono</em> for code. Built entirely on client-side storage for maximum privacy and performance.
              </p>
            </div>
            <div>
              <h4 className="label-text" style={{ color: 'var(--primary)', marginBottom: '12px' }}>Product</h4>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>
                <li style={{ padding: '3px 0' }}>Security</li>
                <li style={{ padding: '3px 0' }}>Data Export</li>
              </ul>
            </div>
          </div>
          
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '18px', display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
            <span className="label-text">DealForge · v{APP_VERSION}</span>
            <span style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: '14px', color: 'var(--primary)' }}>— an industrial tool —</span>
            <span className="label-text">© 2026 DealForge</span>
          </div>
        </div>
      </footer>
      
    </div>
  );
}
