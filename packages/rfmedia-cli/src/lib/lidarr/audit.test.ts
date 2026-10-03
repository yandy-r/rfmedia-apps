import { describe, expect, it } from "vitest";

import {
  availableSlot,
  createLidarrAuditGatheredDataFixture,
  createLidarrAuditPlexProbeFixture,
  createLidarrAuditQueueStateFixture,
  createLidarrHealthReportFixture,
  unavailableSlot,
} from "../../actions/test-helpers/lidarr-audit-fixtures.js";
import {
  createLidarrAlbumFixture,
  createLidarrArtistFixture,
  createLidarrArtistStatisticsFixture,
  createLidarrHealthCheckFixture,
} from "../../actions/test-helpers/lidarr-fixtures.js";
import {
  LIDARR_AUDIT_CHECK_DESCRIPTORS,
  LIDARR_AUDIT_CHECK_IDS,
  LIDARR_AUDIT_FINDING_CODES,
  LIDARR_AUDIT_MAX_SUBJECTS,
  shouldFailLidarrAudit,
} from "../../types/lidarr-audit.js";
import type {
  LidarrAuditCheckDescriptor,
  LidarrAuditCheckId,
  LidarrAuditCheckResult,
  LidarrAuditFailOn,
  LidarrAuditFinding,
  LidarrAuditFindingCode,
  LidarrAuditGatheredData,
  LidarrAuditPlexProbe,
  LidarrAuditQueueState,
  LidarrAuditReport,
  LidarrAuditSlot,
} from "../../types/lidarr-audit.js";
import { LookupNotFoundError } from "../errors.js";
import {
  resolveLidarrAuditRequirements,
  resolveLidarrAuditSelection,
  runLidarrAudit,
} from "./audit.js";

const CHECKED_AT = "2026-07-25T00:00:00.000Z";
const ORIGIN = "http://lidarr.test:8686";

/** Any mutating follow-up; `remediation.command` must never match it. */
const MUTATING_COMMAND_PATTERN = /lidarr apply|[-\s]delete\b/u;

/** The registry widened once, so a union-keyed index yields one descriptor type. */
const DESCRIPTORS: Readonly<Record<LidarrAuditCheckId, LidarrAuditCheckDescriptor>> =
  LIDARR_AUDIT_CHECK_DESCRIPTORS;

type SkippedCheckResult = Extract<LidarrAuditCheckResult, { readonly status: "skipped" }>;

// ── Harness ─────────────────────────────────────────────────────────────────

/** Runs the engine over the default gather bundle with `gathered` merged in. */
function runAudit(
  gathered: Partial<LidarrAuditGatheredData> = {},
  selected: readonly LidarrAuditCheckId[] = LIDARR_AUDIT_CHECK_IDS,
  deep = true,
): LidarrAuditReport {
  return runLidarrAudit({
    checkedAt: CHECKED_AT,
    origin: ORIGIN,
    deep,
    selected: new Set(selected),
    gathered: createLidarrAuditGatheredDataFixture(gathered),
  });
}

/**
 * An `available` slot whose payload throws the moment an evaluator reads it.
 *
 * The engine only touches `status` while gating, so this fails inside the
 * per-check `try` and nowhere else — exactly the isolation path under test.
 */
function explodingSlot<T>(message: string): LidarrAuditSlot<T> {
  const slot: LidarrAuditSlot<T> = {
    status: "available",
    get data(): T {
      throw new Error(message);
    },
  };
  return Object.freeze(slot);
}

/** Reads one check verdict out of a report, failing loudly when it is absent. */
function checkById(report: LidarrAuditReport, id: LidarrAuditCheckId): LidarrAuditCheckResult {
  const found = report.checks.find((check) => check.id === id);
  if (found === undefined) {
    throw new Error(`report carries no verdict for check ${id}`);
  }
  return found;
}

/** Narrows a check verdict to the skipped arm. */
function expectSkipped(report: LidarrAuditReport, id: LidarrAuditCheckId): SkippedCheckResult {
  const check = checkById(report, id);
  if (check.status !== "skipped") {
    throw new Error(`expected check ${id} to be skipped, got ${check.status}`);
  }
  return check;
}

/** Finding codes emitted by one check, in emission order. */
function codesFor(
  report: LidarrAuditReport,
  id: LidarrAuditCheckId,
): readonly LidarrAuditFindingCode[] {
  return report.findings.filter((finding) => finding.checkId === id).map((finding) => finding.code);
}

/** The single finding carrying `code`, failing loudly when absent or repeated. */
function findingByCode(
  report: LidarrAuditReport,
  code: LidarrAuditFindingCode,
): LidarrAuditFinding {
  const matches = report.findings.filter((finding) => finding.code === code);
  const [first] = matches;
  if (first === undefined || matches.length > 1) {
    throw new Error(`expected exactly one ${code} finding, got ${matches.length}`);
  }
  return first;
}

// ── Shared health checks ────────────────────────────────────────────────────

const METADATA_ERROR = createLidarrHealthCheckFixture({
  source: "MetadataSourceCheck",
  type: "error",
  message: "Skyhook is unavailable",
  wikiUrl: "https://wiki.servarr.com/lidarr/system#metadata",
});

const ROOT_FOLDER_ERROR = createLidarrHealthCheckFixture({
  source: "RootFolderCheck",
  type: "error",
  message: "Missing root folder: /music",
  wikiUrl: "https://wiki.servarr.com/lidarr/system#missing-root-folder",
});

