import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRIDGE_ARTIST_NORMALIZATION_VERSION,
  BRIDGE_ARTIST_RESOLVER_VERSION,
  BRIDGE_ARTIST_SCORING_VERSION,
  BRIDGE_IDENTITY_CACHE_ERROR_MAX_MESSAGE_BYTES,
  BRIDGE_IDENTITY_SNAPSHOT_MAX_BYTES,
  BRIDGE_IDENTITY_SNAPSHOT_VERSION,
  BridgeIdentityCacheError,
  type BridgeArtistIdentitySnapshot,
  type BridgeArtistResolutionOutcome,
  type BridgeIdentityCacheErrorCode,
  type BridgeIdentityCompatibleScopeSelector,
  type BridgeIdentityScope,
  type BridgeTargetArtist,
} from "../../types/bridge.js";
import type { DbConnection } from "../../types/db.js";
import { MEDIA_IDENTITY_MAX_TITLE_BYTES } from "../../types/media-server.js";
import { initializeDatabase } from "../db.js";
import {
  findCompatibleBridgeIdentityScopes,
  purgeBridgeIdentitySnapshot,
  readBridgeIdentitySnapshot,
  replaceBridgeIdentitySnapshot,
} from "./cache.js";
import { resolveArtistIdentities } from "./mapping.js";

const ARTIST_MBID = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const TARGET_MBID = "10adbe5d-6b17-4be1-99a9-2ffc3b2d555c";
const CAPTURED_AT = "2026-07-27T10:00:00.000Z";
const VERIFIED_AT = "2026-07-27T09:59:00.000Z";
const NOW = "2026-07-27T10:05:00.000Z";
const CLOCK = () => new Date(NOW);
const SECRET = "super-secret-api-key";

const SCOPE: BridgeIdentityScope = Object.freeze({
  plexOrigin: "http://plex.example.net:32400",
  plexInstanceId: "plex-machine-a",
  plexLibraryId: "7",
  lidarrOrigin: "https://lidarr.example.net",
  entityKind: "artist",
});

const RESOLVED: BridgeArtistResolutionOutcome = Object.freeze({
  plexId: "plex-artist-1",
  title: "Massive Attack",
  state: "resolved",
  reason: "unique-exact-mbid",
  method: "exact-mbid",
  candidates: Object.freeze([]),
  sourceMbid: ARTIST_MBID,
  target: Object.freeze({
    lidarrId: 41,
    artistMbid: ARTIST_MBID,
    title: "Massive Attack",
  }),
});

const TARGET_ARTISTS: readonly BridgeTargetArtist[] = Object.freeze([
  Object.freeze({
    lidarrId: 41,
    title: "Massive Attack",
    artistMbid: ARTIST_MBID,
  }),
  Object.freeze({
    lidarrId: 72,
    title: "Portishead",
    artistMbid: TARGET_MBID,
  }),
]);

const SELECTOR: BridgeIdentityCompatibleScopeSelector = Object.freeze({
  plexOrigin: SCOPE.plexOrigin,
  lidarrOrigin: SCOPE.lidarrOrigin,
  entityKind: "artist",
});

function snapshot(
  options: {
    readonly scope?: BridgeIdentityScope;
    readonly capturedAt?: string;
    readonly verifiedAt?: string;
    readonly outcomes?: readonly BridgeArtistResolutionOutcome[];
    readonly targetArtists?: readonly BridgeTargetArtist[];
  } = {},
): BridgeArtistIdentitySnapshot {
  const outcomes = options.outcomes ?? [RESOLVED];
  const targetArtists = options.targetArtists ?? TARGET_ARTISTS;
  return {
    snapshotVersion: BRIDGE_IDENTITY_SNAPSHOT_VERSION,
    resolverVersion: BRIDGE_ARTIST_RESOLVER_VERSION,
    normalizationVersion: BRIDGE_ARTIST_NORMALIZATION_VERSION,
    scoringVersion: BRIDGE_ARTIST_SCORING_VERSION,
    scope: options.scope ?? SCOPE,
    capturedAt: options.capturedAt ?? CAPTURED_AT,
    verifiedAt: options.verifiedAt ?? VERIFIED_AT,
    provenance: { source: "live", mode: "online", freshness: "fresh" },
    completeness: {
      sourceComplete: true,
      targetComplete: true,
      resolutionsComplete: true,
      complete: true,
      sourceArtistCount: outcomes.length,
      targetArtistCount: targetArtists.length,
      resolutionCount: outcomes.length,
    },
    outcomes,
    targetArtists,
  };
}

