import * as fs from "fs";
import { z } from "zod";
import type { ToolExecutionContext, ToolExecutionResult } from "./executor";
import {
  ensureParentDirectory,
  hasFileChangedSinceState,
  normalizeContent,
  writeTextFile,
} from "../common/file-utils";
import { executeValidatedTool } from "../common/runtime";
import { getFileState, isAbsoluteFilePath, isFullFileView, normalizeFilePath, recordFileState } from "../common/state";

const writeSchema = z.strictObject({
  file_path: z.string().min(1, "file_path is required."),
  content: z.string({
    error:
      "content must be a string. If you are writing JSON, serialize the full document to text before calling write.",
  }),
});

type WriteRepairMetadata = {
  input_repaired: boolean;
  repair_kind: "json-stringify-content";
} | null;

export async function handleWriteTool(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  let repairMetadata: WriteRepairMetadata = null;

  return executeValidatedTool(
    "write",
    writeSchema,
    args,
    context,
    async (input) => {
      const filePath = normalizeFilePath(input.file_path);
      if (!isAbsoluteFilePath(filePath)) {
        return {
          ok: false,
          name: "write",
          error: "file_path must be an absolute path.",
        };
      }

      const existingFile = fs.existsSync(filePath);
      if (existingFile) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            ok: false,
            name: "write",
            error: `Failed to stat file: ${message}`,
          };
        }

        if (stat.isDirectory()) {
          return {
            ok: false,
            name: "write",
            error: "file_path points to a directory.",
          };
        }

        if (stat.size > 0) {
          const fileState = getFileState(context.sessionId, filePath);
          if (!fileState || !isFullFileView(fileState)) {
            return {
              ok: false,
              name: "write",
              error: "Must read the full existing file before writing.",
            };
          }

          if (hasFileChangedSinceState(filePath, fileState)) {
            return {
              ok: false,
              name: "write",
              error: "File has been modified since read. Read it again before writing.",
            };
          }
        }
      }

      const normalizedContent = normalizeContent(input.content);

      try {
        ensureParentDirectory(filePath);

        const encoding = "utf8";
        const lineEndings = input.content.includes("\r\n") ? "CRLF" : "LF";
        const bytes = writeTextFile(filePath, normalizedContent, encoding, lineEndings);
        const lineCount = normalizedContent.split("\n").length;

        recordFileState(context.sessionId, {
          filePath,
          content: normalizedContent,
          timestamp: Math.floor(Date.now()),
          encoding,
          lineEndings,
        });

        const sizeLabel = bytes < 1024
          ? `${bytes}B`
          : bytes < 1024 * 1024
            ? `${(bytes / 1024).toFixed(1)}KB`
            : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

        return {
          ok: true,
          name: "write",
          output: existingFile
            ? `Updated file. (${sizeLabel}, ${lineCount} lines)`
            : `Created file. (${sizeLabel}, ${lineCount} lines)`,
          metadata: {
            type: existingFile ? "update" : "create",
            file_path: filePath,
            bytes,
            encoding,
            line_endings: lineEndings,
            cache_refreshed: true,
            ...repairMetadata,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          name: "write",
          error: message,
        };
      }
    },
    {
      preprocess: (rawInput) => {
        const filePath = typeof rawInput.file_path === "string" ? normalizeFilePath(rawInput.file_path) : "";
        const content = rawInput.content;
        if (
          filePath.toLowerCase().endsWith(".json") &&
          content !== null &&
          typeof content === "object" &&
          !Buffer.isBuffer(content)
        ) {
          repairMetadata = {
            input_repaired: true,
            repair_kind: "json-stringify-content",
          };

          return {
            ok: true,
            input: {
              ...rawInput,
              file_path: filePath,
              content: JSON.stringify(content, null, 2),
            },
          };
        }

        repairMetadata = null;
        return {
          ok: true,
          input: typeof rawInput.file_path === "string" ? { ...rawInput, file_path: filePath } : rawInput,
        };
      },
    },
  );
}
