import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLidarrClientMock } from "../../actions/test-helpers/lidarr-client-mocks.js";
import { createLidarrAlbumFixture } from "../../actions/test-helpers/lidarr-fixtures.js";
import { LidarrPlanValidationError } from "../errors.js";
import {
  LIDARR_PLAN_VERSION_V3,
  type LidarrAlbumMutationPlanV2,
  type LidarrCascadePolicy,
} from "../../types/lidarr-plan.js";
import {
  assertLidarrAlbumMutationPlanV2,
  computeLidarrPlanChecksum,
  createLidarrMutationExecutors,
  createLidarrMutationExecutorsWithAlbums,
  readLidarrPlanArtifact,
  writeLidarrPlanArtifact,
} from "./plan-engine.js";
import {
  buildLidarrAlbumMutationPlanV2,
  buildLidarrAlbumMutationPlanV3,
  getLidarrAlbumMutationOperationDefinition,
  isAlbumDeletePlanEntry,
  isAlbumEditPlanEntry,
  LIDARR_ALBUM_DELETE_OPERATION,
  LIDARR_ALBUM_EDIT_OPERATION,
} from "./plan-album-operations.js";

const BUILD_DEPENDENCIES = {
  randomUUID: () => "22222222-2222-4222-8222-222222222222",
  now: () => new Date("2026-07-24T12:00:00.000Z"),
  hostname: () => "test-host",
  username: () => "test-user",
  cwd: () => "/test/cwd",
  cliVersion: "0.5.0-test",
};

const ORIGIN = "https://lidarr.example.test";

const CASCADE_POLICY = Object.freeze({
  assumptions: Object.freeze({
    albumsPerArtist: null,
    indexerQueriesPerCandidate: 2,
  }),
  budgets: Object.freeze({
    indexerQueries: 10,
    acquisitionCandidates: 5,
  }),
}) satisfies LidarrCascadePolicy;

const tempRoots: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rfmedia-lidarr-album-plan-"));
  tempRoots.push(root);
  return root;
}

function makeEditPlan(): LidarrAlbumMutationPlanV2 {
  return buildLidarrAlbumMutationPlanV2(
    {
      origin: ORIGIN,
      selection: { kind: "album-filters", artistIds: [7], selectors: ["albums"] },
      operation: { kind: "album-edit", desiredAnyReleaseOk: false, selectors: ["albums"] },
      maxBatch: 25,
      entries: [
        {
          kind: "album-edit",
          albumId: 12,
          albumTitle: "Twelve",
          artistId: 7,
          artistName: "Seven",
          albumType: "Album",
          anyReleaseOk: true,
        },
        {
          kind: "album-edit",
          albumId: 4,
          albumTitle: "Four",
          artistId: 7,
          artistName: "Seven",
          anyReleaseOk: false,
        },
      ],
    },
    BUILD_DEPENDENCIES,
  );
}

function makeDeletePlan(): LidarrAlbumMutationPlanV2 {
  return buildLidarrAlbumMutationPlanV2(
    {
      origin: ORIGIN,
      selection: { kind: "album-ids", albumIds: [5, 9] },
      operation: {
        kind: "album-delete",
        deleteFiles: true,
        addImportListExclusion: false,
        includeMonitored: false,
        selectors: [],
      },
      maxBatch: 25,
      entries: [
        {
          kind: "album-delete",
          albumId: 9,
          albumTitle: "Nine",
          artistId: 3,
          artistName: "Three",
          foreignAlbumId: "mbid-9",
          monitored: false,
          trackFileCount: 10,
          sizeOnDisk: 1024,
        },
        {
          kind: "album-delete",
          albumId: 5,
          albumTitle: "Five",
          artistId: 2,
          artistName: "Two",
          monitored: false,
          trackFileCount: 0,
          sizeOnDisk: 0,
        },
      ],
    },
    BUILD_DEPENDENCIES,
  );
}

