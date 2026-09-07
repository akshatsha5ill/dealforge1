import { apiClient } from '../api/client';

interface AnalysisResponse {
  status: string;
  analysis: {
    summary: string;
    actionItems: Array<{ task: string; assignee: string }>;
    sentiment: { overall: string; score: number; notes: string };
  };
}

interface DraftResponse {
  status: string;
  draft: { subject: string; body: string };
}

interface EmailSendResponse {
  status: string;
  data: { id: string; from: string; to: string };
}

interface ScoreResponse {
  status: string;
  score: { score: number; reasoning: string; category: string };
}

// BYO keys travel in request headers, never in the JSON body, so they are not
// retained in req.body, request logs, or error payloads server-side. The
// server still accepts legacy body keys during migration (header wins).
export const AI_API_KEY_HEADER = 'x-ai-api-key';
export const EMAIL_API_KEY_HEADER = 'x-email-api-key';

export const analyzeMeeting = async (transcript: string, meetingId: string, apiKey: string, model: string) => {
  const response = await apiClient.post<AnalysisResponse>('/ai/analyze', {
    transcript,
    meetingId,
    model: model || 'openai',
  }, { [AI_API_KEY_HEADER]: apiKey });
  return response.analysis;
};

export const generateEmailDraft = async (transcript: string, leadContext: Record<string, string | number | boolean>, apiKey: string, model: string) => {
  const response = await apiClient.post<DraftResponse>('/email/draft', {
    transcript,
    leadContext,
    model: model || 'openai',
  }, { [AI_API_KEY_HEADER]: apiKey });
  return response.draft;
};

export const sendEmail = async (to: string, subject: string, body: string, emailApiKey: string, campaignId?: string, via: 'resend' | 'gmail' | 'outlook' = 'resend') => {
  const response = await apiClient.post<EmailSendResponse>('/email/send', {
    to,
    subject,
    body,
    campaignId,
    via,
  }, { [EMAIL_API_KEY_HEADER]: emailApiKey });
  return response;
};

export const scoreLead = async (transcript: string, leadContext: Record<string, string | number | boolean>, apiKey: string, model: string) => {
  const response = await apiClient.post<ScoreResponse>('/ai/score', {
    transcript,
    leadContext,
    model: model || 'openai',
  }, { [AI_API_KEY_HEADER]: apiKey });
  return response.score;
};