const INDEXER_WARNING = createLidarrHealthCheckFixture({
  source: "IndexerStatusCheck",
  type: "warning",
  message: "One or more indexers are unavailable.",
});

const UPDATE_NOTICE = createLidarrHealthCheckFixture({
  source: "UpdateCheck",
  type: "notice",
  message: "A new release is available.",
});

const HEALTHY_NOTICE = createLidarrHealthCheckFixture({
  source: "ImportListStatusCheck",
  type: "ok",
  message: "All import lists are responding.",
});

// ── Scenario gather bundles ─────────────────────────────────────────────────
// Each bundle is reused by its focused suite AND by the contract sweeps below,
// so the sweeps can never drift away from the cases they are meant to cover.

/** Transport-level failure: the probe answered `unreachable`. */
const UNREACHABLE_HEALTH: Partial<LidarrAuditGatheredData> = {
  health: availableSlot(createLidarrHealthReportFixture({ status: "unreachable" })),
};

/** Metadata-provider outage, plus a co-located non-metadata error. */
const METADATA_OUTAGE: Partial<LidarrAuditGatheredData> = {
  health: availableSlot(
    createLidarrHealthReportFixture({
      status: "degraded",
      errors: [METADATA_ERROR],
      metadataProvider: { available: false, failingChecks: [METADATA_ERROR] },
    }),
  ),
};

/**
 * One check of every wire severity.
 *
 * `LidarrHealthReport` has no `notices` array, so the `notice` and `ok` checks
 * ride along in `warnings`; the evaluator translates on `check.type` alone,
 * which is precisely the mapping under test.
 */
const HEALTH_CONDITIONS: Partial<LidarrAuditGatheredData> = {
  health: availableSlot(
    createLidarrHealthReportFixture({
      status: "degraded",
      errors: [ROOT_FOLDER_ERROR],
      warnings: [INDEXER_WARNING, UPDATE_NOTICE, HEALTHY_NOTICE],
    }),
  ),
};

/** A blank path and an absent path, alongside one correctly rooted artist. */
const UNROOTED_ARTISTS: Partial<LidarrAuditGatheredData> = {
  artists: availableSlot([
    createLidarrArtistFixture({
      id: 1,
      artistName: "Blank Path",
      foreignArtistId: "mbid-blank",
      path: "   ",
    }),
    createLidarrArtistFixture({ id: 2, artistName: "No Path", foreignArtistId: "mbid-none" }),
    createLidarrArtistFixture({
      id: 3,
      artistName: "Rooted",
      foreignArtistId: "mbid-rooted",
      path: "/music/Rooted",
    }),
  ]),
};

/** Open and half-open circuits with a live deferred-intent backlog. */
const CIRCUITS_TRIPPED: Partial<LidarrAuditGatheredData> = {
  queue: availableSlot(
    createLidarrAuditQueueStateFixture({
      circuits: [
        {
          scope: "lidarr",
          state: {
            state: "open",
            openedAt: "2026-07-24T23:00:00.000Z",
            cooldownMs: 60_000,
            reason: "lidarr-unreachable",
          },
          retryAtIso: "2026-07-25T00:01:00.000Z",
        },
        {
          scope: "metadata",
          state: {
            state: "half-open",
            probeStartedAt: "2026-07-24T23:59:00.000Z",
            reason: "timeout",
          },
        },
      ],
      counts: { pending: 3, "in-progress": 0, succeeded: 0, failed: 2, cancelled: 0 },
      oldestPendingAgeSeconds: 900,
      overdue: 1,
      nearExhaustion: 2,
    }),
  ),
};

/** An unreadable circuit and an unreadable per-row detail read. */
const QUEUE_DEGRADED: Partial<LidarrAuditGatheredData> = {
  queue: availableSlot(
    createLidarrAuditQueueStateFixture({
      circuits: [
        {
          scope: "lidarr",
          state: { state: "unknown", reason: "cannot open tracking database: EACCES" },
        },
      ],
      detailUnavailableReason: "cannot read deferred-intent detail: malformed row",
    }),
  ),
};

/** A monitored album under an unmonitored artist, plus an idle monitored artist. */
const MONITORING_DRIFT: Partial<LidarrAuditGatheredData> = {
  artists: availableSlot([
    createLidarrArtistFixture({
      id: 1,
      artistName: "Unmonitored Owner",
      foreignArtistId: "mbid-owner-1",
      monitored: false,
      path: "/music/One",
    }),
    createLidarrArtistFixture({
      id: 2,
      artistName: "Idle Owner",
      foreignArtistId: "mbid-owner-2",
      monitored: true,
      path: "/music/Two",
    }),
  ]),
  albums: availableSlot({
    albums: [
      createLidarrAlbumFixture({ id: 200, artistId: 1, title: "Orphaned", monitored: true }),
      createLidarrAlbumFixture({ id: 201, artistId: 2, title: "Unwatched", monitored: false }),
    ],
    artistNames: new Map([
      [1, "Unmonitored Owner"],
      [2, "Idle Owner"],
    ]),
    artistsScanned: 2,
  }),
};

/**
 * Every library-gap shape at once: an empty monitored artist, a wanted backlog,
 * an undated gap, a future release that is NOT a gap, and a partial album.
 */
