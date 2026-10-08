import { db } from './db';
import { meetingsDB } from './meetings';
import { leadsDB } from './leads';
import { dealsDB } from './deals';
import { emailsDB } from './emails';
import { trackingDB } from './tracking';
import { z } from 'zod';
import { Meeting, Transcript, Analysis, Lead, Deal, EmailCampaign, EmailTracking, DripCampaign, Setting } from '../../types';

export interface BackupData {
  meetings?: Meeting[];
  transcripts?: Transcript[];
  aiAnalysis?: Analysis[];
  leads?: Lead[];
  deals?: Deal[];
  emails?: EmailCampaign[];
  tracking?: EmailTracking[];
  dripCampaigns?: DripCampaign[];
  settings?: Setting[];
  exportedAt?: string;
}

export const exportAllData = async (): Promise<BackupData> => {
  const [meetings, transcripts, aiAnalysis, leads, deals, emails, tracking, dripCampaigns, settings] = await Promise.all([
    meetingsDB.getAll(),
    db.transcripts.toArray(),
    db.ai_analysis.toArray(),
    leadsDB.getAll(),
    dealsDB.getAll(),
    emailsDB.getAll(),
    trackingDB.getAll(),
    db.drip_campaigns.toArray(),
    db.settings.toArray(),
  ]);
  return { meetings, transcripts, aiAnalysis, leads, deals, emails, tracking, dripCampaigns, settings, exportedAt: new Date().toISOString() };
};

export const importData = async (data: BackupData): Promise<void> => {
  // Defense in depth: validate even programmatic callers — never bulkPut
  // unsanitized objects into IndexedDB (prototype pollution / oversized rows
  // / foreign settings keys).
  const clean = parseAndValidateBackupData(data);
  if (clean.meetings) await db.meetings.bulkPut(clean.meetings);
  if (clean.transcripts) await db.transcripts.bulkPut(clean.transcripts);
  if (clean.aiAnalysis) await db.ai_analysis.bulkPut(clean.aiAnalysis);
  if (clean.leads) await db.leads.bulkPut(clean.leads);
  if (clean.deals) await db.deals.bulkPut(clean.deals);
  if (clean.emails) await db.email_campaigns.bulkPut(clean.emails);
  if (clean.tracking) await db.email_tracking.bulkPut(clean.tracking);
  if (clean.dripCampaigns) await db.drip_campaigns.bulkPut(clean.dripCampaigns);
  if (clean.settings) await db.settings.bulkPut(clean.settings);
};

export const downloadJSON = (data: BackupData, filename = `dealforge-backup-${new Date().toISOString().split('T')[0]}.json`): void => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
};

export interface StorageUsage {
  used: number;
  quota: number;
  percent: string;
}

export const getStorageUsage = async (): Promise<StorageUsage | null> => {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate();
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    return { used: usage, quota: quota, percent: quota > 0 ? ((usage / quota) * 100).toFixed(1) : '0' };
  }
  return null;
};

export const requestPersistence = async (): Promise<boolean> => {
  if (navigator.storage && navigator.storage.persist) {
    return navigator.storage.persist();
  }
  return false;
};

