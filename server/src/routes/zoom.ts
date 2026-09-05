import express, { Request, Response } from 'express';
import { getFirebaseAuth, getFirebaseFirestore } from '../services/firebase-admin.js';
import crypto from 'crypto';
import https from 'https';
import bufferService from '../services/buffer-service.js';
import { verifyAuth, AuthRequest } from '../middleware/auth.js';
import { config } from '../config.js';
import { z } from 'zod';
import { validateRequest } from '../middleware/validateRequest.js';
import { AppError } from '../middleware/errorHandler.js';
import log from '../utils/logger.js';
import zoomRTMS from '../services/zoom-rtms.js';
import transcriptAnalysisPipeline from '../services/transcript-analysis-pipeline.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { FieldValue } from 'firebase-admin/firestore';

const router = express.Router();

// FIX-SEC-S4: Zoom HMAC must be computed over the exact wire bytes, not
// JSON.stringify(req.body) (key order / whitespace change breaks or bypasses
// verification). Requires app.ts to preserve the raw buffer, e.g.:
//   app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }))
// or to mount /webhook + /deauth with express.raw({ type: 'application/json' }).
// Until that lands, getZoomRawBody() prefers rawBody/Buffer and falls back to
// JSON.stringify for backwards compat.
// Also enforces 5-minute timestamp freshness to block replays.
const ZOOM_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

function getZoomRawBody(req: Request): string {
  const raw = (req as Request & { rawBody?: unknown }).rawBody;
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Buffer.isBuffer(req.body)) return (req.body as Buffer).toString('utf8');
  if (typeof req.body === 'string') return req.body;
  return JSON.stringify(req.body);
}

function getZoomParsedBody<T = Record<string, unknown>>(req: Request): T {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body as T;
  }
  try {
    return JSON.parse(getZoomRawBody(req)) as T;
  } catch {
    return {} as T;
  }
}

function isFreshZoomTimestamp(tsHeader: string): boolean {
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts)) return false;
  // Zoom sends ms; tolerate seconds producers by normalizing.
  const tsMs = ts < 1e12 ? ts * 1000 : ts;
  return Math.abs(Date.now() - tsMs) <= ZOOM_TIMESTAMP_TOLERANCE_MS;
}

