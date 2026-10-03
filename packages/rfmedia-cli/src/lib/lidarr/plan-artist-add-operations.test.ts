import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  LidarrArtistAddExtendedPlanV2,
  LidarrArtistAddPlanV2,
} from "../../types/lidarr-plan.js";
import {
  appendLidarrPlanHistory,
  assertLidarrArtistAddPlanV2,
  buildLidarrArtistAddPlanV2,
  computeLidarrPlanChecksum,
  createLidarrMutationExecutors,
  readLidarrPlanArtifact,
  readLidarrPlanHistory,
  selectLidarrResumeEntries,
  writeLidarrPlanArtifact,
} from "./plan-engine.js";
import { getLidarrArtistAddOperationDefinition } from "./plan-operation-definitions.js";

const FOREIGN_ARTIST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_FOREIGN_ARTIST_ID = "33333333-3333-4333-8333-333333333333";
const BUILD_DEPENDENCIES = {
  randomUUID: () => "22222222-2222-4222-8222-222222222222",
  now: () => new Date("2026-07-25T12:00:00.000Z"),
  hostname: () => "test-host",
  username: () => "test-user",
  cwd: () => "/test/cwd",
  cliVersion: "0.5.0-test",
};
const tempRoots: string[] = [];

function assertExtendedPlanFixture(
  plan: LidarrArtistAddPlanV2,
): asserts plan is LidarrArtistAddExtendedPlanV2 {
  if (
    !("postAddUnmonitorSelectors" in plan.operation) ||
    !("postAddUnmonitorSelectors" in plan.entries[0].after)
  ) {
    throw new Error("extended fixture must build an extended plan");
  }
}

function makePlan(): LidarrArtistAddPlanV2 {
  return buildLidarrArtistAddPlanV2(
    {
      origin: "https://lidarr.example.test",
      operation: {
        kind: "artist-add",
        rootFolder: { id: 3, path: "/music" },
        qualityProfile: { id: 5, name: "Lossless" },
        metadataProfile: { id: 7, name: "Standard" },
        monitored: false,
        monitorNewItems: "none",
        searchForMissingAlbums: false,
      },
      entry: {
        artistName: "Exact Artist",
        foreignArtistId: FOREIGN_ARTIST_ID,
        provenance: {
          source: "lastfm",
          method: "artist.getSimilar",
          seedArtist: "Seed Artist",
          similarity: 0.94,
          candidateUrl: "https://www.last.fm/music/Exact+Artist",
          discoveredAt: "2026-07-25T11:59:00.000Z",
        },
      },
    },
    BUILD_DEPENDENCIES,
  );
}

function makeMultiPlan(): LidarrArtistAddPlanV2 {
  return buildLidarrArtistAddPlanV2(
    {
      origin: "https://lidarr.example.test",
      operation: {
        kind: "artist-add",
        rootFolder: { id: 3, path: "/music" },
        qualityProfile: { id: 5, name: "Lossless" },
        metadataProfile: { id: 7, name: "Standard" },
        monitored: false,
        monitorNewItems: "none",
        searchForMissingAlbums: false,
      },
      entries: [
        {
          artistName: "Exact Artist",
          foreignArtistId: FOREIGN_ARTIST_ID,
          provenance: {
            source: "lastfm",
            method: "artist.getSimilar",
            seedArtist: "Seed Artist",
            similarity: 0.94,
            candidateUrl: "https://www.last.fm/music/Exact+Artist",
            discoveredAt: "2026-07-25T11:59:00.000Z",
            selectedRank: 2,
            parentArtist: "Seed Artist",
            depth: 1,
            providerRank: 3,
            firstSeenSequence: 1,
            firstPath: ["Seed Artist", "Exact Artist"],
            adjustedScore: 0.95,
            exposureCount: 26,
            popularityEvidence: "graph-exposure",
          },
        },
        {
          artistName: "Second Artist",
          foreignArtistId: SECOND_FOREIGN_ARTIST_ID,
          provenance: {
            source: "lastfm",
            method: "artist.getSimilar",
            seedArtist: "Seed Artist",
            similarity: 0.88,
            candidateUrl: "https://www.last.fm/music/Second+Artist",
            discoveredAt: "2026-07-25T11:59:01.000Z",
            selectedRank: 100,
            parentArtist: "Related Artist",
            depth: 2,
            providerRank: 1,
            firstSeenSequence: 4,
            firstPath: ["Seed Artist", "Related Artist", "Second Artist"],
            adjustedScore: 0.9,
            exposureCount: 1,
          },
        },
      ],
    },
    BUILD_DEPENDENCIES,
  );
}

