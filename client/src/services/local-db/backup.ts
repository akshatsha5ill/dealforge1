import { db } from './db';
import { meetingsDB } from './meetings';
import { leadsDB } from './leads';
import { dealsDB } from './deals';
import { emailsDB } from './emails';
import { trackingDB } from './tracking';
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
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        await importData(data);
        resolve();
      } catch (err: any) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
};

export const selectBackupDirectory = async (): Promise<any> => {
  if (!('showDirectoryPicker' in window)) {
    throw new Error('File System Access API not supported in this browser.');
  }
  // @ts-ignore
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await db.settings.put({ key: 'backup_dir_handle', value: handle });
  return handle;
};

export const verifyPermission = async (fileHandle: any, readWrite: boolean = true) => {
  const options = { mode: readWrite ? 'readwrite' : 'read' };
  if ((await fileHandle.queryPermission(options)) === 'granted') {
    return true;
  }
  if ((await fileHandle.requestPermission(options)) === 'granted') {
    return true;
  }
  return false;
};

export const runAutoBackup = async (handle: any): Promise<boolean> => {
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
  } catch (err) {
    console.error('Auto backup failed', err);
    return false;
  }
};

