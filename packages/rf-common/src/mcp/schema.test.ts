import { describe, expect, it } from "vitest";

import {
  McpSchemaValidationError,
  mcpSchema,
  schemaArray,
  schemaEnum,
  schemaNumber,
  schemaObject,
  schemaOptional,
  schemaString,
  schemaUnion,
  validateSchema,
} from "./schema.js";

describe("mcp schema utilities", () => {
  it("parses strict object inputs with optional fields", () => {
    const schema = schemaObject({
      service: schemaString(),
      profile: schemaOptional(schemaString()),
      force: mcpSchema.boolean(),
    });

    const parsed = schema.parse({
      service: "traefik",
      force: true,
    });

    expect(parsed).toEqual({
      service: "traefik",
      profile: undefined,
      force: true,
    });
  });

  it("rejects unexpected object keys deterministically", () => {
    const schema = schemaObject({
      service: schemaString(),
    });

    expect(() =>
      schema.parse({
        service: "plex",
        extra: true,
      }),
    ).toThrowError(McpSchemaValidationError);

    try {
      schema.parse({ service: "plex", extra: true });
    } catch (error) {
      expect(error).toBeInstanceOf(McpSchemaValidationError);
      const validationError = error as McpSchemaValidationError;
      expect(validationError.issues[0]).toMatchObject({
        path: "$",
        expected: "no additional properties",
      });
      expect(validationError.issues[0]?.message).toContain("extra");
    }
  });

  it("returns validation failure envelopes without throwing", () => {
    const schema = schemaObject({
      limit: schemaNumber({ integer: true, minimum: 1 }),
    });

    const result = validateSchema(schema, { limit: 0 });

    expect(result.success).toBe(false);
    if (result.success === false) {
      expect(result.error.issues[0]).toMatchObject({
        path: "$.limit",
        expected: "number(min=1)",
      });
    }
  });

  it("supports unions and enums", () => {
    const schema = schemaUnion([
      schemaEnum(["deploy", "rebuild"] as const),
      schemaArray(schemaString()),
    ]);

    expect(schema.parse("deploy")).toBe("deploy");
    expect(schema.parse(["a", "b"])).toEqual(["a", "b"]);
  });

  it("produces deterministic path details for nested array validation", () => {
    const schema = schemaObject({
      services: schemaArray(schemaString()),
    });

    expect(() => schema.parse({ services: ["ok", 1] })).toThrowError(McpSchemaValidationError);

    try {
      schema.parse({ services: ["ok", 1] });
    } catch (error) {
      expect(error).toBeInstanceOf(McpSchemaValidationError);
      const validationError = error as McpSchemaValidationError;
      expect(validationError.issues[0]).toMatchObject({
        path: "$.services[1]",
        expected: "string",
      });
    }
  });
});
