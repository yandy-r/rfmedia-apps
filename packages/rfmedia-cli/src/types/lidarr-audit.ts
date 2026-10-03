/**
 * Operator- and CI-facing contract for `rfmedia lidarr audit` (issue #211).
 *
 * Values live here alongside types, matching `src/types/lidarr-plan.ts` and
 * `src/types/completion.ts`: the command layer imports the registry statically
 * for its `--check` value list and its exit gate without loading a single
 * evaluator, and `src/lib/shell-completions/templates.spec.ts` binds the
 * generated completion value lists to {@link LIDARR_AUDIT_CHECK_IDS} and
 * {@link LIDARR_AUDIT_FAIL_ON_LEVELS}. Both are only safe because this module
 * has ZERO value imports — every import below is type-only and erased.
 *
 * The registry (`requires` / `enriches`) is the single source of truth for both
 * what the action gathers and whether a check can run, so `--check retry-backlog`
 * costs zero Lidarr HTTP round-trips.
 */

import type { DbLidarrDeferredIntentStatus } from "../lib/lidarr/deferred-queue-db.js";
import type { LidarrHealthReport } from "../lib/lidarr/health.js";
import type { LidarrResilienceSnapshot } from "./lidarr-resilience.js";
import type { LidarrAlbum, LidarrArtist } from "./lidarr.js";
import type { MediaServerErrorCode, MediaServerLibrary } from "./media-server.js";

// ── Severity ────────────────────────────────────────────────────────────────

/**
 * Diagnostic urgency ladder, ascending.
 *
 * Deliberately distinct from `LidarrRiskLevel` (`types/lidarr-plan.ts`), which
 * rates the blast radius of a proposed mutation, and from `LidarrHealthType`
 * (`types/lidarr.ts`), which is Lidarr's wire severity. Wire severities are
 * translated into this ladder, never adopted.
 */
export const LIDARR_AUDIT_SEVERITIES = ["info", "warning", "critical"] as const;

/** One rung of the {@link LIDARR_AUDIT_SEVERITIES} ladder. */
export type LidarrAuditSeverity = (typeof LIDARR_AUDIT_SEVERITIES)[number];

/** Accepted `--fail-on` levels; `"none"` disables the findings-driven exit. */
export const LIDARR_AUDIT_FAIL_ON_LEVELS = ["none", "info", "warning", "critical"] as const;

/** One accepted `--fail-on` value. */
export type LidarrAuditFailOn = (typeof LIDARR_AUDIT_FAIL_ON_LEVELS)[number];

// ── Registry ────────────────────────────────────────────────────────────────

/** A data source a check needs. Drives both the gather plan and the skip gate. */
export const LIDARR_AUDIT_REQUIREMENTS = [
  "health",
  "artists",
  "wanted",
  "albums",
  "queue",
  "plex",
  "plexIdentity",
] as const;

/** One data source named by a descriptor's `requires` / `enriches` list. */
export type LidarrAuditRequirement = (typeof LIDARR_AUDIT_REQUIREMENTS)[number];

/** Every registered check id, in report order. These are the `--check` values. */
export const LIDARR_AUDIT_CHECK_IDS = [
  "metadata-dependency",
  "operation-safety",
  "retry-backlog",
  "monitoring-drift",
  "library-gaps",
  "duplicate-identity",
  "plex-connectivity",
  "plex-alignment",
] as const;

/** One registered check id. */
export type LidarrAuditCheckId = (typeof LIDARR_AUDIT_CHECK_IDS)[number];

/**
 * Ids declared for schema stability but not implemented in this release. They
 * never dispatch an evaluator, so no unreachable function body exists.
 */
export const LIDARR_AUDIT_RESERVED_CHECK_IDS = ["plex-alignment"] as const;

/** One reserved (evaluator-less) check id. */
export type LidarrAuditReservedCheckId = (typeof LIDARR_AUDIT_RESERVED_CHECK_IDS)[number];

/** Ids backed by a real evaluator. The evaluator map is keyed on this union. */
export type LidarrAuditEvaluatedCheckId = Exclude<LidarrAuditCheckId, LidarrAuditReservedCheckId>;

