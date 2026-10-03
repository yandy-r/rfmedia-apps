/**
 * Tests for the copy command's plan/apply flag wiring (issue #115).
 *
 * Covers:
 * - The --dry-run regression fix (previously an unknown option)
 * - The --plan conflict matrix (typed OptionConflictError)
 * - The --apply exclusivity allowlist (getOptionValueSource-based)
 * - --plan dispatch routing to executePlanGeneration
 * - conflictStrategy freezing semantics (explicit-only, resolution 5)
 * - The interactive auto-selection guard for plan generation (resolution 22)
 * - Machine-output payloads for --plan/--apply via the global --output option
 *   (parsed through a parent command mirroring src/cli.ts)
 *
 * `copyCommand` is a module-level singleton and Commander retains option state
 * across parses, so every test re-imports the module via vi.resetModules().
 */

import { Command, Option } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignalManager, type SignalManagerRuntime } from "../lib/signal-handler.js";
import { clearMocksPreservingImplementations } from "../test-utils/mock-lifecycle.js";

// ============================================================================
// MOCK SETUP
// ============================================================================

const mocks = vi.hoisted(() => ({
  getLoadedConfig: vi.fn().mockReturnValue({}),
  executePlanGeneration: vi.fn().mockResolvedValue({
    planPath: "/tmp/p.json",
    plan: { id: "x", review: { summary: {} } },
  }),
  executePlanApply: vi.fn().mockResolvedValue({
    source: "",
    created: 0,
    skipped: 0,
    filtered: 0,
    failed: [],
  }),
  executeAlbumCopyWithFileInput: vi.fn().mockResolvedValue({
    source: "",
    created: 1,
    skipped: 0,
    filtered: 0,
    failed: [],
  }),
  executeFilterCopyWithFileInput: vi.fn().mockResolvedValue({
    source: "",
    created: 1,
    skipped: 0,
    filtered: 0,
    failed: [],
  }),
  shouldShowInteractiveSelection: vi.fn().mockReturnValue(false),
  loadCopyInteractiveSelection: vi.fn().mockResolvedValue(null),
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../cli.js", () => ({ getLoadedConfig: mocks.getLoadedConfig }));
vi.mock("../actions/copy-plan.js", () => ({
  executePlanGeneration: mocks.executePlanGeneration,
  executePlanApply: mocks.executePlanApply,
}));
vi.mock("../actions/copy-album.js", () => ({
  executeAlbumCopyWithFileInput: mocks.executeAlbumCopyWithFileInput,
}));
vi.mock("../actions/copy-filter.js", () => ({
  executeFilterCopyWithFileInput: mocks.executeFilterCopyWithFileInput,
}));
vi.mock("../lib/interactive-check.js", () => ({
  shouldShowInteractiveSelection: mocks.shouldShowInteractiveSelection,
}));
vi.mock("../lib/interactive-loader.js", () => ({
  loadCopyInteractiveSelection: mocks.loadCopyInteractiveSelection,
}));
vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: mocks.formatOutput,
}));

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Re-imports the copy command singleton with a fresh module registry so
 * Commander option state cannot leak between parses.
 */
async function loadCopyCommand() {
  vi.resetModules();
  const { copyCommand } = await import("./copy.js");
  copyCommand.exitOverride(); // throw instead of process.exit on Commander errors
  return copyCommand;
}

/** Parses the given user-style argv against a freshly loaded copy command. */
async function run(args: string[]): Promise<void> {
  const cmd = await loadCopyCommand();
  await cmd.parseAsync(args, { from: "user" });
}

/**
 * Parses argv through a parent command declaring the global --output option
 * exactly as the root program in src/cli.ts does. This is the only way to
 * exercise the machine-output branches: parsed standalone, `command.parent`
 * is null, so globalOpts is empty and the format always resolves to "text".
 *
 * Argv mirrors real usage: `rfmedia --output json copy ...`.
 */
async function runWithParent(args: string[]): Promise<void> {
  const cmd = await loadCopyCommand();
  const parent = new Command("rfmedia");
  parent.exitOverride();
  parent.addOption(
    new Option("--output <format>", "Output format (json, yaml, csv, table, text)").default("text"),
  );
  parent.addCommand(cmd);
  await parent.parseAsync(args, { from: "user" });
}

