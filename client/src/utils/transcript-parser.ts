import { TranscriptSegment } from '../types';

export interface ParsedTranscript {
  segments: TranscriptSegment[];
  fullText: string;
  durationSeconds: number;
}

const SPEAKER_LINE = /^([\p{L}\p{N} .\-'’]+?)\s*:\s*(.+)$/u;
const SRT_TIMESTAMP = /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})/;
const VTT_TIMESTAMP = /^(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})/;
const VTT_SPEAKER = /<v\s+([^>]+)>([\s\S]*?)<\/v>/;

const toSeconds = (h: number, m: number, s: number, ms: number) => h * 3600 + m * 60 + s + ms / 1000;

function normalizeContent(content: string): string {
  // Strip BOM, normalize \r\n and lone \r to \n
  return content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function isValidSpeaker(label: string, body: string): boolean {
  if (!label || !body) return false;
  // Reject URL-like speakers: contains ://, / or \
  if (label.includes('://') || label.includes('/') || label.includes('\\')) return false;
  // Reject when body is URL continuation (e.g. "https" + "://...".split -> "//...")
  if (body.startsWith('//')) return false;
  // Speaker must contain at least one letter (reject timestamps like "12:30")
  if (!/\p{L}/u.test(label)) return false;
  // Reject absurdly long "speakers" (sentences with colons)
  if (label.length > 40) return false;
  return true;
}

function extractSpeaker(text: string): { speaker?: string; text: string } {
  const vttMatch = VTT_SPEAKER.exec(text);
  if (vttMatch) {
    const speaker = vttMatch[1].trim();
    const body = vttMatch[2].trim();
    if (speaker && body && !speaker.includes('://') && !speaker.includes('/')) {
      return { speaker, text: body };
    }
    return { text: body };
  }
  const trimmed = text.trim();
  if (!trimmed) return { text: '' };
  // Handle multiline cues: only the first line can hold "Speaker: ..."
  const nl = trimmed.indexOf('\n');
  const firstLine = (nl === -1 ? trimmed : trimmed.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : trimmed.slice(nl + 1).trim();
  const plainMatch = SPEAKER_LINE.exec(firstLine);
  if (plainMatch) {
    const label = plainMatch[1].trim();
    const bodyFirst = plainMatch[2].trim();
    if (isValidSpeaker(label, bodyFirst)) {
      const full = rest ? `${bodyFirst}\n${rest}` : bodyFirst;
      return { speaker: label, text: full };
    }
  }
  return { text: trimmed };
}

export function parseTranscriptFile(filename: string, content: string): ParsedTranscript {
  const extension = (filename.split('.').pop() || '').toLowerCase();
  if (extension === 'srt' || extension === 'vtt') {
    return parseTimedTranscript(content, extension === 'srt');
  }
  return parsePlainText(content);
}

function parseTimedTranscript(content: string, isSrt: boolean): ParsedTranscript {
  const normalized = normalizeContent(content);
  if (!normalized.trim()) return buildResult([]);
  const lines = normalized.split('\n');
  const segments: TranscriptSegment[] = [];
  let i = 0;

  if (!isSrt) {
    // Skip WEBVTT header / NOTE blocks
    while (i < lines.length && !VTT_TIMESTAMP.test(lines[i].trim())) i++;
  }

  while (i < lines.length) {
    const line = lines[i].trim();
    const match = VTT_TIMESTAMP.exec(line) || SRT_TIMESTAMP.exec(line);
    if (match) {
      const [, h1, m1, s1, ms1, h2, m2, s2, ms2] = match;
      const start = toSeconds(Number(h1), Number(m1), Number(s1), Number(ms1));
      const end = toSeconds(Number(h2), Number(m2), Number(s2), Number(ms2));
      i++;
      const textLines: string[] = [];
      while (i < lines.length && lines[i].trim() !== '' && !VTT_TIMESTAMP.test(lines[i].trim()) && !SRT_TIMESTAMP.test(lines[i].trim())) {
        textLines.push(lines[i].trim());
        i++;
      }
      const raw = textLines.join('\n');
      const { speaker, text } = extractSpeaker(raw);
      if (text) {
        segments.push({ speaker: speaker || `Speaker ${segments.length + 1}`, text, startTime: start, endTime: end });
      }
    } else {
      i++;
    }
  }

  return buildResult(segments);
}

function parsePlainText(content: string): ParsedTranscript {
  const normalized = normalizeContent(content);
  if (!normalized.trim()) return buildResult([]);
  const lines = normalized.split('\n');
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const speakerMatch = SPEAKER_LINE.exec(line);
    if (speakerMatch) {
      const label = speakerMatch[1].trim();
      const body = speakerMatch[2].trim();
      if (!isValidSpeaker(label, body)) {
        // URL or invalid speaker-looking line: treat as continuation/body, not a new turn
        if (current) {
          current.text += '\n' + line;
        } else {
          segments.push({ speaker: 'Speaker 1', text: line, startTime: 0, endTime: 0 });
        }
        continue;
      }
      if (current) segments.push(current);
      current = {
        speaker: label,
        text: body,
        startTime: 0,
        endTime: 0,
      };
    } else if (current) {
      current.text += '\n' + line;
    } else {
      segments.push({ speaker: 'Speaker 1', text: line, startTime: 0, endTime: 0 });
    }
  }
  if (current) segments.push(current);

  return buildResult(segments);
}

function buildResult(segments: TranscriptSegment[]): ParsedTranscript {
  const fullText = segments.map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text)).join('\n\n');
  const durationSeconds = segments.length > 0 ? Math.max(0, segments[segments.length - 1].endTime) : 0;
  return { segments, fullText, durationSeconds };
}