/**
 * Every finding code this feature can emit, grouped by owning check in
 * {@link LIDARR_AUDIT_CHECK_IDS} order.
 *
 * Codes are a public contract once shipped: CI jobs grep them and the feature
 * doc catalogues them. The per-check split is republished on each descriptor's
 * `findingCodes`, and a test asserts the flat tuple is exactly the duplicate-free
 * union of those per-check lists.
 */
export const LIDARR_AUDIT_FINDING_CODES = [
  // metadata-dependency
  "lidarr-unreachable",
  "metadata-provider-outage",
  // operation-safety
  "lidarr-health-check",
  "artist-missing-root-path",
  // retry-backlog
  "circuit-open",
  "circuit-half-open",
  "circuit-state-unknown",
  "deferred-intents-failed",
  "deferred-intents-pending",
  "queue-detail-unavailable",
  // monitoring-drift
  "monitored-album-under-unmonitored-artist",
  "monitored-artist-no-monitored-albums",
  // library-gaps
  "artist-monitored-no-files",
  "wanted-backlog",
  "album-monitored-no-files",
  "album-partial-files",
  // duplicate-identity
  "duplicate-artist-mbid",
  "duplicate-artist-path",
  "similar-artist-name",
  "duplicate-album-mbid",
  // plex-connectivity
  "plex-unreachable",
  "plex-no-music-library",
  "plex-library-name-unresolved",
] as const;

/** One stable, kebab-case finding code. */
export type LidarrAuditFindingCode = (typeof LIDARR_AUDIT_FINDING_CODES)[number];

/** Static description of one registered check. Carries no behavior. */
export interface LidarrAuditCheckDescriptor {
  /** The check id this descriptor describes. */
  readonly id: LidarrAuditCheckId;
  /** Short human title, echoed on every per-check result row. */
  readonly title: string;
  /** One-line explanation of what the check looks at. */
  readonly description: string;
  /** Hard gate: every entry must be an available slot or the check skips. */
  readonly requires: readonly LidarrAuditRequirement[];
  /** Soft: gathered when possible; adds depth, never gates. */
  readonly enriches: readonly LidarrAuditRequirement[];
  /** Highest severity this check can emit. Documentation and rendering only. */
  readonly maxSeverity: LidarrAuditSeverity;
  /** Every code this check may emit; `[]` for reserved ids. */
  readonly findingCodes: readonly LidarrAuditFindingCode[];
}

/** The registry. The `satisfies` clause makes a missing descriptor a compile error. */
export const LIDARR_AUDIT_CHECK_DESCRIPTORS = Object.freeze({
  "metadata-dependency": {
    id: "metadata-dependency",
    title: "Metadata dependency health",
    description: "Lidarr reachability and metadata-provider outage signals",
    requires: ["health"],
    enriches: [],
    maxSeverity: "critical",
    findingCodes: ["lidarr-unreachable", "metadata-provider-outage"],
  },
  "operation-safety": {
    id: "operation-safety",
    title: "Operation safety",
    description: "Root-folder, disk-space, and permission conditions reported by Lidarr",
    requires: ["health", "artists"],
    enriches: [],
    maxSeverity: "critical",
    findingCodes: ["lidarr-health-check", "artist-missing-root-path"],
  },
  "retry-backlog": {
    id: "retry-backlog",
    title: "Retry backlog",
    description: "Circuit-breaker state and deferred-intent replay queue depth",
    requires: ["queue"],
    enriches: [],
    maxSeverity: "critical",
    findingCodes: [
      "circuit-open",
      "circuit-half-open",
      "circuit-state-unknown",
      "deferred-intents-failed",
      "deferred-intents-pending",
      "queue-detail-unavailable",
    ],
  },
  "monitoring-drift": {
    id: "monitoring-drift",
    title: "Monitoring drift",
    description: "Album monitoring that contradicts its owning artist",
    requires: ["artists", "albums"],
    enriches: [],
    maxSeverity: "warning",
    findingCodes: [
      "monitored-album-under-unmonitored-artist",
      "monitored-artist-no-monitored-albums",
    ],
  },
  "library-gaps": {
    id: "library-gaps",
    title: "Library gaps",
    description: "Monitored entities missing files, plus the wanted/missing backlog",
    requires: ["artists", "wanted"],
    enriches: ["albums"],
    maxSeverity: "warning",
    findingCodes: [
      "artist-monitored-no-files",
      "wanted-backlog",
      "album-monitored-no-files",
      "album-partial-files",
    ],
  },
  "duplicate-identity": {
    id: "duplicate-identity",
    title: "Duplicate identity",
    description: "Repeated MusicBrainz ids, shared root paths, and folded-name collisions",
    requires: ["artists"],
    enriches: ["albums"],
    maxSeverity: "critical",
    findingCodes: [
      "duplicate-artist-mbid",
      "duplicate-artist-path",
      "similar-artist-name",
      "duplicate-album-mbid",
    ],
  },
  "plex-connectivity": {
    id: "plex-connectivity",
    title: "Plex connectivity",
    description: "Media-server reachability and music-library resolution",
    requires: ["plex"],
    enriches: [],
    maxSeverity: "critical",
    findingCodes: ["plex-unreachable", "plex-no-music-library", "plex-library-name-unresolved"],
  },
  "plex-alignment": {
    id: "plex-alignment",
    title: "Plex-Lidarr alignment",
    description: "Cross-service reconciliation (requires the identity-mapping layer)",
    requires: ["plex", "plexIdentity"],
    enriches: [],
    maxSeverity: "warning",
    findingCodes: [],
  },
} as const) satisfies Readonly<Record<LidarrAuditCheckId, LidarrAuditCheckDescriptor>>;

