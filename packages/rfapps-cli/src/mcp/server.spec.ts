import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";
import { schemaObject, schemaString, type McpAnyToolDefinition } from "@rfmedia/common";
import packageMetadata from "../../package.json" with { type: "json" };

import { RfappsMcpServer } from "./server.js";
import { RFAPPS_MCP_TOOL_NAMES, rfappsMcpSchemas } from "./schema.js";
import { rfappsMcpTools } from "./tools.js";
import { rfappsMutationTools } from "./tools-mutate.js";
import { rfappsReadTools } from "./tools-read.js";

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

function makeReconcileResult() {
  return {
    schemaVersion: "reconcile.v1" as const,
    operation: "reconcile" as const,
    mode: "auto-apply" as const,
    dryRun: false,
    status: "converged" as const,
    scope: {
      composePath: "/srv/apps/compose.yml",
      project: "rfmedia-apps",
      profiles: ["media"],
      services: ["plex"],
    },
    actionFingerprint: "sha256:reviewed-actions",
    automation: { status: "allowed" as const },
    services: [
      {
        service: "plex",
        comparison: "drifted" as const,
        drift: {
          hasDrift: true,
          direction: "compose_ahead" as const,
          categories: ["runtime-status" as const],
          image: { changed: false },
          environment: [],
          ports: { changed: false },
          volumes: { changed: false },
          networks: { changed: false },
          runtimeStatus: {
            changed: true,
            currentState: "exited" as const,
            currentHealth: "none" as const,
            desiredState: "running" as const,
            desiredHealth: "healthy" as const,
          },
        },
        action: {
          kind: "start" as const,
          categories: ["runtime-status" as const],
          eligibility: "allowed" as const,
          reasons: [{ code: "RECONCILE_CONTAINER_STOPPED", category: "runtime-status" as const }],
        },
        outcome: "converged" as const,
        finalDrift: {
          hasDrift: false,
          direction: "compose_ahead" as const,
          categories: [],
          image: { changed: false },
          environment: [],
          ports: { changed: false },
          volumes: { changed: false },
          networks: { changed: false },
          runtimeStatus: {
            changed: false,
            currentState: "running" as const,
            currentHealth: "healthy" as const,
            desiredState: "running" as const,
            desiredHealth: "healthy" as const,
          },
        },
      },
    ],
    summary: {
      selected: 1,
      inSync: 0,
      drifted: 1,
      actionable: 1,
      blocked: 0,
      converged: 1,
      failed: 0,
    },
    success: true,
    exitCode: 0 as const,
  };
}

