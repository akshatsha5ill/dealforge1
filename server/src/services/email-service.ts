import crypto from 'crypto';
import { Resend } from 'resend';
import { config } from '../config.js';
import { AppError } from '../middleware/errorHandler.js';

// ---------------------------------------------------------------------------
// Bulk / compliance helpers (Gmail bulk-sender guidelines + CAN-SPAM)
// ---------------------------------------------------------------------------

export interface BulkComplianceOptions {
  /** Explicit bulk flag. Inferred as bulk when campaignId/unsubscribeUrl present. */
  isBulk?: boolean;
  campaignId?: string;
  /** Explicit one-click unsubscribe HTTPS URL. Built from to+campaignId if omitted. */
  unsubscribeUrl?: string;
  /** Reply-To address. Required (and must be replyable) for bulk. */
  replyTo?: string;
  /** mailto: fallback for List-Unsubscribe. Derived if omitted. */
  mailtoUnsubscribe?: string;
  companyName?: string;
  physicalAddress?: string;
}

type SendDraftOptions = {
  apiKey?: string;
  from?: string;
} & BulkComplianceOptions;

type GmailFromOrOptions = string | (BulkComplianceOptions & { from?: string });
type GmailExtraOptions = BulkComplianceOptions & { from?: string };

const NOREPLY_PATTERN = /(no[\-_.]?reply|donotreply|do[\-_.]?not[\-_.]?reply)/i;

const isNoreplyAddress = (value: string | undefined | null): boolean => {
  if (!value) return false;
  return NOREPLY_PATTERN.test(value);
};

const extractDomain = (from: string): string => {
  const m = from.match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  if (m) return m[1].toLowerCase();
  try {
    return new URL(config.clientUrl).hostname.toLowerCase();
  } catch {
    return 'dealforge.app';
  }
};

const defaultReplyTo = (from: string): string => {
  const envReply = (process.env.EMAIL_REPLY_TO || '').trim();
  if (envReply) return envReply;
  if (from && !isNoreplyAddress(from)) {
    // Re-use a replyable From as Reply-To (preserves display name form).
    const emailMatch = from.match(/<([^>]+)>/);
    if (emailMatch) return emailMatch[1].trim();
    // Bare address or display form without brackets — pass through.
    if (from.includes('@')) return from.trim();
  }
  const domain = extractDomain(from || config.email.from || '');
  // Fall back to a replyable address on the sender domain.
  return `support@${domain}`;
};

