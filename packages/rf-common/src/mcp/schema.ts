/**
 * Shared schema builder and runtime validation utilities for MCP tool IO.
 */

/**
 * Validation issue with deterministic location and expectation details.
 */
export interface McpSchemaValidationIssue {
  path: string;
  expected: string;
  received: string;
  message: string;
}

/**
 * Error thrown when schema validation fails.
 */
export class McpSchemaValidationError extends Error {
  readonly issues: McpSchemaValidationIssue[];

  constructor(message: string, issues: McpSchemaValidationIssue[]) {
    super(message);
    this.name = "McpSchemaValidationError";
    this.issues = issues;
  }
}

/**
 * JSON-schema-like representation exposed to transports.
 */
export interface McpJsonSchema {
  type?: string;
  description?: string;
  enum?: ReadonlyArray<string | number | boolean | null>;
  items?: McpJsonSchema;
  oneOf?: ReadonlyArray<McpJsonSchema>;
  properties?: Record<string, McpJsonSchema>;
  required?: string[];
  additionalProperties?: boolean | McpJsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

/**
 * Runtime schema contract for parsing and transport metadata.
 */
export interface McpSchema<TValue> {
  readonly kind: string;
  readonly jsonSchema: McpJsonSchema;
  readonly optional?: true;
  parse(value: unknown): TValue;
  parseAtPath?(value: unknown, path: string): TValue;
}

type SchemaShape = Record<string, McpSchema<unknown>>;

type InferSchemaValue<TSchema extends McpSchema<unknown>> =
  TSchema extends McpSchema<infer TValue> ? TValue : never;

type InferSchemaUnion<TSchemas extends readonly McpSchema<unknown>[]> =
  TSchemas[number] extends McpSchema<infer TValue> ? TValue : never;

/**
 * Build an opaque schema wrapper.
 */
function createSchema<TValue>(
  kind: string,
  jsonSchema: McpJsonSchema,
  parser: (value: unknown, path: string) => TValue,
): McpSchema<TValue> {
  return {
    kind,
    jsonSchema,
    parse(value: unknown): TValue {
      return parser(value, "$");
    },
    parseAtPath(value: unknown, path: string): TValue {
      return parser(value, path);
    },
  };
}

function toReceivedType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function fail(path: string, expected: string, value: unknown, message: string): never {
  throw new McpSchemaValidationError(message, [
    {
      path,
      expected,
      received: toReceivedType(value),
      message,
    },
  ]);
}

function remapIssuePath(issue: McpSchemaValidationIssue, path: string): McpSchemaValidationIssue {
  if (issue.path === "$") {
    return {
      ...issue,
      path,
      message: issue.message.replace("$", path),
    };
  }

  if (issue.path.startsWith("$.")) {
    return {
      ...issue,
      path: `${path}${issue.path.slice(1)}`,
      message: issue.message.replace(issue.path, `${path}${issue.path.slice(1)}`),
    };
  }

  return issue;
}

function parseSchemaAtPath<TValue>(
  schema: McpSchema<TValue>,
  value: unknown,
  path: string,
): TValue {
  if (typeof schema.parseAtPath === "function") {
    return schema.parseAtPath(value, path);
  }

  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof McpSchemaValidationError) {
      const issues = error.issues.map((issue) => remapIssuePath(issue, path));
      throw new McpSchemaValidationError(error.message.replace("$", path), issues);
    }
    throw error;
  }
}

/**
 * String schema.
 */
export function schemaString(options?: {
  description?: string;
  minLength?: number;
  maxLength?: number;
}): McpSchema<string> {
  return createSchema(
    "string",
    {
      type: "string",
      description: options?.description,
      ...(options?.minLength !== undefined ? { minLength: options.minLength } : {}),
      ...(options?.maxLength !== undefined ? { maxLength: options.maxLength } : {}),
    },
    (value, path) => {
      if (typeof value !== "string") {
        fail(path, "string", value, `Expected string at ${path}`);
      }
      if (options?.minLength !== undefined && value.length < options.minLength) {
        fail(path, `string(minLength=${options.minLength})`, value, `String too short at ${path}`);
      }
      if (options?.maxLength !== undefined && value.length > options.maxLength) {
        fail(path, `string(maxLength=${options.maxLength})`, value, `String too long at ${path}`);
      }
      return value;
    },
  );
}

/**
 * Number schema.
 */
