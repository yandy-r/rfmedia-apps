/**
 * Unit tests for the copy plan artifact library (lib/plan.ts).
 *
 * Real filesystem in a mkdtemp sandbox with RFMEDIA_PLAN_DIR pointed at it;
 * minimal mocking (a single doMock-based fs seam for the ENOENT prune test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PlanArtifactError, PlanValidationError } from "./errors.js";
import {
  COPY_PLAN_MAX_BYTES,
  COPY_PLAN_VERSION,
  type CopyPlanV1,
  type PlanApplicationRecord,
  type PlanExecutionOptions,
  type PlanReviewEntry,
  type PlanReviewSection,
} from "../types/plan.js";
import type { CopyOptions, PathEntry } from "../types/options.js";
import {
  appendPlanAudit,
  assertCopyPlanV1,
  buildCopyPlan,
  checkStaleness,
  computePlanChecksum,
  findPlanApplications,
  fingerprintSourceDir,
  getAuditLedgerPath,
  getDefaultPlanDir,
  planToCopyOptions,
  prunePlans,
  readPlanArtifact,
  toPlanExecutionOptions,
  writePlanArtifact,
} from "./plan.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Deterministic filter-mode fixture (canonical order; conflictStrategy omitted). */
function makePlanFixture(overrides: Partial<Omit<CopyPlanV1, "payloadChecksum">> = {}): CopyPlanV1 {
  const body: Omit<CopyPlanV1, "payloadChecksum"> = {
    version: COPY_PLAN_VERSION,
    id: "11111111-2222-4333-8444-555555555555",
    createdAt: "2026-07-19T12:00:00.000Z",
    createdBy: { host: "plan-host", user: "plan-user", cliVersion: "0.5.0", cwd: "/work" },
    command: "copy",
    destination: "/dest",
    execution: {
      mode: {
        type: "filter",
        rating: { minStars: 4, outputFolder: "liked-songs", preserveStructure: false },
      },
      albumOnly: false,
      hardlink: false,
      force: false,
      workers: 4,
    },
    optionsKey: "filter-s4",
    review: {
      advisory: true,
      note: "Snapshot of the dry-run preview at plan time.",
      granularity: "track",
      truncated: false,
      entries: [
        {
          op: "create",
          kind: "copy",
          sourcePath: "/music/Artist/Album/track1.flac",
          destPath: "/dest/liked-songs/track1.flac",
          bytes: 1024,
          sourceSize: 1024,
          sourceMtimeMs: 1700000000000,
        },
      ],
      summary: {
        create: 1,
        skip: 0,
        overwrite: 0,
        incomplete: 0,
        filtered: 2,
        files: 1,
        bytes: 1024,
      },
    },
    fingerprints: {
      sources: [
        {
          path: "/music/Artist",
          exists: true,
          fileCount: 3,
          totalBytes: 4096,
          maxMtimeMs: 1700000000000,
        },
      ],
      destination: { path: "/dest", exists: false },
    },
    ...overrides,
  };
  return { ...body, payloadChecksum: computePlanChecksum(body) };
}

/** Execution variant with a recursive smart filter and an explicit conflictStrategy. */
function makeSmartFilterExecution(): PlanExecutionOptions {
  return {
    mode: {
      type: "filter",
      rating: {
        outputFolder: "smart-picks",
        preserveStructure: false,
        smartFilter: {
          match: "all",
          rules: [
            { type: "rule", field: "rating", operator: ">=", value: 4 },
            {
              type: "group",
              match: "any",
              rules: [
                { type: "rule", field: "genre", operator: "contains", value: "Rock" },
                {
                  type: "group",
                  match: "all",
                  rules: [{ type: "rule", field: "year", operator: ">=", value: 1990 }],
                },
              ],
            },
          ],
        },
        filterName: "nested-rock",
      },
    },
    albumOnly: false,
    hardlink: false,
    force: false,
    conflictStrategy: "skip",
    workers: 2,
  };
}

