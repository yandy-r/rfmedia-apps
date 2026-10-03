import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLogger = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("./logger.js", () => mockLogger);

import {
  ConfigSizeError,
  findUnresolvedTemplates,
  hasUnresolvedTemplates,
  injectSecrets,
  MAX_CONFIG_SIZE_BYTES,
  SecretsInjectionError,
  validateConfigSize,
  warnUnresolvedTemplates,
} from "./secrets.js";

describe("secrets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("injectSecrets", () => {
    it("resolves the complete supported template syntax without changing surrounding content", () => {
      const content = [
        'compact: "{{FOO}}"',
        'spaced: "{{ BAR }}"',
        'wide: "{{  VAR_123  }}"',
        "numeric: {{ PORT }}",
      ].join("\n");

      expect(
        injectSecrets(content, {
          env: { FOO: "one", BAR: "two", VAR_123: "three", PORT: "32400" },
        }),
      ).toBe(['compact: "one"', 'spaced: "two"', 'wide: "three"', "numeric: 32400"].join("\n"));
      expect(mockLogger.logDebug.mock.calls).toEqual([
        ["Resolved template variable: FOO"],
        ["Resolved template variable: BAR"],
        ["Resolved template variable: VAR_123"],
        ["Resolved template variable: PORT"],
      ]);
    });

    it("accepts empty values and leaves content without valid templates unchanged", () => {
      expect(injectSecrets('token: "{{ EMPTY }}"', { env: { EMPTY: "" } })).toBe('token: ""');

      vi.clearAllMocks();
      const content = ['single: "{FOO}"', 'hyphen: "{{ FOO-BAR }}"', 'dot: "{{ FOO.BAR }}"'].join(
        "\n",
      );
      expect(injectSecrets(content, { env: {} })).toBe(content);
      expect(mockLogger.logDebug).not.toHaveBeenCalled();
    });

    it("logs variable names but never resolved secret values", () => {
      const secret = "super_secret_token_12345";

      expect(injectSecrets("{{ SECRET }}", { env: { SECRET: secret } })).toBe(secret);
      expect(mockLogger.logDebug).toHaveBeenCalledWith("Resolved template variable: SECRET");
      expect(JSON.stringify(mockLogger.logDebug.mock.calls)).not.toContain(secret);
    });

    it("throws a typed error for the first missing variable with optional path context", () => {
      expect(() =>
        injectSecrets("{{ FIRST_MISSING }} {{ SECOND_MISSING }}", {
          env: {},
          configPath: "/config/rfmedia.yaml",
        }),
      ).toThrow(SecretsInjectionError);

      try {
        injectSecrets("{{ FIRST_MISSING }} {{ SECOND_MISSING }}", {
          env: {},
          configPath: "/config/rfmedia.yaml",
        });
        expect.fail("Expected SecretsInjectionError");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(SecretsInjectionError);
        expect(error).toMatchObject({
          name: "SecretsInjectionError",
          variableName: "FIRST_MISSING",
          configPath: "/config/rfmedia.yaml",
          message:
            "Environment variable 'FIRST_MISSING' is not set (required by config template in /config/rfmedia.yaml)",
        });
      }
    });
  });

  describe("unresolved template detection", () => {
    it("detects every complete template-like form without false positives", () => {
      const present = ["{{FOO}}", "{{ }}", "{{ FOO BAR }}", "{{ FOO-BAR }}", 'x: "{{ A }}"'];
      const absent = ["", "{FOO}", "{{ FOO }", "{ FOO }}", "plain text"];

      for (const content of present) {
        expect(hasUnresolvedTemplates(content), content).toBe(true);
      }
      for (const content of absent) {
        expect(hasUnresolvedTemplates(content), content).toBe(false);
      }
    });

    it("returns all unresolved templates in source order", () => {
      expect(findUnresolvedTemplates("{{ FOO }} / {{ }} / {{ BAD-NAME }}")).toEqual([
        "{{ FOO }}",
        "{{ }}",
        "{{ BAD-NAME }}",
      ]);
      expect(findUnresolvedTemplates("{{ incomplete } and {single}")).toEqual([]);
    });
  });

  describe("config size validation", () => {
    it("accepts empty, ordinary, and exact-limit byte sizes", () => {
      for (const content of ["", 'key: "value"', "x".repeat(MAX_CONFIG_SIZE_BYTES)]) {
        expect(() => validateConfigSize(content)).not.toThrow();
      }
    });

    it("rejects the first byte over the limit with the complete error contract", () => {
      const content = "x".repeat(MAX_CONFIG_SIZE_BYTES + 1);

      try {
        validateConfigSize(content, "/config/rfmedia.yaml");
        expect.fail("Expected ConfigSizeError");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(ConfigSizeError);
        expect(error).toMatchObject({
          name: "ConfigSizeError",
          actualSize: MAX_CONFIG_SIZE_BYTES + 1,
          maxSize: MAX_CONFIG_SIZE_BYTES,
          configPath: "/config/rfmedia.yaml",
        });
        expect((error as Error).message).toContain("/config/rfmedia.yaml");
      }
    });

    it("measures UTF-8 bytes rather than JavaScript characters", () => {
      const content = "日".repeat(Math.floor(MAX_CONFIG_SIZE_BYTES / 3) + 1);

      expect(content.length).toBeLessThan(MAX_CONFIG_SIZE_BYTES);
      expect(() => validateConfigSize(content)).toThrow(ConfigSizeError);
    });
  });

  describe("warnUnresolvedTemplates", () => {
    it("does not warn when no unresolved pattern remains", () => {
      warnUnresolvedTemplates('token: "resolved"');
      warnUnresolvedTemplates("");

      expect(mockLogger.logWarn).not.toHaveBeenCalled();
    });

    it("reports count, path, patterns, and remediation guidance without extra calls", () => {
      warnUnresolvedTemplates("{{ FOO BAR }} and {{ MISSING }}", "/config/rfmedia.yaml");

      expect(mockLogger.logWarn.mock.calls).toEqual([
        [
          "Found 2 unresolved template pattern(s) in /config/rfmedia.yaml: {{ FOO BAR }}, {{ MISSING }}",
        ],
        [
          "These may indicate malformed templates (invalid variable names, spaces, or special characters)",
        ],
      ]);
    });
  });
});