// Buffer ownership: global keys transcript:${meetingId} / notes:${meetingId} /
// meeting:${meetingId} / participants:${meetingId} were verifyAuth-only with no
// owner check, so any authenticated user could read/write/delete any meeting.
// meeting:${meetingId} now carries ownerUid (stored on first authenticated
// create/claim) and every buffer GET/POST/DELETE requires owner === req.user.uid.
function getBufferOwnerUid(meta: Record<string, unknown> | null | undefined): string | null {
  if (!meta || typeof meta !== 'object') return null;
  for (const k of ['ownerUid', 'uid', 'userId', 'owner'] as const) {
    const v = (meta as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

// POST path: claim ownership on first authenticated create, migrate legacy
// owner-less entries, enforce owner === uid otherwise.
async function ensureBufferOwnership(meetingId: string, uid: string): Promise<boolean> {
  const meta = await bufferService.get<Record<string, unknown>>(`meeting:${meetingId}`);
  if (!meta) {
    await bufferService.store(`meeting:${meetingId}`, {
      ownerUid: uid,
      createdAt: new Date().toISOString(),
      status: 'active',
    });
    return true;
  }
  const owner = getBufferOwnerUid(meta);
  if (!owner) {
    (meta as Record<string, unknown>).ownerUid = uid;
    await bufferService.store(`meeting:${meetingId}`, meta);
    return true;
  }
  return owner === uid;
}

// GET/DELETE path: strict check, never creates.
async function checkBufferOwnership(meetingId: string, uid: string): Promise<boolean> {
  const meta = await bufferService.get<Record<string, unknown>>(`meeting:${meetingId}`);
  if (!meta) return false;
  const owner = getBufferOwnerUid(meta);
  if (!owner) return false;
  return owner === uid;
}

const zoomStartSchema = z.object({
  redirect: z.string().optional(),
});

router.post('/oauth/start', verifyAuth, validateRequest({ body: zoomStartSchema }), (req: AuthRequest, res: Response): void => {
  const { clientId, redirectUri } = config.zoom;
  if (!clientId) {
    res.status(500).json({ error: 'Zoom OAuth not configured' });
    return;
  }

  const rawRedirect = (req.body as { redirect?: string }).redirect;
  if (rawRedirect) {
    try {
      const parsed = new URL(rawRedirect);
      const allowedHosts = new Set([new URL(config.clientUrl).hostname, 'localhost', '127.0.0.1']);
      if (!allowedHosts.has(parsed.hostname)) {
        res.status(400).json({ error: 'Invalid redirect URL' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'Invalid redirect URL' });
      return;
    }
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'meeting:read user:read',
    state: encrypt(JSON.stringify({ uid: req.user!.uid, redirect: rawRedirect })),
  });
  res.status(200).json({ url: `https://zoom.us/oauth/authorize?${params.toString()}` });
});

router.get('/oauth/status', verifyAuth, async (req: AuthRequest, res: Response): Promise<void> => {
  const uid = req.user!.uid;
  try {
    const doc = await getFirebaseFirestore().collection('users').doc(uid).get();
    const data = doc.data();
    res.status(200).json({
      linked: !!data?.zoomLinked,
      zoomUserId: data?.zoomUserId || null,
    });
  } catch (err) {
    log.error('Failed to fetch zoom link status', { error: err, uid });
    res.status(500).json({ error: 'Failed to fetch zoom link status' });
  }
});

router.get('/oauth/callback', async (req: Request, res: Response, next: express.NextFunction): Promise<unknown> => {
  const { code, state } = req.query;
  if (!code) {
    return next(new AppError('Missing authorization code', 400));
  }

  // Identify the user either from the state param (browser redirect flow) or an auth header
  let stateUid: string | null = null;
  let stateRedirect: string | undefined;
  if (typeof state === 'string' && state) {
    try {
      const parsed = JSON.parse(decrypt(state)) as { uid?: string; redirect?: string };
      stateUid = parsed.uid || null;
      stateRedirect = parsed.redirect;
    } catch {
      return next(new AppError('Invalid OAuth state', 400));
    }
  }

  const { clientId, clientSecret, redirectUri } = config.zoom;
  if (!clientId || !clientSecret) {
    return next(new AppError('Zoom OAuth not configured', 500));
  }

  try {
    const tokenRes: Record<string, unknown> = await new Promise((resolve, reject) => {
      const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: redirectUri,
      }).toString();

      const reqOpts = {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${creds}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const request = https.request('https://zoom.us/oauth/token', reqOpts, (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('Failed to parse token response')); }
        });
      });
      request.on('error', reject);
      request.setTimeout(10000, () => {
        request.destroy();
        reject(new Error('Zoom token exchange timed out'));
      });
      request.write(body);
      request.end();
    });

    if (tokenRes.error) {
      return next(new AppError((tokenRes.reason || tokenRes.error) as string, 400));
    }

    // Persist tokens to the user's Firestore document
    const authHeader = req.headers.authorization;
    let uid: string | null = stateUid;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const idToken = authHeader.split('Bearer ')[1];
        const decoded = await getFirebaseAuth().verifyIdToken(idToken);
        uid = decoded.uid;
      } catch {
        // fall through to state-based uid
      }
    }

    const zoomAccessToken = tokenRes.access_token as string;
    const zoomRefreshToken = (tokenRes.refresh_token as string) || '';

    // Fetch Zoom profile so we can persist zoomUserId (required for deauth lookup
    // and /oauth/status display). Failure is non-fatal — tokens are still stored.
    let zoomUserId: string | undefined;
    try {
      const profileRes = await fetch('https://api.zoom.us/v2/users/me', {
        headers: { Authorization: `Bearer ${zoomAccessToken}` },
      });
      if (profileRes.ok) {
        const profile = (await profileRes.json()) as { id?: string };
        if (profile.id) zoomUserId = profile.id;
      } else {
        log.warn('Failed to fetch Zoom user profile', { status: profileRes.status });
      }
    } catch (err) {
      log.warn('Failed to fetch Zoom user profile', { error: err });
    }

    if (uid) {
      await getFirebaseFirestore().collection('users').doc(uid).set({
        zoomLinked: true,
        zoomAccessTokenEnc: encrypt(zoomAccessToken),
        zoomRefreshTokenEnc: encrypt(zoomRefreshToken),
        zoomTokenExpiresAt: tokenRes.expires_in
          ? Date.now() + (tokenRes.expires_in as number) * 1000
          : null,
        ...(zoomUserId ? { zoomUserId } : {}),
        // Remove legacy plaintext fields if a previous version stored them.
        zoomAccessToken: FieldValue.delete(),
        zoomRefreshToken: FieldValue.delete(),
      }, { merge: true });
    }

    // Browser redirect flow: send the user back to the client
    if (stateUid) {
      const base = stateRedirect || `${config.clientUrl}/settings`;
      const sep = base.includes('?') ? '&' : '?';
      return res.redirect(302, `${base}${sep}zoom_linked=true`);
    }

    return res.json({
      status: 'success',
      expires_in: tokenRes.expires_in,
    });
  } catch (err) {
    return next(new AppError('Token exchange failed', 500));
  }
});

