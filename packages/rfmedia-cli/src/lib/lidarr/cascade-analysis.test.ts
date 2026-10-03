import { describe, expect, it } from "vitest";

import { LidarrPlanValidationError } from "../errors.js";
import {
  analyzeLidarrCascade,
  checkedLidarrCascadeAdd,
  checkedLidarrCascadeMultiply,
  resolveLidarrCascadePolicy,
  type LidarrCascadePlanFacts,
} from "./cascade-analysis.js";

const fullPolicy = resolveLidarrCascadePolicy({
  assumptions: { albumsPerArtist: 3, indexerQueriesPerCandidate: 2 },
  budgets: { indexerQueries: 6, acquisitionCandidates: 3 },
});

function analyze(facts: LidarrCascadePlanFacts) {
  return analyzeLidarrCascade(facts, fullPolicy);
}

describe("resolveLidarrCascadePolicy", () => {
  it("seals explicit null omissions and deeply freezes the snapshot", () => {
    const policy = resolveLidarrCascadePolicy(undefined);

    expect(policy).toEqual({
      assumptions: {
        albumsPerArtist: null,
        indexerQueriesPerCandidate: null,
      },
      budgets: { indexerQueries: null, acquisitionCandidates: null },
    });
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.assumptions)).toBe(true);
    expect(Object.isFrozen(policy.budgets)).toBe(true);
  });

  it.each([0, -1, 1_000_001, Number.MAX_SAFE_INTEGER, 1.5])(
    "rejects an invalid bounded value %s",
    (value) => {
      expect(() =>
        resolveLidarrCascadePolicy({
          assumptions: { albumsPerArtist: value },
        }),
      ).toThrow(LidarrPlanValidationError);
    },
  );
});

