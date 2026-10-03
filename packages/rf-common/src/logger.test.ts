import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatDryRun,
  initLogger,
  isDebugMode,
  logDebug,
  logError,
  logInfo,
  logSuccess,
  logWarn,
  output,
  outputInlineSuccess,
  outputJson,
  outputSuccess,
  setDebugMode,
  setJsonMode,
} from "./logger.js";
import { setOutputFormat } from "./output.js";

describe("logger", () => {
  beforeEach(() => {
    setJsonMode(false);
    setDebugMode(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["LOGGER_TEST_DEBUG"];
  });

  it("writes every human-facing variant to stderr", () => {
    logInfo("info");
    logSuccess("success");
    logWarn("warn");
    logError("error");
    output("plain");
    outputSuccess("done");
    outputInlineSuccess("inline");

    const messages = vi.mocked(console.error).mock.calls.map(([message]) => String(message));
    expect(messages).toHaveLength(7);
    for (const expected of ["[INFO] info", "[SUCCESS] success", "[WARN] warn", "[ERROR] error"]) {
      expect(messages).toContain(expected);
    }
    expect(messages).toEqual(expect.arrayContaining(["plain", "✓ done", "  ✓ inline"]));
  });

  it("suppresses human logs for every machine format", () => {
    for (const format of ["json", "yaml", "csv"] as const) {
      setOutputFormat(format);
      logInfo(format);
      output(format);
    }
    expect(console.error).not.toHaveBeenCalled();
  });

  it("emits debug output only when debug mode is enabled", () => {
    logDebug("hidden");
    expect(console.error).not.toHaveBeenCalled();

    setDebugMode(true);
    expect(isDebugMode()).toBe(true);
    logDebug("visible");
    expect(console.error).toHaveBeenCalledWith("[DEBUG] visible");
  });

  it("initializes debug state from explicit options or the configured environment variable", () => {
    process.env["LOGGER_TEST_DEBUG"] = "true";
    initLogger({ debugEnvVar: "LOGGER_TEST_DEBUG" });
    expect(isDebugMode()).toBe(true);

    initLogger({ debugMode: false });
    expect(isDebugMode()).toBe(false);
  });

  it("emits structured JSON only in JSON mode", () => {
    outputJson({ hidden: true });
    expect(console.log).not.toHaveBeenCalled();

    setJsonMode(true);
    outputJson({ ok: true });
    expect(console.log).toHaveBeenCalledWith('{\n  "ok": true\n}');
  });

  it("honors output-format JSON mode for backwards-compatible outputJson calls", () => {
    setJsonMode(false);
    setOutputFormat("json");
    outputJson(["ok"]);
    expect(console.log).toHaveBeenCalledWith('[\n  "ok"\n]');
  });

  it("formats dry-run actions consistently", () => {
    expect(formatDryRun("remove plex")).toBe("[DRY-RUN] Would remove plex");
  });
});
