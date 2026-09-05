import { db } from './local-db/db';
import { sendEmail, generateEmailDraft } from './ai/ai-service';
import { useStore } from '../store';

const ONE_DAY_MS = 86400000;
const ONE_HOUR_MS = 3600000;
const CHECK_INTERVAL_MS = 60000;

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

    // Compliance gate: require explicit opt-in. Skip (do not send) if unsubscribed.
    const consentStatus = (lead as unknown as Record<string, unknown>)?.consentStatus;
    if (consentStatus !== 'opted_in') {
      await db.drip_campaigns.update(campaign.id, {
        status: 'suppressed',
        error: `Skipped: consentStatus is '${String(consentStatus ?? 'missing')}' (require opted_in; unsubscribed/opted_out must not send)`,
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
    try {
      const mod = await import('../../../server/src/services/suppression-service');
      const check = (mod as unknown as { check?: (email: string) => Promise<boolean> })?.check;
      if (typeof check === 'function' && (await check(lead.email))) {
        await db.drip_campaigns.update(campaign.id, {
          status: 'suppressed',
          error: 'Skipped: email is on suppression list (bounce/complaint/unsubscribe/stop-on-reply/manual)',
          nextRunAt: null,
        });
        return;
      }
    } catch {
      // Browser bundle cannot always resolve the server suppression-service (firebase-admin);
      // consent gate above already fail-closes. Server-side send path still enforces check().
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
    
    this.intervalId = setInterval(async () => {
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
    }, CHECK_INTERVAL_MS);
    
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

export const dripWorker = new DripCampaignWorker();
