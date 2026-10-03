/**
 * Tests for the `rfmedia lidarr audit` command layer (issue #211).
 *
 * Scope is the operator/CI contract that lives nowhere else: the exit-code
 * matrix around `--fail-on`, the machine envelope and stdout purity, the CSV
 * row/column schema, all three pre-flight rejections, `--check` accumulation,
 * the human render branches, and credential redaction on the failure path.
 * Report semantics belong to `src/lib/lidarr/audit.test.ts`; gather cost belongs
 * to `src/actions/lidarr/audit.test.ts`.
 *
 * The `rootCommand` harness is mandatory, not decorative: `resolveFormat()`
 * reads `lidarrCommand.parent?.opts()`, so a standalone parse of the leaf
 * silently degrades every machine assertion to `"text"`.
 *
 * Every report fixture is REAL engine output: `createReportFixture` runs
 * `runLidarrAudit` over a gather bundle instead of hand-assembling a report.
 * A hand-built report can encode a shape the engine cannot emit — a full
 * `checks` array with `checksSkipped: 0` is impossible while `plex-alignment`
 * stays reserved — and the render assertions would then pin output no real run
 * ever produces.
 *
 * IMPORTANT: uses vi.clearAllMocks() in beforeEach(), NOT vi.resetAllMocks() —
 * the latter nulls the vi.hoisted() implementations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { formatMachineOutput } from "@rfmedia/common";

import {
  availableSlot,
  createLidarrAuditGatheredDataFixture,
  createLidarrHealthReportFixture,
  unavailableSlot,
} from "../actions/test-helpers/lidarr-audit-fixtures.js";
import {
  createLidarrArtistFixture,
  createLidarrHealthCheckFixture,
} from "../actions/test-helpers/lidarr-fixtures.js";
import { runLidarrAudit } from "../lib/lidarr/audit.js";
import { LIDARR_AUDIT_CHECK_IDS } from "../types/lidarr-audit.js";
import type { LidarrExecutionSuccessMetadata } from "../lib/lidarr/scheduler.js";
import type {
  LidarrAuditCheckId,
  LidarrAuditFinding,
  LidarrAuditFindingCode,
  LidarrAuditGatheredData,
  LidarrAuditReport,
} from "../types/lidarr-audit.js";
import type { LidarrAuditActionResult } from "../actions/lidarr/index.js";

// Mock action handlers with vi.hoisted() - must be defined before vi.mock() calls
const mockActions = vi.hoisted(() => ({
  executeLidarrAudit: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logSuccess: vi.fn(),
  outputJson: vi.fn(),
}));

const mockFormatters = vi.hoisted(() => ({
  formatOutput: vi.fn().mockResolvedValue(undefined),
}));

const mockPrompt = vi.hoisted(() => ({
  confirm: vi.fn(),
  isInteractive: vi.fn(),
}));

const mockPlanEngine = vi.hoisted(() => ({
  readLidarrPlanArtifact: vi.fn(),
}));

// Apply mocks BEFORE importing the module under test. All five modules that
// commands/lidarr.test.ts mocks are mocked here too: importing `lidarrCommand`
// pulls the whole leaf graph, and an unmocked one reaches real I/O.
vi.mock("../actions/lidarr/index.js", () => mockActions);
vi.mock("../lib/logger.js", () => mockLogger);
vi.mock("../lib/formatters/index.js", () => mockFormatters);
vi.mock("../lib/prompt.js", () => mockPrompt);
vi.mock("../lib/lidarr/plan-engine.js", () => mockPlanEngine);

// Import after mocks
import { lidarrCommand } from "./lidarr.js";
import { LIDARR_AUDIT_CSV_COLUMNS } from "./lidarr-audit.js";

/** Execution-lane metadata for the single scheduled gather. */
const EXECUTION: LidarrExecutionSuccessMetadata = {
  taskId: "lidarr-audit",
  operation: "lidarr audit",
  lane: "local-only",
  outcome: "succeeded",
  attempts: 1,
};

