/**
 * Shared MCP transport-agnostic types and contracts.
 */

import type { McpJsonSchema, McpSchema } from "./schema.js";

/**
 * JSON-compatible primitive values.
 */
export type JsonPrimitive = string | number | boolean | null;

/**
 * JSON-compatible values.
 */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/**
 * JSON-compatible object.
 */
export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * JSON-compatible array.
 */
export type JsonArray = JsonValue[];

/**
 * Structured error payload returned to MCP callers.
 */
export interface McpErrorEnvelope {
  code: string;
  message: string;
  suggestions: string[];
  details?: JsonObject;
}

/**
 * Successful MCP tool execution payload.
 */
export interface McpSuccessEnvelope<TResult> {
  ok: true;
  result: TResult;
}

/**
 * Failed MCP tool execution payload.
 */
export interface McpFailureEnvelope {
  ok: false;
  error: McpErrorEnvelope;
}

/**
 * Tool execution response envelope.
 */
export type McpToolEnvelope<TResult> = McpSuccessEnvelope<TResult> | McpFailureEnvelope;

/**
 * Runtime context passed to tool handlers.
 */
export interface McpToolContext {
  requestId?: string;
  signal?: AbortSignal;
}

/**
 * Generic MCP tool definition.
 */
export interface McpToolDefinition<TArgs, TResult> {
  name: string;
  description: string;
  inputSchema: McpSchema<TArgs>;
  outputSchema: McpSchema<TResult>;
  handler: (args: TArgs, context: McpToolContext) => Promise<TResult> | TResult;
}

/**
 * Untyped MCP tool definition.
 */
export type McpAnyToolDefinition = McpToolDefinition<unknown, unknown>;

/**
 * Lightweight metadata shape exposed to transports.
 */
export interface McpToolMetadata {
  name: string;
  description: string;
  inputSchema: McpJsonSchema;
  outputSchema: McpJsonSchema;
}

/**
 * Tool invocation request.
 */
export interface McpToolCall {
  name: string;
  arguments?: unknown;
  context?: McpToolContext;
}
