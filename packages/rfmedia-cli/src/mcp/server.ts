import {
  stdin as processStdin,
  stdout as processStdout,
  stderr as processStderr,
} from "node:process";
import packageMetadata from "../../package.json" with { type: "json" };

import {
  createMcpSuccess,
  createMcpToolRegistry,
  toMcpFailure,
  type McpAnyToolDefinition,
  type McpToolEnvelope,
} from "@rfmedia/common";

import { rfmediaMcpTools } from "./tools.js";

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

interface InitializeResult {
  protocolVersion: string;
  capabilities: {
    tools: Record<string, never>;
  };
  serverInfo: {
    name: string;
    version: string;
  };
}

interface ToolsCallParams {
  name: string;
  arguments?: unknown;
}

export interface StartRfmediaMcpServerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  logger?: NodeJS.WritableStream;
  tools?: readonly McpAnyToolDefinition[];
  version?: string;
}

const DEFAULT_SERVER_VERSION =
  typeof packageMetadata.version === "string" ? packageMetadata.version : "0.0.0";

function createInitializeResult(version: string): InitializeResult {
  return {
    protocolVersion: "2025-01-01",
    capabilities: {
      tools: {},
    },
    serverInfo: {
      name: "rfmedia-mcp-server",
      version,
    },
  };
}

function encodeResponse(response: JsonRpcResponse): string {
  return `${JSON.stringify(response)}\n`;
}

function createErrorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

export class RfmediaMcpServer {
  private readonly registry;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly logger: NodeJS.WritableStream;
  private readonly version: string;
  private buffer = "";
  private processing = false;

  constructor(options?: StartRfmediaMcpServerOptions) {
    this.input = options?.input ?? processStdin;
    this.output = options?.output ?? processStdout;
    this.logger = options?.logger ?? processStderr;
    this.version = options?.version ?? DEFAULT_SERVER_VERSION;
    this.registry = createMcpToolRegistry(options?.tools ?? rfmediaMcpTools);
  }

  start(): void {
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string) => {
      this.buffer += chunk;
      void this.processBuffer();
    });
    this.input.on("error", (error) => {
      this.logger.write(`rfmedia-mcp-server input error: ${String(error)}\n`);
    });
  }

  private async processBuffer(): Promise<void> {
    if (this.processing) {
      return;
    }

    this.processing = true;

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        this.processing = false;
        return;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      try {
        await this.handleLine(line);
      } catch (error) {
        this.logger.write(`rfmedia-mcp-server request handling error: ${String(error)}\n`);
      }
    }
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.output.write(encodeResponse(createErrorResponse(null, -32700, "Parse error")));
      return;
    }

    if (!this.isJsonRpcRequest(parsed)) {
      this.output.write(encodeResponse(createErrorResponse(null, -32600, "Invalid request")));
      return;
    }

    const request = parsed;
    const hasIdMember = this.hasIdMember(request);
    const responseId = this.coerceResponseId(request.id);

    if (hasIdMember && !this.isValidJsonRpcId(request.id)) {
      this.output.write(encodeResponse(createErrorResponse(null, -32600, "Invalid request")));
      return;
    }

    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      this.output.write(encodeResponse(createErrorResponse(responseId, -32600, "Invalid request")));
      return;
    }

    if (!hasIdMember) {
      await this.handleNotification(request);
      return;
    }

    const response = await this.handleRequest(request, responseId);
    this.output.write(encodeResponse(response));
  }

  private isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private hasIdMember(request: JsonRpcRequest): boolean {
    return Object.prototype.hasOwnProperty.call(request, "id");
  }

  private isValidJsonRpcId(id: unknown): id is JsonRpcId {
    return id === null || typeof id === "string" || typeof id === "number";
  }

  private coerceResponseId(id: unknown): JsonRpcId {
    return this.isValidJsonRpcId(id) ? id : null;
  }

  private async handleNotification(request: JsonRpcRequest): Promise<void> {
    if (request.method === "notifications/initialized") {
      return;
    }

    this.logger.write(`rfmedia-mcp-server ignored notification: ${request.method}\n`);
  }

  private async handleRequest(request: JsonRpcRequest, id: JsonRpcId): Promise<JsonRpcResponse> {
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: createInitializeResult(this.version),
        };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: this.registry.listToolMetadata().map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
            })),
          },
        };

      case "tools/call": {
        const params = request.params as ToolsCallParams | undefined;
        if (!params || typeof params.name !== "string") {
          return createErrorResponse(id, -32602, "Invalid params: tools/call requires a tool name");
        }

        try {
          const result = await this.registry.execute({
            name: params.name,
            arguments: params.arguments,
          });

          const envelope: McpToolEnvelope<unknown> = createMcpSuccess(result);

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(envelope),
                },
              ],
              structuredContent: envelope,
              isError: false,
            },
          };
        } catch (error) {
          const failure = toMcpFailure(error);

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: failure.error.message,
                },
              ],
              structuredContent: failure,
              isError: true,
            },
          };
        }
      }

      default:
        return createErrorResponse(id, -32601, `Method not found: ${request.method}`);
    }
  }
}

export function startRfmediaMcpServer(options?: StartRfmediaMcpServerOptions): RfmediaMcpServer {
  const server = new RfmediaMcpServer(options);
  server.start();
  return server;
}

export function runRfmediaMcpServer(): void {
  startRfmediaMcpServer();
}
