import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";
import { schemaObject, schemaString, type McpAnyToolDefinition } from "@rfmedia/common";
import packageMetadata from "../../package.json" with { type: "json" };

import { RfmediaMcpServer } from "./server.js";
import { RFMEDIA_MCP_TOOL_NAMES } from "./schema.js";
import { rfmediaMcpTools } from "./tools.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

function createLineReader(stream: PassThrough): () => Promise<string> {
  let buffer = "";
  const queue: string[] = [];
  const resolvers: Array<(line: string) => void> = [];

  stream.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      const resolver = resolvers.shift();
      if (resolver) {
        resolver(line);
      } else {
        queue.push(line);
      }
    }
  });

  return async () => {
    const queued = queue.shift();
    if (queued !== undefined) {
      return queued;
    }

    return new Promise<string>((resolve) => {
      resolvers.push(resolve);
    });
  };
}

async function readJsonResponse(readLine: () => Promise<string>): Promise<JsonRpcResponse> {
  const line = await readLine();
  return JSON.parse(line) as JsonRpcResponse;
}

async function readJsonResponseWithTimeout(
  readLine: () => Promise<string>,
  timeoutMs: number,
): Promise<JsonRpcResponse | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, timeoutMs);

    void readLine()
      .then((line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line) as JsonRpcResponse);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

describe("rfmedia MCP server", () => {
  it("registers the expected rfmedia tool catalog", () => {
    const names = rfmediaMcpTools.map((tool) => tool.name).sort();
    expect(names).toEqual(Object.values(RFMEDIA_MCP_TOOL_NAMES).sort());
  });

  it("handles initialize, tools/list, and tools/call requests", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logger = new PassThrough();

    const echoTool: McpAnyToolDefinition = {
      name: "rfmedia.echo",
      description: "Echo text for test verification",
      inputSchema: schemaObject({ text: schemaString() }),
      outputSchema: schemaObject({ echoed: schemaString() }),
      handler: async (args) => ({ echoed: (args as { text: string }).text }),
    };

    const server = new RfmediaMcpServer({
      input,
      output,
      logger,
      tools: [echoTool],
    });
    server.start();

    const readLine = createLineReader(output);

    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    const initializeResponse = await readJsonResponse(readLine);
    expect(initializeResponse.id).toBe(1);
    expect(initializeResponse.result).toMatchObject({
      serverInfo: {
        name: "rfmedia-mcp-server",
        version: packageMetadata.version,
      },
    });

    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    const toolsResponse = await readJsonResponse(readLine);
    expect(toolsResponse.id).toBe(2);
    expect(toolsResponse.result).toMatchObject({
      tools: [
        {
          name: "rfmedia.echo",
          outputSchema: {
            type: "object",
          },
        },
      ],
    });

    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "rfmedia.echo",
          arguments: { text: "hello" },
        },
      }) + "\n",
    );
    const callResponse = await readJsonResponse(readLine);
    expect(callResponse.id).toBe(3);
    expect(callResponse.result).toMatchObject({
      isError: false,
      structuredContent: {
        ok: true,
        result: {
          echoed: "hello",
        },
      },
    });
  });

  it("returns MCP error envelopes for tool execution failures", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logger = new PassThrough();

    const failingTool: McpAnyToolDefinition = {
      name: "rfmedia.fail",
      description: "Always fails",
      inputSchema: schemaObject({ text: schemaString() }),
      outputSchema: schemaObject({ echoed: schemaString() }),
      handler: async () => {
        throw new Error("boom");
      },
    };

    const server = new RfmediaMcpServer({
      input,
      output,
      logger,
      tools: [failingTool],
    });
    server.start();

    const readLine = createLineReader(output);

    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "rfmedia.fail",
          arguments: { text: "test" },
        },
      }) + "\n",
    );

    const response = await readJsonResponse(readLine);
    expect(response.id).toBe(1);
    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          code: "ERROR",
          message: "boom",
        },
      },
    });
  });

  it("returns invalid request with id=null for non-conforming id values", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logger = new PassThrough();

    const server = new RfmediaMcpServer({
      input,
      output,
      logger,
      tools: [],
    });
    server.start();

    const readLine = createLineReader(output);

    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: { invalid: true },
        method: "initialize",
      }) + "\n",
    );

    const response = await readJsonResponse(readLine);
    expect(response.id).toBeNull();
    expect(response.error).toMatchObject({
      code: -32600,
      message: "Invalid request",
    });
  });

  it("treats requests with id:null as requests (not notifications)", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logger = new PassThrough();

    const server = new RfmediaMcpServer({
      input,
      output,
      logger,
      tools: [],
    });
    server.start();

    const readLine = createLineReader(output);

    input.write(
      JSON.stringify({ jsonrpc: "2.0", id: null, method: "initialize", params: {} }) + "\n",
    );
    const response = await readJsonResponse(readLine);

    expect(response.id).toBeNull();
    expect(response.result).toMatchObject({
      serverInfo: {
        name: "rfmedia-mcp-server",
        version: packageMetadata.version,
      },
    });
  });

  it("treats requests without id as notifications and does not respond", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logger = new PassThrough();

    const server = new RfmediaMcpServer({
      input,
      output,
      logger,
      tools: [],
    });
    server.start();

    const readLine = createLineReader(output);

    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const response = await readJsonResponseWithTimeout(readLine, 50);
    expect(response).toBeNull();
  });
});
