import { db } from './local-db/db';
import { sendEmail, generateEmailDraft } from './ai/ai-service';
import { useStore } from '../store';

const ONE_DAY_MS = 86400000;
const ONE_HOUR_MS = 3600000;
const CHECK_INTERVAL_MS = 60000;

// Daily outbound cap for browser-driven drip sends. Complements the server
// 5/min rate limit on POST /email/send: 5/min alone allows ~7k/day, far above
// safe cold-outreach volume. Counts local sent records per UTC day.
export const MAX_DRIP_SENDS_PER_DAY = 50;

// Cross-tab single-leader lock so N open tabs don't each run the 60s worker
// and duplicate-send steps. Prefers the Web Locks API; falls back to a
// localStorage lease (TTL > interval) for browsers without it.
const DRIP_LOCK_KEY = 'dealforge:drip-worker-lock';
const DRIP_LOCK_TTL_MS = 90000;

function tryAcquireLocalLock(now: number): boolean {
  try {
    const raw = localStorage.getItem(DRIP_LOCK_KEY);
    if (raw) {
      const heldUntil = Number(raw);
      if (Number.isFinite(heldUntil) && heldUntil > now) return false;
    }
    localStorage.setItem(DRIP_LOCK_KEY, String(now + DRIP_LOCK_TTL_MS));
    return true;
  } catch {
    // Storage unavailable (private mode): fall back to per-tab guard only.
    return true;
  }
}

function releaseLocalLock(): void {
  try {
    localStorage.removeItem(DRIP_LOCK_KEY);
  } catch {
    // ignore
  }
}