const LIBRARY_GAPS: Partial<LidarrAuditGatheredData> = {
  artists: availableSlot([
    createLidarrArtistFixture({
      id: 1,
      artistName: "Empty Artist",
      foreignArtistId: "mbid-empty",
      path: "/music/One",
      statistics: createLidarrArtistStatisticsFixture({ trackCount: 10, trackFileCount: 0 }),
    }),
  ]),
  wanted: availableSlot({ total: 5 }),
  albums: availableSlot({
    albums: [
      createLidarrAlbumFixture({ id: 300, artistId: 1, title: "Undated", monitored: true }),
      createLidarrAlbumFixture({
        id: 301,
        artistId: 1,
        title: "Unreleased",
        monitored: true,
        releaseDate: "2099-01-01",
      }),
      createLidarrAlbumFixture({
        id: 302,
        artistId: 1,
        title: "Partial",
        monitored: true,
        statistics: { trackCount: 10, trackFileCount: 4 },
      }),
    ],
    artistNames: new Map([[1, "Empty Artist"]]),
    artistsScanned: 1,
  }),
};

/** Shared MBIDs, separator-equivalent paths, folded-name collisions, dup albums. */
const DUPLICATE_IDENTITY: Partial<LidarrAuditGatheredData> = {
  artists: availableSlot([
    createLidarrArtistFixture({
      id: 1,
      artistName: "Artist A",
      foreignArtistId: "mbid-shared",
      path: "/music/A",
    }),
    createLidarrArtistFixture({
      id: 2,
      artistName: "Artist B",
      foreignArtistId: "mbid-shared",
      path: "/music/B",
    }),
    createLidarrArtistFixture({
      id: 3,
      artistName: "Artist C",
      foreignArtistId: "mbid-c",
      path: "/music/Shared/",
    }),
    createLidarrArtistFixture({
      id: 4,
      artistName: "Artist D",
      foreignArtistId: "mbid-d",
      path: "/music//Shared",
    }),
    createLidarrArtistFixture({
      id: 5,
      artistName: "Björk",
      foreignArtistId: "mbid-e",
      path: "/music/E",
    }),
    createLidarrArtistFixture({
      id: 6,
      artistName: "The Bjork!",
      foreignArtistId: "mbid-f",
      path: "/music/F",
    }),
  ]),
  albums: availableSlot({
    albums: [
      createLidarrAlbumFixture({
        id: 400,
        artistId: 1,
        title: "Release",
        foreignAlbumId: "mbid-release",
      }),
      createLidarrAlbumFixture({
        id: 401,
        artistId: 2,
        title: "Release (reissue)",
        foreignAlbumId: "mbid-release",
      }),
    ],
    artistNames: new Map([
      [1, "Artist A"],
      [2, "Artist B"],
    ]),
    artistsScanned: 2,
  }),
};

/** Plex rejected the credentials outright. */
const PLEX_UNREACHABLE: Partial<LidarrAuditGatheredData> = {
  plex: availableSlot({
    reachable: false,
    code: "authentication",
    message: "Plex rejected the token",
  }),
};

/** Plex answered, but exposes no music section. */
const PLEX_NO_LIBRARY: Partial<LidarrAuditGatheredData> = {
  plex: availableSlot(createLidarrAuditPlexProbeFixture({ libraries: [] })),
};

/** Plex answered, but the configured library name does not resolve. */
const PLEX_NAME_UNRESOLVED: Partial<LidarrAuditGatheredData> = {
  plex: availableSlot(
    createLidarrAuditPlexProbeFixture({
      configuredLibraryName: "Vinyl",
      configuredLibraryResolved: false,
      resolutionDetail: 'Library "Vinyl" not found. Available: Music',
    }),
  ),
};

const SWEEP_SCENARIOS: readonly Partial<LidarrAuditGatheredData>[] = [
  UNREACHABLE_HEALTH,
  METADATA_OUTAGE,
  HEALTH_CONDITIONS,
  UNROOTED_ARTISTS,
  CIRCUITS_TRIPPED,
  QUEUE_DEGRADED,
  MONITORING_DRIFT,
  LIBRARY_GAPS,
  DUPLICATE_IDENTITY,
  PLEX_UNREACHABLE,
  PLEX_NO_LIBRARY,
  PLEX_NAME_UNRESOLVED,
];

// ── Registry ────────────────────────────────────────────────────────────────

describe("LIDARR_AUDIT_CHECK_DESCRIPTORS", () => {
  it("declares one kebab-case, self-identifying descriptor per registered id", () => {
    const ids = [...LIDARR_AUDIT_CHECK_IDS];

    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(LIDARR_AUDIT_CHECK_DESCRIPTORS)).toEqual(ids);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z]+(?:-[a-z]+)*$/u);
      expect(DESCRIPTORS[id].id).toBe(id);
    }
  });

  it("partitions the finding-code contract across the per-check lists", () => {
    const perCheck = LIDARR_AUDIT_CHECK_IDS.flatMap((id) => [...DESCRIPTORS[id].findingCodes]);

    expect(new Set(perCheck).size).toBe(perCheck.length);
    expect(perCheck).toEqual([...LIDARR_AUDIT_FINDING_CODES]);
    expect(DESCRIPTORS["plex-alignment"].findingCodes).toEqual([]);
  });
});

// ── Engine ──────────────────────────────────────────────────────────────────