function rowCount(db: DbConnection): number {
  return (
    db.prepare("SELECT COUNT(*) AS count FROM bridge_identity_snapshots").get() as {
      count: number;
    }
  ).count;
}

function storedPayload(db: DbConnection): string {
  return (
    db.prepare("SELECT payload_json FROM bridge_identity_snapshots").get() as {
      payload_json: string;
    }
  ).payload_json;
}

function expectCacheError(
  action: () => unknown,
  code: BridgeIdentityCacheErrorCode,
  operation: "read" | "replace" | "purge",
): void {
  try {
    action();
    throw new Error("Expected bridge cache operation to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeIdentityCacheError);
    const cacheFailure = error as BridgeIdentityCacheError;
    expect(cacheFailure.code).toBe(code);
    expect(cacheFailure.operation).toBe(operation);
    expect(Buffer.byteLength(cacheFailure.message, "utf8")).toBeLessThanOrEqual(
      BRIDGE_IDENTITY_CACHE_ERROR_MAX_MESSAGE_BYTES,
    );
    expect(cacheFailure.message).not.toContain(SECRET);
  }
}

describe("bridge identity snapshot cache", () => {
  let tempDirectory: string;
  let db: DbConnection;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), "rfmedia-bridge-cache-test-"));
    db = await initializeDatabase(join(tempDirectory, "tracking.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it("reprojects a cached snapshot with derived offline stale provenance as frozen data", () => {
    const input = snapshot();

    replaceBridgeIdentitySnapshot(db, input);
    const result = readBridgeIdentitySnapshot(db, SCOPE, CLOCK);

    expect(result).toEqual({
      ...input,
      provenance: {
        source: "sqlite-cache",
        mode: "offline",
        freshness: "stale",
        ageSeconds: 300,
      },
    });
    expect(result).not.toBe(input);
    expect(result?.provenance).not.toBe(input.provenance);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.scope)).toBe(true);
    expect(Object.isFrozen(result?.provenance)).toBe(true);
    expect(Object.isFrozen(result?.completeness)).toBe(true);
    expect(Object.isFrozen(result?.outcomes)).toBe(true);
    expect(Object.isFrozen(result?.outcomes[0])).toBe(true);
    expect(Object.isFrozen(result?.targetArtists)).toBe(true);
    expect(Object.isFrozen(result?.targetArtists[0])).toBe(true);
    const outcome = result?.outcomes[0];
    if (outcome?.state !== "resolved") {
      throw new Error("Expected the round-tripped fixture to remain resolved.");
    }
    expect(Object.isFrozen(outcome.target)).toBe(true);
  });

  it("round-trips a valid raw title whose normalized candidate expands past the raw limit", () => {
    const rawTitle = "&".repeat(MEDIA_IDENTITY_MAX_TITLE_BYTES);
    const expanded = resolveArtistIdentities({
      scope: SCOPE,
      sourceArtists: [{ id: "plex-expanded", kind: "artist", title: rawTitle, externalIds: [] }],
      targetArtists: [
        {
          id: 1,
          artistName: rawTitle,
          foreignArtistId: "",
          monitored: false,
          qualityProfileId: 1,
          metadataProfileId: 1,
          tags: [],
        },
      ],
      sourceComplete: true,
      targetComplete: true,
      capturedAt: CAPTURED_AT,
      verifiedAt: VERIFIED_AT,
    });
    const candidate = expanded.outcomes[0]?.candidates[0];

    expect(candidate).toBeDefined();
    expect(Buffer.byteLength(candidate?.normalizedTitle ?? "", "utf8")).toBeGreaterThan(
      MEDIA_IDENTITY_MAX_TITLE_BYTES,
    );

    replaceBridgeIdentitySnapshot(db, expanded);

    expect(readBridgeIdentitySnapshot(db, SCOPE, CLOCK)?.outcomes[0]?.candidates[0]).toEqual(
      candidate,
    );
  });

  it("clamps cached evidence age to zero when the injected clock precedes capture", () => {
    replaceBridgeIdentitySnapshot(db, snapshot());

    const result = readBridgeIdentitySnapshot(
      db,
      SCOPE,
      () => new Date("2026-07-27T09:00:00.000Z"),
    );

    expect(result?.provenance).toEqual({
      source: "sqlite-cache",
      mode: "offline",
      freshness: "stale",
      ageSeconds: 0,
    });
    expect(Object.isFrozen(result?.provenance)).toBe(true);
  });

  it("stores and retrieves a complete empty artist snapshot", () => {
    const empty = snapshot({ outcomes: [], targetArtists: [] });

    replaceBridgeIdentitySnapshot(db, empty);

    expect(readBridgeIdentitySnapshot(db, SCOPE, CLOCK)).toEqual({
      ...empty,
      provenance: {
        source: "sqlite-cache",
        mode: "offline",
        freshness: "stale",
        ageSeconds: 300,
      },
    });
    expect(JSON.parse(storedPayload(db))).toMatchObject({
      completeness: { sourceArtistCount: 0, targetArtistCount: 0, resolutionCount: 0 },
      outcomes: [],
      targetArtists: [],
    });
  });

  it("returns deterministic zero, one, or many compatible full scopes without choosing one", () => {
    expect(findCompatibleBridgeIdentityScopes(db, SELECTOR, CLOCK)).toEqual([]);

    replaceBridgeIdentitySnapshot(db, snapshot());
    expect(findCompatibleBridgeIdentityScopes(db, SELECTOR, CLOCK)).toHaveLength(1);

    const additionalScopes: BridgeIdentityScope[] = [
      { ...SCOPE, plexInstanceId: "plex-machine-b", plexLibraryId: "9" },
      { ...SCOPE, plexLibraryId: "8" },
    ];
    for (const scope of additionalScopes) {
      replaceBridgeIdentitySnapshot(db, snapshot({ scope }));
    }

    const candidates = findCompatibleBridgeIdentityScopes(db, SELECTOR, CLOCK);

    expect(candidates).toEqual([
      {
        scope: SCOPE,
        capturedAt: CAPTURED_AT,
        verifiedAt: VERIFIED_AT,
        ageSeconds: 300,
      },
      {
        scope: { ...SCOPE, plexLibraryId: "8" },
        capturedAt: CAPTURED_AT,
        verifiedAt: VERIFIED_AT,
        ageSeconds: 300,
      },
      {
        scope: { ...SCOPE, plexInstanceId: "plex-machine-b", plexLibraryId: "9" },
        capturedAt: CAPTURED_AT,
        verifiedAt: VERIFIED_AT,
        ageSeconds: 300,
      },
    ]);
    expect(Object.isFrozen(candidates)).toBe(true);
    expect(candidates.every(Object.isFrozen)).toBe(true);
    expect(candidates.every((candidate) => Object.isFrozen(candidate.scope))).toBe(true);
  });

  it("narrows compatible scopes by library ID and isolates both canonical origins", () => {
    const requested = { ...SCOPE, plexInstanceId: "plex-machine-b", plexLibraryId: "8" };
    const otherMachine = { ...SCOPE, plexInstanceId: "plex-machine-c", plexLibraryId: "8" };
    const isolatedScopes: BridgeIdentityScope[] = [
      SCOPE,
      requested,
      otherMachine,
      { ...SCOPE, plexOrigin: "https://other-plex.example.net", plexLibraryId: "8" },
      { ...SCOPE, lidarrOrigin: "http://other-lidarr.example.net:8686", plexLibraryId: "8" },
    ];
    for (const scope of isolatedScopes) {
      replaceBridgeIdentitySnapshot(db, snapshot({ scope }));
    }

    expect(
      findCompatibleBridgeIdentityScopes(db, { ...SELECTOR, plexLibraryId: "8" }, CLOCK).map(
        (candidate) => candidate.scope,
      ),
    ).toEqual([requested, otherMachine]);
  });

  it("discovers compatible scopes without writing or migrating", () => {
    replaceBridgeIdentitySnapshot(db, snapshot());
    db.pragma("query_only = ON");

    expect(findCompatibleBridgeIdentityScopes(db, SELECTOR, CLOCK)).toHaveLength(1);
  });

  it("selects current compatible evidence when a legacy scope also exists", () => {
    const legacyScope = { ...SCOPE, plexInstanceId: "plex-machine-b", plexLibraryId: "8" };
    replaceBridgeIdentitySnapshot(db, snapshot());
    replaceBridgeIdentitySnapshot(db, snapshot({ scope: legacyScope }));
    db.prepare(
      `UPDATE bridge_identity_snapshots
       SET snapshot_version = 1
       WHERE plex_machine_id = ? AND plex_library_id = ?`,
    ).run(legacyScope.plexInstanceId, legacyScope.plexLibraryId);

    expect(
      findCompatibleBridgeIdentityScopes(db, SELECTOR, CLOCK).map((result) => result.scope),
    ).toEqual([SCOPE]);
  });

  it("classifies invalid JSON in a current-version discovery row as corrupt", () => {
    replaceBridgeIdentitySnapshot(db, snapshot());
    db.prepare("UPDATE bridge_identity_snapshots SET payload_json = ?").run("{not-json");

    expectCacheError(
      () => findCompatibleBridgeIdentityScopes(db, SELECTOR),
      "corrupt-payload",
      "read",
    );
  });

  it("classifies malformed current-version discovery metadata as corrupt", () => {
    replaceBridgeIdentitySnapshot(db, snapshot());
    db.prepare("UPDATE bridge_identity_snapshots SET payload_json = ?").run(
      JSON.stringify({
        ...snapshot(),
        normalizationVersion: String(BRIDGE_ARTIST_NORMALIZATION_VERSION),
      }),
    );

    expectCacheError(
      () => findCompatibleBridgeIdentityScopes(db, SELECTOR),
      "corrupt-payload",
      "read",
    );
  });

  it.each(["normalizationVersion", "scoringVersion"] as const)(
    "classifies boolean current-version %s metadata as corrupt",
    (field) => {
      replaceBridgeIdentitySnapshot(db, snapshot());
      db.prepare("UPDATE bridge_identity_snapshots SET payload_json = ?").run(
        JSON.stringify({
          ...snapshot(),
          [field]: true,
        }),
      );

      expectCacheError(
        () => findCompatibleBridgeIdentityScopes(db, SELECTOR),
        "corrupt-payload",
        "read",
      );
    },
  );

  it("isolates every valid provider-instance scope dimension", () => {
    const scopes: BridgeIdentityScope[] = [
      SCOPE,
      { ...SCOPE, plexOrigin: "https://other-plex.example.net" },
      { ...SCOPE, plexInstanceId: "plex-machine-b" },
      { ...SCOPE, plexLibraryId: "8" },
      { ...SCOPE, lidarrOrigin: "http://other-lidarr.example.net:8686" },
    ];

    for (const [index, scope] of scopes.entries()) {
      replaceBridgeIdentitySnapshot(
        db,
        snapshot({
          scope,
          outcomes: [{ ...RESOLVED, plexId: `plex-artist-${index + 1}` }],
        }),
      );
    }

    expect(rowCount(db)).toBe(scopes.length);
    for (const [index, scope] of scopes.entries()) {
      expect(readBridgeIdentitySnapshot(db, scope)?.outcomes[0]?.plexId).toBe(
        `plex-artist-${index + 1}`,
      );
    }
    expect(
      readBridgeIdentitySnapshot(db, {
        ...SCOPE,
        plexLibraryId: "missing",
      }),
    ).toBeUndefined();
  });

  it("replaces one same-scope generation without creating a mixed generation", () => {
    replaceBridgeIdentitySnapshot(db, snapshot());
    const replacement = snapshot({
      capturedAt: "2026-07-27T11:00:00.000Z",
      verifiedAt: "2026-07-27T10:59:00.000Z",
      outcomes: [{ ...RESOLVED, title: "Updated Artist" }],
    });

    replaceBridgeIdentitySnapshot(db, replacement);

    expect(rowCount(db)).toBe(1);
    expect(readBridgeIdentitySnapshot(db, SCOPE, CLOCK)).toEqual({
      ...replacement,
      provenance: {
        source: "sqlite-cache",
        mode: "offline",
        freshness: "stale",
        ageSeconds: 0,
      },
    });
  });

  it("retains the newer same-scope generation when an older write arrives later", () => {
    const newer = snapshot({
      capturedAt: "2026-07-27T11:00:00.000Z",
      verifiedAt: "2026-07-27T10:59:00.000Z",
      outcomes: [{ ...RESOLVED, title: "Newer Artist" }],
    });
    const older = snapshot({
      capturedAt: "2026-07-27T10:30:00.000Z",
      verifiedAt: "2026-07-27T10:29:00.000Z",
      outcomes: [{ ...RESOLVED, title: "Older Artist" }],
    });

    replaceBridgeIdentitySnapshot(db, newer);
    replaceBridgeIdentitySnapshot(db, older);

    expect(rowCount(db)).toBe(1);
    expect(readBridgeIdentitySnapshot(db, SCOPE, CLOCK)).toEqual({
      ...newer,
      provenance: {
        source: "sqlite-cache",
        mode: "offline",
        freshness: "stale",
        ageSeconds: 0,
      },
    });
    expect(JSON.parse(storedPayload(db))).toMatchObject({
      capturedAt: newer.capturedAt,
      outcomes: [{ title: "Newer Artist" }],
    });
  });

  it("preserves the previous generation when validation or the transactional write fails", () => {
    const original = snapshot();
    replaceBridgeIdentitySnapshot(db, original);

    expectCacheError(
      () =>
        replaceBridgeIdentitySnapshot(
          db,
          snapshot({
            capturedAt: "2026-07-27T08:00:00.000Z",
            verifiedAt: "2026-07-27T09:00:00.000Z",
          }),
        ),
      "invalid-snapshot",
      "replace",
    );
    expect(readBridgeIdentitySnapshot(db, SCOPE, CLOCK)).toEqual({
      ...original,
      provenance: {
        source: "sqlite-cache",
        mode: "offline",
        freshness: "stale",
        ageSeconds: 300,
      },
    });

    db.exec(`
      CREATE TRIGGER reject_bridge_snapshot_update
      BEFORE UPDATE ON bridge_identity_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'test update rejection');
      END
    `);
    expectCacheError(
      () =>
        replaceBridgeIdentitySnapshot(
          db,
          snapshot({
            capturedAt: "2026-07-27T11:00:00.000Z",
            verifiedAt: "2026-07-27T10:59:00.000Z",
          }),
        ),
      "database",
      "replace",
    );
    db.exec("DROP TRIGGER reject_bridge_snapshot_update");
    expect(readBridgeIdentitySnapshot(db, SCOPE, CLOCK)).toEqual({
      ...original,
      provenance: {
        source: "sqlite-cache",
        mode: "offline",
        freshness: "stale",
        ageSeconds: 300,
      },
    });
  });

  it("rejects non-canonical, credential-bearing, empty, and wrong-kind scopes", () => {
    const invalidScopes: BridgeIdentityScope[] = [
      { ...SCOPE, plexOrigin: `http://user:${SECRET}@plex.example.net:32400` },
      { ...SCOPE, lidarrOrigin: "https://lidarr.example.net/api/v1" },
      { ...SCOPE, plexInstanceId: "" },
      { ...SCOPE, plexLibraryId: "bad\u001bvalue" },
      { ...SCOPE, entityKind: "album" as "artist" },
    ];

    for (const scope of invalidScopes) {
      expectCacheError(
        () => replaceBridgeIdentitySnapshot(db, snapshot({ scope })),
        "invalid-scope",
        "replace",
      );
    }
    expect(rowCount(db)).toBe(0);
  });

  it("strips unknown secret and raw-wire properties before persistence", () => {
    const input = {
      ...snapshot(),
      apiKey: SECRET,
      token: SECRET,
      rawGuid: `mbid://${ARTIST_MBID}?token=${SECRET}`,
      providerBody: { token: SECRET },
    };

    replaceBridgeIdentitySnapshot(db, input);

    const dump = JSON.stringify(db.prepare("SELECT * FROM bridge_identity_snapshots").all());
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("rawGuid");
    expect(dump).not.toContain("providerBody");
    expect(dump).not.toContain("apiKey");
  });

  it("throws bounded typed errors for corrupt, oversized, and incompatible rows", () => {
    replaceBridgeIdentitySnapshot(db, snapshot());

    db.prepare("UPDATE bridge_identity_snapshots SET payload_json = ?").run("{not-json");
    expectCacheError(() => readBridgeIdentitySnapshot(db, SCOPE), "corrupt-payload", "read");

    db.prepare("UPDATE bridge_identity_snapshots SET payload_json = ?").run(
      "x".repeat(BRIDGE_IDENTITY_SNAPSHOT_MAX_BYTES + 1),
    );
    expectCacheError(() => readBridgeIdentitySnapshot(db, SCOPE), "payload-too-large", "read");

    db.prepare("UPDATE bridge_identity_snapshots SET snapshot_version = ?, payload_json = ?").run(
      1,
      JSON.stringify(snapshot()),
    );
    expectCacheError(() => readBridgeIdentitySnapshot(db, SCOPE), "incompatible-version", "read");
    expectCacheError(
      () => findCompatibleBridgeIdentityScopes(db, SELECTOR),
      "incompatible-version",
      "read",
    );

    db.prepare("UPDATE bridge_identity_snapshots SET snapshot_version = ?, payload_json = ?").run(
      BRIDGE_IDENTITY_SNAPSHOT_VERSION,
      JSON.stringify({ ...snapshot(), normalizationVersion: 0 }),
    );
    expectCacheError(
      () => findCompatibleBridgeIdentityScopes(db, SELECTOR),
      "incompatible-version",
      "read",
    );
  });

  it("strictly rejects malformed payload references, versions, and identifiers", () => {
    replaceBridgeIdentitySnapshot(db, snapshot());
    const malformed = structuredClone(snapshot()) as unknown as {
      snapshotVersion: number;
      outcomes: Array<{
        target: { artistMbid: string };
      }>;
    };
    malformed.outcomes[0]!.target.artistMbid = TARGET_MBID;
    db.prepare("UPDATE bridge_identity_snapshots SET payload_json = ?").run(
      JSON.stringify(malformed),
    );

    expectCacheError(() => readBridgeIdentitySnapshot(db, SCOPE), "corrupt-payload", "read");

    malformed.snapshotVersion = 1;
    db.prepare("UPDATE bridge_identity_snapshots SET payload_json = ?").run(
      JSON.stringify(malformed),
    );
    expectCacheError(() => readBridgeIdentitySnapshot(db, SCOPE), "incompatible-version", "read");
  });

  it("rejects a corrupt target catalog without replacing the previous generation", () => {
    const original = snapshot();
    replaceBridgeIdentitySnapshot(db, original);
    const corrupt = structuredClone(
      snapshot({
        capturedAt: "2026-07-27T11:00:00.000Z",
        verifiedAt: "2026-07-27T10:59:00.000Z",
      }),
    ) as unknown as {
      targetArtists: Array<{ lidarrId: number }>;
    };
    corrupt.targetArtists[1]!.lidarrId = corrupt.targetArtists[0]!.lidarrId;

    expectCacheError(
      () => replaceBridgeIdentitySnapshot(db, corrupt as unknown as BridgeArtistIdentitySnapshot),
      "invalid-snapshot",
      "replace",
    );
    expect(readBridgeIdentitySnapshot(db, SCOPE, CLOCK)?.targetArtists).toEqual(
      original.targetArtists,
    );
  });

  it("rejects a poisoned ambiguous duplicate-target-MBID outcome", () => {
    replaceBridgeIdentitySnapshot(db, snapshot());
    const poisoned = structuredClone(snapshot()) as unknown as {
      outcomes: Array<Record<string, unknown>>;
    };
    poisoned.outcomes[0] = {
      plexId: "plex-artist-1",
      title: "Massive Attack",
      state: "ambiguous",
      reason: "duplicate-target-mbid",
      method: "none",
      candidates: [],
    };
    db.prepare("UPDATE bridge_identity_snapshots SET payload_json = ?").run(
      JSON.stringify(poisoned),
    );

    expectCacheError(() => readBridgeIdentitySnapshot(db, SCOPE), "corrupt-payload", "read");
  });

  it("purges only the exact requested scope and reports the deleted count", () => {
    const otherScope = { ...SCOPE, plexLibraryId: "8" };
    replaceBridgeIdentitySnapshot(db, snapshot());
    replaceBridgeIdentitySnapshot(db, snapshot({ scope: otherScope }));

    expect(purgeBridgeIdentitySnapshot(db, SCOPE)).toBe(1);
    expect(purgeBridgeIdentitySnapshot(db, SCOPE)).toBe(0);
    expect(readBridgeIdentitySnapshot(db, SCOPE)).toBeUndefined();
    expect(readBridgeIdentitySnapshot(db, otherScope)).toBeDefined();
  });
});