/**
 * Runs the real audit engine over the healthy default gather bundle.
 *
 * Defaults mirror a full `--deep` run: every registered check selected, every
 * slot available, so the only skip is the reserved `plex-alignment` check.
 * Narrow `selected` to exercise `not-selected` skips, and override `gathered`
 * to make real evaluators emit real findings.
 *
 * @param options - Gather overrides, selection, and depth.
 * @returns The engine's own report.
 */
function createReportFixture(
  options: {
    readonly gathered?: Partial<LidarrAuditGatheredData>;
    readonly selected?: readonly LidarrAuditCheckId[];
    readonly deep?: boolean;
  } = {},
): LidarrAuditReport {
  return runLidarrAudit({
    checkedAt: "2026-07-25T00:00:00.000Z",
    origin: "http://localhost:8686",
    deep: options.deep ?? true,
    selected: new Set(options.selected ?? LIDARR_AUDIT_CHECK_IDS),
    gathered: createLidarrAuditGatheredDataFixture(options.gathered),
  });
}

/** Gather override whose `metadata-dependency` evaluator emits a real critical. */
const UNREACHABLE_HEALTH: Partial<LidarrAuditGatheredData> = {
  health: availableSlot(createLidarrHealthReportFixture({ status: "unreachable" })),
};

/**
 * Gather override whose `operation-safety` evaluator emits a real warning: the
 * default artist fixture carries no root folder path.
 */
const UNROOTED_ARTIST: Partial<LidarrAuditGatheredData> = {
  artists: availableSlot([createLidarrArtistFixture()]),
};

/** Gather override that degrades the report: the tracking-database read failed. */
const QUEUE_UNAVAILABLE: Partial<LidarrAuditGatheredData> = {
  queue: unavailableSlot("data-unavailable", "tracking database is locked"),
};

/**
 * Reads one finding out of a report by code, failing loudly when it is absent.
 *
 * @param report - The report to search.
 * @param code - The finding code the fixture is expected to have produced.
 * @returns The single matching finding.
 */
function findingByCode(
  report: LidarrAuditReport,
  code: LidarrAuditFindingCode,
): LidarrAuditFinding {
  const found = report.findings.find((finding) => finding.code === code);
  if (found === undefined) {
    throw new Error(`report carries no ${code} finding`);
  }
  return found;
}

/**
 * Wraps a report in the action result envelope.
 *
 * @param report - The report the mocked action should resolve with.
 * @returns The action result.
 */
function createActionResult(report: LidarrAuditReport): LidarrAuditActionResult {
  return { execution: EXECUTION, report };
}

