import { describe, expect, it } from "vitest";

import { SecretsInjectionError } from "../secrets.js";
import { McpSchemaValidationError } from "./schema.js";
import { normalizeMcpError, toMcpFailure } from "./errors.js";

describe("mcp error normalization", () => {
  it("maps schema validation errors to deterministic validation envelopes", () => {
    const envelope = normalizeMcpError(
      new McpSchemaValidationError("invalid", [
        {
          path: "$.service",
          expected: "string",
          received: "number",
          message: "Expected string at $.service",
        },
      ]),
    );

    expect(envelope).toMatchObject({
      code: "MCP_VALIDATION_ERROR",
      message: "Expected string at $.service",
    });
    expect(envelope.details).toBeDefined();
  });

  it("reuses shared error formatter semantics", () => {
    const error = new SecretsInjectionError("PLEX_TOKEN", "/tmp/.env");
    const envelope = normalizeMcpError(error);

    expect(envelope.code).toBe("SECRETS_INJECTION_ERROR");
    expect(envelope.message).toContain("Missing required environment variable");
    expect(envelope.suggestions.length).toBeGreaterThan(0);
  });

  it("wraps non-error throwables", () => {
    const failure = toMcpFailure("boom");
    expect(failure.ok).toBe(false);
    expect(failure.error).toMatchObject({
      code: "ERROR",
      message: "boom",
    });
  });
});
