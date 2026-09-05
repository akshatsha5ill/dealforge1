import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, Video, Users, Mail, ArrowRight, Zap } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid } from 'recharts';
import { db } from '../../services/local-db/db';
import { useStore } from '../../store';
import { getMonthlyAnalyzedCount } from '../../services/usage';
import { getPlan } from '../../services/feature-gate';
import { getEffectiveMeetingLimit, initReferrals } from '../../services/referral';
import { Meeting } from '../../types';

import { buildMeetingTrendData, buildPipelineData } from '../../utils/analytics';

export default function DashboardPage() {
  const navigate = useNavigate();
  const plan = useStore((state) => state.subscription?.plan);
  const [stats, setStats] = useState({ meetings: 0, leads: 0, deals: 0, emails: 0 });
  const [recentMeetings, setRecentMeetings] = useState<Meeting[]>([]);
  const [meetingTrendData, setMeetingTrendData] = useState<any[]>([]);
  const [pipelineData, setPipelineData] = useState<any[]>([]);
  const [monthlyUsed, setMonthlyUsed] = useState(0);

  useEffect(() => {
    const fetchData = async () => {
      const [meetings, leads, deals, emails, used] = await Promise.all([
        db.meetings.toArray(),
        db.leads.toArray(),
        db.deals.toArray(),
        db.email_campaigns.toArray(),
        getMonthlyAnalyzedCount(),
      ]);
      setStats({ meetings: meetings.length, leads: leads.length, deals: deals.length, emails: emails.filter((e: any) => e.status === 'sent').length });
      setRecentMeetings(meetings.slice(-5).reverse());
      setMeetingTrendData(buildMeetingTrendData(meetings));
      setPipelineData(buildPipelineData(deals));
      setMonthlyUsed(used);
      await initReferrals();
    };
    fetchData();
  }, []);

  const currentPlan = getPlan(plan);
  const meetingLimit = getEffectiveMeetingLimit(currentPlan);
  const isFree = currentPlan === 'free';
  const statCards = [
    { label: 'Total Meetings', value: stats.meetings, icon: Video, color: 'var(--accent-primary)' },
    { label: 'Active Leads', value: stats.leads, icon: Users, color: 'var(--success)' },
    { label: 'Open Deals', value: stats.deals, icon: TrendingUp, color: 'var(--warning)' },
    { label: 'Emails Sent', value: stats.emails, icon: Mail, color: 'var(--danger)' },
  ];

  return (
    <div className="animate-fade-in">
      <div style={{ marginBottom: '30px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: 700, marginBottom: '4px' }}>Dashboard</h1>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Welcome back. Here's your sales overview.</p>
      </div>

      {/* Free plan usage banner */}
      {isFree && meetingLimit !== null && (
        <div className="ds-panel" style={{ padding: '20px 24px', marginBottom: '20px', display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap', border: '1px solid rgba(168, 119, 20, 0.35)' }}>
          <div style={{ flex: 1, minWidth: '220px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                Free plan — {monthlyUsed}/{meetingLimit} meetings analyzed this month
              </span>
              <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {monthlyUsed >= meetingLimit ? 'Limit reached' : `${meetingLimit - monthlyUsed} remaining`}
              </span>
            </div>
            <div style={{ height: '6px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '3px', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${Math.min(100, (monthlyUsed / meetingLimit) * 100)}%`,
                  backgroundColor: monthlyUsed >= meetingLimit ? 'var(--danger)' : 'var(--secondary)',
                  borderRadius: '3px',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>
          </div>
          <button
            onClick={() => navigate('/dashboard/billing')}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '10px 18px', backgroundColor: 'var(--text-primary)', color: 'var(--bg-primary)', border: 'none', borderRadius: '8px', fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}
          >
            <Zap size={14} /> Upgrade for Unlimited
          </button>
        </div>
      )}

      {/* Stat Cards */}
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

      {/* Charts Row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '30px' }}>
        <div className="ds-panel" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '20px', color: 'var(--text-secondary)' }}>Meetings This Week</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={meetingTrendData}>
              <XAxis dataKey="name" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '13px' }}
                cursor={{ fill: 'var(--bg-tertiary)' }}
              />
              <Bar dataKey="meetings" fill="var(--accent-primary)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="ds-panel" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, marginBottom: '20px', color: 'var(--text-secondary)' }}>Pipeline Value</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={pipelineData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="name" tick={{ fill: 'var(--text-muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: 'var(--text-muted)', fontSize: 12 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${(v/1000).toFixed(0)}k`} />
              <Tooltip
                contentStyle={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '13px' }}
                formatter={(v) => [`$${(v || 0).toLocaleString()}`, 'Value']}
              />
              <Line type="monotone" dataKey="value" stroke="var(--success)" strokeWidth={2} dot={{ fill: 'var(--success)', r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Recent Meetings */}
      <div className="ds-panel" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-secondary)' }}>Recent Meetings</h3>
          <button onClick={() => navigate('/dashboard/meetings')} style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            View all <ArrowRight size={14} />
          </button>
        </div>
        {recentMeetings.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
            <Video size={40} style={{ marginBottom: '12px', opacity: 0.3 }} />
            <p>No meetings yet. Start a meeting in Zoom to see data here.</p>
          </div>
        ) : (
          <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ paddingBottom: '12px', borderBottom: '1px solid var(--border)', fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Title</th>
                <th style={{ paddingBottom: '12px', borderBottom: '1px solid var(--border)', fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Duration</th>
                <th style={{ paddingBottom: '12px', borderBottom: '1px solid var(--border)', fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Status</th>
                <th style={{ paddingBottom: '12px', borderBottom: '1px solid var(--border)', fontSize: '12px', fontWeight: 500, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {recentMeetings.map((m) => (
                <tr key={m.id} style={{ cursor: 'pointer', transition: 'background-color 0.2s' }} onClick={() => navigate(`/dashboard/meetings/${m.id}`)} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'var(--bg-tertiary)'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                  <td style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>{m.title}</td>
                  <td className="data-text" style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>{m.duration} min</td>
                  <td style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ padding: '4px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 500, backgroundColor: m.status === 'completed' ? 'var(--success)' + '18' : 'var(--warning)' + '18', color: m.status === 'completed' ? 'var(--success)' : 'var(--warning)' }}>
                      {m.status}
                    </span>
                  </td>
                  <td style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
                    <button onClick={(e) => { e.stopPropagation(); navigate(`/dashboard/meetings/${m.id}`); }} style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: '13px' }}>
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
