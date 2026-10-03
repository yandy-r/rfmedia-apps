/**
 * Unit tests for generic serializers and formatter dispatch.
 *
 * Tests cover:
 * - JSON serializer: objects and arrays match JSON.stringify(data, null, 2)
 * - YAML serializer: objects and arrays produce expected YAML output
 * - CSV serializer: flat objects, arrays of objects, nested flattening,
 *   edge cases (commas, quotes, empty strings, nulls), and depth limit error
 * - formatMachineOutput dispatch: correct serializer selection per format,
 *   stdout output via console.log, no-op for text/table
 *
 * IMPORTANT: Uses vi.spyOn(console, "log") to capture stdout output
 * in dispatch tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import YAML from "yaml";
import { formatAsJson } from "./json.js";
import { formatAsYaml } from "./yaml.js";
import { formatAsCsv } from "./csv.js";
import { formatMachineOutput } from "./index.js";
import { setOutputFormat } from "../output.js";

describe("formatAsJson", () => {
  it("formats a flat object as pretty-printed JSON", () => {
    const data = { name: "test", count: 42 };
    const result = formatAsJson(data);

    expect(result).toBe(JSON.stringify(data, null, 2));
  });

  it("formats an array of objects as pretty-printed JSON", () => {
    const data = [
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ];
    const result = formatAsJson(data);

    expect(result).toBe(JSON.stringify(data, null, 2));
  });

  it("formats a nested object as pretty-printed JSON", () => {
    const data = { outer: { inner: { deep: "value" } } };
    const result = formatAsJson(data);

    expect(result).toBe(JSON.stringify(data, null, 2));
  });

  it("formats an empty object", () => {
    const result = formatAsJson({});

    expect(result).toBe("{}");
  });

  it("formats an empty array", () => {
    const result = formatAsJson([]);

    expect(result).toBe("[]");
  });

  it("formats null", () => {
    const result = formatAsJson(null);

    expect(result).toBe("null");
  });

  it("formats a string value", () => {
    const result = formatAsJson("hello");

    expect(result).toBe('"hello"');
  });

  it("formats a number value", () => {
    const result = formatAsJson(42);

    expect(result).toBe("42");
  });

  it("formats boolean values", () => {
    expect(formatAsJson(true)).toBe("true");
    expect(formatAsJson(false)).toBe("false");
  });
});

describe("formatAsYaml", () => {
  it("formats a flat object as YAML", () => {
    const data = { name: "test", count: 42 };
    const result = formatAsYaml(data);

    expect(result).toBe(YAML.stringify(data));
  });

  it("formats an array of objects as YAML", () => {
    const data = [
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ];
    const result = formatAsYaml(data);

    expect(result).toBe(YAML.stringify(data));
  });

  it("formats a nested object as YAML", () => {
    const data = { outer: { inner: "value" } };
    const result = formatAsYaml(data);

    expect(result).toBe(YAML.stringify(data));
  });

  it("formats an empty object as YAML", () => {
    const result = formatAsYaml({});

    expect(result).toBe(YAML.stringify({}));
  });

  it("formats an empty array as YAML", () => {
    const result = formatAsYaml([]);

    expect(result).toBe(YAML.stringify([]));
  });

  it("formats null as YAML", () => {
    const result = formatAsYaml(null);

    expect(result).toBe(YAML.stringify(null));
  });
});

describe("formatAsCsv", () => {
  describe("flat objects", () => {
    it("formats a single flat object as header + data row", () => {
      const data = { name: "test", count: 42, active: true };
      const result = formatAsCsv(data);

      const lines = result.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe("name,count,active");
      expect(lines[1]).toBe("test,42,true");
    });

    it("formats a single-field object", () => {
      const data = { id: 1 };
      const result = formatAsCsv(data);

      expect(result).toBe("id\n1");
    });
  });

  describe("arrays of flat objects", () => {
    it("formats an array of objects as header + data rows", () => {
      const data = [
        { name: "alpha", score: 10 },
        { name: "beta", score: 20 },
      ];
      const result = formatAsCsv(data);

      const lines = result.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("name,score");
      expect(lines[1]).toBe("alpha,10");
      expect(lines[2]).toBe("beta,20");
    });

    it("returns empty string for an empty array", () => {
      const result = formatAsCsv([]);

      expect(result).toBe("");
    });

    it("handles rows with different keys (union of all keys)", () => {
      const data = [
        { name: "alpha", score: 10 },
        { name: "beta", extra: "yes" },
      ];
      const result = formatAsCsv(data);

      const lines = result.split("\n");
      expect(lines[0]).toBe("name,score,extra");
      expect(lines[1]).toBe("alpha,10,");
      expect(lines[2]).toBe("beta,,yes");
    });
  });

  describe("nested object flattening", () => {
    it("flattens one level of nesting with dot-notation keys", () => {
      const data = { name: "test", config: { port: 8080, host: "localhost" } };
      const result = formatAsCsv(data);

      const lines = result.split("\n");
      expect(lines[0]).toBe("name,config.port,config.host");
      expect(lines[1]).toBe("test,8080,localhost");
    });

    it("flattens nested objects in arrays", () => {
      const data = [
        { name: "a", meta: { version: 1 } },
        { name: "b", meta: { version: 2 } },
      ];
      const result = formatAsCsv(data);

      const lines = result.split("\n");
      expect(lines[0]).toBe("name,meta.version");
      expect(lines[1]).toBe("a,1");
      expect(lines[2]).toBe("b,2");
    });

    it("serializes arrays within objects as JSON strings", () => {
      const data = { name: "test", tags: ["a", "b"] };
      const result = formatAsCsv(data);

      const lines = result.split("\n");
      expect(lines[0]).toBe("name,tags");
      expect(lines[1]).toBe('test,"[""a"",""b""]"');
    });
  });

  describe("edge cases", () => {
    it("escapes values containing commas", () => {
      const data = { description: "hello, world", name: "test" };
      const result = formatAsCsv(data);

      const lines = result.split("\n");
      expect(lines[1]).toBe('"hello, world",test');
    });

    it("escapes values containing double quotes", () => {
      const data = { value: 'say "hello"' };
      const result = formatAsCsv(data);

      const lines = result.split("\n");
      expect(lines[1]).toBe('"say ""hello"""');
    });

    it("handles empty string values", () => {
      const data = { name: "", count: 0 };
      const result = formatAsCsv(data);

      const lines = result.split("\n");
      expect(lines[1]).toBe(",0");
    });

    it("handles null values as empty fields", () => {
      const data = { name: null, count: 42 };
      const result = formatAsCsv(data);

      const lines = result.split("\n");
      expect(lines[1]).toBe(",42");
    });

    it("handles undefined values as empty fields", () => {
      const data = { name: undefined, count: 42 };
      const result = formatAsCsv(data);

      const lines = result.split("\n");
      expect(lines[1]).toBe(",42");
    });

    it("supports custom delimiter", () => {
      const data = { name: "test", count: 42 };
      const result = formatAsCsv(data, { delimiter: ";" });

      const lines = result.split("\n");
      expect(lines[0]).toBe("name;count");
      expect(lines[1]).toBe("test;42");
    });

    it("supports column selection and ordering", () => {
      const data = { name: "test", count: 42, active: true };
      const result = formatAsCsv(data, { columns: ["active", "name"] });

      const lines = result.split("\n");
      expect(lines[0]).toBe("active,name");
      expect(lines[1]).toBe("true,test");
    });

    it("escapes values containing the custom delimiter", () => {
      const data = { value: "a;b" };
      const result = formatAsCsv(data, { delimiter: ";" });

      const lines = result.split("\n");
      expect(lines[1]).toBe('"a;b"');
    });
  });

  describe("depth limit error", () => {
    it("throws error for objects nested beyond 2 levels", () => {
      const data = {
        level0: {
          level1: {
            level2: "too deep",
          },
        },
      };

      expect(() => formatAsCsv(data)).toThrow(
        /CSV format does not support nesting deeper than 2 levels/,
      );
    });

    it("throws error suggesting JSON or YAML format", () => {
      const data = {
        outer: {
          inner: {
            deep: "value",
          },
        },
      };

      expect(() => formatAsCsv(data)).toThrow(/--output json or --output yaml/);
    });

    it("includes the offending key path in the error", () => {
      const data = {
        config: {
          nested: {
            tooDeep: "value",
          },
        },
      };

      expect(() => formatAsCsv(data)).toThrow(/config\.nested/);
    });

    it("throws error for non-object/non-array data", () => {
      expect(() => formatAsCsv("string")).toThrow(
        /CSV format requires an object or array of objects/,
      );
    });

    it("throws error for arrays of primitives", () => {
      expect(() => formatAsCsv([1, 2, 3])).toThrow(/CSV format requires an array of objects/);
    });
  });
});

describe("formatMachineOutput", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setOutputFormat("text");
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    setOutputFormat("text");
  });

  it("outputs JSON to stdout for 'json' format", async () => {
    const data = { name: "test", value: 42 };

    await formatMachineOutput("json", data);

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
  });

  it("outputs YAML to stdout for 'yaml' format", async () => {
    const data = { name: "test", value: 42 };

    await formatMachineOutput("yaml", data);

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy).toHaveBeenCalledWith(YAML.stringify(data));
  });

  it("outputs CSV to stdout for 'csv' format", async () => {
    const data = { name: "test", value: 42 };

    await formatMachineOutput("csv", data);

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("name,value");
    expect(output).toContain("test,42");
  });

  it("is a no-op for 'text' format", async () => {
    await formatMachineOutput("text", { data: "value" });

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("is a no-op for 'table' format", async () => {
    await formatMachineOutput("table", { data: "value" });

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("passes CSV options through to the CSV serializer", async () => {
    const data = { name: "test", value: 42, extra: true };

    await formatMachineOutput("csv", data, {
      columns: ["value", "name"],
      delimiter: ";",
    });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("value;name");
    expect(output).toContain("42;test");
  });

  it("handles array data for JSON format", async () => {
    const data = [{ id: 1 }, { id: 2 }];

    await formatMachineOutput("json", data);

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
  });

  it("handles array data for YAML format", async () => {
    const data = [{ id: 1 }, { id: 2 }];

    await formatMachineOutput("yaml", data);

    expect(consoleSpy).toHaveBeenCalledWith(YAML.stringify(data));
  });

  it("handles array data for CSV format", async () => {
    const data = [
      { name: "a", score: 1 },
      { name: "b", score: 2 },
    ];

    await formatMachineOutput("csv", data);

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0]?.[0] as string;
    const lines = output.split("\n");
    expect(lines[0]).toBe("name,score");
    expect(lines[1]).toBe("a,1");
    expect(lines[2]).toBe("b,2");
  });
});
