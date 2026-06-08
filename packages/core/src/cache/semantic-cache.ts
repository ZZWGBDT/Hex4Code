/// @file semantic-cache.ts
/// @brief Semantic cache engine — n-gram similarity based LLM response cache
///
/// How it works:
///   1. Compute n-gram feature vector for each query (character 3-gram)
///   2. When a new query arrives, calculate cosine similarity with cached entries
///   3. Similarity exceeds threshold (default 0.85) and same model -> return cached response
///   4. Automatic TTL expiration (default 1 hour) and LRU eviction (default 200 entries)
///
/// Pure in-memory implementation, no external dependencies. Optional persistence to JSON file.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface CacheEntry {
  /** 缓存键（原始 query） */
  query: string;
  /** LLM 响应文本 */
  response: string;
  /** 使用的模型 ID */
  model: string;
  /** 创建时间戳 */
  createdAt: number;
  /** TTL（毫秒），默认 3600000 */
  ttl: number;
  /** 访问计数（用于 LRU 淘汰） */
  accessCount: number;
  /** 最后访问时间（用于 LRU 淘汰） */
  lastAccessed: number;
  /** n-gram 特征向量 */
  fingerprint: Record<string, number>;
}

export interface SemanticCacheConfig {
  /** 相似度阈值 (0.0-1.0)，默认 0.85 */
  threshold?: number;
  /** 最大缓存条目数，默认 200 */
  maxEntries?: number;
  /** 默认 TTL（毫秒），默认 3600000 (1h) */
  defaultTtl?: number;
  /** 启用持久化 */
  persistPath?: string;
}

const DEFAULT_CONFIG: Required<SemanticCacheConfig> = {
  threshold: 0.85,
  maxEntries: 200,
  defaultTtl: 3600000,
  persistPath: "",
};

