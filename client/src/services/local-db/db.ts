import Dexie, { Table } from 'dexie';
import { Meeting, Transcript, Analysis, Lead, Deal, EmailCampaign, EmailTracking, DripCampaign, Setting } from '../../types';

/**
 * Storage threat model (documented):
 * - IndexedDB (Dexie) stores PII (meetings, transcripts, leads, deals, emails)
 *   in PLAINTEXT at rest. Browser IndexedDB has no OS-level encryption
 *   guarantee; anyone with device/filesystem access can read it.
 * - API keys ARE encrypted at rest via WebCrypto AES-256-GCM + PBKDF2
 *   (600k iterations, see client/src/crypto/key-vault.ts) — only the
 *   ciphertext is stored in the `settings` table.
 * - Mitigations: (1) wipe-on-logout via wipeLocalData() below (IndexedDB +
 *   localStorage + Firebase persistence), (2) user-driven Delete All Data in
 *   Settings, (3) requestPersistence() to avoid eviction confusion.
 * - Full per-record DB encryption (e.g. dexie-encrypted, libsodium
 *   secretbox, or WebCrypto AES-GCM envelope per row) is deferred: it
 *   requires a user-supplied unlock key on every load and key-rotation
 *   story. If needed, prefer WebCrypto AES-GCM + PBKDF2 (already used for
 *   key-vault) or `dexie-encrypted` with a non-extractable CryptoKey.
 */
export class DealForgeDatabase extends Dexie {
  meetings!: Table<Meeting, string>;
  transcripts!: Table<Transcript, string>;
  ai_analysis!: Table<Analysis, string>;
  leads!: Table<Lead, string>;
  deals!: Table<Deal, string>;
  email_campaigns!: Table<EmailCampaign, string>;
  email_tracking!: Table<EmailTracking, string>;
  settings!: Table<Setting, string>;
  drip_campaigns!: Table<DripCampaign, string>;

  constructor() {
    super('DealForgeDB');

    this.version(1).stores({
      meetings: 'id, zoomMeetingId, title, startTime, endTime, duration, status',
      transcripts: 'id, meetingId, createdAt',
      ai_analysis: 'id, meetingId, leadScore, analyzedAt',
      leads: 'id, meetingId, name, email, company, role, score, stage, createdAt',
      deals: 'id, leadId, title, stage, value, probability, expectedClose, createdAt',
      email_campaigns: 'id, leadId, subject, status, type, scheduledAt, sentAt',
      email_tracking: 'id, campaignId, opens, clicks, replied, lastActivity'
    });

    this.version(2).stores({
      meetings: 'id, zoomMeetingId, title, startTime, endTime, duration, status, [status+startTime]',
      leads: 'id, meetingId, name, email, company, role, score, stage, createdAt, [stage+createdAt]',
      settings: 'key'
    }).upgrade(_tx => {
      // Indexes added, no data migration needed
    });

    this.version(3).stores({
      drip_campaigns: 'id, leadId, name, status, currentStep, nextRunAt, createdAt'
    }).upgrade(_tx => {
    });

    // Version 4: Optimize indexes by removing bloated/unused indexes 
    // to improve write performance and reduce storage footprint.
    this.version(4).stores({
      meetings: 'id, zoomMeetingId, startTime, status, [status+startTime]',
      transcripts: 'id, meetingId',
      ai_analysis: 'id, meetingId',
      leads: 'id, meetingId, stage, createdAt, [stage+createdAt]',
      deals: 'id, leadId, stage',
      email_campaigns: 'id, leadId, status',
      email_tracking: 'id, campaignId',
      drip_campaigns: 'id, leadId, status'
    }).upgrade(_tx => {
      // Dropping unneeded indexes to optimize writes and storage size
    });
  }
}

export const db = new DealForgeDatabase();

// LocalStorage keys holding auth/entitlement-adjacent or PII-adjacent state.
// Must stay in sync with subscriptionSlice CACHE_KEY and Settings wipe list.
export const SENSITIVE_LOCAL_STORAGE_KEYS = [
  'dealforge_subscription',
  'dealforge_usage_events',
  'dealforge_autobackup',
  'dealforge_last_autobackup',
  'pending_plan',
  'dealforge_cookie_consent',
] as const;

/**
 * Secure wipe for logout / account switch: delete IndexedDB (app + Firebase
 * persistence), clear sensitive localStorage + sessionStorage. Best-effort —
 * never throws (logout must always succeed).
 */
export async function wipeLocalData(): Promise<void> {
  try {
    localStorage.removeItem('dealforge_subscription');
    for (const key of SENSITIVE_LOCAL_STORAGE_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore per-key failures
      }
    }
  } catch {
    // localStorage unavailable — continue with IDB wipe
  }
  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }
  try {
    db.close();
  } catch {
    // ignore
  }
  try {
    await db.delete();
  } catch {
    // ignore — DB may already be deleted / blocked
  }
  // Firebase Auth persistence (firebaseLocalStorageDb) holds the ID token
  // and user record — must not survive logout on shared devices.
  try {
    if (typeof indexedDB !== 'undefined') {
      const dbs: Array<{ name?: string }> =
        typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [{ name: 'firebaseLocalStorageDb' }];
      for (const info of dbs) {
        const name = info?.name;
        if (name === 'firebaseLocalStorageDb') {
          await new Promise<void>((resolve) => {
            try {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve();
            } catch {
              resolve();
            }
          });
        }
      }
    }
  } catch {
    // ignore
  }
}