// Decrypt a stored Zoom token. Supports legacy plaintext values written before
// the encryption fix so existing links keep working until refresh/reconnect.
function decryptStoredToken(stored: string): string {
  try {
    return decrypt(stored);
  } catch {
    return stored;
  }
}

// Read the user's stored Zoom tokens, decrypting them (same encrypt/decrypt
// pattern as services/email-oauth.ts). Refreshes the access token via Zoom
// OAuth when expired and persists the re-encrypted tokens.
export async function getValidZoomAccessToken(uid: string): Promise<string> {
  const docRef = getFirebaseFirestore().collection('users').doc(uid);
  const doc = await docRef.get();
  const data = doc.data() as {
    zoomAccessTokenEnc?: string;
    zoomRefreshTokenEnc?: string;
    zoomAccessToken?: string;
    zoomRefreshToken?: string;
    zoomTokenExpiresAt?: number | null;
  } | undefined;
  if (!doc.exists || !data) {
    throw new AppError('Zoom account not linked', 400);
  }
  const encAccess = data.zoomAccessTokenEnc ?? data.zoomAccessToken;
  const encRefresh = data.zoomRefreshTokenEnc ?? data.zoomRefreshToken;
  if (!encAccess) {
    throw new AppError('Zoom account not linked', 400);
  }
  let accessToken = decryptStoredToken(encAccess);
  const expiresAt = data.zoomTokenExpiresAt;

  if (typeof expiresAt === 'number' && Date.now() >= expiresAt - 60000) {
    if (!encRefresh) {
      throw new AppError('Zoom session expired. Please reconnect Zoom.', 401);
    }
    const refreshToken = decryptStoredToken(encRefresh);
    if (!refreshToken) {
      throw new AppError('Zoom session expired. Please reconnect Zoom.', 401);
    }
    const { clientId, clientSecret } = config.zoom;
    if (!clientId || !clientSecret) {
      throw new AppError('Zoom OAuth not configured', 500);
    }
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString();
    const refreshRes = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const refreshed = (await refreshRes.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: unknown;
      reason?: string;
    };
    if (!refreshRes.ok || !refreshed.access_token) {
      log.error('Zoom token refresh failed', { error: refreshed.reason || refreshed.error });
      throw new AppError('Zoom session expired. Please reconnect Zoom.', 401);
    }
    accessToken = refreshed.access_token;
    await docRef.set(
      {
        zoomAccessTokenEnc: encrypt(accessToken),
        ...(refreshed.refresh_token ? { zoomRefreshTokenEnc: encrypt(refreshed.refresh_token) } : {}),
        zoomTokenExpiresAt: refreshed.expires_in ? Date.now() + refreshed.expires_in * 1000 : expiresAt,
        zoomAccessToken: FieldValue.delete(),
        zoomRefreshToken: FieldValue.delete(),
      },
      { merge: true }
    );
  }

  return accessToken;
}