async function getTodaySentCount(now: number): Promise<number> {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const startMs = dayStart.getTime();
  try {
    const campaigns = await db.email_campaigns.toArray();
    let count = 0;
    for (const c of campaigns as Array<{ sentAt?: unknown; status?: unknown }>) {
      if (c?.status !== 'sent') continue;
      const t = typeof c.sentAt === 'string' || typeof c.sentAt === 'number' ? new Date(c.sentAt).getTime() : NaN;
      if (Number.isFinite(t) && t >= startMs) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

class DripCampaignWorker {
  private isRunning: boolean = false;
  private intervalId: any = null;

  async processCampaignStep(campaign: any, now: number) {
    if (!campaign.nextRunAt || campaign.nextRunAt > now) return;

    const lead = await db.leads.get(campaign.leadId);
    if (!lead || !lead.email) {
      await db.drip_campaigns.update(campaign.id, { status: 'error', error: 'Lead not found or no email' });
      return;
    }

    // Compliance gate: fail-closed — require explicit opted_in to send.
    const rawConsent = (lead as unknown as Record<string, unknown>)?.consentStatus;
    const consentStatus = typeof rawConsent === 'string' ? rawConsent.trim().toLowerCase() : rawConsent;
    if (consentStatus !== 'opted_in') {
      await db.drip_campaigns.update(campaign.id, {
        status: 'needs_consent',
        error: `Skipped: consentStatus is '${String(rawConsent ?? 'missing')}' (opted_in required to send)`,
        nextRunAt: null,
      });
      return;
    }
    if ((lead as unknown as Record<string, unknown>)?.unsubscribedAt) {
      await db.drip_campaigns.update(campaign.id, {
        status: 'suppressed',
        error: 'Skipped: lead has unsubscribedAt set',
        nextRunAt: null,
      });
      return;
    }

    // Suppression-list gate: mirror of server suppression-service check() — must run before send.
    // NOTE: the server bundle (firebase-admin) can never be imported into the
    // browser build, so this dynamic import always fails here by design. It is
    // kept as defense-in-depth for non-browser runtimes; the ENFORCING check
    // is server-side checkStrict() in POST /email/send (410 suppressed, 503 on
    // outage). Do not treat a resolved import as the compliance boundary.
    try {
      const mod = await import(/* @vite-ignore */ '../../../server/src/services/suppression-service');
      const check = (mod as unknown as { check?: (email: string) => Promise<boolean> })?.check;
      if (typeof check === 'function' && (await check(lead.email))) {
        await db.drip_campaigns.update(campaign.id, {
          status: 'suppressed',
          error: 'Skipped: email is on suppression list (bounce/complaint/unsubscribe/stop-on-reply/manual)',
          nextRunAt: null,
        });
        return;
      }
    } catch (suppressionCheckErr) {
      // Expected in the browser: server suppression-service is not bundleable.
      // Consent/unsubscribed gates above already fail-closed; the server-side
      // send path still enforces the authoritative suppression list.
      console.warn('Drip worker client-side suppression check unavailable, relying on server enforcement', suppressionCheckErr);
    }

    // Daily quota: bound total sends per UTC day across all campaigns/tabs.
    const sentToday = await getTodaySentCount(now);
    if (sentToday >= MAX_DRIP_SENDS_PER_DAY) {
      console.warn(`Drip daily quota reached (${sentToday}/${MAX_DRIP_SENDS_PER_DAY}), deferring campaign ${campaign.id}`);
      await db.drip_campaigns.update(campaign.id, { nextRunAt: now + ONE_DAY_MS });
      return;
    }

    const storeState = useStore.getState();
    const aiKey = storeState.openAiKey || storeState.anthropicKey || storeState.geminiKey;
    const aiModel = storeState.openAiKey ? 'openai' : storeState.anthropicKey ? 'anthropic' : 'gemini';
    const emailKey = storeState.resendKey;
    
    if (!aiKey || !emailKey) {
       console.error(`Missing API Keys for AI or Email generation for campaign ${campaign.id}`);
       useStore.getState().setError(`Drip Campaign Failed: Missing API Keys.`);
       await db.drip_campaigns.update(campaign.id, { nextRunAt: now + ONE_HOUR_MS });
       return;
    }

    try {
      let transcriptContext = '';
      try {
        const transcript = lead?.meetingId
          ? await db.transcripts.where('meetingId').equals(lead.meetingId).first()
          : undefined;
        transcriptContext = transcript?.fullText || '';
      } catch (err) {
        console.error("Failed to load transcript for drip worker", err);
      }

      let subject = '';
      let body = '';
      
      const sequence = campaign.sequence || [];
      const currentStep = campaign.currentStep || 0;
      const step = sequence[currentStep];

      if (step && step.subject && step.body) {
        subject = step.subject;
        body = step.body.replace(/\{lead_name\}/gi, lead.name).replace(/\{company\}/gi, lead.company || '');
      } else {
        const res = await generateEmailDraft(transcriptContext, lead as unknown as Record<string, string | number | boolean>, aiKey, aiModel);
        const data = res; // generateEmailDraft now returns parsed JSON because of apiClient
        subject = data?.subject || `${campaign.name} - Follow up`;
        body = data?.body || `Hi ${lead.name},\n\nJust following up on our recent meeting. Let me know if you have any questions!\n\nBest,`;
      }
      
      const stepCampaignId = crypto.randomUUID();
      await sendEmail(lead.email, subject, body, emailKey, stepCampaignId);
      
      await db.email_campaigns.put({
        id: stepCampaignId,
        leadId: lead.id,
        subject,
        body,
        status: 'sent',
        type: 'drip_step',
        sequence: [],
        sentAt: new Date(now).toISOString(),
        scheduledAt: new Date(now).toISOString(),
      });

      await db.email_tracking.put({
        id: crypto.randomUUID(),
        campaignId: stepCampaignId,
        opens: 0,
        clicks: 0,
        replied: 0,
        lastActivity: null,
      });

      const nextStepIndex = currentStep + 1;
      const isLastStep = nextStepIndex >= (sequence.length || 3);
      const nextDelay = (sequence[nextStepIndex]?.delayDays ?? 1) * ONE_DAY_MS;

      await db.drip_campaigns.update(campaign.id, { 
        status: isLastStep ? 'completed' : 'active',
        currentStep: nextStepIndex, 
        nextRunAt: isLastStep ? null : now + nextDelay
      });
    } catch (err) {
      console.error(`Failed to send drip step for campaign ${campaign.id}:`, err);
      await db.drip_campaigns.update(campaign.id, { nextRunAt: now + ONE_HOUR_MS });
    }
  }

  start() {
    if (this.intervalId) return;

    const tick = async () => {
      if (this.isRunning) return;
      // Single-leader: only one tab runs each sweep. Prefer Web Locks;
      // fall back to a localStorage lease so duplicates can't double-send.
      const locks = (navigator as Navigator & { locks?: { request: (name: string, opts: unknown, cb: () => Promise<void>) => Promise<void> } }).locks;
      if (locks?.request) {
        let acquired = false;
        try {
          await locks.request('dealforge-drip-worker', { ifAvailable: true }, async () => {
            acquired = true;
            await this.runSweep();
          });
        } catch {
          acquired = false;
        }
        if (!acquired) return;
        return;
      }
      const now = Date.now();
      if (!tryAcquireLocalLock(now)) return;
      try {
        await this.runSweep();
      } finally {
        releaseLocalLock();
      }
    };

    this.intervalId = setInterval(() => {
      void tick();
    }, CHECK_INTERVAL_MS);

  }

  private async runSweep(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const now = Date.now();
      const activeCampaigns = await db.drip_campaigns.where('status').equals('active').toArray();

      for (const campaign of activeCampaigns) {
        await this.processCampaignStep(campaign, now);
      }
    } catch (err) {
      console.error('Drip worker error:', err);
    } finally {
      this.isRunning = false;
    }
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

export const dripWorker = new DripCampaignWorker();
