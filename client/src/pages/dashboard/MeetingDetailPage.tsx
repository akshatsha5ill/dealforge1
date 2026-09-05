import { useParams, Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { db } from '../../services/local-db/db';
import { analyzeMeeting } from '../../services/ai/ai-service';
import { useStore } from '../../store';
import { leadsDB } from '../../services/local-db/leads';
import { getMonthlyAnalyzedCount } from '../../services/usage';
import { canUseFeature, isTranscriptExpired } from '../../services/feature-gate';
import { getEffectiveMeetingLimit, initReferrals } from '../../services/referral';
import UpgradePrompt from '../../components/common/UpgradePrompt';
import { trackEvent } from '../../services/usage-analytics';
import { Meeting, Transcript, Analysis } from '../../types';

export default function MeetingDetailPage() {
  const { id } = useParams();

  const { openAiKey, anthropicKey } = useStore();
  const plan = useStore((state) => state.subscription?.plan);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const [usageExceeded, setUsageExceeded] = useState(false);
  const [modelGated, setModelGated] = useState(false);
  const [monthlyUsed, setMonthlyUsed] = useState(0);

  useEffect(() => {
    if (!id) return;
    const fetchData = async () => {
      try {
        const [meetingData, transcriptData, analysisData, used] = await Promise.all([
          db.meetings.get(id),
          db.transcripts.where('meetingId').equals(id).first(),
          db.ai_analysis.where('meetingId').equals(id).first(),
          getMonthlyAnalyzedCount(),
        ]);
        await initReferrals();
        setMeeting(meetingData || null);
        setTranscript(transcriptData || null);
        setAnalysis(analysisData?.summary ? analysisData : null);
        setMonthlyUsed(used);
      } catch (err) {
        console.error('Failed to load meeting:', err);
      } finally {
        setInitialLoading(false);
      }
    };
    fetchData();
  }, [id]);

  const handleAnalyze = async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    setUsageExceeded(false);
    setModelGated(false);
    try {
      if (!transcript?.fullText?.trim()) {
        setError('No transcript available for this meeting. Analysis requires transcript text.');
        setLoading(false);
        return;
      }
      const transcriptText = transcript.fullText;
      const apiKey = openAiKey || anthropicKey;
      if (!apiKey) {
        trackEvent('analyze_blocked_no_key');
        setError('Please set an API key in Settings before analyzing.');
        setLoading(false);
        return;
      }

      // Free plan: max N analyzed meetings per month, OpenAI model only
      const used = await getMonthlyAnalyzedCount();
      const limit = getEffectiveMeetingLimit(plan);
      if (limit !== null && used >= limit) {
        trackEvent('analyze_blocked_limit');
        setUsageExceeded(true);
        setLoading(false);
        return;
      }
      const model = openAiKey ? 'openai' : 'anthropic';
      if (!canUseFeature(plan, 'allAiModels') && model !== 'openai') {
        trackEvent('analyze_blocked_model');
        setModelGated(true);
        setLoading(false);
        return;
      }

      trackEvent('analyze_clicked');
      const result = await analyzeMeeting(transcriptText, id, apiKey, model);
      trackEvent('analyze_succeeded');

      const aiLeads = (result as any).leads || [];
      const actionItems = result.actionItems ? result.actionItems.map((item: any) => {
        if (typeof item === 'string') return item;
        const task = item?.task ? String(item.task) : '';
        const assignee = typeof item?.assignee === 'string' ? item.assignee.trim() : '';
        if (!task) return assignee ? `Unassigned task (Assigned to: ${assignee})` : '';
        return assignee && assignee.toLowerCase() !== 'unassigned' ? `${task} (Assigned to: ${assignee})` : task;
      }).filter(Boolean) : [];
      const rawSentimentScore = Number(result.sentiment?.score ?? 0);
      const clampedSentimentScore = Number.isFinite(rawSentimentScore) ? Math.min(100, Math.max(0, rawSentimentScore)) : 0;
      const normalizedSentiment = clampedSentimentScore / 100;
      const overall = result.sentiment?.overall === 'positive' || result.sentiment?.overall === 'negative' || result.sentiment?.overall === 'neutral' ? result.sentiment.overall : 'neutral';
      const validLeadScores = aiLeads.map((l: any) => Number(l?.score)).filter((n: number) => Number.isFinite(n) && n >= 0 && n <= 100);
      const leadScore = validLeadScores.length > 0 ? Math.max(...validLeadScores) : 0;
      const analysisRecord: Analysis = {
        id: `analysis_${id}`,
        meetingId: id,
        summary: result.summary,
        actionItems,
        sentiment: {
          positive: overall === 'positive' ? normalizedSentiment : 0,
          neutral: overall === 'neutral' ? 1 : 0,
          negative: overall === 'negative' ? normalizedSentiment : 0,
          overall,
        },
        leadScore,
        emailDraft: null,
        modelUsed: model,
        analyzedAt: new Date().toISOString(),
      };
      await db.ai_analysis.put(analysisRecord);
      setAnalysis(analysisRecord);

      // Auto Lead Creation & Scoring (Abstracted)
      await leadsDB.createLeadsFromAnalysis(id, aiLeads);
    } catch (err) {
      console.error('Analysis failed:', err);
      setError('Failed to generate analysis. Check your API key in Settings.');
    } finally {
      setLoading(false);
    }
  };

  if (initialLoading) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <div style={{ width: '32px', height: '32px', border: '3px solid var(--border)', borderTopColor: 'var(--accent-primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
        Loading meeting...
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!meeting) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <p style={{ fontSize: '16px', marginBottom: '16px' }}>Meeting not found.</p>
        <Link to="/dashboard/meetings" style={{ color: 'var(--accent-primary)', textDecoration: 'none', fontSize: '14px' }}>
          &larr; Back to Meetings
        </Link>
      </div>
    );
  }

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const transcriptExpired = isTranscriptExpired(plan, meeting.startTime);
  const meetingLimit = getEffectiveMeetingLimit(plan);
  const isFree = plan === 'free' || !plan;

  return (
    <div className="animate-fade-in">
      <div style={{ marginBottom: '20px' }}>
        <Link to="/dashboard/meetings" style={{ color: 'var(--accent-primary)', textDecoration: 'none', fontSize: '14px', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          &larr; Back to Meetings
        </Link>
      </div>

      {/* Meeting Header */}
      <div className="ds-panel" style={{ padding: '28px', marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '8px' }}>{meeting.title}</h1>
            <div style={{ display: 'flex', gap: '20px', color: 'var(--text-secondary)', fontSize: '14px' }}>
              <span className="data-text">{formatDate(meeting.startTime)}</span>
              <span className="data-text">{meeting.duration} min</span>
              <span style={{ padding: '2px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 500, backgroundColor: meeting.status === 'completed' ? 'rgba(78,205,196,0.12)' : 'rgba(240,201,41,0.12)', color: meeting.status === 'completed' ? 'var(--success)' : 'var(--warning)' }}>
                {meeting.status}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Content Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px' }}>
        {/* Transcript */}
        <div className="ds-panel" style={{ padding: '24px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', color: 'var(--accent-primary)' }}>Transcript</h2>
          {transcriptExpired ? (
            <UpgradePrompt
              feature="allAiModels"
              description="Transcripts older than 30 days are available on Pro. Upgrade for unlimited meeting history."
              compact
            />
          ) : transcript?.fullText ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>
              {transcript.fullText}
            </div>
          ) : (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              <p style={{ fontSize: '14px' }}>No transcript available for this meeting.</p>
              <p style={{ fontSize: '12px', marginTop: '8px' }}>Transcripts are captured when the Zoom panel is active, or you can add one manually from the Meetings page.</p>
            </div>
          )}
        </div>

        {/* AI Analysis Sidebar */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="ds-panel" style={{ padding: '24px' }}>
            <h2 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '16px', color: 'var(--accent-primary)' }}>AI Analysis</h2>

            {error && (
              <div style={{ padding: '12px', backgroundColor: 'rgba(233,69,96,0.1)', borderRadius: '8px', marginBottom: '16px', color: 'var(--danger)', fontSize: '13px' }}>
                {error}
              </div>
            )}

            {!analysis ? (
              <div>
                {usageExceeded ? (
                  <UpgradePrompt
                    feature="allAiModels"
                    description={`You've reached your free limit of ${meetingLimit ?? 3} analyzed meetings per month. Upgrade to Pro for unlimited meetings, all AI models, and more.`}
                  />
                ) : modelGated ? (
                  <UpgradePrompt
                    feature="allAiModels"
                    description="The free plan includes 1 AI model (OpenAI). Upgrade to Pro to use Anthropic and Gemini."
                  />
                ) : (
                  <>
                    <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
                      Generate an AI-powered summary, action items, and sentiment analysis for this meeting.
                    </p>
                    {isFree && meetingLimit !== null && !transcriptExpired && (
                      <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '12px' }}>
                        {monthlyUsed}/{meetingLimit} free analyses used this month
                      </p>
                    )}
                    <button
                      onClick={handleAnalyze}
                      disabled={loading || transcriptExpired || !transcript?.fullText?.trim()}
                      style={{ padding: '10px 16px', backgroundColor: 'var(--accent-primary)', color: 'var(--bg-primary)', border: 'none', borderRadius: '8px', cursor: loading || transcriptExpired || !transcript?.fullText?.trim() ? 'not-allowed' : 'pointer', fontWeight: 600, width: '100%', opacity: loading || transcriptExpired || !transcript?.fullText?.trim() ? 0.5 : 1, fontSize: '14px', transition: 'opacity 0.2s' }}
                    >
                      {loading ? 'Analyzing...' : transcriptExpired ? 'Upgrade to analyze older meetings' : 'Generate Summary'}
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div>
                <div style={{ marginBottom: '20px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-secondary)' }}>Summary</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6 }}>{analysis.summary}</p>
                </div>
                <div style={{ marginBottom: '20px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-secondary)' }}>Action Items</h3>
                  {Array.isArray(analysis.actionItems) && analysis.actionItems.length > 0 ? (
                    <ul style={{ margin: 0, paddingLeft: '18px', color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6 }}>
                      {analysis.actionItems.map((item, idx) => (
                        <li key={idx} style={{ marginBottom: '4px' }}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No action items identified.</p>
                  )}
                </div>
                <div style={{ marginBottom: '20px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-secondary)' }}>Sentiment</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6 }}>
                    {(analysis.sentiment?.overall ?? 'neutral').charAt(0).toUpperCase() + (analysis.sentiment?.overall ?? 'neutral').slice(1)}
                    {' ('}
                    {(() => {
                      const overall = analysis.sentiment?.overall ?? 'neutral';
                      if (overall === 'positive') return `${Math.round((analysis.sentiment?.positive ?? 0) * 100)}%`;
                      if (overall === 'negative') return `${Math.round((analysis.sentiment?.negative ?? 0) * 100)}%`;
                      return `${Math.round((analysis.sentiment?.neutral ?? 0) * 100)}%`;
                    })()}
                    {')'}
                  </p>
                </div>
                <div style={{ marginBottom: '20px' }}>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-secondary)' }}>Lead Score</h3>
                  <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.6 }}>{typeof analysis.leadScore === 'number' ? analysis.leadScore : 0}/100</p>
                </div>
                {analysis.analyzedAt && (
                  <p className="data-text" style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                    Analyzed {new Date(analysis.analyzedAt).toLocaleString()}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