function makeExtendedPlan(): LidarrArtistAddExtendedPlanV2 {
  const plan = buildLidarrArtistAddPlanV2(
    {
      origin: "https://lidarr.example.test",
      operation: {
        kind: "artist-add",
        rootFolder: { id: 3, path: "/music" },
        qualityProfile: { id: 5, name: "Lossless" },
        metadataProfile: { id: 7, name: "Albums Only" },
        monitored: true,
        monitorNewItems: "none",
        searchForMissingAlbums: false,
        postAddUnmonitorSelectors: ["singles", "albums", "singles"],
      },
      entry: {
        artistName: "Exact Artist",
        foreignArtistId: FOREIGN_ARTIST_ID,
        provenance: {
          source: "lastfm",
          method: "artist.getSimilar",
          seedArtist: "Seed Artist",
          similarity: 0.94,
          candidateUrl: "https://www.last.fm/music/Exact+Artist",
          discoveredAt: "2026-07-25T11:59:00.000Z",
        },
      },
    },
    BUILD_DEPENDENCIES,
  );
  assertExtendedPlanFixture(plan);
  return plan;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("foreign-ID artist-add plan contracts", () => {
  it("seals one deterministic expected-absent entry and round-trips exactly", async () => {
    const plan = makePlan();
    const repeated = makePlan();
    const root = await mkdtemp(join(tmpdir(), "rfmedia-lidarr-artist-add-plan-"));
    tempRoots.push(root);
    const path = join(root, "plan.json");

    expect(plan.selection).toEqual({
      kind: "foreign-artist-id",
      foreignArtistId: FOREIGN_ARTIST_ID,
    });
    expect(plan.entries).toEqual([
      expect.objectContaining({
        id: `artist:${FOREIGN_ARTIST_ID}`,
        foreignArtistId: FOREIGN_ARTIST_ID,
        before: { exists: false },
        after: expect.objectContaining({
          exists: true,
          monitored: false,
          monitorNewItems: "none",
          searchForMissingAlbums: false,
        }),
      }),
    ]);
    expect(plan.entries[0].idempotencyKey).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(repeated.payloadChecksum).toBe(plan.payloadChecksum);
    expect(repeated.entries[0].idempotencyKey).toBe(plan.entries[0].idempotencyKey);
    expect(computeLidarrPlanChecksum(plan)).toBe(plan.payloadChecksum);
    expect(() => assertLidarrArtistAddPlanV2(plan)).not.toThrow();
    expect(plan.payloadChecksum).toBe(
      "sha256:6b6d6e4153a00931b7876c731c3449c8f7c55906c7e1053a7fa7b3acef2aeec1",
    );

    await writeLidarrPlanArtifact(path, plan);
    await expect(readLidarrPlanArtifact(path)).resolves.toEqual(plan);
  });

  it("canonicalizes extended monitoring and post-add normalization into the sealed plan", () => {
    const plan = makeExtendedPlan();
    const repeated = makeExtendedPlan();

    expect(plan.operation).toMatchObject({
      monitored: true,
      postAddUnmonitorSelectors: ["albums", "singles"],
    });
    expect(plan.entries[0].after).toMatchObject({
      monitored: true,
      postAddUnmonitorSelectors: ["albums", "singles"],
    });
    expect(plan.risk.cascade).toEqual([
      "The artist is added monitored.",
      "New albums are not monitored automatically.",
      "No missing-album search is triggered.",
      "Post-add albums matching these sealed types are unmonitored: albums, singles.",
    ]);
    expect(repeated.payloadChecksum).toBe(plan.payloadChecksum);
    expect(repeated.entries[0].idempotencyKey).toBe(plan.entries[0].idempotencyKey);
    expect(plan.entries[0].idempotencyKey).not.toBe(makePlan().entries[0].idempotencyKey);
    expect(computeLidarrPlanChecksum(plan)).toBe(plan.payloadChecksum);
    expect(() => assertLidarrArtistAddPlanV2(plan)).not.toThrow();
  });

  it("rejects unknown post-add selectors at producer and exact artifact boundaries", () => {
    const plan = makeExtendedPlan();
    const unknownSelectors = ["future-releases"];

    expect(() =>
      getLidarrArtistAddOperationDefinition({
        ...plan.operation,
        postAddUnmonitorSelectors: unknownSelectors,
      }),
    ).toThrow(/not a supported album type selector/iu);

    const artifact = structuredClone(plan);
    Object.assign(artifact.operation, {
      postAddUnmonitorSelectors: unknownSelectors,
    });
    Object.assign(artifact.entries[0].after, {
      postAddUnmonitorSelectors: unknownSelectors,
    });

    expect(() => assertLidarrArtistAddPlanV2(artifact)).toThrow(
      /not a supported album type selector/iu,
    );
  });

  it("seals multi-MBID entries in approved visible-rank order and round-trips stably", async () => {
    const plan = makeMultiPlan();
    const repeated = makeMultiPlan();
    const root = await mkdtemp(join(tmpdir(), "rfmedia-lidarr-multi-artist-add-plan-"));
    tempRoots.push(root);
    const path = join(root, "plan.json");

    expect(plan.selection).toEqual({
      kind: "foreign-artist-ids",
      foreignArtistIds: [FOREIGN_ARTIST_ID, SECOND_FOREIGN_ARTIST_ID],
    });
    expect(plan.maxBatch).toBe(2);
    expect(plan.review).toEqual({ requested: 2, changed: 2, unchanged: 0 });
    expect(plan.summary).toEqual({ kind: "artist-add", artists: 2 });
    expect(plan.entries.map((entry) => entry.provenance.selectedRank)).toEqual([2, 100]);
    expect(plan.entries[0]?.provenance.exposureCount).toBe(26);
    expect(repeated.payloadChecksum).toBe(plan.payloadChecksum);
    expect(computeLidarrPlanChecksum(plan)).toBe(plan.payloadChecksum);

    await writeLidarrPlanArtifact(path, plan);
    await expect(readLidarrPlanArtifact(path)).resolves.toEqual(plan);

    const tampered = structuredClone(plan);
    Object.assign(tampered.entries[0].provenance, { adjustedScore: 0.1 });
    await expect(writeLidarrPlanArtifact(join(root, "tampered.json"), tampered)).rejects.toThrow(
      /checksum/iu,
    );
  });

  it.each([
    [
      "zero depth",
      (provenance: LidarrArtistAddPlanV2["entries"][number]["provenance"]) =>
        Object.assign(provenance, { depth: 0 }),
      /positive safe integer/iu,
    ],
    [
      "a path length that contradicts depth",
      (provenance: LidarrArtistAddPlanV2["entries"][number]["provenance"]) =>
        Object.assign(provenance, {
          firstPath: ["Seed Artist", "Unexpected Artist", "Exact Artist"],
        }),
      /firstPath must match/iu,
    ],
    [
      "a path that contradicts its parent",
      (provenance: LidarrArtistAddPlanV2["entries"][number]["provenance"]) =>
        Object.assign(provenance, { parentArtist: "Unexpected Artist" }),
      /firstPath must match/iu,
    ],
    [
      "a path that contradicts the planned artist",
      (provenance: LidarrArtistAddPlanV2["entries"][number]["provenance"]) =>
        Object.assign(provenance, { firstPath: ["Seed Artist", "Unexpected Artist"] }),
      /firstPath must match/iu,
    ],
  ])("rejects extended provenance with %s", (_label, mutate, expected) => {
    const plan = structuredClone(makeMultiPlan());
    const provenance = plan.entries[0]?.provenance;
    if (provenance === undefined) throw new Error("multi-entry fixture requires provenance");
    mutate(provenance);

    expect(() => assertLidarrArtistAddPlanV2(plan)).toThrow(expected);
  });

  it("rejects duplicate MBIDs, entry-order tampering, and mismatched selection order", () => {
    const duplicateInput = {
      ...makeMultiPlan(),
      entries: [makeMultiPlan().entries[0], makeMultiPlan().entries[0]],
    };
    const reordered = structuredClone(makeMultiPlan());
    const reversedSelection = structuredClone(makeMultiPlan());
    Object.assign(reordered, { entries: [...reordered.entries].reverse() });
    if (reversedSelection.selection.kind === "foreign-artist-ids") {
      Object.assign(reversedSelection.selection, {
        foreignArtistIds: [...reversedSelection.selection.foreignArtistIds].reverse(),
      });
    }

    expect(() => assertLidarrArtistAddPlanV2(duplicateInput)).toThrow(/duplicate/iu);
    expect(() => assertLidarrArtistAddPlanV2(reordered)).toThrow(/selected-rank order/iu);
    expect(() => assertLidarrArtistAddPlanV2(reversedSelection)).toThrow(/match.*in order/iu);
  });

  it("requires maxBatch to equal the bounded artist-add entry count", () => {
    const wrongBatch = structuredClone(makeMultiPlan());
    const oversized = structuredClone(makeMultiPlan());
    Object.assign(wrongBatch, { maxBatch: 3 });
    Object.assign(oversized, {
      entries: Array.from({ length: 26 }, (_, index) => ({
        ...structuredClone(makeMultiPlan().entries[0]),
        id: `artist:${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
        foreignArtistId: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
      })),
      maxBatch: 26,
    });

    expect(() => assertLidarrArtistAddPlanV2(wrongBatch)).toThrow(/maxBatch.*entries.length/iu);
    expect(() => assertLidarrArtistAddPlanV2(oversized)).toThrow(/exceeds its bound/iu);
  });

  it("rejects policy drift and unknown keys under exact-key parsing", () => {
    const plan = makePlan();
    const policyDrift = structuredClone(plan);
    const unknownKey = structuredClone(plan) as typeof plan & { unexpected?: string };
    Object.assign(policyDrift.operation, { monitored: true });
    unknownKey.unexpected = "not-allowed";

    expect(() => assertLidarrArtistAddPlanV2(policyDrift)).toThrow(/policy/iu);
    expect(() => assertLidarrArtistAddPlanV2(unknownKey)).toThrow(/unknown key/iu);
  });

  it("rejects legacy/extended hybrids and non-canonical selector arrays", () => {
    const legacyOperationHybrid = structuredClone(makePlan());
    const extendedEntryHybrid = structuredClone(makeExtendedPlan());
    const duplicateSelectors = structuredClone(makeExtendedPlan());
    const mismatchedSelectors = structuredClone(makeExtendedPlan());

    Object.assign(legacyOperationHybrid.operation, {
      postAddUnmonitorSelectors: [],
    });
    Reflect.deleteProperty(extendedEntryHybrid.entries[0].after, "postAddUnmonitorSelectors");
    Object.assign(duplicateSelectors.operation, {
      postAddUnmonitorSelectors: ["albums", "albums"],
    });
    Object.assign(mismatchedSelectors.entries[0].after, {
      postAddUnmonitorSelectors: ["singles"],
    });

    expect(() => assertLidarrArtistAddPlanV2(legacyOperationHybrid)).toThrow(/required/iu);
    expect(() => assertLidarrArtistAddPlanV2(extendedEntryHybrid)).toThrow(/required/iu);
    expect(() => assertLidarrArtistAddPlanV2(duplicateSelectors)).toThrow(/sorted and unique/iu);
    expect(() => assertLidarrArtistAddPlanV2(mismatchedSelectors)).toThrow(/inconsistent/iu);
  });

  it("round-trips normalization stages for resume and skips terminal verified success", async () => {
    const plan = makeExtendedPlan();
    const entry = plan.entries[0];
    const root = await mkdtemp(join(tmpdir(), "rfmedia-lidarr-normalization-history-"));
    tempRoots.push(root);
    const historyPath = join(root, "history.jsonl");
    const normalizationPending = {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      entryId: entry.id,
      foreignArtistId: entry.foreignArtistId,
      lidarrId: 41,
      recordedAt: "2026-07-25T12:01:00.000Z",
      outcome: "creation-verified-normalization-pending" as const,
      idempotencyKey: entry.idempotencyKey,
    };
    const verificationPending = {
      ...normalizationPending,
      recordedAt: "2026-07-25T12:02:00.000Z",
      outcome: "normalization-verification-pending" as const,
      albumIds: [11, 29],
    };

    await appendLidarrPlanHistory(normalizationPending, historyPath);
    expect(
      selectLidarrResumeEntries(
        plan,
        await readLidarrPlanHistory(plan.id, plan.payloadChecksum, historyPath),
      ),
    ).toEqual(plan.entries);

    await appendLidarrPlanHistory(verificationPending, historyPath);
    await expect(
      readLidarrPlanHistory(plan.id, plan.payloadChecksum, historyPath),
    ).resolves.toEqual([verificationPending]);
    expect(selectLidarrResumeEntries(plan, [verificationPending])).toEqual(plan.entries);
    expect(
      selectLidarrResumeEntries(plan, [
        {
          planId: plan.id,
          planChecksum: plan.payloadChecksum,
          entryId: entry.id,
          foreignArtistId: entry.foreignArtistId,
          recordedAt: "2026-07-25T12:03:00.000Z",
          outcome: "succeeded",
        },
      ]),
    ).toEqual([]);
  });

  it("is explicitly non-deferable and never enters the numeric-ID executor registry", () => {
    const definition = getLidarrArtistAddOperationDefinition(makePlan().operation);

    expect(definition.deferability).toEqual({ kind: "non-deferable" });
    expect(createLidarrMutationExecutors().has("artist-add")).toBe(false);
  });
});
