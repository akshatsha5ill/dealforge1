import { getFirebaseFirestore } from './firebase-admin.js';
import log from '../utils/logger.js';

const MAX_LIST_ITEMS = 500;

export interface SyncMeeting {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  duration: number;
  status: string;
}

export interface SyncAnalysis {
  id: string;
  meetingId: string;
  summary: string;
  actionItems: string[];
  leadScore: number;
  modelUsed: string;
  analyzedAt: string;
}

export interface SyncLead {
  id: string;
  meetingId: string;
  name: string;
  email: string;
  company: string;
  role: string;
  score: number;
  stage: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncDeal {
  id: string;
  leadId: string;
  title: string;
  stage: string;
  value: number;
  probability: number;
  expectedClose: string;
  createdAt: string;
  updatedAt: string;
}

export interface SyncPayload {
  meetings: SyncMeeting[];
  analyses: SyncAnalysis[];
  leads: SyncLead[];
  deals: SyncDeal[];
}

function collection(uid: string, name: string) {
  return getFirebaseFirestore().collection('users').doc(uid).collection('api-data').doc(name).collection('items');
}

function now(): string {
  return new Date().toISOString();
}

export async function syncDerivedData(uid: string, payload: SyncPayload): Promise<void> {
  const firestore = getFirebaseFirestore();
  const syncedAt = now();

  const records: Array<{ name: string; item: { id: string } }> = [
    ...payload.meetings.map((item) => ({ name: 'meetings' as const, item })),
    ...payload.analyses.map((item) => ({ name: 'analyses' as const, item })),
    ...payload.leads.map((item) => ({ name: 'leads' as const, item })),
    ...payload.deals.map((item) => ({ name: 'deals' as const, item })),
  ];

  for (let i = 0; i < records.length; i += 500) {
    const batch = firestore.batch();
    for (const { name, item } of records.slice(i, i + 500)) {
      const ref = collection(uid, name).doc(item.id);
      const data = { ...item } as Record<string, unknown>;
      if (data.createdAt === undefined) data.createdAt = syncedAt;
      if (data.updatedAt === undefined) data.updatedAt = syncedAt;
      batch.set(ref, { ...data, syncedAt }, { merge: true });
    }
    await batch.commit();
  }

  await firestore
    .collection('users')
    .doc(uid)
    .collection('api-data')
    .doc('meta')
    .set({ lastSyncedAt: syncedAt }, { merge: true });
}

export async function getLastSyncedAt(uid: string): Promise<string | null> {
  try {
    const doc = await getFirebaseFirestore()
      .collection('users')
      .doc(uid)
      .collection('api-data')
      .doc('meta')
      .get();
    return doc.exists ? (doc.data()?.lastSyncedAt as string | null) || null : null;
  } catch (err) {
    log.error('Failed to read last synced time', { error: err, uid });
    return null;
  }
}

function getSortTime(item: Record<string, unknown>): number {
  const raw =
    item.createdAt ?? item.startTime ?? item.updatedAt ?? item.analyzedAt ?? item.syncedAt ?? 0;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? 0 : t;
  }
  return 0;
}

async function listItems<T>(uid: string, name: string, limit = MAX_LIST_ITEMS): Promise<T[]> {
  const snap = await collection(uid, name).get();
  const items: T[] = [];
  snap.forEach((doc) => items.push(doc.data() as T));
  items.sort(
    (a, b) => getSortTime(b as unknown as Record<string, unknown>) - getSortTime(a as unknown as Record<string, unknown>),
  );
  return items.slice(0, limit);
}

export interface MeetingWithAnalysis extends SyncMeeting {
  summary: string | null;
  actionItems: string[];
  leadScore: number | null;
  modelUsed: string | null;
  analyzedAt: string | null;
}

export async function getMeetingsWithAnalyses(uid: string, limit = MAX_LIST_ITEMS): Promise<MeetingWithAnalysis[]> {
  const meetings = await listItems<SyncMeeting>(uid, 'meetings', limit);
  const analyses = await listItems<SyncAnalysis>(uid, 'analyses', limit);
  const byMeeting = new Map<string, SyncAnalysis>();
  for (const analysis of analyses) {
    if (!byMeeting.has(analysis.meetingId)) byMeeting.set(analysis.meetingId, analysis);
  }
  return meetings.map((meeting) => {
    const analysis = byMeeting.get(meeting.id);
    return {
      ...meeting,
      summary: analysis?.summary ?? null,
      actionItems: analysis?.actionItems ?? [],
      leadScore: analysis?.leadScore ?? null,
      modelUsed: analysis?.modelUsed ?? null,
      analyzedAt: analysis?.analyzedAt ?? null,
    };
  });
}

export async function getMeetingDetail(uid: string, meetingId: string): Promise<MeetingWithAnalysis | null> {
  const doc = await collection(uid, 'meetings').doc(meetingId).get();
  if (!doc.exists) return null;
  const meeting = doc.data() as SyncMeeting;
  const analysisDoc = await collection(uid, 'analyses').where('meetingId', '==', meetingId).get();
  const docs = analysisDoc.docs.map((d) => d.data() as SyncAnalysis);
  docs.sort(
    (a, b) => getSortTime(b as unknown as Record<string, unknown>) - getSortTime(a as unknown as Record<string, unknown>),
  );
  const analysis: SyncAnalysis | null = docs.length === 0 ? null : docs[0];
  return {
    ...meeting,
    summary: analysis?.summary ?? null,
    actionItems: analysis?.actionItems ?? [],
    leadScore: analysis?.leadScore ?? null,
    modelUsed: analysis?.modelUsed ?? null,
    analyzedAt: analysis?.analyzedAt ?? null,
  };
}

export async function getLeads(uid: string): Promise<SyncLead[]> {
  return listItems<SyncLead>(uid, 'leads');
}

export async function getDeals(uid: string): Promise<SyncDeal[]> {
  return listItems<SyncDeal>(uid, 'deals');
}
