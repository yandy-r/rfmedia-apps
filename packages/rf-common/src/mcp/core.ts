/**
 * Shared MCP core runtime helpers.
 */

import type {
  McpAnyToolDefinition,
  McpFailureEnvelope,
  McpSuccessEnvelope,
  McpToolCall,
  McpToolEnvelope,
  McpToolMetadata,
} from "./types.js";

/**
 * Thrown when duplicate tool names are registered.
 */
export class McpDuplicateToolError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`Duplicate MCP tool registration: ${toolName}`);
    this.name = "McpDuplicateToolError";
    this.toolName = toolName;
  }
}

/**
 * Thrown when a tool call references a missing tool name.
 */
export class McpToolNotFoundError extends Error {
  readonly toolName: string;

  constructor(toolName: string) {
    super(`MCP tool not found: ${toolName}`);
    this.name = "McpToolNotFoundError";
    this.toolName = toolName;
  }
}

/**
 * Registry handle for MCP tool metadata and invocation.
 */
export interface McpToolRegistry {
  readonly tools: ReadonlyMap<string, McpAnyToolDefinition>;
  listToolMetadata(): McpToolMetadata[];
  execute(call: McpToolCall): Promise<unknown>;
}

/**
 * Build a deterministic MCP registry from tool definitions.
 */
export function createMcpToolRegistry(tools: readonly McpAnyToolDefinition[]): McpToolRegistry {
  const map = new Map<string, McpAnyToolDefinition>();

  for (const tool of tools) {
    if (map.has(tool.name)) {
      throw new McpDuplicateToolError(tool.name);
    }
    map.set(tool.name, tool);
  }

  return {
    tools: map,
    listToolMetadata(): McpToolMetadata[] {
      return Array.from(map.values())
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema.jsonSchema,
          outputSchema: tool.outputSchema.jsonSchema,
        }));
    },
    async execute(call: McpToolCall): Promise<unknown> {
      const tool = map.get(call.name);
      if (tool === undefined) {
        throw new McpToolNotFoundError(call.name);
      }

      const args = tool.inputSchema.parse(call.arguments ?? {});
      const rawResult = await tool.handler(args, call.context ?? {});
      return tool.outputSchema.parse(rawResult);
    },
  };
}

/**
 * Convenience constructor for successful envelopes.
 */
export function createMcpSuccess<TResult>(result: TResult): McpSuccessEnvelope<TResult> {
  return {
    ok: true,
    result,
  };
}

/**
 * Convenience constructor for failed envelopes.
 */
export function createMcpFailure(error: McpFailureEnvelope["error"]): McpFailureEnvelope {
  return {
    ok: false,
    error,
  };
}

/**
 * Helper to create typed envelopes from unknown execution output.
 */
export function toMcpEnvelope<TResult>(
  value: TResult | McpFailureEnvelope,
): McpToolEnvelope<TResult> {
  if (typeof value === "object" && value !== null && "ok" in value) {
    const maybeEnvelope = value as { ok?: unknown };
    if (maybeEnvelope.ok === false) {
      return value as McpFailureEnvelope;
    }
  }

  return createMcpSuccess(value as TResult);
}
