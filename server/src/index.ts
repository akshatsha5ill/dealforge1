process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

import http from 'http';
import { Server, Socket } from 'socket.io';
import { app } from './app.js';
import bufferService from './services/buffer-service.js';
import zoomRTMS from './services/zoom-rtms.js';
import transcriptAnalysisPipeline from './services/transcript-analysis-pipeline.js';
import log from './utils/logger.js';
import { config } from './config.js';
import { getFirebaseAuth } from './services/firebase-admin.js';

const server = http.createServer(app);

const allowedOrigin = config.clientUrl || 'http://localhost:5173';
const allowedOrigins = new Set(
  [allowedOrigin, ...(process.env.CLIENT_URLS || '').split(',').map((s) => s.trim()).filter(Boolean)],
);
const allowPreviewOrigins =
  process.env.ALLOW_PREVIEW_ORIGINS !== undefined
    ? process.env.ALLOW_PREVIEW_ORIGINS === 'true'
    : !config.isProd;

const isAllowedSocketOrigin = (origin: string | undefined): boolean => {
  // Allow non-browser / same-origin requests with no Origin header.
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  if (!allowPreviewOrigins) return false;
  // See app.ts isAllowedOrigin: explicit CLIENT_URLS allowlist only, plus the
  // trusted Zoom client. No *.vercel.app wildcard (attacker-deployable).
  try {
    const hostname = new URL(origin).hostname;
    if (hostname === 'zoom.us' || hostname.endsWith('.zoom.us')) return true;
  } catch {
    // fall through to deny
  }
  return false;
};

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (isAllowedSocketOrigin(origin)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST']
  }
});

// Log transport / CORS / handshake failures (server side of client connect_error).
io.engine.on('connection_error', (err: { req?: unknown; code?: unknown; message?: unknown; context?: unknown }) => {
  log.warn('Socket connection_error', {
    code: (err as { code?: unknown }).code,
    message: (err as { message?: unknown }).message,
    context: (err as { context?: unknown }).context,
  });
});

app.set('io', io);

// Expose io globally for RTMS service
(global as any).__io = io;

// Initialize transcript analysis pipeline with WebSocket server
transcriptAnalysisPipeline.initialize(io);

io.use((socket: Socket & { user?: Record<string, unknown> }, next) => {
  const queryToken = socket.handshake.query?.token;
  if (queryToken) {
    log.warn('Rejected query.token: use auth.token', { socketId: socket.id });
  }
  const token = socket.handshake.auth?.token;
  if (!token) {
    return next(new Error('Authentication error'));
  }
  getFirebaseAuth().verifyIdToken(token as string, true)
    .then((decodedToken: Record<string, unknown>) => {
      socket.user = decodedToken;
      next();
    })
    .catch((err: Error) => {
      log.warn('Socket auth failed (client connect_error)', { message: err?.message });
      next(new Error('Authentication error'));
    });
});

// Safety caps for save_note (socket events bypass Express JSON limit + sanitize middleware).
const SAVE_NOTE_MAX_BYTES = 10 * 1024; // 10kb size limit
const SAVE_NOTE_CONTENT_MAX_LEN = 5000;
const SAVE_NOTE_TIMESTAMP_MAX_LEN = 100;
const SAVE_NOTE_RATE_MAX = 20; // max notes per window per socket and per user (global)
const SAVE_NOTE_RATE_WINDOW_MS = 60 * 1000;
const saveNoteTimestamps = new Map<string, number[]>();
// Per-user global rate-limit bucket (uid -> timestamps) to prevent reconnect / multi-socket bypass.
const saveNoteUserTimestamps = new Map<string, number[]>();
const stripTags = (s: string): string => s.replace(/<[^>]*>/g, '');

