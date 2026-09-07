// Chart data builders (pure functions). Distinct from services/analytics.ts
// (Google Analytics) and services/usage-analytics.ts (local event store).
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDayKey(d: Date): string {
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

function startOfDayLocal(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export interface DateItem {
  createdAt?: string | number;
  startTime?: string;
  sentAt?: string;
  scheduledAt?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export function filterByDate<T extends DateItem>(items: T[], days: number): T[] {
  const startOfToday = startOfDayLocal(new Date());
  startOfToday.setDate(startOfToday.getDate() - (days - 1));
  const cutoff = startOfToday.getTime();
  return items.filter((item) => {
    const raw = item.createdAt || item.startTime || item.sentAt || item.scheduledAt;
    if (!raw) return false;
    const ts = new Date(raw).getTime();
    return !isNaN(ts) && ts >= cutoff;
  });
}

export interface MeetingData {
  startTime: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export function buildMeetingTrendData(meetings: MeetingData[]) {
  const counts: Record<string, number> = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0, Sat: 0, Sun: 0 };
  for (const m of meetings) {
    const d = new Date(m.startTime);
    const day = DAY_NAMES[d.getDay()];
    if (day in counts) counts[day]++;
  }
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((name) => ({ name, meetings: counts[name] }));
}

export interface DealData {
  stage?: string;
  value?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export function buildPipelineData(deals: DealData[]) {
  const stages: Record<string, number> = {};
  for (const d of deals) {
    const key = d.stage || 'Unknown';
    stages[key] = (stages[key] || 0) + (d.value || 0);
  }
  return Object.entries(stages).map(([name, value]) => ({ name, value }));
}

export interface LeadData {
  stage?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export function buildLeadStageData(leads: LeadData[]) {
  const stages: Record<string, number> = {};
  for (const l of leads) {
    const key = l.stage || 'Unknown';
    stages[key] = (stages[key] || 0) + 1;
  }
  return Object.entries(stages).map(([name, value]) => ({ name, value }));
}

export interface EmailItem {
  status?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export function buildEmailData(emails: EmailItem[]) {
  const statuses: Record<string, number> = {};
  for (const e of emails) {
    const key = e.status || 'Unknown';
    statuses[key] = (statuses[key] || 0) + 1;
  }
  return Object.entries(statuses).map(([name, count]) => ({ name, count }));
}

export function calculatePipelineVelocity(deals: DealData[]) {
  if (deals.length === 0) return { velocity: 0, avgSalesCycle: 0, winRate: 0 };
  
  const wonDeals = deals.filter(d => d.stage === 'closed_won');
  const winRate = wonDeals.length / deals.length;
  
  const totalValue = deals.reduce((sum, d) => sum + (d.value || 0), 0);
  const avgDealSize = totalValue / deals.length;
  
  let totalCycleDays = 0;
  let cycleCount = 0;
  
  for (const d of wonDeals) {
    if (d.createdAt && d.updatedAt) {
      const start = new Date(d.createdAt).getTime();
      const end = new Date(d.updatedAt).getTime();
      const diffDays = Math.max(1, (end - start) / (1000 * 60 * 60 * 24)); // Minimum 1 day
      totalCycleDays += diffDays;
      cycleCount++;
    }
  }
  
  const avgSalesCycle = cycleCount > 0 ? (totalCycleDays / cycleCount) : 30; // default 30 days if no reliable data
  
  const velocity = (deals.length * winRate * avgDealSize) / avgSalesCycle;
  return { velocity, avgSalesCycle, winRate: winRate * 100 };
}

export function buildMeetingFrequencyData(meetings: MeetingData[], days: number) {
  const startOfToday = startOfDayLocal(new Date());
  const cutoffDate = new Date(startOfToday);
  cutoffDate.setDate(startOfToday.getDate() - (days - 1));
  const cutoffTime = cutoffDate.getTime();
  const startOfTodayTime = startOfToday.getTime();
  
  // Initialize buckets for the chart
  const step = days > 30 ? Math.ceil(days / 15) : 1; // Group by multiple days if range is large
  
  // Build bucket offsets (days ago), always including today (offset 0)
  const offsets = new Set<number>();
  for (let i = days - 1; i >= 0; i -= step) {
    offsets.add(i);
  }
  offsets.add(0);
  const sortedOffsets = Array.from(offsets).sort((a, b) => b - a);

  const buckets: { key: string; timestamp: number; count: number }[] = [];
  const keyToIndex = new Map<string, number>();
  for (const i of sortedOffsets) {
    const bucketDate = new Date(startOfToday);
    bucketDate.setDate(startOfToday.getDate() - i);
    const dayStart = startOfDayLocal(bucketDate);
    const key = formatDayKey(dayStart);
    if (!keyToIndex.has(key)) {
      keyToIndex.set(key, buckets.length);
      buckets.push({ key, timestamp: dayStart.getTime(), count: 0 });
    }
  }

  // Sort buckets by timestamp (not string)
  buckets.sort((a, b) => a.timestamp - b.timestamp);
  keyToIndex.clear();
  buckets.forEach((b, idx) => keyToIndex.set(b.key, idx));
  
  for (const m of meetings) {
    const d = new Date(m.startTime);
    if (isNaN(d.getTime())) continue;
    const dayStartTime = startOfDayLocal(d).getTime();
    if (dayStartTime < cutoffTime || dayStartTime > startOfTodayTime) continue;
    if (step === 1) {
      const key = formatDayKey(startOfDayLocal(d));
      const idx = keyToIndex.get(key);
      if (idx !== undefined) buckets[idx].count++;
    } else {
      // Assign to the latest bucket whose start is <= meeting day
      for (let bi = buckets.length - 1; bi >= 0; bi--) {
        if (dayStartTime >= buckets[bi].timestamp) {
          buckets[bi].count++;
          break;
        }
      }
    }
  }

  return buckets.map(({ key, count }) => ({ date: key, count }));
}

export function buildPipelineVelocity(deals: DealData[]) {
  const wonDeals = deals.filter(d => d.stage === 'closed_won' && d.createdAt && d.updatedAt);
  if (wonDeals.length === 0) return 0;
  
  let totalDays = 0;
  for (const d of wonDeals) {
    const start = new Date(d.createdAt).getTime();
    const end = new Date(d.updatedAt).getTime();
    const days = (end - start) / (1000 * 60 * 60 * 24);
    totalDays += Math.max(0, days);
  }
  
  return Math.round(totalDays / wonDeals.length);
}

export function buildLeadScoreTrend(leads: LeadData[]) {
  const daysMap: Record<string, { totalScore: number; count: number; timestamp: number }> = {};
  
  for (const l of leads) {
    if (l.createdAt && l.score !== undefined) {
      const d = new Date(l.createdAt);
      if (isNaN(d.getTime())) continue;
      const dayStart = startOfDayLocal(d);
      const dateStr = formatDayKey(dayStart);
      if (!daysMap[dateStr]) {
        daysMap[dateStr] = { totalScore: 0, count: 0, timestamp: dayStart.getTime() };
      }
      daysMap[dateStr].totalScore += l.score;
      daysMap[dateStr].count += 1;
    }
  }
  
  const result = Object.entries(daysMap).map(([date, data]) => ({
    name: date,
    score: Math.round(data.totalScore / data.count),
    timestamp: data.timestamp
  }));
  
  // Sort by timestamp (not string, no assumed year)
  result.sort((a, b) => a.timestamp - b.timestamp);
  return result.map(({ name, score }) => ({ name, score }));
}
