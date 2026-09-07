import React, { useEffect } from 'react';
import { Send, Sparkles, FileText, Plus, Trash2 } from 'lucide-react';
import { RichTextEditor } from '../common/RichTextEditor';
import { Lead, EmailSequenceStep } from '../../types';
import { IntegrationInfo } from '../../services/email-integration';
import { useStore } from '../../store';
import { leadsDB } from '../../services/local-db/leads';
import './Email.css';

interface EmailForm {
  leadId: string;
  subject: string;
  body: string;
  type: string;
  sequence?: EmailSequenceStep[];
}

type SendVia = 'resend' | 'gmail' | 'outlook';

interface ComposeEmailProps {
  form: EmailForm;
  setForm: React.Dispatch<React.SetStateAction<EmailForm>>;
  leads: Lead[];
  getLeadName: (id: string) => string;
  getLeadEmail: (id: string) => string;
  getLeadCompany: (id: string) => string;
  openAiKey: string | null;
  aiLoading: boolean;
  sendLoading: boolean;
  handleAiDraft: () => void;
  handleSaveDraft: () => void;
  handleSend: () => void;
  via: SendVia;
  setVia: (via: SendVia) => void;
  integrations: IntegrationInfo[];
}

export const ComposeEmailCard: React.FC<ComposeEmailProps> = ({
  form,
  setForm,
  leads,
  getLeadName,
  getLeadEmail,
  getLeadCompany,
  openAiKey,
  aiLoading,
  sendLoading,
  handleAiDraft,
  handleSaveDraft,
  handleSend,
  via,
  setVia,
  integrations,
}) => {
  useEffect(() => {
    if (form.type === 'drip_campaign' && (!form.sequence || form.sequence.length === 0)) {
      setForm((prev) => ({
        ...prev,
        sequence: [{ delayDays: 1, subject: '', body: '' }]
      }));
    }
  }, [form.type, form.sequence, setForm]);

  const connectedProviders = integrations.filter((i) => i.connected).map((i) => i.provider);
  const isDrip = form.type === 'drip_campaign';
  const selectedLead = leads.find((l) => l.id === form.leadId);
  const isOptedIn = (selectedLead?.consentStatus || '').trim().toLowerCase() === 'opted_in';
  const anthropicKey = useStore((s) => s.anthropicKey);
  const geminiKey = useStore((s) => s.geminiKey);
  const hasAiKey = !!(openAiKey || anthropicKey || geminiKey);

  const addSequenceStep = () => {
    setForm((prev) => ({
      ...prev,
      sequence: [...(prev.sequence || []), { delayDays: 1, subject: '', body: '' }]
    }));
  };

  const removeSequenceStep = (index: number) => {
    setForm((prev) => {
      const newSeq = [...(prev.sequence || [])];
      newSeq.splice(index, 1);
      return { ...prev, sequence: newSeq };
    });
  };

  const updateSequenceStep = (index: number, field: keyof EmailSequenceStep, value: string | number) => {
    setForm((prev) => {
      const newSeq = [...(prev.sequence || [])];
      newSeq[index] = { ...newSeq[index], [field]: value };
      return { ...prev, sequence: newSeq };
    });
  };

  return (
    <div className="ds-panel compose-card">
      <div className="compose-header">
        <h2 className="compose-title">Compose Email</h2>
        {hasAiKey && (
          <button
            onClick={handleAiDraft}
            disabled={!form.leadId || aiLoading}
            className="btn-secondary"
            style={{ opacity: form.leadId && !aiLoading ? 1 : 0.5 }}
          >
            <Sparkles size={14} />
            {aiLoading ? 'Generating...' : 'AI Draft'}
          </button>
        )}
      </div>

      <div className="form-grid">
        <div>
          <label className="form-label">Lead</label>
          <select
            value={form.leadId}
            onChange={(e) => setForm((prev) => ({ ...prev, leadId: e.target.value }))}
            className="input-style"
            style={{ cursor: 'pointer', appearance: 'none' }}
          >
            <option value="">Select a lead...</option>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} — {l.company || l.email}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="form-label">Type</label>
          <select
            value={form.type}
            onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}
            className="input-style"
            style={{ cursor: 'pointer', appearance: 'none' }}
          >
            <option value="follow_up">Follow Up</option>
            <option value="cold_outreach">Cold Outreach</option>
            <option value="proposal">Proposal</option>
            <option value="thank_you">Thank You</option>
            <option value="check_in">Check In</option>
            <option value="drip_campaign">Automated Drip Campaign</option>
          </select>
        </div>
        {!isDrip && (
          <div>
            <label className="form-label">Send Via</label>
            <select
              value={via}
              onChange={(e) => setVia(e.target.value as SendVia)}
              className="input-style"
              style={{ cursor: 'pointer', appearance: 'none' }}
            >
              <option value="resend">Resend API Key</option>
              {connectedProviders.includes('gmail') && <option value="gmail">Gmail</option>}
              {connectedProviders.includes('outlook') && <option value="outlook">Outlook</option>}
            </select>
          </div>
        )}
      </div>

      {form.leadId && (
        <div className="lead-info-bar">
          <span className="lead-info-name">{getLeadName(form.leadId)}</span>
          <span className="lead-info-dot">·</span>
          <span>{getLeadEmail(form.leadId)}</span>
          <span className="lead-info-dot">·</span>
          <span>{getLeadCompany(form.leadId)}</span>
        </div>
      )}

      {form.leadId && (
        <label className="consent-check" style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', marginBottom: '16px', fontSize: '13px' }}>
          <input
            type="checkbox"
            checked={isOptedIn}
            onChange={(e) => {
              const next = e.target.checked ? 'opted_in' : 'opted_out';
              if (form.leadId) {
                void leadsDB.setConsentStatus(form.leadId, next, { source: 'compose-card' }).catch(() => {});
                // Optimistic local update so the gate state is visible immediately.
                const lead = leads.find((l) => l.id === form.leadId);
                if (lead) lead.consentStatus = next;
              }
            }}
            style={{ marginTop: '2px' }}
          />
          <span>
            This recipient has opted in to marketing email.
            {isDrip && !isOptedIn && ' Drip campaigns require opt-in and will not send until checked.'}
          </span>
        </label>
      )}

      {form.type !== 'drip_campaign' && (
        <>
          <div className="form-group">
            <label className="form-label">Subject</label>
            <input
              type="text"
              value={form.subject}
              onChange={(e) => setForm((prev) => ({ ...prev, subject: e.target.value }))}
              placeholder="Email subject line..."
              className="input-style"
            />
          </div>
          <div style={{ marginBottom: '20px' }}>
            <label className="form-label">Body</label>
            <RichTextEditor
              value={form.body}
              onChange={(val) => setForm((prev) => ({ ...prev, body: val }))}
              placeholder="Write your email content..."
            />
          </div>
        </>
      )}

      {form.type === 'drip_campaign' && (
        <div style={{ marginBottom: '20px' }}>
          <div className="form-group">
            <label className="form-label">Campaign Name</label>
            <input
              type="text"
              value={form.subject}
              onChange={(e) => setForm((prev) => ({ ...prev, subject: e.target.value }))}
              placeholder="e.g. Q3 Outreach Sequence"
              className="input-style"
            />
          </div>
          <h3 className="form-label" style={{ marginTop: '24px', marginBottom: '12px' }}>Email Sequence</h3>
          {(form.sequence || []).map((step, idx) => (
            <div key={idx} className="sequence-step-card">
              <div className="sequence-header">
                <span className="sequence-title">Step {idx + 1}</span>
                <button 
                  onClick={() => removeSequenceStep(idx)}
                  className="btn-secondary"
                  style={{ padding: '4px 8px', color: 'var(--danger)', borderColor: 'var(--danger)', opacity: 0.8 }}
                >
                  <Trash2 size={12} /> Remove
                </button>
              </div>
              <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', alignItems: 'center' }}>
                <label className="form-label" style={{ margin: 0 }}>Delay (Days):</label>
                <input 
                  type="number"
                  min="0"
                  value={step.delayDays}
                  onChange={(e) => updateSequenceStep(idx, 'delayDays', parseInt(e.target.value) || 0)}
                  className="input-style"
                  style={{ width: '80px', padding: '6px 10px' }}
                />
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Days after previous step</span>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <input
                  type="text"
                  value={step.subject}
                  onChange={(e) => updateSequenceStep(idx, 'subject', e.target.value)}
                  placeholder="Subject line..."
                  className="input-style"
                />
              </div>
              <div>
                <RichTextEditor
                  value={step.body}
                  onChange={(val) => updateSequenceStep(idx, 'body', val)}
                  placeholder="Email body..."
                />
              </div>
            </div>
          ))}
          <button onClick={addSequenceStep} className="btn-secondary" style={{ width: '100%', justifyContent: 'center', marginTop: '8px' }}>
            <Plus size={16} /> Add Step
          </button>
        </div>
      )}

      <div className="compose-footer">
        <button
          onClick={handleSaveDraft}
          disabled={!form.leadId || !form.subject}
          className="btn-secondary"
          style={{ opacity: form.leadId && form.subject ? 1 : 0.5 }}
        >
          <FileText size={14} />
          Save Draft
        </button>
        <button
          onClick={handleSend}
          disabled={!form.leadId || !form.subject || (form.type !== 'drip_campaign' && !form.body) || sendLoading}
          className="btn-primary"
          style={{
            opacity: form.leadId && form.subject && (form.type === 'drip_campaign' || form.body) && !sendLoading ? 1 : 0.5,
          }}
        >
          <Send size={14} />
          {sendLoading ? 'Sending...' : form.type === 'drip_campaign' ? 'Start Campaign' : 'Send Now'}
        </button>
      </div>
    </div>
  );
};
