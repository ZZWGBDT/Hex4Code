/**
 * @file l1-pattern-index.ts
 * @brief L1 pattern index — dynamically generates completion patterns from CodeIndex
 *
 * Automatically scans symbol definitions in the project and builds a Trie completion index.
 * Supports automatic recognition of HEX4 SDK APIs and general language keywords.
 *
 * Hex4 映射:
 *   CodeIndex = 硬件寄存器表
 *   PatternTrie = 地址解码器
 *   TC 标签 = 信号质量标记
 */

import * as fs from "fs";
import * as path from "path";
import { PatternTrie } from "./l1-pattern-trie";
import {
  HEX4_PATTERNS,
  HEX4_STRUCT_TYPES,
  HEX4_HEADERS,
  LOCAL_PATTERNS,
  PIPELINE_STAGE_PATTERNS,
} from "./types";
import type { TCType } from "../tools/executor";

/** L1 模式索引 — 管理所有 L1 补全源 */
export class L1PatternIndex {
  /** 主 Trie 树 */
  private trie: PatternTrie;
  /** 项目根目录 */
  private projectRoot: string;
  /** 缓存路径 */
  private cachePath: string;
  /** 是否已初始化 */
  private initialized = false;
  /** 结构体/类型名的 Trie (用于模糊匹配) */
  private typeTrie: PatternTrie;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.trie = new PatternTrie();
    this.typeTrie = new PatternTrie();
    this.cachePath = path.join(projectRoot, ".hex4code", "pattern-cache.json");