// ── Slots ───────────────────────────────────────────────────────────────────

/**
 * Why a data source is absent. `"not-requested"`, `"requires-deep"`,
 * `"plex-not-configured"`, and `"identity-mapping-unavailable"` are EXPECTED and
 * never mark the report degraded; `"data-unavailable"` is a real failure and does.
 */
export type LidarrAuditUnavailableReason =
  | "not-requested"
  | "requires-deep"
  | "plex-not-configured"
  | "identity-mapping-unavailable"
  | "data-unavailable";

/**
 * Presence AND reason in one value. There is deliberately no parallel
 * "capabilities" list: a slot cannot desynchronise from its own reason.
 */
export type LidarrAuditSlot<T> =
  | { readonly status: "available"; readonly data: T }
  | {
      readonly status: "unavailable";
      readonly reason: LidarrAuditUnavailableReason;
      readonly detail: string;
    };

/**
 * `detail` used for every Lidarr-backed slot the action abandons after the
 * health probe reports `status: "unreachable"`.
 *
 * The probe swallows its own transport error and `LidarrHealthReport` carries no
 * reason field, so this constant is the only available explanation. The `health`
 * slot itself deliberately stays `available` with the unreachable report as its
 * data — that report is the evidence `metadata-dependency` needs to emit the
 * `lidarr-unreachable` critical finding.
 */
export const LIDARR_AUDIT_UNREACHABLE_DETAIL =
  "Lidarr is unreachable; the health probe failed at the transport level";

/**
 * Circuit + deferred-queue state; assembled without ever throwing.
 *
 * `counts` is EXACT (a `GROUP BY` aggregate). Every derived per-row field below
 * is computed over a bounded window of the oldest pending intents instead, so
 * it is a LOWER BOUND whenever {@link LidarrAuditQueueState.detailTruncated} is
 * true. The window is published rather than hidden so a `--json` consumer never
 * divides a windowed numerator by the exact `counts.pending` denominator.
 */
export interface LidarrAuditQueueState {
  /**
   * Circuit entries reused verbatim from the resilience snapshot, so audit
   * output and breaker persistence can never drift apart.
   */
  readonly circuits: LidarrResilienceSnapshot["circuits"];
  /** All five lifecycle statuses, zero-filled. Always exact. */
  readonly counts: Readonly<Record<DbLidarrDeferredIntentStatus, number>>;
  /**
   * Age of the oldest `pending` intent in the detail window, when the detail
   * read succeeded. Exact whenever the window is ordered oldest-first.
   */
  readonly oldestPendingAgeSeconds?: number;
  /**
   * Pending intents in the detail window whose `nextAttemptAt` is already past.
   * A lower bound when `detailTruncated` is true.
   */
  readonly overdue?: number;
  /**
   * Pending intents in the detail window at `attempts >= maxAttempts - 1`.
   * A lower bound when `detailTruncated` is true.
   */
  readonly nearExhaustion?: number;
  /** Row cap applied to the detail read; absent when that read failed. */
  readonly detailWindow?: number;
  /** True when `counts.pending` exceeded `detailWindow`, so the derived counts are lower bounds. */
  readonly detailTruncated?: boolean;
  /** Set when the per-row detail read failed; counts remain valid. */
  readonly detailUnavailableReason?: string;
}