export function schemaNumber(options?: {
  description?: string;
  integer?: boolean;
  minimum?: number;
  maximum?: number;
}): McpSchema<number> {
  return createSchema(
    options?.integer === true ? "integer" : "number",
    {
      type: options?.integer === true ? "integer" : "number",
      description: options?.description,
      ...(options?.minimum !== undefined ? { minimum: options.minimum } : {}),
      ...(options?.maximum !== undefined ? { maximum: options.maximum } : {}),
    },
    (value, path) => {
      if (typeof value !== "number" || Number.isNaN(value)) {
        fail(
          path,
          options?.integer === true ? "integer" : "number",
          value,
          `Expected number at ${path}`,
        );
      }
      if (options?.integer === true && !Number.isInteger(value)) {
        fail(path, "integer", value, `Expected integer at ${path}`);
      }
      if (options?.minimum !== undefined && value < options.minimum) {
        fail(path, `number(min=${options.minimum})`, value, `Number below minimum at ${path}`);
      }
      if (options?.maximum !== undefined && value > options.maximum) {
        fail(path, `number(max=${options.maximum})`, value, `Number above maximum at ${path}`);
      }
      return value;
    },
  );
}

/**
 * Boolean schema.
 */
export function schemaBoolean(options?: { description?: string }): McpSchema<boolean> {
  return createSchema(
    "boolean",
    {
      type: "boolean",
      description: options?.description,
    },
    (value, path) => {
      if (typeof value !== "boolean") {
        fail(path, "boolean", value, `Expected boolean at ${path}`);
      }
      return value;
    },
  );
}

/**
 * Null schema.
 */
export function schemaNull(options?: { description?: string }): McpSchema<null> {
  return createSchema(
    "null",
    {
      type: "null",
      description: options?.description,
    },
    (value, path) => {
      if (value !== null) {
        fail(path, "null", value, `Expected null at ${path}`);
      }
      return null;
    },
  );
}

/**
 * Literal enum schema.
 */
export function schemaEnum<TValues extends readonly (string | number | boolean | null)[]>(
  values: TValues,
  options?: { description?: string },
): McpSchema<TValues[number]> {
  const allowed = [...values];
  return createSchema(
    "enum",
    {
      enum: allowed,
      description: options?.description,
    },
    (value, path) => {
      for (const candidate of allowed) {
        if (candidate === value) {
          return candidate;
        }
      }
      fail(
        path,
        `enum(${allowed.map((entry) => JSON.stringify(entry)).join(",")})`,
        value,
        `Expected one of allowed enum values at ${path}`,
      );
    },
  );
}

/**
 * Array schema.
 */
export function schemaArray<TValue>(
  itemSchema: McpSchema<TValue>,
  options?: { description?: string; minItems?: number; maxItems?: number },
): McpSchema<TValue[]> {
  return createSchema(
    "array",
    {
      type: "array",
      description: options?.description,
      items: itemSchema.jsonSchema,
      ...(options?.minItems !== undefined ? { minItems: options.minItems } : {}),
      ...(options?.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
    },
    (value, path) => {
      if (!Array.isArray(value)) {
        fail(path, "array", value, `Expected array at ${path}`);
      }
      if (options?.minItems !== undefined && value.length < options.minItems) {
        fail(
          path,
          `array(minItems=${options.minItems})`,
          value,
          `Array has too few items at ${path}`,
        );
      }
      if (options?.maxItems !== undefined && value.length > options.maxItems) {
        fail(
          path,
          `array(maxItems=${options.maxItems})`,
          value,
          `Array has too many items at ${path}`,
        );
      }
      return value.map((entry, index) => parseSchemaAtPath(itemSchema, entry, `${path}[${index}]`));
    },
  );
}

/**
 * Unknown passthrough schema for opaque payloads.
 */
export function schemaUnknown(options?: { description?: string }): McpSchema<unknown> {
  return createSchema(
    "unknown",
    {
      description: options?.description,
    },
    (value) => value,
  );
}

/**
 * Record schema for string-keyed maps.
 */
export function schemaRecord<TValue>(
  valueSchema: McpSchema<TValue>,
  options?: { description?: string },
): McpSchema<Record<string, TValue>> {
  return createSchema(
    "record",
    {
      type: "object",
      description: options?.description,
      additionalProperties: valueSchema.jsonSchema,
    },
    (value, path) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(path, "object", value, `Expected object at ${path}`);
      }
      const result: Record<string, TValue> = {};
      for (const [key, entry] of Object.entries(value)) {
        result[key] = parseSchemaAtPath(valueSchema, entry, `${path}.${key}`);
      }
      return result;
    },
  );
}

