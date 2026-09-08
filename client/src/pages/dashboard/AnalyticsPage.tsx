import { useState, useEffect } from 'react';
import { TrendingUp, Video, Users, Mail, BarChart3, ArrowRight, Zap, Clock } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid, PieChart, Pie, Cell } from 'recharts';
import { db } from '../../services/local-db/db';
import { Meeting, Lead, Deal, EmailCampaign } from '../../types';

const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];
import { filterByDate, buildMeetingTrendData, buildPipelineData, buildLeadStageData, buildEmailData, calculatePipelineVelocity, buildMeetingFrequencyData, buildLeadScoreTrend } from '../../utils/analytics';

const tooltipStyle = { backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '13px' };
const axisTick = { fill: 'var(--text-muted)', fontSize: 12 };
const gridStroke = 'var(--border)';

export default function AnalyticsPage() {
  const [timeFilter, setTimeFilter] = useState(30);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [emails, setEmails] = useState<EmailCampaign[]>([]);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [allMeetings, allLeads, allDeals, allEmails] = await Promise.all([
          db.meetings.toArray(),
          db.leads.toArray(),
          db.deals.toArray(),
          db.email_campaigns.toArray(),
        ]);
        setMeetings(allMeetings);
        setLeads(allLeads);
        setDeals(allDeals);
        setEmails(allEmails);
      } catch {
        // IndexedDB unavailable — render the empty state instead of crashing.
        setLoadError(true);
      }
    };
    fetchData();
  }, []);

  const TIME_FILTERS = [
    { label: '7d', days: 7 },
    { label: '30d', days: 30 },
    { label: '90d', days: 90 },
  ];

  const filteredLeads = filterByDate(leads, timeFilter);
  const filteredDeals = filterByDate(deals, timeFilter);
  const filteredMeetings = filterByDate(meetings, timeFilter);
  const filteredEmails = filterByDate(emails, timeFilter);

  const meetingTrendData = buildMeetingTrendData(filteredMeetings);
  const meetingFrequencyData = buildMeetingFrequencyData(filteredMeetings, timeFilter);
  const pipelineData = buildPipelineData(filteredDeals);
  const leadStageData = buildLeadStageData(filteredLeads);
  const emailData = buildEmailData(filteredEmails);

  const leadScoreData = buildLeadScoreTrend(filteredLeads);

  const { velocity, avgSalesCycle } = calculatePipelineVelocity(filteredDeals);

  const totalMeetings = filteredMeetings.length;
  const totalLeads = filteredLeads.length;
  const leadIds = new Set(filteredLeads.map((l) => l.id));
  const dealsWithLead = filteredDeals.filter((d) => leadIds.has(d.leadId));
  const conversionRate = totalLeads > 0 ? ((dealsWithLead.length / totalLeads) * 100).toFixed(1) : 0;
  const pipelineValue = filteredDeals.reduce((sum, d) => sum + (d.value || 0), 0);

  const wonDeals = filteredDeals.filter((d) => d.stage === 'closed_won').length;
  const dealCount = filteredDeals.length;

  const statCards = [
    { label: 'Total Meetings', value: totalMeetings, icon: Video, color: 'var(--accent-primary)' },
    { label: 'Pipeline Velocity', value: `$${velocity.toFixed(0)}/day`, icon: Zap, color: '#8b5cf6' },
    { label: 'Conversion Rate', value: `${conversionRate}%`, icon: TrendingUp, color: 'var(--warning)' },
    { label: 'Pipeline Value', value: `$${pipelineValue.toLocaleString()}`, icon: BarChart3, color: 'var(--danger)' },
    { label: 'Total Leads', value: totalLeads, icon: Users, color: 'var(--success)' },
    { label: 'Avg Sales Cycle', value: `${avgSalesCycle.toFixed(1)} days`, icon: Clock, color: '#06b6d4' },
  ];

  const funnelSteps = [
    { label: 'Leads', count: totalLeads, pct: totalLeads > 0 ? 100 : 0 },
    { label: 'Deals', count: dealCount, pct: totalLeads > 0 ? Number(((dealCount / totalLeads) * 100).toFixed(1)) : 0 },
    { label: 'Won', count: wonDeals, pct: totalLeads > 0 ? Number(((wonDeals / totalLeads) * 100).toFixed(1)) : 0 },
  ];

  return (
    <div className="animate-fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '30px' }}>
        <div>
          <h1 style={{ fontSize: '28px', fontWeight: 700, marginBottom: '4px' }}>Analytics</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            {loadError ? 'Local data is unavailable — charts show empty state.' : 'Track performance and lead engagement.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {TIME_FILTERS.map(({ label, days }) => (
            <button
              key={label}
              onClick={() => setTimeFilter(days)}
              style={{
                padding: '6px 14px',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                backgroundColor: timeFilter === days ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                color: timeFilter === days ? '#fff' : 'var(--text-secondary)',
                fontSize: '13px',
                fontWeight: 500,
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '30px' }}>
        {statCards.map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="ds-panel stat-card" style={{ padding: '20px', cursor: 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
              <span style={{ color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 500 }}>{label}</span>
              <div style={{ width: '36px', height: '36px', borderRadius: '8px', backgroundColor: `${color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon size={18} style={{ color }} />
              </div>
            </div>
            <div className="data-text" style={{ fontSize: '28px', fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
          </div>
        ))}
      </div>

      <div className="ds-panel" style={{ padding: '24px', marginBottom: '30px' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '20px', color: 'var(--text-secondary)' }}>Meeting Frequency</h3>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={meetingFrequencyData}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
            <XAxis dataKey="date" tick={axisTick} axisLine={false} tickLine={false} />
            <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip contentStyle={tooltipStyle} />
            <Line type="monotone" dataKey="count" stroke="var(--accent-primary)" strokeWidth={3} dot={{ r: 4, fill: 'var(--bg-primary)', strokeWidth: 2 }} activeDot={{ r: 6 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '30px' }}>
        <div className="ds-panel" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '20px', color: 'var(--text-secondary)' }}>Meeting Trends</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={meetingTrendData}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
              <XAxis dataKey="name" tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--bg-tertiary)' }} />
              <Bar dataKey="meetings" fill="var(--accent-primary)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="ds-panel" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '20px', color: 'var(--text-secondary)' }}>Pipeline by Stage</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={pipelineData}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
              <XAxis dataKey="name" tick={axisTick} axisLine={false} tickLine={false} />
              <YAxis tick={axisTick} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v) => [`$${(v || 0).toLocaleString()}`, 'Value']} cursor={{ fill: 'var(--bg-tertiary)' }} />
              <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                {pipelineData.map((_, i) => (
                  <Cell key={i} fill={COLORS[i % COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '30px' }}>
        <div className="ds-panel" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '20px', color: 'var(--text-secondary)' }}>Lead Stages</h3>
          {leadStageData.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              <Users size={32} style={{ marginBottom: '8px', opacity: 0.3 }} />
              <p>No lead data available.</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie
                  data={leadStageData}
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={80}
                  paddingAngle={3}
                  dataKey="value"
                  label={({ name, percent }) => `${name} ${((percent || 0) * 100).toFixed(0)}%`}
                >
                  {leadStageData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="ds-panel" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '20px', color: 'var(--text-secondary)' }}>Email Performance</h3>
          {emailData.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              <Mail size={32} style={{ marginBottom: '8px', opacity: 0.3 }} />
              <p>No email data available.</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={emailData}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                <XAxis dataKey="name" tick={axisTick} axisLine={false} tickLine={false} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'var(--bg-tertiary)' }} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {emailData.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '30px' }}>
        <div className="ds-panel" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '24px', color: 'var(--text-secondary)' }}>Conversion Funnel</h3>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0' }}>
            {funnelSteps.map((step, i) => (
              <div key={step.label} style={{ display: 'flex', alignItems: 'center' }}>
                <div style={{ textAlign: 'center', minWidth: '120px' }}>
                  <div style={{
                    width: `${Math.max(60, step.pct * 0.9)}px`,
                    height: `${Math.max(40, step.pct * 0.5)}px`,
                    margin: '0 auto 12px',
                    borderRadius: '12px',
                    backgroundColor: COLORS[i],
                    opacity: 0.85,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.3s',
                  }}>
                    <span style={{ color: '#fff', fontSize: '18px', fontWeight: 700 }}>{step.count}</span>
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>{step.label}</div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{step.pct}%</div>
                </div>
                {i < funnelSteps.length - 1 && (
                  <ArrowRight size={20} style={{ color: 'var(--text-muted)', margin: '0 12px', marginBottom: '30px' }} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="ds-panel" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '20px', color: 'var(--text-secondary)' }}>Avg. Lead Score Trend</h3>
          {leadScoreData.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
              <TrendingUp size={32} style={{ marginBottom: '8px', opacity: 0.3 }} />
              <p>No lead scores available.</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={leadScoreData}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                <XAxis dataKey="name" tick={axisTick} axisLine={false} tickLine={false} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} domain={[0, 100]} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line type="monotone" dataKey="score" stroke="var(--accent-primary)" strokeWidth={3} dot={{ fill: 'var(--bg-primary)', stroke: 'var(--accent-primary)', strokeWidth: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