/** Outcome of the single cheap Plex probe. Identity joins are out of scope. */
export type LidarrAuditPlexProbe =
  | {
      readonly reachable: true;
      /** Music libraries exposed by the server; `[]` is a legitimate finding. */
      readonly libraries: readonly MediaServerLibrary[];
      /** The configured `plex.libraryName`, when one is set. */
      readonly configuredLibraryName?: string;
      /** Whether `configuredLibraryName` resolved to a real library. */
      readonly configuredLibraryResolved?: boolean;
      /** Verbatim `Available: …` text from a failed name resolution. */
      readonly resolutionDetail?: string;
    }
  | {
      readonly reachable: false;
      /** Classified failure reason; non-media-server throws map to `"configuration"`. */
      readonly code: MediaServerErrorCode;
      /** Human-readable failure message, credential-free. */
      readonly message: string;
    };

/** Albums plus artist-name context, adapted from the deep album scan. */
export interface LidarrAuditAlbumData {
  /** Every album returned by the scan, already narrowed by `--artist-ids`. */
  readonly albums: readonly LidarrAlbum[];
  /** Artist id to display name, for album-subject labelling. */
  readonly artistNames: ReadonlyMap<number, string>;
  /** How many artists the scan visited. */
  readonly artistsScanned: number;
}

/**
 * Everything the action gathered, one slot per requirement. The lib layer reads
 * these; it never performs I/O and never resolves a client.
 */
export interface LidarrAuditGatheredData {
  /** Health probe result; stays available even when Lidarr is unreachable. */
  readonly health: LidarrAuditSlot<LidarrHealthReport>;
  /** Library-wide artist list. */
  readonly artists: LidarrAuditSlot<readonly LidarrArtist[]>;
  /** Library-wide wanted/missing total; ignores `--artist-ids` by design. */
  readonly wanted: LidarrAuditSlot<{ readonly total: number }>;
  /** Per-artist album scan; only planned under `--deep`. */
  readonly albums: LidarrAuditSlot<LidarrAuditAlbumData>;
  /** Circuit and deferred-intent state; the only tracking-database read. */
  readonly queue: LidarrAuditSlot<LidarrAuditQueueState>;
  /** Media-server probe; unavailable when credentials are absent. */
  readonly plex: LidarrAuditSlot<LidarrAuditPlexProbe>;
  /** Reserved join layer; a compile-time constant `unavailable` until #207/#208. */
  readonly plexIdentity: LidarrAuditSlot<never>;
}

// ── Findings ────────────────────────────────────────────────────────────────

/**
 * What a finding is about. Ids stay SINGULAR (`artistId`, never `artistIds`) so
 * no payload literal can trip the `lidarr-editor-body-owner` architecture rule,
 * which is a purely structural object-literal key check.
 */
export type LidarrAuditSubject =
  | { readonly kind: "instance"; readonly origin: string }
  | { readonly kind: "artist"; readonly artistId: number; readonly name: string }
  | {
      readonly kind: "album";
      readonly albumId: number;
      readonly title: string;
      readonly ownerArtistId: number;
      readonly ownerArtistName: string;
    }
  | { readonly kind: "queue"; readonly scope: string }
  | { readonly kind: "media-server"; readonly library?: string };

/**
 * Actionable follow-up.
 *
 * INVARIANT (test-enforced): `command` is ALWAYS non-mutating — a read command
 * or a `lidarr plan …` artifact command. Destructive follow-ups appear only in
 * `action` prose, because #211 ships as a read-only operator view.
 */
