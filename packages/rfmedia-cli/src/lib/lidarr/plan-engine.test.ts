import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { createLidarrClientMock } from "../../actions/test-helpers/lidarr-client-mocks.js";
import {
  createLidarrAlbumFixture,
  createLidarrArtistFixture,
} from "../../actions/test-helpers/lidarr-fixtures.js";

import {
  LidarrPlanAlreadyRunningError,
  LidarrPlanArtifactError,
  LidarrPlanValidationError,
} from "../errors.js";
import {
  acquireLidarrPlanClaim,
  appendLidarrPlanHistory,
  assertLidarrMutationPlan,
  assertLidarrMutationPlanV1,
  assertLidarrMutationPlanV2,
  assertLidarrMutationPlanV3,
  buildLidarrAlbumMonitoringPlanV3,
  buildLidarrArtistAddPlanV3,
  buildLidarrArtistAddPlanV2,
  buildLidarrMutationPlan,
  buildLidarrMutationPlanV2,
  buildLidarrMutationPlanV3,
  computeLidarrPlanChecksum,
  createLidarrMutationExecutors,
  findLidarrArtistAddPossibleDispatchEvidence,
  getLidarrMutationOperationDefinition,
  hasLidarrArtistAddPossibleDispatchEvidence,
  hasLidarrArtistDeletePossibleDispatchEvidence,
  readLidarrPlanArtifact,
  readLidarrPlanHistory,
  selectLidarrResumeEntries,
  type LidarrDeferableMutationOperationDefinitionV2,
  writeLidarrPlanArtifact,
} from "./plan-engine.js";
import {
  LIDARR_PLAN_VERSION_V2,
  LIDARR_PLAN_VERSION_V3,
  type LidarrArtistAddPlanV2,
  type LidarrCascadePolicy,
  type LidarrArtistMonitoringOperation,
  type LidarrArtistProfileAssignmentOperation,
  type LidarrArtistTagMutationOperation,
  type LidarrMutationPlanEntry,
  type LidarrMutationPlanEntryV2,
  type LidarrMutationPlanV2,
  type LidarrPlanHistoryRecord,
  type LidarrPlanTagReference,
} from "../../types/lidarr-plan.js";
import type { LidarrArtist } from "../../types/lidarr.js";

const tempRoots: string[] = [];

const FOREIGN_ARTIST_ID = "55555555-5555-4555-8555-555555555555";
const CASCADE_POLICY: LidarrCascadePolicy = {
  assumptions: {
    albumsPerArtist: 2,
    indexerQueriesPerCandidate: 3,
  },
  budgets: {
    indexerQueries: 5,
    acquisitionCandidates: 1,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rfmedia-lidarr-plan-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function makePlan() {
  return buildLidarrMutationPlan(
    {
      origin: "https://lidarr.example.test",
      operation: { kind: "artist-monitoring", desiredMonitored: false },
      maxBatch: 25,
      entries: [
        { artistId: 9, artistName: "Nine", monitored: true },
        { artistId: 2, artistName: "Two", monitored: false },
      ],
    },
    {
      randomUUID: () => "11111111-1111-4111-8111-111111111111",
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      hostname: () => "test-host",
      username: () => "test-user",
      cwd: () => "/test/cwd",
      cliVersion: "0.5.0-test",
    },
  );
}

function makeArtistAddPlan(): LidarrArtistAddPlanV2 {
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
        artistName: "New Artist",
        foreignArtistId: FOREIGN_ARTIST_ID,
        provenance: {
          source: "lastfm",
          method: "artist.getSimilar",
          seedArtist: "Seed Artist",
          similarity: 0.9,
          candidateUrl: "https://www.last.fm/music/New+Artist",
          discoveredAt: "2026-07-25T12:00:00.000Z",
        },
      },
    },
    {
      randomUUID: () => "66666666-6666-4666-8666-666666666666",
      now: () => new Date("2026-07-25T12:01:00.000Z"),
      hostname: () => "test-host",
      username: () => "test-user",
      cwd: () => "/test/cwd",
      cliVersion: "0.5.0-test",
    },
  );
}

function makeAlbumPlan(selectors: readonly string[] = ["singles", "eps", "singles"]) {
  return buildLidarrMutationPlan(
    {
      origin: "https://lidarr.example.test",
      operation: { kind: "album-monitoring", desiredMonitored: false, selectors },
      maxBatch: 25,
      entries: [
        {
          albumId: 9,
          albumTitle: "Nine EP",
          artistId: 3,
          artistName: "Three",
          albumType: "EP",
          monitored: true,
        },
        { albumId: 5, albumTitle: "Five Single", artistId: 2, artistName: "Two", monitored: false },
      ],
    },
    {
      randomUUID: () => "33333333-3333-4333-8333-333333333333",
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      hostname: () => "test-host",
      username: () => "test-user",
      cwd: () => "/test/cwd",
      cliVersion: "0.5.0-test",
    },
  );
}

// Verbatim pre-#198 artifact and history fixtures (generated by the shipped
// artist lane). These are load-bearing back-compat guards: the exact bytes,
// checksum, and idempotency keys must keep validating unchanged.
const ARTIST_PLAN_FIXTURE_ID = "11111111-1111-4111-8111-111111111111";
const ARTIST_PLAN_FIXTURE_CHECKSUM =
  "sha256:aaa631f69b8d7b657f6cbdc59f49653d7636e4a56aad2769e029da9411cfa26f";
const ARTIST_PLAN_FIXTURE_ENTRY_KEY =
  "sha256:c2c40269ceedece6daf2e13e9655cc460ba9eee9f05d61cd78e2429cba30bd74";
const ARTIST_PLAN_ARTIFACT_FIXTURE = `{
  "version": "rfmedia.lidarr-plan.v1",
  "id": "11111111-1111-4111-8111-111111111111",
  "createdAt": "2026-07-22T12:00:00.000Z",
  "createdBy": {
    "host": "test-host",
    "user": "test-user",
    "cliVersion": "0.5.0-test",
    "cwd": "/test/cwd"
  },
  "command": "lidarr",
  "target": {
    "origin": "https://lidarr.example.test"
  },
  "operation": {
    "kind": "artist-monitoring",
    "desiredMonitored": false
  },
  "maxBatch": 25,
  "entries": [
    {
      "id": "artist:2",
      "artistId": 2,
      "artistName": "Two",
      "before": {
        "monitored": false
      },
      "after": {
        "monitored": false
      },
      "idempotencyKey": "sha256:c2c40269ceedece6daf2e13e9655cc460ba9eee9f05d61cd78e2429cba30bd74"
    },
    {
      "id": "artist:9",
      "artistId": 9,
      "artistName": "Nine",
      "before": {
        "monitored": true
      },
      "after": {
        "monitored": false
      },
      "idempotencyKey": "sha256:56cd4ab6c616420a2c4298a80d028ae47474fdf9b162e59f8eb66f4209294b2d"
    }
  ],
  "review": {
    "requested": 2,
    "changed": 1,
    "unchanged": 1
  },
  "risk": {
    "level": "low",
    "destructive": false,
    "cascade": [
      "Existing files remain unchanged.",
      "Existing download-queue items are not cancelled.",
      "No artist or album search is triggered."
    ]
  },
  "payloadChecksum": "sha256:aaa631f69b8d7b657f6cbdc59f49653d7636e4a56aad2769e029da9411cfa26f"
}
`;
const ARTIST_HISTORY_FIXTURE_LINES = [
  `{"planId":"${ARTIST_PLAN_FIXTURE_ID}","planChecksum":"${ARTIST_PLAN_FIXTURE_CHECKSUM}","entryId":"artist:2","artistId":2,"recordedAt":"2026-07-22T12:01:00.000Z","outcome":"succeeded"}`,
  `{"planId":"${ARTIST_PLAN_FIXTURE_ID}","planChecksum":"${ARTIST_PLAN_FIXTURE_CHECKSUM}","entryId":"artist:9","artistId":9,"recordedAt":"2026-07-22T12:02:00.000Z","outcome":"failed","errorCode":"http-500","message":"upstream error"}`,
];
function checksumMaterial(value: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;
}

function makeArtist(overrides: Partial<LidarrArtist> = {}): LidarrArtist {
  return {
    id: 2,
    artistName: "Two",
    foreignArtistId: "mbid-two",
    monitored: true,
    qualityProfileId: 1,
    metadataProfileId: 2,
    tags: [3],
    ...overrides,
  };
}

function sealV2(plan: LidarrMutationPlanV2): LidarrMutationPlanV2 {
  return { ...plan, payloadChecksum: computeLidarrPlanChecksum(plan) };
}

function makeV2MonitoringPlan(): LidarrMutationPlanV2 {
  const origin = "https://lidarr.example.test";
  return sealV2({
    version: LIDARR_PLAN_VERSION_V2,
    id: "44444444-4444-4444-8444-444444444444",
    createdAt: "2026-07-22T12:00:00.000Z",
    createdBy: {
      host: "test-host",
      user: "test-user",
      cliVersion: "0.5.0-test",
      cwd: "/test/cwd",
    },
    command: "lidarr",
    target: { origin },
    selection: { kind: "all" },
    operation: { kind: "artist-monitoring", desiredMonitored: false },
    maxBatch: 25,
    entries: [
      {
        id: "artist:2",
        artistId: 2,
        artistName: "Two",
        before: { monitored: true },
        after: { monitored: false },
        idempotencyKey: checksumMaterial({
          origin,
          operation: "artist-monitoring",
          artistId: 2,
          desiredMonitored: false,
        }),
      },
    ],
    review: { requested: 1, changed: 1, unchanged: 0 },
    summary: { kind: "artist-monitoring", monitoredBefore: 1, monitoredAfter: 0 },
    risk: {
      level: "low",
      destructive: false,
      cascade: [
        "Existing files remain unchanged.",
        "Existing download-queue items are not cancelled.",
        "No artist or album search is triggered.",
      ],
    },
    payloadChecksum: `sha256:${"0".repeat(64)}`,
  });
}

function makeV2ProfilePlan(): LidarrMutationPlanV2 {
  const origin = "https://lidarr.example.test";
  const qualityProfile = { id: 4, name: "Lossless" };
  const metadataProfile = { id: 7, name: "Standard" };
  return sealV2({
    version: LIDARR_PLAN_VERSION_V2,
    id: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-07-22T12:00:00.000Z",
    createdBy: {
      host: "test-host",
      user: "test-user",
      cliVersion: "0.5.0-test",
      cwd: "/test/cwd",
    },
    command: "lidarr",
    target: { origin },
    selection: { kind: "ids", artistIds: [2] },
    operation: { kind: "artist-profile-assignment", qualityProfile, metadataProfile },
    maxBatch: 25,
    entries: [
      {
        id: "artist:2",
        artistId: 2,
        artistName: "Two",
        before: {
          qualityProfile: { id: 1, name: "Any" },
          metadataProfile: { id: 7, name: "Standard" },
        },
        after: { qualityProfile, metadataProfile },
        idempotencyKey: checksumMaterial({
          origin,
          operation: "artist-profile-assignment",
          artistId: 2,
          qualityProfileId: 4,
          metadataProfileId: 7,
        }),
      },
    ],
    review: { requested: 1, changed: 1, unchanged: 0 },
    summary: {
      kind: "artist-profile-assignment",
      qualityProfileChanged: 1,
      metadataProfileChanged: 0,
    },
    risk: {
      level: "medium",
      destructive: false,
      cascade: [
        "Existing files remain unchanged.",
        "Future acquisition and refresh behavior may change.",
        "No artist or album search is triggered.",
      ],
    },
    payloadChecksum: `sha256:${"0".repeat(64)}`,
  });
}

