import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripVTControlCharacters } from "node:util";

import type { OutputFormat } from "@rfmedia/common";

import type { ReconciliationActionOptions } from "../actions/reconcile.js";
import type { ReconciliationResult } from "../types/reconciliation.js";

const mockFormatOutput = vi.hoisted(() => vi.fn());

vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: mockFormatOutput,
}));

import { RECONCILE_CSV_COLUMNS, createReconcileCommand } from "./reconcile.js";

const SOURCE_ROOT = "/music";

function createResult(overrides: Partial<ReconciliationResult> = {}): ReconciliationResult {
  return {
    schema: "rfmedia.reconcile.v1",
    status: "scanned",
    success: true,
    exitCode: 0,
    mode: "scan",
    strategy: null,
    sourceRoot: SOURCE_ROOT,
    library: "Music",
    databasePath: "/state/rfmedia.db",
    operationId: null,
    requestedFields: ["rating"],
    requestedOperations: ["rating", "database-stat-refresh"],
    executed: false,
    executable: true,
    allowPartial: false,
    counts: {
      paths: 0,
      findings: 0,
      inSync: 0,
      observedResiduals: 0,
      blockers: 0,
      ratingOutcomes: {
        total: 0,
        planned: 0,
        applied: 0,
        skipped: 0,
        unsupported: 0,
        failed: 0,
      },
      databaseStatOutcomes: {
        total: 0,
        planned: 0,
        applied: 0,
        skipped: 0,
        failed: 0,
      },
    },
    findings: [],
    observedResiduals: [],
    blockers: [],
    failureCodes: [],
    outcomes: [],
    postApply: null,
    ...overrides,
  };
}

function createHarness(
  format: OutputFormat = "text",
  result: ReconciliationResult = createResult(),
) {
  const abortController = new AbortController();
  const executeReconciliation =
    vi.fn<(options: ReconciliationActionOptions) => Promise<ReconciliationResult>>();
  executeReconciliation.mockResolvedValue(result);
  const loadActions = vi.fn().mockResolvedValue({ executeReconciliation });
  const command = createReconcileCommand({
    resolveFormat: () => format,
    resolveSignal: () => abortController.signal,
    loadActions,
  });
  command.exitOverride();
  return { abortController, command, executeReconciliation, loadActions };
}