export interface LidarrAuditRemediation {
  /** Prose the operator acts on; the only place a destructive verb may appear. */
  readonly action: string;
  /** A non-mutating command to run next. */
  readonly command?: string;
  /** Upstream documentation link, surfaced unmodified when Lidarr supplies one. */
  readonly docUrl?: string;
}

/** Hard cap on subjects embedded per finding; `affected` carries the true count. */
export const LIDARR_AUDIT_MAX_SUBJECTS = 10;

/** One audit finding. `evidence` is flat and scalar-valued so CSV stays lossless. */
export interface LidarrAuditFinding {
  /** Which registered check emitted this finding. */
  readonly checkId: LidarrAuditCheckId;
  /** Stable kebab code, unique within the check. A public contract once shipped. */
  readonly code: LidarrAuditFindingCode;
  readonly severity: LidarrAuditSeverity;
  /** One-line operator-facing statement of the problem. */
  readonly summary: string;
  /** Affected entities, capped at {@link LIDARR_AUDIT_MAX_SUBJECTS}. */
  readonly subjects: readonly LidarrAuditSubject[];
  /** True affected ENTITY count before capping — never a group count. */
  readonly affected: number;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly remediation: LidarrAuditRemediation;
}

/**
 * Builds one finding with the frozen capping and counting semantics every
 * evaluator shares.
 *
 * `subjects` is truncated to the first {@link LIDARR_AUDIT_MAX_SUBJECTS} entries
 * while `affected` defaults to the count BEFORE truncation, so a capped finding
 * still reports its true blast radius. `evidence` defaults to `{}`, and the
 * returned finding plus its `subjects` and `evidence` are frozen.
 *
 * `affected` ALWAYS counts affected entities, never groups. For group-based
 * findings (`duplicate-artist-mbid`, `duplicate-artist-path`,
 * `similar-artist-name`, `duplicate-album-mbid`) the evaluator emits ONE finding
 * per group with `subjects` = that group's members, `affected` = `members.length`,
 * and `evidence.groupSize` = `members.length`.
 *
 * @param input - Finding fields; `affected` and `evidence` are optional and
 *   default as described above.
 * @returns The frozen finding.
 */
export function createLidarrAuditFinding(input: {
  readonly checkId: LidarrAuditCheckId;
  readonly code: LidarrAuditFindingCode;
  readonly severity: LidarrAuditSeverity;
  readonly summary: string;
  readonly subjects: readonly LidarrAuditSubject[];
  readonly affected?: number;
  readonly evidence?: Readonly<Record<string, string | number | boolean>>;
  readonly remediation: LidarrAuditRemediation;
}): LidarrAuditFinding {
  return Object.freeze({
    checkId: input.checkId,
    code: input.code,
    severity: input.severity,
    summary: input.summary,
    subjects: Object.freeze(input.subjects.slice(0, LIDARR_AUDIT_MAX_SUBJECTS)),
    affected: input.affected ?? input.subjects.length,
    evidence: Object.freeze({ ...input.evidence }),
    remediation: input.remediation,
  });
}

// ── Results ─────────────────────────────────────────────────────────────────

/** Why a registered check produced no verdict. */
export type LidarrAuditSkipReason =
  | "not-selected"
  | LidarrAuditUnavailableReason
  /** The evaluator threw; isolated so the rest of the audit still completes. */
  | "check-error";

/** Per-check verdict. EVERY registered check appears exactly once, always. */
export type LidarrAuditCheckResult =
  | {
      readonly id: LidarrAuditCheckId;
      readonly title: string;
      readonly status: "pass";
      readonly findingCount: 0;
    }
  | {
      readonly id: LidarrAuditCheckId;
      readonly title: string;
      readonly status: "findings";
      readonly findingCount: number;
      readonly highestSeverity: LidarrAuditSeverity;
    }
  | {
      readonly id: LidarrAuditCheckId;
      readonly title: string;
      readonly status: "skipped";
      readonly findingCount: 0;
      readonly skipReason: LidarrAuditSkipReason;
      readonly detail: string;
    };