function makeV2TagPlan(): LidarrMutationPlanV2 {
  const origin = "https://lidarr.example.test";
  const requestedTag = { id: 8, label: "managed" };
  const retainedTag = { id: 3, label: "existing" };
  return sealV2({
    version: LIDARR_PLAN_VERSION_V2,
    id: "33333333-3333-4333-8333-333333333333",
    createdAt: "2026-07-22T12:00:00.000Z",
    createdBy: {
      host: "test-host",
      user: "test-user",
      cliVersion: "0.5.0-test",
      cwd: "/test/cwd",
    },
    command: "lidarr",
    target: { origin },
    selection: { kind: "filters", monitored: true, tags: [retainedTag] },
    operation: { kind: "artist-tag-mutation", mode: "add", tags: [requestedTag] },
    maxBatch: 25,
    entries: [
      {
        id: "artist:9",
        artistId: 9,
        artistName: "Nine",
        before: { tags: [retainedTag] },
        after: { tags: [retainedTag, requestedTag] },
        added: [requestedTag],
        removed: [],
        retained: [retainedTag],
        idempotencyKey: checksumMaterial({
          origin,
          operation: "artist-tag-mutation",
          artistId: 9,
          mode: "add",
          tagIds: [8],
        }),
      },
    ],
    review: { requested: 1, changed: 1, unchanged: 0 },
    summary: { kind: "artist-tag-mutation", added: 1, removed: 0, retained: 1 },
    risk: {
      level: "low",
      destructive: false,
      cascade: [
        "Existing files remain unchanged.",
        "Unrelated tag assignments are preserved.",
        "Tag-scoped automation may change future behavior.",
      ],
    },
    payloadChecksum: `sha256:${"0".repeat(64)}`,
  });
}

function makeV2DeletePlan(deleteFiles = false): LidarrMutationPlanV2 {
  return buildLidarrMutationPlanV2(
    {
      origin: "https://lidarr.example.test",
      selection: { kind: "ids", artistIds: [2, 9] },
      operation: { kind: "artist-delete", deleteFiles },
      maxBatch: 25,
      entries: [
        {
          kind: "artist-delete",
          artistId: 9,
          artistName: "Nine",
          path: "/music/Nine",
          albumCount: 3,
          trackFileCount: 30,
          sizeOnDisk: 3_000,
        },
        {
          kind: "artist-delete",
          artistId: 2,
          artistName: "Two",
          path: "/music/Two",
          albumCount: 2,
          trackFileCount: 20,
          sizeOnDisk: 2_000,
        },
      ],
    },
    {
      randomUUID: () => "66666666-6666-4666-8666-666666666666",
      now: () => new Date("2026-07-24T12:00:00.000Z"),
      hostname: () => "delete-host",
      username: () => "delete-user",
      cwd: () => "/delete/cwd",
      cliVersion: "0.5.0-delete",
    },
  );
}

function makeV3MonitoringPlan() {
  return buildLidarrMutationPlanV3(
    {
      origin: "https://lidarr.example.test",
      selection: { kind: "ids", artistIds: [2] },
      operation: { kind: "artist-monitoring", desiredMonitored: true },
      maxBatch: 25,
      entries: [
        {
          kind: "artist-monitoring",
          artistId: 2,
          artistName: "Two",
          monitored: false,
        },
      ],
      cascadePolicy: CASCADE_POLICY,
    },
    {
      randomUUID: () => "77777777-7777-4777-8777-777777777777",
      now: () => new Date("2026-07-27T12:00:00.000Z"),
      hostname: () => "v3-host",
      username: () => "v3-user",
      cwd: () => "/v3/cwd",
      cliVersion: "0.5.0-v3",
    },
  );
}

