/**
 * End-to-end integration spec for the album plan/apply flow.
 *
 * Real filesystem, no entry-point mocks. RFMEDIA_PLAN_DIR points at a tmp
 * plans dir; tracking is disabled and the undo/history database is frozen to a
 * tmp path via trackingDatabase, so nothing touches $HOME.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { cleanupTempDir, createTempTestDir, createTestFile } from "../test-utils/filesystem.js";
import { executePlanApply, executePlanGeneration } from "./copy-plan.js";
import { findPlanApplications, readPlanArtifact } from "../lib/plan.js";
import { PlanStaleError } from "../lib/errors.js";
import { pathExists } from "../lib/filesystem.js";
import type { CopyOptions, CopyRange } from "../types/index.js";

/**
 * History session ids have second resolution ({timestamp}-{command}-{pid});
 * two applies inside the same second would collide on the UNIQUE session_id.
 */
async function waitForNextWallClockSecond(): Promise<void> {
  const msIntoSecond = Date.now() % 1000;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000 - msIntoSecond + 50));
}

describe("copy-plan integration (album end-to-end)", () => {
  let tmpBase: string;
  let planDir: string;
  let artistDir: string;
  let destDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpBase = await createTempTestDir("copy-plan-int-");
    planDir = join(tmpBase, "plans");
    artistDir = join(tmpBase, "library", "Artist");
    destDir = join(tmpBase, "dest");
    dbPath = join(tmpBase, "tracking.db");
    await createTestFile(join(artistDir, "Album1", "01.flac"), "alpha-alpha");
    await createTestFile(join(artistDir, "Album1", "02.flac"), "beta-beta-b");
    await mkdir(destDir, { recursive: true });
    vi.stubEnv("RFMEDIA_PLAN_DIR", planDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await cleanupTempDir(tmpBase);
  });

  it(
    "generates, blocks stale apply, force-applies to disk, and re-applies idempotently",
    { timeout: 30_000 },
    async () => {
      const range: CopyRange = { start: 1, end: 2, padWidth: 3 };
      const copyOptions: CopyOptions = {
        mode: { type: "album", range },
        albumOnly: false,
        hardlink: false,
        force: false,
        dryRun: false,
        workers: 1,
        trackCompleted: false,
        trackingDatabase: dbPath,
        cliRange: range,
        cliSourceEntries: [{ path: artistDir }],
      };

      // 1-2. Generate the plan; manifest entries must match the disk fixture.
      const { planPath, plan } = await executePlanGeneration({
        destination: destDir,
        copyOptions,
      });
      expect(plan.review.granularity).toBe("suffix");
      expect(plan.review.entries).toHaveLength(2);
      for (const entry of plan.review.entries) {
        expect(entry.op).toBe("create");
        expect(entry.fileCount).toBe(2);
      }
      expect(plan.review.summary.create).toBe(2);
      expect(plan.fingerprints.sources).toHaveLength(1);
      expect(plan.fingerprints.sources[0]?.path).toBe(resolve(artistDir));
      expect(plan.fingerprints.sources[0]?.fileCount).toBe(2);
      // payloadChecksum verifies through the hardened reader.
      const reread = await readPlanArtifact(planPath);
      expect(reread).toEqual(plan);
      // Generation was a dry run — nothing was written to the destination.
      expect(await pathExists(join(destDir, "Artist"))).toBe(false);

      // 3. Mutate a source file: apply without --force-stale must abort.
      await appendFile(join(artistDir, "Album1", "01.flac"), "-drift");
      await expect(
        executePlanApply({
          planPath,
          dryRun: false,
          yes: true,
          forceStale: false,
          machineOutput: false,
        }),
      ).rejects.toBeInstanceOf(PlanStaleError);
      expect(await pathExists(join(destDir, "Artist"))).toBe(false);
      let records = await findPlanApplications(plan.id);
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe("aborted-stale");

      // 4. Force-stale apply lands the files and audits the override.
      const applied = await executePlanApply({
        planPath,
        dryRun: false,
        yes: true,
        forceStale: true,
        machineOutput: false,
      });
      expect(applied.failed).toEqual([]);
      expect(applied.created).toBe(plan.review.summary.create);
      for (const suffix of ["001", "002"]) {
        expect(await pathExists(join(destDir, "Artist", `Album1-${suffix}`, "01.flac"))).toBe(true);
        expect(await pathExists(join(destDir, "Artist", `Album1-${suffix}`, "02.flac"))).toBe(true);
      }
      records = await findPlanApplications(plan.id);
      expect(records).toHaveLength(2);
      expect(records[1]?.status).toBe("completed");
      expect(records[1]?.forcedStale).toBe(true);
      expect(records[1]?.stalenessErrorsOverridden).toContain("source-drift");
      expect(records[1]?.historySessionId).toBeTruthy();
      expect(records[1]?.counts.created).toBe(applied.created);

      // 5. Second apply warns already-applied and skips existing copies.
      await waitForNextWallClockSecond();
      const stderrSpy = vi.spyOn(console, "error");
      const reapplied = await executePlanApply({
        planPath,
        dryRun: false,
        yes: true,
        forceStale: true,
        machineOutput: false,
      });
      expect(reapplied.failed).toEqual([]);
      expect(reapplied.created).toBe(0);
      expect(reapplied.skipped).toBeGreaterThan(0);
      const warned = stderrSpy.mock.calls.some((call) =>
        String(call[0]).includes("was already applied"),
      );
      expect(warned).toBe(true);
      records = await findPlanApplications(plan.id);
      expect(records).toHaveLength(3);
      expect(records[2]?.status).toBe("completed");
    },
  );
});
