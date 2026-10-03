/**
 * Cost and safety contract for the `rfmedia lidarr audit` action (issue #211).
 *
 * Deliberately narrow: the verdicts themselves are exhaustively covered by
 * `src/lib/lidarr/audit.test.ts` against the pure engine. What lives ONLY here
 * is how much I/O the action performs, where it performs it, and what it
 * refuses to do — above all that `--check retry-backlog` issues zero HTTP
 * requests. Without that assertion a later edit silently turns every audit into
 * a 1 + N library walk against the `local-only` lane budget.
 *
 * The engine, the evaluators, and the identity helpers are NOT mocked, so every
 * assertion below reads the real report the action produced. Only the I/O seams
 * are replaced: the scheduler/client barrel, the health probe, the deep album
 * scan, the Plex probe, the tracking-database queue read, and config loading.
 */

import { inspect } from "node:util";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { LidarrPlanValidationError } from "../../lib/errors.js";
import { LidarrTimeoutError, LidarrValidationError } from "../../lib/lidarr/errors.js";
import { LIDARR_AUDIT_UNREACHABLE_DETAIL } from "../../types/lidarr-audit.js";
import {
  createLidarrAuditPlexProbeFixture,
  createLidarrAuditQueueStateFixture,
  createLidarrHealthReportFixture,
} from "../test-helpers/lidarr-audit-fixtures.js";
import {
  createLidarrClientMock,
  type LidarrClientMock,
} from "../test-helpers/lidarr-client-mocks.js";
import type {
  LidarrAuditCheckId,
  LidarrAuditCheckResult,
  LidarrAuditReport,
} from "../../types/lidarr-audit.js";

/** Credential-free origin the mocked resolver returns for every run. */
const ORIGIN = "http://lidarr.test:8686";

/**
 * `detail` every check gated on the `artists` slot echoes when that read — not
 * the health probe — fails at the transport level.
 */
const ARTIST_READ_FAILURE_DETAIL =
  "the Lidarr artist list could not be read: the request failed at the transport level " +
  "after Lidarr answered the health probe";

/** Execution metadata the pass-through scheduler stub stamps on the gather. */
const EXPECTED_EXECUTION = {
  taskId: "lidarr-audit",
  operation: "lidarr audit",
  lane: "local-only",
  outcome: "succeeded",
  attempts: 1,
} as const;

const mockResolveRequiredLidarrClient = vi.hoisted(() => vi.fn());
const mockResolveRequiredLidarrOrigin = vi.hoisted(() => vi.fn());
const mockRunSingle = vi.hoisted(() =>
  vi.fn(
    async (_tier: unknown, task: { id: string; run: () => Promise<unknown> }) =>
      ({
        value: await task.run(),
        execution: {
          taskId: task.id,
          operation: "lidarr audit",
          lane: "local-only",
          outcome: "succeeded",
          attempts: 1,
        },
      }) as const,
  ),
);
const mockHealthLib = vi.hoisted(() => ({
  runHealthProbe: vi.fn(),
  // Reused verbatim by the real `operation-safety` evaluator. Its matching is
  // asserted in `src/lib/lidarr/health.test.ts`; here it only has to exist.
  detectMetadataProviderOutage: vi.fn(() => []),
}));
const mockAlbumScan = vi.hoisted(() => ({ scanSelectedArtists: vi.fn() }));
const mockPlexProbe = vi.hoisted(() => ({ probeLidarrAuditPlex: vi.fn() }));
const mockQueue = vi.hoisted(() => ({ collectLidarrAuditQueueState: vi.fn() }));
const mockAdapters = vi.hoisted(() => ({ resolveRequiredMediaServerAdapter: vi.fn() }));
const mockLogger = vi.hoisted(() => ({ logDebug: vi.fn(), logInfo: vi.fn() }));

