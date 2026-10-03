# Final Design — `rfmedia lidarr audit` (issue #211)

**Provenance:** internal planning artifact for [#211](https://github.com/yandy-r/rfmedia-apps/issues/211), captured verbatim from the planning workspace; its sibling [plan.md](plan.md) is the implementation plan derived from it.

**Status:** authoritative. Sole input to the planning phase.
**Base:** `operator-first` structure, compressed to `minimal-surface` scope, with `registry-first` correctness grafts. All judge must-grafts applied; all must-rejects removed. Every path, symbol, and signature below was verified against the working tree.

---

## 1. Decision summary

`rfmedia lidarr audit` is a strictly read-only diagnostic built as three layers that mirror `lidarr health` 1:1 — pure evaluators in `src/lib/lidarr/audit*.ts` that take already-fetched data, one `execute*` action in `src/actions/lidarr/audit.ts` that owns all I/O inside a single `local-only` scheduler task, and a DI-factory command module `src/commands/lidarr-audit.ts` that owns every byte of rendering. Eight checks are declared in one frozen registry in `src/types/lidarr-audit.ts` whose `requires`/`enriches` fields are the _single_ source of truth for both what the action fetches and whether a check can run, so `--check retry-backlog` costs zero HTTP requests and `--check duplicate-identity` costs two. Data reaches the engine as discriminated `LidarrAuditSlot<T>` values (`available` with data, or `unavailable` with a machine-readable reason) — one representation of presence-and-reason, so a slot can never desynchronise from a parallel capability list. The command is diagnostic by default (`process.exitCode` untouched even with critical findings, matching the pinned `health` contract at `commands/lidarr.test.ts:1947`); `--fail-on <none|info|warning|critical>` is the explicit, opt-in CI gate, following the `apply` precedent at `commands/lidarr.ts:1409`. Nothing mutates: every emitted `remediation.command` is a read command or a `lidarr plan …` artifact command, enforced by a test.

**Plex alignment: PLUGGABLE SLOT (not implemented now) + one real Plex check shipped alongside it.**

Justification, verified: `PlexWireArtist` (`src/lib/adapters/plex/types.ts:233-241`) and `PlexWireAlbum` (`:220-230`) never consume a `Guid` field, and `MediaArtist`/`MediaAlbum` in `src/types/media-server.ts` carry no external-id field at all — while `LidarrArtist.foreignArtistId` is required and doc-commented "canonical key for the future Plex-Lidarr bridge". There is no join key. The only implementable alignment check today is an N×M free-text title match, which has no tiebreak, produces the false-positive noise that gets audit commands ignored, is code #207/#208 must delete, and — worst — would bake a title-identity model into a frozen `--json` contract. `src/lib/bridge/reconcile.ts` named by the issue does not exist and is treated as unimplementable.

So `plex-alignment` ships as a **reserved** registry id that always reports `status: "skipped"` with reason `plex-not-configured` or `identity-mapping-unavailable`, and is _evaluator-less by construction_ (the evaluator `Record` is keyed on `Exclude<LidarrAuditCheckId, LidarrAuditReservedCheckId>`, so there is no unreachable function body). CI consumers can assert on its presence and status today; when #208 lands, only the action's Plex gather changes and the JSON schema, CSV columns, and completions stay byte-identical.

In its place ships `plex-connectivity` — one `adapter.library.list()` call behind an explicit url-AND-token readiness gate, plus one `adapter.library.byName()` when `plex.libraryName` is configured. Real operational signal, ~90 lines, zero matching.

---

## 2. Check catalog

Severity ladder is purpose-built: `info | warning | critical`. Lidarr's wire enum `LidarrHealthType` is **translated**, never adopted (`error→critical`, `warning→warning`, `notice→info`, `ok→not emitted`).

Requirements: `health | artists | wanted | albums | queue | plex`. `requires` = hard gate + fetch. `enriches` = fetch-only (adds depth when available, never gates).

### Shipping in this PR (7 active + 1 reserved)

| #   | id                              | requires / enriches                     | Max sev  | Detects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Exact data source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Remediation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------- | --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `metadata-dependency`           | `health`                                | critical | (a) `lidarr-unreachable` — the probe itself failed at transport level; (b) metadata/Skyhook provider outage                                                                                                                                                                                                                                                                                                                                                                                                   | `runHealthProbe(client, signal)` → `LidarrHealthReport` (`src/lib/lidarr/health.ts:116`). Transport failures return `status: "unreachable"` rather than throwing (verified `health.ts:122-137`). Outage view is `report.metadataProvider` derived by `detectMetadataProviderOutage` (`health.ts:91`, pattern `/metadata\|skyhook\|api\.lidarr\.audio/i`, error-level only).                                                                                                                                                                                                                                                                                                                                     | action: "Metadata-dependent operations (`lidarr search`, `lidarr lookup`, artist add) are gated until the provider recovers; local-only commands stay safe." · command: `rfmedia lidarr health --type error` · docUrl: first failing check's `wikiUrl`                                                                                                                                                                                                                                                                           |
| 2   | `operation-safety`              | `health`, `artists`                     | critical | (a) Lidarr's own non-metadata health checks (root-folder accessibility, disk space, permissions, indexers) translated to audit severity, **excluding** every check already claimed by `detectMetadataProviderOutage` so nothing double-counts; (b) artists with `path === undefined`, which cannot receive imports (warning)                                                                                                                                                                                  | `LidarrHealthReport.errors` + `.warnings` (`LidarrHealthCheck { source, type, message, wikiUrl? }`, `src/types/lidarr.ts:357`); `client.listArtists()` → `LidarrArtist.path` (optional, `src/types/lidarr.ts:171`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | (a) action = the check's own `message`; docUrl = its `wikiUrl` (Lidarr's own wiki is the better target) · command: `rfmedia lidarr health --type error --type warning`. (b) action: "Assign a root folder to the artist in Lidarr; no CLI surface assigns one today."                                                                                                                                                                                                                                                            |
| 3   | `retry-backlog`                 | `queue`                                 | critical | (a) circuits in `open` (critical, with `retryAtIso`) or `half-open` (warning); (b) `{ state: "unknown", reason }` surfaced verbatim as info — never read as healthy; (c) `failed` deferred intents (critical — work permanently dropped); (d) `pending` intents (warning) with oldest-pending age, overdue count (`nextAttemptAt <= now`), and near-exhaustion count (`attempts >= maxAttempts - 1`)                                                                                                          | `collectLidarrAuditQueueState` (new, `src/lib/lidarr/audit-queue.ts`): `readLidarrResilienceSnapshot(overrides)` (`health.ts:376`, never throws) for `circuits[]` + `deferredIntents`, then ONE DB open → `countDeferredIntentsByStatus(db, origin)` (`deferred-queue-db.ts:537`, all five statuses zero-filled, never throws) and `listDeferredIntents(db, { status: "pending", origin, limit })` (`deferred-queue.ts:322`) in its **own** nested try/catch because it throws on malformed rows                                                                                                                                                                                                                | (a) action: "Automatic retries resume at `<retryAtIso>`." (b) action quotes the reason, e.g. `cannot open tracking database: …`. (c) action: "N deferred intents exhausted their attempts and will not replay; re-issue the originating operation." (d) action: "Replay is automatic with exponential backoff (30 s base, 1 h cap)." · command: `rfmedia lidarr health`                                                                                                                                                          |
| 4   | `monitoring-drift`              | `artists`, `albums`                     | warning  | (a) `monitored-album-under-unmonitored-artist` (**warning**) — Lidarr gates searching on `artist.monitored`, so these are genuinely dead work; (b) `monitored-artist-no-monitored-albums` (**info**) — this is exactly what Lidarr's stock "Monitor: Future" produces and is frequently intentional; the message says so                                                                                                                                                                                      | `client.listArtists()` joined by `artistId` to `scanSelectedArtists(client, artistIds, { taskIdPrefix: "lidarr-audit-albums", operationLabel: "lidarr audit album scan" })` → `AlbumScan { albums, artistNames, artistsScanned, execution }` (`src/actions/lidarr/album-scan.ts:118`). Requires `--deep`.                                                                                                                                                                                                                                                                                                                                                                                                       | (a) command: `rfmedia lidarr plan artist-monitoring --ids <id> --monitored --plan-file ./audit-artist-monitoring.plan.json` · action names `rfmedia lidarr apply <file>` as the operator-driven follow-up. (b) command: `rfmedia lidarr plan album-monitoring --artist-ids <id> --monitored --plan-file ./audit-album-monitoring.plan.json`                                                                                                                                                                                      |
| 5   | `library-gaps`                  | `artists`, `wanted` / enriches `albums` | warning  | (a) `artist-monitored-no-files` (**warning**) — monitored artist with `statistics.trackCount > 0 && statistics.trackFileCount === 0`; (b) `wanted-backlog` (**info**) — library-wide missing total; (c) `--deep`: `album-monitored-no-files` (**warning**) — monitored, **released**, zero files; (d) `--deep`: `album-partial-files` (**info**) — `0 < trackFileCount < trackCount`                                                                                                                          | `LidarrArtistStatistics` (`src/types/lidarr.ts:135-148`); `client.getWantedMissing({ page: 1, pageSize: 1 })` → `LidarrWantedPage.totalRecords` (one request, no traversal); albums via `filterLidarrAlbums(albums, { monitored: true, hasFiles: false })` (`src/lib/lidarr/album-selection.ts:50`) — reused, not re-derived, because its private `albumHasFiles` already encodes "absent statistics counts as zero files" (`album-selection.ts:35`). Future releases excluded via `LidarrAlbum.releaseDate` (`src/types/lidarr.ts:216`).                                                                                                                                                                       | (a) action: "Nothing has been downloaded for this artist. A library-wide collapse is almost always an unmounted root folder, not a search problem." · command: `rfmedia lidarr albums --artist-ids <id> --no-files`. (b) command: `rfmedia lidarr wanted --page-size 50`; message states the total is library-wide and ignores `--artist-ids`. (c)/(d) command: `rfmedia lidarr albums --artist-ids <id> --no-files`                                                                                                             |
| 6   | `duplicate-identity`            | `artists` / enriches `albums`           | critical | (a) `duplicate-artist-mbid` (**critical**) — ≥2 artists sharing `foreignArtistId`; real corruption, since `projectLidarrArtistArray` already rejects duplicate internal ids via `hasUniqueIds`; (b) `duplicate-artist-path` (**warning**) — ≥2 artists sharing a separator-normalized `path`, i.e. two entries writing to one folder; (c) `similar-artist-name` (**info**) — folded-name collision with _distinct_ MBIDs, labelled a candidate not a verdict; (d) `--deep`: `duplicate-album-mbid` (**info**) | `client.listArtists()` → `foreignArtistId` (required), `path` (optional), `artistName`; `LidarrAlbum.foreignAlbumId` (optional). Grouping via `groupDuplicates(items, keyOf)` — `keyOf` returning `undefined` **excludes** the item, so an absent optional field can never act as a match key. Name folding: `normalizeForMatch` from `src/lib/fuzzy-match.ts:55` **plus** an explicit `.normalize("NFKD").replace(/\p{M}/gu, "")` and a leading-article strip (verified: `normalizeForMatch` lowercases, maps ellipsis/dashes/quotes/nbsp, strips ASCII punctuation, collapses whitespace — it does **not** NFKD-fold, so "Björk"/"Bjork" would not collide without the added step). O(n) hash bucketing only. | (a) action: "Two Lidarr entries claim the same MusicBrainz artist. Decide which is canonical." · command: `rfmedia lidarr lookup artist "lidarr:<mbid>"` · deletion named in prose only (`rfmedia lidarr plan artist-delete`), never as `command`. (b) action: "Reassign one artist to its own folder in Lidarr before the next import; do not delete files until the paths are separated." · command: `rfmedia lidarr list` (c) action: "Confirm on MusicBrainz whether these are distinct artists; if so no action is needed." |
| 7   | `plex-connectivity`             | `plex`                                  | critical | (a) unreachable / auth failure, discriminated on `MediaServerError.code` (`authentication`/`authorization`/`network`/`timeout` → critical; others → warning); (b) zero music libraries returned — `mapPlexLibrary` drops non-music sections, so `[]` is a legitimate "no music library" finding, not a transport error (warning); (c) configured `plex.libraryName` fails to resolve, surfacing `library.byName()`'s message verbatim because it already embeds `Available: <titles>` (warning)               | `resolveRequiredMediaServerAdapter({ plexUrl, plexToken })` (`src/lib/adapters/action-helpers.ts:38`) → `adapter.library.list()` / `adapter.library.byName(name)` (`MediaServerLibraryCapability`, `src/types/media-server.ts:255-258`). Behind an explicit `Boolean(url && token)` gate — **not** `createOptionalMediaServerAdapter` (scan-gated on `scanAfterCopy`, default false) and **not** `getConfiguredMediaServerType` (ORs url/token). Absent credentials ⇒ slot `unavailable`, adapter never constructed.                                                                                                                                                                                            | (a) action: "Set `plex.url` / `plex.token` in config or pass `--plex-url` / `--plex-token`." (b) action: "No music library is exposed by this Plex server." (c) `evidence.available` carries the verbatim `Available: …` list so the operator can fix `plex.libraryName` without a second command.                                                                                                                                                                                                                               |
| 8   | `plex-alignment` **(RESERVED)** | `plex`, `plexIdentity`                  | —        | Never emits a finding. Always `skipped` with `plex-not-configured` (no credentials) or `identity-mapping-unavailable` (Plex configured, no join layer — detail cites #207/#208).                                                                                                                                                                                                                                                                                                                              | None today. The `plexIdentity` slot is emitted by the action as a compile-time constant `unavailable`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | n/a — the skip `detail` names the blocking issues so a `--json` reader learns _why_ rather than assuming a pass.                                                                                                                                                                                                                                                                                                                                                                                                                 |

### Considered and DEFERRED (with reason)

| Check                                                                  | Why deferred                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cutoff-unmet backlog                                                   | `getApiV1WantedCutoff` exists at `src/lib/lidarr/generated/sdk.gen.ts:990` but has no `LidarrClientApi` method. Reaching it = 5 coordinated edits (client method, `types.ts` guard+projector, `src/types/lidarr.ts` domain type, `resilience.ts` `wrapped` passthrough — a compile error until added, and `LIDARR_IN_PLACE_RETRY_ALLOWLIST`) plus every barrel-mocked client stub, plus a codegen contract change. |
| Root-folder accessibility / free space (real figures)                  | `getApiV1Rootfolder` (`sdk.gen.ts:2382`) and `getApiV1Diskspace` (`:1062`) — same 5-edit cost. Lidarr emits its own root-folder, disk-space, and permission health checks, each with a `wikiUrl`, so `operation-safety` covers the same operational ground with zero new plumbing.                                                                                                                                 |
| Download-queue / history / trackfile drift                             | `getApiV1Queue`, `getApiV1History`, `getApiV1Trackfile` — same cost; none is a _library health_ signal, they are activity views.                                                                                                                                                                                                                                                                                   |
| Metadata-cache freshness                                               | `readLidarrCache` **throws** on a malformed row (`metadata-cache.ts:84,99`), the opposite of `readLidarrResilienceSnapshot`. A poisoned row would need bespoke isolation for marginal value.                                                                                                                                                                                                                       |
| Plex↔Lidarr catalog reconciliation                                     | No join key exists (§1). Shipped as the reserved `plex-alignment` slot.                                                                                                                                                                                                                                                                                                                                            |
| `MediaArtist.albumCount` vs `LidarrArtist.statistics.albumCount` drift | **Explicitly rejected, not merely deferred.** `mapPlexArtist` sets `albumCount` from Plex `childCount` (albums Plex has scanned) while Lidarr counts every tracked album including unreleased and unmonitored. Guaranteed constant false positives. Recorded here and in `docs/features/lidarr-audit.md` so #208's implementer does not reach for it.                                                              |
| Percent-of-tracks coverage thresholds                                  | **Rejected.** `LidarrArtistStatistics.trackCount` is documented as "Number of tracks known across **monitored** albums" while `trackFileCount` is "Number of track files present on disk" (all albums), with `totalTrackCount` as the all-albums denominator. The ratio mixes numerator and denominator scopes and can exceed 100. Only the unambiguous `trackCount > 0 && trackFileCount === 0` case ships.       |
| "Unmonitored artist with files on disk"                                | **Rejected.** Unmonitoring a completed discography is the most common deliberate operator action in Lidarr; this would fire on most of a mature library at warning level.                                                                                                                                                                                                                                          |
| `anyReleaseOk === false` release-policy drift                          | **Rejected.** `anyReleaseOk: false` means Lidarr targets a specific release — a legitimate setting that does not block acquisition.                                                                                                                                                                                                                                                                                |

---

## 3. Type contract

```ts
// ═════════════════════════════════════════════════════════════════════════════
// src/types/lidarr-audit.ts  (new)
//
// Operator- and CI-facing audit contract. Values live here alongside types,
// matching src/types/lidarr-plan.ts and src/types/completion.ts; the command
// layer imports the registry statically for `.choices()` without loading any
// evaluator code.
// ═════════════════════════════════════════════════════════════════════════════

import type { CircuitScope, CircuitState } from "../lib/lidarr/circuit-breaker.js";
import type { DbLidarrDeferredIntentStatus } from "../lib/lidarr/deferred-queue-db.js";
import type { MediaServerErrorCode, MediaServerLibrary } from "./media-server.js";

// ── Severity ────────────────────────────────────────────────────────────────

/**
 * Diagnostic urgency ladder, ascending.
 *
 * Deliberately distinct from `LidarrRiskLevel` (`types/lidarr-plan.ts:190`),
 * which rates the blast radius of a proposed mutation, and from
 * `LidarrHealthType` (`types/lidarr.ts:352`), which is Lidarr's wire severity.
 * Wire severities are translated into this ladder, never adopted.
 */
export const LIDARR_AUDIT_SEVERITIES = ["info", "warning", "critical"] as const;
export type LidarrAuditSeverity = (typeof LIDARR_AUDIT_SEVERITIES)[number];

/** Accepted `--fail-on` levels; `"none"` disables the findings-driven exit. */
export const LIDARR_AUDIT_FAIL_ON_LEVELS = ["none", "info", "warning", "critical"] as const;
export type LidarrAuditFailOn = (typeof LIDARR_AUDIT_FAIL_ON_LEVELS)[number];

// ── Registry ────────────────────────────────────────────────────────────────

/** A data source a check needs. Drives both the fetch plan and the skip gate. */
export const LIDARR_AUDIT_REQUIREMENTS = [
  "health",
  "artists",
  "wanted",
  "albums",
  "queue",
  "plex",
  "plexIdentity",
] as const;
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
export type LidarrAuditCheckId = (typeof LIDARR_AUDIT_CHECK_IDS)[number];

/**
 * Ids declared for schema stability but not implemented in this release. They
 * never dispatch an evaluator, so no unreachable function body exists.
 */
export const LIDARR_AUDIT_RESERVED_CHECK_IDS = ["plex-alignment"] as const;
export type LidarrAuditReservedCheckId = (typeof LIDARR_AUDIT_RESERVED_CHECK_IDS)[number];

/** Ids backed by a real evaluator. The evaluator map is keyed on this union. */
export type LidarrAuditEvaluatedCheckId = Exclude<LidarrAuditCheckId, LidarrAuditReservedCheckId>;

/** Static description of one registered check. Carries no behavior. */
export interface LidarrAuditCheckDescriptor {
  readonly id: LidarrAuditCheckId;
  readonly title: string;
  readonly description: string;
  /** Hard gate: every entry must be an available slot or the check skips. */
  readonly requires: readonly LidarrAuditRequirement[];
  /** Soft: fetched when possible; adds depth, never gates. */
  readonly enriches: readonly LidarrAuditRequirement[];
  /** Highest severity this check can emit; used to reject a dead `--fail-on`. */
  readonly maxSeverity: LidarrAuditSeverity;
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
  },
  "operation-safety": {
    id: "operation-safety",
    title: "Operation safety",
    description: "Root-folder, disk-space, and permission conditions reported by Lidarr",
    requires: ["health", "artists"],
    enriches: [],
    maxSeverity: "critical",
  },
  "retry-backlog": {
    id: "retry-backlog",
    title: "Retry backlog",
    description: "Circuit-breaker state and deferred-intent replay queue depth",
    requires: ["queue"],
    enriches: [],
    maxSeverity: "critical",
  },
  "monitoring-drift": {
    id: "monitoring-drift",
    title: "Monitoring drift",
    description: "Album monitoring that contradicts its owning artist",
    requires: ["artists", "albums"],
    enriches: [],
    maxSeverity: "warning",
  },
  "library-gaps": {
    id: "library-gaps",
    title: "Library gaps",
    description: "Monitored entities missing files, plus the wanted/missing backlog",
    requires: ["artists", "wanted"],
    enriches: ["albums"],
    maxSeverity: "warning",
  },
  "duplicate-identity": {
    id: "duplicate-identity",
    title: "Duplicate identity",
    description: "Repeated MusicBrainz ids, shared root paths, and folded-name collisions",
    requires: ["artists"],
    enriches: ["albums"],
    maxSeverity: "critical",
  },
  "plex-connectivity": {
    id: "plex-connectivity",
    title: "Plex connectivity",
    description: "Media-server reachability and music-library resolution",
    requires: ["plex"],
    enriches: [],
    maxSeverity: "critical",
  },
  "plex-alignment": {
    id: "plex-alignment",
    title: "Plex-Lidarr alignment",
    description: "Cross-service reconciliation (requires the identity-mapping layer)",
    requires: ["plex", "plexIdentity"],
    enriches: [],
    maxSeverity: "warning",
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

/** Circuit + deferred-queue state; assembled without ever throwing. */
export interface LidarrAuditQueueState {
  readonly circuits: readonly {
    readonly scope: CircuitScope;
    readonly state: CircuitState | { readonly state: "unknown"; readonly reason: string };
    readonly retryAtIso?: string;
  }[];
  /** All five lifecycle statuses, zero-filled. */
  readonly counts: Readonly<Record<DbLidarrDeferredIntentStatus, number>>;
  /** Age of the oldest `pending` intent, when the detail read succeeded. */
  readonly oldestPendingAgeSeconds?: number;
  /** Pending intents whose `nextAttemptAt` is already past. */
  readonly overdue?: number;
  /** Pending intents at `attempts >= maxAttempts - 1`. */
  readonly nearExhaustion?: number;
  /** Set when the per-row detail read failed; counts remain valid. */
  readonly detailUnavailableReason?: string;
}

/** Outcome of the single cheap Plex probe. Identity joins are out of scope. */
export type LidarrAuditPlexProbe =
  | {
      readonly reachable: true;
      readonly libraries: readonly MediaServerLibrary[];
      readonly configuredLibraryName?: string;
      readonly configuredLibraryResolved?: boolean;
      /** Verbatim `Available: …` text from a failed name resolution. */
      readonly resolutionDetail?: string;
    }
  | {
      readonly reachable: false;
      readonly code: MediaServerErrorCode;
      readonly message: string;
    };

/** Albums plus artist-name context, adapted from `AlbumScan`. */
export interface LidarrAuditAlbumData {
  readonly albums: readonly import("./lidarr.js").LidarrAlbum[];
  readonly artistNames: ReadonlyMap<number, string>;
  readonly artistsScanned: number;
}

/**
 * Everything the action fetched, one slot per requirement. The lib layer reads
 * these; it never fetches and never resolves a client.
 */
export interface LidarrAuditGatheredData {
  readonly health: LidarrAuditSlot<import("../lib/lidarr/health.js").LidarrHealthReport>;
  readonly artists: LidarrAuditSlot<readonly import("./lidarr.js").LidarrArtist[]>;
  readonly wanted: LidarrAuditSlot<{ readonly total: number }>;
  readonly albums: LidarrAuditSlot<LidarrAuditAlbumData>;
  readonly queue: LidarrAuditSlot<LidarrAuditQueueState>;
  readonly plex: LidarrAuditSlot<LidarrAuditPlexProbe>;
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
 * `action` prose. ROADMAP.md frames #211 as a read-only operator view.
 */
export interface LidarrAuditRemediation {
  readonly action: string;
  readonly command?: string;
  readonly docUrl?: string;
}

/** Hard cap on subjects embedded per finding; `affected` carries the true count. */
export const LIDARR_AUDIT_MAX_SUBJECTS = 10;

/** One audit finding. `evidence` is flat and scalar-valued so CSV stays lossless. */
export interface LidarrAuditFinding {
  readonly checkId: LidarrAuditCheckId;
  /** Stable kebab code, unique within the check. A public contract once shipped. */
  readonly code: string;
  readonly severity: LidarrAuditSeverity;
  readonly summary: string;
  /** Affected entities, capped at {@link LIDARR_AUDIT_MAX_SUBJECTS}. */
  readonly subjects: readonly LidarrAuditSubject[];
  /** True affected count before capping. */
  readonly affected: number;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly remediation: LidarrAuditRemediation;
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

export interface LidarrAuditSummary {
  readonly critical: number;
  readonly warning: number;
  readonly info: number;
  readonly total: number;
  readonly checksRun: number;
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
  readonly artistsExamined: number;
  readonly albumsExamined: number;
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
  readonly checkedAt: string;
  /** Credential-free canonical Lidarr origin. Never contains the API key. */
  readonly origin: string;
  readonly deep: boolean;
  readonly status: "clean" | "findings" | "degraded";
  readonly summary: LidarrAuditSummary;
  readonly checks: readonly LidarrAuditCheckResult[];
  readonly findings: readonly LidarrAuditFinding[];
  readonly coverage: LidarrAuditCoverage;
}

/** A check's verdict function: pure, synchronous, gathered data in / findings out. */
export type LidarrAuditEvaluator = (gathered: LidarrAuditGatheredData) => readonly LidarrAuditFinding[];
```

```ts
// ═════════════════════════════════════════════════════════════════════════════
// src/lib/lidarr/audit-identity.ts  (new) — the only novel algorithm
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Folds an artist name to a duplicate-candidate key.
 *
 * Delegates casefold, unicode-character mapping, punctuation stripping, and
 * whitespace collapse to `normalizeForMatch` (`../fuzzy-match.js`), then adds
 * the two steps it does NOT perform — NFKD decomposition with combining-mark
 * removal (so "Björk" and "Bjork" collide) and a leading-article strip.
 *
 * Exact post-fold equality only. `findBestMatch`/`compareSimilarity` are
 * deliberately unused: `findBestMatch` emits a `logDebug` per pairwise
 * comparison, and a threshold matcher has no tiebreak key.
 *
 * @param name - Raw `LidarrArtist.artistName`.
 * @returns The fold key; `""` when nothing survives folding.
 */
export function foldArtistName(name: string): string;

/**
 * Normalizes an artist path for collision detection: duplicate separators
 * collapsed and trailing separators removed. Comparison stays CASE-SENSITIVE —
 * these containers run on Linux with case-sensitive bind mounts, so folding
 * case would fabricate critical-severity duplicates from distinct directories.
 *
 * @param path - Raw `LidarrArtist.path`.
 * @returns The normalized key; `""` when the path is blank.
 */
export function normalizeArtistPath(path: string): string;

/** A set of items that collapsed onto one identity key. */
export interface LidarrAuditDuplicateGroup<T> {
  readonly key: string;
  /** Always length >= 2. */
  readonly members: readonly T[];
}

/**
 * Groups items by a derived key in O(n), returning only collisions.
 *
 * @param items - Items to group.
 * @param keyOf - Key deriver. Returning `undefined` or `""` EXCLUDES the item,
 *   so an absent optional field can never act as a match key.
 * @returns Frozen groups of two or more, ordered by first appearance.
 */
export function groupDuplicates<T>(
  items: readonly T[],
  keyOf: (item: T) => string | undefined,
): readonly LidarrAuditDuplicateGroup<T>[];
```

```ts
// ═════════════════════════════════════════════════════════════════════════════
// src/lib/lidarr/audit-library-checks.ts  (new) — pure, zero I/O
// ═════════════════════════════════════════════════════════════════════════════
export function evaluateMonitoringDrift(g: LidarrAuditGatheredData): readonly LidarrAuditFinding[];
export function evaluateLibraryGaps(g: LidarrAuditGatheredData): readonly LidarrAuditFinding[];
export function evaluateDuplicateIdentity(g: LidarrAuditGatheredData): readonly LidarrAuditFinding[];

// ═════════════════════════════════════════════════════════════════════════════
// src/lib/lidarr/audit-platform-checks.ts  (new) — pure, zero I/O
// ═════════════════════════════════════════════════════════════════════════════
export function evaluateMetadataDependency(g: LidarrAuditGatheredData): readonly LidarrAuditFinding[];
export function evaluateOperationSafety(g: LidarrAuditGatheredData): readonly LidarrAuditFinding[];
export function evaluateRetryBacklog(g: LidarrAuditGatheredData): readonly LidarrAuditFinding[];
export function evaluatePlexConnectivity(g: LidarrAuditGatheredData): readonly LidarrAuditFinding[];

// ═════════════════════════════════════════════════════════════════════════════
// src/lib/lidarr/audit.ts  (new) — engine. Pure and synchronous.
// MUST NOT statically import "./index.js": the barrel does `export * from
// "./health.js"` etc. and a static edge back would create an ESM cycle — the
// same hazard that forced `LidarrClientOverrides` to be duplicated at
// health.ts:301 and `tiers.ts` to use a lazy `await import("./health.js")`.
// ═════════════════════════════════════════════════════════════════════════════

export interface LidarrAuditRunInput {
  readonly checkedAt: string;
  readonly origin: string;
  readonly deep: boolean;
  readonly selected: ReadonlySet<LidarrAuditCheckId>;
  readonly gathered: LidarrAuditGatheredData;
}

/**
 * Runs every registered check and assembles the report.
 *
 * Requirement gating and per-check error isolation live HERE, never in a check:
 * a check whose `requires` includes an unavailable slot reports `skipped` with
 * that slot's own reason and detail, and a check that throws reports
 * `skipped/check-error` while every other check still runs.
 *
 * @param input - Timestamp, origin, depth, selection, and gathered data.
 * @returns The frozen report, checks in registry declaration order.
 */
export function runLidarrAudit(input: LidarrAuditRunInput): LidarrAuditReport;

/**
 * Validates and expands a raw `--check` selection.
 *
 * @param raw - Raw check ids, or `undefined` to select every registered check.
 * @returns Selected ids in registry order.
 * @throws {MissingRequiredArgumentError} On an unknown id.
 */
export function resolveLidarrAuditSelection(raw: readonly string[] | undefined): readonly LidarrAuditCheckId[];

/**
 * Computes the fetch plan for a selection.
 *
 * @param selected - Selected check ids.
 * @returns Hard requirements and soft enrichments, deduplicated.
 */
export function resolveLidarrAuditRequirements(selected: readonly LidarrAuditCheckId[]): {
  readonly required: ReadonlySet<LidarrAuditRequirement>;
  readonly enriched: ReadonlySet<LidarrAuditRequirement>;
};

/**
 * @param report - A completed report.
 * @param failOn - The configured gate level.
 * @returns True when the command must set `process.exitCode = 1`.
 */
export function shouldFailLidarrAudit(report: LidarrAuditReport, failOn: LidarrAuditFailOn): boolean;

// ═════════════════════════════════════════════════════════════════════════════
// src/lib/lidarr/audit-queue.ts  (new) — the only DB I/O in the feature
// ═════════════════════════════════════════════════════════════════════════════

export interface LidarrAuditQueueDependencies {
  /** Test seam; defaults to `initializeDatabase()` from `../db.js`. */
  readonly openDb?: () => Promise<DbConnection>;
}

/**
 * Assembles circuit state and deferred-intent backlog. NEVER throws.
 *
 * Circuit state comes from `readLidarrResilienceSnapshot`, which already
 * degrades to `{ state: "unknown", reason }` per scope. The per-row detail read
 * (`listDeferredIntents`) is wrapped SEPARATELY from the count read
 * (`countDeferredIntentsByStatus`) because the former throws on a malformed row
 * — one poisoned row must cost the age/attempt detail, never the counts.
 *
 * @param overrides - Lidarr connection overrides.
 * @param origin - Credential-free canonical origin, resolved by the action.
 * @param deps - Test seams.
 * @returns The queue state; failures become explicit fields, never exceptions.
 */
export async function collectLidarrAuditQueueState(
  overrides: LidarrClientOverrides,
  origin: string,
  deps?: LidarrAuditQueueDependencies,
): Promise<LidarrAuditQueueState>;

// ═════════════════════════════════════════════════════════════════════════════
// src/actions/lidarr/audit-plex.ts  (new) — sole adapter boundary
// ═════════════════════════════════════════════════════════════════════════════

export interface LidarrAuditPlexOverrides {
  readonly plexUrl?: string;
  readonly plexToken?: string;
}

/**
 * Probes the media server for the audit. NEVER throws.
 *
 * Returns `{ status: "unavailable", reason: "plex-not-configured" }` WITHOUT
 * constructing an adapter when url or token is absent. `requireMediaServerAdapter`
 * throws on missing credentials; `createOptionalMediaServerAdapter` is a SCAN
 * gate (`plexScan ?? plex.scanAfterCopy ?? false`, default false); and
 * `getConfiguredMediaServerType` ORs url/token. None is a readiness check.
 *
 * @param overrides - CLI Plex connection overrides.
 * @returns The probe slot; `MediaServerError` is converted, never rethrown.
 */
export async function probeLidarrAuditPlex(
  overrides: LidarrAuditPlexOverrides,
): Promise<LidarrAuditSlot<LidarrAuditPlexProbe>>;

// ═════════════════════════════════════════════════════════════════════════════
// src/actions/lidarr/audit.ts  (new)
// ═════════════════════════════════════════════════════════════════════════════

/** Reliability tier for `audit`. Never contacts api.lidarr.audio. */
export const TIER: LidarrTier = "local-only";

export interface LidarrAuditActionOptions {
  /** Raw `--check` values; `undefined` selects every registered check. */
  readonly check?: readonly string[];
  /** Enables the 1 + N per-artist album scan. */
  readonly deep?: boolean;
  /** Scopes the deep scan; rejected by the command without `--deep`. */
  readonly artistIds?: readonly number[];
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
  readonly plexUrl?: string;
  readonly plexToken?: string;
}

export interface LidarrAuditActionResult {
  readonly execution: LidarrExecutionSuccessMetadata;
  readonly report: LidarrAuditReport;
}

/**
 * Executes one read-only library health audit.
 *
 * Strictly non-mutating: no writes, no artifacts, no cache population. Fetches
 * only the data the SELECTED checks require, so `--check retry-backlog` issues
 * zero HTTP requests. Diagnostic by contract — findings never fail this call;
 * the command layer owns exit behavior.
 *
 * @param options - Selection, depth, and connection overrides.
 * @returns The report plus scheduler execution metadata.
 * @throws {MissingRequiredArgumentError} On an unknown `--check` id.
 * @throws {LidarrError} When the Lidarr client cannot be resolved, or a planned
 *   Lidarr read fails for a non-transport reason.
 * @throws {LidarrPlanValidationError} When a `--deep` album scan does not
 *   complete. The scan is fail-closed by design: a partial artist/album set
 *   would fabricate duplicate-identity groups and gap findings, and a wrong
 *   audit is worse than a failed one.
 */
export async function executeLidarrAudit(options: LidarrAuditActionOptions): Promise<LidarrAuditActionResult>;

// ═════════════════════════════════════════════════════════════════════════════
// src/actions/lidarr/index.ts  (modify — two lines, house pattern)
// ═════════════════════════════════════════════════════════════════════════════
export { executeLidarrAudit, TIER as LIDARR_AUDIT_TIER } from "./audit.js";
export type { LidarrAuditActionOptions, LidarrAuditActionResult } from "./audit.js";

// ═════════════════════════════════════════════════════════════════════════════
// src/commands/lidarr-audit.ts  (new) — imports NOTHING from ./lidarr.js
// ═════════════════════════════════════════════════════════════════════════════

/** Parent-private helpers injected at registration time (no ESM cycle). */
export interface LidarrAuditCommandDeps {
  readonly resolveFormat: () => OutputFormat;
  readonly reportLidarrFailure: (
    subcommand: string,
    error: unknown,
    options: {
      readonly staleHint: boolean;
      readonly format: OutputFormat;
      readonly sensitiveValues?: readonly unknown[];
    },
  ) => Promise<void>;
  readonly renderExecutionSummary: (execution: LidarrExecutionSuccessMetadata) => void;
  /** `parseIdList` from the parent: comma-separated unique positive ints. */
  readonly parseIdList: (label: string, value: string) => number[];
}

/** Machine success envelope. */
export interface LidarrAuditJsonOutput {
  readonly command: "lidarr-audit";
  readonly result: LidarrAuditActionResult;
}

/**
 * Stable CSV schema: one `summary` row, then one `check` row per registered
 * check, then one `finding` row per finding, sharing a flat file via `rowType`.
 * Modelled on `LIDARR_SEARCH_CSV_COLUMNS` (`./lidarr-search.js`).
 */
export const LIDARR_AUDIT_CSV_COLUMNS = [
  "command",
  "rowType",
  "report.checkedAt",
  "report.origin",
  "report.deep",
  "report.status",
  "summary.total",
  "summary.critical",
  "summary.warning",
  "summary.info",
  "summary.checksRun",
  "summary.checksSkipped",
  "summary.highestSeverity",
  "coverage.artistsExamined",
  "coverage.albumsExamined",
  "coverage.artistsScanned",
  "coverage.wantedTotal",
  "execution.lane",
  "execution.outcome",
  "execution.attempts",
  "check.id",
  "check.status",
  "check.findingCount",
  "check.skipReason",
  "check.detail",
  "finding.checkId",
  "finding.code",
  "finding.severity",
  "finding.summary",
  "finding.affected",
  "finding.subjects",
  "finding.evidence",
  "finding.remediationAction",
  "finding.remediationCommand",
  "finding.docUrl",
] as const;

/**
 * Builds the `lidarr audit` leaf.
 *
 * @param deps - Parent-injected output, failure, and parsing helpers.
 * @returns The configured Commander leaf, ready for `addCommand`.
 */
export function createLidarrAuditCommand(deps: LidarrAuditCommandDeps): Command;
```

### JSON output schema (worked example)

```json
{
  "command": "lidarr-audit",
  "result": {
    "execution": {
      "taskId": "lidarr-audit",
      "operation": "lidarr audit",
      "lane": "local-only",
      "outcome": "succeeded",
      "attempts": 1
    },
    "report": {
      "checkedAt": "2026-07-25T18:04:11.220Z",
      "origin": "http://lidarr:8686",
      "deep": false,
      "status": "findings",
      "summary": {
        "critical": 1,
        "warning": 3,
        "info": 2,
        "total": 6,
        "checksRun": 5,
        "checksSkipped": 3,
        "highestSeverity": "critical"
      },
      "checks": [
        {
          "id": "metadata-dependency",
          "title": "Metadata dependency health",
          "status": "findings",
          "findingCount": 1,
          "highestSeverity": "critical"
        },
        {
          "id": "monitoring-drift",
          "title": "Monitoring drift",
          "status": "skipped",
          "findingCount": 0,
          "skipReason": "requires-deep",
          "detail": "album data requires --deep (1 + N requests)"
        },
        {
          "id": "plex-alignment",
          "title": "Plex-Lidarr alignment",
          "status": "skipped",
          "findingCount": 0,
          "skipReason": "identity-mapping-unavailable",
          "detail": "Plex artists carry no MusicBrainz id; reconciliation lands with #207/#208"
        }
      ],
      "findings": [
        {
          "checkId": "duplicate-identity",
          "code": "duplicate-artist-mbid",
          "severity": "critical",
          "summary": "2 artists share MusicBrainz id f22942a1-…",
          "subjects": [
            { "kind": "artist", "artistId": 42, "name": "Aphex Twin" },
            { "kind": "artist", "artistId": 907, "name": "Aphex Twin" }
          ],
          "affected": 2,
          "evidence": { "foreignArtistId": "f22942a1-…", "groupSize": 2 },
          "remediation": {
            "action": "Two Lidarr entries claim the same MusicBrainz artist. Decide which is canonical, then plan a delete for the other and review the artifact before applying.",
            "command": "rfmedia lidarr lookup artist \"lidarr:f22942a1-…\""
          }
        }
      ],
      "coverage": { "artistsExamined": 812, "albumsExamined": 0, "artistsScanned": 0, "wantedTotal": 137 }
    }
  }
}
```

CI usage: `rfmedia lidarr audit --output json --fail-on warning | jq -r '.result.report.summary.highestSeverity'`.

---

## 4. Module layout

All paths relative to `packages/rfmedia-cli/`.

### Create — production (8 files)

| Path                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | ~Lines |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/types/lidarr-audit.ts`               | Severity/fail-on/requirement/check-id tuples, the frozen `LIDARR_AUDIT_CHECK_DESCRIPTORS` registry (`as const satisfies Readonly<Record<…>>`, the `LIDARR_TIER_DESCRIPTORS` pattern at `tiers.ts:45`), slot/finding/result/report/summary/coverage contracts, `LIDARR_AUDIT_MAX_SUBJECTS`. Imports only types plus `CircuitScope`/`CircuitState` and `DbLidarrDeferredIntentStatus` — the `types/lidarr-resilience.ts:15` precedent. Command imports it statically for `.choices()` with zero evaluator code loaded. | 250    |
| `src/lib/lidarr/audit-identity.ts`        | `foldArtistName`, `normalizeArtistPath`, `groupDuplicates<T>`. Reuses `normalizeForMatch` from `../fuzzy-match.js` and adds the NFKD + combining-mark strip and article strip it lacks. O(n) only.                                                                                                                                                                                                                                                                                                                   | 100    |
| `src/lib/lidarr/audit-library-checks.ts`  | Pure evaluators over library data: `evaluateMonitoringDrift`, `evaluateLibraryGaps`, `evaluateDuplicateIdentity`. Reuses `filterLidarrAlbums` from `./album-selection.js`. Zero I/O, zero client imports.                                                                                                                                                                                                                                                                                                            | 270    |
| `src/lib/lidarr/audit-platform-checks.ts` | Pure evaluators over platform state: `evaluateMetadataDependency`, `evaluateOperationSafety`, `evaluateRetryBacklog`, `evaluatePlexConnectivity`. Reuses `detectMetadataProviderOutage` from `./health.js` verbatim; exhaustive `LidarrHealthType → LidarrAuditSeverity` switch with a `const exhaustive: never` clause.                                                                                                                                                                                             | 240    |
| `src/lib/lidarr/audit.ts`                 | The engine. `EVALUATORS: Readonly<Record<LidarrAuditEvaluatedCheckId, LidarrAuditEvaluator>>` (compile-error-total, reserved ids excluded so no unreachable body exists), `runLidarrAudit`, `resolveLidarrAuditSelection`, `resolveLidarrAuditRequirements`, `shouldFailLidarrAudit`. Must NOT statically import `./index.js`.                                                                                                                                                                                       | 210    |
| `src/lib/lidarr/audit-queue.ts`           | `collectLidarrAuditQueueState` — the only DB access. `readLidarrResilienceSnapshot` + one `initializeDatabase()` → `countDeferredIntentsByStatus` (safe) + `listDeferredIntents` (own nested try/catch) → `closeDatabase` in `finally`. Never throws. `deps.openDb` test seam, `health.ts:309` precedent.                                                                                                                                                                                                            | 130    |
| `src/actions/lidarr/audit.ts`             | `executeLidarrAudit` + `TIER`. Computes the fetch plan, resolves origin + client, runs ONE `runSingle` for the Lidarr HTTP gather, runs the album scan / queue read / Plex probe outside it, assembles the slots, delegates to `runLidarrAudit`, deep-freezes.                                                                                                                                                                                                                                                       | 220    |
| `src/actions/lidarr/audit-plex.ts`        | `probeLidarrAuditPlex`. Explicit url-AND-token gate first, `resolveRequiredMediaServerAdapter` only behind it, `MediaServerError.code` discrimination, never rethrows. The one file #208 changes.                                                                                                                                                                                                                                                                                                                    | 110    |

### Create — tests (3 files) and docs (1)

| Path                                | ~Lines |
| ----------------------------------- | ------ |
| `src/lib/lidarr/audit.test.ts`      | 340    |
| `src/actions/lidarr/audit.test.ts`  | 160    |
| `src/commands/lidarr-audit.test.ts` | 210    |
| `docs/features/lidarr-audit.md`     | 210    |

### Create — command (1 file)

| Path                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ~Lines |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `src/commands/lidarr-audit.ts` | DI factory `createLidarrAuditCommand(deps)`, `LidarrAuditCommandDeps`, `LidarrAuditJsonOutput`, `LIDARR_AUDIT_CSV_COLUMNS`, the local `parseAuditCheckIds` arg parser, pre-flight validation, the machine/human parity gate, the two stderr tables + deduped follow-up block, the multi-row CSV projection, and the `--fail-on` exit gate. Rendering stays inline: `lidarr-albums.ts` ships at 536 lines with rendering inline, and `lidarr-mutation-presenter.ts` exists only because two command modules share it — audit has one consumer. | 430    |

### Modify

| Path                                          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | ~Lines |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `src/actions/lidarr/index.ts`                 | Two lines after the `health.js` block (`:29-30`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 3      |
| `src/commands/lidarr.ts`                      | `import { createLidarrAuditCommand } from "./lidarr-audit.js";` after line 46; `lidarrCommand.addCommand(createLidarrAuditCommand({ resolveFormat, reportLidarrFailure, renderExecutionSummary, parseIdList }));` **between** the `health` (`:1435`) and `search` (`:1436`) registrations. `LidarrSuccessCommand` (`:387`), `LidarrSuccessActionResult` (`:394`), and `projectLidarrCsvSuccess` (`:409`) are **NOT** touched — audit owns its multi-row CSV.                                                                                                                                                                                                                               | 8      |
| `src/commands/lidarr.test.ts`                 | Insert `"audit"` after `"health"` in the pinned array at `:730-740`. Mandatory — the suite fails until done.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 1      |
| `src/lib/shell-completions/bash.ts`           | 4 edits: `lidarr_subcommands` at `:159` gains `audit` after `health`; `lidarr_audit_opts="--check --deep --artist-ids --fail-on --plex-url --plex-token -v --verbose"` plus `lidarr_audit_checks` and `lidarr_audit_fail_levels="none info warning critical"` near `:160-181`; a **dedicated guarded** word-scanner arm after the `albums)` arm at `:203-208` (first-match-wins — `audit` must appear in exactly one arm); a dispatch arm after the `health` branch (`:525-530`) handling `--check`/`--fail-on` via `$prev` then `"$lidarr_audit_opts $lidarr_shared_opts $global_opts"`. Do NOT reuse `$lidarr_search_opts` (`templates.spec.ts:494-496` pins its occurrence count at 2). | 25     |
| `src/lib/shell-completions/zsh.ts`            | 2 edits: `'audit:Audit Lidarr library health and drift'` after the `health` entry in `lidarr_subcmds` (`:404-418`); a new flat `audit)` `_arguments` case placed **after `health)` and before `search)`** — verified the only safe slot, since `templates.spec.ts` slices only `status→list`, `list→wanted`, `wanted→health`. Repeatable/enumerated flags use `'*--check[…]:check:(…)'`; block ends with `${globalOpts}`.                                                                                                                                                                                                                                                                  | 14     |
| `src/lib/shell-completions/fish.ts`           | 3 edits: `__fish_rfmedia_lidarr_audit_active` predicate copied from the `health` shape at `:1139-1147`; advertisement line inserted after `:1292`; a `# Lidarr audit options` block near `:1345` where every value-taking flag carries `-r` and enumerated flags carry `-xa`. Descriptions byte-identical to zsh.                                                                                                                                                                                                                                                                                                                                                                          | 22     |
| `src/lib/shell-completions/templates.spec.ts` | `lidarrCommandTree.lidarr` at `:41-44` gains `"audit"` at index 5 (asserted 3×); a `lidarrAuditOptions` const near `:60`; an exact-option lock test modelled on `:541-567`; an `__fish_rfmedia_lidarr_audit_active` entry in the value-option map at `:787-901`; a negative `--allow-stale` assertion in the parity test at `:1079-1112`.                                                                                                                                                                                                                                                                                                                                                  | 45     |
| `README.md` (package)                         | `### Lidarr Library Health Audit` under `## Development`, between `### Lidarr Albums` (`:4947`) and `### Lidarr Mutation Plan/Apply` (`:4975`), ending with the conventional `See [Lidarr Library Health Audit](docs/features/lidarr-audit.md) …` pointer; plus one `## Features` bullet.                                                                                                                                                                                                                                                                                                                                                                                                  | 50     |
| `../../docs/README.md` (repo)                 | One bullet in the Lidarr feature-doc list at `:88-94`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 2      |
| `CHANGELOG.md`                                | `## [Unreleased] / ### Added` bullet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 4      |
| `../../ROADMAP.md`                            | Three coordinated updates: Current focus (`:33-35`), Sprint 1 table (`:44-54`), layer diagram + Phase B table (`:190-202`); refresh `**Open issues:**` and `**Last updated:**`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 10     |

**Total: 9 new production files.** The issue says "Medium, 3-5". The overrun is accounted for by the ~500-line soft cap (the checks split), the mandatory ESM-cycle avoidance (the sibling command module), and the isolated Plex slot. Compressible seams if reviewers object, in order: merge `audit-identity.ts` into `audit-library-checks.ts` (−1, pushes it to ~360); merge `audit-queue.ts` into `audit.ts` (−1, but mixes pure engine with DB I/O — not recommended).

---

## 5. CLI contract

### Command

`rfmedia lidarr audit [options]` — `"Audit Lidarr library health and drift"`

Registered at index 5, between `health` and `search`. New pinned order in all four places:

```
["status", "list", "albums", "wanted", "health", "audit", "search", "lookup", "plan", "apply"]
```

### Flags

| Flag                     | helpGroup     | Type / parser                                                                                                                            | Default |
| ------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `--check <ids>`          | `Selection:`  | local `parseAuditCheckIds` — comma list validated against `LIDARR_AUDIT_CHECK_IDS`, throws `InvalidArgumentError` listing every valid id | all 8   |
| `--deep`                 | `Selection:`  | boolean                                                                                                                                  | `false` |
| `--artist-ids <ids>`     | `Selection:`  | `deps.parseIdList("Artist", value)`                                                                                                      | —       |
| `--fail-on <level>`      | `Safety:`     | `.choices(["none","info","warning","critical"])`                                                                                         | `none`  |
| `-v, --verbose`          | `Output:`     | boolean                                                                                                                                  | `false` |
| `--lidarr-url <url>`     | `Connection:` | bare `.option()`, description verbatim `"Lidarr base URL (overrides config)"`                                                            | config  |
| `--lidarr-api-key <key>` | `Connection:` | bare `.option()`, `"Lidarr API key (overrides config)"`                                                                                  | config  |
| `--plex-url <url>`       | `Connection:` | bare `.option()`, `"Plex server URL (overrides config)"`                                                                                 | config  |
| `--plex-token <token>`   | `Connection:` | bare `.option()`, `"Plex API token (overrides config)"`                                                                                  | config  |

**Deliberately absent, with reasons:**

- `--severity` — a display floor that mutates counts and `status` makes a check report `pass` while drift exists, on a command whose purpose is CI assertion. Dropped entirely. `jq` covers humans; `--fail-on` covers CI.
- `--allow-stale` — no cache category exists, an audit served from cache is actively misleading (the `lidarr-albums.ts:429-431` rationale), and adding it would break the parity test at `templates.spec.ts:1079-1112`.
- `--type`, `--types`, `--limit`, `--max-batch` — the bash global `case "$prev"` arms at `bash.ts:251-408` `return` **before** the per-leaf dispatch, and `--type` maps unconditionally to `$lidarr_health_types` whenever `$cmd == "lidarr"`. These names can never be used on a `lidarr` leaf.
- `--plex-library` — resolved from `plex.libraryName` config; a flag would cost one more entry in three hand-written templates plus the spec lock.
- Scheduler-tuning flags — forbidden in any generated script by `templates.spec.ts:903-910`.

### Pre-flight validation (before the lazy action import, inside `try`)

All three throw inside the `try` block so they flow through `deps.reportLidarrFailure` and produce both the machine failure envelope and exit 1:

1. `--artist-ids` without `--deep` → `new MissingRequiredArgumentError("--artist-ids requires --deep", "lidarr audit")`.
2. `resolveLidarrAuditSelection(check)` → `MissingRequiredArgumentError` on an unknown id.
3. A `--fail-on` level that no selected check can ever reach (max of `descriptor.maxSeverity` over the selection is below the gate) → `new OptionConflictError("--fail-on", "--check", "no selected check can emit <level>")`. Prevents a silently dead CI gate.

### Output

**Machine → stdout via `formatOutput`.** json/yaml: `{ command: "lidarr-audit", result }`. csv: `await formatOutput("csv", projectAuditCsv(result), { columns: [...LIDARR_AUDIT_CSV_COLUMNS] })` — `[summary, ...checkRows, ...findingRows]` discriminated by `rowType`; `finding.subjects` and `finding.evidence` are single JSON-encoded cells, every other value is scalar.

**Human → stderr only** (`console.error` + `console-table-printer` + `picocolors`), in order:

1. Header: `Lidarr Library Audit` · `Origin: <origin> · Depth: library|deep · <checkedAt>` · `Coverage: N artists · M albums · wanted backlog K`.
2. Checks table (`Check | Status | Findings | Note`) — always rendered when any check was skipped or errored; suppressed entirely when every check passed.
3. Findings table (`Severity | Check | Affected | Summary`), sorted critical→warning→info then by registry order, truncated to 20 rows unless `-v`.
4. `Suggested follow-up` block — deduplicated by `remediation.command`, capped at 10, each with its `docUrl` on a continuation line.
5. Degradation line(s), one yellow line per `data-unavailable`/`check-error` — omitted when empty (`renderHealthResilienceBlock` precedent at `lidarr.ts:780-784`).
6. Gate line, only when `--fail-on` is set: `Audit gate: PASSED|FAILED (--fail-on <level>; highest severity <x>)`.
7. `deps.renderExecutionSummary(result.execution)`.

Quiet-when-clean: with `status === "clean"` and no skips, only the header, one green `No findings across N checks.` line, and the execution summary print. When album checks skipped for `requires-deep`, the human output prints `Run with --deep for album-level checks.`

### Exit codes

| Situation                                                                   | `process.exitCode`                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------- |
| Success, `--fail-on none` (default) — even with critical findings           | untouched (0)                                        |
| Success, findings reach the `--fail-on` level                               | `1`                                                  |
| Success, `report.status === "degraded"` **and** `--fail-on` is not `none`   | `1` — an incomplete report must not read green in CI |
| Success, findings below the gate and not degraded                           | untouched (0)                                        |
| Pre-flight validation error                                                 | `1` via `reportLidarrFailure`                        |
| Lidarr client unresolvable / non-transport read failure / partial deep scan | `1` via `reportLidarrFailure`                        |

`process.exit()` is never called. The gate is applied after rendering:

```ts
if (shouldFailLidarrAudit(result.report, failOn)) {
  process.exitCode = 1;
}
```

Failure path: `await deps.reportLidarrFailure("audit", error, { staleHint: false, format, sensitiveValues: [cmdOptions["lidarrApiKey"], cmdOptions["plexToken"]] })`. **`plexToken` is new** — audit is the first Lidarr leaf carrying a Plex credential, and omitting it would leak a token into machine failure output.

---

## 6. Error / resilience behavior

**Fetch-plan first.** The action computes `required ∪ enriched` over the _selected_ checks. `albums` is dropped from the plan when `--deep` is off; `plex` is dropped when credentials are absent; `plexIdentity` is always absent. Every requirement not in the plan becomes an `unavailable` slot with an **expected** reason (`not-requested` / `requires-deep` / `plex-not-configured` / `identity-mapping-unavailable`) which never marks the report degraded. `--check retry-backlog` therefore issues zero HTTP requests, and `--check duplicate-identity` issues exactly two (health pre-check + `listArtists`).

**Lidarr unreachable.** Whenever _any_ Lidarr HTTP requirement is planned, the gather calls `runHealthProbe(client, signal)` first — it is both a data source and the reachability pre-check. Verified at `health.ts:122-137`: transport failures (`lidarr-unreachable`, `timeout`) return `{ status: "unreachable", … }` instead of throwing. On `unreachable` the action **skips** the remaining Lidarr reads and marks `artists`/`wanted`/`albums` `unavailable` with `data-unavailable` and the probe's reason. Consequence: `metadata-dependency` emits a `critical` `lidarr-unreachable` finding, `retry-backlog` still produces a full verdict from SQLite, `plex-connectivity` still runs, everything Lidarr-dependent reports `skipped/data-unavailable`, `report.status === "degraded"`, and — with `--fail-on` set — exit 1. Non-transport Lidarr failures (validation, auth, unexpected) propagate to `reportLidarrFailure` and exit 1 with the full taxonomy envelope, circuit-open retry-at line included.

**A single check throws.** The engine wraps every evaluator dispatch in `try/catch` and converts a throw into `{ status: "skipped", skipReason: "check-error", detail }`. Every other check still runs; `report.status` becomes `degraded`. This matters concretely because `noUncheckedIndexedAccess` makes each `artistsById.get(album.artistId)` a `T | undefined`, so a single missed guard is a `TypeError`.

**Metadata provider degraded.** `metadata-dependency` emits a `critical` finding per failing check, carrying each check's `wikiUrl` as `docUrl`. Nothing is blocked: the audit runs entirely on the `local-only` lane and never touches `api.lidarr.audio`, so no `ensureTierHealthy` gate applies.

**Tracking DB unreadable.** `collectLidarrAuditQueueState` never throws. Circuit rows degrade per scope to `{ state: "unknown", reason }` (isolated so one malformed row cannot poison the other) and surface as an `info` finding quoting the reason verbatim. If `listDeferredIntents` throws on a malformed row, only the age/overdue/near-exhaustion detail is lost — `detailUnavailableReason` is set and the counts from `countDeferredIntentsByStatus` remain valid. The `queue` slot itself stays `available`, so `retry-backlog` still produces a verdict and the report is not degraded.

**Deep scan fails closed.** `scanSelectedArtists` throws `LidarrPlanValidationError` on any failed or skipped batch task, including `failureType: "budget-exhausted"` past the `local-only` lane's `operationBudget: 1000`. That error **propagates** to `reportLidarrFailure` → exit 1. It is deliberately not degraded to a partial `albums` slot: a partial artist/album set fabricates duplicate-identity groups and gap findings, and a wrong audit is worse than a failed one. The failure text and `docs/features/lidarr-audit.md` must name **both** escape hatches explicitly: `--artist-ids` scoping, and the `lidarr.scheduler.lanes.local-only.operationBudget` config override.

**Plex.** `probeLidarrAuditPlex` never throws. No credentials → `plex-not-configured` slot, adapter never constructed. `MediaServerError` → a `plex-connectivity` finding discriminated on `.code`, not on message text.

**Scheduling.** One `runSingle(TIER, { id: "lidarr-audit", operation: "lidarr audit", idempotent: true, run })` wraps the Lidarr HTTP gather; it always exists (zero-request when nothing Lidarr-backed is planned), so `execution` is deterministic. `scanSelectedArtists` schedules its own tasks and runs **outside** that task — nesting would have the outer task hold one of the lane's 8 concurrency slots while its own batch competes for the remaining 7 (`albums.ts:130-171` precedent). Deep mode therefore issues `listArtists()` twice (once in the gather, once inside the scan); this is documented and costs one request.

---

## 7. Test plan

Three new files. The rule: **exhaustively test the pure engine and evaluators; test the orchestration layers only where they encode a decision that lives nowhere else.** Nothing is written for pass-through code.

Repo lifecycle rules apply: mocks via `vi.hoisted()` before `vi.mock()` factories, SUT imported after all mocks, `vi.clearAllMocks()` in `beforeEach` (`vi.resetAllMocks()` is banned — it nulls hoisted implementations).

### 1. `src/lib/lidarr/audit.test.ts` — the whole of the new logic

Pure data in, pure report out; no mocks. Fixtures from `createLidarrArtistFixture`, `createLidarrAlbumFixture`, `createLidarrHealthCheckFixture` (`src/actions/test-helpers/lidarr-fixtures.ts`). Justified because every bug here becomes _wrong operator advice_, which is worse than no advice.

- **Registry integrity** — ids unique, kebab-case, and every id present in `LIDARR_AUDIT_CHECK_DESCRIPTORS`. Guards the `--check` choices, three shell templates, and `templates.spec.ts` from drifting apart.
- **Requirement gating** — a check whose `requires` includes an unavailable slot reports `skipped` with _that slot's_ reason and detail; an `enriches` slot being unavailable does NOT gate.
- **`plex-alignment` always skips** with `identity-mapping-unavailable` even when the `plex` slot is available. The #208 regression guard, and the single most important test in the feature.
- **Per-check error isolation** — a throwing evaluator yields `skipped/check-error` for that check only; every other check still runs; `report.status === "degraded"`.
- **Status precedence** — expected absences (`requires-deep`, `plex-not-configured`, `not-selected`) never degrade; `data-unavailable` and `check-error` always do.
- **`shouldFailLidarrAudit`** — the full matrix across `none|info|warning|critical` × clean/findings/degraded.
- **`resolveLidarrAuditSelection`** rejects an unknown id; **`resolveLidarrAuditRequirements`** returns the correct hard/soft split for representative selections.
- **Subject capping** — 25 affected artists → `subjects.length === 10`, `affected === 25`.
- **Per-check correctness**, one positive + one negative each, plus these specific traps that would otherwise ship broken:
  - `groupDuplicates` with a `keyOf` returning `undefined` never groups those members (the `path` / `foreignAlbumId` optionality trap).
  - `foldArtistName` collapses case, **diacritics** ("Björk" ≡ "Bjork" — asserts the NFKD step `normalizeForMatch` does not provide), punctuation, and a leading article; two artists with equal folded names but distinct MBIDs produce `info`, not `critical`.
  - `normalizeArtistPath` collapses trailing/duplicate separators but is **case-sensitive** — `/music/Artist` and `/music/artist` do NOT collide.
  - An album or artist with absent `statistics` counts as zero files, never as "has files".
  - A monitored album with a **future** `releaseDate` is not a gap.
  - `operation-safety` does not re-report checks already claimed by `detectMetadataProviderOutage`.
  - The `LidarrHealthType → LidarrAuditSeverity` map is total for all four wire values.
  - `wikiUrl` reaches `remediation.docUrl` unmodified.
  - `retry-backlog` surfaces `{ state: "unknown", reason }` as an `info` finding quoting the reason, and `detailUnavailableReason` as an `info` finding — never as healthy.
  - Plex probe union → finding mapping for `reachable: false`, zero libraries, unresolved library name.
- **Non-mutating remediation invariant** — a regex over every finding emitted by every evaluator across all fixtures fails if any `remediation.command` matches `lidarr apply` or a `*-delete` plan verb. This is the guard that keeps the audit from ever handing an operator a destructive one-liner, and it enforces ROADMAP.md's own framing of #211.

### 2. `src/actions/lidarr/audit.test.ts` — the cost and safety contract only

Barrel-mock pattern from `src/actions/lidarr/health.test.ts:12-36` (`vi.hoisted` + pass-through `runSingle` stub + `createLidarrClientMock()`), plus mocks for `./album-scan.js`, `./audit-plex.js`, `../../lib/lidarr/health.js`, `../../lib/lidarr/audit-queue.js`, `../../lib/loaded-config.js`.

- Scheduler called with `("local-only", objectContaining({ id: "lidarr-audit", idempotent: true }))`, and overrides reach `resolveRequiredLidarrClient` as `(objectContaining({ lidarrUrl, lidarrApiKey }), objectContaining({ tier: "local-only", retryAttemptsOverride: 0 }))`.
- **`--check retry-backlog` invokes neither `scanSelectedArtists` nor `client.listArtists` nor `runHealthProbe`.** Without this a later edit silently turns every audit into a 1 + N library walk against a 1000-op lane budget.
- **`--check monitoring-drift` without `--deep`** yields an `albums` slot of `requires-deep` and performs no scan.
- **A rejecting `scanSelectedArtists` propagates** (fail-closed) rather than degrading — the inverse of the usual degradation rule, and it lives only here.
- **`runHealthProbe` returning `status: "unreachable"`** produces `data-unavailable` slots for `artists`/`wanted` and issues no further Lidarr reads.
- **Absent Plex credentials** yield a `plex-not-configured` slot with no adapter construction.
- **Secret leak guard** — `expect(inspect(result)).not.toContain("secret-api-key")` and the same for a Plex token (`health.test.ts:752` precedent, extended for the new credential).

### 3. `src/commands/lidarr-audit.test.ts` — the operator/CI contract

Built on the `rootCommand` harness from `src/commands/lidarr.test.ts:685-699` — mandatory, because `resolveFormat()` reads `lidarrCommand.parent?.opts()` and a naive standalone parse silently degrades to `"text"`. Mocks `../actions/lidarr/index.js` and `../lib/formatters/index.js`; `afterEach` resets `process.exitCode = undefined`.

- **Exit-code matrix**: default run with a critical finding leaves `process.exitCode` undefined (the report-not-gate contract, mirroring `lidarr.test.ts:1947`); `--fail-on warning` with a critical finding sets 1; `--fail-on critical` with only warnings does not; `--fail-on warning` with a `degraded` report sets 1; `--fail-on none` never sets it.
- `--output json` calls `formatOutput` with exactly `{ command: "lidarr-audit", result }`, and the `console.log` spy records nothing (stdout purity, `lidarr.test.ts:678-683`).
- `--output csv` calls `formatOutput` with `{ columns: [...LIDARR_AUDIT_CSV_COLUMNS] }` and rows in `summary` → `check` → `finding` order.
- Pre-flight failures produce the failure envelope + exit 1 **before** the action mock is called: unknown `--check` id, `--artist-ids` without `--deep`, and the dead-gate `--fail-on`/`--check` conflict.
- API key and Plex token are absent from failure output.

### 4–5. Mandatory updates to existing suites (not new tests)

- `src/commands/lidarr.test.ts:730-740` — insert `"audit"` after `"health"`.
- `src/lib/shell-completions/templates.spec.ts` — `lidarrCommandTree.lidarr`, the `lidarrAuditOptions` exact-option lock, the Fish value-option map entry, the `--allow-stale` negative assertion.

### Deliberately NOT written

No standalone `audit-identity.test.ts` (covered through the checks that consume it). No `audit-queue.test.ts` against a real SQLite file — the DB recipe it copies is already covered by `src/lib/lidarr/health.test.ts:558-759`, and its degrade-don't-throw behavior is asserted through the injected slot in file 1. No `audit-plex.test.ts` — it is a thin `MediaServerError`→union mapping whose consequences are asserted in file 1. No renderer snapshot tests. No duplication of the existing subcommand-order assertion.

### Verification commands

```bash
cd packages/rfmedia-cli
env -u FORCE_COLOR npx vitest run \
  src/lib/lidarr/audit.test.ts \
  src/actions/lidarr/audit.test.ts \
  src/commands/lidarr-audit.test.ts \
  src/commands/lidarr.test.ts \
  src/lib/shell-completions/templates.spec.ts

# repo root — pretypecheck chains codegen:lidarr:check + check:architecture + test:architecture
npm run typecheck --workspace packages/rfmedia-cli   # read the TOP of the output
npm run check:architecture -w packages/rfmedia-cli
env -u FORCE_COLOR npm run test:run
npm run lint:md && npm run format:all
```

`FORCE_COLOR` is exported in the agent shell; it breaks two rf-common logger tests and blocks `git push` via the pre-push hook.

### Architecture-gate landmines to respect while implementing

- The literal `fetch(` or `trustedFetch(` **anywhere in a new production `.ts`, including JSDoc and plain comments**, is a `plex-fetch-owner` violation — the regex at `scripts/check-direct-plex-imports.mjs:543` runs over raw file content. Write "HTTP request" / "round-trip" / "retrieve". Nine new files are nine chances to trip this.
- No string literal containing `/api/v1/` (`handwritten-lidarr-api-path`).
- No import of `src/types/plex`, `src/lib/adapters/plex/*`, `src/lib/plex`, or `src/lib/plex-cache`. Plex speaks only `src/lib/adapters/action-helpers.js` + `src/types/media-server.js`. (`packages/rfmedia-cli/CLAUDE.md:1119-1178` still documents the deleted modules — trust the gate, not the doc.)
- Never place key `artistIds` alongside any of `{tags, applyTags, deleteFiles, metadataProfileId, moveFiles, qualityProfileId, rootFolderPath, addImportListExclusion}` in one object literal (`lidarr-editor-body-owner` is a purely structural check). `LidarrAuditActionOptions.artistIds` is safe today; finding subjects use singular `artistId` by design.
- `noPropertyAccessFromIndexSignature` — every Commander option read is `cmdOptions["failOn"] as string | undefined`.

---

## 8. Non-goals

1. **No mutation, ever.** No `--apply`, no auto-remediation, no artifact writing, no cache population, no scan trigger. `remediation.command` is always a read command or a `lidarr plan …` artifact command, test-enforced.
2. **No Plex↔Lidarr identity join.** No fuzzy title matching, no `--plex-match-threshold`, no cross-service caching. `plex-alignment` is a reserved, evaluator-less slot until #207/#208.
3. **No new `LidarrClientApi` methods and no codegen change.** Cutoff-unmet, root folders, disk space, queue, history, and track files stay out of scope (§2 deferred table).
4. **No `--severity` display filter.** A status field that reports `pass` while drift exists is disqualifying on a command built for CI assertion.
5. **No new exit codes.** 1 is this repo's only failure code; `summary.highestSeverity` is how CI distinguishes gate-tripped from Lidarr-down.
6. **No changes to `LidarrSuccessCommand`, `LidarrSuccessActionResult`, or `projectLidarrCsvSuccess`.** The audit ships its own multi-row CSV; the shared flat projection would collapse the findings array into one opaque cell.
7. **No registration in `src/lib/lidarr/index.ts`.** The barrel re-exports lib modules with `export *`; adding audit would create the exact static-cycle hazard that forced `LidarrClientOverrides` to be duplicated at `health.ts:301`.
8. **No MCP tool registration.** `src/mcp/*` contains zero Lidarr references today, and `schema.ts`/`adapters.ts` are on the Plex compatibility allowlist — touching them widens blast radius for no requested benefit.
9. **No full wanted/missing traversal.** One `pageSize: 1` request for `totalRecords`; the backlog view stays `rfmedia lidarr wanted`.
10. **No graceful partial deep scan.** `scanSelectedArtists` stays fail-closed; large libraries get an explicit failure naming `--artist-ids` and the lane-budget override, not a silently reduced report.
11. **No `docs/features/shell-completion.md` edit** — that file documents the **rfapps** CLI, not rfmedia.
