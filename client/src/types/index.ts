export interface Meeting {
  id: string;
  zoomMeetingId: string;
  title: string;
  startTime: string; // Storing as ISO string is usually better for Dexie/JSON or number timestamp.
  endTime: string;
  duration: number;
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | string;
}

export interface TranscriptSegment {
  speaker: string;
  text: string;
  startTime: number;
  endTime: number;
}

export interface Transcript {
  id: string;
  meetingId: string;
  segments: TranscriptSegment[]; 
  fullText: string;
  createdAt: string;
}

export interface AnalysisSentiment {
  positive: number;
  neutral: number;
  negative: number;
  overall: string;
}

export interface Analysis {
  id: string;
  meetingId: string;
  summary: string;
  actionItems: string[];
  sentiment: AnalysisSentiment;
  leadScore: number;
  emailDraft: string | null;
  modelUsed: string;
  analyzedAt: string;
}

export interface Lead {
  id: string;
  meetingId: string;
  name: string;
  email: string;
  company: string;
  role: string;
  score: number;
  stage: string;
  reasoning?: string;
  tags?: string[];
  customFields?: Record<string, any>;
  consentStatus?: 'opted_in' | 'opted_out' | 'unsubscribed' | 'unknown' | string;
  consentSource?: string;
  consentCapturedAt?: string;
  consentBasis?: string;
  unsubscribedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DealNote {
  text: string;
  author: string;
  createdAt: string;
}

export interface Deal {
  id: string;
  leadId: string;
  title: string;
  stage: string;
  value: number;
  probability: number;
  expectedClose: string;
  notes: DealNote[];
  createdAt: string;
  updatedAt: string;
  order?: number;
}

export interface EmailSequenceStep {
  subject: string;
  body: string;
  delayDays: number;
}

export interface EmailCampaign {
  id: string;
  leadId: string;
  subject: string;
  body: string;
  status: 'draft' | 'scheduled' | 'sent' | 'error' | string;
  type: string;
  sequence: EmailSequenceStep[];
  scheduledAt: string;
  sentAt?: string;
  createdAt?: number;
}

export interface EmailTracking {
  id: string;
  campaignId: string;
  opens: number;
  clicks: number;
  replied: number;
  lastActivity: string | null;
}

export interface DripCampaign {
  id: string;
  leadId: string;
  name: string;
  status: 'active' | 'completed' | 'error' | 'paused' | string;
  currentStep: number;
  totalSteps?: number;
  nextRunAt: number | null;
  createdAt: number;
  error?: string;
}

export interface Setting {
  key: string;
  value: unknown;
}
