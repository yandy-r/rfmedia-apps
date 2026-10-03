/**
 * Baseline scope gating and degradation (issue #152, test T5).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Stats } from "node:fs";
import { join } from "node:path";

const mockFs = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

const mockPlanStorage = vi.hoisted(() => ({
  hashFile: vi.fn(),
}));

const mockLogger = vi.hoisted(() => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: mockFs.readFile,
  readdir: mockFs.readdir,
  stat: mockFs.stat,
}));

// Only `hashFile` is mocked: the baseline module must not reach for
// `loadPlan`, which reports read failures at WARN.
vi.mock("./plan-storage.js", () => ({
  hashFile: mockPlanStorage.hashFile,
}));

vi.mock("@rfmedia/common", () => ({
  logDebug: mockLogger.logDebug,
  logInfo: mockLogger.logInfo,
  logWarn: mockLogger.logWarn,
  logError: mockLogger.logError,
}));

import { loadPlanBaseline } from "./plan-baseline.js";
import type {
  BaselineUnavailableReason,
  PlanBaseline,
  PlanBaselineResult,
} from "../types/plan-intelligence.js";
import type { DeploymentPlan } from "../types/plan.js";

const PLAN_DIR = ".rfapps/plans";
const NEWEST_FILE = "plan-2026-07-20-00-00-00-000.json";
const OLDER_FILE = "plan-2026-07-10-00-00-00-000.json";

const COMPOSE_PATH = "/repo/compose.yml";
const OTHER_COMPOSE_PATH = "/repo/compose.dev.yml";
const PROFILES = ["all", "media"];

const BASELINE_HASH = "b".repeat(64);
const CURRENT_HASH = "c".repeat(64);
const WEB_FINGERPRINT = "d".repeat(64);

function makePlan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    id: "plan-newest",
    createdAt: "2026-07-20T00:00:00.000Z",
    composeHash: BASELINE_HASH,
    composePath: COMPOSE_PATH,
    profiles: ["media", "all"],
    services: [
      {
        service: "web",
        resolvedConfigFingerprint: WEB_FINGERPRINT,
        changeType: "update",
        image: { changed: false },
        environment: [],
        ports: { changed: false },
        volumes: { changed: false },
        networks: { changed: false },
      },
      {
        service: "db",
        resolvedConfigFingerprint: "not-a-fingerprint",
        changeType: "unchanged",
        image: { changed: false },
        environment: [],
        ports: { changed: false },
        volumes: { changed: false },
        networks: { changed: false },
      },
    ],
    summary: {
      toCreate: 0,
      toUpdate: 1,
      toRecreate: 0,
      toDelete: 0,
      unchanged: 1,
      updatesAvailable: 0,
      total: 2,
    },
    ...overrides,
  };
}

/** The always-eligible older candidate every gating row must fall back to. */
function makeMatchingOlderPlan(): DeploymentPlan {
  return makePlan({ id: "plan-older", createdAt: "2026-07-10T00:00:00.000Z" });
}

function createStat(mtimeMs: number): Stats {
  return { mtimeMs } as Stats;
}

/** Narrowing helper: fails loudly instead of skipping assertions on the wrong variant. */
function expectLoaded(result: PlanBaselineResult): PlanBaseline {
  expect(result.status).toBe("loaded");
  if (result.status !== "loaded") {
    throw new Error(`expected a loaded baseline, received status "${result.status}"`);
  }
  return result.baseline;
}

interface DirectoryEntry {
  readonly file: string;
  readonly mtimeMs: number;
  /** Raw bytes as they sit on disk, so malformed artifacts are expressible. */
  readonly content: string;
  /** True when `stat` rejects for this entry (racing unlink, unreadable mode). */
  readonly statFails?: boolean;
}

function primeDirectory(entries: readonly DirectoryEntry[]): void {
  mockFs.readdir.mockResolvedValue([...entries.map((entry) => entry.file), "notes.txt"]);
  mockFs.stat.mockImplementation(async (path: string) => {
    const entry = entries.find((candidate) => path === join(PLAN_DIR, candidate.file));
    if (entry?.statFails === true) {
      throw new Error("ENOENT: no such file or directory");
    }
    return createStat(entry?.mtimeMs ?? 0);
  });
  mockFs.readFile.mockImplementation(async (path: string) => {
    const entry = entries.find((candidate) => path === join(PLAN_DIR, candidate.file));
    if (entry === undefined) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    return entry.content;
  });
}

type ExpectedOutcome =
  | { readonly status: "loaded"; readonly planId: string }
  | { readonly status: "unavailable"; readonly reason: BaselineUnavailableReason };