describe("rfapps MCP server", () => {
  it("registers the expected rfapps tool catalog", () => {
    const names = rfappsMcpTools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        RFAPPS_MCP_TOOL_NAMES.status,
        RFAPPS_MCP_TOOL_NAMES.health,
        RFAPPS_MCP_TOOL_NAMES.pull,
        RFAPPS_MCP_TOOL_NAMES.deploy,
        RFAPPS_MCP_TOOL_NAMES.rebuild,
        RFAPPS_MCP_TOOL_NAMES.stop,
        RFAPPS_MCP_TOOL_NAMES.delete,
        RFAPPS_MCP_TOOL_NAMES.prune,
        RFAPPS_MCP_TOOL_NAMES.plan,
        RFAPPS_MCP_TOOL_NAMES.apply,
        RFAPPS_MCP_TOOL_NAMES.history,
        RFAPPS_MCP_TOOL_NAMES.rollback,
        RFAPPS_MCP_TOOL_NAMES.driftDetect,
        RFAPPS_MCP_TOOL_NAMES.driftShow,
        RFAPPS_MCP_TOOL_NAMES.driftReconcile,
        RFAPPS_MCP_TOOL_NAMES.driftImport,
      ].sort(),
    );
  });

  it("exposes one retained reconciliation mutation with exact registry schemas", () => {
    const publicReconcileTools = rfappsMcpTools.filter((tool) =>
      tool.name.toLowerCase().includes("reconcile"),
    );
    const mutationReconcileTools = rfappsMutationTools.filter((tool) =>
      tool.name.toLowerCase().includes("reconcile"),
    );

    expect(publicReconcileTools).toHaveLength(1);
    expect(mutationReconcileTools).toEqual(publicReconcileTools);
    expect(rfappsReadTools).not.toContain(publicReconcileTools[0]);
    expect(publicReconcileTools[0]).toMatchObject({
      name: RFAPPS_MCP_TOOL_NAMES.driftReconcile,
      inputSchema: rfappsMcpSchemas.driftReconcile.input,
      outputSchema: rfappsMcpSchemas.driftReconcile.output,
    });
  });

  it("lists exact reconciliation schemas and propagates the full result over JSON-RPC", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logger = new PassThrough();
    const expected = makeReconcileResult();
    const canonicalResult = rfappsMcpSchemas.driftReconcile.output.parse(expected);
    const productionTool = rfappsMutationTools.find(
      (tool) => tool.name === RFAPPS_MCP_TOOL_NAMES.driftReconcile,
    );
    expect(productionTool).toBeDefined();

    const reconcileTool: McpAnyToolDefinition = {
      ...productionTool!,
      handler: async () => expected,
    };
    const server = new RfappsMcpServer({ input, output, logger, tools: [reconcileTool] });
    server.start();
    const readLine = createLineReader(output);

    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    const listResponse = await readJsonResponse(readLine);
    expect(listResponse.result).toEqual({
      tools: [
        {
          name: RFAPPS_MCP_TOOL_NAMES.driftReconcile,
          description: productionTool!.description,
          inputSchema: rfappsMcpSchemas.driftReconcile.input.jsonSchema,
          outputSchema: rfappsMcpSchemas.driftReconcile.output.jsonSchema,
        },
      ],
    });

    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: RFAPPS_MCP_TOOL_NAMES.driftReconcile,
          arguments: { service: "plex", autoApply: true, yes: true },
        },
      }) + "\n",
    );
    const callResponse = await readJsonResponse(readLine);
    expect(callResponse.result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, result: canonicalResult }),
        },
      ],
      structuredContent: { ok: true, result: canonicalResult },
      isError: false,
    });
    expect(callResponse.result).toMatchObject({
      structuredContent: {
        ok: true,
        result: {
          schemaVersion: "reconcile.v1",
          actionFingerprint: "sha256:reviewed-actions",
          automation: { status: "allowed" },
          services: [
            {
              service: "plex",
              action: { kind: "start" },
              finalDrift: { hasDrift: false },
            },
          ],
        },
      },
    });
  });

  it("rejects reconciliation auto-apply without explicit yes at the JSON-RPC boundary", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logger = new PassThrough();
    const productionTool = rfappsMutationTools.find(
      (tool) => tool.name === RFAPPS_MCP_TOOL_NAMES.driftReconcile,
    );
    expect(productionTool).toBeDefined();

    const server = new RfappsMcpServer({ input, output, logger, tools: [productionTool!] });
    server.start();
    const readLine = createLineReader(output);

    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: RFAPPS_MCP_TOOL_NAMES.driftReconcile,
          arguments: { autoApply: true },
        },
      }) + "\n",
    );
    const response = await readJsonResponse(readLine);

    expect(response.result).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          code: "MCP_VALIDATION_ERROR",
        },
      },
    });
  });

  it("handles initialize, tools/list, and tools/call requests", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logger = new PassThrough();

    const echoTool: McpAnyToolDefinition = {
      name: "rfapps.echo",
      description: "Echo text for test verification",
      inputSchema: schemaObject({ text: schemaString() }),
      outputSchema: schemaObject({ echoed: schemaString() }),
      handler: async (args) => ({ echoed: (args as { text: string }).text }),
    };

    const server = new RfappsMcpServer({
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
        name: "rfapps-mcp-server",
        version: packageMetadata.version,
      },
    });

    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    const toolsResponse = await readJsonResponse(readLine);
    expect(toolsResponse.id).toBe(2);
    expect(toolsResponse.result).toMatchObject({
      tools: [
        {
          name: "rfapps.echo",
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
          name: "rfapps.echo",
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
      name: "rfapps.fail",
      description: "Always fails",
      inputSchema: schemaObject({ text: schemaString() }),
      outputSchema: schemaObject({ echoed: schemaString() }),
      handler: async () => {
        throw new Error("boom");
      },
    };

    const server = new RfappsMcpServer({
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
          name: "rfapps.fail",
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

    const server = new RfappsMcpServer({
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

    const server = new RfappsMcpServer({
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
        name: "rfapps-mcp-server",
        version: packageMetadata.version,
      },
    });
  });

  it("treats requests without id as notifications and does not respond", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const logger = new PassThrough();

    const server = new RfappsMcpServer({
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