describe("Lidarr plan construction", () => {
  it("preserves the golden v1 canonical bytes and checksum", () => {
    const plan = makePlan();

    expect(Object.keys(plan)).toEqual([
      "version",
      "id",
      "createdAt",
      "createdBy",
      "command",
      "target",
      "operation",
      "maxBatch",
      "entries",
      "review",
      "risk",
      "payloadChecksum",
    ]);
    expect(plan.entries.map((entry) => entry.idempotencyKey)).toEqual([
      "sha256:c2c40269ceedece6daf2e13e9655cc460ba9eee9f05d61cd78e2429cba30bd74",
      "sha256:56cd4ab6c616420a2c4298a80d028ae47474fdf9b162e59f8eb66f4209294b2d",
    ]);
    expect(plan.payloadChecksum).toBe(
      "sha256:aaa631f69b8d7b657f6cbdc59f49653d7636e4a56aad2769e029da9411cfa26f",
    );
  });

  it("registers a strict deferred executor for artist monitoring", async () => {
    const executor = createLidarrMutationExecutors().get("lidarr.artist-monitoring");
    const definition = getLidarrMutationOperationDefinition(makePlan().operation);
    const setArtistsMonitored = vi.fn().mockResolvedValue(undefined);
    const client = createLidarrClientMock({ setArtistsMonitored });

    await executor?.execute({ artistId: 9, monitored: false }, client);
    await definition.executeDeferredPayload({ artistId: 2, monitored: true }, client);
    expect(setArtistsMonitored).toHaveBeenCalledWith([9], false, undefined);
    expect(setArtistsMonitored).toHaveBeenCalledWith([2], true, undefined);
    await expect(
      executor?.execute({ artistId: 9, monitored: false, extra: true }, client),
    ).rejects.toBeInstanceOf(LidarrPlanValidationError);
  });

  it("owns deferred payload matching and live-state comparison in the operation definition", () => {
    const plan = makePlan();
    const entry = plan.entries[1]!;
    const definition = getLidarrMutationOperationDefinition(plan.operation);

    expect(definition.classify(entry, makeArtist({ monitored: entry.before.monitored }))).toBe(
      "ready",
    );
    expect(definition.classify(entry, makeArtist({ monitored: entry.after.monitored }))).toBe(
      "satisfied",
    );
    expect(
      definition.matchesDeferredIntent(entry, definition.deferredOperation, {
        artistId: entry.artistId,
        monitored: entry.after.monitored,
      }),
    ).toBe(true);
    expect(
      definition.matchesDeferredIntent(entry, definition.deferredOperation, {
        artistId: entry.artistId,
        monitored: entry.after.monitored,
        extra: true,
      }),
    ).toBe(false);
    expect(
      definition.matchesDeferredIntent(entry, "lidarr.other", definition.payloadFor(entry)),
    ).toBe(false);
  });

  it("sorts entries, computes review counts, and seals canonical desired state", () => {
    const plan = makePlan();

    expect(plan.entries.map((entry) => entry.artistId)).toEqual([2, 9]);
    expect(plan.review).toEqual({ requested: 2, changed: 1, unchanged: 1 });
    expect(plan.risk).toMatchObject({ level: "low", destructive: false });
    expect(plan.payloadChecksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(computeLidarrPlanChecksum(plan)).toBe(plan.payloadChecksum);
    expect(JSON.stringify(plan)).not.toMatch(/api.?key|token|secret/iu);
  });

  it("produces the same checksum for semantically identical entry order", () => {
    const first = makePlan();
    const second = buildLidarrMutationPlan(
      {
        origin: first.target.origin,
        operation: { kind: "artist-monitoring", desiredMonitored: false },
        maxBatch: first.maxBatch,
        entries: [...first.entries].reverse().map((entry) => ({
          artistId: entry.artistId,
          artistName: entry.artistName,
          monitored: entry.before.monitored,
        })),
      },
      {
        randomUUID: () => first.id,
        now: () => new Date(first.createdAt),
        hostname: () => first.createdBy.host,
        username: () => first.createdBy.user,
        cwd: () => first.createdBy.cwd,
        cliVersion: first.createdBy.cliVersion,
      },
    );

    expect(second.payloadChecksum).toBe(first.payloadChecksum);
  });

  it("rejects duplicate, empty, over-cap, and non-canonical inputs", () => {
    const base = {
      origin: "https://lidarr.example.test",
      operation: { kind: "artist-monitoring" as const, desiredMonitored: false },
      maxBatch: 2,
    };
    expect(() => buildLidarrMutationPlan({ ...base, entries: [] })).toThrow(
      LidarrPlanValidationError,
    );
    expect(() =>
      buildLidarrMutationPlan({
        ...base,
        entries: [
          { artistId: 1, artistName: "One", monitored: true },
          { artistId: 1, artistName: "Duplicate", monitored: true },
        ],
      }),
    ).toThrow(/duplicate/iu);
    expect(() =>
      buildLidarrMutationPlan({
        ...base,
        maxBatch: 1,
        entries: [
          { artistId: 1, artistName: "One", monitored: true },
          { artistId: 2, artistName: "Two", monitored: true },
        ],
      }),
    ).toThrow(/maxBatch/iu);
    expect(() =>
      buildLidarrMutationPlan({
        ...base,
        origin: "https://lidarr.example.test/path",
        entries: [{ artistId: 1, artistName: "One", monitored: true }],
      }),
    ).toThrow(/origin/iu);
  });

  it("rejects operation-inconsistent semantics, risk, idempotency, and terminal controls", () => {
    const plan = makePlan();
    const reseal = (value: typeof plan) => ({
      ...value,
      payloadChecksum: computeLidarrPlanChecksum(value),
    });
    const wrongAfter = reseal({
      ...plan,
      entries: plan.entries.map((entry, index) =>
        index === 0 ? { ...entry, after: { monitored: !plan.operation.desiredMonitored } } : entry,
      ),
    });
    expect(() => assertLidarrMutationPlanV1(wrongAfter)).toThrow(/after is inconsistent/iu);

    const wrongKey = reseal({
      ...plan,
      entries: plan.entries.map((entry, index) =>
        index === 0 ? { ...entry, idempotencyKey: `sha256:${"f".repeat(64)}` } : entry,
      ),
    });
    expect(() => assertLidarrMutationPlanV1(wrongKey)).toThrow(/idempotencyKey is inconsistent/iu);

    const wrongRisk = reseal({
      ...plan,
      risk: { ...plan.risk, cascade: ["Misleading replacement"] },
    });
    expect(() => assertLidarrMutationPlanV1(wrongRisk)).toThrow(/risk.cascade is inconsistent/iu);

    const controlName = reseal({
      ...plan,
      entries: plan.entries.map((entry, index) =>
        index === 0 ? { ...entry, artistName: "safe\u001b[2Jspoof" } : entry,
      ),
    });
    expect(() => assertLidarrMutationPlanV1(controlName)).toThrow(/terminal control/iu);

    const bidiName = reseal({
      ...plan,
      entries: plan.entries.map((entry, index) =>
        index === 0 ? { ...entry, artistName: "safe\u202Espoof" } : entry,
      ),
    });
    expect(() => assertLidarrMutationPlanV1(bidiName)).toThrow(/terminal control/iu);
  });
});

describe("Lidarr strict v2 plan construction", () => {
  const dependencies = {
    randomUUID: () => "55555555-5555-4555-8555-555555555555",
    now: () => new Date("2026-07-23T12:00:00.000Z"),
    hostname: () => "v2-host",
    username: () => "v2-user",
    cwd: () => "/v2/cwd",
    cliVersion: "0.5.0-v2",
  };

  it("builds profile entries and aggregate evidence through the registered definition", () => {
    const qualityProfile = { id: 4, name: "Lossless" };
    const metadataProfile = { id: 7, name: "Extended" };
    const plan = buildLidarrMutationPlanV2(
      {
        origin: "https://lidarr.example.test",
        selection: { kind: "ids", artistIds: [2] },
        operation: {
          kind: "artist-profile-assignment",
          qualityProfile,
          metadataProfile,
        },
        maxBatch: 25,
        entries: [
          {
            kind: "artist-profile-assignment",
            artistId: 2,
            artistName: "Two",
            qualityProfile,
            metadataProfile: { id: 2, name: "Standard" },
          },
        ],
      },
      dependencies,
    );

    expect(plan).toMatchObject({
      version: LIDARR_PLAN_VERSION_V2,
      id: "55555555-5555-4555-8555-555555555555",
      createdAt: "2026-07-23T12:00:00.000Z",
      createdBy: {
        host: "v2-host",
        user: "v2-user",
        cliVersion: "0.5.0-v2",
        cwd: "/v2/cwd",
      },
      target: { origin: "https://lidarr.example.test" },
      review: { requested: 1, changed: 1, unchanged: 0 },
      summary: {
        kind: "artist-profile-assignment",
        qualityProfileChanged: 0,
        metadataProfileChanged: 1,
      },
      risk: { level: "medium", destructive: false },
    });
    expect(plan.entries[0]).toMatchObject({
      artistId: 2,
      before: { qualityProfile, metadataProfile: { id: 2, name: "Standard" } },
      after: { qualityProfile, metadataProfile },
    });
    expect(computeLidarrPlanChecksum(plan)).toBe(plan.payloadChecksum);
    expect(() => assertLidarrMutationPlanV2(plan)).not.toThrow();
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it("canonicalizes tag references and sources once for deterministic sealed output", () => {
    const makeTagPlan = (
      entries: readonly [
        {
          readonly kind: "artist-tag-mutation";
          readonly artistId: number;
          readonly artistName: string;
          readonly tags: readonly LidarrPlanTagReference[];
        },
        {
          readonly kind: "artist-tag-mutation";
          readonly artistId: number;
          readonly artistName: string;
          readonly tags: readonly LidarrPlanTagReference[];
        },
      ],
      tags: readonly LidarrPlanTagReference[],
    ) =>
      buildLidarrMutationPlanV2(
        {
          origin: "https://lidarr.example.test",
          selection: { kind: "ids", artistIds: [2, 9] },
          operation: { kind: "artist-tag-mutation", mode: "set", tags },
          maxBatch: 25,
          entries,
        },
        dependencies,
      );
    const two = {
      kind: "artist-tag-mutation" as const,
      artistId: 2,
      artistName: "Two",
      tags: [
        { id: 8, label: "managed" },
        { id: 4, label: "keep" },
      ],
    };
    const nine = {
      kind: "artist-tag-mutation" as const,
      artistId: 9,
      artistName: "Nine",
      tags: [
        { id: 8, label: "managed" },
        { id: 3, label: "remove" },
      ],
    };
    const requested = [
      { id: 8, label: "managed" },
      { id: 4, label: "keep" },
    ];
    const first = makeTagPlan([nine, two], requested);
    const second = makeTagPlan([two, nine], [...requested].reverse());

    expect(first.operation).toEqual({
      kind: "artist-tag-mutation",
      mode: "set",
      tags: [
        { id: 4, label: "keep" },
        { id: 8, label: "managed" },
      ],
    });
    expect(first.entries.map((entry) => entry.artistId)).toEqual([2, 9]);
    expect(first.review).toEqual({ requested: 2, changed: 1, unchanged: 1 });
    expect(first.summary).toEqual({
      kind: "artist-tag-mutation",
      added: 1,
      removed: 1,
      retained: 3,
    });
    expect(first.risk).toMatchObject({ level: "high", destructive: true });
    expect(second.payloadChecksum).toBe(first.payloadChecksum);
  });

  it("supports monitoring and rejects non-empty cohort contract violations", () => {
    const base = {
      origin: "https://lidarr.example.test",
      selection: { kind: "ids" as const, artistIds: [2] },
      operation: { kind: "artist-monitoring" as const, desiredMonitored: false },
      maxBatch: 1,
      entries: [
        {
          kind: "artist-monitoring" as const,
          artistId: 2,
          artistName: "Two",
          monitored: true,
        },
      ],
    };
    const plan = buildLidarrMutationPlanV2(base, dependencies);

    expect(plan.summary).toEqual({
      kind: "artist-monitoring",
      monitoredBefore: 1,
      monitoredAfter: 0,
    });
    expect(() => buildLidarrMutationPlanV2({ ...base, entries: [] }, dependencies)).toThrow(
      /entries must not be empty/iu,
    );
    expect(() =>
      buildLidarrMutationPlanV2(
        {
          ...base,
          entries: [base.entries[0]!, { ...base.entries[0]!, artistName: "Duplicate" }],
        },
        dependencies,
      ),
    ).toThrow(/maxBatch/iu);
    expect(() =>
      buildLidarrMutationPlanV2(
        {
          ...base,
          selection: { kind: "ids", artistIds: [3] },
        },
        dependencies,
      ),
    ).toThrow(/selection.artistIds must match plan.entries/iu);
    expect(() =>
      buildLidarrMutationPlanV2(
        {
          ...base,
          entries: [
            {
              kind: "artist-tag-mutation",
              artistId: 2,
              artistName: "Two",
              tags: [],
            },
          ],
        },
        dependencies,
      ),
    ).toThrow(/incompatible entry source/iu);
  });

  it("seals deletion evidence, mode, totals, risk, and stable artist order", () => {
    const keepFiles = makeV2DeletePlan(false);
    const sameOrderIndependentPlan = makeV2DeletePlan(false);
    const deleteFiles = makeV2DeletePlan(true);

    expect(keepFiles.entries.map((entry) => entry.artistId)).toEqual([2, 9]);
    expect(keepFiles.summary).toEqual({
      kind: "artist-delete",
      artists: 2,
      albums: 5,
      trackFiles: 50,
      sizeOnDisk: 5_000,
    });
    expect(keepFiles.risk).toMatchObject({ level: "high", destructive: true });
    expect(keepFiles.entries[0]).toMatchObject({
      before: {
        path: "/music/Two",
        albumCount: 2,
        trackFileCount: 20,
        sizeOnDisk: 2_000,
      },
      after: { exists: false },
    });
    expect(sameOrderIndependentPlan.payloadChecksum).toBe(keepFiles.payloadChecksum);
    expect(deleteFiles.payloadChecksum).not.toBe(keepFiles.payloadChecksum);
    expect(deleteFiles.entries[0]?.idempotencyKey).not.toBe(keepFiles.entries[0]?.idempotencyKey);

    const definition = getLidarrMutationOperationDefinition({
      kind: "artist-delete",
      deleteFiles: false,
    });
    expect(definition.deferability).toEqual({ kind: "non-deferable" });
    expect(definition).not.toHaveProperty("deferredOperation");
    expect(definition).not.toHaveProperty("executeDeferredPayload");
    expect(definition).not.toHaveProperty("matchesDeferredIntent");
  });

  it("keeps each deferable definition kind correlated with its operation", () => {
    type MonitoringDefinition = Extract<
      LidarrDeferableMutationOperationDefinitionV2,
      { readonly kind: "artist-monitoring" }
    >;
    type ProfileDefinition = Extract<
      LidarrDeferableMutationOperationDefinitionV2,
      { readonly kind: "artist-profile-assignment" }
    >;
    type TagDefinition = Extract<
      LidarrDeferableMutationOperationDefinitionV2,
      { readonly kind: "artist-tag-mutation" }
    >;

    expectTypeOf<
      MonitoringDefinition["operation"]
    >().toEqualTypeOf<LidarrArtistMonitoringOperation>();
    expectTypeOf<
      ProfileDefinition["operation"]
    >().toEqualTypeOf<LidarrArtistProfileAssignmentOperation>();
    expectTypeOf<TagDefinition["operation"]>().toEqualTypeOf<LidarrArtistTagMutationOperation>();
  });
});

describe("Lidarr profile operation definition", () => {
  const origin = "https://lidarr.example.test";
  const qualityBefore = { id: 1, name: "Any" };
  const qualityAfter = { id: 4, name: "Lossless" };
  const metadataBefore = { id: 2, name: "Standard" };
  const metadataAfter = { id: 7, name: "Extended" };

  it("constructs canonical managed state, risk, resources, payload, and idempotency", () => {
    const operation = {
      kind: "artist-profile-assignment" as const,
      qualityProfile: qualityAfter,
      metadataProfile: metadataAfter,
    };
    const definition = getLidarrMutationOperationDefinition(operation);
    const source = {
      kind: "artist-profile-assignment" as const,
      artistId: 2,
      artistName: "Two",
      qualityProfile: qualityBefore,
      metadataProfile: metadataBefore,
    };
    const entry = definition.buildEntry(origin, source);
    const duplicate = definition.buildEntry(origin, source);

    expect(definition.canonicalize()).toEqual(operation);
    expect(definition.risk()).toEqual({
      level: "medium",
      destructive: false,
      cascade: [
        "Existing files remain unchanged.",
        "Future acquisition and refresh behavior may change.",
        "No artist or album search is triggered.",
      ],
    });
    expect(definition.referencedResources()).toEqual([
      { kind: "quality-profile", id: 4, name: "Lossless" },
      { kind: "metadata-profile", id: 7, name: "Extended" },
    ]);
    expect(entry).toMatchObject({
      id: "artist:2",
      artistId: 2,
      artistName: "Two",
      before: {
        qualityProfile: qualityBefore,
        metadataProfile: metadataBefore,
      },
      after: {
        qualityProfile: qualityAfter,
        metadataProfile: metadataAfter,
      },
    });
    expect(definition.hasChange(entry)).toBe(true);
    expect(definition.payloadFor(entry)).toEqual({
      artistId: 2,
      qualityProfileId: 4,
      metadataProfileId: 7,
    });
    expect(entry.idempotencyKey).toBe(
      checksumMaterial({
        origin,
        operation: "artist-profile-assignment",
        artistId: 2,
        qualityProfileId: 4,
        metadataProfileId: 7,
      }),
    );
    expect(duplicate.idempotencyKey).toBe(entry.idempotencyKey);
  });

  it("supports quality-only, metadata-only, combined partial convergence, and no-op state", () => {
    const qualityDefinition = getLidarrMutationOperationDefinition({
      kind: "artist-profile-assignment",
      qualityProfile: qualityAfter,
    });
    const qualityEntry = qualityDefinition.buildEntry(origin, {
      kind: "artist-profile-assignment",
      artistId: 2,
      artistName: "Two",
      qualityProfile: qualityAfter,
    });
    expect(qualityDefinition.hasChange(qualityEntry)).toBe(false);
    expect(
      qualityDefinition.classifyLive(
        qualityEntry,
        makeArtist({
          qualityProfileId: 4,
          metadataProfileId: 999,
          monitored: false,
          tags: [88],
        }),
      ),
    ).toMatchObject({ state: "satisfied" });

    const metadataDefinition = getLidarrMutationOperationDefinition({
      kind: "artist-profile-assignment",
      metadataProfile: metadataAfter,
    });
    const metadataEntry = metadataDefinition.buildEntry(origin, {
      kind: "artist-profile-assignment",
      artistId: 2,
      artistName: "Two",
      metadataProfile: metadataBefore,
    });
    expect(metadataDefinition.payloadFor(metadataEntry)).toEqual({
      artistId: 2,
      metadataProfileId: 7,
    });

    const combinedDefinition = getLidarrMutationOperationDefinition({
      kind: "artist-profile-assignment",
      qualityProfile: qualityAfter,
      metadataProfile: metadataAfter,
    });
    const combinedEntry = combinedDefinition.buildEntry(origin, {
      kind: "artist-profile-assignment",
      artistId: 2,
      artistName: "Two",
      qualityProfile: qualityBefore,
      metadataProfile: metadataBefore,
    });
    expect(
      combinedDefinition.classifyLive(
        combinedEntry,
        makeArtist({ qualityProfileId: 1, metadataProfileId: 2 }),
      ),
    ).toMatchObject({ state: "ready" });
    expect(
      combinedDefinition.classifyLive(
        combinedEntry,
        makeArtist({ qualityProfileId: 4, metadataProfileId: 2 }),
      ),
    ).toMatchObject({ state: "ready" });
    expect(
      combinedDefinition.classifyLive(
        combinedEntry,
        makeArtist({ qualityProfileId: 4, metadataProfileId: 7 }),
      ),
    ).toMatchObject({ state: "satisfied" });
    expect(
      combinedDefinition.classifyLive(
        combinedEntry,
        makeArtist({ qualityProfileId: 9, metadataProfileId: 2 }),
      ),
    ).toMatchObject({
      state: "drifted",
      message: "Artist 2 managed profile state changed after planning",
    });
    expect(
      combinedDefinition.verify(
        combinedEntry,
        makeArtist({ qualityProfileId: 4, metadataProfileId: 2 }),
      ),
    ).toBe(false);
    expect(
      combinedDefinition.verify(
        combinedEntry,
        makeArtist({ qualityProfileId: 4, metadataProfileId: 7 }),
      ),
    ).toBe(true);
  });

  it("executes only requested profiles and validates exact deferred payloads", async () => {
    const setArtistProfiles = vi.fn().mockResolvedValue(undefined);
    const client = createLidarrClientMock({ setArtistProfiles });
    const definition = getLidarrMutationOperationDefinition({
      kind: "artist-profile-assignment",
      qualityProfile: qualityAfter,
      metadataProfile: metadataAfter,
    });
    const entry = definition.buildEntry(origin, {
      kind: "artist-profile-assignment",
      artistId: 2,
      artistName: "Two",
      qualityProfile: qualityBefore,
      metadataProfile: metadataBefore,
    });
    const executor = createLidarrMutationExecutors().get("lidarr.artist-profile-assignment");

    await definition.execute(entry, client);
    await executor?.execute({ artistId: 9, qualityProfileId: 4 }, client);
    expect(setArtistProfiles).toHaveBeenNthCalledWith(
      1,
      2,
      { qualityProfileId: 4, metadataProfileId: 7 },
      undefined,
    );
    expect(setArtistProfiles).toHaveBeenNthCalledWith(2, 9, { qualityProfileId: 4 }, undefined);
    await expect(executor?.execute({ artistId: 9 }, client)).rejects.toThrow(
      /manage at least one profile/iu,
    );
    await expect(
      executor?.execute({ artistId: 9, qualityProfileId: 4, extra: true }, client),
    ).rejects.toThrow(/unknown key/iu);

    const expected = definition.payloadFor(entry);
    expect(
      definition.matchesDeferredIntent(entry, definition.deferability.operation, expected),
    ).toBe(true);
    expect(
      definition.matchesDeferredIntent(entry, definition.deferability.operation, {
        ...expected,
        extra: true,
      }),
    ).toBe(false);
    expect(definition.matchesDeferredIntent(entry, "lidarr.other", expected)).toBe(false);
  });
});

describe("Lidarr tag operation definition", () => {
  const origin = "https://lidarr.example.test";
  const existing = { id: 3, label: "existing" };
  const managed = { id: 8, label: "managed" };
  const unrelated = { id: 10, label: "unrelated" };

  const cases: readonly {
    readonly mode: "add" | "remove" | "set" | "clear";
    readonly requested: readonly LidarrPlanTagReference[];
    readonly before: readonly LidarrPlanTagReference[];
    readonly after: readonly LidarrPlanTagReference[];
    readonly ready: readonly number[];
    readonly satisfied: readonly number[];
    readonly drifted?: readonly number[];
    readonly level: "low" | "high";
    readonly destructive: boolean;
  }[] = [
    {
      mode: "add",
      requested: [managed],
      before: [existing],
      after: [existing, managed],
      ready: [3, 10],
      satisfied: [3, 8, 10],
      level: "low",
      destructive: false,
    },
    {
      mode: "remove",
      requested: [managed],
      before: [existing, managed],
      after: [existing],
      ready: [3, 8, 10],
      satisfied: [3, 10],
      level: "low",
      destructive: false,
    },
    {
      mode: "set",
      requested: [managed],
      before: [existing, managed],
      after: [managed],
      ready: [3, 8],
      satisfied: [8],
      drifted: [8, 10],
      level: "high",
      destructive: true,
    },
    {
      mode: "clear",
      requested: [],
      before: [existing],
      after: [],
      ready: [3],
      satisfied: [],
      drifted: [10],
      level: "high",
      destructive: true,
    },
  ];

  it.each(cases)(
    "owns $mode entry, risk, classification, verification, and payload semantics",
    ({ mode, requested, before, after, ready, satisfied, drifted, level, destructive }) => {
      const definition = getLidarrMutationOperationDefinition({
        kind: "artist-tag-mutation",
        mode,
        tags: requested,
      });
      const entry = definition.buildEntry(origin, {
        kind: "artist-tag-mutation",
        artistId: 2,
        artistName: "Two",
        tags: before,
      });

      expect(entry).toMatchObject({
        before: { tags: before },
        after: { tags: after },
      });
      expect(definition.risk()).toMatchObject({ level, destructive });
      expect(definition.referencedResources()).toEqual(
        requested.map((tag) => ({ kind: "tag", id: tag.id, label: tag.label })),
      );
      expect(definition.hasChange(entry)).toBe(
        before.map((tag) => tag.id).join(",") !== after.map((tag) => tag.id).join(","),
      );
      expect(definition.payloadFor(entry)).toEqual({
        artistId: 2,
        mode,
        tagIds: requested.map((tag) => tag.id),
      });
      expect(definition.classifyLive(entry, makeArtist({ tags: ready }))).toMatchObject({
        state: "ready",
      });
      expect(definition.classifyLive(entry, makeArtist({ tags: satisfied }))).toMatchObject({
        state: "satisfied",
      });
      expect(definition.verify(entry, makeArtist({ tags: satisfied }))).toBe(true);
      if (drifted !== undefined) {
        expect(definition.classifyLive(entry, makeArtist({ tags: drifted }))).toMatchObject({
          state: "drifted",
          message: "Artist 2 tag set changed after planning",
        });
        expect(definition.verify(entry, makeArtist({ tags: drifted }))).toBe(false);
      }
    },
  );

  it.each([
    { mode: "add" as const, requested: [managed], before: [existing, managed] },
    { mode: "remove" as const, requested: [managed], before: [existing] },
    { mode: "set" as const, requested: [managed], before: [managed] },
    { mode: "clear" as const, requested: [], before: [] },
  ])("recognizes all $mode no-op states", ({ mode, requested, before }) => {
    const definition = getLidarrMutationOperationDefinition({
      kind: "artist-tag-mutation",
      mode,
      tags: requested,
    });
    const entry = definition.buildEntry(origin, {
      kind: "artist-tag-mutation",
      artistId: 2,
      artistName: "Two",
      tags: before,
    });

    expect(definition.hasChange(entry)).toBe(false);
    expect(definition.classify(entry, makeArtist({ tags: before.map((tag) => tag.id) }))).toBe(
      "satisfied",
    );
  });

  it("normalizes construction and enforces exact tag deferred replay payloads", async () => {
    const updateArtistTags = vi.fn().mockResolvedValue(undefined);
    const client = createLidarrClientMock({ updateArtistTags });
    const definition = getLidarrMutationOperationDefinition({
      kind: "artist-tag-mutation",
      mode: "set",
      tags: [unrelated, managed],
    });
    const entry = definition.buildEntry(origin, {
      kind: "artist-tag-mutation",
      artistId: 2,
      artistName: "Two",
      tags: [managed, existing],
    });
    const executor = createLidarrMutationExecutors().get("lidarr.artist-tag-mutation");

    expect(definition.canonicalize()).toEqual({
      kind: "artist-tag-mutation",
      mode: "set",
      tags: [managed, unrelated],
    });
    expect(entry.idempotencyKey).toBe(
      checksumMaterial({
        origin,
        operation: "artist-tag-mutation",
        artistId: 2,
        mode: "set",
        tagIds: [8, 10],
      }),
    );
    await definition.execute(entry, client);
    await executor?.execute({ artistId: 9, mode: "set", tagIds: [8, 10] }, client);
    expect(updateArtistTags).toHaveBeenNthCalledWith(
      1,
      2,
      { mode: "set", tagIds: [8, 10] },
      undefined,
    );
    expect(updateArtistTags).toHaveBeenNthCalledWith(
      2,
      9,
      { mode: "set", tagIds: [8, 10] },
      undefined,
    );

    const expected = definition.payloadFor(entry);
    expect(
      definition.matchesDeferredIntent(entry, definition.deferability.operation, expected),
    ).toBe(true);
    expect(
      definition.matchesDeferredIntent(entry, definition.deferability.operation, {
        artistId: 2,
        mode: "set",
        tagIds: [10, 8],
      }),
    ).toBe(false);
    await expect(
      executor?.execute({ artistId: 9, mode: "set", tagIds: [10, 8] }, client),
    ).rejects.toThrow(/sorted and unique/iu);
    await expect(
      executor?.execute({ artistId: 9, mode: "clear", tagIds: [8] }, client),
    ).rejects.toThrow(/inconsistent with mode/iu);
    await expect(
      executor?.execute(
        { artistId: 9, mode: "set", tagIds: [8, 10], authorization: "secret" },
        client,
      ),
    ).rejects.toThrow(/unknown key/iu);
  });

  it("registers only the four exact mutation executor identities", () => {
    expect([...createLidarrMutationExecutors().keys()]).toEqual([
      "lidarr.artist-monitoring",
      "lidarr.artist-profile-assignment",
      "lidarr.artist-tag-mutation",
      "lidarr.album-monitoring",
    ]);
  });
});

describe("Lidarr plan v2 contracts", () => {
  it("validates and seals strict profile and tag discriminants", () => {
    const monitoringPlan = makeV2MonitoringPlan();
    const profilePlan = makeV2ProfilePlan();
    const tagPlan = makeV2TagPlan();

    expect(() => assertLidarrMutationPlanV2(monitoringPlan)).not.toThrow();
    expect(() => assertLidarrMutationPlan(profilePlan)).not.toThrow();
    expect(() => assertLidarrMutationPlanV2(profilePlan)).not.toThrow();
    expect(() => assertLidarrMutationPlanV2(tagPlan)).not.toThrow();
    expect(computeLidarrPlanChecksum(monitoringPlan)).toBe(monitoringPlan.payloadChecksum);
    expect(computeLidarrPlanChecksum(profilePlan)).toBe(profilePlan.payloadChecksum);
    expect(computeLidarrPlanChecksum(tagPlan)).toBe(tagPlan.payloadChecksum);
  });

  it("rejects unknown versions before permissive fallback", () => {
    expect(() =>
      assertLidarrMutationPlan({ ...makeV2ProfilePlan(), version: "rfmedia.lidarr-plan.v4" }),
    ).toThrow(/unsupported plan version/iu);
  });

  it("rejects operation, entry, risk, summary, and idempotency inconsistencies", () => {
    const plan = makeV2ProfilePlan();
    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        entries: plan.entries.map((entry) => ({
          ...entry,
          after: {
            qualityProfile: { id: 12, name: "Other" },
            metadataProfile: { id: 7, name: "Standard" },
          },
        })),
      }),
    ).toThrow(/after is inconsistent/iu);
    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        risk: { ...plan.risk, level: "low" },
      }),
    ).toThrow(/risk is inconsistent/iu);
    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        summary: { ...plan.summary, qualityProfileChanged: 0 },
      }),
    ).toThrow(/summary counts are inconsistent/iu);
    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        entries: plan.entries.map((entry) => ({
          ...entry,
          idempotencyKey: `sha256:${"f".repeat(64)}`,
        })),
      }),
    ).toThrow(/idempotencyKey is inconsistent/iu);
  });

  it("rejects unknown, recursively sensitive, and prototype keys", () => {
    const plan = makeV2TagPlan();
    expect(() => assertLidarrMutationPlanV2({ ...plan, extra: true })).toThrow(/unknown key/iu);
    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        selection: { ...plan.selection, nested: { authorization: "credential" } },
      }),
    ).toThrow(/sensitive key/iu);
    const prototypeKey = JSON.parse(
      JSON.stringify(plan).replace('"selection":{', '"selection":{"__proto__":{"polluted":true},'),
    ) as unknown;
    expect(() => assertLidarrMutationPlanV2(prototypeKey)).toThrow(/forbidden key/iu);
  });

  it("rejects unsorted targets and tag sets plus invalid tag bounds", () => {
    const plan = makeV2TagPlan();
    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        operation: {
          kind: "artist-tag-mutation",
          mode: "add",
          tags: [
            { id: 8, label: "managed" },
            { id: 3, label: "existing" },
          ],
        },
      }),
    ).toThrow(/sorted by unique tag id/iu);
    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        selection: { kind: "ids", artistIds: [9, 2] },
      }),
    ).toThrow(/sorted and unique/iu);
    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        operation: { kind: "artist-tag-mutation", mode: "clear", tags: [{ id: 8, label: "x" }] },
      }),
    ).toThrow(/inconsistent with tag mode/iu);
  });

  it("rejects deletion evidence, postcondition, summary, and unknown-key tampering", () => {
    const plan = makeV2DeletePlan();
    const [first, ...remaining] = plan.entries;
    if (first === undefined || !("path" in first.before)) throw new Error("expected delete entry");

    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        entries: [{ ...first, before: { ...first.before, albumCount: -1 } }, ...remaining],
      }),
    ).toThrow(/non-negative safe integer/iu);
    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        entries: [{ ...first, before: { ...first.before, path: "" } }, ...remaining],
      }),
    ).toThrow(/non-empty bounded string/iu);
    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        entries: [{ ...first, after: { exists: true } }, ...remaining],
      }),
    ).toThrow(/must seal artist absence/iu);
    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        summary: { ...plan.summary, sizeOnDisk: 5_001 },
      }),
    ).toThrow(/summary counts are inconsistent/iu);
    expect(() =>
      assertLidarrMutationPlanV2({
        ...plan,
        operation: { ...plan.operation, importListExclusion: true },
      }),
    ).toThrow(/unknown key/iu);
  });
});