type MutableRecord = Record<string, unknown>;

function clonePlan(plan: LidarrAlbumMutationPlanV2): MutableRecord {
  return JSON.parse(JSON.stringify(plan)) as MutableRecord;
}

function planEntries(draft: MutableRecord): MutableRecord[] {
  return draft["entries"] as MutableRecord[];
}

describe("album mutation plan build and artifact round-trip", () => {
  it("builds a deterministic album-edit plan with a stable checksum", () => {
    const plan = makeEditPlan();

    expect(makeEditPlan()).toEqual(plan);
    expect(computeLidarrPlanChecksum(plan)).toBe(plan.payloadChecksum);
    expect(plan.operation.kind).toBe("album-edit");
    expect(plan.entries.map((entry) => entry.albumId)).toEqual([4, 12]);
    expect(plan.entries.map((entry) => entry.id)).toEqual(["album:4", "album:12"]);
    expect(plan.review).toEqual({ requested: 2, changed: 1, unchanged: 1 });
    expect(plan.summary).toEqual({ kind: "album-edit", changedToTrue: 0, changedToFalse: 1 });
    expect(plan.risk).toMatchObject({ level: "medium", destructive: false });
  });

  it("builds a deterministic album-delete plan with sealed destruction evidence", () => {
    const plan = makeDeletePlan();

    expect(makeDeletePlan()).toEqual(plan);
    expect(computeLidarrPlanChecksum(plan)).toBe(plan.payloadChecksum);
    expect(plan.operation).toMatchObject({
      kind: "album-delete",
      deleteFiles: true,
      addImportListExclusion: false,
    });
    expect(plan.entries.map((entry) => entry.albumId)).toEqual([5, 9]);
    expect(plan.review).toEqual({ requested: 2, changed: 2, unchanged: 0 });
    expect(plan.summary).toEqual({
      kind: "album-delete",
      albums: 2,
      withFiles: 1,
      totalTrackFiles: 10,
      totalSizeOnDisk: 1024,
      deleteFiles: true,
      importListExclusions: false,
    });
    expect(plan.risk).toMatchObject({ level: "high", destructive: true });
    expect(plan.risk.cascade.join(" ")).toMatch(/PERMANENTLY deleted/u);
    expect(plan.risk.cascade.join(" ")).toMatch(/re-added by import lists/u);
  });

  it("seals changed album-edit cascade exposure as unknown in v3", () => {
    const plan = buildLidarrAlbumMutationPlanV3(
      {
        origin: ORIGIN,
        selection: { kind: "album-filters", artistIds: [7], selectors: ["albums"] },
        operation: { kind: "album-edit", desiredAnyReleaseOk: false, selectors: ["albums"] },
        maxBatch: 25,
        entries: [
          {
            kind: "album-edit",
            albumId: 12,
            albumTitle: "Twelve",
            artistId: 7,
            artistName: "Seven",
            anyReleaseOk: true,
          },
        ],
        cascadePolicy: CASCADE_POLICY,
      },
      BUILD_DEPENDENCIES,
    );

    expect(plan.version).toBe(LIDARR_PLAN_VERSION_V3);
    expect(plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
      value: null,
      certainty: "unknown",
      horizon: "conditional",
      basis: "release-automation-evidence-unavailable",
    });
    expect(plan.cascadeAnalysis.metrics.conditionalIndexerQueries.value).toBeNull();
    expect(plan.cascadeAnalysis.budgets).toMatchObject({
      indexerQueries: { status: "unknown", limit: 10, projected: null },
      acquisitionCandidates: { status: "unknown", limit: 5, projected: null },
    });
    expect(plan.cascadeAnalysis.warnings.map((warning) => warning.metric)).toEqual([
      "indexerQueries",
      "acquisitionCandidates",
    ]);
    expect(computeLidarrPlanChecksum(plan)).toBe(plan.payloadChecksum);
  });

  it("seals album-delete as zero new acquisition exposure while preserving file evidence", () => {
    const plan = buildLidarrAlbumMutationPlanV3(
      {
        origin: ORIGIN,
        selection: { kind: "album-ids", albumIds: [5, 9] },
        operation: {
          kind: "album-delete",
          deleteFiles: true,
          addImportListExclusion: false,
          includeMonitored: false,
          selectors: [],
        },
        maxBatch: 25,
        entries: [
          {
            kind: "album-delete",
            albumId: 9,
            albumTitle: "Nine",
            artistId: 3,
            artistName: "Three",
            monitored: false,
            trackFileCount: 10,
            sizeOnDisk: 1024,
          },
          {
            kind: "album-delete",
            albumId: 5,
            albumTitle: "Five",
            artistId: 2,
            artistName: "Two",
            monitored: false,
            trackFileCount: 0,
            sizeOnDisk: 0,
          },
        ],
        cascadePolicy: CASCADE_POLICY,
      },
      BUILD_DEPENDENCIES,
    );

    expect(plan.entries.map((entry) => entry.albumId)).toEqual([5, 9]);
    expect(plan.cascadeAnalysis.metrics.acquisitionCandidates).toMatchObject({
      value: 0,
      certainty: "exact",
      basis: "operation-removes-acquisition-scope",
    });
    expect(plan.cascadeAnalysis.metrics.filesAffected).toMatchObject({
      value: 10,
      certainty: "exact",
      horizon: "immediate",
    });
    expect(plan.cascadeAnalysis.metrics.bytesAffected).toMatchObject({
      value: 1024,
      certainty: "exact",
      horizon: "immediate",
    });
    expect(plan.summary).toMatchObject({
      totalTrackFiles: 10,
      totalSizeOnDisk: 1024,
    });
    expect(plan.cascadeAnalysis.warnings).toEqual([]);
    expect(computeLidarrPlanChecksum(plan)).toBe(plan.payloadChecksum);
  });

  it("round-trips both kinds through write and read with byte-stable checksums", async () => {
    const root = await makeTempRoot();
    for (const [name, plan] of [
      ["album-edit.json", makeEditPlan()],
      ["album-delete.json", makeDeletePlan()],
    ] as const) {
      const path = join(root, name);
      await expect(writeLidarrPlanArtifact(path, plan)).resolves.toBe(path);
      const roundTrip = await readLidarrPlanArtifact(path);
      expect(roundTrip).toEqual(plan);
      expect(computeLidarrPlanChecksum(roundTrip)).toBe(plan.payloadChecksum);
      expect(() => assertLidarrAlbumMutationPlanV2(JSON.parse(JSON.stringify(plan)))).not.toThrow();
    }
  });

  it("rejects duplicate album ids", () => {
    expect(() =>
      buildLidarrAlbumMutationPlanV2(
        {
          origin: ORIGIN,
          selection: { kind: "album-filters", selectors: [] },
          operation: { kind: "album-edit", desiredAnyReleaseOk: true, selectors: [] },
          maxBatch: 25,
          entries: [
            {
              kind: "album-edit",
              albumId: 9,
              albumTitle: "Nine",
              artistId: 3,
              artistName: "Three",
              anyReleaseOk: false,
            },
            {
              kind: "album-edit",
              albumId: 9,
              albumTitle: "Nine again",
              artistId: 3,
              artistName: "Three",
              anyReleaseOk: false,
            },
          ],
        },
        BUILD_DEPENDENCIES,
      ),
    ).toThrow(/duplicate album id 9/u);
  });

  it("enforces maxBatch and rejects empty entry sets", () => {
    const source = {
      kind: "album-delete",
      albumId: 9,
      albumTitle: "Nine",
      artistId: 3,
      artistName: "Three",
      monitored: false,
      trackFileCount: 0,
      sizeOnDisk: 0,
    } as const;
    const input = {
      origin: ORIGIN,
      selection: { kind: "album-ids", albumIds: [9] } as const,
      operation: {
        kind: "album-delete",
        deleteFiles: false,
        addImportListExclusion: false,
        includeMonitored: false,
        selectors: [],
      } as const,
      maxBatch: 1,
      entries: [source, { ...source, albumId: 10 }],
    };
    expect(() => buildLidarrAlbumMutationPlanV2(input, BUILD_DEPENDENCIES)).toThrow(
      /entries exceed maxBatch/u,
    );
    expect(() =>
      buildLidarrAlbumMutationPlanV2({ ...input, entries: [] }, BUILD_DEPENDENCIES),
    ).toThrow(/entries must not be empty/u);
  });
});

