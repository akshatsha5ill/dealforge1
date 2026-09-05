import { useState, useEffect } from 'react';
import { db } from '../../services/local-db/db';
import { VirtuosoGrid } from 'react-virtuoso';
import { Lead } from '../../types';
import { scoreLead } from '../../services/ai/ai-service';
import { useStore } from '../../store';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from '../../components/common/Toast';
import { trackEvent } from '../../services/usage-analytics';
import { apiClient } from '../../services/api/client';

const stages = ['Lead Identified', 'Discovery', 'Demo', 'Proposal', 'Negotiation', 'Closed Won', 'Closed Lost'];

const normalizeStage = (s: string | undefined | null) => (s ?? '').toLowerCase().replace(/[\s-]+/g, '_');

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingRescore, setLoadingRescore] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [scoringId, setScoringId] = useState<string | null>(null);
  const { openAiKey, anthropicKey, geminiKey, setError } = useStore();

  useEffect(() => {
    const fetchLeads = async () => {
      try {
        const data = await db.leads.toArray();
        setLeads(data);
      } catch (err) {
        console.error('Failed to load leads:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchLeads();
  }, []);

  const filtered = leads.filter((l) => {
    const matchesStage = filter === 'all' || normalizeStage(l.stage) === normalizeStage(filter);
    const matchesSearch = l.name?.toLowerCase().includes(search.toLowerCase()) || l.company?.toLowerCase().includes(search.toLowerCase()) || l.email?.toLowerCase().includes(search.toLowerCase());
    return matchesStage && matchesSearch;
  });

  const handleRescore = async (lead: Lead) => {
    setLoadingRescore(prev => ({ ...prev, [lead.id]: true }));
    try {
      const transcript = await db.transcripts.where('meetingId').equals(lead.meetingId).first();
      if (!transcript) {
        toast.info('No transcript found for this lead.');
        return;
      }
      
      const apiKey = geminiKey || openAiKey || anthropicKey;
      if (!apiKey) {
        toast.info('Please set an API key in Settings before rescoring.');
        return;
      }
      const model = geminiKey ? 'gemini' : openAiKey ? 'openai' : 'anthropic';
      
      const data = await apiClient.post<{ score: { score: number; reasoning?: string } }>('/ai/score', {
        transcript: (transcript as any).fullText || (transcript as any).content || '',
        leadContext: {
          name: lead.name,
          company: lead.company,
          role: lead.role,
          stage: lead.stage
        },
        model,
        apiKey
      });
      
      if (data.score && data.score.score != null) {
        const newScore = data.score.score;
        trackEvent('lead_rescored');
        await db.leads.update(lead.id, { score: newScore });
        setLeads(prev => prev.map(l => l.id === lead.id ? { ...l, score: newScore } : l));
      }
    } catch (err) {
      console.error('Failed to rescore lead:', err);
      toast.error('Failed to rescore lead.');
    } finally {
      setLoadingRescore(prev => ({ ...prev, [lead.id]: false }));
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return 'var(--success)';
    if (score >= 50) return 'var(--warning)';
    return 'var(--danger)';
  };

  const handleScoreLead = async (lead: Lead) => {
    const apiKey = geminiKey || openAiKey || anthropicKey;
    const model = geminiKey ? 'gemini' : openAiKey ? 'openai' : 'anthropic';

    if (!apiKey) {
      setError('Please configure an AI API key in Settings to score leads.');
      return;
    }

    try {
      setScoringId(lead.id);
      
      const transcriptData = await db.transcripts.where('meetingId').equals(lead.meetingId).first();
      if (!transcriptData || !transcriptData.fullText) {
        throw new Error('No transcript found for this lead.');
      }

      const res = await scoreLead(
        transcriptData.fullText,
        { name: lead.name, company: lead.company, role: lead.role, email: lead.email },
        apiKey,
        model
      );

      const scoreResult = res;
      const updatedLead = { ...lead, score: scoreResult.score, reasoning: scoreResult.reasoning };
      
      await db.leads.put(updatedLead);
      setLeads(leads.map(l => l.id === lead.id ? updatedLead : l));
    } catch (err: any) {
      setError(err.message || 'Failed to score lead.');
    } finally {
      setScoringId(null);
    }
  };

  return (
    <div className="animate-fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ fontSize: '28px', fontWeight: 700, marginBottom: '4px' }}>Leads</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>{leads.length} total leads</p>
        </div>
        <input
          type="text"
          placeholder="Search by name, company, email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ padding: '10px 14px', backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--text-primary)', fontSize: '14px', width: '280px' }}
        />
      </div>

      {/* Stage Filter Tabs */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <button onClick={() => setFilter('all')} style={{ padding: '6px 14px', borderRadius: '20px', border: '1px solid var(--border)', backgroundColor: filter === 'all' ? 'var(--accent-primary)' : 'var(--bg-secondary)', color: filter === 'all' ? 'var(--bg-primary)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: '13px', fontWeight: 500, transition: 'all 0.2s' }}>
          All ({leads.length})
        </button>
        {stages.map((s) => {
          const count = leads.filter((l) => normalizeStage(l.stage) === normalizeStage(s)).length;
          return (
            <button key={s} onClick={() => setFilter(s)} style={{ padding: '6px 14px', borderRadius: '20px', border: '1px solid var(--border)', backgroundColor: filter === s ? 'var(--accent-primary)' : 'var(--bg-secondary)', color: filter === s ? 'var(--bg-primary)' : 'var(--text-secondary)', cursor: 'pointer', fontSize: '13px', fontWeight: 500, transition: 'all 0.2s' }}>
              {s} ({count})
            </button>
          );
        })}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
          <p style={{ fontSize: '16px', marginBottom: '8px' }}>{search || filter !== 'all' ? 'No leads match your filters' : 'No leads yet'}</p>
          <p style={{ fontSize: '13px' }}>{search || filter !== 'all' ? 'Try adjusting your search or filters' : 'Leads are auto-created from meeting participants.'}</p>
        </div>
      ) : (
        <VirtuosoGrid
          style={{ height: '70vh' }}
          data={filtered}
          listClassName="leads-grid"
          itemContent={(index, lead) => (
            <div key={lead.id} className="ds-panel stat-card" style={{ padding: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                <div>
                  <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '4px' }}>{lead.name}</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{lead.role} at {lead.company}</p>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  <div style={{ width: '44px', height: '44px', borderRadius: '50%', border: `2px solid ${getScoreColor(lead.score)}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span className="data-text" style={{ fontSize: '14px', fontWeight: 700, color: getScoreColor(lead.score) }}>{lead.score}</span>
                  </div>
                  <button 
                    onClick={() => handleRescore(lead)}
                    disabled={loadingRescore[lead.id]}
                    style={{ background: 'none', border: 'none', cursor: loadingRescore[lead.id] ? 'not-allowed' : 'pointer', color: 'var(--text-muted)', padding: '4px' }}
                    title="Re-score lead with AI"
                  >
                    <RefreshCw size={14} style={{ animation: loadingRescore[lead.id] ? 'spin 1s linear infinite' : 'none' }} />
                  </button>
                  <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                </div>
              </div>
              <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>{lead.email}</p>
              
              {lead.reasoning && (
                <div style={{ padding: '10px', backgroundColor: 'var(--bg-primary)', borderRadius: '8px', fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '12px', fontStyle: 'italic', borderLeft: `2px solid ${getScoreColor(lead.score)}` }}>
                  "{lead.reasoning}"
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ padding: '4px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 500, backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>{lead.stage}</span>
                
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button
                    onClick={() => handleScoreLead(lead)}
                    disabled={scoringId === lead.id}
                    style={{ background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)', padding: '4px 10px', borderRadius: '12px', fontSize: '12px', cursor: scoringId === lead.id ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                  >
                    {scoringId === lead.id ? <Loader2 size={12} className="animate-spin" /> : '✨ AI Score'}
                  </button>
                  <span className="data-text" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{lead.createdAt ? new Date(lead.createdAt).toLocaleDateString() : '—'}</span>
                </div>
              </div>
            </div>
          )}
        />
      )}
    </div>
  );
}
