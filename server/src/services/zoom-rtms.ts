import WebSocket from 'ws';
import crypto from 'crypto';
import log from '../utils/logger.js';
import { config } from '../config.js';
import bufferService from './buffer-service.js';

interface RTMSAuthPayload {
  func: string;
  payload: {
    sdkKey: string;
    sdkSecret: string;
    topic: string;
    meetingNumber: string;
    password?: string;
    role: number;
  };
}

interface RTMSTranscriptionEvent {
  event: string;
  payload: {
    transcript_id: string;
    message_id: string;
    speaker_name?: string;
    text: string;
    start_time: number;
    end_time: number;
  };
}

interface RTMSConnection {
  ws: WebSocket;
  meetingId: string;
  topic: string;
  authenticated: boolean;
  lastActivity: number;
  reconnectAttempts?: number;
}

type MeetingEmitter = {
  to: (room: string) => { emit: (event: string, payload: unknown) => void };
};

class ZoomRTMSService {
  private connections: Map<string, RTMSConnection> = new Map();
  private heartbeatIntervals: Map<string, NodeJS.Timeout> = new Map();
  private emitter: MeetingEmitter | null = null;
  private static MAX_RECONNECT_ATTEMPTS = 5;
  private static RECONNECT_DELAY_MS = 3000;
  private static HEARTBEAT_INTERVAL_MS = 30000;
  private static CONNECTION_TIMEOUT_MS = 10000;

  constructor() {
    this.startConnectionCleanup();
  }

  /** Inject the Socket.IO server (called once from index.ts). Avoids global.__io. */
  setEmitter(emitter: MeetingEmitter): void {
    this.emitter = emitter;
  }

