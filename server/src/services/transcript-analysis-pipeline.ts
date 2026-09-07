import { Server } from 'socket.io';
import { analyzeMeeting } from './ai-service.js';
import bufferService from './buffer-service.js';
import { getDailyAnalysisCount, getMonthlyAnalysisCount, recordAnalysisUsage, DAILY_ANALYSIS_LIMIT, FREE_ANALYSIS_LIMIT } from './usage-service.js';
import log from '../utils/logger.js';

interface TranscriptSegment {
  id: string;
  speaker: string;
  text: string;
  startTime: number;
  endTime: number;
  timestamp: string;
  source: string;
}

interface Suggestion {
  title: string;
  content: string;
}

interface Lead {
  name?: string;
  company?: string;
  role?: string;
  email?: string | null;
  score?: number;
  stage?: string;
  [key: string]: unknown;
}

interface MeetingPipeline {
  meetingId: string;
  ownerUid?: string;
  intervalId: NodeJS.Timeout;
  lastAnalyzedIndex: number;
  isActive: boolean;
}

const MAX_TRANSCRIPT_CHARS = 12000;

class TranscriptAnalysisPipeline {
  private pipelines: Map<string, MeetingPipeline> = new Map();
  private io: Server | null = null;
  private analysisIntervalMs: number = 45000; // 45 seconds
  private isInitialized: boolean = false;

  initialize(io: Server): void {
    this.io = io;
    this.isInitialized = true;
    log.info('Transcript analysis pipeline initialized');
  }

  startPipeline(meetingId: string, ownerUid?: string): void {
    if (!this.isInitialized) {
      log.warn('Pipeline not initialized, cannot start pipeline', { meetingId });
      return;
    }

    if (this.pipelines.has(meetingId)) {
      log.warn('Pipeline already running for meeting', { meetingId });
      return;
    }

    const pipeline: MeetingPipeline = {
      meetingId,
      ownerUid,
      intervalId: setInterval(() => this.analyzeTranscript(meetingId), this.analysisIntervalMs),
      lastAnalyzedIndex: 0,
      isActive: true
    };

    this.pipelines.set(meetingId, pipeline);
    log.info('Transcript analysis pipeline started', { meetingId, intervalMs: this.analysisIntervalMs });
  }

  stopPipeline(meetingId: string): void {
    const pipeline = this.pipelines.get(meetingId);
    if (pipeline) {
      clearInterval(pipeline.intervalId);
      pipeline.isActive = false;
      this.pipelines.delete(meetingId);
      log.info('Transcript analysis pipeline stopped', { meetingId });
    }
  }

