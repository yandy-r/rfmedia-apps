import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutputFormat } from "@rfmedia/common";

import type { LidarrReconcileActionResult } from "../actions/lidarr/index.js";
import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import type {
  PlexLidarrReconciliationResultV1,
  ReconciliationAuthoritativeItem,
  ReconciliationNormalizedNameReviewItem,
  ReconciliationTargetUnmatchedItem,
} from "../types/bridge.js";

const mockFormatOutput = vi.hoisted(() => vi.fn());

vi.mock("../lib/formatters/index.js", () => ({
  formatOutput: mockFormatOutput,
}));

import { LIDARR_RECONCILE_CSV_COLUMNS, createLidarrReconcileCommand } from "./lidarr-reconcile.js";

const EXECUTION: LidarrExecutionSuccessMetadata = Object.freeze({
  taskId: "lidarr-reconcile",
  operation: "lidarr reconcile",
  lane: "local-only",
  outcome: "succeeded",
  attempts: 1,
});

const EXACT: ReconciliationAuthoritativeItem = Object.freeze({
  category: "authoritative",
  reason: "unique-exact-mbid",
  method: "exact-mbid",
  source: Object.freeze({
    plexId: "plex-1",
    title: "Exact Artist",
    artistMbid: "11111111-1111-4111-8111-111111111111",
  }),
  target: Object.freeze({
    lidarrId: 1,
    title: "Exact Artist",
    artistMbid: "11111111-1111-4111-8111-111111111111",
  }),
  score: null,
  runnerUpMargin: null,
  candidates: [] as const,
});

const REVIEW: ReconciliationNormalizedNameReviewItem = Object.freeze({
  category: "review-normalized-name",
  reason: "unique-normalized-name",
  method: "normalized-name",
  source: Object.freeze({
    plexId: "plex-2",
    title: "Review Artist",
    artistMbid: null,
  }),
  target: Object.freeze({
    lidarrId: 2,
    title: "Review Artist",
    artistMbid: null,
  }),
  score: 1,
  runnerUpMargin: 1,
  candidates: Object.freeze([
    Object.freeze({
      rank: 1,
      target: Object.freeze({
        lidarrId: 2,
        title: "Review Artist",
        artistMbid: null,
      }),
      method: "normalized-name",
      score: 1,
    }),
  ]),
});

const LIDARR_ONLY: ReconciliationTargetUnmatchedItem = Object.freeze({
  category: "unmatched",
  reason: "no-authoritative-source-match",
  method: "none",
  source: null,
  target: Object.freeze({
    lidarrId: 3,
    title: "Lidarr Only",
    artistMbid: null,
  }),
  score: null,
  runnerUpMargin: null,
  candidates: [] as const,
});

function createReport(
  overrides: Partial<PlexLidarrReconciliationResultV1> = {},
): PlexLidarrReconciliationResultV1 {
  return {
    schema: "rfmedia.plex-lidarr-reconciliation.v1",
    scope: {
      plexOrigin: "http://localhost:32400",
      plexInstanceId: "plex-instance",
      plexLibraryId: "7",
      lidarrOrigin: "http://localhost:8686",
      entityKind: "artist",
    },
    provenance: {
      source: "live",
      mode: "online",
      freshness: "fresh",
    },
    capturedAt: "2026-07-28T00:00:00.000Z",
    verifiedAt: "2026-07-28T00:00:00.000Z",
    completeness: {
      sourceComplete: true,
      targetComplete: true,
      resolutionsComplete: true,
      complete: true,
      sourceArtistCount: 2,
      targetArtistCount: 3,
      resolutionCount: 2,
    },
    summary: {
      sourceArtistCount: 2,
      targetArtistCount: 3,
      primaryOutcomeCount: 2,
      matchedExactCount: 1,
      reviewSuggestedCount: 1,
      reviewAmbiguousCount: 0,
      plexOnlyCount: 1,
      lidarrOnlyCount: 1,
      conflictCount: 0,
      unavailableCount: 0,
      duplicatesIncluded: true,
      duplicateFindingCount: 1,
      suggestionCount: 1,
    },
    matchedExact: [EXACT],
    reviewSuggested: [REVIEW],
    reviewAmbiguous: [],
    plexOnly: [REVIEW],
    lidarrOnly: [LIDARR_ONLY],
    conflicts: [],
    unavailable: [],
    duplicates: [
      {
        code: "source-normalized-name-collision",
        artistMbid: null,
        normalizedTitle: "review artist",
        members: [
          {
            side: "plex",
            plexId: "plex-2",
            title: "Review Artist",
            artistMbid: null,
          },
        ],
      },
    ],
    suggestions: [
      {
        code: "inspect-target",
        source: REVIEW.source,
        target: REVIEW.target,
        argv: ["rfmedia", "lidarr", "lookup", "artist", "Review Artist"],
      },
    ],
    ...overrides,
  };
}