describe("runLidarrAudit", () => {
  it("reports every registered check exactly once, in registry order", () => {
    const report = runAudit({}, ["retry-backlog"]);

    expect(report.checks.map((check) => check.id)).toEqual([...LIDARR_AUDIT_CHECK_IDS]);
    expect(expectSkipped(report, "library-gaps").skipReason).toBe("not-selected");
    expect(report.status).toBe("clean");
  });

  it("always skips plex-alignment with identity-mapping-unavailable, Plex or not", () => {
    const report = runAudit();

    const skipped = expectSkipped(report, "plex-alignment");
    expect(checkById(report, "plex-connectivity").status).toBe("pass");
    expect(skipped.skipReason).toBe("identity-mapping-unavailable");
    expect(skipped.detail).toContain("rfmedia lidarr reconcile");
    expect(codesFor(report, "plex-alignment")).toEqual([]);
    expect(report.status).toBe("clean");
  });

  it("reports plex-alignment as plex-not-configured when Plex has no credentials", () => {
    const report = runAudit({ plex: unavailableSlot("plex-not-configured", "no url or token") });

    const skipped = expectSkipped(report, "plex-alignment");
    expect(skipped.skipReason).toBe("plex-not-configured");
    expect(skipped.detail).toContain("rfmedia lidarr reconcile");
  });

  it("propagates a blocking requirement's own reason and detail", () => {
    const detail = "the deep album scan needs --deep";
    const report = runAudit({ albums: unavailableSlot("requires-deep", detail) }, undefined, false);

    const skipped = expectSkipped(report, "monitoring-drift");
    expect(skipped.skipReason).toBe("requires-deep");
    expect(skipped.detail).toBe(detail);
  });

  it("never gates a check on an enriching slot", () => {
    const report = runAudit(
      { ...LIBRARY_GAPS, albums: unavailableSlot("requires-deep", "no --deep") },
      ["library-gaps"],
      false,
    );

    expect(checkById(report, "library-gaps").status).toBe("findings");
    expect(codesFor(report, "library-gaps")).toEqual([
      "artist-monitored-no-files",
      "wanted-backlog",
    ]);
    expect(report.status).toBe("findings");
  });

  it("isolates a throwing evaluator into a check-error skip", () => {
    const message = "boom: circuit payload unavailable";
    const report = runAudit({ queue: explodingSlot<LidarrAuditQueueState>(message) });

    const skipped = expectSkipped(report, "retry-backlog");
    expect(skipped.skipReason).toBe("check-error");
    expect(skipped.detail).toBe(message);
    expect(report.status).toBe("degraded");
    expect(
      report.checks.filter(
        (check) => check.status === "skipped" && check.skipReason === "check-error",
      ),
    ).toHaveLength(1);
    expect(checkById(report, "metadata-dependency").status).toBe("pass");
    expect(checkById(report, "plex-connectivity").status).toBe("pass");
  });

  it("degrades on a data-unavailable slot a selected check consumes", () => {
    const detail = "Lidarr is unreachable; the health probe failed at the transport level";
    const report = runAudit({ wanted: unavailableSlot("data-unavailable", detail) }, [
      "library-gaps",
    ]);

    const skipped = expectSkipped(report, "library-gaps");
    expect(skipped.skipReason).toBe("data-unavailable");
    expect(skipped.detail).toBe(detail);
    expect(report.status).toBe("degraded");
  });

  it("ignores a data-unavailable slot no selected check consumes", () => {
    const report = runAudit({ wanted: unavailableSlot("data-unavailable", "gone") }, [
      "retry-backlog",
    ]);

    expect(report.status).toBe("clean");
  });

  it("never degrades on an expected absence", () => {
    const report = runAudit(
      {
        albums: unavailableSlot("requires-deep", "no --deep"),
        plex: unavailableSlot("plex-not-configured", "no url or token"),
      },
      ["monitoring-drift", "plex-connectivity", "retry-backlog"],
      false,
    );

    expect(expectSkipped(report, "monitoring-drift").skipReason).toBe("requires-deep");
    expect(expectSkipped(report, "plex-connectivity").skipReason).toBe("plex-not-configured");
    expect(checkById(report, "retry-backlog").status).toBe("pass");
    expect(report.status).toBe("clean");
  });

  it("ranks degraded above findings", () => {
    const findingsOnly = runAudit(LIBRARY_GAPS, ["library-gaps"]);
    expect(findingsOnly.status).toBe("findings");
    expect(findingsOnly.summary.highestSeverity).toBe("warning");

    const degraded = runAudit(
      { ...LIBRARY_GAPS, queue: unavailableSlot("data-unavailable", "db closed") },
      ["library-gaps", "retry-backlog"],
    );
    expect(degraded.summary.total).toBeGreaterThan(0);
    expect(degraded.status).toBe("degraded");
  });

  it("summarises severities and per-check verdict counts", () => {
    const report = runAudit(LIBRARY_GAPS, ["library-gaps", "retry-backlog"]);

    expect(report.summary).toEqual({
      critical: 0,
      warning: 2,
      info: 2,
      total: 4,
      checksRun: 2,
      checksSkipped: 6,
      highestSeverity: "warning",
    });
  });

  it("derives coverage from slot availability alone, never from the selection", () => {
    const report = runAudit(
      {
        artists: availableSlot([
          createLidarrArtistFixture({ id: 1, path: "/music/One" }),
          createLidarrArtistFixture({
            id: 2,
            foreignArtistId: "mbid-artist-2",
            artistName: "Artist 2",
            path: "/music/Two",
          }),
        ]),
        wanted: availableSlot({ total: 7 }),
        albums: availableSlot({
          albums: [createLidarrAlbumFixture({ id: 100, artistId: 1 })],
          artistNames: new Map([[1, "Artist 1"]]),
          artistsScanned: 2,
        }),
      },
      ["retry-backlog"],
    );

    expect(report.coverage).toEqual({
      artistsExamined: 2,
      albumsExamined: 1,
      artistsScanned: 2,
      wantedTotal: 7,
    });
  });

  it("reports a null wantedTotal for an ungathered wanted slot", () => {
    const report = runAudit(
      {
        artists: unavailableSlot("not-requested", "not planned"),
        wanted: unavailableSlot("not-requested", "not planned"),
        albums: unavailableSlot("requires-deep", "no --deep"),
      },
      ["retry-backlog"],
      false,
    );

    expect(report.coverage).toEqual({
      artistsExamined: 0,
      albumsExamined: 0,
      artistsScanned: 0,
      wantedTotal: null,
    });
  });
});

