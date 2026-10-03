/**
 * Tests for the plan generation / apply actions (copy-plan.ts).
 *
 * The two copy entry points and the confirmation prompt are mocked; the real
 * lib/plan.js runs against tmp dirs via RFMEDIA_PLAN_DIR. The fidelity
 * contract test swaps in the REAL copy-filter entry point (vi.importActual)
 * with mocked ratings, per the repo pattern in copy-filter.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import { cleanupTempDir, createTempTestDir, createTestFile } from "../test-utils/filesystem.js";
import { clearMocksPreservingImplementations } from "../test-utils/mock-lifecycle.js";

import { executePlanApply, executePlanGeneration, type PlanApplyArgs } from "./copy-plan.js";
import { readPlanArtifact } from "../lib/plan.js";
import {
  MissingRequiredArgumentError,
  PlanStaleError,
  PlanValidationError,
} from "../lib/errors.js";
import {
  COPY_PLAN_MAX_ENTRIES,
  type CopyPlanV1,
  type PlanApplicationRecord,
  type PlanPreviewCapture,
} from "../types/plan.js";
import type { CopyOptions, CopyResult, RatingFilter } from "../types/index.js";
import type { SmartFilter } from "../types/filters.js";
import type { FilterPreview, PreviewAction, PreviewResult } from "../types/preview.js";

// ============================================================================
// MOCK SETUP
// ============================================================================

const mocks = vi.hoisted(() => ({
  executeAlbumCopyWithFileInput: vi.fn(),
  executeFilterCopyWithFileInput: vi.fn(),
  confirm: vi.fn(),
  requireFfmpeg: vi.fn(),
  readRating: vi.fn(),
  readRatingAndFormat: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("./copy-album.js", () => ({
  executeAlbumCopyWithFileInput: mocks.executeAlbumCopyWithFileInput,
}));

vi.mock("./copy-filter.js", () => ({
  executeFilterCopyWithFileInput: mocks.executeFilterCopyWithFileInput,
}));

vi.mock("../lib/prompt.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/prompt.js")>();
  return { ...original, confirm: mocks.confirm };
});

vi.mock("../lib/convert.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/convert.js")>();
  return { ...original, requireFfmpeg: mocks.requireFfmpeg };
});

// Ratings are mocked for the fidelity test, which runs the REAL copy-filter.
vi.mock("../lib/ratings.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/ratings.js")>();
  return {
    ...original,
    readRating: mocks.readRating,
    readRatingAndFormat: mocks.readRatingAndFormat,
  };
});

// Silence + observe human logging (stderr); everything else stays real.
vi.mock("../lib/logger.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/logger.js")>();
  return { ...original, logInfo: mocks.logInfo, logWarn: mocks.logWarn };
});

// ============================================================================
// HELPERS
// ============================================================================

const originalIsTTY = process.stdin.isTTY;

function setStdinTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

function okResult(overrides: Partial<CopyResult> = {}): CopyResult {
  return { source: "mock", created: 0, skipped: 0, filtered: 0, failed: [], ...overrides };
}

describe("copy-plan actions", () => {
  let tmpBase: string;
  let planDir: string;
  let srcDir: string;
  let destDir: string;

  function filterOptions(
    overrides: Partial<CopyOptions> = {},
    rating: Partial<RatingFilter> = {},
  ): CopyOptions {
    return {
      mode: {
        type: "filter",
        rating: { outputFolder: "liked-songs", preserveStructure: false, minStars: 4, ...rating },
      },
      albumOnly: false,
      hardlink: false,
      force: false,
      dryRun: false,
      workers: 1,
      trackCompleted: false,
      cliSourceEntries: [{ path: srcDir }],
      ...overrides,
    };
  }

  function makeFilterPreview(
    tracks: { sourcePath: string; destPath: string; bytes: number; action?: PreviewAction }[],
    filteredCount = 0,
  ): FilterPreview {
    const likedTracks = tracks.map((track) => ({
      sourcePath: track.sourcePath,
      destPath: track.destPath,
      action: track.action ?? ("create" as PreviewAction),
      bytes: track.bytes,
    }));
    const willCopy = likedTracks.filter((track) => track.action !== "skip").length;
    return {
      artistName: "src",
      sourcePath: srcDir,
      likedTracks,
      filteredCount,
      summary: {
        willCopy,
        willSkip: likedTracks.length - willCopy,
        totalBytes: likedTracks.reduce((sum, track) => sum + track.bytes, 0),
      },
    };
  }

  function stubFilterCapture(...captures: PlanPreviewCapture[]): void {
    mocks.executeFilterCopyWithFileInput.mockImplementation(
      async (_source: string | undefined, _destination: string, options: CopyOptions) => {
        for (const capture of captures) options.capturePreview?.(capture);
        return okResult();
      },
    );
  }

  function lastDispatchedOptions(): CopyOptions {
    const call = mocks.executeFilterCopyWithFileInput.mock.calls.at(-1);
    if (!call) throw new Error("expected the filter entry point to have been called");
    return call[2] as CopyOptions;
  }

  /**
   * Generates a real plan into RFMEDIA_PLAN_DIR from a one-file filter fixture,
   * then resets the entry-point mock for the apply phase.
   */
  async function generateFilterPlan(
    overrides: Partial<CopyOptions> = {},
    planOutput?: string,
  ): Promise<{ planPath: string; plan: CopyPlanV1; sourceFile: string; options: CopyOptions }> {
    const sourceFile = join(srcDir, "01.flac");
    const content = "audio-data-01";
    await createTestFile(sourceFile, content);
    stubFilterCapture({
      mode: "filter",
      source: srcDir,
      preview: makeFilterPreview([
        {
          sourcePath: sourceFile,
          destPath: join(destDir, "liked-songs", "01.flac"),
          bytes: content.length,
        },
      ]),
    });
    const options = filterOptions(overrides);
    const generated = await executePlanGeneration({
      destination: destDir,
      copyOptions: options,
      ...(planOutput !== undefined && { planOutput }),
    });
    mocks.executeFilterCopyWithFileInput.mockClear();
    mocks.executeFilterCopyWithFileInput.mockImplementation(async () => okResult({ created: 1 }));
    return { ...generated, sourceFile, options };
  }

  function applyArgs(planPath: string, overrides: Partial<PlanApplyArgs> = {}): PlanApplyArgs {
    return {
      planPath,
      dryRun: false,
      yes: true,
      forceStale: false,
      machineOutput: false,
      ...overrides,
    };
  }

  async function readAuditRecords(): Promise<PlanApplicationRecord[]> {
    const raw = await readFile(join(planDir, "audit.jsonl"), "utf-8").catch(() => "");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as PlanApplicationRecord);
  }

  async function listManagedPlans(): Promise<string[]> {
    const entries = await readdir(planDir).catch(() => [] as string[]);
    return entries.filter((name) => name.startsWith("plan-") && name.endsWith(".json"));
  }

  beforeEach(async () => {
    clearMocksPreservingImplementations();
    mocks.executeAlbumCopyWithFileInput.mockImplementation(async () => okResult());
    mocks.executeFilterCopyWithFileInput.mockImplementation(async () => okResult());
    mocks.confirm.mockResolvedValue(true);
    mocks.requireFfmpeg.mockResolvedValue(undefined);
    mocks.readRating.mockResolvedValue({ value: 1, source: "Vorbis" });
    mocks.readRatingAndFormat.mockResolvedValue(null);

    tmpBase = await createTempTestDir("copy-plan-");
    planDir = join(tmpBase, "plans");
    srcDir = join(tmpBase, "src");
    destDir = join(tmpBase, "dest");
    await mkdir(srcDir, { recursive: true });
    vi.stubEnv("RFMEDIA_PLAN_DIR", planDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    setStdinTTY(originalIsTTY);
    await cleanupTempDir(tmpBase);
  });

  // ==========================================================================
  // executePlanGeneration
  // ==========================================================================

  describe("executePlanGeneration", () => {
    it("dispatches with dryRun: true and a capturePreview hook and never mutates", async () => {
      const sourceFile = join(srcDir, "01.flac");
      await createTestFile(sourceFile, "audio-data-01");
      stubFilterCapture({
        mode: "filter",
        source: srcDir,
        preview: makeFilterPreview([
          {
            sourcePath: sourceFile,
            destPath: join(destDir, "liked-songs", "01.flac"),
            bytes: "audio-data-01".length,
          },
        ]),
      });
      const options = filterOptions();

      await executePlanGeneration({ destination: destDir, copyOptions: options });

      expect(mocks.executeFilterCopyWithFileInput).toHaveBeenCalledTimes(1);
      const call = mocks.executeFilterCopyWithFileInput.mock.calls[0];
      expect(call?.[0]).toBeUndefined();
      expect(call?.[1]).toBe(destDir);
      const genOptions = call?.[2] as CopyOptions;
      expect(genOptions.dryRun).toBe(true);
      expect(typeof genOptions.capturePreview).toBe("function");
      // The caller's options object is untouched.
      expect(options.dryRun).toBe(false);
      expect(options.capturePreview).toBeUndefined();
    });

    it("throws PLAN_EMPTY and writes no file when zero captures arrive", async () => {
      mocks.executeFilterCopyWithFileInput.mockImplementation(async () => okResult());
      await expect(
        executePlanGeneration({ destination: destDir, copyOptions: filterOptions() }),
      ).rejects.toMatchObject({ name: "PlanArtifactError", code: "PLAN_EMPTY" });
      expect(await listManagedPlans()).toHaveLength(0);
    });

    it("multi-source: a frozen source with no capture -> PlanValidationError naming it, no artifact", async () => {
      const dirA = join(srcDir, "a");
      const dirB = join(srcDir, "b");
      await createTestFile(join(dirA, "01.flac"), "abcd");
      await mkdir(dirB);
      // Only dirA produces a preview capture; dirB is empty/silent.
      stubFilterCapture({
        mode: "filter",
        source: dirA,
        preview: makeFilterPreview([
          {
            sourcePath: join(dirA, "01.flac"),
            destPath: join(destDir, "liked-songs", "01.flac"),
            bytes: 4,
          },
        ]),
      });
      const options = filterOptions({ cliSourceEntries: [{ path: dirA }, { path: dirB }] });

      const promise = executePlanGeneration({ destination: destDir, copyOptions: options });
      await expect(promise).rejects.toBeInstanceOf(PlanValidationError);
      await promise.catch((error: unknown) => {
        expect(String((error as Error).message)).toContain(dirB);
        expect(String((error as Error).message)).toContain("the plan was not written");
      });
      expect(await listManagedPlans()).toHaveLength(0);
    });

    it("dry-run dispatch failures -> PlanValidationError naming the sources, no artifact", async () => {
      const sourceFile = join(srcDir, "01.flac");
      await createTestFile(sourceFile, "abcd");
      mocks.executeFilterCopyWithFileInput.mockImplementation(
        async (_source: string | undefined, _destination: string, options: CopyOptions) => {
          options.capturePreview?.({
            mode: "filter",
            source: srcDir,
            preview: makeFilterPreview([
              {
                sourcePath: sourceFile,
                destPath: join(destDir, "liked-songs", "01.flac"),
                bytes: 4,
              },
            ]),
          });
          return okResult({ failed: [{ path: srcDir, message: "EACCES: permission denied" }] });
        },
      );

      const promise = executePlanGeneration({ destination: destDir, copyOptions: filterOptions() });
      await expect(promise).rejects.toBeInstanceOf(PlanValidationError);
      await promise.catch((error: unknown) => {
        expect(String((error as Error).message)).toContain(srcDir);
        expect(String((error as Error).message)).toContain("the plan was not written");
      });
      expect(await listManagedPlans()).toHaveLength(0);
    });

    it("resolves relative frozen sources and destination to absolute; apply replays them", async () => {
      const relSrc = relative(process.cwd(), srcDir);
      const relDest = relative(process.cwd(), destDir);
      const sourceFile = join(srcDir, "01.flac");
      await createTestFile(sourceFile, "abcd");
      // Echo captures for whatever entries the dispatch received, mirroring the
      // real per-source capture contract.
      mocks.executeFilterCopyWithFileInput.mockImplementation(
        async (_source: string | undefined, _destination: string, options: CopyOptions) => {
          for (const entry of options.cliSourceEntries ?? []) {
            options.capturePreview?.({
              mode: "filter",
              source: entry.path,
              preview: makeFilterPreview([
                {
                  sourcePath: sourceFile,
                  destPath: join(destDir, "liked-songs", "01.flac"),
                  bytes: 4,
                },
              ]),
            });
          }
          return okResult();
        },
      );
      const options = filterOptions({ cliSourceEntries: [{ path: relSrc }] });

      const { planPath, plan } = await executePlanGeneration({
        destination: relDest,
        copyOptions: options,
      });

      // The artifact is cwd-independent: all frozen paths are absolute.
      expect(plan.destination).toBe(destDir);
      expect(plan.execution.cliSourceEntries).toEqual([{ path: srcDir }]);
      expect(plan.fingerprints.destination.path).toBe(destDir);
      expect(plan.fingerprints.sources.map((source) => source.path)).toEqual([srcDir]);
      const genCall = mocks.executeFilterCopyWithFileInput.mock.calls.at(-1);
      expect(genCall?.[1]).toBe(destDir);

      // Apply replays the identical absolute paths (dispatch parity).
      mocks.executeFilterCopyWithFileInput.mockClear();
      mocks.executeFilterCopyWithFileInput.mockImplementation(async () => okResult({ created: 1 }));
      await executePlanApply(applyArgs(planPath));
      const applyCall = mocks.executeFilterCopyWithFileInput.mock.calls.at(-1);
      expect(applyCall?.[1]).toBe(destDir);
      expect((applyCall?.[2] as CopyOptions).cliSourceEntries).toEqual([{ path: srcDir }]);
    });

    it("a previewed file vanishing before the stat pass leaves the entry un-stamped", async () => {
      const fileA = join(srcDir, "a.flac");
      const ghost = join(srcDir, "ghost.flac");
      await createTestFile(fileA, "abcd");
      stubFilterCapture({
        mode: "filter",
        source: srcDir,
        preview: makeFilterPreview([
          { sourcePath: fileA, destPath: join(destDir, "liked-songs", "a.flac"), bytes: 4 },
          { sourcePath: ghost, destPath: join(destDir, "liked-songs", "ghost.flac"), bytes: 4 },
        ]),
      });

      const { plan } = await executePlanGeneration({
        destination: destDir,
        copyOptions: filterOptions(),
      });

      expect(plan.review.entries).toHaveLength(2);
      expect(plan.review.entries[0]?.sourceSize).toBeGreaterThan(0);
      expect(plan.review.entries[0]?.sourceMtimeMs).toBeGreaterThan(0);
      expect(plan.review.entries[1]?.sourcePath).toBe(ghost);
      expect(plan.review.entries[1]?.sourceSize).toBeUndefined();
      expect(plan.review.entries[1]?.sourceMtimeMs).toBeUndefined();
    });

    it("freezes --file sources into execution.cliSourceEntries (file kept as tracking id)", async () => {
      const dirA = join(srcDir, "a");
      const dirB = join(srcDir, "b");
      await mkdir(dirA);
      await mkdir(dirB);
      const sourcesFile = join(tmpBase, "sources.txt");
      await writeFile(sourcesFile, `${dirA}\n${dirB}\n`, "utf-8");
      stubFilterCapture(
        { mode: "filter", source: dirA, preview: makeFilterPreview([]) },
        { mode: "filter", source: dirB, preview: makeFilterPreview([]) },
      );

      const options = filterOptions({ file: sourcesFile, cliSourceEntries: undefined });
      const { plan } = await executePlanGeneration({ destination: destDir, copyOptions: options });

      const genOptions = lastDispatchedOptions();
      expect(genOptions.cliSourceEntries).toEqual([{ path: dirA }, { path: dirB }]);
      expect(plan.execution.cliSourceEntries).toEqual([{ path: dirA }, { path: dirB }]);
      expect(plan.execution.file).toBe(sourcesFile);
      // Every frozen source is fingerprinted, captured or not.
      expect(plan.fingerprints.sources.map((source) => source.path)).toEqual([
        resolve(dirA),
        resolve(dirB),
      ]);
    });

    it("serializes a plan with no plexToken anywhere even when options carry one", async () => {
      const { planPath } = await generateFilterPlan({
        plexToken: "secret-token-123",
        plexUrl: "http://plex.local:32400",
      });
      const content = await readFile(planPath, "utf-8");
      expect(content).not.toContain("plexToken");
      expect(content).not.toContain("secret-token-123");
      expect(content).toContain("plexUrl");
    });

    it("filter plans get per-entry sourceSize/truncated sourceMtimeMs from a stat pass", async () => {
      const fileA = join(srcDir, "a.flac");
      const fileB = join(srcDir, "b.flac");
      await createTestFile(fileA, "abcd");
      await createTestFile(fileB, "abcdef");
      const pinned = new Date(1_700_000_000_123);
      await utimes(fileA, pinned, pinned);

      stubFilterCapture({
        mode: "filter",
        source: srcDir,
        preview: makeFilterPreview([
          { sourcePath: fileA, destPath: join(destDir, "liked-songs", "a.flac"), bytes: 4 },
          { sourcePath: fileB, destPath: join(destDir, "liked-songs", "b.flac"), bytes: 6 },
        ]),
      });
      const { plan } = await executePlanGeneration({
        destination: destDir,
        copyOptions: filterOptions(),
      });

      const statA = await stat(fileA);
      const statB = await stat(fileB);
      expect(plan.review.entries[0]?.sourceSize).toBe(statA.size);
      expect(plan.review.entries[0]?.sourceMtimeMs).toBe(Math.trunc(statA.mtimeMs));
      expect(plan.review.entries[1]?.sourceSize).toBe(statB.size);
      expect(plan.review.entries[1]?.sourceMtimeMs).toBe(Math.trunc(statB.mtimeMs));
      expect(Number.isInteger(plan.review.entries[0]?.sourceMtimeMs)).toBe(true);
    });

    it("album plans fingerprint the top-level capture source, not per-album dirs", async () => {
      const artistDir = join(srcDir, "Artist");
      const albumDir = join(artistDir, "Album1");
      await createTestFile(join(albumDir, "01.flac"), "aaaa");
      const preview: PreviewResult = {
        albums: [
          {
            albumName: "Album1",
            sourcePath: albumDir,
            suffixes: [
              {
                suffix: "001",
                destPath: join(destDir, "Artist", "Album1-001"),
                action: "create",
                fileCount: 1,
                totalBytes: 4,
              },
              {
                suffix: "002",
                destPath: join(destDir, "Artist", "Album1-002"),
                action: "create",
                fileCount: 1,
                totalBytes: 4,
              },
            ],
            summary: { willCreate: 2, willSkip: 0, willOverwrite: 0, willRecreate: 0 },
          },
        ],
        totals: { files: 2, bytes: 8, creates: 2, skips: 0, overwrites: 0, recreates: 0 },
      };
      mocks.executeAlbumCopyWithFileInput.mockImplementation(
        async (_source: string | undefined, _destination: string, options: CopyOptions) => {
          options.capturePreview?.({ mode: "album", source: artistDir, preview });
          return okResult();
        },
      );
      const range = { start: 1, end: 2, padWidth: 3 };
      const options: CopyOptions = {
        mode: { type: "album", range },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 1,
        trackCompleted: false,
        cliRange: range,
        cliSourceEntries: [{ path: artistDir }],
      };
      const { plan } = await executePlanGeneration({ destination: destDir, copyOptions: options });

      expect(mocks.executeAlbumCopyWithFileInput).toHaveBeenCalledTimes(1);
      expect(mocks.executeFilterCopyWithFileInput).not.toHaveBeenCalled();
      expect(plan.fingerprints.sources).toHaveLength(1);
      expect(plan.fingerprints.sources[0]?.path).toBe(resolve(artistDir));
      expect(plan.fingerprints.sources[0]?.fileCount).toBe(1);
      expect(plan.review.granularity).toBe("suffix");
      expect(plan.review.entries).toHaveLength(2);
      expect(plan.review.entries[0]?.fileCount).toBe(1);
      expect(plan.review.entries[0]?.sourceSize).toBeUndefined();
      expect(plan.review.summary).toEqual({
        create: 2,
        skip: 0,
        overwrite: 0,
        incomplete: 0,
        filtered: 0,
        files: 2,
        bytes: 8,
      });
    });

    it("adds rangeExpansion for ranged filter plans", async () => {
      const sourceFile = join(srcDir, "ranged.flac");
      await createTestFile(sourceFile, "abcd");
      stubFilterCapture({
        mode: "filter",
        source: srcDir,
        preview: makeFilterPreview([
          { sourcePath: sourceFile, destPath: join(destDir, "liked-songs", "r.flac"), bytes: 4 },
        ]),
      });
      const { plan } = await executePlanGeneration({
        destination: destDir,
        copyOptions: filterOptions({}, { range: { start: 1, end: 2, padWidth: 3 } }),
      });
      expect(plan.review.rangeExpansion).toMatchObject({
        start: 1,
        end: 2,
        padWidth: 3,
        copiesPerEntry: 2,
      });
      expect(plan.review.rangeExpansion?.note).toContain("-001, -002");
    });

    it(
      "caps entries at 20000 with truncated: true and intact summary",
      { timeout: 60_000 },
      async () => {
        const sourceFile = join(srcDir, "big.flac");
        await createTestFile(sourceFile, "abcd");
        const tracks = Array.from({ length: COPY_PLAN_MAX_ENTRIES + 1 }, (_, index) => ({
          sourcePath: sourceFile,
          destPath: join(destDir, "liked-songs", `track-${index}.flac`),
          bytes: 4,
        }));
        stubFilterCapture({ mode: "filter", source: srcDir, preview: makeFilterPreview(tracks) });
        const { plan } = await executePlanGeneration({
          destination: destDir,
          copyOptions: filterOptions(),
        });
        expect(plan.review.entries).toHaveLength(COPY_PLAN_MAX_ENTRIES);
        expect(plan.review.truncated).toBe(true);
        expect(plan.review.summary.create).toBe(COPY_PLAN_MAX_ENTRIES + 1);
        expect(plan.fingerprints.sources).toHaveLength(1);
      },
    );

    it("writes to --plan-output verbatim and skips pruning; default path prunes to 50", async () => {
      await mkdir(planDir, { recursive: true });
      for (let index = 0; index < 55; index++) {
        const seed = join(planDir, `plan-seed-${String(index).padStart(2, "0")}.json`);
        await writeFile(seed, "{}", "utf-8");
        const old = new Date(1_000_000_000 + index * 60_000);
        await utimes(seed, old, old);
      }

      const custom = join(tmpBase, "out", "custom-plan.json");
      const first = await generateFilterPlan({}, custom);
      expect(first.planPath).toBe(custom);
      expect(await readFile(custom, "utf-8")).toContain('"version"');
      // Explicit --plan-output skips pruning entirely.
      expect(await listManagedPlans()).toHaveLength(55);

      const second = await generateFilterPlan();
      const managed = await listManagedPlans();
      expect(managed).toHaveLength(50);
      expect(managed).toContain(basename(second.planPath));
    });

    it("optionsKey matches formatOptionsHash(buildOptionsHash(options))", async () => {
      const { plan } = await generateFilterPlan({
        convertFormat: "alac",
        mode: {
          type: "filter",
          rating: {
            outputFolder: "liked-songs",
            preserveStructure: false,
            minStars: 4,
            range: { start: 1, end: 2, padWidth: 3 },
          },
        },
      });
      expect(plan.optionsKey).toBe("filter-s4-001-002-alac");
    });
  });

  // ==========================================================================
  // executePlanApply
  // ==========================================================================

  describe("executePlanApply", () => {
    it("dispatch parity: entry point receives options deep-equal to { ...plan.execution, dryRun: false } plus runtime hooks", async () => {
      const { planPath } = await generateFilterPlan();
      const plan = await readPlanArtifact(planPath);

      await executePlanApply(applyArgs(planPath));

      expect(mocks.executeFilterCopyWithFileInput).toHaveBeenCalledTimes(1);
      const call = mocks.executeFilterCopyWithFileInput.mock.calls.at(-1);
      expect(call?.[0]).toBeUndefined();
      expect(call?.[1]).toBe(destDir);
      const dispatched = call?.[2] as CopyOptions;
      expect(typeof dispatched.onHistorySession).toBe("function");
      const { onHistorySession: _hook, ...rest } = dispatched;
      expect(rest).toEqual({ ...plan.execution, dryRun: false });
    });

    it("blocks on staleness errors without --force-stale: entry point NOT called, audit status aborted-stale", async () => {
      const { planPath, plan, sourceFile } = await generateFilterPlan();
      await appendFile(sourceFile, "-drift");

      await expect(executePlanApply(applyArgs(planPath))).rejects.toBeInstanceOf(PlanStaleError);

      expect(mocks.executeFilterCopyWithFileInput).not.toHaveBeenCalled();
      const records = await readAuditRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        planId: plan.id,
        planPath: resolve(planPath),
        status: "aborted-stale",
        forcedStale: false,
        stalenessErrorsOverridden: [],
        counts: { created: 0, skipped: 0, failed: 0, filtered: 0 },
      });
    });

    it("proceeds with --force-stale and records stalenessErrorsOverridden codes in the audit record", async () => {
      const { planPath, sourceFile } = await generateFilterPlan();
      await appendFile(sourceFile, "-drift");

      const result = await executePlanApply(applyArgs(planPath, { forceStale: true }));

      expect(result.created).toBe(1);
      expect(mocks.executeFilterCopyWithFileInput).toHaveBeenCalledTimes(1);
      const records = await readAuditRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe("completed");
      expect(records[0]?.forcedStale).toBe(true);
      expect(records[0]?.stalenessErrorsOverridden).toEqual(
        expect.arrayContaining(["source-drift", "entry-drift"]),
      );
    });

    it("TTY decline -> aborted-user audit record, no dispatch", async () => {
      const { planPath } = await generateFilterPlan();
      setStdinTTY(true);
      mocks.confirm.mockResolvedValueOnce(false);

      const result = await executePlanApply(applyArgs(planPath, { yes: false }));

      expect(result).toEqual({ source: planPath, created: 0, skipped: 0, filtered: 0, failed: [] });
      expect(mocks.confirm).toHaveBeenCalledWith("Apply this plan?");
      expect(mocks.executeFilterCopyWithFileInput).not.toHaveBeenCalled();
      const records = await readAuditRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe("aborted-user");
    });

    it("non-TTY without --yes -> MissingRequiredArgumentError, no dispatch", async () => {
      const { planPath } = await generateFilterPlan();
      setStdinTTY(undefined);

      await expect(executePlanApply(applyArgs(planPath, { yes: false }))).rejects.toBeInstanceOf(
        MissingRequiredArgumentError,
      );
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.executeFilterCopyWithFileInput).not.toHaveBeenCalled();
      expect(await readAuditRecords()).toHaveLength(0);
    });

    it("machineOutput without --yes -> typed error", async () => {
      const { planPath } = await generateFilterPlan();
      setStdinTTY(true);

      await expect(
        executePlanApply(applyArgs(planPath, { yes: false, machineOutput: true })),
      ).rejects.toBeInstanceOf(MissingRequiredArgumentError);
      expect(mocks.executeFilterCopyWithFileInput).not.toHaveBeenCalled();
    });

    it("--yes skips confirmation entirely", async () => {
      const { planPath } = await generateFilterPlan();
      setStdinTTY(undefined);

      await executePlanApply(applyArgs(planPath, { yes: true }));

      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.executeFilterCopyWithFileInput).toHaveBeenCalledTimes(1);
    });

    it("frozen conflictStrategy 'ask' + non-TTY or machineOutput -> typed error, no dispatch", async () => {
      const { planPath } = await generateFilterPlan({ conflictStrategy: "ask" });

      setStdinTTY(undefined);
      await expect(executePlanApply(applyArgs(planPath))).rejects.toThrow(
        /froze conflict-strategy "ask"/,
      );

      setStdinTTY(true);
      await expect(
        executePlanApply(applyArgs(planPath, { machineOutput: true })),
      ).rejects.toBeInstanceOf(MissingRequiredArgumentError);

      expect(mocks.executeFilterCopyWithFileInput).not.toHaveBeenCalled();
      expect(await readAuditRecords()).toHaveLength(0);
    });

    it("frozen conflictStrategy 'ask' on a TTY proceeds (per-conflict prompting is designed)", async () => {
      const { planPath } = await generateFilterPlan({ conflictStrategy: "ask" });
      setStdinTTY(true);

      const result = await executePlanApply(applyArgs(planPath));

      expect(result.created).toBe(1);
      expect(mocks.executeFilterCopyWithFileInput).toHaveBeenCalledTimes(1);
    });

    it("convert plan pre-flights requireFfmpeg before dispatch", async () => {
      const { planPath } = await generateFilterPlan({ convertFormat: "alac" });
      mocks.requireFfmpeg.mockRejectedValueOnce(new Error("ffmpeg not found"));

      await expect(executePlanApply(applyArgs(planPath))).rejects.toThrow("ffmpeg not found");
      expect(mocks.executeFilterCopyWithFileInput).not.toHaveBeenCalled();

      // With ffmpeg present, apply proceeds through the same pre-flight.
      const result = await executePlanApply(applyArgs(planPath));
      expect(result.created).toBe(1);
      expect(mocks.requireFfmpeg).toHaveBeenCalledTimes(2);
      expect(mocks.executeFilterCopyWithFileInput).toHaveBeenCalledTimes(1);
    });

    it("warns when the audit ledger already contains this planId", async () => {
      const { planPath, plan } = await generateFilterPlan();
      await executePlanApply(applyArgs(planPath));
      mocks.logWarn.mockClear();

      await executePlanApply(applyArgs(planPath));

      const warned = mocks.logWarn.mock.calls.some((call) =>
        String(call[0]).includes(`Plan ${plan.id} was already applied`),
      );
      expect(warned).toBe(true);
      expect(await readAuditRecords()).toHaveLength(2);
    });

    it("partial failure -> result.failed propagated, audit status partial with counts.failed = failed.length", async () => {
      const { planPath } = await generateFilterPlan();
      mocks.executeFilterCopyWithFileInput.mockResolvedValueOnce(
        okResult({ created: 2, skipped: 1, failed: [{ path: "/broken.flac", message: "boom" }] }),
      );

      const result = await executePlanApply(applyArgs(planPath));

      expect(result.failed).toHaveLength(1);
      const records = await readAuditRecords();
      expect(records[0]?.status).toBe("partial");
      expect(records[0]?.counts).toEqual({ created: 2, skipped: 1, failed: 1, filtered: 0 });
    });

    it("zero-created failure -> audit status failed with counts created 0 / failed 1", async () => {
      const { planPath } = await generateFilterPlan();
      mocks.executeFilterCopyWithFileInput.mockResolvedValueOnce(
        okResult({ created: 0, failed: [{ path: "/broken.flac", message: "boom" }] }),
      );

      const result = await executePlanApply(applyArgs(planPath));

      expect(result.failed).toHaveLength(1);
      const records = await readAuditRecords();
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe("failed");
      expect(records[0]?.counts).toEqual({ created: 0, skipped: 0, failed: 1, filtered: 0 });
    });

    it("dispatch throw -> audit record status failed with zeroed counts, error rethrown", async () => {
      const { planPath, plan } = await generateFilterPlan();
      const boom = new Error("disk exploded mid-dispatch");
      mocks.executeFilterCopyWithFileInput.mockRejectedValueOnce(boom);

      await expect(executePlanApply(applyArgs(planPath))).rejects.toBe(boom);

      const records = await readAuditRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        planId: plan.id,
        planPath: resolve(planPath),
        status: "failed",
        counts: { created: 0, skipped: 0, failed: 0, filtered: 0 },
      });
    });

    it("captures historySessionId via onHistorySession into the audit record", async () => {
      const { planPath } = await generateFilterPlan();
      mocks.executeFilterCopyWithFileInput.mockImplementationOnce(
        async (_source: string | undefined, _destination: string, options: CopyOptions) => {
          options.onHistorySession?.("hist-session-123");
          return okResult({ created: 1 });
        },
      );

      await executePlanApply(applyArgs(planPath));

      const records = await readAuditRecords();
      expect(records[0]?.status).toBe("completed");
      expect(records[0]?.historySessionId).toBe("hist-session-123");
    });

    it("check mode (--apply --dry-run): fresh plan -> zero-result success, no dispatch, no audit", async () => {
      const { planPath } = await generateFilterPlan();

      const result = await executePlanApply(applyArgs(planPath, { dryRun: true, yes: false }));

      expect(result).toEqual({ source: planPath, created: 0, skipped: 0, filtered: 0, failed: [] });
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.executeFilterCopyWithFileInput).not.toHaveBeenCalled();
      expect(await readAuditRecords()).toHaveLength(0);
    });

    it("check mode: drifted plan -> PlanStaleError (exit-1 path), no dispatch", async () => {
      const { planPath, sourceFile } = await generateFilterPlan();
      await appendFile(sourceFile, "-drift");

      await expect(executePlanApply(applyArgs(planPath, { dryRun: true }))).rejects.toBeInstanceOf(
        PlanStaleError,
      );

      expect(mocks.executeFilterCopyWithFileInput).not.toHaveBeenCalled();
      // Check mode never writes audit records, even for the stale abort.
      expect(await readAuditRecords()).toHaveLength(0);
    });

    it("tampered plan -> PLAN_CHECKSUM_MISMATCH hard error even with --force-stale", async () => {
      const { planPath } = await generateFilterPlan();
      const parsed = JSON.parse(await readFile(planPath, "utf-8")) as Record<string, unknown>;
      parsed["destination"] = join(tmpBase, "evil-dest");
      await writeFile(planPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8");

      await expect(
        executePlanApply(applyArgs(planPath, { forceStale: true })),
      ).rejects.toMatchObject({ name: "PlanArtifactError", code: "PLAN_CHECKSUM_MISMATCH" });
      expect(mocks.executeFilterCopyWithFileInput).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Fidelity + round-trip contracts
  // ==========================================================================

  describe("fidelity contracts", () => {
    it("plan review entries deep-equal a plain dry-run preview (and are non-empty)", async () => {
      const actual = await vi.importActual<typeof import("./copy-filter.js")>("./copy-filter.js");
      await createTestFile(join(srcDir, "Album", "01.flac"), "alpha-audio");
      await createTestFile(join(srcDir, "Album", "02.flac"), "beta-audio-x");
      mocks.readRating.mockResolvedValue({ value: 1, source: "Vorbis" });

      const options = filterOptions();
      mocks.executeFilterCopyWithFileInput.mockImplementation(
        actual.executeFilterCopyWithFileInput,
      );
      const { plan } = await executePlanGeneration({ destination: destDir, copyOptions: options });

      const captures: PlanPreviewCapture[] = [];
      await actual.executeFilterCopyWithFileInput(undefined, destDir, {
        ...options,
        dryRun: true,
        capturePreview: (capture) => captures.push(capture),
      });

      const planTuples = plan.review.entries
        .map((entry) => `${entry.sourcePath}|${entry.destPath}|${entry.op}`)
        .sort();
      const previewTuples = captures
        .flatMap((capture) =>
          capture.mode === "filter"
            ? capture.preview.likedTracks.map(
                (track) => `${track.sourcePath}|${track.destPath}|${track.action}`,
              )
            : [],
        )
        .sort();

      // Non-empty guards against an empty-vs-empty false pass through any
      // future routing regression.
      expect(planTuples.length).toBeGreaterThan(0);
      expect(planTuples).toEqual(previewTuples);
    });

    it("smart-filter round-trip: serialized plan retains the recursive structure byte-for-byte and applies it", async () => {
      const smartFilter: SmartFilter = {
        match: "all",
        rules: [
          { type: "rule", field: "rating", operator: ">=", value: 4 },
          {
            type: "group",
            match: "any",
            rules: [
              { type: "rule", field: "genre", operator: "contains", value: "rock" },
              {
                type: "group",
                match: "all",
                rules: [{ type: "rule", field: "year", operator: ">=", value: 1990 }],
              },
            ],
          },
        ],
      };
      const sourceFile = join(srcDir, "01.flac");
      await createTestFile(sourceFile, "abcd");
      stubFilterCapture({
        mode: "filter",
        source: srcDir,
        preview: makeFilterPreview([
          { sourcePath: sourceFile, destPath: join(destDir, "liked-songs", "01.flac"), bytes: 4 },
        ]),
      });
      const options = filterOptions(
        { cliSourceEntries: [{ path: srcDir, filterName: "deep" }] },
        { minStars: undefined, smartFilter, filterName: "deep" },
      );
      const { planPath } = await executePlanGeneration({
        destination: destDir,
        copyOptions: options,
      });

      const reread = await readPlanArtifact(planPath);
      const rating =
        reread.execution.mode.type === "filter" ? reread.execution.mode.rating : undefined;
      expect(rating?.smartFilter).toEqual(smartFilter);
      // Byte-for-byte via the canonical key order (declaration order).
      expect(JSON.stringify(rating?.smartFilter)).toBe(JSON.stringify(smartFilter));

      mocks.executeFilterCopyWithFileInput.mockClear();
      mocks.executeFilterCopyWithFileInput.mockImplementation(async () => okResult({ created: 1 }));
      await executePlanApply(applyArgs(planPath));
      const dispatched = lastDispatchedOptions();
      expect(
        dispatched.mode.type === "filter" ? dispatched.mode.rating.smartFilter : undefined,
      ).toEqual(smartFilter);
    });
  });
});
