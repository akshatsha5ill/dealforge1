import { useState, useEffect, useCallback, useMemo } from 'react';
import { Send, Mail, Clock, CheckCircle, FileText, Plus, X, Search, RefreshCw, Lock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { db } from '../../services/local-db/db';
import { useStore } from '../../store';
import { apiClient } from '../../services/api/client';
import { auth } from '../../services/firebase/config';
import { canUseFeature } from '../../services/feature-gate';
import UpgradePrompt from '../../components/common/UpgradePrompt';
import { ComposeEmailCard } from '../../components/email/ComposeEmailCard';
import { EmailCampaignCard } from '../../components/email/EmailCampaignCard';
import { DripCampaignCard } from '../../components/email/DripCampaignCard';
import { confirm } from '../../components/common/ConfirmDialog';
import { toast } from '../../components/common/Toast';
import { EmailSequenceStep } from '../../types';
import { EmailCampaign, Lead, DripCampaign } from '../../types';
import { getEmailIntegrationStatus, IntegrationInfo } from '../../services/email-integration';
import { trackEvent } from '../../services/usage-analytics';
import '../../components/email/Email.css';

const STATUS_CONFIG: Record<string, any> = {
  draft: { color: 'var(--text-muted)', bg: 'var(--bg-tertiary)', icon: FileText, label: 'Draft' },
  scheduled: { color: 'var(--warning)', bg: 'rgba(245, 158, 11, 0.12)', icon: Clock, label: 'Scheduled' },
  sent: { color: 'var(--success)', bg: 'rgba(34, 197, 94, 0.12)', icon: CheckCircle, label: 'Sent' },
  paused: { color: 'var(--text-secondary)', bg: 'var(--bg-secondary)', icon: Clock, label: 'Paused' },
};

export default function EmailPage() {
  const { openAiKey } = useStore();
  const plan = useStore((state) => state.subscription?.plan);
  const navigate = useNavigate();
  const canEmail = canUseFeature(plan, 'emailOutreach');
  const [campaigns, setCampaigns] = useState<EmailCampaign[]>([]);
  const [dripCampaigns, setDripCampaigns] = useState<DripCampaign[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCompose, setShowCompose] = useState(false);
  const [filterStatus, setFilterStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [sendLoading, setSendLoading] = useState(false);
  const [via, setVia] = useState<'resend' | 'gmail' | 'outlook'>('resend');
  const [integrations, setIntegrations] = useState<IntegrationInfo[]>([]);

  const [form, setForm] = useState<{
    leadId: string;
    subject: string;
    body: string;
    type: string;
    sequence?: EmailSequenceStep[];
  }>({
    leadId: '',
    subject: '',
    body: '',
    type: 'follow_up',
  });

  const [stats, setStats] = useState({ total: 0, sent: 0, draft: 0, scheduled: 0, opened: 0, replied: 0 });

  const loadData = useCallback(async () => {
    try {

      const [campaignData, dripData, leadData, trackingData] = await Promise.all([
        db.email_campaigns.toArray(),
        db.drip_campaigns.toArray(),
        db.leads.toArray(),
        db.email_tracking.toArray(),
      ]);

      setDripCampaigns(dripData.sort((a, b) => b.createdAt - a.createdAt));

      setCampaigns(campaignData.sort((a, b) => {
        const da = a.sentAt || a.scheduledAt || a.createdAt || 0;
        const db2 = b.sentAt || b.scheduledAt || b.createdAt || 0;
        return (new Date(db2).getTime()) - (new Date(da).getTime());
      }));
      setLeads(leadData);

      const sentCount = campaignData.filter(c => c.status === 'sent').length;
      const draftCount = campaignData.filter(c => c.status === 'draft').length;
      const scheduledCount = campaignData.filter(c => c.status === 'scheduled').length;

      let opened = 0;
      let replied = 0;
      for (const t of trackingData) {
        if (t.opens > 0) opened++;
        if (t.replied > 0) replied++;
      }

      setStats({
        total: campaignData.length,
        sent: sentCount,
        draft: draftCount,
        scheduled: scheduledCount,
        opened,
        replied,
      });
    } catch (err) {
      console.error('Failed to load email data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const syncTrackingEvents = useCallback(async () => {
    try {
      if (!auth.currentUser) return;
      const res = await apiClient.get<{ status: string; events: Array<{ campaignId: string; event: string; timestamp?: string }> }>('/tracking/events');
      if (res && res.status === 'success' && res.events && res.events.length > 0) {
        let hasUpdates = false;
        for (const event of res.events) {
          const trackingData = await db.email_tracking.where('campaignId').equals(event.campaignId).first();
          if (trackingData) {
            if (event.event === 'open') trackingData.opens += 1;
            if (event.event === 'click') trackingData.clicks += 1;
            if (event.event === 'reply' || event.event === 'replied') trackingData.replied += 1;
            trackingData.lastActivity = event.timestamp || new Date().toISOString();
            await db.email_tracking.put(trackingData);
            hasUpdates = true;
          }
        }
        if (hasUpdates) {
          loadData();
        }
      }
    } catch (err) {
      console.error('Failed to sync tracking events:', err);
    }
  }, [loadData]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    let active = true;
    getEmailIntegrationStatus()
      .then((res) => {
        if (active) setIntegrations(res.integrations);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    syncTrackingEvents();
    const interval = setInterval(syncTrackingEvents, 30000);
    return () => clearInterval(interval);
  }, [syncTrackingEvents]);

  const leadMap = useMemo(() => {
    const map = new Map();
    for (const l of leads) {
      map.set(l.id, l);
    }
    return map;
  }, [leads]);

  const getLeadName = (leadId: string) => {
    const lead = leadMap.get(leadId);
    return lead ? lead.name : 'Unknown Lead';
  };

  const getLeadEmail = (leadId: string) => {
    const lead = leadMap.get(leadId);
    return lead ? lead.email : '';
  };

  const getLeadCompany = (leadId: string) => {
    const lead = leadMap.get(leadId);
    return lead ? lead.company : '';
  };

  const filteredCampaigns = campaigns.filter(c => {
    const matchesStatus = filterStatus === 'all' || c.status === filterStatus;
    const leadName = getLeadName(c.leadId).toLowerCase();
    const subject = (c.subject || '').toLowerCase();
    const matchesSearch = leadName.includes(search.toLowerCase()) || subject.includes(search.toLowerCase());
    return matchesStatus && matchesSearch;
  });

  const handleAiDraft = async () => {
    if (!canEmail || !form.leadId) return;
    setAiLoading(true);
    try {
      trackEvent('email_drafted');
      const lead = leads.find(l => l.id === form.leadId);
      let transcriptContext = '';
      try {
        const transcript = lead?.meetingId
          ? await db.transcripts.where('meetingId').equals(lead.meetingId).first()
          : undefined;
        transcriptContext = transcript?.fullText || '';
      } catch (err) {
        console.error("Failed to load transcript context for AI draft", err);
        useStore.getState().setError("Failed to load transcript context for AI. Drafting with limited context.");
      }

      const data = await apiClient.post<{ subject?: string; body?: string; content?: string }>('/email/draft', {
        leadContext: {
          name: lead?.name,
          email: lead?.email,
          company: lead?.company,
          role: lead?.role,
          score: lead?.score,
        },
        transcript: transcriptContext.slice(0, 4000),
        previousEmails: campaigns
          .filter(c => c.leadId === form.leadId)
          .map(c => ({ subject: c.subject, body: c.body, sentAt: c.sentAt })),
        apiKey: openAiKey,
      });

      setForm(prev => ({
        ...prev,
        subject: data.subject || prev.subject,
        body: data.body || data.content || prev.body,
      }));
    } catch (err) {
      console.error('AI draft failed:', err);
      toast.error('Failed to generate AI draft. Please try again.');
    } finally {
      setAiLoading(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!canEmail || !form.leadId || !form.subject) return;
    const campaign = {
      id: crypto.randomUUID(),
      leadId: form.leadId,
      subject: form.subject,
      body: form.body,
      status: 'draft' as const,
      type: form.type,
      sequence: [] as EmailSequenceStep[],
      scheduledAt: '',
      createdAt: Date.now(),
    };
    await db.email_campaigns.put(campaign);
    setForm({ leadId: '', subject: '', body: '', type: 'follow_up', sequence: [] });
    setShowCompose(false);
    loadData();
  };

  const handleSend = async () => {
    if (!canEmail || !form.leadId || !form.subject) return;
    setSendLoading(true);
    try {
      const lead = leads.find(l => l.id === form.leadId);
      
      if (form.type === 'drip_campaign') {
        // Fail-closed at creation time (worker also gates): never start an
        // auto-drip without explicit opt-in.
        const consent = String((lead as unknown as Record<string, unknown>)?.consentStatus || '').trim().toLowerCase();
        if (consent !== 'opted_in') {
          toast.error('This lead has not opted in. Check the opt-in box before starting a drip campaign.');
          return;
        }
        const campaign = {
          id: crypto.randomUUID(),
          leadId: form.leadId,
          name: form.subject,
          status: 'active',
          currentStep: 0,
          sequence: form.sequence,
          nextRunAt: Date.now(),
          createdAt: Date.now(),
        };
        await db.drip_campaigns.put(campaign);
      } else {
        if (!form.body) return;
        const campaignId = crypto.randomUUID();
        await apiClient.post('/email/send', {
          to: lead?.email,
          subject: form.subject,
          body: form.body,
          leadId: form.leadId,
          campaignId,
          emailApiKey: useStore.getState().resendKey,
          via,
        });

        const campaign = {
          id: campaignId,
          leadId: form.leadId,
          subject: form.subject,
          body: form.body,
          status: 'sent' as const,
          type: form.type,
          sequence: [] as EmailSequenceStep[],
          scheduledAt: '',
          sentAt: new Date().toISOString(),
          createdAt: Date.now(),
        };
        await db.email_campaigns.put(campaign);

        await db.email_tracking.put({
          id: crypto.randomUUID(),
          campaignId: campaign.id,
          opens: 0,
          clicks: 0,
          replied: 0,
          lastActivity: null,
        });
      }

      setForm({ leadId: '', subject: '', body: '', type: 'follow_up', sequence: [] });
      setShowCompose(false);
      trackEvent('email_sent');
      loadData();
    } catch (err) {
      console.error('Send failed:', err);
      toast.error('Failed to send email. Draft kept open.');
    } finally {
      setSendLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    const confirmed = await confirm('Delete Campaign', 'Are you sure you want to delete this email campaign? This cannot be undone.');
    if (!confirmed) return;
    await db.email_campaigns.delete(id);
    loadData();
  };

  const handleToggleDripStatus = async (id: string, currentStatus: string) => {
    try {
      const newStatus = currentStatus === 'active' ? 'paused' : 'active';
      if (newStatus === 'active') {
        await db.drip_campaigns.update(id, { status: newStatus, nextRunAt: Date.now(), error: '' });
      } else {
        await db.drip_campaigns.update(id, { status: newStatus });
      }
      loadData();
    } catch (err) {
      console.error('Failed to toggle drip status:', err);
    }
  };

  const handleDeleteDrip = async (id: string) => {
    const confirmed = await confirm('Delete Drip Campaign', 'Are you sure you want to delete this drip campaign? This cannot be undone.');
    if (!confirmed) return;
    try {
      await db.drip_campaigns.delete(id);
      loadData();
    } catch (err) {
      console.error('Failed to delete drip:', err);
    }
  };

  const handleSendDraft = async (campaign: any) => {
    if (!canEmail) return;
    const lead = leads.find(l => l.id === campaign.leadId);
    if (!lead) return;
    try {
      // Tracking (open pixel + click wrap) is injected server-side in
      // routes/email.ts using canonical TRACKING_BASE_URL + signed uid.
      // Do not inject here to avoid double pixel, wrong host, raw uid leak.
      await apiClient.post('/email/send', {
        to: lead.email,
        subject: campaign.subject,
        body: campaign.body,
        leadId: campaign.leadId,
        campaignId: campaign.id,
        emailApiKey: useStore.getState().resendKey,
        via,
      });

      await db.email_campaigns.put({
        ...campaign,
        status: 'sent',
        sentAt: Date.now(),
      });

      await db.email_tracking.put({
        id: crypto.randomUUID(),
        campaignId: campaign.id,
        opens: 0,
        clicks: 0,
        replied: 0,
        lastActivity: null,
      });

      loadData();
    } catch (err) {
      console.error('Send draft failed:', err);
      toast.error('Failed to send draft. Draft kept open.');
    }
  };

  const statCards = [
    { label: 'Total Campaigns', value: stats.total, icon: Mail, color: 'var(--accent-primary)' },
    { label: 'Emails Sent', value: stats.sent, icon: Send, color: 'var(--success)' },
    { label: 'Drafts', value: stats.draft, icon: FileText, color: 'var(--text-muted)' },
    { label: 'Scheduled', value: stats.scheduled, icon: Clock, color: 'var(--warning)' },
  ];

  if (loading) {
    return (
      <div className="animate-fade-in" style={{ textAlign: 'center', padding: '80px 20px', color: 'var(--text-muted)' }}>
        <RefreshCw size={28} style={{ marginBottom: '12px', animation: 'spin 1s linear infinite' }} />
        <p>Loading campaigns...</p>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <div className="email-header">
        <div>
          <h1 className="email-title">Email Outreach</h1>
          <p className="email-subtitle">Manage AI-generated follow-ups and campaigns.</p>
        </div>
        {canEmail ? (
          <button
            onClick={() => setShowCompose(!showCompose)}
            className="btn-primary"
            style={{ opacity: showCompose ? 0.7 : 1 }}
          >
            {showCompose ? <><X size={16} /> Close</> : <><Plus size={16} /> Compose</>}
          </button>
        ) : (
          <button
            onClick={() => navigate('/dashboard/billing')}
            className="btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            <Lock size={16} /> Unlock with Pro
          </button>
        )}
      </div>

      {!canEmail && (
        <div style={{ marginBottom: '20px' }}>
          <UpgradePrompt
            feature="emailOutreach"
            description="Send AI-drafted follow-ups, drip campaigns, and track opens and replies — all from your own inbox. Available on Pro."
          />
        </div>
      )}

      <div className="stat-grid">
        {statCards.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="ds-panel stat-card" style={{ padding: '20px' }}>
            <div className="stat-card-inner">
              <span className="stat-label">{label}</span>
              <div className="stat-icon-wrapper" style={{ backgroundColor: `${color}15` }}>
                <Icon size={18} style={{ color }} />
              </div>
            </div>
            <div className="stat-value">{value}</div>
          </div>
        ))}
      </div>

      {stats.sent > 0 && (
        <div className="metrics-row">
          <div className="ds-panel" style={{ padding: '20px' }}>
            <div className="metric-header">
              <div className="metric-icon" style={{ backgroundColor: 'rgba(34, 197, 94, 0.12)' }}>
                <Mail size={16} style={{ color: 'var(--success)' }} />
              </div>
              <span className="stat-label">Opened</span>
            </div>
            <div className="metric-value">{stats.opened || 0}</div>
            <p className="metric-sub">
              {stats.sent > 0 ? Math.round(((stats.opened || 0) / stats.sent) * 100) : 0}% open rate
            </p>
          </div>
          <div className="ds-panel" style={{ padding: '20px' }}>
            <div className="metric-header">
              <div className="metric-icon" style={{ backgroundColor: 'rgba(99, 102, 241, 0.12)' }}>
                <Send size={16} style={{ color: 'var(--accent-primary)' }} />
              </div>
              <span className="stat-label">Replied</span>
            </div>
            <div className="metric-value">{stats.replied || 0}</div>
            <p className="metric-sub">
              {stats.sent > 0 ? Math.round(((stats.replied || 0) / stats.sent) * 100) : 0}% reply rate
            </p>
          </div>
        </div>
      )}

      {showCompose && (
        <ComposeEmailCard
          form={form}
          setForm={setForm}
          leads={leads}
          getLeadName={getLeadName}
          getLeadEmail={getLeadEmail}
          getLeadCompany={getLeadCompany}
          openAiKey={openAiKey}
          aiLoading={aiLoading}
          sendLoading={sendLoading}
          handleAiDraft={handleAiDraft}
          handleSaveDraft={handleSaveDraft}
          handleSend={handleSend}
          via={via}
          setVia={setVia}
          integrations={integrations}
        />
      )}

      <div className="filters-row">
        <div className="filter-btn-group">
          {['all', 'draft', 'scheduled', 'sent', 'drips'].map(s => {
            let count = 0;
            if (s === 'all') count = campaigns.length;
            else if (s === 'drips') count = dripCampaigns.length;
            else count = campaigns.filter(c => c.status === s).length;
            
            return (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={`filter-btn ${filterStatus === s ? 'active' : 'inactive'}`}
              >
                {s === 'all' ? 'All' : s === 'drips' ? 'Drip Campaigns' : s} ({count})
              </button>
            );
          })}
        </div>
        <div className="search-wrapper">
          <Search size={14} className="search-icon" />
          <input
            type="text"
            placeholder="Search campaigns..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="search-input"
          />
        </div>
      </div>

      {filterStatus === 'drips' ? (
        dripCampaigns.length === 0 ? (
          <div className="ds-panel empty-state">
            <Clock size={40} style={{ marginBottom: '12px', opacity: 0.3 }} />
            <p style={{ fontSize: '16px', marginBottom: '4px' }}>No drip campaigns yet</p>
            <p style={{ fontSize: '13px' }}>Click "Compose" and select "Automated Drip Campaign".</p>
          </div>
        ) : (
          <div className="campaign-list" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '20px' }}>
            {dripCampaigns.filter(c => {
               const leadName = getLeadName(c.leadId).toLowerCase();
               const name = (c.name || '').toLowerCase();
               return leadName.includes(search.toLowerCase()) || name.includes(search.toLowerCase());
            }).map(campaign => (
              <DripCampaignCard
                key={campaign.id}
                campaign={campaign}
                getLeadName={getLeadName}
                handleToggleStatus={handleToggleDripStatus}
                handleDelete={handleDeleteDrip}
              />
            ))}
          </div>
        )
      ) : filteredCampaigns.length === 0 ? (
        <div className="ds-panel empty-state">
          <Mail size={40} style={{ marginBottom: '12px', opacity: 0.3 }} />
          <p style={{ fontSize: '16px', marginBottom: '4px' }}>
            {campaigns.length === 0 ? 'No campaigns yet' : 'No campaigns match your filters'}
          </p>
          <p style={{ fontSize: '13px' }}>
            {campaigns.length === 0 ? 'Click "Compose" to create your first email campaign.' : 'Try adjusting your search or filters.'}
          </p>
        </div>
      ) : (
        <div className="campaign-list">
          {filteredCampaigns.map(campaign => (
            <EmailCampaignCard
              key={campaign.id}
              campaign={campaign}
              statusConfig={STATUS_CONFIG}
              getLeadName={getLeadName}
              getLeadEmail={getLeadEmail}
              handleSendDraft={handleSendDraft}
              handleDelete={handleDelete}
              handleToggleDripStatus={handleToggleDripStatus}
            />
          ))}
        </div>
      )}
    </div>
  );
}