function makeCopyOptionsFixture(): CopyOptions {
  return {
    mode: {
      type: "filter",
      rating: { minStars: 4, outputFolder: "liked-songs", preserveStructure: false },
    },
    albumOnly: false,
    hardlink: true,
    force: false,
    conflictStrategy: "skip",
    dryRun: true,
    workers: 3,
    file: "/tmp/sources.txt",
    verify: true,
    plexToken: "super-secret-token",
    plexUrl: "http://plex.local:32400",
    plexLibrary: "Music",
    cliSourceEntries: [{ path: "/music/Artist", filterName: "liked" }],
    sourceGroup: "pop",
  };
}

function makeAuditRecord(overrides: Partial<PlanApplicationRecord> = {}): PlanApplicationRecord {
  return {
    planId: "plan-1111",
    planPath: "/plans/plan-1111.json",
    planChecksum: `sha256:${"a".repeat(64)}`,
    appliedAt: "2026-07-19T12:00:00.000Z",
    host: "plan-host",
    cliVersion: "0.5.0",
    status: "completed",
    forcedStale: false,
    stalenessErrorsOverridden: [],
    stalenessWarnings: 0,
    counts: { created: 1, skipped: 0, failed: 0, filtered: 0 },
    ...overrides,
  };
}

/** JSON-plain clone mimicking a parsed artifact (strips explicit undefined). */
function toRaw(plan: CopyPlanV1): Record<string, unknown> {
  return JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
}

/**
 * Builds a real on-disk source tree plus a plan whose fingerprints and review
 * entries match the disk exactly (clean staleness baseline).
 */