  private startConnectionCleanup(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [meetingId, conn] of this.connections.entries()) {
        if (now - conn.lastActivity > 60000) {
          log.warn('RTMS connection inactive, closing', { meetingId });
          this.disconnectFromMeeting(meetingId);
        }
      }
    }, 30000).unref();
  }

  async connectToMeeting(meetingId: string, topic: string): Promise<boolean> {
    if (this.connections.has(meetingId)) {
      log.warn('RTMS connection already exists for meeting', { meetingId });
      return true;
    }

    const sdkKey = config.zoom.sdkKey;
    const sdkSecret = config.zoom.sdkSecret;

    if (!sdkKey || !sdkSecret) {
      log.error('Zoom SDK credentials not configured for RTMS');
      return false;
    }

    try {
      const wsUrl = this.buildAuthUrl(meetingId, topic, sdkKey, sdkSecret);
      
      const ws = new WebSocket(wsUrl, {
        headers: {
          'Origin': 'https://rtms2.zoom.us'
        }
      });

      const connectionPromise = new Promise<boolean>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('RTMS connection timeout'));
        }, ZoomRTMSService.CONNECTION_TIMEOUT_MS);

        ws.on('open', () => {
          log.info('RTMS WebSocket connected', { meetingId });
          clearTimeout(timeout);
          this.sendAuth(ws, meetingId, topic, sdkKey, sdkSecret);
        });

        ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(meetingId, message);
            
            if (message.event === 'auth' && message.status === 'success') {
              clearTimeout(timeout);
              const conn = this.connections.get(meetingId);
              if (conn) {
                conn.authenticated = true;
                conn.lastActivity = Date.now();
              }
              log.info('RTMS authenticated successfully', { meetingId });
              resolve(true);
            } else if (message.event === 'auth' && message.status === 'error') {
              clearTimeout(timeout);
              log.error('RTMS authentication failed', { meetingId, error: message.error });
              reject(new Error(`RTMS auth failed: ${message.error}`));
            }
          } catch (err) {
            log.error('Failed to parse RTMS message', { meetingId, error: err });
          }
        });

        ws.on('error', (err: Error) => {
          clearTimeout(timeout);
          log.error('RTMS WebSocket error', { meetingId, error: err.message });
          this.handleConnectionError(meetingId, err);
          reject(err);
        });

        ws.on('close', (code: number, reason: string) => {
          clearTimeout(timeout);
          log.info('RTMS WebSocket closed', { meetingId, code, reason });
          this.handleConnectionClose(meetingId);
        });

        ws.on('pong', () => {
          const conn = this.connections.get(meetingId);
          if (conn) {
            conn.lastActivity = Date.now();
          }
        });
      });

      this.connections.set(meetingId, {
        ws,
        meetingId,
        topic,
        authenticated: false,
        lastActivity: Date.now()
      });

      this.startHeartbeat(meetingId);
      return await connectionPromise;
    } catch (err) {
      log.error('Failed to connect to RTMS', { meetingId, error: err });
      return false;
    }
  }

  private buildAuthUrl(meetingId: string, topic: string, sdkKey: string, sdkSecret: string): string {
    const timestamp = Date.now().toString();
    const stringToSign = `${sdkKey}${meetingId}${timestamp}`;
    const signature = crypto.createHmac('sha256', sdkSecret).update(stringToSign).digest('hex');
    
    return `wss://rtms2.zoom.us/rtms/websocket?sdkKey=${sdkKey}&meetingNumber=${meetingId}&topic=${encodeURIComponent(topic)}&timestamp=${timestamp}&signature=${signature}`;
  }

  private sendAuth(ws: WebSocket, meetingId: string, topic: string, sdkKey: string, sdkSecret: string): void {
    const authPayload: RTMSAuthPayload = {
      func: 'auth',
      payload: {
        sdkKey,
        sdkSecret,
        topic,
        meetingNumber: meetingId,
        role: 0
      }
    };

    ws.send(JSON.stringify(authPayload));
    log.info('RTMS auth request sent', { meetingId });
  }

  private handleMessage(meetingId: string, message: { event?: string; payload?: Record<string, unknown> }): void {
    if (!this.connections.has(meetingId)) return;

    const conn = this.connections.get(meetingId);
    if (!conn) return;
    
    conn.lastActivity = Date.now();

    switch (message.event) {
      case 'transcription':
        this.handleTranscriptionEvent(meetingId, message as unknown as RTMSTranscriptionEvent);
        break;
      case 'meeting_status':
        this.handleMeetingStatusEvent(meetingId, message as { payload?: { status?: string } });
        break;
      case 'participant_update':
        log.info('Participant update received', { meetingId, participant: message.payload?.name });
        break;
      default:
        log.info('Unknown RTMS event', { meetingId, event: message.event });
    }
  }

  private async handleTranscriptionEvent(meetingId: string, event: RTMSTranscriptionEvent): Promise<void> {
    if (!event.payload) {
      log.warn('Invalid transcription event: missing payload', { meetingId });
      return;
    }

    const { speaker_name, text, transcript_id, start_time, end_time } = event.payload;

    if (!text || typeof text !== 'string' || !text.trim()) {
      log.warn('Invalid transcription event: missing text', { meetingId });
      return;
    }
    // Bound server-originated payloads like the HTTP/WS ingest paths (10kb
    // total there; per-field caps here). Trimmed so whitespace-only text and
    // unbounded Zoom strings can't bloat the buffer or broadcasts.
    if (text.length > 10000) {
      log.warn('Transcription event text exceeds length cap, truncating', { meetingId });
    }

    const segment = {
      id: (typeof transcript_id === 'string' && transcript_id.slice(0, 200)) || `transcript-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      speaker: (typeof speaker_name === 'string' ? speaker_name : 'Unknown Speaker').slice(0, 200) || 'Unknown Speaker',
      text: text.trim().slice(0, 10000),
      startTime: typeof start_time === 'string' || typeof start_time === 'number' ? start_time : undefined,
      endTime: typeof end_time === 'string' || typeof end_time === 'number' ? end_time : undefined,
      timestamp: new Date().toISOString()
    };

    try {
      // Store segment in buffer
      const key = `transcript:${meetingId}`;
      const existing = (await bufferService.get<{ segments: Array<Record<string, unknown>> }>(key)) || { segments: [] };
      existing.segments.push(segment);
      await bufferService.store(key, existing);

      // Broadcast to connected clients
      if (this.emitter) {
        this.emitter.to(`meeting:${meetingId}`).emit('transcription', segment);
        log.info('Transcription segment emitted', { meetingId, speaker: segment.speaker });
      }
    } catch (err) {
      log.error('Failed to process transcription segment', { meetingId, error: err });
    }
  }

  private handleMeetingStatusEvent(meetingId: string, event: { payload?: { status?: string } }): void {
    const { status } = event.payload || {};
    if (status === 'ended') {
      log.info('Meeting ended via RTMS', { meetingId });
      this.disconnectFromMeeting(meetingId);
    }
  }

  private handleConnectionError(meetingId: string, err: Error): void {
    if (!this.connections.has(meetingId)) return;

    const conn = this.connections.get(meetingId);
    if (!conn) return;
    
    if (!conn.authenticated) {
      log.error('RTMS connection failed before authentication', { meetingId, error: err.message });
      this.cleanupConnection(meetingId);
      return;
    }

    log.warn('RTMS connection error, attempting reconnect', { meetingId, error: err.message });
    this.reconnectToMeeting(meetingId);
  }

  private handleConnectionClose(meetingId: string): void {
    if (!this.connections.has(meetingId)) return;

    const conn = this.connections.get(meetingId);
    if (!conn) return;
    
    if (conn.authenticated) {
      log.info('RTMS connection lost, attempting reconnect', { meetingId });
      this.reconnectToMeeting(meetingId);
    } else {
      this.cleanupConnection(meetingId);
    }
  }

  private async reconnectToMeeting(meetingId: string): Promise<void> {
    if (!this.connections.has(meetingId)) return;

    const conn = this.connections.get(meetingId);
    if (!conn) return;
    
    const attempt = conn.reconnectAttempts || 0;

    if (attempt >= ZoomRTMSService.MAX_RECONNECT_ATTEMPTS) {
      log.error('Max reconnect attempts reached for RTMS', { meetingId });
      this.cleanupConnection(meetingId);
      return;
    }

    conn.reconnectAttempts = attempt + 1;
    const topic = conn.topic;
    
    setTimeout(async () => {
      if (!this.connections.has(meetingId)) return;
      
      this.cleanupConnection(meetingId);
      const success = await this.connectToMeeting(meetingId, topic);
      if (!success) {
        log.error('RTMS reconnect failed', { meetingId });
      }
    }, ZoomRTMSService.RECONNECT_DELAY_MS * (attempt + 1));
  }

  private startHeartbeat(meetingId: string): void {
    // unref so idle heartbeat timers never keep the process alive on their own
    // (matches the connection-cleanup interval in the constructor).
    const interval = setInterval(() => {
      if (!this.connections.has(meetingId)) {
        clearInterval(interval);
        return;
      }

      const conn = this.connections.get(meetingId);
      if (!conn) {
        clearInterval(interval);
        return;
      }
      
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.ping();
      } else {
        clearInterval(interval);
      }
    }, ZoomRTMSService.HEARTBEAT_INTERVAL_MS);
    interval.unref();

    this.heartbeatIntervals.set(meetingId, interval);
  }

  private cleanupConnection(meetingId: string): void {
    const conn = this.connections.get(meetingId);
    if (conn) {
      try {
        if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
          conn.ws.close();
        }
      } catch (err) {
        log.error('Error closing RTMS connection', { meetingId, error: err });
      }
    }
    
    this.connections.delete(meetingId);
    
    const heartbeatInterval = this.heartbeatIntervals.get(meetingId);
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      this.heartbeatIntervals.delete(meetingId);
    }
  }

  async disconnectFromMeeting(meetingId: string): Promise<void> {
    if (!this.connections.has(meetingId)) {
      return;
    }

    log.info('Disconnecting from RTMS', { meetingId });
    this.cleanupConnection(meetingId);
  }

  isMeetingConnected(meetingId: string): boolean {
    const conn = this.connections.get(meetingId);
    return conn?.authenticated === true && conn.ws.readyState === WebSocket.OPEN;
  }

  getConnectedMeetingIds(): string[] {
    return Array.from(this.connections.keys()).filter(id => this.isMeetingConnected(id));
  }

  async shutdown(): Promise<void> {
    log.info('Shutting down RTMS service');
    
    for (const meetingId of this.connections.keys()) {
      await this.disconnectFromMeeting(meetingId);
    }
    
    for (const interval of this.heartbeatIntervals.values()) {
      clearInterval(interval);
    }
    
    this.heartbeatIntervals.clear();
  }
}

export default new ZoomRTMSService();