// ── Selection and fetch plan ────────────────────────────────────────────────

describe("resolveLidarrAuditSelection", () => {
  it("expands an absent selection to every registered check", () => {
    expect(resolveLidarrAuditSelection(undefined)).toEqual([...LIDARR_AUDIT_CHECK_IDS]);
  });

  it("dedupes and re-orders a selection into registry order", () => {
    expect(
      resolveLidarrAuditSelection(["plex-connectivity", "retry-backlog", "retry-backlog"]),
    ).toEqual(["retry-backlog", "plex-connectivity"]);
  });

  it("rejects an unknown id with LookupNotFoundError", () => {
    const call = (): unknown => resolveLidarrAuditSelection(["metadata-dependency", "typo-check"]);

    expect(call).toThrow(LookupNotFoundError);
    expect(call).toThrow("Unknown audit check: 'typo-check'");
  });
});

describe("resolveLidarrAuditRequirements", () => {
  it("plans zero Lidarr round-trips for retry-backlog", () => {
    const { required, enriched } = resolveLidarrAuditRequirements(["retry-backlog"]);

    expect([...required]).toEqual(["queue"]);
    expect([...enriched]).toEqual([]);
  });

  it("splits hard requirements from soft enrichments", () => {
    const { required, enriched } = resolveLidarrAuditRequirements([
      "library-gaps",
      "duplicate-identity",
    ]);

    expect([...required]).toEqual(["artists", "wanted"]);
    expect([...enriched]).toEqual(["albums"]);
  });

  it("counts a requirement that is hard anywhere as hard everywhere", () => {
    const { required, enriched } = resolveLidarrAuditRequirements([
      "library-gaps",
      "monitoring-drift",
    ]);

    expect([...required]).toEqual(["artists", "wanted", "albums"]);
    expect([...enriched]).toEqual([]);
  });
});

// ── Exit gate ───────────────────────────────────────────────────────────────

describe("shouldFailLidarrAudit", () => {
  const clean = runAudit();
  const info = runAudit({ wanted: availableSlot({ total: 3 }) }, ["library-gaps"]);
  const warning = runAudit(UNROOTED_ARTISTS, ["operation-safety"]);
  const critical = runAudit(UNREACHABLE_HEALTH, ["metadata-dependency"]);
  const degraded = runAudit({ queue: unavailableSlot("data-unavailable", "db closed") }, [
    "retry-backlog",
  ]);

  const matrix: readonly {
    readonly label: string;
    readonly report: LidarrAuditReport;
    readonly expected: Readonly<Record<LidarrAuditFailOn, boolean>>;
  }[] = [
    {
      label: "clean",
      report: clean,
      expected: { none: false, info: false, warning: false, critical: false },
    },
    {
      label: "info findings",
      report: info,
      expected: { none: false, info: true, warning: false, critical: false },
    },
    {
      label: "warning findings",
      report: warning,
      expected: { none: false, info: true, warning: true, critical: false },
    },
    {
      label: "critical findings",
      report: critical,
      expected: { none: false, info: true, warning: true, critical: true },
    },
    {
      label: "degraded",
      report: degraded,
      expected: { none: false, info: true, warning: true, critical: true },
    },
  ];

  it("builds the five report shapes the matrix ranks", () => {
    expect([clean.status, clean.summary.highestSeverity]).toEqual(["clean", "none"]);
    expect([info.status, info.summary.highestSeverity]).toEqual(["findings", "info"]);
    expect([warning.status, warning.summary.highestSeverity]).toEqual(["findings", "warning"]);
    expect([critical.status, critical.summary.highestSeverity]).toEqual(["findings", "critical"]);
    expect([degraded.status, degraded.summary.highestSeverity]).toEqual(["degraded", "none"]);
  });

  for (const { label, report, expected } of matrix) {
    it(`gates a ${label} report at every level`, () => {
      for (const level of ["none", "info", "warning", "critical"] as const) {
        expect(shouldFailLidarrAudit(report, level), `${label} @ --fail-on ${level}`).toBe(
          expected[level],
        );
      }
    });
  }

  it("trips a degraded report even at a level no selected check can emit", () => {
    // The dead-gate pre-flight was removed because of exactly this case: the
    // gate is live at `critical` even when the selection tops out at `warning`.
    expect(degraded.summary.highestSeverity).toBe("none");
    expect(shouldFailLidarrAudit(degraded, "critical")).toBe(true);
  });
});

// ── metadata-dependency ─────────────────────────────────────────────────────