describe("Lidarr plan v3 sealing and validation", () => {
  it("seals deterministic cascade evidence and round trips canonical v3 bytes", async () => {
    const first = makeV3MonitoringPlan();
    const second = makeV3MonitoringPlan();
    const root = await makeTempRoot();
    const path = join(root, "v3.json");

    expect(first.version).toBe(LIDARR_PLAN_VERSION_V3);
    expect(first.cascadeAnalysis).toMatchObject({
      assumptions: CASCADE_POLICY.assumptions,
      metrics: {
        immediateIndexerQueries: { value: 0, certainty: "exact" },
        acquisitionCandidates: { value: 2, certainty: "modelled" },
        conditionalIndexerQueries: { value: 6, certainty: "modelled" },
        newlyMonitored: { value: 1, certainty: "exact" },
      },
      budgets: {
        indexerQueries: { status: "exceeded", limit: 5, projected: 6 },
        acquisitionCandidates: { status: "exceeded", limit: 1, projected: 2 },
      },
      warnings: [
        { code: "indexer-query-budget-exceeded" },
        { code: "acquisition-budget-exceeded" },
      ],
      recommendations: ["reduce-scope", "split-into-batches", "delay-apply"],
    });
    expect(second.payloadChecksum).toBe(first.payloadChecksum);
    expect(computeLidarrPlanChecksum(first)).toBe(first.payloadChecksum);
    expect(() => assertLidarrMutationPlanV3(first)).not.toThrow();

    await writeLidarrPlanArtifact(path, first);
    await expect(readLidarrPlanArtifact(path)).resolves.toEqual(first);
    expect(await readFile(path, "utf8")).toContain('"version": "rfmedia.lidarr-plan.v3"');
  });

  it("provides engine-owned artist-add and album-monitoring v3 entry points", () => {
    const legacyAdd = makeArtistAddPlan();
    const add = buildLidarrArtistAddPlanV3({
      origin: legacyAdd.target.origin,
      operation: legacyAdd.operation,
      entry: {
        artistName: legacyAdd.entries[0].artistName,
        foreignArtistId: legacyAdd.entries[0].foreignArtistId,
        provenance: legacyAdd.entries[0].provenance,
      },
      cascadePolicy: CASCADE_POLICY,
    });
    const album = buildLidarrAlbumMonitoringPlanV3({
      origin: "https://lidarr.example.test",
      operation: {
        kind: "album-monitoring",
        desiredMonitored: true,
        selectors: ["albums"],
      },
      maxBatch: 25,
      entries: [
        {
          albumId: 5,
          albumTitle: "Five",
          artistId: 2,
          artistName: "Two",
          monitored: false,
        },
      ],
      cascadePolicy: CASCADE_POLICY,
    });

    expect(add).toMatchObject({
      version: LIDARR_PLAN_VERSION_V3,
      cascadeAnalysis: {
        metrics: { acquisitionCandidates: { value: 0, certainty: "exact" } },
      },
    });
    expect(album).toMatchObject({
      version: LIDARR_PLAN_VERSION_V3,
      cascadeAnalysis: {
        metrics: {
          acquisitionCandidates: { value: 1, certainty: "exact" },
          newlyMonitored: { value: 1, unit: "albums" },
        },
      },
    });
    expect(() => assertLidarrMutationPlan(add)).not.toThrow();
    expect(() => assertLidarrMutationPlan(album)).not.toThrow();
  });

  it("rejects exact-key violations at the envelope and nested analysis boundaries", () => {
    const plan = makeV3MonitoringPlan();

    expect(() => assertLidarrMutationPlanV3({ ...plan, extra: true })).toThrow(/unknown key/iu);
    expect(() =>
      assertLidarrMutationPlanV3({
        ...plan,
        cascadeAnalysis: {
          ...plan.cascadeAnalysis,
          metrics: {
            ...plan.cascadeAnalysis.metrics,
            acquisitionCandidates: {
              ...plan.cascadeAnalysis.metrics.acquisitionCandidates,
              explanation: "unsealed prose",
            },
          },
        },
      }),
    ).toThrow(/unknown key/iu);
  });

  it("rejects false cascade semantics even after the attacker recomputes SHA-256", () => {
    const plan = makeV3MonitoringPlan();
    const falseAnalysis = {
      ...plan.cascadeAnalysis,
      metrics: {
        ...plan.cascadeAnalysis.metrics,
        acquisitionCandidates: {
          ...plan.cascadeAnalysis.metrics.acquisitionCandidates,
          value: 3,
        },
      },
    };
    const unsealed = {
      ...plan,
      cascadeAnalysis: falseAnalysis,
      payloadChecksum: `sha256:${"0".repeat(64)}`,
    };
    const tampered = {
      ...unsealed,
      payloadChecksum: computeLidarrPlanChecksum(unsealed),
    };

    expect(computeLidarrPlanChecksum(tampered)).toBe(tampered.payloadChecksum);
    expect(() => assertLidarrMutationPlanV3(tampered)).toThrow(/cascadeAnalysis is inconsistent/iu);
  });
});