// Handler lives on the API (app.ts: app.use('/unsubscribe', ...)); the client
// router has no /unsubscribe route, so a clientUrl-based link 404s.
// Prefer an explicit API base; derive the API origin from TRACKING_BASE_URL
// when set; legacy fallback is config.clientUrl.
const getUnsubscribeBase = (baseOverride?: string): string => {
  const explicit = (baseOverride || process.env.UNSUBSCRIBE_BASE_URL || process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const trackingBase = (process.env.TRACKING_BASE_URL || '').trim().replace(/\/+$/, '');
  if (trackingBase) {
    const origin = trackingBase.replace(/\/api\/tracking$/, '').replace(/\/api$/, '');
    if (/^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, '');
  }
  return (config.clientUrl || 'http://localhost:3000').replace(/\/$/, '');
};

// Must match routes/unsubscribe.ts verifyEmailToken: HMAC-SHA256 of the
// normalized email with TRACKING_SECRET || SESSION_SECRET. Empty when no
// secret (dev/test verify allows unsigned, mirroring tracking.ts).
const signUnsubscribeEmail = (to: string): string => {
  const secret = process.env.TRACKING_SECRET || process.env.SESSION_SECRET || '';
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(to.trim().toLowerCase()).digest('hex');
};

const buildUnsubscribeUrl = (to: string, campaignId?: string, baseOverride?: string): string => {
  const base = getUnsubscribeBase(baseOverride);
  const params = new URLSearchParams({ email: to });
  if (campaignId) params.set('campaign', campaignId);
  const token = signUnsubscribeEmail(to);
  if (token) params.set('token', token);
  return `${base}/unsubscribe?${params.toString()}`;
};

const buildMailtoUnsubscribe = (replyTo: string, campaignId?: string): string => {
  const subject = campaignId ? `unsubscribe ${campaignId}` : 'unsubscribe';
  return `mailto:${replyTo}?subject=${encodeURIComponent(subject)}`;
};

const buildListUnsubscribeHeaders = (
  unsubscribeUrl: string,
  mailtoUnsubscribe: string,
): Record<string, string> => ({
  'List-Unsubscribe': `<${unsubscribeUrl}>, <${mailtoUnsubscribe}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
});

const escapeHtmlAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Append a CAN-SPAM compliant footer (unsubscribe link + physical address).
 * Idempotent: returns input unchanged if footer already present.
 */
const injectComplianceFooter = (
  html: string,
  opts: { unsubscribeUrl: string; companyName?: string; physicalAddress?: string },
): string => {
  const { unsubscribeUrl } = opts;
  if (!unsubscribeUrl) return html;
  if (html.includes('data-compliance-footer')) return html;
  if (html.includes(unsubscribeUrl)) return html;

  const companyName = opts.companyName || process.env.EMAIL_COMPANY_NAME || 'DealForge';
  const physicalAddress =
    opts.physicalAddress || process.env.EMAIL_PHYSICAL_ADDRESS || 'DealForge, Inc.';
  const safeUrl = escapeHtmlAttr(unsubscribeUrl);

  const footer =
    `<br><div data-compliance-footer="true" style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e5e5;font-size:12px;color:#666;">` +
    `<p style="margin:0 0 8px;">You're receiving this email because you subscribed via ${escapeHtmlAttr(companyName)}.</p>` +
    `<p style="margin:0 0 8px;"><a href="${safeUrl}">Unsubscribe</a> from these emails.</p>` +
    `<p style="margin:0;">${escapeHtmlAttr(companyName)} &middot; ${escapeHtmlAttr(physicalAddress)}</p>` +
    `</div>`;

  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${footer}$&`);
  }
  return `${html}${footer}`;
};

/** Throw for bulk sends using a noreply sender or noreply Reply-To. */
const assertBulkSender = (from: string, replyTo: string): void => {
  if (isNoreplyAddress(from)) {
    throw new AppError('Bulk email must not use a noreply sender. Use a replyable From address.', 400);
  }
  if (!replyTo || isNoreplyAddress(replyTo)) {
    throw new AppError('Bulk email must include a replyable Reply-To address.', 400);
  }
};

const normalizeBulkContext = (
  to: string,
  from: string,
  opts: BulkComplianceOptions,
): { isBulkSend: boolean; replyTo: string; unsubscribeUrl: string; mailtoUnsubscribe: string } => {
  const isBulkSend = Boolean(opts.isBulk || opts.campaignId || opts.unsubscribeUrl);
  if (!isBulkSend) {
    return {
      isBulkSend: false,
      replyTo: opts.replyTo || '',
      unsubscribeUrl: opts.unsubscribeUrl || '',
      mailtoUnsubscribe: opts.mailtoUnsubscribe || '',
    };
  }
  const replyTo = (opts.replyTo || defaultReplyTo(from)).trim();
  assertBulkSender(from, replyTo);
  const unsubscribeUrl = opts.unsubscribeUrl || buildUnsubscribeUrl(to, opts.campaignId);
  const mailtoUnsubscribe = opts.mailtoUnsubscribe || buildMailtoUnsubscribe(replyTo, opts.campaignId);
  return { isBulkSend: true, replyTo, unsubscribeUrl, mailtoUnsubscribe };
};

const normalizeGmailArgs = (
  fromOrOptions: GmailFromOrOptions | undefined,
  extraOptions: GmailExtraOptions | undefined,
): { from: string } & BulkComplianceOptions => {
  const defaults = { from: config.email.from } as { from: string } & BulkComplianceOptions;
  if (typeof fromOrOptions === 'string') {
    return { ...defaults, from: fromOrOptions, ...(extraOptions || {}) };
  }
  return { ...defaults, ...(fromOrOptions || {}), ...(extraOptions || {}) };
};

type OutlookFromOrOptions = string | (BulkComplianceOptions & { from?: string });
type OutlookExtraOptions = BulkComplianceOptions & { from?: string };

const normalizeOutlookArgs = (
  fromOrOptions: OutlookFromOrOptions | undefined,
  extraOptions: OutlookExtraOptions | undefined,
): { from: string } & BulkComplianceOptions => {
  const defaults = { from: config.email.from } as { from: string } & BulkComplianceOptions;
  if (typeof fromOrOptions === 'string') {
    // 5th arg is the authenticated user email (see getValidAccessToken).
    // Empty string falls back to extraOptions.from / config default so the
    // existing routes/email.ts caller (4 args, email discarded) keeps working.
    const trimmed = fromOrOptions.trim();
    if (trimmed) {
      return { ...defaults, ...(extraOptions || {}), from: trimmed };
    }
    return { ...defaults, ...(extraOptions || {}) };
  }
  return { ...defaults, ...(fromOrOptions || {}), ...(extraOptions || {}) };
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&middot;/gi, '·')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try {
        return String.fromCharCode(parseInt(h, 16));
      } catch {
        return _;
      }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCharCode(parseInt(n, 10));
      } catch {
        return _;
      }
    });

/**
 * Minimal HTML -> plain-text fallback (no deps).
 * Strips script/style, converts block breaks to newlines, keeps link URLs,
 * strips remaining tags, decodes entities, and collapses whitespace.
 */
const htmlToText = (html: string): string => {
  if (!html) return '';
  let text = String(html);
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script\s*>/gi, ' ');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  // Keep link destinations: <a href="url">label</a> -> "label (url)"
  text = text.replace(
    /<a[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_, url: string, label: string) => {
      const cleanLabel = label.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const cleanUrl = decodeHtmlEntities(String(url).trim());
      if (!cleanLabel) return ` ${cleanUrl} `;
      if (!cleanUrl || cleanUrl === cleanLabel) return ` ${cleanLabel} `;
      return ` ${cleanLabel} (${cleanUrl}) `;
    },
  );
  text = text.replace(
    /<a[^>]*href\s*=\s*'([^']+)'[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_, url: string, label: string) => {
      const cleanLabel = label.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const cleanUrl = decodeHtmlEntities(String(url).trim());
      if (!cleanLabel) return ` ${cleanUrl} `;
      if (!cleanUrl || cleanUrl === cleanLabel) return ` ${cleanLabel} `;
      return ` ${cleanLabel} (${cleanUrl}) `;
    },
  );
  text = text.replace(/<(br\s*\/?|hr\s*\/?)>/gi, '\n');
  text = text.replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|table|blockquote|section|article)\s*>/gi, '\n');
  text = text.replace(/<(p|div|h[1-6]|li|tr|blockquote)[^>]*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t\u00a0]+/g, ' ');
  text = text
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
};

// Sentinel Note: In a production app, the Resend API key would ideally be configured securely
// via env vars or per-user integrations. Using a generic error if not provided.
const sendDraft = async (to: string, subject: string, body: string, { apiKey = config.email.resendApiKey, from = config.email.from, replyTo: replyToOpt, campaignId, unsubscribeUrl: unsubscribeOpt, mailtoUnsubscribe: mailtoOpt, isBulk, companyName, physicalAddress }: SendDraftOptions = {}) => {
  if (!apiKey) {
    throw new AppError('Resend API Key is missing.', 400);
  }
  // Guard: refuse Resend send unless EMAIL_FROM is explicitly set to a
  // Resend-verified domain address (see docs/email-deliverability.md).
  // config.email.from falls back to a hardcoded default, which must not be
  // used for production sends from an unverified domain.
  if (!(process.env.EMAIL_FROM || '').trim()) {
    console.warn('[email-service] Refusing Resend send: EMAIL_FROM is not set. Set EMAIL_FROM to an address on a Resend-verified domain.');
    throw new AppError('EMAIL_FROM is not configured. Set EMAIL_FROM to an address on a Resend-verified domain.', 400);
  }
  const ctx = normalizeBulkContext(to, from, {
    isBulk,
    campaignId,
    unsubscribeUrl: unsubscribeOpt,
    mailtoUnsubscribe: mailtoOpt,
    replyTo: replyToOpt,
  });

  const finalBody = ctx.isBulkSend
    ? injectComplianceFooter(body, { unsubscribeUrl: ctx.unsubscribeUrl, companyName, physicalAddress })
    : body;
  const headers = ctx.isBulkSend
    ? buildListUnsubscribeHeaders(ctx.unsubscribeUrl, ctx.mailtoUnsubscribe)
    : undefined;
  // Bulk sends always carry an explicit replyable Reply-To.
  const replyTo = ctx.isBulkSend ? ctx.replyTo : replyToOpt || undefined;

  const resend = new Resend(apiKey);

  const { data, error } = await resend.emails.send({
    from,
    to: [to],
    subject: subject,
    html: finalBody,
    text: htmlToText(finalBody),
    ...(headers ? { headers } : {}),
    ...(replyTo ? { replyTo } : {}),
  });

  if (error) {
    throw new AppError(error.message, 500);
  }
  return data;
};

// Strip CR/LF to prevent Gmail CRLF header injection.
const sanitizeHeaderValue = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();
const sanitizeEmailAddress = (value: string): string => value.replace(/[\r\n]+/g, '').trim();

const sendViaGmail = async (
  accessToken: string,
  to: string,
  subject: string,
  body: string,
  fromOrOptions: GmailFromOrOptions = config.email.from,
  extraOptions: GmailExtraOptions = {},
) => {
  const { from, replyTo: replyToOpt, campaignId, unsubscribeUrl: unsubscribeOpt, mailtoUnsubscribe: mailtoOpt, isBulk, companyName, physicalAddress } =
    normalizeGmailArgs(fromOrOptions, extraOptions);
  const ctx = normalizeBulkContext(to, from, {
    isBulk,
    campaignId,
    unsubscribeUrl: unsubscribeOpt,
    mailtoUnsubscribe: mailtoOpt,
    replyTo: replyToOpt,
  });

  const finalBody = ctx.isBulkSend
    ? injectComplianceFooter(body, { unsubscribeUrl: ctx.unsubscribeUrl, companyName, physicalAddress })
    : body;

  const safeTo = sanitizeEmailAddress(to);
  const safeSubject = sanitizeHeaderValue(subject);
  const safeFrom = sanitizeHeaderValue(from);
  const date = new Date().toUTCString();
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@dealforge.app>`;
  const textBody = htmlToText(finalBody);
  const boundary = `=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const encodeB64 = (s: string): string =>
    (Buffer.from(s, 'utf8').toString('base64').match(/.{1,76}/g) || []).join('\r\n');
  const lines = [
    `From: ${safeFrom}`,
    `To: ${safeTo}`,
    `Subject: ${safeSubject}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
  ];
  if (ctx.isBulkSend) {
    lines.push(`Reply-To: ${sanitizeHeaderValue(ctx.replyTo)}`);
    lines.push(`List-Unsubscribe: ${sanitizeHeaderValue(`<${ctx.unsubscribeUrl}>, <${ctx.mailtoUnsubscribe}>`)}`);
    lines.push('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  } else if (replyToOpt) {
    lines.push(`Reply-To: ${sanitizeHeaderValue(replyToOpt)}`);
  }
  lines.push(
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    'MIME-Version: 1.0',
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    encodeB64(textBody),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    encodeB64(finalBody),
    `--${boundary}--`,
  );
  const message = lines.join('\r\n');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: Buffer.from(message, 'utf8').toString('base64url') }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AppError(`Gmail send failed: ${detail || res.statusText}`, 500);
  }
  return { id: (await res.json() as { id: string }).id, via: 'gmail' };
};