describe("metadata-dependency", () => {
  it("reports an unreachable probe as one critical finding", () => {
    const report = runAudit(UNREACHABLE_HEALTH, ["metadata-dependency"]);

    expect(codesFor(report, "metadata-dependency")).toEqual(["lidarr-unreachable"]);
    expect(findingByCode(report, "lidarr-unreachable").severity).toBe("critical");
  });

  it("passes a provider's wikiUrl through to remediation.docUrl unmodified", () => {
    const report = runAudit(METADATA_OUTAGE, ["metadata-dependency"]);

    expect(codesFor(report, "metadata-dependency")).toEqual(["metadata-provider-outage"]);
    const finding = findingByCode(report, "metadata-provider-outage");
    expect(finding.severity).toBe("critical");
    expect(finding.remediation.docUrl).toBe(METADATA_ERROR.wikiUrl);
  });

  it("passes a healthy instance", () => {
    const report = runAudit({}, ["metadata-dependency"]);

    expect(checkById(report, "metadata-dependency").status).toBe("pass");
  });
});

// ── operation-safety ────────────────────────────────────────────────────────

describe("operation-safety", () => {
  it("translates all four wire severities, emitting nothing for ok", () => {
    const report = runAudit(HEALTH_CONDITIONS, ["operation-safety"]);
    const findings = report.findings.filter((finding) => finding.code === "lidarr-health-check");

    expect(findings.map((finding) => [finding.evidence["source"], finding.severity])).toEqual([
      ["RootFolderCheck", "critical"],
      ["IndexerStatusCheck", "warning"],
      ["UpdateCheck", "info"],
    ]);
  });

  it("does not re-report a check metadata-dependency already claims", () => {
    const report = runAudit(METADATA_OUTAGE, ["metadata-dependency", "operation-safety"]);

    expect(codesFor(report, "operation-safety")).toEqual([]);
    expect(checkById(report, "operation-safety").status).toBe("pass");
  });

  it("reports a metadata check itself when metadata-dependency was not selected", () => {
    const report = runAudit(METADATA_OUTAGE, ["operation-safety"]);

    expect(codesFor(report, "operation-safety")).toEqual(["lidarr-health-check"]);
    const finding = findingByCode(report, "lidarr-health-check");
    expect(finding.severity).toBe("critical");
    expect(finding.evidence["source"]).toBe(METADATA_ERROR.source);
    // The point of the deferral being conditional: `--check operation-safety
    // --fail-on critical` must still trip rather than reading clean.
    expect(report.summary.highestSeverity).toBe("critical");
  });

  it("flags blank and absent artist paths as unrooted", () => {
    const report = runAudit(UNROOTED_ARTISTS, ["operation-safety"]);

    expect(codesFor(report, "operation-safety")).toEqual(["artist-missing-root-path"]);
    const finding = findingByCode(report, "artist-missing-root-path");
    expect(finding.severity).toBe("warning");
    expect(finding.affected).toBe(2);
    expect(
      finding.subjects.map((subject) => (subject.kind === "artist" ? subject.name : "")),
    ).toEqual(["Blank Path", "No Path"]);
  });

  it("passes a fully rooted library", () => {
    const report = runAudit(
      {
        artists: availableSlot([createLidarrArtistFixture({ id: 1, path: "/music/Rooted" })]),
      },
      ["operation-safety"],
    );

    expect(checkById(report, "operation-safety").status).toBe("pass");
  });

  it("caps subjects while reporting the true affected count", () => {
    const artists = Array.from({ length: 25 }, (_, index) =>
      createLidarrArtistFixture({
        id: index + 1,
        artistName: `Unrooted ${index + 1}`,
        foreignArtistId: `mbid-unrooted-${index + 1}`,
      }),
    );
    const report = runAudit({ artists: availableSlot(artists) }, ["operation-safety"]);

    const finding = findingByCode(report, "artist-missing-root-path");
    expect(finding.subjects).toHaveLength(LIDARR_AUDIT_MAX_SUBJECTS);
    expect(finding.affected).toBe(25);
  });
});

// ── retry-backlog ───────────────────────────────────────────────────────────

describe("retry-backlog", () => {
  it("reports tripped circuits and the deferred-intent backlog", () => {
    const report = runAudit(CIRCUITS_TRIPPED, ["retry-backlog"]);

    expect(codesFor(report, "retry-backlog")).toEqual([
      "circuit-open",
      "circuit-half-open",
      "deferred-intents-failed",
      "deferred-intents-pending",
    ]);
    expect(findingByCode(report, "circuit-open").severity).toBe("critical");
    expect(findingByCode(report, "circuit-open").evidence["retryAtIso"]).toBe(
      "2026-07-25T00:01:00.000Z",
    );
    expect(findingByCode(report, "circuit-half-open").severity).toBe("warning");
    expect(findingByCode(report, "deferred-intents-failed").severity).toBe("critical");

    const pending = findingByCode(report, "deferred-intents-pending");
    expect(pending.severity).toBe("warning");
    expect(pending.affected).toBe(3);
    expect(pending.evidence).toMatchObject({
      pending: 3,
      oldestPendingAgeSeconds: 900,
      overdue: 1,
      nearExhaustion: 2,
    });
  });

  it("surfaces an unreadable circuit and an unreadable detail read as info, never as healthy", () => {
    const report = runAudit(QUEUE_DEGRADED, ["retry-backlog"]);

    expect(codesFor(report, "retry-backlog")).toEqual([
      "circuit-state-unknown",
      "queue-detail-unavailable",
    ]);
    const unknown = findingByCode(report, "circuit-state-unknown");
    expect(unknown.severity).toBe("info");
    expect(unknown.evidence["reason"]).toBe("cannot open tracking database: EACCES");

    const detail = findingByCode(report, "queue-detail-unavailable");
    expect(detail.severity).toBe("info");
    expect(detail.evidence["reason"]).toBe("cannot read deferred-intent detail: malformed row");
  });

  it("passes closed circuits with an empty queue", () => {
    const report = runAudit({}, ["retry-backlog"]);

    expect(checkById(report, "retry-backlog").status).toBe("pass");
  });
});