    // 同步加载内置模式（不依赖 IO），确保立即可用
    this.loadBuiltinPatterns();
    this.loadHex4Patterns();
    this.loadPipelinePatterns();
    this.initialized = true;
  }

  /** 初始化索引（加载异步项目扫描） */
  async initialize(): Promise<void> {
    if (this.initialized && this.trie.getPatternCount() > 0) return;

    // 尝试从缓存加载项目模式
    if (!this.loadFromCache()) {
      await this.scanProjectPatterns();
    }

    const count = this.trie.getPatternCount();
    console.log(`[L1] Pattern index initialized: ${count} patterns`);
  }

  /** 搜索匹配的补全模式 */
  search(textBefore: string, language?: string) {
    if (!this.initialized) {
      // 降级：使用基础搜索
      return this.basicSearch(textBefore);
    }
    return this.trie.search(textBefore, language);
  }

  /** 强制重新索引 */
  async reindex(): Promise<void> {
    this.trie.clear();
    this.typeTrie.clear();
    this.initialized = false;
    await this.initialize();
  }

  /** 获取统计信息 */
  getStats() {
    return {
      patternCount: this.trie.getPatternCount(),
      initialized: this.initialized,
      cachePath: this.cachePath,
    };
  }

  // ── 私有方法 ───────────────────────────────────────────────────

  /** 加载内置通用语言模式 */
  private loadBuiltinPatterns(): void {
    this.trie.loadFromRecord(LOCAL_PATTERNS, "TC_NONE", "L1-pattern", 30);
  }

  /** 加载 HEX4 特有模式 */
  private loadHex4Patterns(): void {
    // API 函数和宏 (高优先级)
    this.trie.loadFromRecord(HEX4_PATTERNS, "TC_NONE", "L1-pattern", 0);

    // 结构体类型名 (低优先级，通过 typeTrie 做模糊匹配)
    for (const typeName of HEX4_STRUCT_TYPES) {
      if (typeName.length >= 2) {
        // 为每个可能的前缀插入
        for (let i = 2; i <= typeName.length; i++) {
          const prefix = typeName.substring(0, i);
          this.typeTrie.insert(
            prefix,
            typeName.substring(i),
            "TC_CARRY",
            "L1-pattern",
            20,
            `struct ${typeName}`,
            ["c", "cpp"],
          );
        }
      }
    }

    // #include 头文件补全
    for (const header of HEX4_HEADERS) {
      this.trie.insert(`#include <${header.substring(0, 1)}`, header.substring(1), "TC_NONE", "L1-pattern", 5);
      this.trie.insert(`#include "${header.substring(0, 1)}`, header.substring(1), "TC_NONE", "L1-pattern", 5);
    }
  }

  /** 加载流水线阶段模式 */
  private loadPipelinePatterns(): void {
    this.trie.loadFromRecord(PIPELINE_STAGE_PATTERNS, "TC_CARRY", "L1-pattern", 15);
  }

  /** 从项目文件扫描动态模式 */
  private async scanProjectPatterns(): Promise<void> {
    if (!fs.existsSync(this.projectRoot)) return;

    try {
      // 扫描 package.json 中的依赖 (JS/TS 项目)
      const packageJsonPath = path.join(this.projectRoot, "package.json");
      if (fs.existsSync(packageJsonPath)) {
        this.scanPackageJson(packageJsonPath);
      }

      // 扫描 .c / .h / .cpp 文件中的 HEX4 模式 (C/C++ 项目)
      const sourceFiles = this.findSourceFiles(this.projectRoot, [".c", ".h", ".cpp", ".hpp"], 50);
      for (const file of sourceFiles) {
        this.scanSourceFile(file);
      }

      // 写入缓存
      this.saveToCache();
    } catch (err) {
      console.warn("[L1] Project scan failed:", err);
    }
  }

  /** 扫描 package.json 提取依赖和脚本中的模式 */
  private scanPackageJson(packageJsonPath: string): void {
    try {
      const raw = fs.readFileSync(packageJsonPath, "utf8");
      const pkg = JSON.parse(raw);

      // 从 scripts 中提取 npm 命令
      if (pkg.scripts && typeof pkg.scripts === "object") {
        for (const [name] of Object.entries(pkg.scripts)) {
          this.trie.insert(`npm run ${name.substring(0, 2)}`, name.substring(2), "TC_NONE", "L1-pattern", 25);
        }
      }

      // 从 dependencies 提取导入模式
      if (pkg.dependencies && typeof pkg.dependencies === "object") {
        const deps = Object.keys(pkg.dependencies as Record<string, string>);
        for (const dep of deps) {
          if (dep.startsWith("@")) {
            const parts = dep.split("/");
            if (parts.length === 2) {
              this.trie.insert(`import { ${parts[1].substring(0, 2)}`, `${parts[1].substring(2)}} from "${dep}"`, "TC_CARRY", "L1-pattern", 40);
            }
          }
        }
      }
    } catch {
      // 忽略
    }
  }

  /** 扫描源码文件提取 HEX4 标识符 */
  private scanSourceFile(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      // 匹配 HEX4 标识符: hex4_*, TC_*, Hex4*, ternary_*
      const hex4Matches = content.match(/\b(hex4_\w+|TC_\w+|Hex4\w+|ternary_\w+|sm2_\w+|tc_\w+)\b/g);
      if (hex4Matches) {
        const unique = [...new Set(hex4Matches)];
        for (const id of unique) {
          // 为标识符的前 3 个字符建立补全
          if (id.length >= 3) {
            this.trie.insert(
              id.substring(0, 3),
              id.substring(3),
              "TC_CARRY",
              "L1-pattern",
              35,
              `project ${path.basename(filePath)}`,
            );
          }
        }
      }
    } catch {
      // 忽略
    }
  }

  /** 查找项目中的源码文件（限制数量） */
  private findSourceFiles(root: string, exts: string[], maxFiles: number): string[] {
    const results: string[] = [];
    const walk = (dir: string): void => {
      if (results.length >= maxFiles) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= maxFiles) return;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith(".") && entry.name !== "node_modules" && entry.name !== "dist" && entry.name !== "out") {
              walk(full);
            }
          } else if (entry.isFile() && exts.includes(path.extname(entry.name))) {
            results.push(full);
          }
        }
      } catch {
        // 跳过无权限目录
      }
    };
    walk(root);
    return results;
  }

  /** 从缓存恢复 */
  private loadFromCache(): boolean {
    try {
      if (fs.existsSync(this.cachePath)) {
        // 检查缓存是否过期（24 小时）
        const stat = fs.statSync(this.cachePath);
        const age = Date.now() - stat.mtimeMs;
        if (age < 24 * 60 * 60 * 1000) {
          // 缓存有效，当前仅靠内置模式，不需要从缓存恢复
          // 缓存主要用于未来扩展
          return true;
        }
      }
    } catch {
      // ignore
    }
    return false;
  }

  /** 保存到缓存（占位，未来可扩展） */
  private saveToCache(): void {
    // 当前实现仅保存元数据
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.cachePath,
        JSON.stringify({ updatedAt: Date.now(), count: this.trie.getPatternCount() }),
        "utf8",
      );
    } catch {
      // ignore
    }
  }

  /** 未初始化时的基础降级搜索 */
  private basicSearch(textBefore: string) {
    const results: Array<{
      suffix: string;
      fullText: string;
      tc: TCType;
      source: "L1-pattern";
      priority: number;
      description?: string;
    }> = [];

    // 搜索 HEX4 模式
    for (const [prefix, suggestions] of Object.entries(HEX4_PATTERNS)) {
      if (textBefore.endsWith(prefix)) {
        for (const s of suggestions) {
          results.push({
            suffix: s.substring(prefix.length),
            fullText: s,
            tc: "TC_NONE",
            source: "L1-pattern",
            priority: 0,
          });
        }
        return results;
      }
    }

    // 搜索通用模式 — 直接用 textBefore.endsWith() 匹配，
    // prefix 本身已包含尾随空格（如 "if "），不能 trim
    for (const [prefix, suggestions] of Object.entries(LOCAL_PATTERNS)) {
      if (textBefore.endsWith(prefix)) {
        for (const s of suggestions) {
          const suffix = s.startsWith(prefix) ? s.substring(prefix.length) : "";
          results.push({
            suffix,
            fullText: s,
            tc: "TC_NONE",
            source: "L1-pattern",
            priority: 30,
          });
        }
        return results;
      }
    }

    return results;
  }
}
