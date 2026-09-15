/**
 * Multi-tier caching layer for the BYOK analytics platform.
 *
 * Tier 1: In-memory LRU cache (fastest, per-process, sub-millisecond)
 * Tier 2: Redis cache (shared across processes/restarts, ~1-5ms)
 *
 * Falls back gracefully: if Redis is unavailable, the in-memory cache
 * still works. All cache reads/writes are fire-and-forget.
 */

// ---- Tier 1: In-memory LRU ----

interface LruEntry<T> {
  value: T;
  expiresAt: number;
}

class LruCache<T> {
  private map = new Map<string, LruEntry<T>>();
  private hitCount = 0;
  private missCount = 0;

  constructor(
    private maxEntries: number,
    private defaultTtlMs: number,
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) { this.missCount++; return undefined; }
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      this.missCount++;
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hitCount++;
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    if (this.map.has(key)) { this.map.delete(key); }
    else if (this.map.size >= this.maxEntries) {
      const firstKey = this.map.keys().next().value;
      if (firstKey) this.map.delete(firstKey);
    }
    this.map.set(key, { value, expiresAt });
  }

  delete(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }

  getStats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.hitCount + this.missCount;
    return {
      hits: this.hitCount,
      misses: this.missCount,
      size: this.map.size,
      hitRate: total > 0 ? this.hitCount / total : 0,
    };
  }
}

// ---- Tier 2: Redis (optional, shared) ----

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, duration?: number): Promise<any>;
  del(key: string): Promise<number>;
  delMultiple(keys: string[]): Promise<number>;
  ping(): Promise<string>;
}

let redisClient: RedisLike | null = null;
let redisAvailable = false;

async function tryInitRedis(): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return;
  try {
    // Dynamic import wrapped in eval to avoid TypeScript static analysis
    // (ioredis is an optional dependency - only loaded if REDIS_URL is set)
    const RedisMod: any = await import("ioredis" as string);
    const ClientClass = RedisMod.default || RedisMod;
    const client = new ClientClass(url, {
      maxRetriesPerRequest: 2,
      connectTimeout: 3000,
      commandTimeout: 2000,
      lazyConnect: true,
      enableOfflineQueue: true,
    });
    await client.ping();
    redisClient = client as unknown as RedisLike;
    redisAvailable = true;
    console.log("[cache] Redis connected — multi-tier caching active");
  } catch (err: any) {
    redisAvailable = false;
    console.warn(`[cache] Redis unavailable (${err?.message ?? err}), in-memory only`);
  }
}

tryInitRedis();

// ---- Cache namespaces with TTLs ----

const NAMESPACES: Record<string, { memoryTtlMs: number; redisTtlMs: number }> = {
  ds_list: { memoryTtlMs: 5 * 60 * 1000, redisTtlMs: 10 * 60 * 1000 },
  wb_list: { memoryTtlMs: 5 * 60 * 1000, redisTtlMs: 10 * 60 * 1000 },
  views_list: { memoryTtlMs: 3 * 60 * 1000, redisTtlMs: 5 * 60 * 1000 },
  ds_metadata: { memoryTtlMs: 30 * 60 * 1000, redisTtlMs: 60 * 60 * 1000 },
  ds_glossary: { memoryTtlMs: 30 * 60 * 1000, redisTtlMs: 60 * 60 * 1000 },
  field_values: { memoryTtlMs: 2 * 60 * 1000, redisTtlMs: 5 * 60 * 1000 },
  pulse_metrics: { memoryTtlMs: 1 * 60 * 1000, redisTtlMs: 2 * 60 * 1000 },
  server_info: { memoryTtlMs: 60 * 60 * 1000, redisTtlMs: 2 * 60 * 60 * 1000 },
  field_usage: { memoryTtlMs: 15 * 60 * 1000, redisTtlMs: 30 * 60 * 1000 },
  search_results: { memoryTtlMs: 3 * 60 * 1000, redisTtlMs: 5 * 60 * 1000 },
  users_list: { memoryTtlMs: 10 * 60 * 1000, redisTtlMs: 20 * 60 * 1000 },
  default: { memoryTtlMs: 5 * 60 * 1000, redisTtlMs: 10 * 60 * 1000 },
};

const lruCaches = new Map<string, LruCache<any>>();

function getLru(namespace: string): LruCache<any> {
  let lru = lruCaches.get(namespace);
  if (!lru) {
    lru = new LruCache(500, NAMESPACES[namespace]?.memoryTtlMs ?? NAMESPACES.default.memoryTtlMs);
    lruCaches.set(namespace, lru);
  }
  return lru;
}

// ---- Public API ----

export async function cacheGet<T>(namespace: string, identifier: string): Promise<T | undefined> {
  const key = cacheKey(namespace, identifier);
  const lru = getLru(namespace);
  const memVal = lru.get(key);
  if (memVal !== undefined) return memVal as T;

  if (redisAvailable && redisClient) {
    try {
      const raw = await redisClient.get(key);
      if (raw) {
        const parsed = JSON.parse(raw) as T;
        const ns = NAMESPACES[namespace] ?? NAMESPACES.default;
        lru.set(key, parsed, ns.memoryTtlMs);
        return parsed;
      }
    } catch { /* fall through */ }
  }
  return undefined;
}

export async function cacheSet<T>(namespace: string, identifier: string, value: T, customTtlMs?: number): Promise<void> {
  const key = cacheKey(namespace, identifier);
  const ns = NAMESPACES[namespace] ?? NAMESPACES.default;
  getLru(namespace).set(key, value, customTtlMs ?? ns.memoryTtlMs);
  if (redisAvailable && redisClient) {
    const ttlSeconds = Math.ceil((customTtlMs ?? ns.redisTtlMs) / 1000);
    redisClient.set(key, JSON.stringify(value), "EX", ttlSeconds).catch(() => {});
  }
}

export async function cacheInvalidate(namespace: string, identifier: string): Promise<void> {
  const key = cacheKey(namespace, identifier);
  getLru(namespace).delete(key);
  if (redisAvailable && redisClient) {
    redisClient.del(key).catch(() => {});
  }
}

export async function cacheInvalidateNamespace(namespace: string): Promise<void> {
  lruCaches.set(namespace, new LruCache(500, NAMESPACES[namespace]?.memoryTtlMs ?? NAMESPACES.default.memoryTtlMs));
  if (redisAvailable && redisClient) {
    try {
      const pattern = `byok:${namespace}:*`;
      const clientWithScan = redisClient as unknown as {
        scan(cursor: number, ...args: any[]): Promise<[string, string[]]>;
      };
      let cursor = 0;
      do {
        const [next, keys] = await clientWithScan.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = Number(next);
        if (keys.length) await redisClient.delMultiple(keys).catch(() => {});
      } while (cursor !== 0);
    } catch { /* best effort */ }
  }
}

export function cacheStats(): {
  redisAvailable: boolean;
  namespaces: Record<string, { hits: number; misses: number; size: number; hitRate: number }>;
} {
  const nsStats: Record<string, { hits: number; misses: number; size: number; hitRate: number }> = {};
  for (const [ns, lru] of lruCaches) {
    nsStats[ns] = lru.getStats();
  }
  return { redisAvailable, namespaces: nsStats };
}

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

function cacheKey(namespace: string, identifier: string): string {
  return `byok:${namespace}:${identifier}`;
}