// ── monitoring-drift ────────────────────────────────────────────────────────

describe("monitoring-drift", () => {
  it("warns about orphaned monitored albums and notes idle monitored artists", () => {
    const report = runAudit(MONITORING_DRIFT, ["monitoring-drift"]);

    expect(codesFor(report, "monitoring-drift")).toEqual([
      "monitored-album-under-unmonitored-artist",
      "monitored-artist-no-monitored-albums",
    ]);
    expect(findingByCode(report, "monitored-album-under-unmonitored-artist").severity).toBe(
      "warning",
    );

    const idle = findingByCode(report, "monitored-artist-no-monitored-albums");
    expect(idle.severity).toBe("info");
    expect(idle.remediation.action).toContain("Monitor: Future");
  });

  it("passes a library whose album monitoring matches its artists", () => {
    const report = runAudit(
      {
        artists: availableSlot([
          createLidarrArtistFixture({ id: 1, monitored: true, path: "/music/One" }),
        ]),
        albums: availableSlot({
          albums: [createLidarrAlbumFixture({ id: 200, artistId: 1, monitored: true })],
          artistNames: new Map([[1, "Artist 1"]]),
          artistsScanned: 1,
        }),
      },
      ["monitoring-drift"],
    );

    expect(checkById(report, "monitoring-drift").status).toBe("pass");
  });
});

// ── library-gaps ────────────────────────────────────────────────────────────

describe("library-gaps", () => {
  it("reports empty artists, the wanted backlog, undated gaps, and partial albums", () => {
    const report = runAudit(LIBRARY_GAPS, ["library-gaps"]);

    expect(codesFor(report, "library-gaps")).toEqual([
      "artist-monitored-no-files",
      "wanted-backlog",
      "album-monitored-no-files",
      "album-partial-files",
    ]);
    expect(findingByCode(report, "artist-monitored-no-files").severity).toBe("warning");
    expect(findingByCode(report, "wanted-backlog").affected).toBe(5);
    expect(findingByCode(report, "album-partial-files").severity).toBe("info");

    // D13: an absent releaseDate stays eligible; a future one is excluded.
    const gap = findingByCode(report, "album-monitored-no-files");
    expect(gap.severity).toBe("warning");
    expect(gap.subjects.map((subject) => (subject.kind === "album" ? subject.title : ""))).toEqual([
      "Undated",
    ]);
  });

  it("counts an absent album statistics block as zero files", () => {
    const report = runAudit(
      {
        artists: availableSlot([createLidarrArtistFixture({ id: 1, path: "/music/One" })]),
        albums: availableSlot({
          albums: [createLidarrAlbumFixture({ id: 300, artistId: 1, monitored: true })],
          artistNames: new Map([[1, "Artist 1"]]),
          artistsScanned: 1,
        }),
      },
      ["library-gaps"],
    );

    expect(codesFor(report, "library-gaps")).toEqual(["album-monitored-no-files"]);
  });

  it("passes a fully-stocked library with no backlog", () => {
    const report = runAudit(
      {
        artists: availableSlot([createLidarrArtistFixture({ id: 1, path: "/music/One" })]),
        albums: availableSlot({
          albums: [
            createLidarrAlbumFixture({
              id: 300,
              artistId: 1,
              statistics: { trackCount: 10, trackFileCount: 10 },
            }),
          ],
          artistNames: new Map([[1, "Artist 1"]]),
          artistsScanned: 1,
        }),
      },
      ["library-gaps"],
    );

    expect(checkById(report, "library-gaps").status).toBe("pass");
  });
});

// ── duplicate-identity ──────────────────────────────────────────────────────

