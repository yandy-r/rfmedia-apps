import { describe, expect, it } from "vitest";

import type { DbReconciliationInventoryCandidate } from "../types/db.js";
import type { MediaTrack } from "../types/media-server.js";
import {
  buildReconciliationPlan,
  buildReconciliationReport,
  normalizeReconciliationPath,
  ratingsShareNativeStep,
  reduceReconciliationStatus,
  resolveReconciliationStrategy,
  type ReconciliationFileInput,
} from "./reconciliation.js";

const scale = { min: 0, max: 10, step: 1 } as const;

function file(
  path: string,
  values: Partial<Extract<ReconciliationFileInput["metadata"], { state: "present" }>> = {},
  stat = { mtime: 10, size: 20 },
  ratingWriteProjection: ReconciliationFileInput["ratingWriteProjection"] = path.endsWith(".mp3")
    ? { encoding: "mp3-popm" }
    : { encoding: "unsupported" },
): ReconciliationFileInput {
  return {
    path,
    metadata: {
      state: "present",
      rating: 0.8,
      artist: "Artist",
      genre: "Rock",
      year: 2024,
      ...values,
    },
    stat,
    ratingWriteProjection,
  };
}

function row(
  id: number,
  path: string,
  values: Partial<DbReconciliationInventoryCandidate> = {},
): DbReconciliationInventoryCandidate {
  return {
    id,
    operation_id: id,
    source_path: `/source/${id}.mp3`,
    relative_path: `${id}.mp3`,
    mtime: 10,
    size: 20,
    rating: 0.8,
    genre: "Rock",
    year: 2024,
    bpm: null,
    artist: "Artist",
    dest_path: path,
    content_hash: null,
    copied_at: 1,
    ...values,
  };
}

function track(id: string, path: string, values: Partial<MediaTrack> = {}): MediaTrack {
  return {
    id,
    kind: "track",
    title: id,
    rating: 0.8,
    year: 2024,
    genres: ["Rock"],
    artist: "Artist",
    album: "Album",
    playCount: 0,
    durationMs: 1,
    filePath: path,
    ...values,
  };
}

function report(
  files: readonly ReconciliationFileInput[],
  rows: readonly DbReconciliationInventoryCandidate[],
  tracks: readonly MediaTrack[],
  serverRatingWritable = true,
) {
  return buildReconciliationReport({
    sourceRoot: "/music",
    files,
    databaseRows: rows,
    serverTracks: tracks,
    serverNativeRatingScale: scale,
    serverRatingWritable,
  });
}

describe("normalizeReconciliationPath", () => {
  it.each([
    ["/music/album/../track.mp3", "/music/track.mp3"],
    ["/music-archive/track.mp3", null],
    ["track.mp3", null],
    ["/outside/track.mp3", null],
  ])("normalizes and contains %s", (candidate, expected) => {
    expect(normalizeReconciliationPath("/music", candidate)).toBe(expected);
  });

  it("never joins records by basename", () => {
    const result = report(
      [file("/music/a/song.mp3")],
      [row(1, "/music/b/song.mp3")],
      [track("server", "/music/c/song.mp3")],
    );
    expect(result.records.map((record) => record.path)).toEqual([
      "/music/a/song.mp3",
      "/music/b/song.mp3",
      "/music/c/song.mp3",
    ]);
  });
});