router.post('/webhook', async (req: Request, res: Response, next: express.NextFunction): Promise<unknown> => {
  const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN || config.zoom.webhookSecretToken;

  if (!secret) {
     return next(new AppError('Server configuration error', 500));
  }

  const zoomSignature = req.headers['x-zm-signature'] as string;
  const zoomTimestamp = req.headers['x-zm-request-timestamp'] as string;

  if (!zoomSignature || !zoomTimestamp) {
    return next(new AppError('Unauthorized: Missing signature', 401));
  }

  if (!isFreshZoomTimestamp(zoomTimestamp)) {
    return next(new AppError('Unauthorized: Stale request', 401));
  }

  const message = `v0:${zoomTimestamp}:${getZoomRawBody(req)}`;
  const hashForVerify = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const signature = `v0=${hashForVerify}`;

  const bufSig = Buffer.from(signature);
  const bufZoom = Buffer.from(zoomSignature);

  if (bufSig.length !== bufZoom.length || !crypto.timingSafeEqual(bufSig, bufZoom)) {
    return next(new AppError('Unauthorized: Invalid signature', 401));
  }

  const { event, payload } = getZoomParsedBody<{ event?: string; payload?: any }>(req);

  switch (event) {
    case 'endpoint.url_validation': {
      const hashForValidate = crypto.createHmac('sha256', secret).update(payload.plainToken).digest('hex');
      res.status(200).json({
        plainToken: payload.plainToken,
        encryptedToken: hashForValidate
      });
      return;
    }
    case 'meeting.started': {
      const meetingId = payload?.object?.id;
      const topic = payload?.object?.topic || 'Untitled Meeting';
      if (meetingId) {
        const existingMeta = await bufferService.get<Record<string, unknown>>(`meeting:${meetingId}`);
        const prevOwner = getBufferOwnerUid(existingMeta);
        await bufferService.store(`meeting:${meetingId}`, {
          startedAt: new Date().toISOString(),
          status: 'active',
          topic,
          ...(prevOwner ? { ownerUid: prevOwner } : {}),
          ...(existingMeta && typeof existingMeta === 'object' ? { createdAt: (existingMeta as Record<string, unknown>).createdAt ?? (existingMeta as Record<string, unknown>).startedAt } : {}),
        });

        // Establish RTMS connection for real-time transcription
        const rtmsConnected = await zoomRTMS.connectToMeeting(meetingId, topic);
        if (rtmsConnected) {
          log.info('RTMS connection established for meeting', { meetingId, topic });
        } else {
          log.warn('Failed to establish RTMS connection, falling back to manual transcription', { meetingId });
        }

        // Start transcript analysis pipeline
        const io = req.app.get('io');
        if (io) {
          transcriptAnalysisPipeline.initialize(io);
        }
        transcriptAnalysisPipeline.startPipeline(meetingId);
        log.info('Transcript analysis pipeline started for meeting', { meetingId });
      }
      break;
    }
    case 'meeting.ended': {
      const meetingId = payload?.object?.id;
      if (meetingId) {
        // Stop transcript analysis pipeline
        transcriptAnalysisPipeline.stopPipeline(meetingId);
        log.info('Transcript analysis pipeline stopped for meeting', { meetingId });

        // Disconnect from RTMS
        await zoomRTMS.disconnectFromMeeting(meetingId);

        const data = await bufferService.get<Record<string, unknown>>(`meeting:${meetingId}`);
        if (data) {
          data.endedAt = new Date().toISOString();
          data.status = 'completed';
          await bufferService.store(`meeting:${meetingId}`, data);
        }
        const io = req.app.get('io');
        if (io) {
          io.to(`meeting:${meetingId}`).emit('meeting_ended', { meetingId });
          io.emit('meeting_ended', { meetingId });
        }
      }
      break;
    }
    case 'meeting.participant_joined': {
      const meetingId = payload?.object?.id;
      const participant = payload?.object?.participant;
      if (meetingId && participant) {
        const consentNotifiedAt = new Date().toISOString();
        const participantWithConsent = { ...participant, consentNotifiedAt };
        const key = `participants:${meetingId}`;
        const existing = (await bufferService.get<{ participants: Array<Record<string, unknown>> }>(key)) || { participants: [] };
        if (!existing.participants.find((p) => p.user_id === participant.user_id || p.user_name === participant.user_name)) {
          existing.participants.push(participantWithConsent);
          await bufferService.store(key, existing);
        }

        const io = req.app.get('io');
        if (io) {
          io.to(`meeting:${meetingId}`).emit('participant_joined', { meetingId, participant: participantWithConsent });
          io.emit('participant_joined', { meetingId, participant: participantWithConsent });
          io.to(`meeting:${meetingId}`).emit('recording_consent_notice', { meetingId, participant: participantWithConsent, consentNotifiedAt, message: 'This meeting is being transcribed by DealForge. Please inform all participants and obtain required consent.' });
          io.emit('recording_consent_notice', { meetingId, participant: participantWithConsent, consentNotifiedAt });
        }
      }
      break;
    }
  }

  return res.status(200).json({ status: 'ok' });
});

