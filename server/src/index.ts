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

const isAllowedSocketOrigin = (origin: string | undefined): boolean => {
  // Allow non-browser / same-origin requests with no Origin header.
  if (!origin) return true;
  if (origin === allowedOrigin) return true;
  try {
    const hostname = new URL(origin).hostname;
    if (hostname === 'zoom.us' || hostname.endsWith('.zoom.us')) return true;
    if (hostname.endsWith('.vercel.app')) return true;
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
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
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

  socket.on('save_note', async (note: Record<string, unknown>) => {
    const meetingRoom = [...socket.rooms].find(r => r.startsWith('meeting:'));
    if (!meetingRoom) {
      log.warn('Note received but socket not in a meeting room', { socketId: socket.id });
      return;
    }
    const meetingId = meetingRoom.replace('meeting:', '');
    const key = `notes:${meetingId}`;
    const existing = (await bufferService.get<{ notes: Array<Record<string, unknown>> }>(key)) || { notes: [] };
    existing.notes.push({ ...note, receivedAt: new Date().toISOString() });
    await bufferService.store(key, existing);
    log.info('Note stored via WS', { socketId: socket.id, meetingId, uid: socket.user?.uid });
  });

  socket.on('disconnect', () => {
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
