import { useState, useEffect, useCallback } from 'react';
import { Key, RefreshCw, Trash2, Copy, Check, Lock, ShieldCheck } from 'lucide-react';
import { useStore } from '../../store';
import { canUseFeature } from '../../services/feature-gate';
import {
  getApiSyncEnabled,
  setApiSyncEnabled,
  getLastSyncedAt,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  syncDerivedData,
  ApiKeySummary,
  NewApiKey,
  SyncResult,
} from '../../services/api-access';
import { toast } from '../common/Toast';
import UpgradePrompt from '../common/UpgradePrompt';

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  padding: '12px',
  backgroundColor: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: '8px',
  marginBottom: '8px',
  flexWrap: 'wrap',
};

export function ApiAccess() {
  const plan = useStore((state) => state.subscription?.plan);
  const canAccess = canUseFeature(plan, 'apiAccess');

  const [syncEnabled, setSyncEnabledState] = useState(false);
  const [syncState, setSyncState] = useState<'idle' | 'syncing' | 'done'>('idle');
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);

  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [newKeyName, setNewKeyName] = useState('');
  const [creatingKey, setCreatingKey] = useState(false);
  const [revokingKey, setRevokingKey] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<NewApiKey | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const refreshKeys = useCallback(async () => {
    const k = await listApiKeys();
    setKeys(k);
  }, []);

  useEffect(() => {
    if (!canAccess) return;
    const load = async () => {
      const [enabled, lastSync] = await Promise.all([getApiSyncEnabled(), getLastSyncedAt()]);
      setSyncEnabledState(enabled);
      setLastSyncedAt(lastSync);
      refreshKeys();
    };
    load();
  }, [canAccess, refreshKeys]);

  if (!canAccess) {
    return (
      <UpgradePrompt
        feature="apiAccess"
        description="Export meeting summaries, action items, and lead scores to your CRM via a read-only API. Transcripts stay on your device."
      />
    );
  }

  const handleToggleSync = async () => {
    const next = !syncEnabled;
    setSyncEnabledState(next);
    await setApiSyncEnabled(next);
    if (next) {
      await handleSync();
    }
  };

  const handleSync = async () => {
    setSyncState('syncing');
    const result = await syncDerivedData();
    setSyncState('done');
    if (result) {
      setLastResult(result);
      setLastSyncedAt(result.syncedAt);
      toast.success('Synced summaries and lead scores to the API.');
    } else {
      toast.error('Sync failed. Please try again.');
    }
    setTimeout(() => setSyncState('idle'), 3000);
  };

  const handleCreateKey = async () => {
    setCreatingKey(true);
    const key = await createApiKey(newKeyName.trim() || 'API key');
    setCreatingKey(false);
    if (key) {
      setNewKey(key);
      setNewKeyName('');
      await refreshKeys();
    } else {
      toast.error('Failed to create API key.');
    }
  };

  const handleRevoke = async (keyHash: string) => {
    setRevokingKey(keyHash);
    const ok = await revokeApiKey(keyHash);
    setRevokingKey(null);
    if (ok) {
      await refreshKeys();
      toast.success('API key revoked.');
    } else {
      toast.error('Failed to revoke API key.');
    }
  };

  const handleCopyKey = async () => {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey.key);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = newKey.key;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
  };

  // Split deploys (app ≠ api origin) override this via VITE_API_URL.
  const apiBase = `${import.meta.env.VITE_API_URL || window.location.origin}/api`;

  return (
    <div className="ds-panel" style={{ padding: '28px', gridColumn: '1 / -1' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <h2 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px', color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Key size={18} /> API Access
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px', lineHeight: 1.5, margin: 0, maxWidth: '560px' }}>
            Pull meeting summaries, action items, and lead scores into your CRM with a read-only API. Your raw transcripts never leave this device.
          </p>
        </div>
      </div>

      {/* Sync section */}
      <div style={rowStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <RefreshCw size={16} style={{ color: 'var(--secondary)' }} />
          <div>
            <div style={{ fontSize: '13px', fontWeight: 600 }}>Sync derived data to the API</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              {syncEnabled
                ? lastSyncedAt
                  ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}`
                  : 'Syncing enabled — run your first sync'
                : 'Send summaries, action items, and lead scores to the server (never transcripts)'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          {syncEnabled && (
            <button
              onClick={handleSync}
              disabled={syncState === 'syncing'}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: '8px', fontWeight: 600, fontSize: '12px', cursor: syncState === 'syncing' ? 'not-allowed' : 'pointer' }}
            >
              <RefreshCw size={13} className={syncState === 'syncing' ? 'spin' : ''} />
              {syncState === 'syncing' ? 'Syncing...' : 'Sync Now'}
            </button>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}>
            <input type="checkbox" checked={syncEnabled} onChange={handleToggleSync} style={{ accentColor: 'var(--secondary)' }} />
            Enable
          </label>
        </div>
      </div>

      {lastResult && (
        <div style={{ marginBottom: '20px', fontSize: '12px', color: 'var(--text-secondary)' }}>
          Synced {lastResult.meetings} meeting{lastResult.meetings !== 1 ? 's' : ''}, {lastResult.analyses} analysis
          {lastResult.analyses !== 1 ? 'es' : ''}, {lastResult.leads} lead{lastResult.leads !== 1 ? 's' : ''}, {lastResult.deals} deal
          {lastResult.deals !== 1 ? 's' : ''}.
        </div>
      )}

      {/* API keys section */}
      <h3 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '10px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <ShieldCheck size={14} /> API Keys
      </h3>

      {newKey && (
        <div style={{ marginBottom: '16px', padding: '14px', backgroundColor: 'rgba(78, 205, 196, 0.1)', border: '1px solid rgba(78, 205, 196, 0.4)', borderRadius: '8px' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>Your new API key — copy it now, it won't be shown again</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <code style={{ padding: '8px 12px', backgroundColor: 'var(--bg-secondary)', borderRadius: '6px', fontSize: '13px', wordBreak: 'break-all' }}>{newKey.key}</code>
            <button
              onClick={handleCopyKey}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', backgroundColor: 'var(--accent-primary)', color: 'var(--bg-primary)', border: 'none', borderRadius: '8px', fontWeight: 600, fontSize: '12px', cursor: 'pointer' }}
            >
              {copiedKey ? <Check size={13} /> : <Copy size={13} />}
              {copiedKey ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <input
          value={newKeyName}
          onChange={(e) => setNewKeyName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreateKey(); }}
          placeholder="Key name (e.g. CRM sync)"
          maxLength={60}
          style={{ flex: 1, minWidth: '180px', padding: '10px 14px', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '13px', color: 'var(--text-primary)' }}
        />
        <button
          onClick={handleCreateKey}
          disabled={creatingKey}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '10px 20px', backgroundColor: 'var(--text-primary)', color: 'var(--bg-primary)', border: 'none', borderRadius: '8px', fontWeight: 600, fontSize: '13px', cursor: creatingKey ? 'not-allowed' : 'pointer', opacity: creatingKey ? 0.6 : 1 }}
        >
          <Key size={14} />
          {creatingKey ? 'Creating...' : 'Create Key'}
        </button>
      </div>

      {keys.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
          No API keys yet. Create one to use the read-only API.
        </div>
      ) : (
        keys.map((k) => (
          <div key={k.keyHash} style={rowStyle}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 600 }}>
                {k.name} {k.revoked && <span style={{ color: 'var(--secondary)', fontSize: '11px', textTransform: 'uppercase' }}>revoked</span>}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{k.prefix}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                Created {new Date(k.createdAt).toLocaleDateString()}
                {k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : ' · never used'}
              </div>
            </div>
            {!k.revoked && (
              <button
                onClick={() => handleRevoke(k.keyHash)}
                disabled={revokingKey === k.keyHash}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 14px', backgroundColor: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontWeight: 600, fontSize: '12px', cursor: 'pointer' }}
              >
                <Trash2 size={13} />
                {revokingKey === k.keyHash ? 'Revoking...' : 'Revoke'}
              </button>
            )}
          </div>
        ))
      )}

      {/* Endpoint reference */}
      <div style={{ paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-secondary)' }}>Endpoints</div>
        <code style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.8, wordBreak: 'break-all' }}>
          {`GET ${apiBase}/v1/meetings`} — meetings with summaries and action items
          {'\n'}
          {`GET ${apiBase}/v1/meetings/:id`} — single meeting
          {'\n'}
          {`GET ${apiBase}/v1/leads`} — leads with scores
          {'\n'}
          {`GET ${apiBase}/v1/deals`} — deals
        </code>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Lock size={12} />
          Authenticate with the <code style={{ fontSize: '11px' }}>x-api-key</code> header. Rate limited to 60 requests/minute. Full docs at <code style={{ fontSize: '11px' }}>{apiBase}/docs</code>.
        </div>
      </div>
    </div>
  );
}