describe("album plan tamper rejection", () => {
  it("rejects extra entry keys", () => {
    const draft = clonePlan(makeDeletePlan());
    planEntries(draft)[0]!["extra"] = true;
    expect(() => assertLidarrAlbumMutationPlanV2(draft)).toThrow(/unknown key/u);
  });

  it("rejects an id that does not match the albumId", () => {
    const draft = clonePlan(makeDeletePlan());
    planEntries(draft)[0]!["id"] = "album:999";
    expect(() => assertLidarrAlbumMutationPlanV2(draft)).toThrow(/does not match albumId/u);
  });

  it("rejects a non-positive albumId", () => {
    const draft = clonePlan(makeDeletePlan());
    planEntries(draft)[0]!["albumId"] = 0;
    planEntries(draft)[0]!["id"] = "album:0";
    expect(() => assertLidarrAlbumMutationPlanV2(draft)).toThrow(/positive safe integer/u);
  });

  it("rejects a delete after-state that is not exactly { deleted: true }", () => {
    const falseDraft = clonePlan(makeDeletePlan());
    planEntries(falseDraft)[0]!["after"] = { deleted: false };
    expect(() => assertLidarrAlbumMutationPlanV2(falseDraft)).toThrow(
      /after must be exactly \{ deleted: true \}/u,
    );
    const extraDraft = clonePlan(makeDeletePlan());
    planEntries(extraDraft)[0]!["after"] = { deleted: true, monitored: false };
    expect(() => assertLidarrAlbumMutationPlanV2(extraDraft)).toThrow(/unknown key/u);
  });

  it("rejects edit before/after shape mismatches and desired-state drift", () => {
    const beforeDraft = clonePlan(makeEditPlan());
    planEntries(beforeDraft)[0]!["before"] = { monitored: true };
    expect(() => assertLidarrAlbumMutationPlanV2(beforeDraft)).toThrow(/unknown key/u);

    const afterDraft = clonePlan(makeEditPlan());
    planEntries(afterDraft)[0]!["after"] = { anyReleaseOk: true };
    expect(() => assertLidarrAlbumMutationPlanV2(afterDraft)).toThrow(
      /after is inconsistent with plan.operation/u,
    );
  });

  it("rejects review.changed inconsistencies", () => {
    const draft = clonePlan(makeDeletePlan());
    draft["review"] = { requested: 2, changed: 1, unchanged: 1 };
    expect(() => assertLidarrAlbumMutationPlanV2(draft)).toThrow(
      /review counts do not match entries/u,
    );
  });

  it("rejects idempotencyKey mismatches", () => {
    const draft = clonePlan(makeDeletePlan());
    planEntries(draft)[0]!["idempotencyKey"] = `sha256:${"0".repeat(64)}`;
    expect(() => assertLidarrAlbumMutationPlanV2(draft)).toThrow(/idempotencyKey is inconsistent/u);
  });

  it("rejects risk mismatches against the recomputed operation risk", () => {
    const plan = makeDeletePlan();
    const draft = clonePlan(plan);
    draft["risk"] = { level: "low", destructive: false, cascade: [...plan.risk.cascade] };
    expect(() => assertLidarrAlbumMutationPlanV2(draft)).toThrow(
      /risk is inconsistent with plan.operation/u,
    );
  });

  it("rejects entries out of albumId order", () => {
    const draft = clonePlan(makeDeletePlan());
    (draft["entries"] as MutableRecord[]).reverse();
    expect(() => assertLidarrAlbumMutationPlanV2(draft)).toThrow(/sorted by unique albumId/u);
  });

  it("rejects album-ids selections that do not match the entries", () => {
    const draft = clonePlan(makeDeletePlan());
    draft["selection"] = { kind: "album-ids", albumIds: [5] };
    expect(() => assertLidarrAlbumMutationPlanV2(draft)).toThrow(
      /albumIds must match plan.entries/u,
    );
  });

  it("rejects artist-family selections on album plans", () => {
    const draft = clonePlan(makeDeletePlan());
    draft["selection"] = { kind: "all" };
    expect(() => assertLidarrAlbumMutationPlanV2(draft)).toThrow(
      /selection is inconsistent with plan.operation/u,
    );
  });

  it("rejects tampered delete summaries", () => {
    const countsDraft = clonePlan(makeDeletePlan());
    (countsDraft["summary"] as MutableRecord)["withFiles"] = 2;
    expect(() => assertLidarrAlbumMutationPlanV2(countsDraft)).toThrow(
      /summary counts are inconsistent/u,
    );
    const modeDraft = clonePlan(makeDeletePlan());
    (modeDraft["summary"] as MutableRecord)["deleteFiles"] = false;
    expect(() => assertLidarrAlbumMutationPlanV2(modeDraft)).toThrow(
      /summary is inconsistent with plan.operation/u,
    );
  });

  it("rejects artist plans presented as album plans", () => {
    expect(() =>
      assertLidarrAlbumMutationPlanV2({
        ...clonePlan(makeDeletePlan()),
        operation: { kind: "artist-monitoring", desiredMonitored: false },
      }),
    ).toThrow(LidarrPlanValidationError);
  });
});

