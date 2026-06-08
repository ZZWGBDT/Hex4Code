/**
 * @file completion-cache.ts
 * @brief Completion result cache — reduces duplicate FIM API calls
 *
 * Exact hash cache based on prefix+suffix+model+language.
 * Shares the same caching philosophy as semantic-cache.ts.
 *
 * Hex4 映射:
 *   语义缓存 = 重复查询的快速路径
 *   LRU 淘汰 = 缓存空间的管理
 *   TTL 过期 = 数据时效性保证
 */

import * as crypto from "crypto";
import type { CompletionItem, CompletionCacheEntry } from "./types";
import { DEFAULT_COMPLETION_CONFIG } from "./types";

export class CompletionCache {
  private entries = new Map<string, CompletionCacheEntry>();
  private maxEntries: number;
  private defaultTtl: number;
  private hits = 0;
  private misses = 0;

  constructor(maxEntries?: number, defaultTtl?: number) {
    this.maxEntries = maxEntries ?? DEFAULT_COMPLETION_CONFIG.cacheMaxEntries;
    this.defaultTtl = defaultTtl ?? DEFAULT_COMPLETION_CONFIG.cacheTtl;
  }

  /**
   * 生成缓存键。
   * 使用 SHA-256 哈希 prefix + suffix + model + language。
   */
  makeKey(prefix: string, suffix: string, model: string, language: string): string {
    const raw = `${prefix}||${suffix}||${model}||${language}`;
    return crypto.createHash("sha256").update(raw).digest("hex").substring(0, 32);
  }

  /**
   * 查找缓存。
   * @returns 命中返回补全省略项列表，未命中返回 null
   */
  get(key: string): CompletionItem[] | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // 检查 TTL
    if (Date.now() - entry.createdAt > entry.ttl) {
      this.entries.delete(key);
      this.misses++;
      return null;
    }

    // 更新访问信息
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    this.hits++;
    return entry.items;
  }

  /**
   * 写入缓存。
   */
  set(key: string, items: CompletionItem[], ttl?: number): void {
    // 如果缓存已满，淘汰最久未访问的条目
    if (this.entries.size >= this.maxEntries) {
      this.evictLru();
    }

    this.entries.set(key, {
      key,
      items,
      createdAt: Date.now(),
      ttl: ttl ?? this.defaultTtl,
      accessCount: 0,
      lastAccessed: Date.now(),
    });
  }

  /**
   * 基于 key 前缀的模糊查找（用于语义近似匹配）。
   * 查找同一 prefix 开头的缓存条目，返回最相似的。
   */
  fuzzyFind(prefix: string, model: string, language: string): CompletionItem[] | null {
    let bestMatch: { items: CompletionItem[]; score: number } | null = null;

    for (const [key, entry] of this.entries) {
      // 检查 TTL
      if (Date.now() - entry.createdAt > entry.ttl) {
        this.entries.delete(key);
        continue;
      }

      // 必须同模型同语言
      if (!key.includes(model) || !key.includes(language)) continue;

      // 简单前缀匹配：缓存 key 中的 prefix 部分与当前 prefix 的相似度
      const cachedPrefix = key.split("||")[0];
      if (cachedPrefix) {
        const score = this.stringSimilarity(prefix, cachedPrefix);
        if (score > 0.8 && (!bestMatch || score > bestMatch.score)) {
          bestMatch = { items: entry.items, score };
        }
      }
    }

    if (bestMatch) {
      this.hits++;
      return bestMatch.items;
    }
    this.misses++;
    return null;
  }

  /** 清除所有缓存 */
  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }

  /** 获取统计信息 */
  stats(): { totalEntries: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      totalEntries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /** 淘汰最久未访问的条目 (LRU) */
  private evictLru(): void {
    let oldest: { key: string; time: number } | null = null;
    for (const [key, entry] of this.entries) {
      if (!oldest || entry.lastAccessed < oldest.time) {
        oldest = { key, time: entry.lastAccessed };
      }
    }
    if (oldest) {
      this.entries.delete(oldest.key);
    }
  }

  /**
   * 计算两个字符串的相似度（0.0 - 1.0）。
   * 基于字符级 n-gram 重叠率。
   */
  private stringSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    if (a.length < 2 || b.length < 2) return 0.0;

    // 使用 3-gram
    const gramsA = this.getNGrams(a, 3);
    const gramsB = this.getNGrams(b, 3);

    if (gramsA.size === 0 || gramsB.size === 0) return 0.0;

    let intersection = 0;
    for (const gram of gramsA) {
      if (gramsB.has(gram)) intersection++;
    }

    const union = gramsA.size + gramsB.size - intersection;
    return union > 0 ? intersection / union : 0.0;
  }

  private getNGrams(text: string, n: number): Set<string> {
    const grams = new Set<string>();
    for (let i = 0; i <= text.length - n; i++) {
      grams.add(text.substring(i, i + n));
    }
    return grams;
  }
}
