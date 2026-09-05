import OpenAI from 'openai';
import { Anthropic } from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { config } from '../config.js';
import { MEETING_ANALYSIS_PROMPT, EMAIL_DRAFT_PROMPT, LEAD_SCORING_PROMPT } from '../utils/prompts.js';

export interface AIProvider {
  analyzeMeeting(transcript: string): Promise<Record<string, unknown>>;
  generateEmailDraft?(transcript: string, context: Record<string, unknown>): Promise<Record<string, unknown>>;
  scoreLead(transcript: string, leadContext: Record<string, unknown>): Promise<Record<string, unknown>>;
}

import { z } from 'zod';
import { sanitizeObject } from '../utils/sanitize.js';
import { AppError } from '../middleware/errorHandler.js';

// Output schemas: constrain what the model may return so invalid
// scores / sentiment / emails are dropped instead of trusted blindly.
const ScoreSchema = z.number().int().min(0).max(100);
const OverallSchema = z.enum(['positive', 'negative', 'neutral']);
const EmailSchema = z.string().email().nullable();

const SentimentSchema = z
  .object({
    overall: OverallSchema,
    score: ScoreSchema,
    notes: z.string(),
  })
  .partial()
  .passthrough();

const LeadEntrySchema = z
  .object({
    name: z.string(),
    company: z.string(),
    role: z.string(),
    email: EmailSchema,
    score: ScoreSchema,
    stage: z.string(),
  })
  .partial()
  .passthrough();

const MeetingAnalysisSchema = z
  .object({
    summary: z.string(),
    actionItems: z.array(z.any()),
    sentiment: SentimentSchema,
    leads: z.array(LeadEntrySchema),
  })
  .partial()
  .passthrough();

const LeadScoreSchema = z
  .object({
    score: ScoreSchema,
    reasoning: z.string(),
    category: z.enum(['hot', 'warm', 'cold']),
  })
  .partial()
  .passthrough();

const EmailDraftSchema = z
  .object({
    subject: z.string(),
    body: z.string(),
  })
  .partial()
  .passthrough();

// Non-greedy, balanced-brace extraction: collect every balanced {...}
// candidate (respecting strings/escapes) plus fenced blocks, so a greedy
// /\{[\s\S]*\}/ match can no longer swallow trailing text / second object.
const extractJsonCandidates = (text: string): string[] => {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const t = s.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      candidates.push(t);
    }
  };

  if (!text || typeof text !== 'string') return candidates;
  push(text);

  // Markdown fences: ```json ... ``` or ``` ... ```
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRe.exec(text)) !== null) {
    push(fenceMatch[1]);
  }

  // Balanced-brace scan over the raw text.
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inStr: string | null = null;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === inStr) {
          inStr = null;
        }
      } else {
        if (ch === '"' || ch === "'" || ch === '`') {
          inStr = ch;
        } else if (ch === '{') {
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            push(text.slice(start, i + 1));
            break;
          }
        }
      }
    }
  }

  // Longest-first so the most complete object is tried before fragments.
  return candidates.sort((a, b) => b.length - a.length);
};

// Normalize one parsed object: drop invalid emails to null, drop invalid
// lead entries, drop invalid sentiment fields — then safeParse.
const validateAIOutput = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const obj = { ...(value as Record<string, unknown>) };

  if (Array.isArray(obj.leads)) {
    const kept: unknown[] = [];
    for (const entry of obj.leads as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue; // drop
      const lead = { ...(entry as Record<string, unknown>) };
      // Drop invalid email value -> null (never hallucinate/guess).
      if (lead.email !== undefined && lead.email !== null) {
        if (typeof lead.email !== 'string' || EmailSchema.safeParse(lead.email).success === false) {
          lead.email = null;
        }
      }
      const parsed = LeadEntrySchema.safeParse(lead);
      if (parsed.success) kept.push(parsed.data); // drop invalid leads
    }
    obj.leads = kept;
  }

  if (obj.sentiment !== undefined && typeof obj.sentiment === 'object' && obj.sentiment !== null) {
    const s = { ...(obj.sentiment as Record<string, unknown>) };
    if (s.overall !== undefined && OverallSchema.safeParse(s.overall).success === false) {
      delete s.overall; // drop invalid enum value
    }
    if (s.score !== undefined && ScoreSchema.safeParse(s.score).success === false) {
      delete s.score; // drop out-of-range / non-int score
    }
    obj.sentiment = s;
  }

  // Top-level score (lead-scoring prompt): drop if not int 0-100.
  if (obj.score !== undefined && obj.score !== null && ScoreSchema.safeParse(obj.score).success === false) {
    // Keep the key only if some schema accepts it without score; otherwise
    // remove it so a lone invalid score cannot pass validation.
    delete obj.score;
  }

  const schemas = [MeetingAnalysisSchema, LeadScoreSchema, EmailDraftSchema];
  for (const schema of schemas) {
    const result = schema.safeParse(obj);
    if (result.success) return result.data as Record<string, unknown>;
  }
  return null; // drop candidate, caller retries next
};

