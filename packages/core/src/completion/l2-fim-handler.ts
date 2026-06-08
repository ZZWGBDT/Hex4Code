/**
 * @file l2-fim-handler.ts
 * @brief FIM API handler — calls LLM for completions + streaming result processing
 *
 * Handles API call logic, supporting streaming output and TC progressive labeling.
 *
 * Hex4 mapping:
 *   API call = external coprocessor request
 *   Streaming output = data arrives cycle by cycle
 *   TC progressive = confidence grows with completeness
 */

import type { FimContext, CompletionItem } from "./types";
import { buildPrompt } from "./l2-fim-prompt";
import { DEFAULT_COMPLETION_CONFIG } from "./types";

/** FIM result callback */
export interface FimCallbacks {
  /** 流式结果到达 */
  onStreamChunk?: (chunk: string, partialTc: "TC_UNCERTAIN" | "TC_CARRY" | "TC_NONE") => void;
  /** 完成时回调 */
  onComplete?: (items: CompletionItem[]) => void;
  /** 错误回调 */
  onError?: (error: string) => void;
}

/** FIM 处理器选项 */
export interface FimHandlerOptions {
  maxTokens?: number;
  temperature?: number;
  modelId: string;
  apiKey: string;
  baseURL: string;
  enableStreaming?: boolean;
}

/** FIM API 处理器 */
export class FimHandler {
  private options: FimHandlerOptions;

  constructor(options: FimHandlerOptions) {
    this.options = {
      ...options,
      maxTokens: options.maxTokens ?? DEFAULT_COMPLETION_CONFIG.maxCompletionTokens,
      temperature: options.temperature ?? DEFAULT_COMPLETION_CONFIG.temperature,
      enableStreaming: options.enableStreaming ?? true,
    };
  }

  /**
   * 执行 FIM 补全（非流式，单次返回）。
   * @returns 补全省略项列表
   */
  async complete(ctx: FimContext): Promise<CompletionItem[]> {
    const { messages, extraParams } = buildPrompt(ctx, this.options.modelId);

    try {
      const response = await fetch(`${this.options.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.modelId,
          messages,
          max_tokens: this.options.maxTokens,
          temperature: this.options.temperature,
          stop: ["\n\n", "\r\n\r\n"],
          ...extraParams,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        throw new Error(`FIM API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string | null };
        }>;
      };

      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) return [];

      return [
        {
          text: content,
          tc: "TC_NONE",
          source: "L2-fim",
          score: 50,
        },
      ];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[FIM] API call failed: ${message}`);
      return [];
    }
  }

  /**
   * 执行 FIM 补全（流式，逐块返回）。
   * 支持渐进式 TC 标签更新。
   */
  async completeStreaming(ctx: FimContext, callbacks: FimCallbacks): Promise<void> {
    const { messages, extraParams } = buildPrompt(ctx, this.options.modelId);

    try {
      const response = await fetch(`${this.options.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.modelId,
          messages,
          max_tokens: this.options.maxTokens,
          temperature: this.options.temperature,
          stop: ["\n\n", "\r\n\r\n"],
          stream: true,
          ...extraParams,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "unknown");
        throw new Error(`FIM streaming error ${response.status}: ${errorText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body for streaming");

      const decoder = new TextDecoder();
      let fullContent = "";
      let buffer = "";
      let chunkCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // 保留最后一个不完整的行

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          try {
            const json = JSON.parse(trimmed.substring(6));
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              chunkCount++;

              // 流式 TC: 开始不确定，积累后变为参考，完整后变为确定
              let partialTc: "TC_UNCERTAIN" | "TC_CARRY" | "TC_NONE";
              if (chunkCount <= 3) {
                partialTc = "TC_UNCERTAIN"; // 前几块不确定
              } else if (chunkCount <= 8) {
                partialTc = "TC_CARRY"; // 累积中，参考用
              } else {
                partialTc = "TC_NONE"; // 稳定输出，确信度高
              }

              callbacks.onStreamChunk?.(delta, partialTc);
            }
          } catch {
            // 忽略解析错误
          }
        }
      }

      // 完成
      if (fullContent.trim()) {
        const items: CompletionItem[] = [
          {
            text: fullContent.trim(),
            tc: "TC_NONE",
            source: "L2-fim",
            score: 50,
          },
        ];
        callbacks.onComplete?.(items);
      } else {
        callbacks.onError?.("Empty FIM completion");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      callbacks.onError?.(message);
    }
  }
}