describe("analyzeLidarrCascade operation matrix", () => {
  it("models changed artist monitoring and treats equality as within", () => {
    const result = analyze({
      operation: { kind: "artist-monitoring", desiredMonitored: true },
      entries: [
        { before: { monitored: false }, after: { monitored: true } },
        { before: { monitored: true }, after: { monitored: true } },
      ],
    });

    expect(result.metrics.immediateIndexerQueries.value).toBe(0);
    expect(result.metrics.acquisitionCandidates).toMatchObject({
      value: 3,
      certainty: "modelled",
      horizon: "conditional",
    });
    expect(result.metrics.conditionalIndexerQueries.value).toBe(6);
    expect(result.metrics.newlyMonitored.value).toBe(1);
    expect(result.budgets.indexerQueries.status).toBe("within");
    expect(result.budgets.acquisitionCandidates.status).toBe("within");
    expect(result.warnings).toEqual([]);
  });

  it("keeps assumption-dependent artist and query projections unknown", () => {
    const missingAlbums = analyzeLidarrCascade(
      {
        operation: { kind: "artist-monitoring", desiredMonitored: true },
        entries: [{ before: { monitored: false }, after: { monitored: true } }],
      },
      resolveLidarrCascadePolicy({
        budgets: { acquisitionCandidates: 1 },
      }),
    );
    const missingQueries = analyzeLidarrCascade(
      {
        operation: { kind: "album-monitoring", desiredMonitored: true },
        entries: [{ before: { monitored: false }, after: { monitored: true } }],
      },
      resolveLidarrCascadePolicy({ budgets: { indexerQueries: 1 } }),
    );

    expect(missingAlbums.metrics.acquisitionCandidates).toMatchObject({
      value: null,
      certainty: "unknown",
    });
    expect(missingAlbums.budgets.acquisitionCandidates.status).toBe("unknown");
    expect(missingQueries.metrics.acquisitionCandidates.value).toBe(1);
    expect(missingQueries.metrics.conditionalIndexerQueries).toMatchObject({
      value: null,
      certainty: "unknown",
      basis: "indexer-queries-per-candidate-not-configured",
    });
    expect(missingQueries.budgets.indexerQueries.status).toBe("unknown");
  });

  it("keeps unmonitoring and no-op entries at exact zero", () => {
    const result = analyze({
      operation: { kind: "artist-monitoring", desiredMonitored: false },
      entries: [
        { before: { monitored: true }, after: { monitored: false } },
        { before: { monitored: false }, after: { monitored: false } },
      ],
    });

    expect(result.metrics.acquisitionCandidates).toMatchObject({
      value: 0,
      certainty: "exact",
      horizon: "none",
    });
    expect(result.metrics.conditionalIndexerQueries.value).toBe(0);
  });

  it("counts changed false-to-true albums exactly", () => {
    const result = analyze({
      operation: { kind: "album-monitoring", desiredMonitored: true },
      entries: [
        { before: { monitored: false }, after: { monitored: true } },
        { before: { monitored: true }, after: { monitored: true } },
      ],
    });

    expect(result.metrics.acquisitionCandidates).toMatchObject({
      value: 1,
      certainty: "exact",
    });
    expect(result.metrics.newlyMonitored.value).toBe(1);
  });

  it.each(["artist-profile-assignment", "artist-tag-mutation", "album-edit"] as const)(
    "preserves unknown conditional exposure for changed %s facts",
    (kind) => {
      const facts: LidarrCascadePlanFacts =
        kind === "artist-profile-assignment"
          ? {
              operation: { kind },
              entries: [
                {
                  before: { qualityProfile: { id: 1 } },
                  after: { qualityProfile: { id: 2 } },
                },
              ],
            }
          : kind === "artist-tag-mutation"
            ? {
                operation: { kind },
                entries: [{ added: [{}], removed: [] }],
              }
            : {
                operation: { kind },
                entries: [
                  {
                    before: { anyReleaseOk: false },
                    after: { anyReleaseOk: true },
                  },
                ],
              };

      expect(analyze(facts).metrics.acquisitionCandidates).toMatchObject({
        value: null,
        certainty: "unknown",
        basis: "release-automation-evidence-unavailable",
      });
    },
  );

  it("keeps unchanged profile, tag, and album-edit facts at exact zero", () => {
    const facts: readonly LidarrCascadePlanFacts[] = [
      {
        operation: { kind: "artist-profile-assignment" },
        entries: [{ before: {}, after: {} }],
      },
      {
        operation: { kind: "artist-tag-mutation" },
        entries: [{ added: [], removed: [] }],
      },
      {
        operation: { kind: "album-edit" },
        entries: [
          {
            before: { anyReleaseOk: true },
            after: { anyReleaseOk: true },
          },
        ],
      },
    ];

    expect(facts.map((entry) => analyze(entry).metrics.acquisitionCandidates.value)).toEqual([
      0, 0, 0,
    ]);
  });

  it("models monitored artist adds and keeps unmonitored adds exact zero", () => {
    const monitored = analyze({
      operation: {
        kind: "artist-add",
        monitored: true,
        searchForMissingAlbums: false,
      },
      entries: [{ after: { monitored: true } }, { after: { monitored: true } }],
    });
    const unmonitored = analyze({
      operation: {
        kind: "artist-add",
        monitored: false,
        searchForMissingAlbums: false,
      },
      entries: [{ after: { monitored: false } }],
    });

    expect(monitored.metrics.acquisitionCandidates.value).toBe(6);
    expect(unmonitored.metrics.acquisitionCandidates.value).toBe(0);
  });

  it("reports deletion file evidence without inventing acquisition exposure", () => {
    const artist = analyze({
      operation: { kind: "artist-delete", deleteFiles: true },
      entries: [
        {
          before: { albumCount: 2, trackFileCount: 4, sizeOnDisk: 100 },
        },
        {
          before: { albumCount: 1, trackFileCount: 3, sizeOnDisk: 50 },
        },
      ],
    });
    const album = analyze({
      operation: { kind: "album-delete", deleteFiles: false },
      entries: [{ before: { trackFileCount: 9, sizeOnDisk: 999 } }],
    });

    expect(artist.metrics.acquisitionCandidates.value).toBe(0);
    expect(artist.metrics.filesAffected.value).toBe(7);
    expect(artist.metrics.bytesAffected.value).toBe(150);
    expect(album.metrics.filesAffected.value).toBe(0);
    expect(album.metrics.bytesAffected.value).toBe(0);
  });

  it("uses sealed album monitoring evidence for track-filter reacquisition", () => {
    const monitored = analyze({
      operation: { kind: "track-file-filter" },
      entries: [
        {
          before: {
            albumMonitored: true,
            deleteCandidates: [{ size: 10 }, { size: 20 }],
          },
        },
      ],
    });
    const unmonitored = analyze({
      operation: { kind: "track-file-filter" },
      entries: [
        {
          before: {
            albumMonitored: false,
            deleteCandidates: [{ size: 10 }],
          },
        },
      ],
    });

    expect(monitored.metrics.acquisitionCandidates.value).toBe(1);
    expect(monitored.metrics.filesAffected.value).toBe(2);
    expect(monitored.metrics.bytesAffected.value).toBe(30);
    expect(unmonitored.metrics.acquisitionCandidates.value).toBe(0);
  });
});