vi.mock("../../lib/lidarr/index.js", () => ({
  resolveLidarrScheduler: () => ({ runSingle: mockRunSingle }),
  resolveRequiredLidarrClient: mockResolveRequiredLidarrClient,
  resolveRequiredLidarrOrigin: mockResolveRequiredLidarrOrigin,
}));
// `isTransportOutage` is deliberately NOT mocked: it is a pure predicate over
// the error taxonomy, and the degradation assertions below are only meaningful
// against the same definition of "transport failure" the probe classifies on.
vi.mock("../../lib/lidarr/health.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/lidarr/health.js")>();
  return {
    ...actual,
    runHealthProbe: mockHealthLib.runHealthProbe,
    detectMetadataProviderOutage: mockHealthLib.detectMetadataProviderOutage,
  };
});
vi.mock("../../lib/lidarr/audit-queue.js", () => ({
  collectLidarrAuditQueueState: mockQueue.collectLidarrAuditQueueState,
}));
vi.mock("./album-scan.js", () => ({ scanSelectedArtists: mockAlbumScan.scanSelectedArtists }));
vi.mock("./audit-plex.js", () => ({ probeLidarrAuditPlex: mockPlexProbe.probeLidarrAuditPlex }));
// The action must never reach the media server itself; the probe owns that
// boundary. Mocked so a future direct adapter construction is observable.
vi.mock("../../lib/adapters/action-helpers.js", () => ({
  resolveRequiredMediaServerAdapter: mockAdapters.resolveRequiredMediaServerAdapter,
}));
vi.mock("../../lib/loaded-config.js", () => ({
  getLoadedPlexConfig: vi.fn().mockReturnValue({}),
  getLoadedLidarrConfig: vi.fn().mockReturnValue({}),
}));
vi.mock("../../lib/logger.js", () => ({
  logDebug: mockLogger.logDebug,
  logInfo: mockLogger.logInfo,
}));

import { TIER, executeLidarrAudit } from "./audit.js";

/**
 * Reads one check verdict out of a report.
 *
 * @param report - The report under assertion.
 * @param id - The registered check id to read.
 * @returns That check's verdict.
 * @throws {Error} When the report omits the check, which is itself a contract
 *   violation: every registered check appears exactly once, always.
 */
function findCheck(report: LidarrAuditReport, id: LidarrAuditCheckId): LidarrAuditCheckResult {
  const check = report.checks.find((entry) => entry.id === id);
  if (check === undefined) {
    throw new Error(`report is missing the ${id} check`);
  }
  return check;
}

/**
 * Awaits a promise expected to reject and returns its rejection reason.
 *
 * @param promise - The call under test.
 * @returns The thrown value.
 * @throws {Error} When the promise resolves instead of rejecting.
 */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the audit to reject");
}

/** An empty deep scan, shaped like `scanSelectedArtists` output. */
function createEmptyScan(artistsScanned = 0) {
  return {
    albums: [],
    artistNames: new Map<number, string>(),
    artistsScanned,
    execution: { ...EXPECTED_EXECUTION, taskId: "lidarr-audit-albums-artists" },
  };
}

let clientMock: LidarrClientMock;

beforeEach(() => {
  vi.clearAllMocks();
  clientMock = createLidarrClientMock();
  mockResolveRequiredLidarrClient.mockReturnValue(clientMock);
  mockResolveRequiredLidarrOrigin.mockReturnValue(ORIGIN);
  mockHealthLib.runHealthProbe.mockResolvedValue(createLidarrHealthReportFixture());
  mockQueue.collectLidarrAuditQueueState.mockResolvedValue(createLidarrAuditQueueStateFixture());
  mockPlexProbe.probeLidarrAuditPlex.mockResolvedValue({
    status: "available",
    data: createLidarrAuditPlexProbeFixture(),
  });
  mockAlbumScan.scanSelectedArtists.mockResolvedValue(createEmptyScan());
});

