import log from '../utils/logger.js';
import { config } from '../config.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClient = any;

interface BufferEntry<T> {
  data: T;
  timestamp: number;
}

class BufferService {
  private buffer: Map<string, BufferEntry<unknown>>;
  private ttl: number;
  private cleanupInterval: NodeJS.Timeout;
  private redis: RedisClient | null = null;
  private useRedis = false;
  private static MAX_ENTRIES = 10000;
  // FIX-SRE-R4: per-meeting segment cap — bounds a single meeting's growth
  // so one meeting cannot exhaust memory. Overflow is an explicit 429,
  // never a silent drop.
  private static MAX_SEGMENTS_PER_MEETING = 2000;

  constructor(ttlMs: number = 24 * 60 * 60 * 1000) {
    this.buffer = new Map();
    this.ttl = ttlMs;
    this.cleanupInterval = setInterval(() => this._cleanup(), 15 * 60 * 1000);
    this.cleanupInterval.unref();
    this._initRedis();
  }

  private async _initRedis() {
    if (config.redis.url) {
      try {
        const ioredis = await import('ioredis');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Redis = ioredis.default as any;
        this.redis = new Redis(config.redis.url, {
          maxRetriesPerRequest: 3,
          retryStrategy(times: number) {
            if (times > 3) return null;
            return Math.min(times * 200, 2000);
          },
        });
        this.redis.on('connect', () => {
          this.useRedis = true;
          log.info('Redis connected for buffer service');
          void this._resyncToRedis();
        });
        this.redis.on('close', () => {
          if (this.useRedis) {
            log.warn('Redis connection closed, using in-memory buffer');
            this.useRedis = false;
          }
        });
        this.redis.on('error', (err: Error) => {
          if (this.useRedis) {
            log.error('Redis error, falling back to in-memory', { error: err.message });
            this.useRedis = false;
          }
        });
      } catch {
        log.warn('Redis not available, using in-memory buffer');
      }
    }
  }

  async store<T>(key: string, data: T): Promise<void> {
    // FIX-SRE-R4: per-meeting segment cap. Unbounded `segments` arrays let a
    // single meeting exhaust memory; reject with an explicit 429 so callers
    // (and the HTTP error handler) surface 429 instead of silently dropping.
    const segments = (data as unknown as { segments?: unknown })?.segments;
    if (Array.isArray(segments) && segments.length > BufferService.MAX_SEGMENTS_PER_MEETING) {
      log.warn('Per-meeting segment cap exceeded, rejecting write', {
        key,
        size: segments.length,
        cap: BufferService.MAX_SEGMENTS_PER_MEETING,
      });
      const err = new Error(
        `Segment limit exceeded for ${key}: ${segments.length} > ${BufferService.MAX_SEGMENTS_PER_MEETING}`,
      ) as Error & { statusCode: number; status: number };
      err.statusCode = 429;
      err.status = 429;
      throw err;
    }
    const entry: BufferEntry<T> = { data, timestamp: Date.now() };
    // Dual-write: always keep in-memory copy so Redis flaps never lose writes.
    // FIX-SRE-R4: LRU eviction instead of global silent drop. The old global
    // 10k silent-drop let one tenant DoS all others with no signal; evict the
    // least-recently-used key so every write either succeeds or throws 429.
    if (this.buffer.has(key)) {
      this.buffer.delete(key);
    } else if (this.buffer.size >= BufferService.MAX_ENTRIES) {
      this._cleanup();
      while (this.buffer.size >= BufferService.MAX_ENTRIES) {
        const oldest = this.buffer.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.buffer.delete(oldest);
        log.warn('Buffer at capacity, evicted LRU entry', { evicted: oldest, key });
      }
    }
    this.buffer.set(key, entry);
    if (this.useRedis && this.redis) {
      try {
        await this.redis.set(key, JSON.stringify(entry), 'PX', this.ttl);
      } catch (err) {
        log.warn('Redis write failed, kept in-memory copy', {
          key,
          error: (err as Error).message,
        });
      }
    }
  }

  async get<T>(key: string): Promise<T | null> {
    // Redis-first, then memory fallback (fixes split-brain on flap).
    if (this.useRedis && this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (raw) {
          try {
            const entry: BufferEntry<T> = JSON.parse(raw);
            return entry.data as T;
          } catch {
            // Corrupt Redis payload — fall through to memory.
          }
        }
      } catch {
        // Redis read failed — fall through to in-memory.
      }
    }
    const entry = this.buffer.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttl) {
      this.buffer.delete(key);
      return null;
    }
    // FIX-SRE-R4: LRU recency — re-insert on hit so eviction drops the
    // least-recently-used key (timestamp/TTL preserved).
    this.buffer.delete(key);
    this.buffer.set(key, entry);
    return entry.data as T;
  }

  async delete(key: string): Promise<void> {
    // Dual-delete: remove from both stores so no stale copy survives a flap.
    this.buffer.delete(key);
    if (this.useRedis && this.redis) {
      try {
        await this.redis.del(key);
      } catch {
        // In-memory copy already removed; Redis will expire via TTL.
      }
    }
  }

  shutdown(): void {
    clearInterval(this.cleanupInterval);
    this.buffer.clear();
    if (this.redis) {
      this.redis.quit();
    }
  }

  private _cleanup(): void {
    const now = Date.now();
    for (const [key, value] of this.buffer.entries()) {
      if (now - value.timestamp > this.ttl) {
        this.buffer.delete(key);
      }
    }
  }

  private async _resyncToRedis(): Promise<void> {
    if (!this.redis || !this.useRedis || this.buffer.size === 0) return;
    const now = Date.now();
    let synced = 0;
    try {
      const pipeline = typeof this.redis.pipeline === 'function' ? this.redis.pipeline() : null;
      for (const [key, value] of this.buffer.entries()) {
        const elapsed = now - value.timestamp;
        if (elapsed > this.ttl) {
          this.buffer.delete(key);
          continue;
        }
        const remaining = this.ttl - elapsed;
        if (pipeline) {
          pipeline.set(key, JSON.stringify(value), 'PX', remaining);
        } else {
          await this.redis.set(key, JSON.stringify(value), 'PX', remaining);
          synced++;
        }
      }
      if (pipeline) {
        const results = await pipeline.exec();
        synced = Array.isArray(results) ? results.length : this.buffer.size;
      }
      log.info('Resynced in-memory buffer to Redis', { synced, size: this.buffer.size });
    } catch (err) {
      log.warn('Redis resync failed, keeping in-memory copies', {
        error: (err as Error).message,
      });
    }
  }
}

export default new BufferService();