async function makeLivePlan(
  root: string,
  options: {
    trackCount?: number;
    cliSourceEntries?: PathEntry[];
    preStat?: (trackPaths: string[]) => Promise<void>;
  } = {},
): Promise<{ plan: CopyPlanV1; srcDir: string; destDir: string; trackPaths: string[] }> {
  const trackCount = options.trackCount ?? 2;
  const srcDir = join(root, "live-source");
  const destDir = join(root, "live-dest");
  await mkdir(srcDir, { recursive: true });
  const trackPaths: string[] = [];
  for (let index = 0; index < trackCount; index++) {
    const trackPath = join(srcDir, `track-${String(index).padStart(2, "0")}.flac`);
    await writeFile(trackPath, `audio-data-${index}`, "utf-8");
    trackPaths.push(trackPath);
  }
  await options.preStat?.(trackPaths);
  const entries: PlanReviewEntry[] = [];
  for (const trackPath of trackPaths) {
    const trackStat = await stat(trackPath);
    entries.push({
      op: "create",
      kind: "copy",
      sourcePath: trackPath,
      destPath: join(destDir, "liked-songs", basename(trackPath)),
      bytes: trackStat.size,
      sourceSize: trackStat.size,
      sourceMtimeMs: Math.trunc(trackStat.mtimeMs),
    });
  }
  const execution: PlanExecutionOptions = {
    mode: {
      type: "filter",
      rating: { minStars: 4, outputFolder: "liked-songs", preserveStructure: false },
    },
    albumOnly: false,
    hardlink: false,
    force: false,
    workers: 2,
    ...(options.cliSourceEntries === undefined
      ? {}
      : { cliSourceEntries: options.cliSourceEntries }),
  };
  const review: PlanReviewSection = {
    advisory: true,
    note: "test snapshot",
    granularity: "track",
    truncated: false,
    entries,
    summary: {
      create: entries.length,
      skip: 0,
      overwrite: 0,
      incomplete: 0,
      filtered: 0,
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    },
  };
  const plan = buildCopyPlan({
    destination: destDir,
    execution,
    optionsKey: "filter-s4",
    review,
    fingerprints: {
      sources: [await fingerprintSourceDir(srcDir)],
      destination: { path: destDir, exists: false },
    },
  });
  return { plan, srcDir, destDir, trackPaths };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("lib/plan", () => {
  let tmpRoot: string;
  let planDir: string;
  let originalPlanDir: string | undefined;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "rfmedia-plan-"));
    planDir = join(tmpRoot, "plans");
    originalPlanDir = process.env["RFMEDIA_PLAN_DIR"];
    process.env["RFMEDIA_PLAN_DIR"] = planDir;
  });

  afterEach(async () => {
    if (originalPlanDir === undefined) {
      delete process.env["RFMEDIA_PLAN_DIR"];
    } else {
      process.env["RFMEDIA_PLAN_DIR"] = originalPlanDir;
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe("artifact round-trip", () => {
    it("writes atomically with 0o600 file and 0o700 dir and reads back an identical plan", async () => {
      const plan = makePlanFixture();
      const planPath = join(getDefaultPlanDir(), "plan-roundtrip.json");
      const written = await writePlanArtifact(planPath, plan);
      expect(written).toBe(planPath);

      const fileStat = await stat(planPath);
      expect(fileStat.mode & 0o777).toBe(0o600);
      const dirStat = await stat(getDefaultPlanDir());
      expect(dirStat.mode & 0o777).toBe(0o700);

      const names = await readdir(getDefaultPlanDir());
      expect(names).toEqual(["plan-roundtrip.json"]); // no temp files left behind

      const readBack = await readPlanArtifact(planPath);
      expect(readBack).toEqual(plan);
    });

    it("reads a compatible artifact from a non-private parent without changing modes", async () => {
      const plan = makePlanFixture();
      const planPath = join(getDefaultPlanDir(), "plan-shared-parent.json");
      await writePlanArtifact(planPath, plan);
      await chmod(getDefaultPlanDir(), 0o775);
      await chmod(planPath, 0o644);

      await expect(readPlanArtifact(planPath)).resolves.toEqual(plan);
      expect((await stat(getDefaultPlanDir())).mode & 0o777).toBe(0o775);
      expect((await stat(planPath)).mode & 0o777).toBe(0o644);
    });

    it("emits keys in fixed canonical order (snapshot)", async () => {
      const planPath = join(getDefaultPlanDir(), "plan-canonical.json");
      await writePlanArtifact(planPath, makePlanFixture());
      const content = await readFile(planPath, "utf-8");
      expect(content).toMatchSnapshot();
    });

    it("rejects overwrite of an existing plan without overwrite flag (PLAN_EXISTS)", async () => {
      const plan = makePlanFixture();
      const planPath = join(getDefaultPlanDir(), "plan-exists.json");
      await writePlanArtifact(planPath, plan);
      await expect(writePlanArtifact(planPath, plan)).rejects.toMatchObject({
        name: "PlanArtifactError",
        code: "PLAN_EXISTS",
      });
      await expect(writePlanArtifact(planPath, plan, { overwrite: true })).resolves.toBe(planPath);
    });

    it("round-trips a smart-filter plan (recursive rules) without dropping keys", async () => {
      const plan = makePlanFixture({ execution: makeSmartFilterExecution() });
      const planPath = join(getDefaultPlanDir(), "plan-smart.json");
      await writePlanArtifact(planPath, plan);
      const content = await readFile(planPath, "utf-8");
      expect(content).toContain('"smartFilter"');
      expect(content).toContain('"conflictStrategy": "skip"');

      const readBack = await readPlanArtifact(planPath);
      expect(readBack.execution).toEqual(plan.execution);
      if (plan.execution.mode.type !== "filter" || readBack.execution.mode.type !== "filter") {
        throw new Error("expected filter-mode fixtures");
      }
      expect(readBack.execution.mode.rating.smartFilter).toEqual(
        plan.execution.mode.rating.smartFilter,
      );
    });
  });

  describe("checksum integrity", () => {
    it("detects a single flipped byte as PLAN_CHECKSUM_MISMATCH", async () => {
      const planPath = join(getDefaultPlanDir(), "plan-tamper.json");
      await writePlanArtifact(planPath, makePlanFixture());
      const content = await readFile(planPath, "utf-8");
      const tampered = content.replace("track1.flac", "track2.flac");
      expect(tampered).not.toBe(content);
      await writeFile(planPath, tampered, "utf-8");
      await expect(readPlanArtifact(planPath)).rejects.toMatchObject({
        name: "PlanArtifactError",
        code: "PLAN_CHECKSUM_MISMATCH",
      });
    });

    it("detects truncation as malformed or checksum failure", async () => {
      const planPath = join(getDefaultPlanDir(), "plan-truncated.json");
      await writePlanArtifact(planPath, makePlanFixture());
      const content = await readFile(planPath, "utf-8");
      await writeFile(planPath, content.slice(0, Math.floor(content.length / 2)), "utf-8");
      const error: unknown = await readPlanArtifact(planPath).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PlanArtifactError);
      expect(["PLAN_MALFORMED", "PLAN_CHECKSUM_MISMATCH"]).toContain(
        (error as PlanArtifactError).code,
      );
    });
  });

  describe("hardened IO", () => {
    it("rejects a symlinked plan path", async () => {
      const planPath = join(getDefaultPlanDir(), "plan-real.json");
      await writePlanArtifact(planPath, makePlanFixture());
      const linkPath = join(getDefaultPlanDir(), "plan-link.json");
      await symlink(planPath, linkPath);
      await expect(readPlanArtifact(linkPath)).rejects.toMatchObject({
        code: "PLAN_UNSAFE_PATH",
      });
    });

    it("rejects a symlink in a parent component", async () => {
      const realDir = join(tmpRoot, "real-dir");
      await mkdir(realDir, { recursive: true });
      const planPath = join(realDir, "plan-a.json");
      await writePlanArtifact(planPath, makePlanFixture());
      const linkDir = join(tmpRoot, "link-dir");
      await symlink(realDir, linkDir);
      await expect(readPlanArtifact(join(linkDir, "plan-a.json"))).rejects.toMatchObject({
        code: "PLAN_UNSAFE_PATH",
      });
    });

    it("rejects artifacts over COPY_PLAN_MAX_BYTES", async () => {
      await mkdir(getDefaultPlanDir(), { recursive: true, mode: 0o700 });
      const planPath = join(getDefaultPlanDir(), "plan-huge.json");
      await writeFile(planPath, `{"pad":"${"a".repeat(COPY_PLAN_MAX_BYTES)}"}`, {
        encoding: "utf-8",
        mode: 0o644,
      });
      await expect(readPlanArtifact(planPath)).rejects.toMatchObject({
        code: "PLAN_TOO_LARGE",
      });
    });

    it("rejects path traversal segments", async () => {
      const traversal = `${tmpRoot}/plans/../escape.json`;
      await expect(readPlanArtifact(traversal)).rejects.toMatchObject({
        code: "PLAN_UNSAFE_PATH",
      });
      await expect(writePlanArtifact(traversal, makePlanFixture())).rejects.toMatchObject({
        code: "PLAN_UNSAFE_PATH",
      });
    });

    it("rejects malformed JSON as PLAN_MALFORMED", async () => {
      await mkdir(getDefaultPlanDir(), { recursive: true, mode: 0o700 });
      const planPath = join(getDefaultPlanDir(), "plan-bad.json");
      await writeFile(planPath, "{ not json", { encoding: "utf-8", mode: 0o644 });
      await expect(readPlanArtifact(planPath)).rejects.toMatchObject({
        code: "PLAN_MALFORMED",
      });
    });

    it("surfaces a nonexistent artifact path as PLAN_IO", async () => {
      const missingPath = join(getDefaultPlanDir(), "plan-missing.json");
      await expect(readPlanArtifact(missingPath)).rejects.toMatchObject({
        name: "PlanArtifactError",
        code: "PLAN_IO",
      });
    });
  });

  describe("assertCopyPlanV1", () => {
    it("accepts the canonical fixture", () => {
      expect(() => assertCopyPlanV1(toRaw(makePlanFixture()))).not.toThrow();
    });

    it("accepts a smart-filter fixture with nested rule groups", () => {
      const raw = toRaw(makePlanFixture({ execution: makeSmartFilterExecution() }));
      expect(() => assertCopyPlanV1(raw)).not.toThrow();
    });

    it.each(["extra", "metadata"])("rejects unknown top-level key %s", (key) => {
      const raw = toRaw(makePlanFixture());
      raw[key] = true;
      expect(() => assertCopyPlanV1(raw)).toThrow(PlanValidationError);
    });

    it("rejects a missing required field", () => {
      const raw = toRaw(makePlanFixture());
      delete raw["destination"];
      expect(() => assertCopyPlanV1(raw)).toThrow(/destination/);
    });

    it("rejects an unsupported version string", () => {
      const raw = toRaw(makePlanFixture());
      raw["version"] = "rfmedia.copy-plan.v2";
      expect(() => assertCopyPlanV1(raw)).toThrow(/version/);
    });

    it("rejects command !== copy", () => {
      const raw = toRaw(makePlanFixture());
      raw["command"] = "sync";
      expect(() => assertCopyPlanV1(raw)).toThrow(/command/);
    });

    it("rejects __proto__ keys at any depth", () => {
      const json = JSON.stringify(makePlanFixture());
      const tampered = JSON.parse(
        json.replace('"granularity"', '"__proto__": {"polluted": true}, "granularity"'),
      ) as unknown;
      expect(() => assertCopyPlanV1(tampered)).toThrow(/__proto__/);
    });

    it("rejects any embedded plexToken key at any depth", () => {
      const raw = toRaw(makePlanFixture());
      const review = raw["review"] as Record<string, unknown>;
      const summary = review["summary"] as Record<string, unknown>;
      summary["plexToken"] = "secret";
      expect(() => assertCopyPlanV1(raw)).toThrow(/plexToken/);
    });

    it("rejects smart-filter nesting beyond the depth bound", () => {
      let rules: unknown = [{ type: "rule", field: "rating", operator: ">=", value: 4 }];
      for (let index = 0; index < 17; index++) {
        rules = [{ type: "group", match: "all", rules }];
      }
      const raw = toRaw(makePlanFixture({ execution: makeSmartFilterExecution() }));
      const execution = raw["execution"] as Record<string, unknown>;
      const mode = execution["mode"] as Record<string, unknown>;
      const rating = mode["rating"] as Record<string, unknown>;
      rating["smartFilter"] = { match: "all", rules };
      expect(() => assertCopyPlanV1(raw)).toThrow(/depth/);
    });
  });

  describe("checkStaleness", () => {
    it("flags a deleted source dir as overridable error source-missing", async () => {
      const { plan, srcDir } = await makeLivePlan(tmpRoot);
      await rm(srcDir, { recursive: true, force: true });
      const report = await checkStaleness(plan, { forceStale: false });
      const missing = report.errors.find((finding) => finding.code === "source-missing");
      expect(missing).toMatchObject({
        severity: "error",
        overridable: true,
        paths: [srcDir],
      });
    });

    it("flags fingerprint drift (fileCount/totalBytes/maxMtimeMs) as source-drift", async () => {
      const { plan, srcDir } = await makeLivePlan(tmpRoot);
      await writeFile(join(srcDir, "new-track.flac"), "new audio", "utf-8");
      const report = await checkStaleness(plan, { forceStale: false });
      expect(report.errors.map((finding) => finding.code)).toEqual(["source-drift"]);
      expect(report.errors[0]?.paths).toEqual([srcDir]);
      expect(report.errors[0]?.overridable).toBe(true);
      expect(report.warnings).toEqual([]);
    });

    it("flags per-entry size/mtime drift as entry-drift capped at 10 paths", async () => {
      const { plan, trackPaths } = await makeLivePlan(tmpRoot, { trackCount: 12 });
      for (const trackPath of trackPaths) {
        await appendFile(trackPath, "-changed", "utf-8");
      }
      const report = await checkStaleness(plan, { forceStale: false });
      const entryDrift = report.errors.find((finding) => finding.code === "entry-drift");
      expect(entryDrift).toBeDefined();
      expect(entryDrift?.paths).toHaveLength(10);
      expect(entryDrift?.message).toMatch(/\+2 more/);
      expect(entryDrift?.overridable).toBe(true);
    });

    it("flags a reviewed file removed from disk (ENOENT) as entry-drift with its path", async () => {
      const { plan, trackPaths } = await makeLivePlan(tmpRoot, { trackCount: 3 });
      const removedPath = trackPaths[0];
      if (removedPath === undefined) throw new Error("fixture track missing");
      await rm(removedPath);
      const report = await checkStaleness(plan, { forceStale: false });
      const entryDrift = report.errors.find((finding) => finding.code === "entry-drift");
      expect(entryDrift).toMatchObject({
        severity: "error",
        overridable: true,
        paths: [removedPath],
      });
      // Removing a file also shifts the source-dir fingerprint; entry-drift
      // must still be reported alongside that source-drift.
      expect(report.errors.map((finding) => finding.code)).toContain("source-drift");
    });

    it("does NOT flag entry-drift for an unchanged file with fractional mtime", async () => {
      // Resolution 20 pin: persisted mtimes and fresh comparisons both truncate.
      const { plan } = await makeLivePlan(tmpRoot, {
        preStat: async (paths) => {
          for (const trackPath of paths) {
            await utimes(trackPath, 1700000000.1234567, 1700000000.1234567);
          }
        },
      });
      const report = await checkStaleness(plan, { forceStale: false });
      expect(report.findings).toEqual([]);
    });

    it("emits plan-age warning past 24h", async () => {
      const { plan } = await makeLivePlan(tmpRoot);
      const report = await checkStaleness(plan, {
        forceStale: false,
        now: Date.parse(plan.createdAt) + 25 * 60 * 60 * 1000,
      });
      expect(report.errors).toEqual([]);
      expect(report.warnings.map((finding) => finding.code)).toEqual(["plan-age"]);
    });

    it("emits host-mismatch and cli-version warnings", async () => {
      const { plan } = await makeLivePlan(tmpRoot);
      const foreign: CopyPlanV1 = {
        ...plan,
        createdBy: { ...plan.createdBy, host: "other-host", cliVersion: "0.0.1" },
      };
      const report = await checkStaleness(foreign, { forceStale: false });
      expect(report.errors).toEqual([]);
      expect(report.warnings.map((finding) => finding.code).sort()).toEqual([
        "cli-version",
        "host-mismatch",
      ]);
    });

    it("emits dest-drift warning when review op no longer matches disk", async () => {
      const { plan } = await makeLivePlan(tmpRoot);
      const firstDest = plan.review.entries[0]?.destPath;
      if (firstDest === undefined) throw new Error("fixture entry missing");
      await mkdir(dirname(firstDest), { recursive: true });
      await writeFile(firstDest, "already there", "utf-8");
      const report = await checkStaleness(plan, { forceStale: false });
      expect(report.errors).toEqual([]);
      expect(report.warnings.map((finding) => finding.code)).toEqual(["dest-drift"]);
      expect(report.warnings[0]?.paths).toEqual([firstDest]);
    });

    it("emits filter-resolution warning when frozen entries carry filterName", async () => {
      const entryPath = join(tmpRoot, "live-source");
      const { plan } = await makeLivePlan(tmpRoot, {
        cliSourceEntries: [{ path: entryPath, filterName: "liked" }],
      });
      const report = await checkStaleness(plan, { forceStale: false });
      expect(report.errors).toEqual([]);
      expect(report.warnings.map((finding) => finding.code)).toEqual(["filter-resolution"]);
      expect(report.warnings[0]?.paths).toEqual([entryPath]);
    });

    it("emits review-truncated warning and skips per-entry checks", async () => {
      const { plan } = await makeLivePlan(tmpRoot);
      const ghostEntries = plan.review.entries.map((entry) => ({
        ...entry,
        sourcePath: join(tmpRoot, "ghost", basename(entry.sourcePath)),
      }));
      const truncated: CopyPlanV1 = {
        ...plan,
        review: { ...plan.review, truncated: true, entries: ghostEntries },
      };
      const report = await checkStaleness(truncated, { forceStale: false });
      expect(report.errors).toEqual([]);
      expect(report.warnings.map((finding) => finding.code)).toEqual(["review-truncated"]);
    });

    it("forceStale downgrades errors into overridden+warnings and empties errors", async () => {
      const { plan, srcDir } = await makeLivePlan(tmpRoot);
      await rm(srcDir, { recursive: true, force: true });
      const report = await checkStaleness(plan, { forceStale: true });
      expect(report.errors).toEqual([]);
      expect(report.overridden.length).toBeGreaterThan(0);
      expect(report.overridden.map((finding) => finding.code)).toContain("source-missing");
      for (const finding of report.overridden) {
        expect(report.warnings).toContain(finding);
        expect(report.findings).toContain(finding);
      }
    });

    it("returns clean report for an untouched fixture", async () => {
      const { plan } = await makeLivePlan(tmpRoot);
      const report = await checkStaleness(plan, { forceStale: false });
      expect(report).toEqual({ findings: [], errors: [], overridden: [], warnings: [] });
    });
  });

  describe("execution layer fidelity", () => {
    it("planToCopyOptions parity with the queue rehydration shape for shared fields plus verify/conflictStrategy", () => {
      const options = makeCopyOptionsFixture();
      const execution = toPlanExecutionOptions(options);
      expect("plexToken" in execution).toBe(false);
      expect("dryRun" in execution).toBe(false);
      expect("selection" in execution).toBe(false);
      expect(execution.verify).toBe(true);
      expect(execution.conflictStrategy).toBe("skip");
      expect(execution.mode).toEqual(options.mode);
      expect(execution.cliSourceEntries).toEqual(options.cliSourceEntries);
      expect(execution.plexUrl).toBe(options.plexUrl);
      expect(execution.file).toBe(options.file);

      const plan = makePlanFixture({ execution });
      expect(planToCopyOptions(plan, false)).toEqual({ ...plan.execution, dryRun: false });
      expect(planToCopyOptions(plan, true).dryRun).toBe(true);
    });

    it("serialized plan contains no plexToken anywhere (serialize-and-grep)", async () => {
      const execution = toPlanExecutionOptions(makeCopyOptionsFixture());
      const base = makePlanFixture();
      const plan = buildCopyPlan({
        destination: "/dest",
        execution,
        optionsKey: "filter-s4",
        review: base.review,
        fingerprints: base.fingerprints,
      });
      const planPath = join(getDefaultPlanDir(), "plan-secret.json");
      await writePlanArtifact(planPath, plan);
      const content = await readFile(planPath, "utf-8");
      expect(content).not.toContain("plexToken");
      expect(content).not.toContain("super-secret-token");
    });
  });

  describe("plans dir maintenance", () => {
    it("prunePlans keeps newest 50 and never deletes audit.jsonl", async () => {
      await mkdir(planDir, { recursive: true });
      await writeFile(join(planDir, "audit.jsonl"), "{}\n", "utf-8");
      await writeFile(join(planDir, "unmanaged.txt"), "keep me", "utf-8");
      const base = 1_700_000_000;
      for (let index = 0; index < 53; index++) {
        const name = `plan-${String(index).padStart(3, "0")}.json`;
        const filePath = join(planDir, name);
        await writeFile(filePath, "{}", "utf-8");
        await utimes(filePath, base + index, base + index);
      }
      await prunePlans();
      const remaining = (await readdir(planDir)).sort();
      expect(remaining).toContain("audit.jsonl");
      expect(remaining).toContain("unmanaged.txt");
      const planFiles = remaining.filter((name) => name.startsWith("plan-"));
      expect(planFiles).toHaveLength(50);
      expect(planFiles).not.toContain("plan-000.json");
      expect(planFiles).not.toContain("plan-001.json");
      expect(planFiles).not.toContain("plan-002.json");
      expect(planFiles).toContain("plan-003.json");
      expect(planFiles).toContain("plan-052.json");
    });

    it("prunePlans tolerates a file vanishing mid-scan (ENOENT swallowed)", async () => {
      await mkdir(planDir, { recursive: true });
      const base = 1_700_000_000;
      const names = ["plan-vanishing.json", "plan-old.json", "plan-new.json"];
      for (const [index, name] of names.entries()) {
        const filePath = join(planDir, name);
        await writeFile(filePath, "{}", "utf-8");
        await utimes(filePath, base + index, base + index);
      }

      vi.resetModules();
      const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      vi.doMock("node:fs/promises", () => ({
        ...realFs,
        stat: (async (...args: Parameters<typeof realFs.stat>) => {
          if (String(args[0]).endsWith("plan-vanishing.json")) {
            throw Object.assign(new Error("ENOENT: file vanished mid-scan"), { code: "ENOENT" });
          }
          return realFs.stat(...args);
        }) as typeof realFs.stat,
      }));
      try {
        const freshPlan = await import("./plan.js");
        await expect(freshPlan.prunePlans(1)).resolves.toBeUndefined();
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
      }

      const remaining = (await readdir(planDir)).sort();
      // The "vanished" file was skipped from candidates (still on disk); the
      // oldest surviving candidate was pruned and the scan completed.
      expect(remaining).toEqual(["plan-new.json", "plan-vanishing.json"]);
    });

    it("audit append/find round-trips records and skips malformed lines", async () => {
      const first = makeAuditRecord();
      const other = makeAuditRecord({ planId: "plan-2222", status: "failed" });
      await appendPlanAudit(first);
      await appendPlanAudit(other);
      await appendFile(getAuditLedgerPath(), "this is not json\n", "utf-8");
      const third = makeAuditRecord({ status: "partial", historySessionId: "sess-9" });
      await appendPlanAudit(third);

      await expect(findPlanApplications("plan-1111")).resolves.toEqual([first, third]);
      await expect(findPlanApplications("plan-2222")).resolves.toEqual([other]);
      await expect(findPlanApplications("plan-none")).resolves.toEqual([]);
    });

    it("degrades an unreadable audit ledger (non-ENOENT) to a warning and empty result", async () => {
      // Seed a real record so an empty result proves degradation, not absence.
      await appendPlanAudit(makeAuditRecord());

      vi.resetModules();
      const realFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const realLogger = await vi.importActual<typeof import("./logger.js")>("./logger.js");
      const logWarnSpy = vi.fn();
      vi.doMock("node:fs/promises", () => ({
        ...realFs,
        open: (async (...args: Parameters<typeof realFs.open>) => {
          if (String(args[0]).endsWith("audit.jsonl")) {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
          }
          return realFs.open(...args);
        }) as typeof realFs.open,
      }));
      vi.doMock("./logger.js", () => ({ ...realLogger, logWarn: logWarnSpy }));
      try {
        const freshPlan = await import("./plan.js");
        await expect(freshPlan.findPlanApplications("plan-1111")).resolves.toEqual([]);
        expect(logWarnSpy).toHaveBeenCalledTimes(1);
        expect(String(logWarnSpy.mock.calls[0]?.[0])).toMatch(/audit ledger/);
        expect(String(logWarnSpy.mock.calls[0]?.[0])).toMatch(/EACCES/);
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.doUnmock("./logger.js");
        vi.resetModules();
      }
    });

    it("first-ever audit append creates the ledger with mode 0o600", async () => {
      await expect(findPlanApplications("plan-1111")).resolves.toEqual([]); // no ledger yet
      await appendPlanAudit(makeAuditRecord());
      const ledgerStat = await stat(getAuditLedgerPath());
      expect(ledgerStat.mode & 0o777).toBe(0o600);
      const dirStat = await stat(getDefaultPlanDir());
      expect(dirStat.mode & 0o777).toBe(0o700);
    });
  });
});
