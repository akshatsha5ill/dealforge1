import { db } from './local-db/db';
import { analyzeMeeting } from './ai/ai-service';
import { useStore } from '../store';
import { getSharedSocket } from '../hooks/useWebSocket';

// Shared validation with local-db/leads.ts: never persist hallucinated emails as-is.
// Normalize (trim + lowercase), validate regex, drop invalid to '' + needs_enrichment flag, dedupe.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LEN = 254;

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v || v.length > MAX_EMAIL_LEN) return null;
  if (!EMAIL_RE.test(v)) return null;
  return v;
}

function dedupeKey(l: { email?: unknown; name?: unknown; company?: unknown }): string {
  const rawEmail = typeof l.email === 'string' ? l.email.trim().toLowerCase() : '';
  if (rawEmail && EMAIL_RE.test(rawEmail)) return `email:${rawEmail}`;
  const name = typeof l.name === 'string' ? l.name.trim().toLowerCase() : '';
  const company = typeof l.company === 'string' ? l.company.trim().toLowerCase() : '';
  return `person:${name}|${company}`;
}

class LeadAutomationService {
  private isSubscribed: boolean = false;

  async processMeetingLeads(meetingId: string, apiKey: string, model: string) {
    const transcriptData = await db.transcripts.where('meetingId').equals(meetingId).first();
    if (!transcriptData || !transcriptData.fullText) return;

    const existingAnalysis = await db.ai_analysis.where('meetingId').equals(meetingId).first();
    if (existingAnalysis) return;

    const result = await analyzeMeeting(transcriptData.fullText, meetingId, apiKey, model);

    await db.ai_analysis.put({
      id: `analysis_${meetingId}`,
      meetingId: meetingId,
      summary: result?.summary || '',
      actionItems: result?.actionItems?.map((item: any) => item.task || String(item)) || [],
      sentiment: { positive: 0, neutral: 0, negative: 0, overall: result?.sentiment?.overall || 'neutral' },
      leadScore: 0,
      emailDraft: null,
      modelUsed: model,
      analyzedAt: new Date().toISOString(),
    });
    
    const leads = (result as any)?.leads || [];
    if (!leads || leads.length === 0) return;

    const existingLeads = await db.leads.where('meetingId').equals(meetingId).toArray();
    const seen = new Set(existingLeads.map((l: any) => dedupeKey({
      email: normalizeEmail(l.email) ?? '',
      name: l.name,
      company: l.company,
    })));

    const leadRecords: any[] = [];
    leads.forEach((lead: any, index: number) => {
      const normalizedEmail = normalizeEmail(lead?.email);
      const needs_enrichment = normalizedEmail === null;
      const name = (typeof lead?.name === 'string' ? lead.name.trim() : '') || 'Unknown';
      const company = (typeof lead?.company === 'string' ? lead.company.trim() : '') || 'Unknown';
      const candidate = {
        email: normalizedEmail ?? '',
        name,
        company,
      };
      const key = dedupeKey(candidate);
      if (seen.has(key)) return;
      seen.add(key);

      leadRecords.push({
        id: `lead_${meetingId}_${index}_${Date.now()}`,
        meetingId: meetingId,
        name,
        email: normalizedEmail ?? '',
        needs_enrichment,
        customFields: {
          ...(lead?.customFields ?? {}),
          ...(needs_enrichment ? { needs_enrichment: true } : {}),
        },
        company,
        role: (typeof lead?.role === 'string' ? lead.role.trim() : '') || 'Unknown',
        score: lead?.score || 50,
        stage: lead?.stage || 'Lead Identified',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    });

    if (leadRecords.length === 0) return;
    await db.leads.bulkPut(leadRecords);
  }

  handleMeetingEnded = async (data: { meetingId: string }) => {
    const { meetingId } = data;
    if (!meetingId) return;
    
    const storeState = useStore.getState();
    const apiKey = storeState.geminiKey || storeState.openAiKey || storeState.anthropicKey;
    const model = storeState.geminiKey ? 'gemini' : storeState.openAiKey ? 'openai' : 'anthropic';
    
    if (!apiKey) {
      useStore.getState().setError('Lead Automation: No AI API key configured. Please add Gemini, OpenAI, or Anthropic key in Settings.');
      return;
    }

    try {
      await this.processMeetingLeads(meetingId, apiKey, model);
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('Failed in auto-lead automation:', err);
      useStore.getState().setError(`Lead Automation Failed: ${errorMsg}`);
    }
  };

  handleParticipantJoined = async (data: { meetingId: string, participant: any }) => {
    const { meetingId, participant } = data;
    if (!meetingId || !participant) return;

    try {
      const existingLeads = await db.leads.where('meetingId').equals(meetingId).toArray();
      const normalizedParticipantEmail = normalizeEmail(participant.email);
      const normalizedParticipantName = typeof participant.user_name === 'string'
        ? participant.user_name.trim().toLowerCase()
        : '';
      const alreadyExists = existingLeads.find(l => {
        const existingEmail = normalizeEmail((l as any).email);
        if (normalizedParticipantEmail && existingEmail) {
          return existingEmail === normalizedParticipantEmail;
        }
        const existingName = typeof (l as any).name === 'string'
          ? (l as any).name.trim().toLowerCase()
          : '';
        return !!normalizedParticipantName && existingName === normalizedParticipantName;
      });

      if (alreadyExists) return;

      const needs_enrichment = normalizedParticipantEmail === null;
      const newLead = {
        id: `lead_${meetingId}_${participant.user_id || Date.now()}`,
        meetingId: meetingId,
        name: (typeof participant.user_name === 'string' ? participant.user_name.trim() : '') || 'Unknown Participant',
        email: normalizedParticipantEmail ?? '',
        needs_enrichment,
        customFields: {
          ...(needs_enrichment ? { needs_enrichment: true } : {}),
        },
        company: 'Unknown',
        role: 'Meeting Participant',
        score: 50,
        stage: 'Lead Identified',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      
      await db.leads.add(newLead);
    } catch (err: any) {
      console.error('Failed to auto-create lead from participant:', err);
    }
  };

  start() {
    if (this.isSubscribed) return;
    
    const socket = getSharedSocket();
    if (socket) {
      socket.on('meeting_ended', this.handleMeetingEnded);
      socket.on('participant_joined', this.handleParticipantJoined);
      this.isSubscribed = true;
    } else {
      console.warn('Lead Automation Service could not start: WebSocket not initialized.');
    }
  }

  stop() {
    if (!this.isSubscribed) return;
    
    const socket = getSharedSocket();
    if (socket) {
      socket.off('meeting_ended', this.handleMeetingEnded);
      socket.off('participant_joined', this.handleParticipantJoined);
    }
    this.isSubscribed = false;
  }
}

export const leadAutomationService = new LeadAutomationService();
