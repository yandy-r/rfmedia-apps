/**
 * Unit tests for CLI error handling module.
 *
 * Tests cover:
 * - formatError: default formatting and registered formatters (built-in and custom)
 * - handleCliError: message/suggestions output, exit code, debug vs non-debug mode
 *
 * IMPORTANT: Uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecretsInjectionError, ConfigSizeError } from "./secrets.js";

// Mock logger: identity colors for stable assertions, controllable isDebugMode
const mockLogger = vi.hoisted(() => ({
  isDebugMode: vi.fn().mockReturnValue(false),
  colors: {
    red: (s: string) => s,
    yellow: (s: string) => s,
    dim: (s: string) => s,
  },
}));

vi.mock("./logger.js", () => mockLogger);

// Import after mocks
import {
  formatError,
  handleCliError,
  PromptInterruptedError,
  registerErrorFormatter,
} from "./errors.js";

describe("formatError", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("default formatting", () => {
    it("returns message, default suggestions, and exit code 1 for generic Error", () => {
      const error = new Error("Something went wrong");
      const result = formatError(error);

      expect(result.message).toBe("Something went wrong");
      expect(result.suggestions).toEqual(["Run with --debug for more details"]);
      expect(result.exitCode).toBe(1);
      expect(result.originalError).toBe(error);
    });

    it("uses fallback message when error.message is empty", () => {
      const error = new Error("");
      const result = formatError(error);

      expect(result.message).toBe("An unexpected error occurred");
      expect(result.suggestions).toEqual(["Run with --debug for more details"]);
      expect(result.exitCode).toBe(1);
    });
  });

  describe("built-in formatters", () => {
    it("formats prompt interruption with shell-standard exit code 130", () => {
      const result = formatError(new PromptInterruptedError());

      expect(result.message).toBe("Operation interrupted");
      expect(result.suggestions).toEqual([]);
      expect(result.exitCode).toBe(130);
    });

    it("formats SecretsInjectionError with message and suggestions", () => {
      const error = new SecretsInjectionError("PLEX_TOKEN");
      const result = formatError(error);

      expect(result.message).toBe("Missing required environment variable: PLEX_TOKEN");
      expect(result.suggestions).toContain(
        "Set the PLEX_TOKEN environment variable before running the command",
      );
      expect(result.suggestions).toContain(
        "Use --use-dotenvx or --use-op to inject secrets from a secure source",
      );
      expect(result.exitCode).toBe(1);
    });

    it("formats SecretsInjectionError with config path when provided", () => {
      const error = new SecretsInjectionError("API_KEY", "/path/to/.rfmedia.yaml");
      const result = formatError(error);

      expect(result.message).toContain(" (in /path/to/.rfmedia.yaml)");
    });

    it("formats ConfigSizeError with message and suggestions", () => {
      const error = new ConfigSizeError(2048, 1024); // 2KB actual, 1KB max
      const result = formatError(error);

      expect(result.message).toContain("exceeds maximum size");
      expect(result.message).toContain("2KB");
      expect(result.message).toContain("1KB");
      expect(result.suggestions).toContain("Remove unnecessary content from the config file");
      expect(result.exitCode).toBe(1);
    });

    it("formats ConfigSizeError with config path when provided", () => {
      const error = new ConfigSizeError(2048, 1024, "config.yaml");
      const result = formatError(error);

      expect(result.message).toMatch(/config\.yaml/);
    });
  });

  describe("custom formatter", () => {
    class CustomError extends Error {
      constructor(
        message: string,
        public readonly code: string,
      ) {
        super(message);
        this.name = "CustomError";
      }
    }

    it("uses registered custom formatter when canHandle matches", () => {
      registerErrorFormatter({
        canHandle: (e): e is CustomError => e instanceof CustomError,
        formatMessage: (e) => `Custom: ${e.code} - ${e.message}`,
        getSuggestions: () => ["Fix the custom thing", "Run --debug"],
        exitCode: 2,
      });

      const error = new CustomError("Failed", "ERR_CUSTOM");
      const result = formatError(error);

      expect(result.message).toBe("Custom: ERR_CUSTOM - Failed");
      expect(result.suggestions).toEqual(["Fix the custom thing", "Run --debug"]);
      expect(result.exitCode).toBe(2);
      expect(result.originalError).toBe(error);
    });

    it("uses default exit code 1 when formatter omits exitCode", () => {
      class NoExitError extends Error {
        override name = "NoExitError";
      }
      registerErrorFormatter({
        canHandle: (e): e is NoExitError => e instanceof NoExitError,
        formatMessage: (e) => e.message,
        getSuggestions: () => [],
      });

      const error = new NoExitError("no exit code");
      const result = formatError(error);

      expect(result.exitCode).toBe(1);
    });

    it("uses first matching formatter when multiple could match", () => {
      class FormatterAError extends Error {
        override name = "FormatterAError";
      }
      class FormatterBError extends Error {
        override name = "FormatterBError";
      }
      registerErrorFormatter({
        canHandle: (e): e is FormatterAError => e instanceof FormatterAError,
        formatMessage: () => "First",
        getSuggestions: () => [],
        exitCode: 10,
      });
      registerErrorFormatter({
        canHandle: (e): e is FormatterBError => e instanceof FormatterBError,
        formatMessage: () => "Second",
        getSuggestions: () => [],
        exitCode: 20,
      });

      const error = new FormatterAError("test");
      const result = formatError(error);

      expect(result.message).toBe("First");
      expect(result.exitCode).toBe(10);
    });
  });
});

describe("handleCliError", () => {
  let exitMock: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.isDebugMode.mockReturnValue(false);
    exitMock = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    }) as ReturnType<typeof vi.spyOn>;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitMock.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("formats error, outputs message and suggestions to stderr, then exits with code", () => {
    const error = new Error("Test failure");

    expect(() => handleCliError(error)).toThrow("process.exit(1)");

    const calls = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(
      calls.some(
        (s: unknown) => String(s).includes("Error:") && String(s).includes("Test failure"),
      ),
    ).toBe(true);
    expect(calls.some((s: unknown) => String(s).includes("Suggestions:"))).toBe(true);
    expect(calls.some((s: unknown) => String(s).includes("--debug"))).toBe(true);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("converts non-Error to Error and formats it", () => {
    expect(() => handleCliError("string error")).toThrow("process.exit(1)");

    const calls = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls.some((s: unknown) => String(s).includes("string error"))).toBe(true);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("exits with formatter exit code for known error types", () => {
    const error = new SecretsInjectionError("VAR");

    expect(() => handleCliError(error)).toThrow("process.exit(1)");

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("includes debug block when isDebugMode is true", () => {
    mockLogger.isDebugMode.mockReturnValue(true);
    const error = new Error("Debug me");
    error.stack = "Error: Debug me\n    at Object.<anonymous> (/test.ts:1:1)";

    expect(() => handleCliError(error)).toThrow("process.exit(1)");

    const output = consoleErrorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output).toContain("--- Debug Information ---");
    expect(output).toContain("Error type:");
    expect(output).toContain("Stack trace:");
  });

  it("does not include debug block when isDebugMode is false", () => {
    mockLogger.isDebugMode.mockReturnValue(false);
    const error = new Error("No debug");

    expect(() => handleCliError(error)).toThrow("process.exit(1)");

    const output = consoleErrorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output).not.toContain("--- Debug Information ---");
    expect(output).not.toContain("Stack trace:");
  });
});