function createResult(
  report: PlexLidarrReconciliationResultV1 = createReport(),
): LidarrReconcileActionResult {
  return { report, execution: EXECUTION };
}

function redact(message: string, sensitiveValues: readonly unknown[] | undefined): string {
  let output = message;
  for (const value of sensitiveValues ?? []) {
    if (typeof value === "string" && value.length > 0) {
      output = output.split(value).join("[REDACTED]");
    }
  }
  return output;
}

function createHarness(
  format: OutputFormat = "text",
  result: LidarrReconcileActionResult = createResult(),
) {
  const executeLidarrReconcile = vi.fn().mockResolvedValue(result);
  const loadActions = vi.fn().mockResolvedValue({ executeLidarrReconcile });
  const renderExecutionSummary = vi.fn();
  const reportLidarrFailure = vi.fn(
    async (
      subcommand: string,
      error: unknown,
      options: {
        readonly format: OutputFormat;
        readonly sensitiveValues?: readonly unknown[];
      },
    ) => {
      const raw = error instanceof Error ? error.message : String(error);
      await mockFormatOutput(options.format, {
        command: `lidarr-${subcommand}`,
        error: {
          message: redact(raw, options.sensitiveValues),
          outcome: "failed",
        },
      });
      process.exitCode = 1;
    },
  );
  const command = createLidarrReconcileCommand({
    resolveFormat: () => format,
    reportLidarrFailure,
    renderExecutionSummary,
    loadActions,
  });
  return {
    command,
    executeLidarrReconcile,
    loadActions,
    renderExecutionSummary,
    reportLidarrFailure,
  };
}

