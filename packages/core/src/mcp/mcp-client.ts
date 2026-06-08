import { spawn, type ChildProcess } from "child_process";
import { createInterface, type Interface } from "readline";
import * as os from "os";
import * as path from "path";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

type ListToolsResult = {
  tools: McpToolDefinition[];
  nextCursor?: string;
};

type CallToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

export class McpClient {
  private process: ChildProcess | null = null;
  private reader: Interface | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  private stderrBuffer = "";

  constructor(
    private readonly serverName: string,
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly env?: Record<string, string>,
  ) {}

  async connect(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const childEnv = {
        ...process.env,
        ...this.env,
      };
      const args = this.withNpxYesArg(this.command, this.args);

      const isWindows = os.platform() === "win32";

      if (isWindows) {
        // On Windows, .cmd files require shell: true to be spawned.
        // Build a single command string so cmd.exe handles quoting correctly.
        const cmd = [this.command + ".cmd", ...args].join(" ");
        this.process = spawn(cmd, [], {
          stdio: ["pipe", "pipe", "pipe"],
          env: childEnv,
          shell: true,
          windowsHide: true,
        });
      } else {
        this.process = spawn(this.command, args, {
          stdio: ["pipe", "pipe", "pipe"],
          env: childEnv,
        });
      }

      this.process.on("error", (err) => {
        reject(this.withStderr(`Failed to start MCP server "${this.serverName}" (${this.command}): ${err.message}`));
      });

      this.process.on("close", (code) => {
        const error = this.withStderr(`MCP server "${this.serverName}" exited with code ${code}`);
        for (const [, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pendingRequests.clear();
      });

      if (this.process.stderr) {
        this.process.stderr.on("data", (data: Buffer) => {
          this.appendStderr(data.toString("utf8"));
        });
      }

      this.reader = createInterface({ input: this.process.stdout! });
      this.reader.on("line", (line: string) => {
        this.handleLine(line);
      });

      // Send initialize request (MCP protocol handshake)
      this.sendRequest(
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "hex4code-cli", version: "0.1.0" },
        },
        timeoutMs,
      )
        .then(() => {
          // Send initialized notification
          this.sendNotification("notifications/initialized");
          resolve();
        })
        .catch(reject);
    });
  }

  async listTools(timeoutMs: number): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 100; page++) {
      const params = cursor ? { cursor } : {};
      const result = (await this.sendRequest("tools/list", params, timeoutMs)) as ListToolsResult;
      tools.push(...(result.tools ?? []));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) {
        return tools;
      }
    }

    throw this.withStderr(`MCP server "${this.serverName}" returned too many tools/list pages`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await this.sendRequest("tools/call", { name, arguments: args })) as CallToolResult;
  }

  disconnect(): void {
    if (this.reader) {
      this.reader.close();
      this.reader = null;
    }
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  private sendRequest(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(
          this.withStderr(
            `Timed out after ${timeoutMs}ms waiting for MCP server "${this.serverName}" to respond to ${method}`,
          ),
        );
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.writeLine(JSON.stringify(request));
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification = {
      jsonrpc: "2.0" as const,
      method,
      params,
    };
    this.writeLine(JSON.stringify(notification));
  }

  private writeLine(data: string): void {
    if (this.process?.stdin) {
      this.process.stdin.write(data + "\n");
    }
  }

  private handleLine(line: string): void {
    try {
      const message = JSON.parse(line) as JsonRpcResponse;
      if (message.id !== undefined && this.pendingRequests.has(message.id)) {
        const pending = this.pendingRequests.get(message.id)!;
        this.pendingRequests.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(this.withStderr(`MCP error: ${message.error.message}`));
        } else {
          pending.resolve(message.result);
        }
      }
    } catch {
      // Ignore unparseable lines
    }
  }

  private withNpxYesArg(command: string, args: string[]): string[] {
    const executable = path
      .basename(command)
      .toLowerCase()
      .replace(/\.cmd$/, "");
    if (executable !== "npx") {
      return args;
    }
    if (args.includes("-y") || args.includes("--yes")) {
      return args;
    }
    return ["-y", ...args];
  }

  private appendStderr(text: string): void {
    this.stderrBuffer = `${this.stderrBuffer}${text}`;
    if (this.stderrBuffer.length > 4000) {
      this.stderrBuffer = this.stderrBuffer.slice(-4000);
    }
  }

  private withStderr(message: string): Error {
    const stderr = this.stderrBuffer.trim();
    return new Error(stderr ? `${message}. stderr: ${stderr}` : message);
  }
}