describe("lidarr audit command", () => {
  let rootCommand: Command;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks(); // NOT resetAllMocks!

    // Re-establish default resolutions after clearAllMocks
    mockActions.executeLidarrAudit.mockResolvedValue(createActionResult(createReportFixture()));
    mockFormatters.formatOutput.mockResolvedValue(undefined);

    // Suppress human table rendering (goes to stderr via console.error)
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Guard the machine-only stdout contract (formatOutput is mocked, so
    // nothing may write to stdout directly).
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Create a root command to attach the lidarr command to (for global options)
    rootCommand = new Command("rfmedia");
    rootCommand.option("--json", "Output in JSON format");
    rootCommand.option("--output <format>", "Output format (json, yaml, csv, table, text)");
    rootCommand.option("--debug", "Enable debug output");

    // Mirror cli.ts's preAction reconciliation of --json into the resolved
    // --output format, so bare --json exercises the same parity gate.
    rootCommand.hook("preAction", () => {
      const opts = rootCommand.opts();
      if (opts["json"] && rootCommand.getOptionValueSource("output") !== "cli") {
        rootCommand.setOptionValue("output", "json");
      }
    });

    rootCommand.addCommand(lidarrCommand);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    process.exitCode = undefined;
  });

  /** Joins every stderr line captured by the console.error spy. */
  function capturedStderr(): string {
    return consoleErrorSpy.mock.calls
      .map((call: readonly unknown[]) => call.map(String).join(" "))
      .join("\n");
  }

  /** Runs `rfmedia lidarr audit …` through the root command harness. */
  async function runAudit(...args: readonly string[]): Promise<void> {
    await rootCommand.parseAsync(["node", "rfmedia", ...args], { from: "node" });
  }

  describe("exit-code gate", () => {
    it("leaves the exit code untouched for a critical finding without --fail-on", async () => {
      mockActions.executeLidarrAudit.mockResolvedValue(
        createActionResult(createReportFixture({ gathered: UNREACHABLE_HEALTH })),
      );

      await runAudit("lidarr", "audit");

      // audit is diagnostic by default: findings are a report, not a gate.
      expect(process.exitCode).toBeUndefined();
    });

    it("sets exit 1 when a critical finding reaches a --fail-on warning gate", async () => {
      mockActions.executeLidarrAudit.mockResolvedValue(
        createActionResult(createReportFixture({ gathered: UNREACHABLE_HEALTH })),
      );

      await runAudit("lidarr", "audit", "--fail-on", "warning");

      expect(process.exitCode).toBe(1);
    });

    it("leaves the exit code untouched when findings stay below the gate", async () => {
      mockActions.executeLidarrAudit.mockResolvedValue(
        createActionResult(createReportFixture({ gathered: UNROOTED_ARTIST })),
      );

      await runAudit("lidarr", "audit", "--fail-on", "critical");

      expect(process.exitCode).toBeUndefined();
    });

    it("sets exit 1 for a degraded report even at --fail-on critical", async () => {
      mockActions.executeLidarrAudit.mockResolvedValue(
        createActionResult(
          createReportFixture({
            gathered: { ...UNROOTED_ARTIST, ...QUEUE_UNAVAILABLE },
          }),
        ),
      );

      await runAudit("lidarr", "audit", "--fail-on", "critical");

      // An incomplete report must never read green in CI, regardless of the
      // highest severity the selected checks could reach.
      expect(process.exitCode).toBe(1);
    });

    it("never sets an exit code at --fail-on none", async () => {
      mockActions.executeLidarrAudit.mockResolvedValue(
        createActionResult(
          createReportFixture({
            gathered: { ...UNREACHABLE_HEALTH, ...QUEUE_UNAVAILABLE },
          }),
        ),
      );

      await runAudit("lidarr", "audit", "--fail-on", "none");

      expect(process.exitCode).toBeUndefined();
    });

    it("renders the gate verdict to stderr only, after the report", async () => {
      mockActions.executeLidarrAudit.mockResolvedValue(
        createActionResult(createReportFixture({ gathered: UNREACHABLE_HEALTH })),
      );

      await runAudit("lidarr", "audit", "--fail-on", "warning");

      const stderr = capturedStderr();
      expect(stderr).toContain("Lidarr Library Audit");
      expect(stderr).toContain("Audit gate:");
      expect(stderr).toContain("--fail-on warning; highest severity critical");
      expect(stderr.indexOf("Lidarr Library Audit")).toBeLessThan(stderr.indexOf("Audit gate:"));
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it("omits the gate line entirely when --fail-on is not set", async () => {
      await runAudit("lidarr", "audit");

      expect(capturedStderr()).not.toContain("Audit gate:");
    });
  });

  describe("machine output", () => {
    it("emits the lidarr-audit envelope for json with a clean stdout", async () => {
      const result = createActionResult(createReportFixture({ gathered: UNROOTED_ARTIST }));
      mockActions.executeLidarrAudit.mockResolvedValue(result);

      await runAudit("--output", "json", "lidarr", "audit");

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "lidarr-audit",
        result,
      });
      expect(mockFormatters.formatOutput.mock.calls.at(-1)).toHaveLength(2);
      expect(consoleLogSpy).not.toHaveBeenCalled();
      expect(capturedStderr()).toBe("");
    });

    it("reconciles bare --json into the same envelope", async () => {
      const result = createActionResult(createReportFixture());
      mockActions.executeLidarrAudit.mockResolvedValue(result);

      await runAudit("--json", "lidarr", "audit");

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith("json", {
        command: "lidarr-audit",
        result,
      });
    });

    it("emits a summary-then-check-then-finding CSV projection with the pinned columns", async () => {
      const report = createReportFixture({
        gathered: { ...UNREACHABLE_HEALTH, ...UNROOTED_ARTIST, ...QUEUE_UNAVAILABLE },
      });
      const critical = findingByCode(report, "lidarr-unreachable");
      mockActions.executeLidarrAudit.mockResolvedValue(createActionResult(report));

      await runAudit("--output", "csv", "lidarr", "audit");

      const csvCall = mockFormatters.formatOutput.mock.calls.at(-1);
      expect(csvCall).toHaveLength(3);
      expect(csvCall?.[0]).toBe("csv");
      expect(csvCall?.[2]).toEqual({ columns: [...LIDARR_AUDIT_CSV_COLUMNS] });

      const rows = csvCall?.[1] as readonly Record<string, unknown>[];
      expect(rows.map((row) => row["rowType"])).toEqual([
        "summary",
        ...LIDARR_AUDIT_CHECK_IDS.map(() => "check"),
        "finding",
        "finding",
      ]);
      expect(rows[0]).toEqual(
        expect.objectContaining({
          command: "lidarr-audit",
          rowType: "summary",
          "report.status": "degraded",
          "report.origin": "http://localhost:8686",
          "summary.total": 2,
          "summary.checksSkipped": 2,
          "summary.highestSeverity": "critical",
          "coverage.wantedTotal": 0,
          "execution.lane": "local-only",
        }),
      );
      expect(rows[1]).toEqual(
        expect.objectContaining({
          rowType: "check",
          "check.id": "metadata-dependency",
          "check.status": "findings",
        }),
      );
      expect(rows.find((row) => row["check.id"] === "retry-backlog")).toEqual(
        expect.objectContaining({
          "check.status": "skipped",
          "check.skipReason": "data-unavailable",
          "check.detail": "tracking database is locked",
        }),
      );
      const findingRow = rows.at(-2);
      expect(findingRow).toEqual(
        expect.objectContaining({
          rowType: "finding",
          "finding.checkId": "metadata-dependency",
          "finding.code": "lidarr-unreachable",
          "finding.severity": "critical",
          "finding.affected": 1,
          "finding.subjects": JSON.stringify(critical.subjects),
          "finding.evidence": JSON.stringify(critical.evidence),
          "finding.remediationCommand": "rfmedia lidarr health",
        }),
      );
    });

    it("hands the shared CSV serializer a projection it can render", async () => {
      mockActions.executeLidarrAudit.mockResolvedValue(
        createActionResult(
          createReportFixture({
            gathered: { ...UNREACHABLE_HEALTH, ...QUEUE_UNAVAILABLE },
          }),
        ),
      );

      await runAudit("--output", "csv", "lidarr", "audit");

      const rows = mockFormatters.formatOutput.mock.calls.at(-1)?.[1];
      await expect(
        formatMachineOutput("csv", rows, { columns: [...LIDARR_AUDIT_CSV_COLUMNS] }),
      ).resolves.toBeUndefined();
    });
  });

  describe("option forwarding", () => {
    it("forwards depth, scoping, and both credential pairs to the action", async () => {
      await runAudit(
        "lidarr",
        "audit",
        "--deep",
        "--artist-ids",
        "8,3",
        "--lidarr-url",
        "http://localhost:8686",
        "--lidarr-api-key",
        "secret-api-key",
        "--plex-url",
        "http://localhost:32400",
        "--plex-token",
        "plex-secret-token",
      );

      expect(mockActions.executeLidarrAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          deep: true,
          artistIds: [8, 3],
          lidarrUrl: "http://localhost:8686",
          lidarrApiKey: "secret-api-key",
          plexUrl: "http://localhost:32400",
          plexToken: "plex-secret-token",
        }),
      );
    });

    it("selects every registered check when --check is omitted", async () => {
      await runAudit("lidarr", "audit");

      expect(mockActions.executeLidarrAudit).toHaveBeenCalledWith(
        expect.objectContaining({ check: undefined }),
      );
    });

    it("accumulates repeated and comma-separated --check into one selection", async () => {
      await runAudit(
        "lidarr",
        "audit",
        "--check",
        "metadata-dependency",
        "--check",
        "retry-backlog",
      );
      const repeated = mockActions.executeLidarrAudit.mock.calls.at(-1)?.[0] as {
        check?: readonly string[];
      };

      await runAudit("lidarr", "audit", "--check", "metadata-dependency,retry-backlog");
      const commaSeparated = mockActions.executeLidarrAudit.mock.calls.at(-1)?.[0] as {
        check?: readonly string[];
      };

      expect(repeated.check).toEqual(["metadata-dependency", "retry-backlog"]);
      expect(commaSeparated.check).toEqual(repeated.check);
    });

    it("tolerates blank entries in a comma-separated --check list", async () => {
      await runAudit("lidarr", "audit", "--check", "retry-backlog, ,library-gaps");

      expect(mockActions.executeLidarrAudit).toHaveBeenCalledWith(
        expect.objectContaining({ check: ["retry-backlog", "library-gaps"] }),
      );
    });
  });

  describe("pre-flight validation", () => {
    it("rejects an unknown --check id through the failure envelope", async () => {
      await runAudit("--output", "json", "lidarr", "audit", "--check", "bogus-check");

      expect(mockActions.executeLidarrAudit).not.toHaveBeenCalled();
      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          command: "lidarr-audit",
          error: expect.objectContaining({
            message: "Unknown audit check: 'bogus-check'",
            outcome: "failed",
          }),
        }),
      );
      expect(process.exitCode).toBe(1);
    });

    it("rejects a valid id mixed with an unknown one", async () => {
      await runAudit("--output", "json", "lidarr", "audit", "--check", "retry-backlog,typo");

      expect(mockActions.executeLidarrAudit).not.toHaveBeenCalled();
      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          error: expect.objectContaining({ message: "Unknown audit check: 'typo'" }),
        }),
      );
      expect(process.exitCode).toBe(1);
    });

    it.each([
      ["an empty value", ""],
      ["a lone comma", ","],
      ["whitespace only", " "],
    ])("rejects --check with %s instead of auditing nothing", async (_label, value) => {
      await runAudit(
        "--output",
        "json",
        "lidarr",
        "audit",
        "--check",
        value,
        "--fail-on",
        "critical",
      );

      // Blank values parse to zero ids, and the engine takes an empty selection
      // literally — `rfmedia lidarr audit --check "$UNSET_VAR" --fail-on critical`
      // must fail loudly rather than exit 0 having evaluated no check at all.
      expect(mockActions.executeLidarrAudit).not.toHaveBeenCalled();
      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          command: "lidarr-audit",
          error: expect.objectContaining({
            message: "lidarr audit: --check requires at least one audit check id",
            outcome: "failed",
          }),
        }),
      );
      expect(process.exitCode).toBe(1);
    });

    it("rejects --artist-ids without --deep through the failure envelope", async () => {
      await runAudit("--output", "json", "lidarr", "audit", "--artist-ids", "8,3");

      expect(mockActions.executeLidarrAudit).not.toHaveBeenCalled();
      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          command: "lidarr-audit",
          error: expect.objectContaining({
            message: "lidarr audit: --artist-ids requires --deep",
            outcome: "failed",
          }),
        }),
      );
      expect(process.exitCode).toBe(1);
    });

    it("accepts --artist-ids once --deep is present", async () => {
      await runAudit("lidarr", "audit", "--deep", "--artist-ids", "8");

      expect(mockActions.executeLidarrAudit).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("human output", () => {
    it("lists every registered check once whenever the report is not quiet-clean", async () => {
      mockActions.executeLidarrAudit.mockResolvedValue(
        createActionResult(createReportFixture({ gathered: UNROOTED_ARTIST })),
      );

      await runAudit("lidarr", "audit");

      const stderr = capturedStderr();
      for (const id of LIDARR_AUDIT_CHECK_IDS) {
        expect(stderr).toContain(id);
      }
      // The reserved check is skipped on every real run, so its note must be
      // visible rather than silently absent.
      expect(stderr).toContain("identity-mapping-unavailable");
    });

    it("stays quiet when a clean run's only skip is the reserved check", async () => {
      mockActions.executeLidarrAudit.mockResolvedValue(createActionResult(createReportFixture()));

      await runAudit("lidarr", "audit");

      const stderr = capturedStderr();
      expect(stderr).toContain(`No findings across ${LIDARR_AUDIT_CHECK_IDS.length - 1} check(s).`);
      expect(stderr).not.toContain("metadata-dependency");
    });

    it("stays quiet when the remaining skips are the operator's own --check narrowing", async () => {
      mockActions.executeLidarrAudit.mockResolvedValue(
        createActionResult(createReportFixture({ selected: ["retry-backlog"] })),
      );

      await runAudit("lidarr", "audit", "--check", "retry-backlog");

      const stderr = capturedStderr();
      expect(stderr).toContain("No findings across 1 check(s).");
      expect(stderr).not.toContain("not-selected");
    });

    it("renders the check table and the --deep hint when coverage is reduced", async () => {
      mockActions.executeLidarrAudit.mockResolvedValue(
        createActionResult(
          createReportFixture({
            deep: false,
            gathered: {
              albums: unavailableSlot("requires-deep", "album scan runs only under --deep"),
            },
          }),
        ),
      );

      await runAudit("lidarr", "audit");

      const stderr = capturedStderr();
      expect(stderr).not.toContain("No findings across");
      expect(stderr).toContain("monitoring-drift");
      expect(stderr).toContain("requires-deep");
      expect(stderr).toContain("Run with --deep for album-level checks.");
    });

    it("keeps distinct follow-up advice that shares one remediation command", async () => {
      const report = createReportFixture({
        gathered: {
          health: availableSlot(
            createLidarrHealthReportFixture({
              errors: [
                createLidarrHealthCheckFixture({
                  source: "RootFolderCheck",
                  type: "error",
                  message: "Root folder /music is missing",
                }),
              ],
              warnings: [
                createLidarrHealthCheckFixture({
                  source: "IndexerStatusCheck",
                  type: "warning",
                  message: "One or more indexers are unavailable.",
                }),
              ],
            }),
          ),
        },
      });
      const [first, second] = report.findings;
      expect(report.findings).toHaveLength(2);
      expect(first?.remediation.command).toBe("rfmedia lidarr health --type error --type warning");
      expect(second?.remediation.command).toBe(first?.remediation.command);
      mockActions.executeLidarrAudit.mockResolvedValue(createActionResult(report));

      await runAudit("lidarr", "audit");

      // Both findings carry the same read command, so a command-keyed dedupe
      // would print only the first one's prose.
      const stderr = capturedStderr();
      expect(stderr).toContain("Root folder /music is missing");
      expect(stderr).toContain("One or more indexers are unavailable.");
    });
  });

  describe("failure path", () => {
    it("redacts the API key and the Plex token from the failure envelope", async () => {
      mockActions.executeLidarrAudit.mockRejectedValue(
        Object.assign(new Error("authentication failed for secret-api-key and plex-secret-token"), {
          code: "authentication",
          statusCode: 401,
          retryable: false,
        }),
      );

      await runAudit(
        "--json",
        "lidarr",
        "audit",
        "--lidarr-api-key",
        "secret-api-key",
        "--plex-token",
        "plex-secret-token",
      );

      expect(mockFormatters.formatOutput).toHaveBeenCalledWith(
        "json",
        expect.objectContaining({
          command: "lidarr-audit",
          error: expect.objectContaining({
            message: "authentication failed for [REDACTED] and [REDACTED]",
            code: "authentication",
            outcome: "failed",
          }),
        }),
      );
      const serialized = JSON.stringify(mockFormatters.formatOutput.mock.calls);
      expect(serialized).not.toContain("secret-api-key");
      expect(serialized).not.toContain("plex-secret-token");
      expect(process.exitCode).toBe(1);
    });

    it("never offers the --allow-stale hint, which audit does not implement", async () => {
      mockActions.executeLidarrAudit.mockRejectedValue(
        Object.assign(new Error("Lidarr is unreachable"), { code: "lidarr-unreachable" }),
      );

      await runAudit("lidarr", "audit");

      expect(mockLogger.logError).toHaveBeenCalledWith(
        "Lidarr audit failed: Lidarr is unreachable",
      );
      expect(mockLogger.logError).not.toHaveBeenCalledWith(
        expect.stringContaining("--allow-stale"),
      );
      expect(process.exitCode).toBe(1);
    });
  });
});