function createSignalRuntime() {
  const beforeExitListeners = new Set<() => void>();
  const signalListeners = new Map<"SIGINT" | "SIGTERM", () => void | Promise<void>>();
  const runtime: SignalManagerRuntime = {
    addSignalListener: (signal, listener) => {
      signalListeners.set(signal, listener);
    },
    removeSignalListener: (signal, listener) => {
      if (signalListeners.get(signal) === listener) signalListeners.delete(signal);
    },
    addBeforeExitListener: (listener) => {
      beforeExitListeners.add(listener);
    },
    removeBeforeExitListener: (listener) => {
      beforeExitListeners.delete(listener);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
    exit: (code) => {
      throw new Error(`Unexpected forced exit ${String(code)}`);
    },
    error: vi.fn(),
  };

  const send = async (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    const listener = signalListeners.get(signal);
    if (listener === undefined) throw new Error(`Missing ${signal} listener`);
    await listener();
  };

  const emitBeforeExit = (): void => {
    for (const listener of [...beforeExitListeners]) listener();
  };

  return { emitBeforeExit, runtime, send };
}

// ============================================================================
// TESTS
// ============================================================================

describe("copy command plan/apply flags", () => {
  beforeEach(() => {
    clearMocksPreservingImplementations();
    // Re-establish defaults so per-test overrides cannot leak forward
    mocks.getLoadedConfig.mockReturnValue({});
    mocks.executePlanGeneration.mockResolvedValue({
      planPath: "/tmp/p.json",
      plan: { id: "x", review: { summary: {} } },
    });
    mocks.executePlanApply.mockResolvedValue({
      source: "",
      created: 0,
      skipped: 0,
      filtered: 0,
      failed: [],
    });
    mocks.executeAlbumCopyWithFileInput.mockResolvedValue({
      source: "",
      created: 1,
      skipped: 0,
      filtered: 0,
      failed: [],
    });
    mocks.executeFilterCopyWithFileInput.mockResolvedValue({
      source: "",
      created: 1,
      skipped: 0,
      filtered: 0,
      failed: [],
    });
    mocks.shouldShowInteractiveSelection.mockReturnValue(false);
    mocks.loadCopyInteractiveSelection.mockResolvedValue(null);
    mocks.formatOutput.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Tests exercising the failure path set process.exitCode = 1
    process.exitCode = undefined;
  });

  describe("--dry-run regression (previously unknown option)", () => {
    it("parses --dry-run and threads dryRun: true into the dispatched options", async () => {
      await run(["/src", "/dest", "--range", "001-002", "--dry-run"]);

      expect(mocks.executeAlbumCopyWithFileInput).toHaveBeenCalledTimes(1);
      const call = mocks.executeAlbumCopyWithFileInput.mock.calls[0];
      expect(call?.[1]).toBe("/dest");
      expect(call?.[2]).toMatchObject({ dryRun: true });
    });

    it("defaults dryRun to false when --dry-run is absent", async () => {
      await run(["/src", "/dest", "--range", "001-002"]);

      expect(mocks.executeAlbumCopyWithFileInput).toHaveBeenCalledTimes(1);
      expect(mocks.executeAlbumCopyWithFileInput.mock.calls[0]?.[2]).toMatchObject({
        dryRun: false,
      });
    });
  });

  it("retains the signal-owned exit code after an aborted copy reports a failure", async () => {
    const { emitBeforeExit, runtime, send } = createSignalRuntime();
    const manager = SignalManager.createForTesting(runtime);
    mocks.executeAlbumCopyWithFileInput.mockImplementationOnce(async () => {
      await send("SIGINT");
      expect(manager.getSignal().aborted).toBe(true);
      return {
        source: "",
        created: 0,
        skipped: 0,
        filtered: 0,
        failed: [{ path: "/x", message: "cancelled" }],
      };
    });

    await run(["/src", "/dest", "--range", "001-002"]);

    expect(process.exitCode).toBe(1);
    emitBeforeExit();
    expect(process.exitCode).toBe(130);
  });

  describe("conflict matrix", () => {
    it.each<[string[], string]>([
      [["--plan", "--apply", "p.json"], "--apply"],
      [["--plan", "--dry-run"], "--dry-run"],
      [["--plan", "--interactive"], "--interactive"],
      [["--plan", "--album-mode"], "--album-mode"],
      // planRequested also derives from --plan-output alone (implies --plan)
      [["--plan-output", "out.json", "--interactive"], "--interactive"],
      [["--plan-output", "out.json", "--apply", "p.json"], "--apply"],
      [["--plan-output", "out.json", "--dry-run"], "--dry-run"],
    ])("rejects --plan with %j", async (flags, conflictingOption) => {
      await expect(run(flags)).rejects.toMatchObject({
        name: "OptionConflictError",
        option: "--plan",
        conflictingOption,
      });
      expect(mocks.executePlanGeneration).not.toHaveBeenCalled();
      expect(mocks.executePlanApply).not.toHaveBeenCalled();
    });

    it("rejects --plan when config copy.albumMode resolves album mode without the CLI flag", async () => {
      mocks.getLoadedConfig.mockReturnValue({ copy: { albumMode: true } });

      await expect(run(["/src", "/dest", "--min-stars", "4", "--plan"])).rejects.toMatchObject({
        name: "OptionConflictError",
        option: "--plan",
        conflictingOption: "--album-mode",
      });
      expect(mocks.executePlanGeneration).not.toHaveBeenCalled();
    });
  });

  describe("--apply exclusivity", () => {
    it("rejects positional paths alongside --apply", async () => {
      await expect(run(["/src", "/dest", "--apply", "p.json"])).rejects.toMatchObject({
        name: "OptionConflictError",
        option: "--apply",
        conflictingOption: "positional path arguments",
      });
      expect(mocks.executePlanApply).not.toHaveBeenCalled();
    });

    // NOTE: single cases-array argument — it.each(a, b, c) silently drops b and c
    it.each<[string[]]>([
      [["--convert", "mp3"]],
      [["--range", "001-002"]],
      [["--min-stars", "4"]],
      [["--force"]],
      [["--no-verify"]],
    ])("rejects non-allowlisted CLI flag with --apply: %j", async (flags) => {
      await expect(run(["--apply", "p.json", ...flags])).rejects.toMatchObject({
        name: "OptionConflictError",
        option: "--apply",
      });
      expect(mocks.executePlanApply).not.toHaveBeenCalled();
    });

    it("accepts the allowlisted companions --dry-run --yes --force-stale --progress --verbose", async () => {
      await run([
        "--apply",
        "p.json",
        "--dry-run",
        "--yes",
        "--force-stale",
        "--progress",
        "--verbose",
      ]);

      expect(mocks.executePlanApply).toHaveBeenCalledTimes(1);
      expect(mocks.executePlanApply).toHaveBeenCalledWith({
        planPath: "p.json",
        dryRun: true,
        yes: true,
        forceStale: true,
        machineOutput: false,
        progress: true,
        verbose: true,
      });
      expect(mocks.executeAlbumCopyWithFileInput).not.toHaveBeenCalled();
      expect(mocks.executeFilterCopyWithFileInput).not.toHaveBeenCalled();
    });

    it("passes machineOutput, yes, forceStale, and planPath through to executePlanApply", async () => {
      await run(["--apply", "/tmp/plan.json", "--yes", "--force-stale"]);

      expect(mocks.executePlanApply).toHaveBeenCalledWith({
        planPath: "/tmp/plan.json",
        dryRun: false,
        yes: true,
        forceStale: true,
        // Standalone command has no parent --output option: text format → non-machine
        machineOutput: false,
        progress: undefined,
        verbose: undefined,
      });
    });

    it("sets exitCode 1 when apply result has failures", async () => {
      mocks.executePlanApply.mockResolvedValue({
        source: "",
        created: 0,
        skipped: 0,
        filtered: 0,
        failed: [{ path: "/x", message: "boom" }],
      });

      await run(["--apply", "p.json", "--yes"]);

      expect(process.exitCode).toBe(1);
    });
  });

  describe("--plan generation routing", () => {
    it("routes to executePlanGeneration instead of the copy dispatch", async () => {
      await run(["/src", "/dest", "--range", "001-002", "--plan"]);

      expect(mocks.executePlanGeneration).toHaveBeenCalledTimes(1);
      const args = mocks.executePlanGeneration.mock.calls[0]?.[0];
      expect(args?.destination).toBe("/dest");
      expect(args?.planOutput).toBeUndefined();
      expect(args?.copyOptions?.mode?.type).toBe("album");
      expect(args?.copyOptions?.cliSourceEntries).toEqual([{ path: "/src" }]);
      expect(mocks.executeAlbumCopyWithFileInput).not.toHaveBeenCalled();
      expect(mocks.executeFilterCopyWithFileInput).not.toHaveBeenCalled();
    });

    it("--plan-output implies --plan and forwards the path", async () => {
      await run(["/src", "/dest", "--range", "001-002", "--plan-output", "/tmp/custom-plan.json"]);

      expect(mocks.executePlanGeneration).toHaveBeenCalledTimes(1);
      expect(mocks.executePlanGeneration.mock.calls[0]?.[0]).toMatchObject({
        destination: "/dest",
        planOutput: "/tmp/custom-plan.json",
      });
      expect(mocks.executeAlbumCopyWithFileInput).not.toHaveBeenCalled();
    });

    it("strips the defaulted conflictStrategy from generated plans", async () => {
      await run(["/src", "/dest", "--range", "001-002", "--plan"]);

      const args = mocks.executePlanGeneration.mock.calls[0]?.[0];
      expect(args?.copyOptions?.conflictStrategy).toBeUndefined();
    });

    it("keeps an explicitly passed --conflict-strategy skip in the frozen options", async () => {
      await run(["/src", "/dest", "--range", "001-002", "--conflict-strategy", "skip", "--plan"]);

      const args = mocks.executePlanGeneration.mock.calls[0]?.[0];
      expect(args?.copyOptions?.conflictStrategy).toBe("skip");
    });

    it("TTY --plan without -i never invokes interactive selection", async () => {
      // Simulate a TTY where auto-detection would enable interactive selection
      mocks.shouldShowInteractiveSelection.mockReturnValue(true);

      await run(["/src", "/dest", "--min-stars", "4", "--plan"]);

      // The planRequested guard short-circuits before the TTY check runs
      expect(mocks.shouldShowInteractiveSelection).not.toHaveBeenCalled();
      expect(mocks.loadCopyInteractiveSelection).not.toHaveBeenCalled();
      expect(mocks.executePlanGeneration).toHaveBeenCalledTimes(1);
    });
  });

  describe("machine output via global --output", () => {
    it("--apply with --output json sets machineOutput and emits the payload including filtered", async () => {
      mocks.executePlanApply.mockResolvedValue({
        source: "",
        created: 3,
        skipped: 1,
        filtered: 2,
        failed: [],
      });

      await runWithParent(["--output", "json", "copy", "--apply", "p.json", "--yes"]);

      expect(mocks.executePlanApply).toHaveBeenCalledTimes(1);
      expect(mocks.executePlanApply).toHaveBeenCalledWith({
        planPath: "p.json",
        dryRun: false,
        yes: true,
        forceStale: false,
        machineOutput: true,
        progress: undefined,
        verbose: undefined,
      });
      expect(mocks.formatOutput).toHaveBeenCalledTimes(1);
      expect(mocks.formatOutput).toHaveBeenCalledWith("json", {
        command: "copy",
        result: {
          planPath: "p.json",
          applied: true,
          created: 3,
          skipped: 1,
          filtered: 2,
          failed: [],
        },
      });
    });

    it("--apply --dry-run with --output json reports applied: false", async () => {
      await runWithParent(["--output", "json", "copy", "--apply", "p.json", "--yes", "--dry-run"]);

      expect(mocks.executePlanApply).toHaveBeenCalledWith(
        expect.objectContaining({ dryRun: true, machineOutput: true }),
      );
      expect(mocks.formatOutput).toHaveBeenCalledTimes(1);
      expect(mocks.formatOutput).toHaveBeenCalledWith("json", {
        command: "copy",
        result: {
          planPath: "p.json",
          applied: false,
          created: 0,
          skipped: 0,
          filtered: 0,
          failed: [],
        },
      });
    });

    it("--plan with --output json emits planPath, planId, and summary", async () => {
      await runWithParent([
        "--output",
        "json",
        "copy",
        "/src",
        "/dest",
        "--range",
        "001-002",
        "--plan",
      ]);

      expect(mocks.executePlanGeneration).toHaveBeenCalledTimes(1);
      expect(mocks.formatOutput).toHaveBeenCalledTimes(1);
      expect(mocks.formatOutput).toHaveBeenCalledWith("json", {
        command: "copy",
        result: { planPath: "/tmp/p.json", planId: "x", summary: {} },
      });
    });

    it("default text format never routes through formatOutput", async () => {
      await runWithParent(["copy", "--apply", "p.json", "--yes"]);

      expect(mocks.executePlanApply).toHaveBeenCalledWith(
        expect.objectContaining({ machineOutput: false }),
      );
      expect(mocks.formatOutput).not.toHaveBeenCalled();
    });
  });
});