describe("buildReconciliationReport", () => {
  it("classifies missing, failed, unavailable, invalid, and present evidence", () => {
    const result = report(
      [{ ...file("/music/a.mp3"), metadata: { state: "failed" } }],
      [row(1, "/music/a.mp3", { year: 99, rating: null })],
      [track("one", "/music/a.mp3", { genres: undefined })],
    );
    const rating = result.findings.find((finding) => finding.field === "rating");
    const genre = result.findings.find((finding) => finding.field === "genre");
    const year = result.findings.find((finding) => finding.field === "year");
    expect(rating?.evidence.map(({ state }) => state)).toEqual(["failed", "missing", "present"]);
    expect(genre?.evidence.map(({ state }) => state)).toEqual(["failed", "present", "unavailable"]);
    expect(year?.evidence.map(({ state }) => state)).toEqual(["failed", "invalid", "present"]);
  });

  it("preserves database and server duplicates as ambiguity", () => {
    const path = "/music/a.mp3";
    const result = report(
      [file(path)],
      [row(2, path), row(1, path)],
      [track("z", path), track("a", path)],
    );
    expect(result.findings.filter(({ field }) => field === null)).toMatchObject([
      { code: "ambiguous-database-entry", operationIds: [1, 2], serverTrackIds: ["a", "z"] },
      { code: "ambiguous-server-path", operationIds: [1, 2], serverTrackIds: ["a", "z"] },
    ]);
  });

  it("uses native server precision while retaining exact file/database comparison", () => {
    expect(ratingsShareNativeStep(0.8, 0.84, scale)).toBe(true);
    const nativeEqual = report(
      [file("/music/a.mp3", { rating: 0.8 })],
      [row(1, "/music/a.mp3", { rating: 0.8 })],
      [track("one", "/music/a.mp3", { rating: 0.84 })],
    );
    expect(nativeEqual.findings.find(({ field }) => field === "rating")?.code).toBe("in-sync");

    const exactConflict = report(
      [file("/music/a.mp3", { rating: 0.81 })],
      [row(1, "/music/a.mp3", { rating: 0.8 })],
      [track("one", "/music/a.mp3", { rating: 0.8 })],
    );
    expect(exactConflict.findings.find(({ field }) => field === "rating")?.code).toBe(
      "conflicting-value",
    );
  });

  it("normalizes text and validates years for comparison", () => {
    const equal = report(
      [file("/music/a.mp3", { artist: "  CAFE\u0301 ", genre: "ROCK" })],
      [row(1, "/music/a.mp3", { artist: "café", genre: " rock " })],
      [track("one", "/music/a.mp3", { artist: "CAFÉ", genres: ["Rock"] })],
    );
    expect(equal.findings.find(({ field }) => field === "artist")?.code).toBe("in-sync");
    expect(equal.findings.find(({ field }) => field === "genre")?.code).toBe("in-sync");

    const invalid = report(
      [file("/music/a.mp3", { year: Number.NaN })],
      [row(1, "/music/a.mp3")],
      [track("one", "/music/a.mp3")],
    );
    expect(invalid.findings.find(({ field }) => field === "year")?.evidence[0]?.state).toBe(
      "invalid",
    );
  });

  it("emits stable IDs and ordering independent of input order", () => {
    const inputs = {
      files: [file("/music/b.mp3"), file("/music/a.mp3")],
      rows: [row(2, "/music/b.mp3"), row(1, "/music/a.mp3")],
      tracks: [track("b", "/music/b.mp3"), track("a", "/music/a.mp3")],
    };
    const forward = report(inputs.files, inputs.rows, inputs.tracks);
    const reverse = report(
      [...inputs.files].reverse(),
      [...inputs.rows].reverse(),
      [...inputs.tracks].reverse(),
    );
    expect(forward.findings.map(({ id }) => id)).toEqual(reverse.findings.map(({ id }) => id));
    expect(forward.findings[0]?.path).toBe("/music/a.mp3");
  });
});