export class SemanticCache {
  private entries: CacheEntry[] = [];
  private config: Required<SemanticCacheConfig>;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: SemanticCacheConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 从磁盘加载持久化缓存
    if (this.config.persistPath) {
      this.loadFromDisk();
      // 每 5 分钟持久化一次（unref 防止阻塞进程退出）
      this.persistTimer = setInterval(() => this.persistToDisk(), 300000);
      this.persistTimer.unref();
    }
  }

  /** 释放资源 */
  dispose(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.config.persistPath) {
      this.persistToDisk();
    }
  }

  /** 清除所有过期条目 */
  evictExpired(): number {
    const now = Date.now();
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => now - e.createdAt < e.ttl);
    return before - this.entries.length;
  }

  /** LRU 淘汰：移除最久未访问的条目 */
  evictLRU(targetCount: number): number {
    if (this.entries.length <= targetCount) return 0;
    this.entries.sort((a, b) => a.lastAccessed - b.lastAccessed);
    const removed = this.entries.length - targetCount;
    this.entries = this.entries.slice(removed);
    return removed;
  }

  /** 计算文本的 n-gram 特征向量 */
  private computeFingerprint(text: string, n: number = 3): Record<string, number> {
    const fingerprint: Record<string, number> = {};
    const normalized = text.toLowerCase().replace(/\s+/g, " ");
    for (let i = 0; i <= normalized.length - n; i++) {
      const gram = normalized.substring(i, i + n);
      fingerprint[gram] = (fingerprint[gram] || 0) + 1;
    }
    return fingerprint;
  }

  /** 计算两个特征向量的余弦相似度 */
  private cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (const key in a) {
      normA += a[key] * a[key];
      if (key in b) dotProduct += a[key] * b[key];
    }
    for (const key in b) {
      normB += b[key] * b[key];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /** 查找缓存命中 */
  find(query: string, model: string): { hit: true; entry: CacheEntry } | { hit: false } {
    this.evictExpired();

    const queryFingerprint = this.computeFingerprint(query);

    let bestScore = 0;
    let bestEntry: CacheEntry | null = null;

    for (const entry of this.entries) {
      if (entry.model !== model) continue;
      const score = this.cosineSimilarity(queryFingerprint, entry.fingerprint);
      if (score > bestScore) {
        bestScore = score;
        bestEntry = entry;
      }
    }

    if (bestEntry && bestScore >= this.config.threshold) {
      bestEntry.accessCount++;
      bestEntry.lastAccessed = Date.now();
      return { hit: true, entry: bestEntry };
    }

    return { hit: false };
  }

  /** 写入缓存 */
  set(query: string, response: string, model: string, ttl?: number): void {
    // 清理过期条目
    this.evictExpired();

    // LRU 淘汰
    if (this.entries.length >= this.config.maxEntries) {
      this.evictLRU(Math.floor(this.config.maxEntries * 0.7));
    }

    const fingerprint = this.computeFingerprint(query);
    this.entries.push({
      query,
      response,
      model,
      createdAt: Date.now(),
      ttl: ttl ?? this.config.defaultTtl,
      accessCount: 0,
      lastAccessed: Date.now(),
      fingerprint,
    });
  }

  /** 清空缓存 */
  clear(): void {
    this.entries = [];
  }

  /** 缓存统计 */
  stats(): { totalEntries: number; totalModels: string[]; hitRate: number; hits: number; misses: number } {
    const models = new Set(this.entries.map((e) => e.model));
    return {
      totalEntries: this.entries.length,
      totalModels: [...models],
      hitRate: this.hits / (this.hits + this.misses || 1),
      hits: this.hits,
      misses: this.misses,
    };
  }

  private hits = 0;
  private misses = 0;

  /** 查找并自动记录命中/未命中 */
  findWithStats(query: string, model: string): { hit: true; entry: CacheEntry } | { hit: false } {
    const result = this.find(query, model);
    if (result.hit) this.hits++;
    else this.misses++;
    return result;
  }

  // ── 持久化 ──────────────────────────────────────────────────────────

  private persistToDisk(): void {
    if (!this.config.persistPath) return;
    try {
      const dir = path.dirname(this.config.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 不持久化 fingerprint（可重算），只存原始数据
      const data = this.entries.map((e) => ({
        query: e.query,
        response: e.response,
        model: e.model,
        createdAt: e.createdAt,
        ttl: e.ttl,
        accessCount: e.accessCount,
        lastAccessed: e.lastAccessed,
      }));
      fs.writeFileSync(this.config.persistPath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      /* 持久化失败不阻塞主流程 */
    }
  }

  private loadFromDisk(): void {
    if (!this.config.persistPath) return;
    try {
      if (!fs.existsSync(this.config.persistPath)) return;
      const raw = fs.readFileSync(this.config.persistPath, "utf8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) return;
      this.entries = data
        .filter(
          (e: Record<string, unknown>) =>
            e && typeof e.query === "string" && typeof e.response === "string" && typeof e.model === "string",
        )
        .map((e: Record<string, unknown>) => ({
          query: e.query as string,
          response: e.response as string,
          model: e.model as string,
          createdAt: (e.createdAt as number) || Date.now(),
          ttl: (e.ttl as number) || this.config.defaultTtl,
          accessCount: (e.accessCount as number) || 0,
          lastAccessed: (e.lastAccessed as number) || Date.now(),
          fingerprint: this.computeFingerprint(e.query as string),
        }));
      // 加载时清理过期条目
      this.evictExpired();
    } catch {
      /* 加载失败不阻塞 */
    }
  }
}

/** 全局单例（进程级别） */
let _globalCache: SemanticCache | null = null;

/** 获取或创建全局语义缓存（自动设置默认持久化路径） */
export function getGlobalCache(config?: SemanticCacheConfig): SemanticCache {
  if (!_globalCache) {
    const cfg: SemanticCacheConfig = { ...config };
    if (!cfg.persistPath) {
      try {
        cfg.persistPath = path.join(os.homedir(), ".hex4code", "cache", "semantic-cache.json");
      } catch {
        /* no persistence fallback */
      }
    }
    _globalCache = new SemanticCache(cfg);
  }
  return _globalCache;
}

/** 重置全局缓存（主要用于测试） */
export function resetGlobalCache(): void {
  if (_globalCache) {
    _globalCache.dispose();
    _globalCache = null;
  }
}