describe("Lidarr plan artifact IO", () => {
  it("round trips through a private atomic artifact", async () => {
    const root = await makeTempRoot();
    const path = join(root, "plans", "plan.json");
    const plan = makePlan();

    await expect(writeLidarrPlanArtifact(path, plan)).resolves.toBe(path);
    await expect(readLidarrPlanArtifact(path)).resolves.toEqual(plan);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("dispatches v1 and v2 artifacts without rewriting either version", async () => {
    const root = await makeTempRoot();
    const v1Path = join(root, "v1.json");
    const v2Path = join(root, "v2.json");
    const v1 = makePlan();
    const v2 = makeV2TagPlan();

    await writeLidarrPlanArtifact(v1Path, v1);
    await writeLidarrPlanArtifact(v2Path, v2);

    await expect(readLidarrPlanArtifact(v1Path)).resolves.toEqual(v1);
    await expect(readLidarrPlanArtifact(v2Path)).resolves.toEqual(v2);
    expect(await readFile(v1Path, "utf8")).toContain('"version": "rfmedia.lidarr-plan.v1"');
    expect(await readFile(v2Path, "utf8")).toContain('"version": "rfmedia.lidarr-plan.v2"');
  });

  it("round trips a strict deletion artifact with checksum-bound evidence", async () => {
    const root = await makeTempRoot();
    const path = join(root, "delete.json");
    const plan = makeV2DeletePlan(true);

    await writeLidarrPlanArtifact(path, plan);

    await expect(readLidarrPlanArtifact(path)).resolves.toEqual(plan);
    const tampered = JSON.parse(await readFile(path, "utf8")) as {
      entries: Array<Record<string, unknown>>;
    };
    tampered.entries[0]!["artistName"] = "Tampered";
    await writeFile(path, `${JSON.stringify(tampered)}\n`, "utf8");
    await expect(readLidarrPlanArtifact(path)).rejects.toMatchObject({
      code: "LIDARR_PLAN_CHECKSUM_MISMATCH",
    });
  });

  it("does not chmod an existing caller-owned parent directory", async () => {
    const root = await makeTempRoot();
    const parent = join(root, "caller-parent");
    await mkdir(parent, { mode: 0o750 });
    const initialMode = (await stat(parent)).mode & 0o777;
    const path = join(parent, "plan.json");

    await writeLidarrPlanArtifact(path, makePlan());

    expect((await stat(parent)).mode & 0o777).toBe(initialMode);
  });

  it("rejects symlinked parent components", async () => {
    const root = await makeTempRoot();
    const realParent = join(root, "real");
    const linkedParent = join(root, "linked");
    await mkdir(realParent, { mode: 0o700 });
    await symlink(realParent, linkedParent);

    await expect(
      writeLidarrPlanArtifact(join(linkedParent, "plan.json"), makePlan()),
    ).rejects.toMatchObject({ code: "LIDARR_PLAN_UNSAFE_PATH" });
  });

  it("rejects overwrite, symlink, tamper, unknown keys, and sensitive keys", async () => {
    const root = await makeTempRoot();
    const path = join(root, "plan.json");
    const plan = makePlan();
    await writeLidarrPlanArtifact(path, plan);

    await expect(writeLidarrPlanArtifact(path, plan)).rejects.toMatchObject({
      code: "LIDARR_PLAN_EXISTS",
    });

    const tamperedPath = join(root, "tampered.json");
    await writeFile(tamperedPath, JSON.stringify({ ...plan, maxBatch: 24 }), {
      encoding: "utf8",
      mode: 0o644,
    });
    await expect(readLidarrPlanArtifact(tamperedPath)).rejects.toMatchObject({
      code: "LIDARR_PLAN_CHECKSUM_MISMATCH",
    });

    const extra = { ...plan, extra: true };
    expect(() => assertLidarrMutationPlanV1(extra)).toThrow(LidarrPlanValidationError);
    expect(() => assertLidarrMutationPlanV1({ ...plan, apiKey: "not-a-real-key" })).toThrow(
      LidarrPlanValidationError,
    );

    const linkPath = join(root, "link.json");
    await symlink(path, linkPath);
    await expect(readLidarrPlanArtifact(linkPath)).rejects.toBeInstanceOf(LidarrPlanArtifactError);
  });

  it("rejects oversized artifacts before JSON parsing", async () => {
    const root = await makeTempRoot();
    const path = join(root, "huge.json");
    await writeFile(path, "x".repeat(10 * 1024 * 1024 + 1), {
      encoding: "utf8",
      mode: 0o644,
    });
    await expect(readLidarrPlanArtifact(path)).rejects.toMatchObject({
      code: "LIDARR_PLAN_TOO_LARGE",
    });
  });

  it.each([
    "",
    "x".repeat(4_097),
    "plan\0.json",
    "plan\u001b[2J.json",
    "plan\u0085.json",
    "plan\u2066spoof.json",
  ])("rejects empty, unbounded, and terminal-control paths before rendering them", async (path) => {
    const error = await readLidarrPlanArtifact(path).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "LIDARR_PLAN_UNSAFE_PATH",
      planPath: undefined,
    });
    if (path.length > 0) expect((error as Error).message).not.toContain(path);
  });
});

