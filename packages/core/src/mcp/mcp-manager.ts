import { McpClient, type McpToolDefinition } from "./mcp-client";
import type { McpServerConfig } from "../settings";

const MCP_STARTUP_TIMEOUT_MS = 30_000;

type McpToolEntry = {
  serverName: string;
  originalName: string;
  namespacedName: string;
  definition: McpToolDefinition;
  client: McpClient;
};

export type McpServerStatus = {
  name: string;
  status: "starting" | "ready" | "failed";
  connected: boolean;
  error?: string;
  toolCount: number;
  tools: string[];
};

export class McpManager {
  private clients: McpClient[] = [];
  private tools: McpToolEntry[] = [];
  private initialized = false;
  private disposed = false;
  private configuredServerNames: string[] = [];
  private serverStatuses: McpServerStatus[] = [];

  prepare(servers?: Record<string, McpServerConfig>): void {
    if (!servers || Object.keys(servers).length === 0) return;
    // Clear the disposed flag — a re-prepare means we are live again.
    // (disconnect() sets disposed=true to stop a stale initialize() loop,
    // but prepare+initialize must be able to start a new one.)
    this.disposed = false;

    for (const name of Object.keys(servers)) {
      if (!this.configuredServerNames.includes(name)) {
        this.configuredServerNames.push(name);
      }
      if (this.serverStatuses.some((status) => status.name === name)) {
        continue;
      }
      this.setStatus({
        name,
        status: "starting",
        connected: false,
        toolCount: 0,
        tools: [],
      });
    }
  }

  async initialize(servers?: Record<string, McpServerConfig>): Promise<void> {
    if (this.initialized || this.disposed) return;
    this.initialized = true;

    if (!servers || Object.keys(servers).length === 0) return;

    const entries = Object.entries(servers);
    this.prepare(servers);

    for (const [name, config] of entries) {
      if (this.disposed) break;
      let client: McpClient | null = null;
      try {
        client = new McpClient(name, config.command, config.args ?? [], config.env);
        await client.connect(MCP_STARTUP_TIMEOUT_MS);
        if (this.disposed) {
          client.disconnect();
          break;
        }
        this.clients.push(client);

        const serverTools = await client.listTools(MCP_STARTUP_TIMEOUT_MS);
        if (this.disposed) break;
        const toolNamespacedNames: string[] = [];
        for (const tool of serverTools) {
          const namespacedName = `mcp__${name}__${tool.name}`;
          this.tools.push({
            serverName: name,
            originalName: tool.name,
            namespacedName,
            definition: tool,
            client,
          });
          toolNamespacedNames.push(namespacedName);
        }
        this.setStatus({
          name,
          status: "ready",
          connected: true,
          toolCount: serverTools.length,
          tools: toolNamespacedNames,
        });
      } catch (err) {
        if (this.disposed) break;
        client?.disconnect();
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[hex4code] MCP server "${name}" failed to initialize: ${message}\n`);
        this.setStatus({
          name,
          status: "failed",
          connected: false,
          error: message,
          toolCount: 0,
          tools: [],
        });
      }
    }
  }

  getStatus(): McpServerStatus[] {
    const result = [...this.serverStatuses];
    const knownNames = new Set(result.map((s) => s.name));
    for (const name of this.configuredServerNames) {
      if (!knownNames.has(name)) {
        result.push({
          name,
          status: "starting",
          connected: false,
          toolCount: 0,
          tools: [],
        });
      }
    }
    return result;
  }

  getMcpToolDefinitions(): Array<{
    type: "function";
    function: {
      name: string;
      description: string;
      parameters: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
      };
    };
  }> {
    return this.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.namespacedName,
        description: t.definition.description ?? `${t.serverName}: ${t.originalName}`,
        parameters: {
          type: "object" as const,
          properties: t.definition.inputSchema.properties,
          required: t.definition.inputSchema.required,
          additionalProperties: false,
        },
      },
    }));
  }

  isMcpTool(name: string): boolean {
    return name.startsWith("mcp__");
  }

  async executeMcpTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; name: string; output?: string; error?: string }> {
    const tool = this.tools.find((t) => t.namespacedName === name);
    if (!tool) {
      return { ok: false, name, error: `Unknown MCP tool: ${name}` };
    }

    try {
      const result = await tool.client.callTool(tool.originalName, args);
      const text = result.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n");
      return {
        ok: !result.isError,
        name,
        output: text || JSON.stringify(result.content),
      };
    } catch (err) {
      return {
        ok: false,
        name,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  disconnect(): void {
    this.disposed = true;
    for (const client of this.clients) {
      client.disconnect();
    }
    this.clients = [];
    this.tools = [];
    this.serverStatuses = [];
    this.configuredServerNames = [];
    this.initialized = false;
  }

  private setStatus(status: McpServerStatus): void {
    if (this.disposed) return;
    const index = this.serverStatuses.findIndex((s) => s.name === status.name);
    if (index === -1) {
      this.serverStatuses.push(status);
      return;
    }
    this.serverStatuses[index] = status;
  }
}