router.post('/deauth', async (req: Request, res: Response, next: express.NextFunction): Promise<unknown> => {
  const secret = config.zoom.webhookSecretToken;

  if (!secret) {
     return next(new AppError('Server configuration error', 500));
  }

  const zoomSignature = req.headers['x-zm-signature'] as string;
  const zoomTimestamp = req.headers['x-zm-request-timestamp'] as string;

  if (!zoomSignature || !zoomTimestamp) {
    return next(new AppError('Unauthorized: Missing signature', 401));
  }

  if (!isFreshZoomTimestamp(zoomTimestamp)) {
    return next(new AppError('Unauthorized: Stale request', 401));
  }

  const message = `v0:${zoomTimestamp}:${getZoomRawBody(req)}`;
  const hashForVerify = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const signature = `v0=${hashForVerify}`;

  const bufSig = Buffer.from(signature);
  const bufZoom = Buffer.from(zoomSignature);

  if (bufSig.length !== bufZoom.length || !crypto.timingSafeEqual(bufSig, bufZoom)) {
    return next(new AppError('Unauthorized: Invalid signature', 401));
  }

  const { payload } = getZoomParsedBody<{ payload?: { user_id?: string; account_id?: string } }>(req);

  const userId = payload?.user_id;
  const accountId = payload?.account_id;
  
  log.info(`Deauth event received for user ${userId}, account ${accountId}`);
  
  if (userId) {
    try {
      const firestore = getFirebaseFirestore();
      const snapshot = await firestore.collection('users').where('zoomUserId', '==', userId).get();
      // Live meeting candidates (owner-filtered per uid below so we never wipe another user's active meeting).
      let activeMeetingIds: string[] = [];
      try {
        const pipelines = transcriptAnalysisPipeline.getActivePipelines() || [];
        const rtmsIds = zoomRTMS.getConnectedMeetingIds() || [];
        activeMeetingIds = Array.from(new Set([...pipelines, ...rtmsIds]));
      } catch (err) {
        log.warn('Failed to list active meetings during deauth cleanup', { error: err });
      }
      const wipeOneUser = async (uid: string): Promise<void> => {
        // 1) Tokens + link metadata.
        try {
          await firestore.collection('users').doc(uid).update({
            zoomLinked: false,
            zoomUserId: FieldValue.delete(),
            zoomAccessTokenEnc: FieldValue.delete(),
            zoomRefreshTokenEnc: FieldValue.delete(),
            zoomTokenExpiresAt: FieldValue.delete(),
            zoomAccessToken: FieldValue.delete(),
            zoomRefreshToken: FieldValue.delete()
          });
        } catch (err) {
          log.error('Failed to clean up user tokens on deauth', { error: err, uid });
        }
        // 2) Discover meetingIds owned by this uid.
        const meetingIds = new Set<string>();
        try {
          const meetingsSnap = await firestore.collection('users').doc(uid).collection('api-data').doc('meetings').collection('items').get();
          meetingsSnap.forEach((d) => { if (d.id) meetingIds.add(d.id); });
        } catch { /* no persisted meetings — ignore */ }
        try {
          const analysesSnap = await firestore.collection('users').doc(uid).collection('api-data').doc('analyses').collection('items').get();
          analysesSnap.forEach((d) => {
            const mid = (d.data() as { meetingId?: unknown }).meetingId;
            if (typeof mid === 'string' && mid) meetingIds.add(mid);
          });
        } catch { /* ignore */ }
        for (const mid of activeMeetingIds) {
          try {
            const meta = await bufferService.get<Record<string, unknown>>(`meeting:${mid}`);
            if (meta && typeof meta === 'object') {
              const owner = (meta as Record<string, unknown>).ownerUid
                ?? (meta as Record<string, unknown>).uid
                ?? (meta as Record<string, unknown>).userId
                ?? (meta as Record<string, unknown>).owner;
              if (owner === uid) meetingIds.add(mid);
            }
          } catch { /* ignore per-meeting read failure */ }
        }
        // 3) Buffer keys + stop live processing for each owned meeting.
        for (const mid of meetingIds) {
          try {
            transcriptAnalysisPipeline.stopPipeline(mid);
          } catch { /* ignore */ }
          try {
            await zoomRTMS.disconnectFromMeeting(mid);
          } catch { /* ignore */ }
          for (const prefix of ['transcript', 'meeting', 'participants', 'notes'] as const) {
            try {
              await bufferService.delete(`${prefix}:${mid}`);
            } catch (err) {
              log.warn('Failed to delete buffer key on deauth', { error: err, uid, key: `${prefix}:${mid}` });
            }
          }
        }
        // 4) Tracking inbox (same Redis store; in-memory copy expires via TTL/pull).
        try {
          await bufferService.delete(`tracking:${uid}`);
        } catch (err) {
          log.warn('Failed to delete tracking inbox on deauth', { error: err, uid });
        }
        log.info('Deauth cleanup completed for user', { uid, meetingsWiped: meetingIds.size });
      };
      const uids: string[] = [];
      snapshot.forEach((doc) => { uids.push(doc.id); });
      await Promise.all(uids.map((uid) => wipeOneUser(uid)));
      if (uids.length === 0) {
        log.info('Deauth received for unknown Zoom user, nothing to wipe', { zoomUserId: userId });
      }
    } catch (err) {
      log.error('Failed to clean up user on deauth', { error: err });
    }
  }
  
  return res.status(200).json({ status: 'ok' });
});