describe("album deferred executors", () => {
  it("registers the two album executor identities beside the pinned four", () => {
    const pinned = [...createLidarrMutationExecutors().keys()];
    const extended = [...createLidarrMutationExecutorsWithAlbums().keys()];
    expect(extended).toEqual([
      ...pinned,
      LIDARR_ALBUM_EDIT_OPERATION,
      LIDARR_ALBUM_DELETE_OPERATION,
    ]);
  });

  it("replays exact album-edit payloads and rejects unknown keys", async () => {
    const client = createLidarrClientMock();
    const executor = createLidarrMutationExecutorsWithAlbums().get(LIDARR_ALBUM_EDIT_OPERATION);

    await executor?.execute({ albumId: 4, anyReleaseOk: false }, client);
    expect(client.setAlbumAnyReleaseOk).toHaveBeenCalledWith(4, false, undefined);
    await expect(
      executor?.execute({ albumId: 4, anyReleaseOk: false, extra: 1 }, client),
    ).rejects.toThrow(/unknown key/u);
  });

  it("replays exact album-delete payloads and rejects missing keys", async () => {
    const client = createLidarrClientMock();
    const executor = createLidarrMutationExecutorsWithAlbums().get(LIDARR_ALBUM_DELETE_OPERATION);

    await executor?.execute(
      { albumId: 9, deleteFiles: true, addImportListExclusion: false },
      client,
    );
    expect(client.deleteAlbum).toHaveBeenCalledWith(
      9,
      { deleteFiles: true, addImportListExclusion: false },
      undefined,
    );
    await expect(executor?.execute({ albumId: 9 }, client)).rejects.toThrow(
      /deleteFiles is required/u,
    );
  });
});