const sendViaOutlook = async (
  accessToken: string,
  to: string,
  subject: string,
  body: string,
  fromOrOptions: OutlookFromOrOptions = config.email.from,
  extraOptions: OutlookExtraOptions = {},
) => {
  const { from: rawFrom, replyTo: replyToOpt, campaignId, unsubscribeUrl: unsubscribeOpt, mailtoUnsubscribe: mailtoOpt, isBulk, companyName, physicalAddress } =
    normalizeOutlookArgs(fromOrOptions, extraOptions);
  // Fallback preserves the old 4-arg caller (routes/email.ts discards email):
  // authenticated user email when provided, else config.email.from.
  const from = (rawFrom || '').trim() || config.email.from;
  // Outlook sends as the authenticated Graph user, so anchor compliance on the
  // real sender (from), not config alone. Reply-To defaults to a replyable
  // address derived from from.
  const provisionalReply = (replyToOpt || defaultReplyTo(from)).trim();
  const isBulkSend = Boolean(isBulk || campaignId || unsubscribeOpt);
  if (isBulkSend) {
    assertBulkSender(from, provisionalReply);
  }
  const ctx = normalizeBulkContext(to, from, {
    isBulk,
    campaignId,
    unsubscribeUrl: unsubscribeOpt,
    mailtoUnsubscribe: mailtoOpt,
    replyTo: provisionalReply,
  });

  const finalBody = ctx.isBulkSend
    ? injectComplianceFooter(body, { unsubscribeUrl: ctx.unsubscribeUrl, companyName, physicalAddress })
    : body;

  const internetMessageHeaders = ctx.isBulkSend
    ? [
        { name: 'List-Unsubscribe', value: `<${ctx.unsubscribeUrl}>, <${ctx.mailtoUnsubscribe}>` },
        { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
      ]
    : undefined;
  const replyTo = ctx.isBulkSend ? ctx.replyTo : replyToOpt || from || undefined;

  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: finalBody },
        toRecipients: [{ emailAddress: { address: to } }],
        from: { emailAddress: { address: from } },
        ...(replyTo ? { replyTo: [{ emailAddress: { address: replyTo } }] } : {}),
        ...(internetMessageHeaders ? { internetMessageHeaders } : {}),
      },
      saveToSentItems: true,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AppError(`Outlook send failed: ${detail || res.statusText}`, 500);
  }
  return { id: `outlook-${Date.now()}`, via: 'outlook' };
};

export {
  sendDraft,
  sendViaGmail,
  sendViaOutlook,
  htmlToText,
  isNoreplyAddress,
  buildUnsubscribeUrl,
  buildMailtoUnsubscribe,
  buildListUnsubscribeHeaders,
  injectComplianceFooter,
  assertBulkSender,
};