describe("strategy and planning", () => {
  it.each([
    [{ fileWins: true }, "file-wins"],
    [{ dbWins: true }, "db-wins"],
    [{ serverWins: true }, "server-wins"],
  ] as const)("resolves exactly one winner", (flags, expected) => {
    expect(resolveReconciliationStrategy(flags)).toBe(expected);
  });

  it("rejects zero or multiple winners", () => {
    expect(() => resolveReconciliationStrategy({})).toThrow(/Exactly one/);
    expect(() => resolveReconciliationStrategy({ fileWins: true, dbWins: true })).toThrow(
      /Exactly one/,
    );
  });

  it("plans rating targets and a separate database-stat outcome", () => {
    const path = "/music/a.mp3";
    const plan = buildReconciliationPlan(
      report(
        [file(path, { rating: 0.9 }, { mtime: 12, size: 22 })],
        [row(1, path, { rating: 0.7 })],
        [track("one", path, { rating: 0.6 })],
      ),
      "file-wins",
    );
    expect(plan.outcomes).toMatchObject([
      { kind: "database-stat", target: "database", inventoryRowId: 1 },
      { kind: "rating", target: "database", intended: 0.9 },
      { kind: "rating", target: "server", intended: 0.9 },
    ]);
  });

  it("blocks a required server write when the adapter is read-only", () => {
    const path = "/music/a.mp3";
    const plan = buildReconciliationPlan(
      report(
        [file(path, { rating: 0.9 })],
        [row(1, path, { rating: 0.9 })],
        [track("one", path, { rating: 0.6 })],
        false,
      ),
      "file-wins",
    );

    expect(plan.executable).toBe(false);
    expect(plan.blockers).toContainEqual({
      operation: "rating",
      path,
      field: "rating",
      authority: "file",
      target: "server",
      code: "unsupported-target",
    });
    expect(plan.outcomes).toEqual([]);
  });

  it("projects only the file target under server authority", () => {
    const path = "/music/a.mp3";
    const intended = 203 / 254;
    const scan = report(
      [file(path, { rating: 0.81 })],
      [row(1, path, { rating: 0.8 })],
      [track("one", path, { rating: 0.8 })],
    );
    const plan = buildReconciliationPlan(scan, "server-wins");

    expect(scan.findings.find(({ field }) => field === "rating")?.code).toBe("conflicting-value");
    expect(plan.blockers).toEqual([]);
    expect(plan.outcomes).toEqual([
      {
        kind: "rating",
        path,
        target: "file",
        status: "planned",
        code: "planned",
        before: 0.81,
        intended,
      },
    ]);
  });

  it("blocks an unrepresentable zero file target before authorization", () => {
    const path = "/music/a.mp3";
    const plan = buildReconciliationPlan(
      report(
        [file(path, { rating: 0.8 })],
        [row(1, path, { rating: 0 })],
        [track("one", path, { rating: 0.8 })],
      ),
      "db-wins",
    );

    expect(plan).toMatchObject({
      executable: false,
      outcomes: [],
      blockers: [
        {
          operation: "rating",
          path,
          authority: "database",
          target: "file",
          code: "unsupported-target",
        },
      ],
    });
  });

  it("preserves the database authority while projecting the MP3 target", () => {
    const path = "/music/a.mp3";
    const intended = 85 / 254;
    const initial = buildReconciliationPlan(
      report(
        [file(path, { rating: 0.2 })],
        [row(1, path, { rating: 0.333 })],
        [track("one", path, { rating: 0.2 })],
      ),
      "db-wins",
    );

    expect(initial.blockers).toEqual([]);
    expect(initial.outcomes).toMatchObject([
      { kind: "rating", target: "file", intended },
      { kind: "rating", target: "server", intended: 0.333 },
    ]);

    const postScan = report(
      [file(path, { rating: intended })],
      [row(1, path, { rating: 0.333 })],
      [track("one", path, { rating: 0.3 })],
    );
    const converged = buildReconciliationPlan(postScan, "db-wins");
    expect(converged.blockers).toEqual([]);
    expect(converged.outcomes).toEqual([]);
  });

  it("keeps non-rating residuals observation-only and non-blocking", () => {
    const path = "/music/a.mp3";
    const scan = report(
      [file(path, { artist: "File" })],
      [row(1, path, { artist: "Database" })],
      [track("one", path, { artist: "Server" })],
    );
    const plan = buildReconciliationPlan(scan, "file-wins");
    expect(scan.observedResiduals.map(({ field }) => field)).toContain("artist");
    expect(plan.blockers).toEqual([]);
    expect(plan.outcomes).toEqual([]);
    expect(plan.executable).toBe(true);
  });

  it("fails closed globally unless allowPartial admits independent records", () => {
    const blocked = "/music/a.ogg";
    const actionable = "/music/b.mp3";
    const scan = report(
      [file(blocked, { rating: 0.9 }), file(actionable, { rating: 0.9 })],
      [row(1, blocked, { rating: 0.7 }), row(2, actionable, { rating: 0.7 })],
      [track("a", blocked, { rating: 0.9 }), track("b", actionable, { rating: 0.9 })],
    );
    const closed = buildReconciliationPlan(scan, "db-wins");
    expect(closed.executable).toBe(false);
    expect(closed.outcomes.some(({ path }) => path === actionable)).toBe(true);

    const partial = buildReconciliationPlan(scan, "db-wins", true);
    expect(partial.executable).toBe(true);
    expect(partial.incomplete).toBe(true);
    expect(partial.actionablePaths).toEqual([actionable]);
    expect(partial.outcomes.every(({ path }) => path === actionable)).toBe(true);
  });
});

describe("reduceReconciliationStatus", () => {
  it("keeps blocked preview successful but execution nonzero", () => {
    expect(
      reduceReconciliationStatus({
        mode: "apply",
        executed: false,
        executable: false,
      }),
    ).toEqual({ status: "preview", success: true, exitCode: 0 });
    expect(
      reduceReconciliationStatus({
        mode: "apply",
        executed: true,
        executable: false,
      }),
    ).toEqual({ status: "blocked", success: false, exitCode: 1 });
  });

  it("reports partial when a requested mutation applied before a later failure", () => {
    expect(
      reduceReconciliationStatus({
        mode: "apply",
        executed: true,
        executable: true,
        outcomes: [
          {
            kind: "rating",
            path: "/music/a.mp3",
            target: "file",
            before: 0.7,
            intended: 0.9,
            status: "applied",
            code: "applied",
          },
          {
            kind: "rating",
            path: "/music/a.mp3",
            target: "server",
            before: 0.7,
            intended: 0.9,
            status: "failed",
            code: "write-failed",
          },
        ],
        postApply: {
          status: "incomplete",
          checkedPaths: 0,
          requestedRatingDrift: 0,
          pendingDatabaseStatRefreshes: 1,
          findings: [],
          blockers: [],
          failureCodes: ["write-failed"],
        },
        failureCodes: ["write-failed"],
      }),
    ).toEqual({ status: "partial", success: false, exitCode: 1 });
  });
});
