import { db } from './db';
import { Lead } from '../../types';

// Never persist AI-hallucinated emails (e.g. '' or 'unknown@...').
// Normalize (trim + lowercase), validate, blank invalid + flag for enrichment.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v || v.length > MAX_EMAIL_LEN) return null;
  if (!EMAIL_RE.test(v)) return null;
  return v;
}

type EnrichedLead = Lead & { needs_enrichment?: boolean };

function sanitizeLead<T extends Partial<Lead>>(lead: T): T & { needs_enrichment: boolean } {
  const normalized = normalizeEmail((lead as any).email);
  const needs_enrichment = normalized === null;
  return {
    ...lead,
    email: normalized ?? '',
    needs_enrichment,
    customFields: {
      ...((lead as any).customFields ?? {}),
      ...(needs_enrichment ? { needs_enrichment: true } : {}),
    },
  } as T & { needs_enrichment: boolean };
}

function dedupeKey(l: Partial<Lead> & { needs_enrichment?: boolean }): string {
  const email = typeof (l as any).email === 'string' ? (l as any).email.trim().toLowerCase() : '';
  if (email && EMAIL_RE.test(email)) return `email:${email}`;
  const name = typeof (l as any).name === 'string' ? (l as any).name.trim().toLowerCase() : '';
  const company = typeof (l as any).company === 'string' ? (l as any).company.trim().toLowerCase() : '';
  return `person:${name}|${company}`;
}

function dedupeLeads<T extends Partial<Lead>>(leads: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const lead of leads) {
    const key = dedupeKey(lead as any);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lead);
  }
  return out;
}

export const leadsDB = {
  getAll: (): Promise<Lead[]> => db.leads.toArray(),
  get: (id: string): Promise<Lead | undefined> => db.leads.get(id),
  getByMeeting: (meetingId: string): Promise<Lead[]> => db.leads.where('meetingId').equals(meetingId).toArray(),
  getByStage: (stage: string): Promise<Lead[]> => db.leads.where('stage').equals(stage).toArray(),
  put: (lead: Lead): Promise<string> => db.leads.put(sanitizeLead(lead) as Lead),
  bulkPut: async (leads: Lead[]): Promise<string> => {
    const sanitized = dedupeLeads(leads.map((l) => sanitizeLead(l) as Lead));
    return db.leads.bulkPut(sanitized);
  },
  delete: (id: string): Promise<void> => db.leads.delete(id),
  count: (): Promise<number> => db.leads.count(),
  
  createLeadsFromAnalysis: async (meetingId: string, analyzedLeads: any[]): Promise<number> => {
    if (!analyzedLeads || analyzedLeads.length === 0) return 0;

    const existing = await db.leads.where('meetingId').equals(meetingId).toArray();
    const existingKeys = new Set(existing.map((l) => dedupeKey(sanitizeLead(l as Lead) as EnrichedLead)));
    
    const leadRecords: Lead[] = [];
    const batchKeys = new Set<string>(existingKeys);
    for (let index = 0; index < analyzedLeads.length; index++) {
      const lead = analyzedLeads[index] ?? {};
      const sanitized = sanitizeLead({
        id: `lead_${meetingId}_${index}_${Date.now()}`,
        meetingId,
        name: (typeof lead.name === 'string' ? lead.name.trim() : '') || 'Unknown',
        email: (lead as any).email,
        company: (typeof lead.company === 'string' ? lead.company.trim() : '') || 'Unknown',
        role: (typeof lead.role === 'string' ? lead.role.trim() : '') || 'Unknown',
        score: lead.score || 50,
        stage: lead.stage || 'Lead Identified',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Lead) as Lead;
      const key = dedupeKey(sanitized as EnrichedLead);
      if (batchKeys.has(key)) continue;
      batchKeys.add(key);
      leadRecords.push(sanitized);
    }
    
    if (leadRecords.length === 0) return 0;
    await db.leads.bulkPut(leadRecords);
    return leadRecords.length;
  }
};