describe("Lidarr plan history and claims", () => {
  it("persists validated history and selects only incomplete resume entries", async () => {
    const root = await makeTempRoot();
    const plan = makePlan();
    const historyPath = join(root, "history.jsonl");
    const record: LidarrPlanHistoryRecord = {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      entryId: plan.entries[0]!.id,
      artistId: plan.entries[0]!.artistId,
      recordedAt: "2026-07-22T12:01:00.000Z",
      outcome: "succeeded",
    };

    await appendLidarrPlanHistory(record, historyPath);
    const records = await readLidarrPlanHistory(plan.id, plan.payloadChecksum, historyPath);
    expect(records).toEqual([record]);
    expect(selectLidarrResumeEntries(plan, records).map((entry) => entry.id)).toEqual([
      plan.entries[1]!.id,
    ]);
    expect((await stat(historyPath)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")(
    "waits for the published history directory sync before artist dispatch can run",
    async () => {
      const root = await makeTempRoot();
      const plan = makeArtistAddPlan();
      const entry = plan.entries[0];
      const historyPath = join(root, "artist-add-history.jsonl");
      const probe = await open(root, "r");
      const fileHandlePrototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      const originalSync = fileHandlePrototype.sync;
      await probe.close();
      const events: string[] = [];
      let signalDirectorySyncStarted: (() => void) | undefined;
      const directorySyncStarted = new Promise<void>((resolve) => {
        signalDirectorySyncStarted = resolve;
      });
      let allowDirectorySyncToComplete: (() => void) | undefined;
      const directorySyncMayComplete = new Promise<void>((resolve) => {
        allowDirectorySyncToComplete = resolve;
      });
      const syncSpy = vi.spyOn(fileHandlePrototype, "sync").mockImplementation(async function (
        this: FileHandle,
      ): Promise<void> {
        if ((await this.stat()).isDirectory()) {
          events.push("directory-sync-started");
          signalDirectorySyncStarted?.();
          await expect(readFile(historyPath, "utf8")).resolves.toContain(entry.idempotencyKey);
          await directorySyncMayComplete;
          await originalSync.call(this);
          events.push("directory-sync-completed");
          return;
        }
        await originalSync.call(this);
      });
      const addArtist = vi.fn(() => {
        events.push("add-artist");
      });

      try {
        const persistThenDispatch = (async () => {
          await appendLidarrPlanHistory(
            {
              planId: plan.id,
              planChecksum: plan.payloadChecksum,
              entryId: entry.id,
              foreignArtistId: entry.foreignArtistId,
              recordedAt: "2026-07-25T12:02:00.000Z",
              outcome: "possibly-dispatched",
              idempotencyKey: entry.idempotencyKey,
            },
            historyPath,
          );
          addArtist();
        })();

        await directorySyncStarted;
        expect(events).toEqual(["directory-sync-started"]);
        expect(addArtist).not.toHaveBeenCalled();
        allowDirectorySyncToComplete?.();
        await persistThenDispatch;
        expect(events).toEqual([
          "directory-sync-started",
          "directory-sync-completed",
          "add-artist",
        ]);
      } finally {
        allowDirectorySyncToComplete?.();
        syncSpy.mockRestore();
      }
    },
  );

  it("preserves v1 album entries when selecting resumable work", () => {
    const plan = makeAlbumPlan();
    const completed = plan.entries[0]!;
    if (!("albumId" in completed)) throw new Error("expected an album-monitoring entry");
    const history: LidarrPlanHistoryRecord[] = [
      {
        planId: plan.id,
        planChecksum: plan.payloadChecksum,
        entryId: completed.id,
        artistId: completed.artistId,
        albumId: completed.albumId,
        recordedAt: "2026-07-22T12:01:00.000Z",
        outcome: "satisfied",
      },
    ];

    const entries = selectLidarrResumeEntries(plan, history);

    expectTypeOf(entries).toEqualTypeOf<LidarrMutationPlanEntry[]>();
    expect(entries).toEqual([plan.entries[1]]);
    expect(entries[0]).toMatchObject({ albumId: 9, albumTitle: "Nine EP" });
  });

  it("preserves v2 artist entries when selecting resumable work", () => {
    const plan = makeV2ProfilePlan();
    const plannedEntry = plan.entries[0]!;
    const history: LidarrPlanHistoryRecord[] = [
      {
        planId: plan.id,
        planChecksum: plan.payloadChecksum,
        entryId: plannedEntry.id,
        artistId: plannedEntry.artistId,
        recordedAt: "2026-07-22T12:01:00.000Z",
        outcome: "failed",
      },
    ];
    const entries = selectLidarrResumeEntries(plan, history);

    expectTypeOf(entries).toEqualTypeOf<LidarrMutationPlanEntryV2[]>();
    expect(entries).toEqual(plan.entries);
    expect(entries[0]).toMatchObject({
      artistId: 2,
      before: { qualityProfile: { id: 1, name: "Any" } },
      after: { qualityProfile: { id: 4, name: "Lossless" } },
    });
    expect(selectLidarrResumeEntries(plan, [{ ...history[0]!, outcome: "succeeded" }])).toEqual([]);
  });

  it("round-trips foreign-ID add history and preserves exact possible-dispatch evidence", async () => {
    const root = await makeTempRoot();
    const plan = makeArtistAddPlan();
    const entry = plan.entries[0];
    const historyPath = join(root, "artist-add-history.jsonl");
    const possible = {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      entryId: entry.id,
      foreignArtistId: entry.foreignArtistId,
      recordedAt: "2026-07-25T12:02:00.000Z",
      outcome: "possibly-dispatched" as const,
      idempotencyKey: entry.idempotencyKey,
    };

    await appendLidarrPlanHistory(possible, historyPath);
    const pending = await readLidarrPlanHistory(plan.id, plan.payloadChecksum, historyPath);
    expect(pending).toEqual([possible]);
    expect(selectLidarrResumeEntries(plan, pending)).toEqual(plan.entries);
    expect(hasLidarrArtistAddPossibleDispatchEvidence(plan, entry, pending)).toBe(true);
    expect(findLidarrArtistAddPossibleDispatchEvidence(plan, entry, pending)).toEqual(possible);

    const boundPossible = { ...possible, lidarrId: 42 };
    await appendLidarrPlanHistory(boundPossible, historyPath);
    const boundPending = await readLidarrPlanHistory(plan.id, plan.payloadChecksum, historyPath);
    expect(boundPending).toEqual([boundPossible]);
    expect(findLidarrArtistAddPossibleDispatchEvidence(plan, entry, boundPending)).toEqual(
      boundPossible,
    );
    await expect(
      appendLidarrPlanHistory({ ...boundPossible, lidarrId: 84 }, historyPath),
    ).rejects.toThrow(/cannot change or remove its Lidarr artist identity/iu);
    expect(() =>
      selectLidarrResumeEntries(plan, [
        { ...possible, idempotencyKey: `sha256:${"f".repeat(64)}` },
      ]),
    ).toThrow(/does not match the artist-add plan entry/iu);

    const completed = {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      entryId: entry.id,
      foreignArtistId: entry.foreignArtistId,
      recordedAt: "2026-07-25T12:03:00.000Z",
      outcome: "succeeded" as const,
    };
    await appendLidarrPlanHistory(completed, historyPath);
    await expect(
      readLidarrPlanHistory(plan.id, plan.payloadChecksum, historyPath),
    ).resolves.toEqual([completed]);
    expect(selectLidarrResumeEntries(plan, [completed])).toEqual([]);
    expect(hasLidarrArtistAddPossibleDispatchEvidence(plan, entry, [completed])).toBe(false);
  });

  it("rejects foreign-ID history that does not exactly identify its artist-add entry", async () => {
    const root = await makeTempRoot();
    const plan = makeArtistAddPlan();
    const entry = plan.entries[0];

    await expect(
      appendLidarrPlanHistory(
        {
          planId: plan.id,
          planChecksum: plan.payloadChecksum,
          entryId: entry.id,
          foreignArtistId: "77777777-7777-4777-8777-777777777777",
          recordedAt: "2026-07-25T12:02:00.000Z",
          outcome: "failed",
        },
        join(root, "artist-add-rejected-history.jsonl"),
      ),
    ).rejects.toThrow(/does not match foreign artist/iu);
  });

  it("preserves attributable possible-dispatch evidence through uncertainty", async () => {
    const root = await makeTempRoot();
    const plan = makeV2DeletePlan(true);
    const entry = plan.entries[0]!;
    const historyPath = join(root, "delete-history.jsonl");
    const possible = {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      entryId: entry.id,
      artistId: entry.artistId,
      recordedAt: "2026-07-24T12:01:00.000Z",
      outcome: "possibly-dispatched" as const,
      idempotencyKey: entry.idempotencyKey,
    };

    await appendLidarrPlanHistory(possible, historyPath);
    const pending = await readLidarrPlanHistory(plan.id, plan.payloadChecksum, historyPath);
    expect(pending).toEqual([possible]);
    expect(selectLidarrResumeEntries(plan, pending)).toEqual(plan.entries);
    expect(hasLidarrArtistDeletePossibleDispatchEvidence(plan, entry, pending)).toBe(true);
    expect(() =>
      selectLidarrResumeEntries(plan, [
        { ...possible, idempotencyKey: `sha256:${"f".repeat(64)}` },
      ]),
    ).toThrow(/does not match the deletion plan entry/iu);

    const uncertain = {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      entryId: entry.id,
      artistId: entry.artistId,
      recordedAt: "2026-07-24T12:02:00.000Z",
      outcome: "uncertain" as const,
    };
    await appendLidarrPlanHistory(uncertain, historyPath);
    const unresolved = await readLidarrPlanHistory(plan.id, plan.payloadChecksum, historyPath);
    expect(unresolved).toEqual([possible, uncertain]);
    expect(selectLidarrResumeEntries(plan, unresolved)).toEqual(plan.entries);
    expect(hasLidarrArtistDeletePossibleDispatchEvidence(plan, entry, unresolved)).toBe(true);

    const terminal = {
      ...uncertain,
      recordedAt: "2026-07-24T12:03:00.000Z",
      outcome: "succeeded" as const,
    };
    await appendLidarrPlanHistory(terminal, historyPath);
    const completed = await readLidarrPlanHistory(plan.id, plan.payloadChecksum, historyPath);
    expect(completed).toEqual([terminal]);
    expect(selectLidarrResumeEntries(plan, completed)).toEqual([plan.entries[1]]);
    expect(hasLidarrArtistDeletePossibleDispatchEvidence(plan, entry, completed)).toBe(false);
    await expect(appendLidarrPlanHistory(possible, historyPath)).rejects.toThrow(
      /cannot replace a terminal/iu,
    );
  });

  it("bounds one plan history to the latest record per entry", async () => {
    const root = await makeTempRoot();
    const plan = makePlan();
    const historyPath = join(root, "history.jsonl");
    const base: LidarrPlanHistoryRecord = {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      entryId: plan.entries[0]!.id,
      artistId: plan.entries[0]!.artistId,
      recordedAt: "2026-07-22T12:01:00.000Z",
      outcome: "failed",
    };
    await appendLidarrPlanHistory(base, historyPath);
    await appendLidarrPlanHistory(
      { ...base, recordedAt: "2026-07-22T12:02:00.000Z", outcome: "succeeded" },
      historyPath,
    );

    await expect(
      readLidarrPlanHistory(plan.id, plan.payloadChecksum, historyPath),
    ).resolves.toEqual([{ ...base, recordedAt: "2026-07-22T12:02:00.000Z", outcome: "succeeded" }]);
  });

  it("fails closed on malformed matching history", async () => {
    const root = await makeTempRoot();
    const plan = makePlan();
    const historyPath = join(root, "history.jsonl");
    await writeFile(historyPath, `${JSON.stringify({ planId: plan.id })}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });
    await expect(
      readLidarrPlanHistory(plan.id, plan.payloadChecksum, historyPath),
    ).rejects.toBeInstanceOf(LidarrPlanValidationError);
  });

  it("allows one live claim and releases it explicitly", async () => {
    const root = await makeTempRoot();
    const plan = makePlan();
    const first = await acquireLidarrPlanClaim(plan.id, {
      claimDirectory: join(root, "claims"),
      hostname: () => "host",
      pid: 42,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      isProcessAlive: () => true,
    });
    await expect(first.assertOwned()).resolves.toBeUndefined();
    expect(await readdir(join(root, "claims"))).toEqual([`${plan.id}.lock`]);

    await expect(
      acquireLidarrPlanClaim(plan.id, {
        claimDirectory: join(root, "claims"),
        hostname: () => "host",
        pid: 43,
        now: () => new Date("2026-07-22T12:00:01.000Z"),
        isProcessAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(LidarrPlanAlreadyRunningError);

    await first.release();
    const second = await acquireLidarrPlanClaim(plan.id, {
      claimDirectory: join(root, "claims"),
      hostname: () => "host",
      pid: 43,
      now: () => new Date("2026-07-22T12:00:02.000Z"),
      isProcessAlive: () => true,
    });
    await second.release();
  });

  // The same-host dead-pid steal is the ONLY recovery path the claim has, because
  // it is acquired with `maxAgeMs: null` (a healthy apply outlives the shared age
  // threshold and cannot renew). Every other claim test asserts a negative, so
  // without this one a regression that silently disables the steal — dropping the
  // `isProcessAlive` forward and falling back to secure-store's own probe — ships
  // green. The abandoned record therefore names a pid that is genuinely ALIVE, so
  // only the injected probe can classify it as dead.
  it("reclaims a claim abandoned by a dead process on this host", async () => {
    const root = await makeTempRoot();
    const claimDirectory = join(root, "claims");
    await mkdir(claimDirectory, { recursive: true });
    await chmod(claimDirectory, 0o700);
    const plan = makePlan();
    const claimPath = join(claimDirectory, `${plan.id}.lock`);
    const abandoned = {
      host: "host",
      pid: process.pid,
      createdAt: "2026-07-22T11:59:00.000Z",
      ownershipToken: "55555555-5555-4555-8555-555555555555",
    };
    await writeFile(claimPath, JSON.stringify(abandoned), { mode: 0o600 });

    // Records which pids the probe was asked about, so a forward that reaches the
    // probe with the WRONG pid (our own, say, instead of the incumbent's) fails
    // here rather than silently stealing for the wrong reason.
    const probedPids: number[] = [];
    const claim = await acquireLidarrPlanClaim(plan.id, {
      claimDirectory,
      hostname: () => "host",
      pid: 8,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      isProcessAlive: (pid) => {
        probedPids.push(pid);
        return false;
      },
    });

    expect(probedPids).toEqual([abandoned.pid]);
    await expect(claim.assertOwned()).resolves.toBeUndefined();
    const republished = JSON.parse(await readFile(claimPath, "utf8")) as Record<string, unknown>;
    expect(republished["ownershipToken"]).not.toBe(abandoned.ownershipToken);
    expect(republished["pid"]).toBe(8);
    expect(republished["binding"]).toBeUndefined();

    await claim.release();
  });

  it("releases without throwing when the claim file gained foreign access bits", async () => {
    const root = await makeTempRoot();
    const claimDirectory = join(root, "claims");
    const plan = makePlan();
    const claim = await acquireLidarrPlanClaim(plan.id, {
      claimDirectory,
      hostname: () => "host",
      pid: 42,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      isProcessAlive: () => true,
    });
    await chmod(claim.path, 0o644);

    await expect(claim.release()).resolves.toBeUndefined();
    await expect(stat(claim.path)).rejects.toMatchObject({ code: "ENOENT" });

    const reacquired = await acquireLidarrPlanClaim(plan.id, {
      claimDirectory,
      hostname: () => "host",
      pid: 42,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      isProcessAlive: () => true,
    });
    await reacquired.release();
  });

  // Bounds corrupt-record preservation. A claims directory that gained foreign
  // write bits fails the parent-safety walk and must keep throwing.
  it("still surfaces a genuine release failure it must not swallow", async () => {
    const root = await makeTempRoot();
    const claimDirectory = join(root, "claims");
    const plan = makePlan();
    const claim = await acquireLidarrPlanClaim(plan.id, {
      claimDirectory,
      hostname: () => "host",
      pid: 42,
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      isProcessAlive: () => true,
    });
    await chmod(claimDirectory, 0o777);

    await expect(claim.release()).rejects.toBeInstanceOf(LidarrPlanArtifactError);
  });

  it("detects displaced ownership and does not release a replacement claim", async () => {
    const root = await makeTempRoot();
    const plan = makePlan();
    const claim = await acquireLidarrPlanClaim(plan.id, {
      claimDirectory: join(root, "claims"),
      hostname: () => "host",
      pid: 42,
      randomUUID: () => "22222222-2222-4222-8222-222222222222",
    });
    await unlink(claim.path);
    const replacement = {
      host: "host",
      pid: 43,
      createdAt: "2026-07-22T12:00:00.000Z",
      ownershipToken: "22222222-2222-4222-8222-222222222222",
    };
    await writeFile(claim.path, JSON.stringify(replacement), { mode: 0o600 });

    await expect(claim.assertOwned()).rejects.toBeInstanceOf(LidarrPlanAlreadyRunningError);
    await claim.release();

    await expect(readFile(claim.path, "utf8")).resolves.toBe(JSON.stringify(replacement));
  });

  it("fails closed on a malformed partial claim publication", async () => {
    const root = await makeTempRoot();
    const claimDirectory = join(root, "claims");
    await mkdir(claimDirectory, { recursive: true });
    await chmod(claimDirectory, 0o700);
    const plan = makePlan();
    const claimPath = join(claimDirectory, `${plan.id}.lock`);
    await writeFile(claimPath, '{"host":"partial', { mode: 0o600 });

    await expect(
      acquireLidarrPlanClaim(plan.id, {
        claimDirectory,
        hostname: () => "host",
        pid: 8,
        isProcessAlive: () => false,
      }),
    ).rejects.toBeInstanceOf(LidarrPlanAlreadyRunningError);
    await expect(readFile(claimPath, "utf8")).resolves.toBe('{"host":"partial');
  });

  it("never reclaims an old claim owned by another host", async () => {
    const root = await makeTempRoot();
    const claimDirectory = join(root, "claims");
    await mkdir(claimDirectory, { recursive: true });
    await chmod(claimDirectory, 0o700);
    const plan = makePlan();
    const claimPath = join(claimDirectory, `${plan.id}.lock`);
    await writeFile(
      claimPath,
      JSON.stringify({
        host: "old-host",
        pid: 7,
        createdAt: "2026-07-22T10:00:00.000Z",
        ownershipToken: "44444444-4444-4444-8444-444444444444",
      }),
      { mode: 0o600 },
    );

    await expect(
      acquireLidarrPlanClaim(plan.id, {
        claimDirectory,
        hostname: () => "new-host",
        pid: 8,
        now: () => new Date("2026-07-22T12:00:00.000Z"),
        isProcessAlive: () => false,
      }),
    ).rejects.toBeInstanceOf(LidarrPlanAlreadyRunningError);
    expect(JSON.parse(await readFile(claimPath, "utf8"))).toMatchObject({ host: "old-host" });
  });
});

describe("Lidarr album plan construction", () => {
  it("sorts by albumId, canonicalizes selectors, and pins deterministic idempotency keys", () => {
    const plan = makeAlbumPlan();

    expect(plan.operation).toEqual({
      kind: "album-monitoring",
      desiredMonitored: false,
      selectors: ["eps", "singles"],
    });
    expect(plan.entries.map((entry) => entry.id)).toEqual(["album:5", "album:9"]);
    expect(plan.entries[0]).toMatchObject({
      albumId: 5,
      albumTitle: "Five Single",
      artistId: 2,
      artistName: "Two",
    });
    expect("albumType" in plan.entries[0]!).toBe(false);
    expect(plan.entries[1]).toMatchObject({ albumId: 9, albumType: "EP" });
    expect(plan.entries[0]!.idempotencyKey).toBe(
      "sha256:a955a01f2ae4192b00c880a314591079b4f27aeae3c0a3fa399bbe0df4903a99",
    );
    expect(plan.review).toEqual({ requested: 2, changed: 1, unchanged: 1 });
    expect(plan.risk).toEqual({
      level: "low",
      destructive: false,
      cascade: [
        "Album files remain on disk",
        "Artist-level monitoring unchanged",
        "No search triggered",
      ],
    });
    expect(computeLidarrPlanChecksum(plan)).toBe(plan.payloadChecksum);
  });

  it("produces the same checksum for any selector ordering or duplication", () => {
    expect(makeAlbumPlan(["eps", "singles"]).payloadChecksum).toBe(
      makeAlbumPlan(["singles", "eps", "singles"]).payloadChecksum,
    );
  });

  it("rejects duplicate album ids", () => {
    expect(() =>
      buildLidarrMutationPlan({
        origin: "https://lidarr.example.test",
        operation: { kind: "album-monitoring", desiredMonitored: false, selectors: [] },
        maxBatch: 25,
        entries: [
          { albumId: 5, albumTitle: "Five", artistId: 2, artistName: "Two", monitored: true },
          { albumId: 5, albumTitle: "Copy", artistId: 2, artistName: "Two", monitored: true },
        ],
      }),
    ).toThrow(/duplicate album id 5/u);
  });

  it("round trips an album plan artifact through the exact-allowlist validators", async () => {
    const root = await makeTempRoot();
    const path = join(root, "album-plan.json");
    const plan = makeAlbumPlan();

    await expect(writeLidarrPlanArtifact(path, plan)).resolves.toBe(path);
    await expect(readLidarrPlanArtifact(path)).resolves.toEqual(plan);
  });

  it("rejects non-canonical or unknown album operation payloads", () => {
    const plan = makeAlbumPlan();

    expect(() =>
      assertLidarrMutationPlanV1({ ...plan, operation: { ...plan.operation, extra: true } }),
    ).toThrow(LidarrPlanValidationError);
    expect(() =>
      assertLidarrMutationPlanV1({
        ...plan,
        operation: {
          kind: "album-monitoring",
          desiredMonitored: false,
          selectors: ["singles", "eps"],
        },
      }),
    ).toThrow(/sorted and unique/u);
    expect(() =>
      assertLidarrMutationPlanV1({
        ...plan,
        operation: { kind: "album-monitoring", desiredMonitored: false, selectors: ["eps", "eps"] },
      }),
    ).toThrow(/sorted and unique/u);
  });

  it("fails closed on unknown kinds and kind-mismatched operation keys", () => {
    const artistPlan = makePlan();

    expect(() =>
      assertLidarrMutationPlanV1({
        ...artistPlan,
        operation: { kind: "playlist-monitoring", desiredMonitored: false },
      }),
    ).toThrow(LidarrPlanValidationError);
    expect(() =>
      assertLidarrMutationPlanV1({
        ...artistPlan,
        operation: { kind: "artist-monitoring", desiredMonitored: false, selectors: [] },
      }),
    ).toThrow(LidarrPlanValidationError);
  });

  it("registers a strict album deferred executor with exact-key revalidation", async () => {
    const executor = createLidarrMutationExecutors().get("lidarr.album-monitoring");
    const setAlbumsMonitored = vi.fn().mockResolvedValue(undefined);
    const client = createLidarrClientMock({ setAlbumsMonitored });

    await executor?.execute({ albumId: 5, monitored: false }, client);
    expect(setAlbumsMonitored).toHaveBeenCalledWith([5], false, undefined);
    await expect(
      executor?.execute({ albumId: 5, monitored: false, extra: true }, client),
    ).rejects.toBeInstanceOf(LidarrPlanValidationError);
    await expect(
      executor?.execute({ albumId: 5, monitored: false, apiKey: "not-a-real-key" }, client),
    ).rejects.toBeInstanceOf(LidarrPlanValidationError);
    expect(setAlbumsMonitored).toHaveBeenCalledTimes(1);
  });

  it("matches deferred intents on the exact album operation and payload", () => {
    const plan = makeAlbumPlan();
    const definition = getLidarrMutationOperationDefinition(plan.operation);
    const entry = plan.entries[0]!;

    expect(
      definition.matchesDeferredIntent(entry, definition.deferredOperation, {
        albumId: 5,
        monitored: false,
      }),
    ).toBe(true);
    expect(
      definition.matchesDeferredIntent(entry, definition.deferredOperation, {
        albumId: 5,
        monitored: false,
        extra: true,
      }),
    ).toBe(false);
    expect(
      definition.matchesDeferredIntent(entry, "lidarr.artist-monitoring", {
        albumId: 5,
        monitored: false,
      }),
    ).toBe(false);
  });
});

describe("Lidarr operation definition seam", () => {
  it("exposes byte-stable identity, label, task-id, and staleness members per kind", () => {
    const artistPlan = makePlan();
    const artistDefinition = getLidarrMutationOperationDefinition(artistPlan.operation);
    const artistEntry = artistPlan.entries[0]!;

    expect(artistDefinition.operationLabel).toBe("lidarr apply artist monitoring");
    expect(artistDefinition.entryId(artistEntry)).toBe("artist:2");
    expect(artistDefinition.entryLabel(artistEntry)).toBe("Two");
    expect(artistDefinition.taskIdFragment(artistEntry)).toBe("2");
    expect(artistDefinition.resultSortKey(artistEntry)).toBe(2);
    expect(artistDefinition.staleFinding(artistEntry, "missing")).toEqual({
      code: "artist-missing",
      entryId: "artist:2",
      artistId: 2,
      message: "Artist 2 no longer exists",
    });
    expect(artistDefinition.staleFinding(artistEntry, "drift")).toEqual({
      code: "artist-state-drift",
      entryId: "artist:2",
      artistId: 2,
      message: "Artist 2 monitoring state changed after planning",
    });

    const albumPlan = makeAlbumPlan();
    const albumDefinition = getLidarrMutationOperationDefinition(albumPlan.operation);
    const albumEntry = albumPlan.entries[0]!;

    expect(albumDefinition.operationLabel).toBe("lidarr apply album monitoring");
    expect(albumDefinition.entryId(albumEntry)).toBe("album:5");
    expect(albumDefinition.entryLabel(albumEntry)).toBe("Five Single — Two");
    expect(albumDefinition.taskIdFragment(albumEntry)).toBe("album:5");
    expect(albumDefinition.resultSortKey(albumEntry)).toBe(5);
    expect(albumDefinition.staleFinding(albumEntry, "missing")).toEqual({
      code: "album-missing",
      entryId: "album:5",
      albumId: 5,
      message: "Album 5 no longer exists",
    });
    expect(albumDefinition.staleFinding(albumEntry, "drift")).toEqual({
      code: "album-state-drift",
      entryId: "album:5",
      albumId: 5,
      message: "Album 5 monitoring state changed after planning",
    });
  });

  it("loads live monitored state keyed by entry id per kind", async () => {
    const client = createLidarrClientMock({
      listArtists: () => Promise.resolve([createLidarrArtistFixture({ id: 2, monitored: true })]),
      listAlbums: () => Promise.resolve([createLidarrAlbumFixture({ id: 5, monitored: false })]),
    });
    const artistPlan = makePlan();
    const artistDefinition = getLidarrMutationOperationDefinition(artistPlan.operation);
    await expect(artistDefinition.loadCurrentStates(client, artistPlan.entries)).resolves.toEqual(
      new Map([["artist:2", { monitored: true }]]),
    );

    const albumPlan = makeAlbumPlan();
    const albumDefinition = getLidarrMutationOperationDefinition(albumPlan.operation);
    const states = await albumDefinition.loadCurrentStates(client, albumPlan.entries);
    expect(client.listAlbums).toHaveBeenCalledWith({ albumIds: [5, 9], signal: undefined });
    expect(states).toEqual(new Map([["album:5", { monitored: false }]]));

    await expect(albumDefinition.loadCurrentStates(client, [])).resolves.toEqual(new Map());
    expect(client.listAlbums).toHaveBeenCalledTimes(1);
  });
});

describe("Lidarr album plan history records", () => {
  it("persists album records and infers the record kind from its shape", async () => {
    const root = await makeTempRoot();
    const plan = makeAlbumPlan();
    const historyPath = join(root, "history.jsonl");
    const record: LidarrPlanHistoryRecord = {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      entryId: "album:5",
      albumId: 5,
      artistId: 2,
      recordedAt: "2026-07-22T12:01:00.000Z",
      outcome: "succeeded",
    };

    await appendLidarrPlanHistory(record, historyPath);
    await expect(
      readLidarrPlanHistory(plan.id, plan.payloadChecksum, historyPath),
    ).resolves.toEqual([record]);
  });

  it("rejects mixed-shape history corruption", async () => {
    const root = await makeTempRoot();
    const plan = makeAlbumPlan();
    const albumIdWithArtistEntry: LidarrPlanHistoryRecord = {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      entryId: "artist:2",
      albumId: 5,
      artistId: 2,
      recordedAt: "2026-07-22T12:01:00.000Z",
      outcome: "succeeded",
    };
    const artistShapeWithAlbumEntry: LidarrPlanHistoryRecord = {
      planId: plan.id,
      planChecksum: plan.payloadChecksum,
      entryId: "album:5",
      artistId: 5,
      recordedAt: "2026-07-22T12:01:00.000Z",
      outcome: "succeeded",
    };

    await expect(
      appendLidarrPlanHistory(albumIdWithArtistEntry, join(root, "mismatch.jsonl")),
    ).rejects.toBeInstanceOf(LidarrPlanValidationError);
    await expect(
      appendLidarrPlanHistory(artistShapeWithAlbumEntry, join(root, "corrupt.jsonl")),
    ).rejects.toBeInstanceOf(LidarrPlanValidationError);
  });
});

describe("Lidarr artist artifact back-compat regression", () => {
  it("still serializes and validates the pinned pre-album artist artifact byte-for-byte", async () => {
    const root = await makeTempRoot();
    const writtenPath = join(root, "written-plan.json");
    await writeLidarrPlanArtifact(writtenPath, makePlan());
    await expect(readFile(writtenPath, "utf8")).resolves.toBe(ARTIST_PLAN_ARTIFACT_FIXTURE);

    const fixturePath = join(root, "fixture-plan.json");
    await writeFile(fixturePath, ARTIST_PLAN_ARTIFACT_FIXTURE, {
      encoding: "utf8",
      mode: 0o644,
    });
    const plan = await readLidarrPlanArtifact(fixturePath);
    expect(plan.payloadChecksum).toBe(ARTIST_PLAN_FIXTURE_CHECKSUM);
    expect(plan.entries[0]!.idempotencyKey).toBe(ARTIST_PLAN_FIXTURE_ENTRY_KEY);
  });

  it("still validates pinned pre-album artist history lines unchanged", async () => {
    const root = await makeTempRoot();
    const historyPath = join(root, "history.jsonl");
    await writeFile(historyPath, `${ARTIST_HISTORY_FIXTURE_LINES.join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });

    const records = await readLidarrPlanHistory(
      ARTIST_PLAN_FIXTURE_ID,
      ARTIST_PLAN_FIXTURE_CHECKSUM,
      historyPath,
    );
    expect(records).toEqual([
      {
        planId: ARTIST_PLAN_FIXTURE_ID,
        planChecksum: ARTIST_PLAN_FIXTURE_CHECKSUM,
        entryId: "artist:2",
        artistId: 2,
        recordedAt: "2026-07-22T12:01:00.000Z",
        outcome: "succeeded",
      },
      {
        planId: ARTIST_PLAN_FIXTURE_ID,
        planChecksum: ARTIST_PLAN_FIXTURE_CHECKSUM,
        entryId: "artist:9",
        artistId: 9,
        recordedAt: "2026-07-22T12:02:00.000Z",
        outcome: "failed",
        errorCode: "http-500",
        message: "upstream error",
      },
    ]);
  });
});
