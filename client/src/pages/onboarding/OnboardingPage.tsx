import { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Video, KeyRound, Mail, CheckCircle, ArrowRight, SkipForward, Lock } from 'lucide-react';
import { db } from '../../services/local-db/db';
import { useStore } from '../../store';
import { auth } from '../../services/firebase/config';
import { encryptKey, EncryptedKey } from '../../crypto/key-vault';
import { getEmailIntegrationStatus, startEmailOAuth, EmailProvider } from '../../services/email-integration';
import { canUseFeature } from '../../services/feature-gate';

interface ZoomStatus {
  linked: boolean;
  zoomUserId: string | null;
}

export default function OnboardingPage() {
  const navigate = useNavigate();
  const plan = useStore((state) => state.subscription?.plan);
  const setOpenAiKey = useStore((state) => state.setOpenAiKey);
  const [step, setStep] = useState(0);
  const [zoomStatus, setZoomStatus] = useState<ZoomStatus | null>(null);
  const [integrations, setIntegrations] = useState<string[]>([]);
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [password, setPassword] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const canEmail = canUseFeature(plan, 'emailOutreach');

  const loadStatus = useCallback(async () => {
    try {
      const token = await auth.currentUser?.getIdToken();
      const res = await fetch('/api/zoom/oauth/status', {
        headers: { ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
      });
      if (res.ok) {
        const data = await res.json();
        setZoomStatus({ linked: !!data.linked, zoomUserId: data.zoomUserId || null });
      }
    } catch (err) {
      // Zoom status is best-effort here (self-hosted server may be unreachable
      // during onboarding) — visible in devtools, not a blocking error.
      console.warn('Zoom status check failed:', err);
    }

    try {
      const res = await getEmailIntegrationStatus();
      setIntegrations(res.integrations.filter((i) => i.connected).map((i) => i.provider));
    } catch (err) {
      console.warn('Email integration status check failed:', err);
    }

    const stored = await db.settings.get('dealforge_encrypted_keys');
    setHasOpenAiKey(!!stored && !!stored.value && !!(stored.value as Record<string, EncryptedKey>).openAi);
  }, []);

  useEffect(() => {
    loadStatus().finally(() => setLoading(false));
  }, [loadStatus]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('zoom_linked') === 'true' || params.get('oauth_success') === 'true') {
      window.history.replaceState({}, document.title, window.location.pathname);
      loadStatus();
    }
  }, [loadStatus]);

  const connectZoom = async () => {
    setConnecting('zoom');
    setError('');
    try {
      const token = await auth.currentUser?.getIdToken();
      const res = await fetch('/api/zoom/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
        body: JSON.stringify({ redirect: window.location.href }),
      });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error || 'Failed to start Zoom connection');
      }
    } catch {
      setError('Failed to start Zoom connection');
    } finally {
      setConnecting(null);
    }
  };

  const connectEmail = async (provider: EmailProvider) => {
    setConnecting(provider);
    setError('');
    try {
      const { url } = await startEmailOAuth(provider, window.location.href);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start email connection');
      setConnecting(null);
    }
  };

  const saveOpenAiKey = async () => {
    if (!keyInput.trim() || !password) {
      setError('Enter an API key and a password to encrypt it.');
      return;
    }
    setSavingKey(true);
    setError('');
    try {
      const encrypted = await encryptKey(keyInput.trim(), password);
      const existing = await db.settings.get('dealforge_encrypted_keys');
      const existingValue = (existing && existing.value) as Record<string, EncryptedKey> | undefined || {};
      await db.settings.put({ key: 'dealforge_encrypted_keys', value: { ...existingValue, openAi: encrypted } });
      setOpenAiKey(keyInput.trim());
      setHasOpenAiKey(true);
      setKeyInput('');
      setPassword('');
      setStep((s) => s + 1);
    } catch {
      setError('Failed to save API key');
    } finally {
      setSavingKey(false);
    }
  };

  const finish = async () => {
    await db.settings.put({ key: 'onboarding_complete', value: true });
    navigate('/dashboard');
  };

  const steps = [
    { label: 'Connect Zoom', icon: Video },
    { label: 'AI API Key', icon: KeyRound },
    { label: 'Email (Pro)', icon: Mail },
  ];

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--bg-primary)', color: 'var(--text-muted)' }}>
        Loading...
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: 'var(--bg-primary)' }}>
      <header style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-primary)' }}>
        <div style={{ maxWidth: '720px', margin: '0 auto', padding: '18px 24px 14px', display: 'flex', alignItems: 'baseline', gap: '12px' }}>
          <Link to="/" style={{ display: 'flex', alignItems: 'baseline', gap: '12px' }}>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '28px', color: 'var(--primary)', letterSpacing: '-0.06em', lineHeight: 1 }}>D.</span>
            <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: '22px', letterSpacing: '-0.015em' }}>DealForge</span>
          </Link>
          <span style={{ fontStyle: 'italic', fontSize: '13px', color: 'var(--text-muted)', borderLeft: '1px solid var(--border)', paddingLeft: '12px' }}>setup</span>
        </div>
      </header>

      <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '32px 24px' }}>
        <div style={{ maxWidth: '560px', width: '100%' }}>
          <div style={{ display: 'flex', gap: '12px', marginBottom: '32px' }}>
            {steps.map((s, i) => {
              const Icon = s.icon;
              const done = i < step;
              const current = i === step;
              return (
                <div key={s.label} style={{ flex: 1, textAlign: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{
                      width: '34px', height: '34px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      backgroundColor: done ? 'rgba(34, 197, 94, 0.12)' : current ? 'rgba(99, 102, 241, 0.12)' : 'var(--bg-secondary)',
                      border: `1px solid ${done ? 'var(--success)' : current ? 'var(--accent-primary)' : 'var(--border)'}`,
                      color: done ? 'var(--success)' : current ? 'var(--accent-primary)' : 'var(--text-muted)',
                    }}>
                      {done ? <CheckCircle size={16} /> : <Icon size={16} />}
                    </div>
                    <div style={{ flex: 1, height: '1px', backgroundColor: i < steps.length - 1 ? 'var(--border)' : 'transparent' }} />
                  </div>
                  <span style={{ fontSize: '12px', color: done || current ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: current ? 600 : 400 }}>{s.label}</span>
                </div>
              );
            })}
          </div>

          <div className="ds-panel" style={{ padding: '32px' }}>
            {error && (
              <div style={{ padding: '12px 16px', marginBottom: '20px', backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid var(--danger)', borderRadius: '8px', color: 'var(--danger)', fontSize: '13px' }}>
                {error}
              </div>
            )}

            {step === 0 && (
              <div>
                <h1 style={{ fontSize: '22px', fontWeight: 700, marginBottom: '8px' }}>Connect Zoom</h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6, marginBottom: '24px' }}>
                  Link your Zoom account so DealForge can record and transcribe your meetings automatically.
                </p>
                {zoomStatus?.linked ? (
                  <div style={{ padding: '16px', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--success)', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                    <CheckCircle size={20} color="var(--success)" />
                    <div>
                      <strong>Zoom connected</strong>
                      {zoomStatus.zoomUserId && <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>User ID: {zoomStatus.zoomUserId}</p>}
                    </div>
                  </div>
                ) : (
                  <button onClick={connectZoom} disabled={connecting === 'zoom'} className="ds-btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                    <Video size={16} /> {connecting === 'zoom' ? 'Redirecting...' : 'Connect Zoom Account'}
                  </button>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '28px' }}>
                  <button onClick={() => setStep((s) => s + 1)} className="ds-btn-ghost" style={{ color: 'var(--text-muted)' }}>
                    Skip for now
                  </button>
                  <button onClick={() => setStep((s) => s + 1)} className="ds-btn-primary" disabled={!zoomStatus?.linked}>
                    Next <ArrowRight size={16} />
                  </button>
                </div>
              </div>
            )}

            {step === 1 && (
              <div>
                <h1 style={{ fontSize: '22px', fontWeight: 700, marginBottom: '8px' }}>Add your AI API key</h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6, marginBottom: '24px' }}>
                  DealForge uses OpenAI to draft follow-ups, score leads, and analyze meetings. Keys are encrypted locally and never sent to our servers.
                </p>
                {hasOpenAiKey ? (
                  <div style={{ padding: '16px', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--success)', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
                    <CheckCircle size={20} color="var(--success)" />
                    <div>
                      <strong>OpenAI key saved</strong>
                      <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>You can update it anytime in Settings.</p>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <input
                      className="ds-input"
                      type="password"
                      placeholder="OpenAI API Key (sk-...)"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                    />
                    <input
                      className="ds-input"
                      type="password"
                      placeholder="Encryption password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button onClick={saveOpenAiKey} disabled={savingKey} className="ds-btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                      {savingKey ? 'Saving...' : 'Save Key'}
                    </button>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '28px' }}>
                  <button onClick={() => setStep((s) => s - 1)} className="ds-btn-ghost" style={{ color: 'var(--text-muted)' }}>
                    Back
                  </button>
                  <button onClick={() => setStep((s) => s + 1)} className="ds-btn-primary" disabled={!hasOpenAiKey}>
                    Next <ArrowRight size={16} />
                  </button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div>
                <h1 style={{ fontSize: '22px', fontWeight: 700, marginBottom: '8px' }}>Send email from your inbox</h1>
                <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6, marginBottom: '24px' }}>
                  Connect Gmail or Outlook to send AI-drafted follow-ups from your own address.
                </p>
                {!canEmail ? (
                  <div style={{ padding: '16px', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '8px', marginBottom: '24px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                      <Lock size={16} color="var(--warning)" />
                      <strong style={{ fontSize: '14px' }}>Email outreach is a Pro feature</strong>
                    </div>
                    <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                      Upgrade to Pro to send campaigns, track opens and replies, and unlock all AI models.
                    </p>
                    <button onClick={() => navigate('/dashboard/billing')} className="ds-btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                      View Plans
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
                    {(['gmail', 'outlook'] as EmailProvider[]).map((p) => {
                      const connected = integrations.includes(p);
                      return (
                        <div key={p} style={{ padding: '20px', backgroundColor: 'var(--bg-secondary)', border: `1px solid ${connected ? 'var(--success)' : 'var(--border)'}`, borderRadius: '8px', textAlign: 'center' }}>
                          <h3 style={{ fontSize: '15px', fontWeight: 600, marginBottom: '12px', textTransform: 'capitalize' }}>{p}</h3>
                          {connected ? (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', color: 'var(--success)', fontSize: '13px', fontWeight: 500 }}>
                              <CheckCircle size={16} /> Connected
                            </div>
                          ) : (
                            <button onClick={() => connectEmail(p)} disabled={connecting === p} className="ds-btn-ghost" style={{ border: '1px solid var(--border)', width: '100%', justifyContent: 'center' }}>
                              {connecting === p ? 'Redirecting...' : 'Connect'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                <button onClick={finish} className="ds-btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                  Finish <CheckCircle size={16} />
                </button>
              </div>
            )}
          </div>

          <div style={{ textAlign: 'center', marginTop: '20px' }}>
            <button onClick={finish} style={{ fontSize: '13px', color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <SkipForward size={14} /> Skip setup and go to dashboard
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