type ObjectFromShape<TShape extends SchemaShape> = {
  [TKey in keyof TShape]: TShape[TKey] extends { optional: true }
    ? InferSchemaValue<TShape[TKey]> | undefined
    : InferSchemaValue<TShape[TKey]>;
};

/**
 * Object schema with strict keys by default.
 */
export function schemaObject<TShape extends SchemaShape>(
  shape: TShape,
  options?: { description?: string; allowUnknownProperties?: boolean },
): McpSchema<ObjectFromShape<TShape>> {
  const required = Object.keys(shape)
    .filter((key) => shape[key]?.optional !== true)
    .sort();

  const propertySchemas: Record<string, McpJsonSchema> = {};
  for (const [key, schema] of Object.entries(shape)) {
    propertySchemas[key] = schema.jsonSchema;
  }

  return createSchema(
    "object",
    {
      type: "object",
      description: options?.description,
      properties: propertySchemas,
      required,
      additionalProperties: options?.allowUnknownProperties === true,
    },
    (value, path) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(path, "object", value, `Expected object at ${path}`);
      }

      const input = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};

      const sortedShapeEntries = Object.entries(shape).sort(([left], [right]) =>
        left.localeCompare(right),
      );

      for (const [key, schema] of sortedShapeEntries) {
        if (!(key in input)) {
          if (schema.optional === true) {
            result[key] = undefined;
            continue;
          }
          fail(`${path}.${key}`, "defined", undefined, `Missing required field ${path}.${key}`);
        }

        result[key] = parseSchemaAtPath(schema, input[key], `${path}.${key}`);
      }

      if (options?.allowUnknownProperties !== true) {
        const allowed = new Set(Object.keys(shape));
        const unexpected = Object.keys(input)
          .filter((key) => !allowed.has(key))
          .sort();

        if (unexpected.length > 0) {
          fail(
            path,
            "no additional properties",
            input,
            `Unexpected properties at ${path}: ${unexpected.join(", ")}`,
          );
        }
      } else {
        for (const [key, entry] of Object.entries(input)) {
          if (!(key in result)) {
            result[key] = entry;
          }
        }
      }

      return result as ObjectFromShape<TShape>;
    },
  );
}

/**
 * Optional schema wrapper for object fields.
 */
export function schemaOptional<TValue>(schema: McpSchema<TValue>): McpSchema<TValue | undefined> {
  const optionalSchema = createSchema<TValue | undefined>(
    "optional",
    schema.jsonSchema,
    (value, path) => {
      if (value === undefined) {
        return undefined;
      }
      return parseSchemaAtPath(schema, value, path);
    },
  );

  return {
    ...optionalSchema,
    optional: true,
  };
}

/**
 * Union schema that validates against the first matching branch.
 */
export function schemaUnion<TSchemas extends readonly McpSchema<unknown>[]>(
  schemas: TSchemas,
  options?: { description?: string },
): McpSchema<InferSchemaUnion<TSchemas>> {
  return createSchema(
    "union",
    {
      oneOf: schemas.map((schema) => schema.jsonSchema),
      description: options?.description,
    },
    (value, path) => {
      const failures: McpSchemaValidationIssue[] = [];

      for (const schema of schemas) {
        try {
          return parseSchemaAtPath(schema, value, path) as InferSchemaUnion<TSchemas>;
        } catch (error) {
          if (error instanceof McpSchemaValidationError) {
            failures.push(...error.issues);
            continue;
          }
          throw error;
        }
      }

      throw new McpSchemaValidationError(`No union variant matched at ${path}`, failures);
    },
  );
}

/**
 * Validate a value against a schema.
 */
export function validateSchema<TValue>(
  schema: McpSchema<TValue>,
  value: unknown,
): { success: true; value: TValue } | { success: false; error: McpSchemaValidationError } {
  try {
    return {
      success: true,
      value: schema.parse(value),
    };
  } catch (error) {
    if (error instanceof McpSchemaValidationError) {
      return { success: false, error };
    }
    throw error;
  }
}

/**
 * Namespace-style convenience export.
 */
export const mcpSchema = {
  string: schemaString,
  number: schemaNumber,
  boolean: schemaBoolean,
  null: schemaNull,
  enum: schemaEnum,
  array: schemaArray,
  unknown: schemaUnknown,
  record: schemaRecord,
  object: schemaObject,
  optional: schemaOptional,
  union: schemaUnion,
};