describe("budget assessments and deterministic codes", () => {
  it("preserves unknown values and emits ordered incomplete warnings", () => {
    const result = analyzeLidarrCascade(
      {
        operation: { kind: "artist-profile-assignment" },
        entries: [
          {
            before: { qualityProfile: { id: 1 } },
            after: { qualityProfile: { id: 2 } },
          },
        ],
      },
      resolveLidarrCascadePolicy({
        budgets: { indexerQueries: 1, acquisitionCandidates: 1 },
      }),
    );

    expect(result.budgets).toMatchObject({
      indexerQueries: { status: "unknown", projected: null, limit: 1 },
      acquisitionCandidates: {
        status: "unknown",
        projected: null,
        limit: 1,
      },
    });
    expect(result.warnings.map(({ code, metric }) => [code, metric])).toEqual([
      ["budget-assessment-incomplete", "indexerQueries"],
      ["budget-assessment-incomplete", "acquisitionCandidates"],
    ]);
    expect(result.recommendations).toEqual(["reduce-scope"]);
  });

  it("emits query then acquisition exceedance and fixed recommendations", () => {
    const result = analyzeLidarrCascade(
      {
        operation: { kind: "album-monitoring", desiredMonitored: true },
        entries: [
          { before: { monitored: false }, after: { monitored: true } },
          { before: { monitored: false }, after: { monitored: true } },
        ],
      },
      resolveLidarrCascadePolicy({
        assumptions: { indexerQueriesPerCandidate: 2 },
        budgets: { indexerQueries: 3, acquisitionCandidates: 1 },
      }),
    );

    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "indexer-query-budget-exceeded",
      "acquisition-budget-exceeded",
    ]);
    expect(result.recommendations).toEqual(["reduce-scope", "split-into-batches", "delay-apply"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.metrics)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
  });

  it("keeps omitted allowances not configured", () => {
    const result = analyzeLidarrCascade(
      {
        operation: { kind: "album-monitoring", desiredMonitored: true },
        entries: [{ before: { monitored: false }, after: { monitored: true } }],
      },
      resolveLidarrCascadePolicy({
        assumptions: { indexerQueriesPerCandidate: 1 },
      }),
    );

    expect(result.budgets.indexerQueries.status).toBe("not-configured");
    expect(result.budgets.acquisitionCandidates.status).toBe("not-configured");
    expect(result.warnings).toEqual([]);
  });
});

describe("checked cascade arithmetic", () => {
  it("rejects unsafe addition and multiplication", () => {
    expect(() => checkedLidarrCascadeAdd(Number.MAX_SAFE_INTEGER, 1)).toThrow(
      "cascade analysis arithmetic overflow",
    );
    expect(() => checkedLidarrCascadeMultiply(Number.MAX_SAFE_INTEGER, 2)).toThrow(
      "cascade analysis arithmetic overflow",
    );
  });
});