describe("reconcile command", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    mockFormatOutput.mockResolvedValue(undefined);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    process.exitCode = undefined;
  });

  it("parses the exact scan read options", async () => {
    const { abortController, command, executeReconciliation } = createHarness();

    await command.parseAsync(
      [
        "scan",
        SOURCE_ROOT,
        "--library",
        "Music",
        "--tracking-database",
        "/state/rfmedia.db",
        "--operation-id",
        "7",
        "--workers",
        "3",
        "--no-progress",
      ],
      { from: "user" },
    );

    expect(executeReconciliation).toHaveBeenCalledWith({
      mode: "scan",
      sourcePath: SOURCE_ROOT,
      library: "Music",
      trackingDatabase: "/state/rfmedia.db",
      operationId: 7,
      workers: 3,
      progress: false,
      signal: abortController.signal,
    });
  });

  it.each([
    ["text", true],
    ["json", false],
    ["yaml", false],
    ["csv", false],
  ] as const)("sets %s output progress to %s", async (format, progress) => {
    const { command, executeReconciliation } = createHarness(format);

    await command.parseAsync(["scan", SOURCE_ROOT], { from: "user" });

    expect(executeReconciliation).toHaveBeenCalledWith(expect.objectContaining({ progress }));
  });

  it("rejects a missing source before loading actions", async () => {
    const { command, loadActions } = createHarness();

    await expect(command.parseAsync(["scan"], { from: "user" })).rejects.toThrow();

    expect(loadActions).not.toHaveBeenCalled();
  });

  it.each([
    ["relative source", ["scan", "music"], "Source path must be absolute"],
    [
      "zero operation ID",
      ["scan", SOURCE_ROOT, "--operation-id", "0"],
      "Value must be a positive integer",
    ],
    [
      "non-numeric workers",
      ["scan", SOURCE_ROOT, "--workers", "many"],
      "Value must be a positive integer",
    ],
  ])("reports an invalid %s through the machine error envelope", async (_label, args, message) => {
    const { command, loadActions } = createHarness("json");

    await command.parseAsync(args, { from: "user" });

    expect(loadActions).not.toHaveBeenCalled();
    expect(mockFormatOutput).toHaveBeenCalledOnce();
    expect(mockFormatOutput).toHaveBeenCalledWith("json", {
      command: "reconcile",
      error: { message, exitCode: 1 },
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("parses the full apply option contract", async () => {
    const result = createResult({
      status: "preview",
      mode: "apply",
      strategy: "file-wins",
    });
    const { abortController, command, executeReconciliation } = createHarness("text", result);

    await command.parseAsync(
      [
        "apply",
        SOURCE_ROOT,
        "--library",
        "Music",
        "--tracking-database",
        "/state/rfmedia.db",
        "--operation-id",
        "7",
        "--workers",
        "3",
        "--no-progress",
        "--file-wins",
        "--popm-email",
        "owner@example.test",
        "--execute",
        "--allow-partial",
        "--yes",
      ],
      { from: "user" },
    );

    expect(executeReconciliation).toHaveBeenCalledWith({
      mode: "apply",
      sourcePath: SOURCE_ROOT,
      library: "Music",
      trackingDatabase: "/state/rfmedia.db",
      operationId: 7,
      workers: 3,
      progress: false,
      fileWins: true,
      dbWins: false,
      serverWins: false,
      execute: true,
      allowPartial: true,
      yes: true,
      machineOutput: false,
      popmEmail: "owner@example.test",
      signal: abortController.signal,
    });
  });

  it("passes an aborted process signal through scan acquisition and reports exit 130", async () => {
    const { abortController, command, executeReconciliation } = createHarness("json");
    abortController.abort();
    executeReconciliation.mockImplementation(async (options) => {
      options.signal?.throwIfAborted();
      return createResult();
    });

    await command.parseAsync(["scan", SOURCE_ROOT], { from: "user" });

    expect(executeReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ signal: abortController.signal }),
    );
    expect(mockFormatOutput).toHaveBeenCalledOnce();
    expect(mockFormatOutput.mock.calls[0]?.[1]).toEqual({
      command: "reconcile",
      error: {
        message: expect.any(String),
        exitCode: 130,
      },
    });
    expect(process.exitCode).toBe(130);
  });

  it("reports a thrown SIGTERM cancellation with machine and process exit 143", async () => {
    const { abortController, command, executeReconciliation } = createHarness("json");
    const cancellation = new DOMException("This operation was aborted", "AbortError");
    executeReconciliation.mockImplementation(async () => {
      process.exitCode = 143;
      abortController.abort(cancellation);
      throw cancellation;
    });

    await command.parseAsync(["scan", SOURCE_ROOT], { from: "user" });

    expect(mockFormatOutput).toHaveBeenCalledWith("json", {
      command: "reconcile",
      error: {
        message: "This operation was aborted",
        exitCode: 143,
      },
    });
    expect(process.exitCode).toBe(143);
  });

  it.each([130, 143] as const)(
    "keeps signal-owned exit %i in a wrapped-error machine envelope",
    async (signalExitCode) => {
      const { abortController, command, executeReconciliation } = createHarness("json");
      executeReconciliation.mockImplementation(async () => {
        process.exitCode = signalExitCode;
        abortController.abort();
        throw new Error("wrapped cancellation");
      });

      await command.parseAsync(["scan", SOURCE_ROOT], { from: "user" });

      expect(mockFormatOutput).toHaveBeenCalledWith("json", {
        command: "reconcile",
        error: {
          message: "wrapped cancellation",
          exitCode: signalExitCode,
        },
      });
      expect(process.exitCode).toBe(signalExitCode);
    },
  );

  it("renders a structured SIGINT cancellation with completed outcomes before exit 130", async () => {
    const completedOutcome = {
      kind: "rating",
      path: "/music/complete.mp3",
      target: "server",
      before: 2,
      intended: 4,
      status: "applied",
      code: "applied",
    } as const;
    const cancelledResult = createResult({
      status: "cancelled",
      success: false,
      exitCode: 130,
      mode: "apply",
      strategy: "db-wins",
      executed: true,
      failureCodes: ["cancelled"],
      outcomes: [completedOutcome],
      postApply: {
        status: "cancelled",
        checkedPaths: 1,
        requestedRatingDrift: 0,
        pendingDatabaseStatRefreshes: 0,
        findings: [],
        blockers: [],
        failureCodes: ["cancelled"],
      },
    });
    const { abortController, command, executeReconciliation } = createHarness(
      "json",
      cancelledResult,
    );
    executeReconciliation.mockImplementation(
      async (options) =>
        await new Promise<ReconciliationResult>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(cancelledResult), {
            once: true,
          });
          abortController.abort();
        }),
    );

    await command.parseAsync(["apply", SOURCE_ROOT, "--db-wins", "--execute", "--yes"], {
      from: "user",
    });

    expect(executeReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ signal: abortController.signal }),
    );
    expect(mockFormatOutput).toHaveBeenCalledOnce();
    expect(mockFormatOutput).toHaveBeenCalledWith("json", {
      command: "reconcile",
      result: cancelledResult,
    });
    expect(cancelledResult.outcomes).toContain(completedOutcome);
    expect(process.exitCode).toBe(130);
  });

  it("reports and preserves the signal manager SIGTERM exit code while rendering cancellation", async () => {
    const cancelledResult = createResult({
      status: "cancelled",
      success: false,
      exitCode: 130,
      mode: "apply",
      strategy: "server-wins",
      executed: true,
      failureCodes: ["cancelled"],
    });
    const { abortController, command, executeReconciliation } = createHarness(
      "json",
      cancelledResult,
    );
    executeReconciliation.mockImplementation(async () => {
      process.exitCode = 143;
      abortController.abort();
      return cancelledResult;
    });

    await command.parseAsync(["apply", SOURCE_ROOT, "--server-wins", "--execute", "--yes"], {
      from: "user",
    });

    expect(mockFormatOutput).toHaveBeenCalledWith("json", {
      command: "reconcile",
      result: { ...cancelledResult, exitCode: 143 },
    });
    expect(process.exitCode).toBe(143);
  });

  it("leaves an omitted library undefined for the action-owned config fallback", async () => {
    const result = createResult({
      status: "preview",
      mode: "apply",
      strategy: "db-wins",
    });
    const { command, executeReconciliation } = createHarness("text", result);

    await command.parseAsync(["apply", SOURCE_ROOT, "--db-wins"], { from: "user" });

    expect(executeReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "apply",
        library: undefined,
        dbWins: true,
      }),
    );
  });

  it("rejects a missing winner before loading actions", async () => {
    const { command, loadActions } = createHarness("json");

    await command.parseAsync(["apply", SOURCE_ROOT], { from: "user" });

    expect(loadActions).not.toHaveBeenCalled();
    expect(mockFormatOutput).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["--file-wins", "--db-wins"],
    ["--file-wins", "--server-wins"],
    ["--db-wins", "--server-wins"],
  ])("rejects conflicting winners %s and %s before loading actions", async (left, right) => {
    const { command, loadActions } = createHarness();

    await expect(
      command.parseAsync(["apply", SOURCE_ROOT, left, right], { from: "user" }),
    ).rejects.toThrow();

    expect(loadActions).not.toHaveBeenCalled();
  });

  it.each([
    ["--file-wins", { fileWins: true, dbWins: false, serverWins: false }],
    ["--db-wins", { fileWins: false, dbWins: true, serverWins: false }],
    ["--server-wins", { fileWins: false, dbWins: false, serverWins: true }],
  ] as const)("normalizes the single winner %s", async (flag, expected) => {
    const result = createResult({ status: "preview", mode: "apply" });
    const { command, executeReconciliation } = createHarness("text", result);

    await command.parseAsync(["apply", SOURCE_ROOT, flag], { from: "user" });

    expect(executeReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        ...expected,
        execute: false,
        allowPartial: false,
        yes: false,
      }),
    );
  });

  it.each([
    [[], { execute: false, allowPartial: false, yes: false }],
    [["--execute"], { execute: true, allowPartial: false, yes: false }],
    [["--allow-partial"], { execute: false, allowPartial: true, yes: false }],
    [["--yes"], { execute: false, allowPartial: false, yes: true }],
  ] as const)(
    "keeps execute, allow-partial, and yes independent for %j",
    async (flags, expected) => {
      const result = createResult({ status: "preview", mode: "apply" });
      const { command, executeReconciliation } = createHarness("text", result);

      await command.parseAsync(["apply", SOURCE_ROOT, "--file-wins", ...flags], {
        from: "user",
      });

      expect(executeReconciliation).toHaveBeenCalledWith(expect.objectContaining(expected));
    },
  );

  it.each(["json", "yaml"] as const)("emits exactly one %s envelope", async (format) => {
    const result = createResult();
    const { command } = createHarness(format, result);

    await command.parseAsync(["scan", SOURCE_ROOT], { from: "user" });

    expect(mockFormatOutput).toHaveBeenCalledOnce();
    expect(mockFormatOutput).toHaveBeenCalledWith(format, {
      command: "reconcile",
      result,
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("emits fixed CSV headers and a mandatory summary row for an empty result", async () => {
    const result = createResult();
    const { command } = createHarness("csv", result);

    await command.parseAsync(["scan", SOURCE_ROOT], { from: "user" });

    expect(mockFormatOutput).toHaveBeenCalledOnce();
    const call = mockFormatOutput.mock.calls[0];
    expect(call?.[0]).toBe("csv");
    expect(call?.[2]).toEqual({ columns: [...RECONCILE_CSV_COLUMNS] });
    expect(call?.[1]).toEqual([
      expect.objectContaining({
        command: "reconcile",
        rowKind: "summary",
        schema: "rfmedia.reconcile.v1",
        status: "scanned",
        "counts.paths": 0,
        "counts.findings": 0,
      }),
    ]);
  });

  it("renders human output only to stderr", async () => {
    const { command } = createHarness();

    await command.parseAsync(["scan", SOURCE_ROOT], { from: "user" });

    expect(consoleErrorSpy.mock.calls.flat().map(String).join("\n")).toContain(
      "Metadata Reconciliation",
    );
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(mockFormatOutput).not.toHaveBeenCalled();
  });

  it("projects terminal controls only in human output while preserving machine data", async () => {
    const unsafePath = "/music/\u001b[31mspoof\u202Egpj";
    const unsafeLibrary = "Music\u0007";
    const result = createResult({
      sourceRoot: unsafePath,
      library: unsafeLibrary,
      findings: [
        {
          path: unsafePath,
          field: "artist",
          code: "conflicting-value",
          evidence: [
            { plane: "file", state: "present", value: "Artist\u001b[2J" },
            { plane: "database", state: "missing", value: null },
            { plane: "server", state: "present", value: "Artist\u202E" },
          ],
          operationIds: [],
          serverTrackIds: [],
          repairable: false,
        },
      ],
    });
    const human = createHarness("text", result);

    await human.command.parseAsync(["scan", SOURCE_ROOT], { from: "user" });

    const rendered = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    const renderedContent = stripVTControlCharacters(rendered);
    expect(renderedContent).not.toMatch(
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]|\p{Bidi_Control}/u,
    );
    expect(renderedContent).toContain("\uFFFD");

    vi.clearAllMocks();
    const machine = createHarness("json", result);
    await machine.command.parseAsync(["scan", SOURCE_ROOT], { from: "user" });

    expect(mockFormatOutput).toHaveBeenCalledWith("json", {
      command: "reconcile",
      result,
    });
  });

  it.each([
    [
      "scan drift",
      "scan",
      createResult({
        status: "scanned",
        counts: {
          ...createResult().counts,
          paths: 1,
          findings: 1,
        },
      }),
    ],
    [
      "blocked preview",
      "apply",
      createResult({
        status: "preview",
        mode: "apply",
        strategy: "file-wins",
        executable: false,
      }),
    ],
  ] as const)("keeps %s at exit zero", async (_label, mode, result) => {
    const { command } = createHarness("json", result);
    const args = mode === "scan" ? ["scan", SOURCE_ROOT] : ["apply", SOURCE_ROOT, "--file-wins"];

    await command.parseAsync(args, { from: "user" });

    expect(process.exitCode).toBe(0);
  });

  it("emits an incomplete executed result before setting a nonzero exit code and never exits", async () => {
    const result = createResult({
      status: "partial",
      success: false,
      exitCode: 1,
      mode: "apply",
      strategy: "server-wins",
      executed: true,
      allowPartial: true,
      postApply: {
        status: "incomplete",
        checkedPaths: 1,
        requestedRatingDrift: 1,
        pendingDatabaseStatRefreshes: 0,
        findings: [],
        blockers: [],
        failureCodes: ["verification-failed"],
      },
    });
    const { command } = createHarness("json", result);
    mockFormatOutput.mockImplementation(async () => {
      expect(process.exitCode).toBeUndefined();
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    try {
      await command.parseAsync(
        ["apply", SOURCE_ROOT, "--server-wins", "--execute", "--allow-partial", "--yes"],
        { from: "user" },
      );

      expect(mockFormatOutput).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("passes machine execution without yes to the action seam for prompt-free rejection", async () => {
    const { command, executeReconciliation } = createHarness("json");
    executeReconciliation.mockRejectedValue(
      new Error("Non-interactive or machine-output reconciliation execution requires --yes."),
    );

    await command.parseAsync(["apply", SOURCE_ROOT, "--db-wins", "--execute"], {
      from: "user",
    });

    expect(executeReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        execute: true,
        yes: false,
        machineOutput: true,
      }),
    );
    expect(mockFormatOutput).toHaveBeenCalledOnce();
    expect(mockFormatOutput.mock.calls[0]?.[1]).toEqual({
      command: "reconcile",
      error: {
        message: "Non-interactive or machine-output reconciliation execution requires --yes.",
        exitCode: 1,
      },
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["scan", ["scan", SOURCE_ROOT]],
    ["preview", ["apply", SOURCE_ROOT, "--file-wins"]],
  ])(
    "returns a nonzero machine error when %s acquisition reports read-failed",
    async (_label, args) => {
      const { command, executeReconciliation } = createHarness("json");
      executeReconciliation.mockRejectedValue(new Error("read-failed: unable to read metadata"));

      await command.parseAsync(args, { from: "user" });

      expect(mockFormatOutput).toHaveBeenCalledWith("json", {
        command: "reconcile",
        error: {
          message: "read-failed: unable to read metadata",
          exitCode: 1,
        },
      });
      expect(process.exitCode).toBe(1);
    },
  );

  it("passes non-machine execution without yes to the action seam for non-TTY rejection", async () => {
    const { command, executeReconciliation } = createHarness("text");
    executeReconciliation.mockRejectedValue(
      new Error("Non-interactive or machine-output reconciliation execution requires --yes."),
    );

    await command.parseAsync(["apply", SOURCE_ROOT, "--file-wins", "--execute"], {
      from: "user",
    });

    expect(executeReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        execute: true,
        yes: false,
        machineOutput: false,
      }),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Non-interactive or machine-output reconciliation execution requires --yes.",
      ),
    );
    expect(mockFormatOutput).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