const parseAIResponse = (text: string) => {
  const candidates = extractJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const sanitized = sanitizeObject(parsed);
      const validated = validateAIOutput(sanitized);
      if (validated) return validated; // success
      // else: drop invalid candidate, retry next
    } catch {
      continue; // drop unparseable candidate, retry next
    }
  }
  throw new AppError('Failed to parse AI response as JSON', 500);
};

export class OpenAIProvider implements AIProvider {
  private client: OpenAI;
  
  constructor(apiKey: string) {
    const opts = config.isTest ? { apiKey: 'test-key', baseURL: 'http://localhost' } : { apiKey };
    this.client = new OpenAI(opts);
  }

  async analyzeMeeting(transcript: string) {
    const response = await this.client.chat.completions.create({
      model: config.ai.openaiModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: MEETING_ANALYSIS_PROMPT },
        { role: "user", content: transcript }
      ],
    });
    return parseAIResponse(response.choices[0].message.content || '');
  }
  
  async generateEmailDraft(transcript: string, context: Record<string, unknown>) {
    const response = await this.client.chat.completions.create({
      model: config.ai.openaiModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EMAIL_DRAFT_PROMPT },
        { role: "user", content: `Context: ${JSON.stringify(context)}\nTranscript: ${transcript}` }
      ],
    });
    return parseAIResponse(response.choices[0].message.content || '');
  }

  async scoreLead(transcript: string, leadContext: Record<string, unknown>) {
    const response = await this.client.chat.completions.create({
      model: config.ai.openaiModel,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: LEAD_SCORING_PROMPT },
        { role: "user", content: `Lead Context: ${JSON.stringify(leadContext)}\nTranscript: ${transcript}` }
      ],
    });
    return parseAIResponse(response.choices[0].message.content || '');
  }
}

export class AnthropicProvider implements AIProvider {
  private client: Anthropic;
  
  constructor(apiKey: string) {
    const opts = config.isTest ? { apiKey: 'test-key', baseURL: 'http://localhost' } : { apiKey };
    this.client = new Anthropic(opts);
  }

  async analyzeMeeting(transcript: string) {
    const response = await this.client.messages.create({
      model: config.ai.anthropicModel,
      max_tokens: 4096,
      system: MEETING_ANALYSIS_PROMPT,
      messages: [
        { role: "user", content: transcript },
        { role: "assistant", content: "{" }
      ],
    });
    return parseAIResponse("{" + (response.content[0] as { text: string }).text);
  }

  async generateEmailDraft(transcript: string, context: Record<string, unknown>) {
    const response = await this.client.messages.create({
      model: config.ai.anthropicModel,
      max_tokens: 1024,
      system: EMAIL_DRAFT_PROMPT,
      messages: [
        { role: "user", content: `Context: ${JSON.stringify(context)}\nTranscript: ${transcript}` },
        { role: "assistant", content: "{" }
      ],
    });
    return parseAIResponse("{" + (response.content[0] as { text: string }).text);
  }

  async scoreLead(transcript: string, leadContext: Record<string, unknown>) {
    const response = await this.client.messages.create({
      model: config.ai.anthropicModel,
      max_tokens: 1024,
      system: LEAD_SCORING_PROMPT,
      messages: [
        { role: "user", content: `Lead Context: ${JSON.stringify(leadContext)}\nTranscript: ${transcript}` },
        { role: "assistant", content: "{" }
      ],
    });
    return parseAIResponse("{" + (response.content[0] as { text: string }).text);
  }
}

export class GeminiProvider implements AIProvider {
  private client: GoogleGenAI;
  
  constructor(apiKey: string) {
    const opts = config.isTest ? { apiKey: 'test-key' } : { apiKey };
    this.client = new GoogleGenAI(opts);
  }

  async analyzeMeeting(transcript: string) {
    const response = await this.client.models.generateContent({
      model: config.ai.geminiModel,
      contents: transcript,
      config: {
        systemInstruction: MEETING_ANALYSIS_PROMPT,
        responseMimeType: "application/json"
      }
    });
    return parseAIResponse(response.text || '');
  }

  async generateEmailDraft(transcript: string, context: Record<string, unknown>) {
    const response = await this.client.models.generateContent({
      model: config.ai.geminiModel,
      contents: `Context: ${JSON.stringify(context)}\nTranscript: ${transcript}`,
      config: {
        systemInstruction: EMAIL_DRAFT_PROMPT,
        responseMimeType: "application/json"
      }
    });
    return parseAIResponse(response.text || '');
  }

  async scoreLead(transcript: string, leadContext: Record<string, unknown>) {
    const response = await this.client.models.generateContent({
      model: config.ai.geminiModel,
      contents: `Lead Context: ${JSON.stringify(leadContext)}\nTranscript: ${transcript}`,
      config: {
        systemInstruction: LEAD_SCORING_PROMPT,
        responseMimeType: "application/json"
      }
    });
    return parseAIResponse(response.text || '');
  }
}

export class AIFactory {
  static getProvider(model: string, apiKey: string): AIProvider {
    switch(model) {
      case 'openai': return new OpenAIProvider(apiKey);
      case 'anthropic': return new AnthropicProvider(apiKey);
      case 'gemini': return new GeminiProvider(apiKey);
      default: throw new AppError('Unsupported AI model', 400);
    }
  }
}