describe("duplicate-identity", () => {
  it("emits one finding per group with affected counting entities", () => {
    const report = runAudit(DUPLICATE_IDENTITY, ["duplicate-identity"]);

    expect(codesFor(report, "duplicate-identity")).toEqual([
      "duplicate-artist-mbid",
      "duplicate-artist-path",
      "similar-artist-name",
      "duplicate-album-mbid",
    ]);

    const mbid = findingByCode(report, "duplicate-artist-mbid");
    expect(mbid.severity).toBe("critical");
    expect(mbid.affected).toBe(2);
    expect(mbid.evidence["groupSize"]).toBe(2);
    expect(mbid.evidence["foreignArtistId"]).toBe("mbid-shared");
  });

  it("collides separator-equivalent paths but keeps comparison case-sensitive", () => {
    const collides = runAudit(DUPLICATE_IDENTITY, ["duplicate-identity"]);
    expect(findingByCode(collides, "duplicate-artist-path").evidence["path"]).toBe("/music/Shared");

    const cased = runAudit(
      {
        artists: availableSlot([
          createLidarrArtistFixture({
            id: 1,
            artistName: "Upper",
            foreignArtistId: "mbid-upper",
            path: "/music/Artist",
          }),
          createLidarrArtistFixture({
            id: 2,
            artistName: "Lower",
            foreignArtistId: "mbid-lower",
            path: "/music/artist",
          }),
        ]),
      },
      ["duplicate-identity"],
    );
    expect(codesFor(cased, "duplicate-identity")).toEqual([]);
  });

  it("folds case, diacritics, punctuation, and a leading article into info, not critical", () => {
    const report = runAudit(DUPLICATE_IDENTITY, ["duplicate-identity"]);

    const similar = findingByCode(report, "similar-artist-name");
    expect(similar.severity).toBe("info");
    expect(similar.evidence["foldedName"]).toBe("bjork");
    expect(
      similar.subjects.map((subject) => (subject.kind === "artist" ? subject.name : "")),
    ).toEqual(["Björk", "The Bjork!"]);
  });

  it("never groups on an undefined or blank key", () => {
    const report = runAudit(
      {
        artists: availableSlot([
          createLidarrArtistFixture({ id: 1, artistName: "One", foreignArtistId: "mbid-1" }),
          createLidarrArtistFixture({
            id: 2,
            artistName: "Two",
            foreignArtistId: "mbid-2",
            path: "   ",
          }),
          createLidarrArtistFixture({
            id: 3,
            artistName: "Three",
            foreignArtistId: "mbid-3",
            path: "  ",
          }),
        ]),
        albums: availableSlot({
          albums: [
            createLidarrAlbumFixture({ id: 400, artistId: 1 }),
            createLidarrAlbumFixture({ id: 401, artistId: 1 }),
          ],
          artistNames: new Map([[1, "One"]]),
          artistsScanned: 1,
        }),
      },
      ["duplicate-identity"],
    );

    expect(codesFor(report, "duplicate-identity")).toEqual([]);
  });

  it("passes a library of distinct artists", () => {
    const report = runAudit(
      {
        artists: availableSlot([
          createLidarrArtistFixture({
            id: 1,
            artistName: "One",
            foreignArtistId: "mbid-1",
            path: "/music/One",
          }),
          createLidarrArtistFixture({
            id: 2,
            artistName: "Two",
            foreignArtistId: "mbid-2",
            path: "/music/Two",
          }),
        ]),
      },
      ["duplicate-identity"],
    );

    expect(checkById(report, "duplicate-identity").status).toBe("pass");
  });
});

// ── plex-connectivity ───────────────────────────────────────────────────────

describe("plex-connectivity", () => {
  it("rates a lock-out critical and a narrower fault a warning", () => {
    const lockedOut = runAudit(PLEX_UNREACHABLE, ["plex-connectivity"]);
    expect(codesFor(lockedOut, "plex-connectivity")).toEqual(["plex-unreachable"]);
    expect(findingByCode(lockedOut, "plex-unreachable").severity).toBe("critical");

    const notFound: LidarrAuditPlexProbe = {
      reachable: false,
      code: "not-found",
      message: "Section endpoint returned 404",
    };
    const narrow = runAudit({ plex: availableSlot(notFound) }, ["plex-connectivity"]);
    expect(findingByCode(narrow, "plex-unreachable").severity).toBe("warning");
  });

  it("warns when a reachable server exposes no music library", () => {
    const report = runAudit(PLEX_NO_LIBRARY, ["plex-connectivity"]);

    expect(codesFor(report, "plex-connectivity")).toEqual(["plex-no-music-library"]);
    expect(findingByCode(report, "plex-no-music-library").severity).toBe("warning");
  });

  it("surfaces the adapter's available-libraries text verbatim", () => {
    const report = runAudit(PLEX_NAME_UNRESOLVED, ["plex-connectivity"]);

    expect(codesFor(report, "plex-connectivity")).toEqual(["plex-library-name-unresolved"]);
    const finding = findingByCode(report, "plex-library-name-unresolved");
    expect(finding.severity).toBe("warning");
    expect(finding.evidence["available"]).toBe('Library "Vinyl" not found. Available: Music');
  });

  it("passes a reachable server with a music library", () => {
    const report = runAudit({}, ["plex-connectivity"]);

    expect(checkById(report, "plex-connectivity").status).toBe("pass");
  });
});

// ── Cross-check contract sweeps ─────────────────────────────────────────────

describe("finding contract", () => {
  const sweptFindings: readonly LidarrAuditFinding[] = SWEEP_SCENARIOS.flatMap(
    (scenario) => runAudit(scenario).findings,
  );

  it("emits only codes the owning check declares, and covers every declared code", () => {
    const observed = new Set<LidarrAuditFindingCode>();

    for (const finding of sweptFindings) {
      expect(
        DESCRIPTORS[finding.checkId].findingCodes,
        `${finding.checkId} does not declare ${finding.code}`,
      ).toContain(finding.code);
      observed.add(finding.code);
    }

    expect([...observed].sort()).toEqual([...LIDARR_AUDIT_FINDING_CODES].sort());
  });

  it("never suggests a mutating command", () => {
    for (const finding of sweptFindings) {
      const { command } = finding.remediation;
      if (command === undefined) {
        continue;
      }
      expect(command, `${finding.code} suggests a mutating command`).not.toMatch(
        MUTATING_COMMAND_PATTERN,
      );
    }
  });
});