const transcriptionSchema = z.object({
  meetingId: z.string().min(1),
  segment: z.any()
});

router.post('/transcription', verifyAuth, validateRequest({ body: transcriptionSchema }), async (req: AuthRequest, res: Response, next: express.NextFunction): Promise<void> => {
  const { meetingId, segment } = req.body;
  const uid = req.user!.uid;
  if (!(await ensureBufferOwnership(String(meetingId), uid))) {
    res.status(403).json({ error: 'Forbidden: not meeting owner' });
    return;
  }

  // Normalize segment to ensure consistent format
  const normalizedSegment = {
    id: segment.id || `transcript-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
    speaker: segment.speaker || 'Unknown Speaker',
    text: segment.text,
    startTime: segment.startTime,
    endTime: segment.endTime,
    timestamp: new Date().toISOString(),
    source: segment.source || 'manual'
  };

  const key = `transcript:${meetingId}`;
  const existing = (await bufferService.get<{ segments: Array<Record<string, unknown>> }>(key)) || { segments: [] };
  existing.segments.push(normalizedSegment);
  await bufferService.store(key, existing);

  const io = req.app.get('io');
  if (io) {
    io.to(`meeting:${meetingId}`).emit('transcription', normalizedSegment);
    log.info('Transcription segment stored and broadcast', { meetingId, source: normalizedSegment.source });
  }

  // Check if we should trigger analysis based on segment count
  const segmentCount = existing.segments.length;
  if (segmentCount > 0 && segmentCount % 10 === 0) {
    // Trigger analysis every 10 segments for more responsive suggestions
    log.info('Triggering transcript analysis based on segment count', { meetingId, segmentCount });
  }

  res.status(200).json({ status: 'ok', segmentId: normalizedSegment.id });
});

const notesSchema = z.object({
  meetingId: z.string().min(1),
  note: z.any()
});

router.post('/notes', verifyAuth, validateRequest({ body: notesSchema }), async (req: AuthRequest, res: Response, next: express.NextFunction): Promise<void> => {
  const { meetingId, note } = req.body;
  const uid = req.user!.uid;
  if (!(await ensureBufferOwnership(String(meetingId), uid))) {
    res.status(403).json({ error: 'Forbidden: not meeting owner' });
    return;
  }

  const key = `notes:${meetingId}`;
  const existing = (await bufferService.get<{ notes: Array<Record<string, unknown>> }>(key)) || { notes: [] };
  existing.notes.push({ ...note, receivedAt: new Date().toISOString() });
  await bufferService.store(key, existing);

  res.status(200).json({ status: 'ok' });
});

router.get('/buffer/:meetingId', verifyAuth, async (req: AuthRequest, res: Response) => {
  const { meetingId } = req.params;
  const uid = req.user!.uid;
  if (!(await checkBufferOwnership(String(meetingId), uid))) {
    res.status(403).json({ error: 'Forbidden: not meeting owner' });
    return;
  }
  const transcript = await bufferService.get(`transcript:${meetingId}`);
  const notes = await bufferService.get(`notes:${meetingId}`);
  const meetingData = await bufferService.get(`meeting:${meetingId}`);
  const participants = await bufferService.get(`participants:${meetingId}`);

  res.status(200).json({
    transcript: transcript || null,
    notes: notes || null,
    meeting: meetingData || null,
    participants: participants || null,
  });
});

router.delete('/buffer/:meetingId', verifyAuth, async (req: AuthRequest, res: Response) => {
  const meetingId = req.params.meetingId;
  const uid = req.user!.uid;
  if (!(await checkBufferOwnership(String(meetingId), uid))) {
    res.status(403).json({ error: 'Forbidden: not meeting owner' });
    return;
  }
  await bufferService.delete(`transcript:${meetingId}`);
  await bufferService.delete(`notes:${meetingId}`);
  await bufferService.delete(`meeting:${meetingId}`);
  await bufferService.delete(`participants:${meetingId}`);

  res.status(200).json({ status: 'cleared' });
});

router.get('/rtms/status', verifyAuth, async (req: AuthRequest, res: Response) => {
  const connectedMeetings = zoomRTMS.getConnectedMeetingIds();
  res.status(200).json({ 
    connectedMeetings,
    isConnected: connectedMeetings.length > 0
  });
});

router.get('/pipeline/status', verifyAuth, async (req: AuthRequest, res: Response) => {
  const activePipelines = transcriptAnalysisPipeline.getActivePipelines();
  res.status(200).json({
    activePipelines,
    activeCount: activePipelines.length
  });
});

export default router;
