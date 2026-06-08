/**
 * @file completion-debounce.ts
 * @brief Debounce engine — reduces unnecessary API calls
 *
 * Delays triggering completion requests when the user types quickly.
 * A new keystroke cancels the previous pending request.
 *
 * Hex4 映射:
 *   引擎层: 去抖 = 信号滤波
 *   类比: 三进制信号需要稳定后再采样
 */

/** 轻量 CancellationToken 接口声明（兼容 VS Code） */
interface CancellationToken {
  readonly isCancellationRequested: boolean;
  readonly onCancellationRequested?: (listener: () => void) => void;
}

/** 去抖状态机 */
export class CompletionDebouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingId = 0;
  private lastDebounceMs = 150;

  constructor(debounceMs = 150) {
    this.lastDebounceMs = debounceMs;
  }

  /**
   * 等待去抖周期。
   * @param ms 去抖毫秒数
   * @param token 取消令牌
   * @returns true = 可以继续, false = 被取消
   */
  wait(ms?: number, token?: CancellationToken): Promise<boolean> {
    const delay = ms ?? this.lastDebounceMs;
    const id = ++this.pendingId;

    // 清除上一次的定时器
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    return new Promise<boolean>((resolve) => {
      this.timer = setTimeout(() => {
        this.timer = null;
        // 如果在此期间有更新的请求，放弃本次
        if (id !== this.pendingId) {
          resolve(false);
          return;
        }
        resolve(true);
      }, delay);

      // 如果外部 token 取消，也放弃
      if (token) {
        const onCancel = (): void => {
          if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
          }
          resolve(false);
        };
        // 兼容 VS Code 的 CancellationToken
        if (typeof token.onCancellationRequested === "function") {
          token.onCancellationRequested(onCancel);
        }
      }
    });
  }

  /** 立即取消当前等待 */
  cancel(): void {
    this.pendingId++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 更新去抖延迟 */
  setDebounceMs(ms: number): void {
    this.lastDebounceMs = ms;
  }

  /** 释放资源 */
  dispose(): void {
    this.cancel();
  }
}

/**
 * 检查是否应触发补全。
 * 过滤掉注释、字符串内部等不合适的补全位置。
 */
export function shouldTriggerCompletion(
  textBefore: string,
  languageId: string,
  skipLanguages: Set<string>,
  minLength: number,
): boolean {
  // 跳过整行为空
  const trimmed = textBefore.trim();
  if (!trimmed || trimmed.length < minLength) return false;

  // 跳过指定语言
  if (skipLanguages.has(languageId)) return false;

  // 跳过注释行
  if (isInsideComment(textBefore, languageId)) return false;

  // 跳过纯空白
  if (/^\s+$/.test(textBefore)) return false;

  return true;
}

/** 检测光标是否在注释中 */
function isInsideComment(text: string, language: string): boolean {
  const lastLine = text.split("\n").pop() || "";
  const trimmedLine = lastLine.trimStart();

  // 单行注释
  const lineCommentMarkers: Record<string, string[]> = {
    c: ["//"],
    cpp: ["//"],
    javascript: ["//"],
    typescript: ["//"],
    python: ["#"],
    go: ["//"],
    rust: ["//"],
    java: ["//"],
    ruby: ["#"],
    php: ["//", "#"],
    swift: ["//"],
    kotlin: ["//"],
    scala: ["//"],
  };

  const markers = lineCommentMarkers[language] || [];
  for (const marker of markers) {
    if (trimmedLine.startsWith(marker)) return true;
    // 也检测行内注释（marker 出现在文本中）
    if (trimmedLine.includes(marker) && !isInsideString(trimmedLine, marker)) return true;
  }

  // 块注释（简单检测：是否在 /* */ 之间）
  if (language === "c" || language === "cpp" || language === "javascript" || language === "typescript" || language === "java" || language === "go" || language === "rust" || language === "swift" || language === "kotlin" || language === "scala") {
    const lines = text.split("\n");
    let inBlockComment = false;
    for (const line of lines) {
      if (line.includes("/*")) inBlockComment = true;
      if (line.includes("*/")) inBlockComment = false;
    }
    if (inBlockComment) return true;
  }

  return false;
}

/** 简单检测目标标记是否在字符串内部 */
function isInsideString(line: string, marker: string): boolean {
  const idx = line.indexOf(marker);
  if (idx === -1) return false;
  const before = line.substring(0, idx);
  const singleQuotes = (before.match(/'/g) || []).length;
  const doubleQuotes = (before.match(/"/g) || []).length;
  // 如果奇数个引号，则可能在字符串中
  return singleQuotes % 2 === 1 || doubleQuotes % 2 === 1;
}