export const importFromJSONFile = async (file: File): Promise<void> => {
  if (file.size > MAX_BACKUP_FILE_BYTES) {
    throw new Error(
      `Backup file too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 20MB.`,
    );
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const text = e.target?.result as string;
        if (typeof text !== 'string' || text.length > MAX_BACKUP_FILE_BYTES) {
          throw new Error('Backup file too large. Maximum is 20MB.');
        }
        const parsed: unknown = JSON.parse(text);
        const clean = parseAndValidateBackupData(parsed);
        await importValidatedData(clean);
        resolve();
      } catch (err: unknown) {
        reject(err instanceof Error ? err : new Error('Invalid backup file'));
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
};

/**
 * Write already-validated backup data to IndexedDB. Prefer importData()
 * (which validates); use this only when the payload came from
 * parseAndValidateBackupData().
 */
export const importValidatedData = async (data: BackupData): Promise<void> => {
  if (data.meetings) await db.meetings.bulkPut(data.meetings);
  if (data.transcripts) await db.transcripts.bulkPut(data.transcripts);
  if (data.aiAnalysis) await db.ai_analysis.bulkPut(data.aiAnalysis);
  if (data.leads) await db.leads.bulkPut(data.leads);
  if (data.deals) await db.deals.bulkPut(data.deals);
  if (data.emails) await db.email_campaigns.bulkPut(data.emails);
  if (data.tracking) await db.email_tracking.bulkPut(data.tracking);
  if (data.dripCampaigns) await db.drip_campaigns.bulkPut(data.dripCampaigns);
  if (data.settings) await db.settings.bulkPut(data.settings);
};

// ---------------------------------------------------------------------------
// Import validation (zod): file-size cap, array caps, settings allowlist.
// ---------------------------------------------------------------------------

/** Reject backup files larger than 20MB before JSON.parse / bulkPut. */
export const MAX_BACKUP_FILE_BYTES = 20 * 1024 * 1024;
/** Per-collection cap: prevents OOM / quota-exhaustion via crafted files. */
export const MAX_ARRAY_ITEMS = 10_000;
/** Settings rows cap. */
const MAX_SETTINGS_ITEMS = 200;

/**
 * Settings keys that may be restored from a backup. Everything else is
 * dropped on import — notably `backup_dir_handle` (a live FileSystem handle
 * that cannot survive JSON and must never be resurrected) and any unknown
 * key an attacker could use to plant privileged flags.
 */
export const SETTINGS_IMPORT_ALLOWLIST: ReadonlySet<string> = new Set([
  'onboarding_complete',
  'pipeline_stages',
  'dealforge_encrypted_keys',
  'last_auto_backup',
  'dealforge_referral_code',
  'dealforge_referral_benefits',
  'dealforge_referral_claimed',
  'dealforge_referral_pending',
  'dealforge_api_sync_enabled',
  'dealforge_api_last_synced',
]);

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const idField = z.string().min(1).max(256);
const shortText = z.string().max(2000);
const longText = z.string().max(1_000_000);

const meetingSchema = z.object({
  id: idField,
  zoomMeetingId: z.string().max(256).optional().default(''),
  title: z.string().max(500).optional().default(''),
  startTime: z.string().max(100).optional().default(''),
  endTime: z.string().max(100).optional().default(''),
  duration: z.number().finite().min(0).max(86400 * 7).optional().default(0),
  status: z.string().max(64).optional().default('completed'),
}).passthrough();

const transcriptSegmentSchema = z.object({
  speaker: z.string().max(256).optional().default(''),
  text: z.string().max(50_000).optional().default(''),
  startTime: z.number().finite().min(0).max(1e9).optional().default(0),
  endTime: z.number().finite().min(0).max(1e9).optional().default(0),
}).passthrough();

const transcriptSchema = z.object({
  id: idField,
  meetingId: z.string().max(256),
  segments: z.array(transcriptSegmentSchema).max(5000).optional().default([]),
  fullText: longText.optional().default(''),
  createdAt: z.string().max(100).optional().default(''),
}).passthrough();

const analysisSchema = z.object({
  id: idField,
  meetingId: z.string().max(256),
  summary: z.string().max(200_000).optional().default(''),
  actionItems: z.array(z.string().max(5000)).max(500).optional().default([]),
  sentiment: z.object({
    positive: z.number().finite().min(0).max(1).optional().default(0),
    neutral: z.number().finite().min(0).max(1).optional().default(0),
    negative: z.number().finite().min(0).max(1).optional().default(0),
    overall: z.string().max(64).optional().default('neutral'),
  }).passthrough().optional().default({ positive: 0, neutral: 0, negative: 0, overall: 'neutral' }),
  leadScore: z.number().finite().min(0).max(100).optional().default(0),
  emailDraft: z.string().max(200_000).nullable().optional().default(null),
  modelUsed: z.string().max(128).optional().default(''),
  analyzedAt: z.string().max(100).optional().default(''),
}).passthrough();

const leadSchema = z.object({
  id: idField,
  meetingId: z.string().max(256).optional().default(''),
  name: z.string().max(256).optional().default(''),
  email: z.string().max(320).optional().default(''),
  company: z.string().max(256).optional().default(''),
  role: z.string().max(256).optional().default(''),
  score: z.number().finite().min(0).max(100).optional().default(0),
  stage: z.string().max(128).optional().default(''),
  reasoning: z.string().max(50_000).optional(),
  tags: z.array(z.string().max(128)).max(100).optional(),
  consentStatus: z.string().max(64).optional(),
  consentSource: z.string().max(256).optional(),
  consentCapturedAt: z.string().max(100).optional(),
  consentBasis: z.string().max(256).optional(),
  unsubscribedAt: z.string().max(100).optional(),
  createdAt: z.string().max(100).optional().default(''),
  updatedAt: z.string().max(100).optional().default(''),
}).passthrough();

const dealSchema = z.object({
  id: idField,
  leadId: z.string().max(256),
  title: z.string().max(500).optional().default(''),
  stage: z.string().max(128).optional().default(''),
  value: z.number().finite().min(0).max(1e15).optional().default(0),
  probability: z.number().finite().min(0).max(100).optional().default(0),
  expectedClose: z.string().max(100).optional().default(''),
  notes: z.array(z.object({ text: z.string().max(20_000), author: z.string().max(256).optional().default(''), createdAt: z.string().max(100).optional().default('') }).passthrough()).max(500).optional().default([]),
  createdAt: z.string().max(100).optional().default(''),
  updatedAt: z.string().max(100).optional().default(''),
}).passthrough();

const emailCampaignSchema = z.object({
  id: idField,
  leadId: z.string().max(256).optional().default(''),
  subject: z.string().max(1000).optional().default(''),
  body: z.string().max(500_000).optional().default(''),
  status: z.string().max(64).optional().default('draft'),
  type: z.string().max(64).optional().default(''),
  sequence: z.array(z.object({
    subject: z.string().max(1000).optional().default(''),
    body: z.string().max(500_000).optional().default(''),
    delayDays: z.number().finite().min(0).max(3650).optional().default(0),
  }).passthrough()).max(50).optional().default([]),
  scheduledAt: z.string().max(100).optional().default(''),
  sentAt: z.string().max(100).optional(),
  createdAt: z.number().finite().optional(),
}).passthrough();

const trackingSchema = z.object({
  id: idField,
  campaignId: z.string().max(256),
  opens: z.number().int().min(0).max(1e9).optional().default(0),
  clicks: z.number().int().min(0).max(1e9).optional().default(0),
  replied: z.number().int().min(0).max(1e9).optional().default(0),
  lastActivity: z.string().max(100).nullable().optional().default(null),
}).passthrough();

const dripCampaignSchema = z.object({
  id: idField,
  leadId: z.string().max(256).optional().default(''),
  name: z.string().max(500).optional().default(''),
  status: z.string().max(64).optional().default('paused'),
  currentStep: z.number().int().min(0).max(10000).optional().default(0),
  totalSteps: z.number().int().min(0).max(10000).optional(),
  nextRunAt: z.number().finite().nullable().optional().default(null),
  createdAt: z.number().finite().optional().default(0),
  error: z.string().max(5000).optional(),
}).passthrough();

const settingSchema = z.object({
  key: z.string().min(1).max(128),
  value: z.unknown(),
}).passthrough();

const backupDataSchema = z.object({
  meetings: z.array(meetingSchema).max(MAX_ARRAY_ITEMS).optional(),
  transcripts: z.array(transcriptSchema).max(MAX_ARRAY_ITEMS).optional(),
  aiAnalysis: z.array(analysisSchema).max(MAX_ARRAY_ITEMS).optional(),
  leads: z.array(leadSchema).max(MAX_ARRAY_ITEMS).optional(),
  deals: z.array(dealSchema).max(MAX_ARRAY_ITEMS).optional(),
  emails: z.array(emailCampaignSchema).max(MAX_ARRAY_ITEMS).optional(),
  tracking: z.array(trackingSchema).max(MAX_ARRAY_ITEMS).optional(),
  dripCampaigns: z.array(dripCampaignSchema).max(MAX_ARRAY_ITEMS).optional(),
  settings: z.array(settingSchema).max(MAX_SETTINGS_ITEMS).optional(),
  exportedAt: z.string().max(100).optional(),
}).strict();

/**
 * Validate + sanitize untrusted backup JSON. Throws on schema violation.
 * Settings are allowlisted (unknown keys dropped) and __proto__/constructor
 * keys rejected to block prototype pollution.
 */
export function parseAndValidateBackupData(input: unknown): BackupData {
  const parsed = backupDataSchema.parse(input);
  let settings: Setting[] | undefined;
  if (parsed.settings) {
    const clean: Setting[] = [];
    for (const row of parsed.settings) {
      if (DANGEROUS_KEYS.has(row.key)) continue;
      if (!SETTINGS_IMPORT_ALLOWLIST.has(row.key)) continue;
      if (row.key === 'backup_dir_handle') continue;
      clean.push({ key: row.key, value: row.value });
    }
    if (clean.length) settings = clean;
  }
  return {
    ...(parsed.meetings ? { meetings: parsed.meetings as Meeting[] } : {}),
    ...(parsed.transcripts ? { transcripts: parsed.transcripts as Transcript[] } : {}),
    ...(parsed.aiAnalysis ? { aiAnalysis: parsed.aiAnalysis as Analysis[] } : {}),
    ...(parsed.leads ? { leads: parsed.leads as Lead[] } : {}),
    ...(parsed.deals ? { deals: parsed.deals as Deal[] } : {}),
    ...(parsed.emails ? { emails: parsed.emails as EmailCampaign[] } : {}),
    ...(parsed.tracking ? { tracking: parsed.tracking as EmailTracking[] } : {}),
    ...(parsed.dripCampaigns ? { dripCampaigns: parsed.dripCampaigns as DripCampaign[] } : {}),
    ...(settings ? { settings } : {}),
    ...(parsed.exportedAt ? { exportedAt: parsed.exportedAt } : {}),
  };
}

export const selectBackupDirectory = async (): Promise<FileSystemDirectoryHandle> => {
  if (!('showDirectoryPicker' in window)) {
    throw new Error('File System Access API not supported in this browser.');
  }
  const handle = await (window as unknown as { showDirectoryPicker: (opts: { mode: string }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite' });
  await db.settings.put({ key: 'backup_dir_handle', value: handle });
  return handle;
};

// Minimal File System Access API surface (DOM lib may not include queryPermission).
interface PermissionHandle {
  queryPermission: (opts: { mode: string }) => Promise<string>;
  requestPermission: (opts: { mode: string }) => Promise<string>;
}

interface BackupDirHandle extends PermissionHandle {
  getFileHandle: (name: string, opts: { create: boolean }) => Promise<{
    createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }>;
  }>;
}

export const verifyPermission = async (fileHandle: PermissionHandle, readWrite: boolean = true) => {
  const options = { mode: readWrite ? 'readwrite' : 'read' } as const;
  if ((await fileHandle.queryPermission(options)) === 'granted') {
    return true;
  }
  if ((await fileHandle.requestPermission(options)) === 'granted') {
    return true;
  }
  return false;
};

export const runAutoBackup = async (handle: BackupDirHandle): Promise<boolean> => {
  try {
    const hasPermission = await verifyPermission(handle, true);
    if (!hasPermission) return false;
    
    const data = await exportAllData();
    const filename = `dealforge-autobackup-${new Date().toISOString().split('T')[0]}.json`;
    
    const fileHandle = await handle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
    
    await db.settings.put({ key: 'last_auto_backup', value: Date.now() });
    return true;
  } catch {
    // Best-effort backup; callers surface failure via return value.
    return false;
  }
};