interface BaselineCase {
  readonly name: string;
  /** Newest candidate on disk. Disqualified in every gating row. */
  readonly newest: DeploymentPlan;
  /** Older candidate on disk. */
  readonly older: DeploymentPlan;
  /** Raw bytes for the newest file, replacing its serialized plan. */
  readonly newestContent?: string;
  /** True when `stat` on the newest file rejects. */
  readonly newestStatFails?: boolean;
  /** True when the plan directory itself cannot be read. */
  readonly directoryUnreadable?: boolean;
  /** True when the row degrades through a filesystem failure that must be traced. */
  readonly expectDebugLog?: boolean;
  readonly expected: ExpectedOutcome;
}

const cases: readonly BaselineCase[] = [
  {
    name: "skips a newer plan targeting a different compose file",
    newest: makePlan({ composePath: OTHER_COMPOSE_PATH }),
    older: makeMatchingOlderPlan(),
    expected: { status: "loaded", planId: "plan-older" },
  },
  {
    name: "skips a newer plan with a different profile set",
    newest: makePlan({ profiles: ["all"] }),
    older: makeMatchingOlderPlan(),
    expected: { status: "loaded", planId: "plan-older" },
  },
  {
    name: "skips a managed-update plan",
    newest: makePlan({ intent: "managed-update" }),
    older: makeMatchingOlderPlan(),
    expected: { status: "loaded", planId: "plan-older" },
  },
  {
    name: "skips a plan with an empty compose hash",
    newest: makePlan({ composeHash: "" }),
    older: makeMatchingOlderPlan(),
    expected: { status: "loaded", planId: "plan-older" },
  },
  {
    name: "reports no-comparable-plan when no candidate matches the current scope",
    newest: makePlan({ composePath: OTHER_COMPOSE_PATH }),
    older: makePlan({ id: "plan-older", intent: "managed-update" }),
    expected: { status: "unavailable", reason: "no-comparable-plan" },
  },
  {
    name: "reports plan-history-unreadable when the plan directory cannot be read",
    newest: makePlan(),
    older: makeMatchingOlderPlan(),
    directoryUnreadable: true,
    expected: { status: "unavailable", reason: "plan-history-unreadable" },
  },
  {
    name: "skips a truncated plan file in favour of an older valid one",
    newest: makePlan(),
    newestContent: '{"id":"plan-newest","composePath":"/repo/comp',
    older: makeMatchingOlderPlan(),
    expectDebugLog: true,
    expected: { status: "loaded", planId: "plan-older" },
  },
  {
    name: "skips a plan file that is valid JSON but not an object",
    newest: makePlan(),
    newestContent: '"not-a-plan"',
    older: makeMatchingOlderPlan(),
    expected: { status: "loaded", planId: "plan-older" },
  },
  {
    name: "keeps scanning when one directory entry cannot be stat-ed",
    newest: makePlan(),
    newestStatFails: true,
    older: makeMatchingOlderPlan(),
    expectDebugLog: true,
    expected: { status: "loaded", planId: "plan-older" },
  },
];

describe("loadPlanBaseline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlanStorage.hashFile.mockResolvedValue(CURRENT_HASH);
  });

  it.each(cases)("$name", async (testCase) => {
    primeDirectory([
      {
        file: NEWEST_FILE,
        mtimeMs: 2_000,
        content: testCase.newestContent ?? JSON.stringify(testCase.newest),
        statFails: testCase.newestStatFails,
      },
      { file: OLDER_FILE, mtimeMs: 1_000, content: JSON.stringify(testCase.older) },
    ]);
    if (testCase.directoryUnreadable === true) {
      mockFs.readdir.mockRejectedValue(new Error("EACCES: permission denied"));
    }

    const result = await loadPlanBaseline(COMPOSE_PATH, PROFILES);

    // A stale or unreadable artifact is not operator-actionable: it must never
    // surface above logDebug.
    expect(mockLogger.logWarn).not.toHaveBeenCalled();
    expect(mockLogger.logError).not.toHaveBeenCalled();
    expect(mockLogger.logInfo).not.toHaveBeenCalled();
    if (testCase.expectDebugLog === true) {
      expect(mockLogger.logDebug).toHaveBeenCalled();
    }

    if (testCase.expected.status === "unavailable") {
      expect(result).toEqual({ status: "unavailable", reason: testCase.expected.reason });
      return;
    }

    const baseline = expectLoaded(result);
    expect(baseline.planId).toBe(testCase.expected.planId);
    expect(baseline.composeFileChanged).toBe(true);
    // Only 64-hex fingerprints cross the boundary; no other plan field does.
    expect(baseline.services).toEqual({ web: { resolvedConfigFingerprint: WEB_FINGERPRINT } });
  });
});