  private async analyzeTranscript(meetingId: string): Promise<void> {
    const pipeline = this.pipelines.get(meetingId);
    if (!pipeline || !pipeline.isActive) {
      return;
    }

    try {
      const transcriptData = await bufferService.get<{ segments: TranscriptSegment[] }>(`transcript:${meetingId}`);
      
      if (!transcriptData || !transcriptData.segments || transcriptData.segments.length === 0) {
        log.info('No transcript segments available for analysis', { meetingId });
        return;
      }

      const newSegments = transcriptData.segments.slice(pipeline.lastAnalyzedIndex);
      
      if (newSegments.length < 3) {
        log.info('Not enough new segments for analysis', { 
          meetingId, 
          newSegments: newSegments.length,
          totalSegments: transcriptData.segments.length 
        });
        return;
      }

      // Cost guard: send only the delta since last analysis, capped at 12k chars.
      const deltaTranscript = this.formatTranscript(newSegments).slice(-MAX_TRANSCRIPT_CHARS);
      const apiKey = this.getApiKey();
      
      if (!apiKey) {
        log.error('No AI API key configured for transcript analysis');
        return;
      }

      // Fail-closed: never fall back to meetingId (would grant per-meeting quota bypass).
      const quotaUid = pipeline.ownerUid ?? await this.resolveOwnerUid(meetingId);
      if (!quotaUid) {
        log.warn('Owner unresolved, skipping AI analysis (fail-closed)', { meetingId });
        return;
      }
      const [dailyCount, monthlyCount] = await Promise.all([
        getDailyAnalysisCount(quotaUid),
        getMonthlyAnalysisCount(quotaUid),
      ]);
      if (dailyCount >= DAILY_ANALYSIS_LIMIT) {
        log.warn('Daily analysis quota exceeded, skipping AI analysis', { meetingId, dailyCount, limit: DAILY_ANALYSIS_LIMIT });
        return;
      }
      if (monthlyCount >= FREE_ANALYSIS_LIMIT) {
        log.warn('Monthly analysis quota exceeded, skipping AI analysis', { meetingId, monthlyCount, limit: FREE_ANALYSIS_LIMIT });
        return;
      }

      const analysisResult = await this.performAnalysis(deltaTranscript, apiKey);
      
      if (analysisResult) {
        // Record usage so live-meeting server-key burns count toward quota.
        // Best-effort: never block emit on usage-write failure.
        try {
          await recordAnalysisUsage(quotaUid, meetingId);
        } catch (usageErr) {
          log.warn('Failed to record pipeline analysis usage', {
            meetingId,
            error: usageErr instanceof Error ? usageErr.message : usageErr,
          });
        }
        if (analysisResult.suggestions) {
          await this.emitSuggestions(meetingId, analysisResult.suggestions);
        }
        if (analysisResult.leads && analysisResult.leads.length > 0) {
          await this.persistLeads(meetingId, analysisResult.leads);
        }

        pipeline.lastAnalyzedIndex = transcriptData.segments.length;
        log.info('Transcript analysis completed', { 
          meetingId, 
          segmentsAnalyzed: newSegments.length,
          totalSegments: transcriptData.segments.length,
          suggestionsGenerated: analysisResult?.suggestions?.length || 0,
          leadsGenerated: analysisResult?.leads?.length || 0
        });
      } else {
        log.warn('Transcript analysis failed, cursor not advanced - will retry on next interval', {
          meetingId,
          pendingSegments: newSegments.length,
          lastAnalyzedIndex: pipeline.lastAnalyzedIndex
        });
      }

    } catch (error) {
      log.error('Error analyzing transcript', { meetingId, error: error instanceof Error ? error.message : error });
    }
  }

  private async resolveOwnerUid(meetingId: string): Promise<string | null> {
    try {
      const meta = await bufferService.get<{ uid?: unknown; ownerUid?: unknown; userId?: unknown; owner?: unknown }>(`meeting:${meetingId}`);
      if (!meta || typeof meta !== 'object') return null;
      for (const key of ['ownerUid', 'uid', 'userId', 'owner'] as const) {
        const value = meta[key];
        if (typeof value === 'string' && value.length > 0) return value;
      }
      return null;
    } catch {
      return null;
    }
  }

  private formatTranscript(segments: TranscriptSegment[]): string {
    return segments.map(segment => 
      `[${segment.speaker}]: ${segment.text}`
    ).join('\n');
  }

  private getApiKey(): string | null {
    if (process.env.OPENAI_API_KEY) {
      return process.env.OPENAI_API_KEY;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      return process.env.ANTHROPIC_API_KEY;
    }
    if (process.env.GEMINI_API_KEY) {
      return process.env.GEMINI_API_KEY;
    }
    return null;
  }

  private getAIModel(): string {
    if (process.env.OPENAI_API_KEY) {
      return 'openai';
    }
    if (process.env.ANTHROPIC_API_KEY) {
      return 'anthropic';
    }
    if (process.env.GEMINI_API_KEY) {
      return 'gemini';
    }
    return 'openai';
  }

  private async performAnalysis(transcript: string, apiKey: string): Promise<{ suggestions: Suggestion[]; leads: Lead[] } | null> {
    try {
      const model = this.getAIModel();
      const result = await analyzeMeeting(transcript, model, apiKey);
      
      if (result && typeof result === 'object') {
        return this.extractSuggestions(result);
      }
      return null;
    } catch (error) {
      log.error('AI analysis failed', { error: error instanceof Error ? error.message : error });
      return null;
    }
  }