describe("executeLidarrAudit", () => {
  it("declares the local-only tier", () => {
    expect(TIER).toBe("local-only");
  });

  describe("scheduling and connection contract", () => {
    it("wraps the Lidarr gather in exactly one idempotent local-only task", async () => {
      const result = await executeLidarrAudit({});

      expect(mockRunSingle).toHaveBeenCalledTimes(1);
      expect(mockRunSingle).toHaveBeenCalledWith(
        "local-only",
        expect.objectContaining({ id: "lidarr-audit", idempotent: true }),
      );
      expect(result.execution).toEqual(EXPECTED_EXECUTION);
    });

    it("forwards CLI connection overrides to the client resolver", async () => {
      await executeLidarrAudit({ lidarrUrl: "http://lidarr:8686", lidarrApiKey: "secret-api-key" });

      expect(mockResolveRequiredLidarrClient).toHaveBeenCalledWith(
        expect.objectContaining({
          lidarrUrl: "http://lidarr:8686",
          lidarrApiKey: "secret-api-key",
        }),
        expect.objectContaining({ tier: "local-only", retryAttemptsOverride: 0 }),
      );
    });

    it("resolves the origin from the same overrides and stamps it on the report", async () => {
      const result = await executeLidarrAudit({
        lidarrUrl: "http://lidarr:8686",
        lidarrApiKey: "secret-api-key",
      });

      expect(mockResolveRequiredLidarrOrigin).toHaveBeenCalledWith({
        lidarrUrl: "http://lidarr:8686",
        lidarrApiKey: "secret-api-key",
      });
      expect(result.report.origin).toBe(ORIGIN);
    });
  });

  describe("fetch-plan cost", () => {
    it("issues zero HTTP requests for --check retry-backlog", async () => {
      const result = await executeLidarrAudit({ check: ["retry-backlog"] });

      // Nothing Lidarr-backed is planned, so no client is even resolved.
      expect(mockResolveRequiredLidarrClient).not.toHaveBeenCalled();
      expect(mockHealthLib.runHealthProbe).not.toHaveBeenCalled();
      expect(clientMock.listArtists).not.toHaveBeenCalled();
      expect(clientMock.getWantedMissing).not.toHaveBeenCalled();
      expect(mockAlbumScan.scanSelectedArtists).not.toHaveBeenCalled();
      expect(mockPlexProbe.probeLidarrAuditPlex).not.toHaveBeenCalled();

      // The tracking-database read is the whole cost of this selection.
      expect(mockQueue.collectLidarrAuditQueueState).toHaveBeenCalledTimes(1);
      expect(mockQueue.collectLidarrAuditQueueState).toHaveBeenCalledWith(
        { lidarrUrl: undefined, lidarrApiKey: undefined },
        ORIGIN,
      );

      // The task still exists, so execution metadata stays deterministic.
      expect(mockRunSingle).toHaveBeenCalledTimes(1);
      expect(result.execution).toEqual(EXPECTED_EXECUTION);
      expect(findCheck(result.report, "retry-backlog")).toMatchObject({ status: "pass" });
    });

    it("performs one probe, one artist list, and one wanted sample on a default run", async () => {
      const result = await executeLidarrAudit({});

      expect(mockHealthLib.runHealthProbe).toHaveBeenCalledTimes(1);
      expect(mockHealthLib.runHealthProbe).toHaveBeenCalledWith(clientMock);
      expect(clientMock.listArtists).toHaveBeenCalledTimes(1);
      expect(clientMock.getWantedMissing).toHaveBeenCalledTimes(1);
      expect(clientMock.getWantedMissing).toHaveBeenCalledWith({ page: 1, pageSize: 1 });
      expect(mockAlbumScan.scanSelectedArtists).not.toHaveBeenCalled();
      expect(result.report.status).toBe("clean");
      expect(result.report.coverage).toEqual({
        artistsExamined: 0,
        albumsExamined: 0,
        artistsScanned: 0,
        wantedTotal: 0,
      });
    });

    it("yields a requires-deep albums slot and no scan for --check monitoring-drift", async () => {
      const result = await executeLidarrAudit({ check: ["monitoring-drift"] });

      expect(mockAlbumScan.scanSelectedArtists).not.toHaveBeenCalled();
      expect(findCheck(result.report, "monitoring-drift")).toMatchObject({
        status: "skipped",
        skipReason: "requires-deep",
      });
      // An expected absence never degrades the report.
      expect(result.report.status).toBe("clean");
      expect(clientMock.listArtists).toHaveBeenCalledTimes(1);
    });

    it("runs the deep scan outside the gather task and still lists artists itself", async () => {
      mockAlbumScan.scanSelectedArtists.mockResolvedValue(createEmptyScan(3));

      const result = await executeLidarrAudit({
        check: ["monitoring-drift"],
        deep: true,
        artistIds: [7],
      });

      expect(mockAlbumScan.scanSelectedArtists).toHaveBeenCalledWith(clientMock, [7], {
        taskIdPrefix: "lidarr-audit-albums",
        operationLabel: "lidarr audit album scan",
      });
      // The scan issues its OWN narrowed artist listing; the library-wide list
      // the audit needs is fetched separately and deliberately not shared.
      expect(clientMock.listArtists).toHaveBeenCalledTimes(1);
      expect(mockRunSingle).toHaveBeenCalledTimes(1);
      expect(result.report.deep).toBe(true);
      expect(result.report.coverage.artistsScanned).toBe(3);
      expect(findCheck(result.report, "monitoring-drift")).toMatchObject({ status: "pass" });
    });
  });

  describe("failure and degradation", () => {
    it("fails closed on an incomplete deep scan and names both escape hatches once", async () => {
      // Verbatim shape of the batch-completion failure `scanSelectedArtists`
      // raises; the action keys its hint off that prefix.
      mockAlbumScan.scanSelectedArtists.mockRejectedValue(
        new LidarrPlanValidationError(
          "album listing did not complete (3 failed, 12 skipped); no partial plan is " +
            "written — narrow with --artist-ids and retry",
        ),
      );

      const error = await captureRejection(
        executeLidarrAudit({ check: ["monitoring-drift"], deep: true }),
      );

      // A read-only command must not report itself as an invalid plan.
      expect(error).toBeInstanceOf(LidarrValidationError);
      expect(error).not.toBeInstanceOf(LidarrPlanValidationError);
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("Invalid Lidarr plan");
      expect(message).toContain("album listing did not complete (3 failed, 12 skipped)");
      expect(message).toContain("lidarr.scheduler.lanes.local-only.operationBudget");
      // Each escape hatch is offered exactly once.
      expect(message.match(/--artist-ids/gu)).toHaveLength(1);
    });

    it("rethrows an unknown-artist-ids scan failure without the budget hint", async () => {
      const failure = new LidarrPlanValidationError("Lidarr artist IDs were not found: 999999");
      mockAlbumScan.scanSelectedArtists.mockRejectedValue(failure);

      const error = await captureRejection(
        executeLidarrAudit({ check: ["monitoring-drift"], deep: true, artistIds: [999999] }),
      );

      // Narrowing --artist-ids further, or raising a budget nothing reached,
      // fixes nothing here — the scan never started a batch.
      expect(error).toBe(failure);
    });

    it("propagates a non-plan scan failure unchanged", async () => {
      const failure = new Error("scan transport failure");
      mockAlbumScan.scanSelectedArtists.mockRejectedValue(failure);

      const error = await captureRejection(
        executeLidarrAudit({ check: ["monitoring-drift"], deep: true }),
      );

      expect(error).toBe(failure);
    });

    it("keeps the health slot available and stops every Lidarr read when unreachable", async () => {
      const unreachable = createLidarrHealthReportFixture({ status: "unreachable" });
      mockHealthLib.runHealthProbe.mockResolvedValue(unreachable);

      const result = await executeLidarrAudit({ deep: true });

      // No further Lidarr reads are issued after the probe fails.
      expect(clientMock.listArtists).not.toHaveBeenCalled();
      expect(clientMock.getWantedMissing).not.toHaveBeenCalled();
      expect(mockAlbumScan.scanSelectedArtists).not.toHaveBeenCalled();

      // The health slot STAYS available: that report is the only evidence
      // explaining why the rest of the report is empty.
      expect(findCheck(result.report, "metadata-dependency")).toMatchObject({
        status: "findings",
        highestSeverity: "critical",
      });
      expect(result.report.findings.map((finding) => finding.code)).toContain("lidarr-unreachable");

      // Its dependants degrade with the shared, machine-readable detail.
      for (const id of ["operation-safety", "library-gaps", "duplicate-identity"] as const) {
        expect(findCheck(result.report, id)).toMatchObject({
          status: "skipped",
          skipReason: "data-unavailable",
          detail: LIDARR_AUDIT_UNREACHABLE_DETAIL,
        });
      }
      expect(result.report.status).toBe("degraded");
      expect(result.report.coverage).toMatchObject({ artistsExamined: 0, wantedTotal: null });

      // Non-Lidarr sources are unaffected by a Lidarr outage.
      expect(mockQueue.collectLidarrAuditQueueState).toHaveBeenCalledTimes(1);
      expect(mockPlexProbe.probeLidarrAuditPlex).toHaveBeenCalledTimes(1);
    });

    it("degrades only the affected slot when a read times out after a healthy probe", async () => {
      clientMock.listArtists.mockRejectedValue(new LidarrTimeoutError("lidarr artist list"));

      const result = await executeLidarrAudit({});

      // The failure is confined to the slot it belongs to: the wanted sample
      // still runs and every non-Lidarr source still reports.
      expect(clientMock.getWantedMissing).toHaveBeenCalledTimes(1);
      expect(findCheck(result.report, "duplicate-identity")).toMatchObject({
        status: "skipped",
        skipReason: "data-unavailable",
        // The probe answered, so the detail must not blame the probe.
        detail: ARTIST_READ_FAILURE_DETAIL,
      });
      expect(findCheck(result.report, "retry-backlog")).toMatchObject({ status: "pass" });
      expect(findCheck(result.report, "metadata-dependency")).toMatchObject({ status: "pass" });
      expect(result.report.status).toBe("degraded");
    });

    it("aborts on a non-transport read failure", async () => {
      const failure = new LidarrValidationError(
        "lidarr artist list",
        "Lidarr returned a malformed artist payload",
        "invalid-response",
      );
      clientMock.listArtists.mockRejectedValue(failure);

      const error = await captureRejection(executeLidarrAudit({}));

      expect(error).toBe(failure);
    });
  });

  describe("Plex boundary", () => {
    it("surfaces plex-not-configured without constructing an adapter", async () => {
      mockPlexProbe.probeLidarrAuditPlex.mockResolvedValue({
        status: "unavailable",
        reason: "plex-not-configured",
        detail: "Plex is not configured",
      });

      const result = await executeLidarrAudit({ check: ["plex-connectivity", "plex-alignment"] });

      expect(mockPlexProbe.probeLidarrAuditPlex).toHaveBeenCalledWith({
        plexUrl: undefined,
        plexToken: undefined,
      });
      expect(mockAdapters.resolveRequiredMediaServerAdapter).not.toHaveBeenCalled();
      expect(findCheck(result.report, "plex-connectivity")).toMatchObject({
        status: "skipped",
        skipReason: "plex-not-configured",
      });
      expect(findCheck(result.report, "plex-alignment")).toMatchObject({
        status: "skipped",
        skipReason: "plex-not-configured",
      });
      // Neither check is Lidarr-backed, so the run costs no Lidarr requests.
      expect(mockResolveRequiredLidarrClient).not.toHaveBeenCalled();
      expect(result.report.status).toBe("clean");
    });

    it("reserves plex-alignment even when the Plex slot is available", async () => {
      const result = await executeLidarrAudit({ check: ["plex-alignment"] });

      expect(findCheck(result.report, "plex-alignment")).toMatchObject({
        status: "skipped",
        skipReason: "identity-mapping-unavailable",
      });
      expect(result.report.status).toBe("clean");
    });
  });

  describe("secret hygiene", () => {
    it("forwards the Plex overrides to the probe without leaking any credential", async () => {
      const result = await executeLidarrAudit({
        lidarrUrl: "http://lidarr:8686",
        lidarrApiKey: "secret-api-key",
        plexUrl: "http://plex:32400",
        plexToken: "secret-plex-token",
      });

      expect(mockPlexProbe.probeLidarrAuditPlex).toHaveBeenCalledWith({
        plexUrl: "http://plex:32400",
        plexToken: "secret-plex-token",
      });
      const rendered = inspect(result, { depth: null });
      expect(rendered).not.toContain("secret-api-key");
      expect(rendered).not.toContain("secret-plex-token");
    });
  });
});