describe("album operation definition semantics", () => {
  it("classifies and verifies album-edit fail-closed against live state", () => {
    const plan = makeEditPlan();
    const definition = getLidarrAlbumMutationOperationDefinition(plan.operation);
    const entry = plan.entries[1]!;
    if (!isAlbumEditPlanEntry(entry)) throw new Error("expected an album-edit entry");

    expect(definition.classify(entry, undefined)).toBe("drifted");
    expect(
      definition.classify(entry, createLidarrAlbumFixture({ id: 12, anyReleaseOk: false })),
    ).toBe("satisfied");
    expect(
      definition.classify(entry, createLidarrAlbumFixture({ id: 12, anyReleaseOk: true })),
    ).toBe("ready");
    expect(definition.classify(entry, createLidarrAlbumFixture({ id: 12 }))).toBe("drifted");
    expect(definition.verify(entry, undefined)).toBe(false);
    expect(
      definition.verify(entry, createLidarrAlbumFixture({ id: 12, anyReleaseOk: false })),
    ).toBe(true);
  });

  it("classifies album-delete with missing==satisfied and drift fail-closed", () => {
    const plan = makeDeletePlan();
    const definition = getLidarrAlbumMutationOperationDefinition(plan.operation);
    const entry = plan.entries[1]!;
    if (!isAlbumDeletePlanEntry(entry)) throw new Error("expected an album-delete entry");
    expect(entry.albumId).toBe(9);

    expect(definition.classify(entry, undefined)).toBe("satisfied");
    expect(
      definition.classify(
        entry,
        createLidarrAlbumFixture({ id: 9, monitored: false, foreignAlbumId: "mbid-9" }),
      ),
    ).toBe("ready");
    expect(
      definition.classify(
        entry,
        createLidarrAlbumFixture({ id: 9, monitored: true, foreignAlbumId: "mbid-9" }),
      ),
    ).toBe("drifted");
    expect(
      definition.classify(
        entry,
        createLidarrAlbumFixture({ id: 9, monitored: false, foreignAlbumId: "mbid-other" }),
      ),
    ).toBe("drifted");
    expect(definition.verify(entry, undefined)).toBe(true);
    expect(definition.verify(entry, createLidarrAlbumFixture({ id: 9 }))).toBe(false);
  });

  it("loads targeted live states keyed by album entry id", async () => {
    const plan = makeDeletePlan();
    const definition = getLidarrAlbumMutationOperationDefinition(plan.operation);
    const present = createLidarrAlbumFixture({ id: 9, monitored: false });
    const client = createLidarrClientMock({ listAlbums: () => Promise.resolve([present]) });

    const states = await definition.loadCurrentStates(client, plan.entries);

    expect(client.listAlbums).toHaveBeenCalledWith({ albumIds: [5, 9], signal: undefined });
    expect(states.get("album:9")).toEqual(present);
    expect(states.has("album:5")).toBe(false);
  });

  it("dispatches sealed operation options and matches deferred intents exactly", async () => {
    const plan = makeDeletePlan();
    const definition = getLidarrAlbumMutationOperationDefinition(plan.operation);
    const entry = plan.entries[1]!;
    if (!isAlbumDeletePlanEntry(entry)) throw new Error("expected an album-delete entry");
    const client = createLidarrClientMock();

    await definition.execute(entry, client);
    expect(client.deleteAlbum).toHaveBeenCalledWith(
      9,
      { deleteFiles: true, addImportListExclusion: false },
      undefined,
    );
    const payload = definition.payloadFor(entry);
    expect(definition.matchesDeferredIntent(entry, LIDARR_ALBUM_DELETE_OPERATION, payload)).toBe(
      true,
    );
    expect(
      definition.matchesDeferredIntent(entry, LIDARR_ALBUM_DELETE_OPERATION, {
        ...payload,
        deleteFiles: false,
      }),
    ).toBe(false);
    expect(definition.matchesDeferredIntent(entry, LIDARR_ALBUM_EDIT_OPERATION, payload)).toBe(
      false,
    );
  });
});