  private extractSuggestions(analysisResult: Record<string, unknown>): { suggestions: Suggestion[]; leads: Lead[] } {
    const suggestions: Suggestion[] = [];
    
    if (analysisResult.actionItems && Array.isArray(analysisResult.actionItems)) {
      for (const item of analysisResult.actionItems) {
        if (item && typeof item === 'object' && 'task' in item) {
          const actionItem = item as { task: string; assignee?: string };
          suggestions.push({
            title: 'Action Item',
            content: actionItem.assignee 
              ? `${actionItem.task} (Assigned to: ${actionItem.assignee})`
              : actionItem.task
          });
        }
      }
    }

    if (analysisResult.summary) {
      suggestions.push({
        title: 'Meeting Summary',
        content: String(analysisResult.summary)
      });
    }

    if (analysisResult.sentiment && typeof analysisResult.sentiment === 'object') {
      const sentiment = analysisResult.sentiment as { overall: string; notes?: string };
      if (sentiment.notes) {
        suggestions.push({
          title: 'Meeting Sentiment',
          content: `${sentiment.overall}: ${sentiment.notes}`
        });
      }
    }

    if (analysisResult.nextSteps && Array.isArray(analysisResult.nextSteps)) {
      for (const step of analysisResult.nextSteps) {
        if (typeof step === 'string') {
          suggestions.push({
            title: 'Next Step',
            content: step
          });
        }
      }
    }

    if (analysisResult.followUps && Array.isArray(analysisResult.followUps)) {
      for (const followUp of analysisResult.followUps) {
        if (typeof followUp === 'string') {
          suggestions.push({
            title: 'Follow-up',
            content: followUp
          });
        }
      }
    }

    let leads: Lead[] = [];
    if (analysisResult.leads && Array.isArray(analysisResult.leads)) {
      leads = (analysisResult.leads as unknown[]).filter(
        (entry): entry is Lead => typeof entry === 'object' && entry !== null
      );
    }

    return { suggestions, leads };
  }

  private async emitSuggestions(meetingId: string, suggestions: Suggestion[]): Promise<void> {
    if (!this.io || suggestions.length === 0) {
      return;
    }

    for (const suggestion of suggestions) {
      this.io.to(`meeting:${meetingId}`).emit('ai_suggestion', suggestion);
    }
    
    log.info('Suggestions emitted via WebSocket', { 
      meetingId, 
      suggestionCount: suggestions.length 
    });
  }

  private async persistLeads(meetingId: string, leads: Lead[]): Promise<void> {
    if (!leads || leads.length === 0) {
      return;
    }
    try {
      const key = `leads:${meetingId}`;
      const existing = (await bufferService.get<{ leads: Lead[] }>(key)) || { leads: [] };
      existing.leads.push(...leads);
      await bufferService.store(key, existing);
      if (this.io) {
        for (const lead of leads) {
          this.io.to(`meeting:${meetingId}`).emit('lead_detected', lead);
        }
      }
      log.info('Leads persisted and emitted', { meetingId, leadCount: leads.length });
    } catch (error) {
      log.error('Failed to persist leads', { meetingId, error: error instanceof Error ? error.message : error });
    }
  }

  shutdown(): void {
    for (const [meetingId, pipeline] of this.pipelines) {
      clearInterval(pipeline.intervalId);
      pipeline.isActive = false;
    }
    this.pipelines.clear();
    this.io = null;
    this.isInitialized = false;
    log.info('Transcript analysis pipeline shut down');
  }

  getActivePipelines(): string[] {
    return Array.from(this.pipelines.keys());
  }

  isPipelineActive(meetingId: string): boolean {
    const pipeline = this.pipelines.get(meetingId);
    return pipeline ? pipeline.isActive : false;
  }
}

export default new TranscriptAnalysisPipeline();