io.on('connection', (socket: Socket & { user?: Record<string, unknown> }) => {
  log.info('Client connected', { socketId: socket.id, uid: socket.user?.uid });

  socket.on('join_meeting', async (meetingId: string) => {
    try {
      const uid = socket.user?.uid as string | undefined;
      if (!uid || typeof meetingId !== 'string' || !meetingId) {
        log.warn('Socket denied join_meeting: missing uid/meetingId', { socketId: socket.id });
        return;
      }
      const meta = await bufferService.get<Record<string, unknown>>(`meeting:${meetingId}`);
      const owner =
        meta && typeof meta === 'object'
          ? ((meta as Record<string, unknown>).ownerUid ??
            (meta as Record<string, unknown>).uid ??
            (meta as Record<string, unknown>).userId ??
            (meta as Record<string, unknown>).owner)
          : null;
      if (typeof owner !== 'string' || owner !== uid) {
        log.warn('Socket denied join_meeting: not meeting owner', { socketId: socket.id, meetingId, uid });
        return;
      }
      socket.join(`meeting:${meetingId}`);
      log.info('Socket joined meeting room', { socketId: socket.id, meetingId, uid });
    } catch (err) {
      log.warn('Socket join_meeting ownership check failed', { socketId: socket.id, meetingId, error: (err as Error)?.message });
    }
  });

  socket.on('save_note', async (note: Record<string, unknown>, ack?: (res: unknown) => void) => {
    const deny = (reason: string) => {
      log.warn(`Rejected save_note: ${reason}`, { socketId: socket.id });
      if (typeof ack === 'function') {
        try { ack({ ok: false, error: reason }); } catch { /* ignore ack errors */ }
      }
    };
    // Rate limit (per-socket + per-user global, in-memory): socket events bypass express-rate-limit.
    // Per-socket alone is bypassable via reconnect / multiple sockets, so also enforce per-uid cap.
    const now = Date.now();
    const hits = (saveNoteTimestamps.get(socket.id) ?? []).filter((t) => now - t < SAVE_NOTE_RATE_WINDOW_MS);
    if (hits.length >= SAVE_NOTE_RATE_MAX) {
      deny('rate limit exceeded');
      return;
    }
    const rateUid = socket.user?.uid as string | undefined;
    let userHits: number[] | undefined;
    if (typeof rateUid === 'string' && rateUid) {
      userHits = (saveNoteUserTimestamps.get(rateUid) ?? []).filter((t) => now - t < SAVE_NOTE_RATE_WINDOW_MS);
      if (userHits.length >= SAVE_NOTE_RATE_MAX) {
        deny('rate limit exceeded');
        return;
      }
    }
    hits.push(now);
    saveNoteTimestamps.set(socket.id, hits);
    if (typeof rateUid === 'string' && rateUid && userHits) {
      userHits.push(now);
      saveNoteUserTimestamps.set(rateUid, userHits);
    }
    const meetingRooms = [...socket.rooms].filter((r) => r.startsWith('meeting:'));
    if (meetingRooms.length === 0) {
      log.warn('Note received but socket not in a meeting room', { socketId: socket.id });
      return;
    }
    // Multi-room guard: reject ambiguous writes; require explicit meetingId in payload to disambiguate.
    let meetingRoom: string;
    if (meetingRooms.length > 1) {
      const explicitId = (note as Record<string, unknown> | null | undefined)?.meetingId;
      if (typeof explicitId !== 'string' || !explicitId || !meetingRooms.includes(`meeting:${explicitId}`)) {
        deny('ambiguous meeting room: provide explicit meetingId in payload');
        return;
      }
      meetingRoom = `meeting:${explicitId}`;
    } else {
      meetingRoom = meetingRooms[0] as string;
      const explicitId = (note as Record<string, unknown> | null | undefined)?.meetingId;
      if (explicitId !== undefined && explicitId !== meetingRoom.replace('meeting:', '')) {
        deny('meetingId mismatch');
        return;
      }
    }
    // Validation: must be a plain object.
    if (!note || typeof note !== 'object' || Array.isArray(note)) {
      deny('invalid note payload');
      return;
    }
    // Size limit: 10kb on serialized payload.
    let serialized: string;
    try {
      serialized = JSON.stringify(note);
    } catch {
      deny('invalid note payload');
      return;
    }
    if (Buffer.byteLength(serialized, 'utf8') > SAVE_NOTE_MAX_BYTES) {
      deny('note exceeds 10kb size limit');
      return;
    }
    // Zod-ish field checks with string length caps.
    const { content, timestamp } = note as { content?: unknown; timestamp?: unknown };
    if (typeof content !== 'string' || !content.trim()) {
      deny('content must be a non-empty string');
      return;
    }
    if (content.length > SAVE_NOTE_CONTENT_MAX_LEN) {
      deny('content exceeds length cap');
      return;
    }
    if (timestamp !== undefined && (typeof timestamp !== 'string' || timestamp.length > SAVE_NOTE_TIMESTAMP_MAX_LEN)) {
      deny('invalid timestamp');
      return;
    }
    // Sanitize: strip HTML tags via simple replace + whitelist fields.
    const sanitizedNote = {
      content: stripTags(content).trim().slice(0, SAVE_NOTE_CONTENT_MAX_LEN),
      ...(typeof timestamp === 'string' ? { timestamp: stripTags(timestamp).slice(0, SAVE_NOTE_TIMESTAMP_MAX_LEN) } : {}),
      receivedAt: new Date().toISOString(),
    };
    if (!sanitizedNote.content) {
      deny('content must be a non-empty string');
      return;
    }
    const meetingId = meetingRoom.replace('meeting:', '');
    // Stale-room guard: re-check buffer owner == uid before store (join-time check alone is insufficient).
    const ownerUid = socket.user?.uid as string | undefined;
    try {
      const meta = await bufferService.get<Record<string, unknown>>(`meeting:${meetingId}`);
      const owner =
        meta && typeof meta === 'object'
          ? ((meta as Record<string, unknown>).ownerUid ??
            (meta as Record<string, unknown>).uid ??
            (meta as Record<string, unknown>).userId ??
            (meta as Record<string, unknown>).owner)
          : null;
      if (typeof owner !== 'string' || owner !== ownerUid) {
        deny('not meeting owner');
        return;
      }
    } catch (err) {
      log.warn('Socket save_note ownership check failed', { socketId: socket.id, meetingId, error: (err as Error)?.message });
      deny('ownership check failed');
      return;
    }
    const key = `notes:${meetingId}`;
    const existing = (await bufferService.get<{ notes: Array<Record<string, unknown>> }>(key)) || { notes: [] };
    existing.notes.push(sanitizedNote);
    await bufferService.store(key, existing);
    log.info('Note stored via WS', { socketId: socket.id, meetingId, uid: socket.user?.uid });
    if (typeof ack === 'function') {
      try { ack({ ok: true }); } catch { /* ignore ack errors */ }
    }
  });

  socket.on('disconnect', () => {
    saveNoteTimestamps.delete(socket.id);
    log.info('Client disconnected', { socketId: socket.id, uid: socket.user?.uid });
  });
});

const gracefulShutdown = async (signal: string) => {
  log.info(`${signal} received. Shutting down gracefully...`);
  
  // Shutdown transcript analysis pipeline first
  transcriptAnalysisPipeline.shutdown();
  
  // Shutdown RTMS connections
  await zoomRTMS.shutdown();
  
  bufferService.shutdown();
  server.close(() => {
    log.info('Server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const port = config.port;

server.listen(port, () => {
  log.info(`Server listening on port ${port}`);
});

export { app, server, io };