describe("lidarr reconcile command", () => {
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

  it("shows exactly the report-first leaf flags without loading actions", () => {
    const { command, loadActions } = createHarness();

    const help = command.helpInformation();

    for (const option of [
      "--plex-library <name>",
      "--plex-library-id <id>",
      "--offline",
      "--duplicates",
      "--plex-url <url>",
      "--plex-token <token>",
      "--lidarr-url <url>",
      "--lidarr-api-key <key>",
      "-v, --verbose",
    ]) {
      expect(help).toContain(option);
    }
    for (const forbidden of ["--apply", "--repair", "--yes", "--allow-stale", "--fail-on"]) {
      expect(help).not.toContain(forbidden);
    }
    expect(loadActions).not.toHaveBeenCalled();
  });

  it.each([
    ["offline Plex library name", ["--offline", "--plex-library", "Music"]],
    ["offline Plex token", ["--offline", "--plex-token", "plex-secret"]],
    ["offline Lidarr API key", ["--offline", "--lidarr-api-key", "lidarr-secret"]],
    ["live cached library ID", ["--plex-library-id", "7"]],
    ["live run without library", []],
  ])("rejects %s before loading the action", async (_label, args) => {
    const { command, loadActions, reportLidarrFailure } = createHarness("json");

    await command.parseAsync(args, { from: "user" });

    expect(loadActions).not.toHaveBeenCalled();
    expect(reportLidarrFailure).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  });

  it("forwards the complete live option contract exactly", async () => {
    const { command, executeLidarrReconcile } = createHarness();

    await command.parseAsync(
      [
        "--plex-library",
        "Music",
        "--duplicates",
        "--plex-url",
        "https://plex.example.test",
        "--plex-token",
        "plex-secret",
        "--lidarr-url",
        "https://lidarr.example.test",
        "--lidarr-api-key",
        "lidarr-secret",
        "--verbose",
      ],
      { from: "user" },
    );

    expect(executeLidarrReconcile).toHaveBeenCalledWith({
      plexLibrary: "Music",
      plexLibraryId: undefined,
      offline: false,
      duplicates: true,
      plexUrl: "https://plex.example.test",
      plexToken: "plex-secret",
      lidarrUrl: "https://lidarr.example.test",
      lidarrApiKey: "lidarr-secret",
    });
  });

  it("forwards the credential-free offline scope selectors", async () => {
    const { command, executeLidarrReconcile } = createHarness();

    await command.parseAsync(
      [
        "--offline",
        "--plex-library-id",
        "7",
        "--plex-url",
        "https://plex.example.test",
        "--lidarr-url",
        "https://lidarr.example.test",
      ],
      { from: "user" },
    );

    expect(executeLidarrReconcile).toHaveBeenCalledWith({
      plexLibrary: undefined,
      plexLibraryId: "7",
      offline: true,
      duplicates: false,
      plexUrl: "https://plex.example.test",
      plexToken: undefined,
      lidarrUrl: "https://lidarr.example.test",
      lidarrApiKey: undefined,
    });
  });

  it.each(["json", "yaml"] as const)(
    "emits one prose-free %s envelope with schema directly under result",
    async (format) => {
      const actionResult = createResult();
      const { command } = createHarness(format, actionResult);

      await command.parseAsync(["--plex-library", "Music"], { from: "user" });

      expect(mockFormatOutput).toHaveBeenCalledOnce();
      const call = mockFormatOutput.mock.calls[0];
      expect(call).toHaveLength(2);
      expect(call?.[0]).toBe(format);
      expect(call?.[1]).toEqual({
        command: "lidarr-reconcile",
        result: {
          ...actionResult.report,
          execution: EXECUTION,
        },
      });
      expect(call?.[1]).not.toHaveProperty("result.report");
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    },
  );

  it("emits fixed CSV columns in summary, item, duplicate, suggestion order", async () => {
    const { command } = createHarness("csv");

    await command.parseAsync(["--plex-library", "Music"], { from: "user" });

    const call = mockFormatOutput.mock.calls[0];
    expect(call).toHaveLength(3);
    expect(call?.[0]).toBe("csv");
    expect(call?.[2]).toEqual({ columns: [...LIDARR_RECONCILE_CSV_COLUMNS] });
    const rows = call?.[1] as readonly Record<string, unknown>[];
    expect(rows.map((row) => row["rowType"])).toEqual([
      "summary",
      "item",
      "item",
      "item",
      "duplicate",
      "suggestion",
    ]);
    expect(rows.slice(1, 4).map((row) => row["item.category"])).toEqual([
      "authoritative",
      "review-normalized-name",
      "unmatched",
    ]);
    expect(rows[0]).toMatchObject({
      command: "lidarr-reconcile",
      schema: "rfmedia.plex-lidarr-reconciliation.v1",
      "scope.plexLibraryId": "7",
      "summary.plexOnlyCount": 1,
      "execution.lane": "local-only",
    });
    expect(rows[4]).toMatchObject({
      "duplicate.code": "source-normalized-name-collision",
    });
    expect(rows[5]).toMatchObject({
      "suggestion.code": "inspect-target",
      "suggestion.argv": JSON.stringify(["rfmedia", "lidarr", "lookup", "artist", "Review Artist"]),
    });
  });

  it("keeps findings successful and renders human output only on stderr", async () => {
    const { command, renderExecutionSummary } = createHarness();

    await command.parseAsync(["--plex-library", "Music", "--duplicates"], { from: "user" });

    const stderr = consoleErrorSpy.mock.calls.flat().map(String).join("\n");
    expect(stderr).toContain("Plex-Lidarr Reconciliation");
    expect(stderr).toContain(
      "review suggestions remain in both directional gaps until an authoritative exact match exists",
    );
    expect(stderr).toContain("Duplicate identity findings (1)");
    expect(renderExecutionSummary).toHaveBeenCalledWith(EXECUTION);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("bounds human details by default and --verbose removes only that truncation", async () => {
    const manyLidarrOnly = Array.from({ length: 21 }, (_, index) => ({
      ...LIDARR_ONLY,
      target: { ...LIDARR_ONLY.target, lidarrId: index + 10, title: `Artist ${index + 1}` },
    })) as ReconciliationTargetUnmatchedItem[];
    const report = createReport({
      lidarrOnly: manyLidarrOnly,
      summary: { ...createReport().summary, lidarrOnlyCount: manyLidarrOnly.length },
    });

    await createHarness("text", createResult(report)).command.parseAsync(
      ["--plex-library", "Music"],
      { from: "user" },
    );
    expect(consoleErrorSpy.mock.calls.flat().map(String).join("\n")).toContain(
      "Showing 20 of 21; use --verbose to show all.",
    );

    consoleErrorSpy.mockClear();
    await createHarness("text", createResult(report)).command.parseAsync(
      ["--plex-library", "Music", "--verbose"],
      { from: "user" },
    );
    expect(consoleErrorSpy.mock.calls.flat().map(String).join("\n")).not.toContain(
      "Showing 20 of 21",
    );
  });

  it("redacts both provider credentials and exits one on operational failure", async () => {
    const { command, executeLidarrReconcile, reportLidarrFailure } = createHarness("json");
    executeLidarrReconcile.mockRejectedValue(
      new Error("authentication failed for plex-secret and lidarr-secret"),
    );

    await command.parseAsync(
      [
        "--plex-library",
        "Music",
        "--plex-token",
        "plex-secret",
        "--lidarr-api-key",
        "lidarr-secret",
      ],
      { from: "user" },
    );

    expect(reportLidarrFailure).toHaveBeenCalledWith(
      "reconcile",
      expect.any(Error),
      expect.objectContaining({
        staleHint: false,
        sensitiveValues: ["lidarr-secret", "plex-secret"],
      }),
    );
    const serialized = JSON.stringify(mockFormatOutput.mock.calls);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("plex-secret");
    expect(serialized).not.toContain("lidarr-secret");
    expect(process.exitCode).toBe(1);
  });
});