/** Aggregate counts across every finding and check in the report. */
export interface LidarrAuditSummary {
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
  /** Total findings; equals `critical + warning + info`. */
  readonly total: number;
  /** Checks that produced a `pass` or `findings` verdict. */
  readonly checksRun: number;
  /** Checks that produced a `skipped` verdict, for any reason. */
  readonly checksSkipped: number;
  /**
   * The single scalar a CI job greps. Exit code 1 is this repo's only failure
   * code, so this is how "gate tripped" is distinguished from "Lidarr down"
   * (the latter has no successful result at all, only a failure envelope).
   */
  readonly highestSeverity: LidarrAuditSeverity | "none";
}

/** How much data actually backed this report. */
export interface LidarrAuditCoverage {
  /** Artists in the library-wide list, or `0` when that slot was unavailable. */
  readonly artistsExamined: number;
  /** Albums returned by the deep scan, or `0` without `--deep`. */
  readonly albumsExamined: number;
  /** Artists the deep scan visited, or `0` without `--deep`. */
  readonly artistsScanned: number;
  /** `null` when the wanted backlog was not sampled. */
  readonly wantedTotal: number | null;
}

/**
 * The complete audit report.
 *
 * `status` precedence is strict: `"degraded"` (any `data-unavailable` slot or
 * `check-error`) outranks `"findings"`, which outranks `"clean"`. An expected
 * absence — `--deep` off, Plex unconfigured, check deselected — never degrades.
 */
export interface LidarrAuditReport {
  /** When the audit ran (ISO-8601). */
  readonly checkedAt: string;
  /** Credential-free canonical Lidarr origin. Never contains the API key. */
  readonly origin: string;
  /** Whether the per-artist album scan ran. */
  readonly deep: boolean;
  readonly status: "clean" | "findings" | "degraded";
  readonly summary: LidarrAuditSummary;
  /** One entry per registered check, in registry declaration order. */
  readonly checks: readonly LidarrAuditCheckResult[];
  readonly findings: readonly LidarrAuditFinding[];
  readonly coverage: LidarrAuditCoverage;
}

/**
 * A check's verdict function: pure, synchronous, gathered data in / findings out.
 *
 * `selected` is the run's full selection, NOT the evaluator's own id. It exists
 * so a check that defers a condition to a sibling check can tell whether that
 * sibling actually ran: deferring unconditionally would drop the condition from
 * the report entirely under a narrower `--check`. Evaluators that defer to
 * nobody simply omit the parameter.
 */
export type LidarrAuditEvaluator = (
  gathered: LidarrAuditGatheredData,
  selected: ReadonlySet<LidarrAuditCheckId>,
) => readonly LidarrAuditFinding[];

/**
 * Position of a severity on the {@link LIDARR_AUDIT_SEVERITIES} ladder.
 *
 * Exported so the engine and the exit gate rank severities through one
 * implementation instead of re-deriving the ordering per module.
 *
 * @param severity - The severity to rank.
 * @returns `0` for `info`, `1` for `warning`, `2` for `critical`.
 */
export function severityRank(severity: LidarrAuditSeverity): number {
  return LIDARR_AUDIT_SEVERITIES.indexOf(severity);
}

/**
 * Decides whether the command must set `process.exitCode = 1`.
 *
 * Lives in the type module rather than the engine so `src/commands/lidarr-audit.ts`
 * can apply the gate after rendering without statically importing the evaluator
 * graph (which reaches the tracking database through `./health.js`).
 *
 * Semantics, in order, with no other rules: `--fail-on none` never trips; a
 * `degraded` report ALWAYS trips at any non-`none` level, regardless of the
 * configured rank, because a degraded report means a selected check could not
 * be evaluated; a report with no findings never trips; otherwise the report's
 * highest severity must reach the configured level.
 *
 * @param report - A completed report.
 * @param failOn - The configured gate level.
 * @returns True when the command must set `process.exitCode = 1`.
 */
export function shouldFailLidarrAudit(
  report: LidarrAuditReport,
  failOn: LidarrAuditFailOn,
): boolean {
  if (failOn === "none") {
    return false;
  }

  if (report.status === "degraded") {
    return true;
  }

  const { highestSeverity } = report.summary;
  if (highestSeverity === "none") {
    return false;
  }

  return severityRank(highestSeverity) >= severityRank(failOn);
}
