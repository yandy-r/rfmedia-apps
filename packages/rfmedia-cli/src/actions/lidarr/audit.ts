/**
 * `rfmedia lidarr audit` action — the read-only library health audit (issue #211).
 *
 * This module owns every byte of I/O the feature performs, and nothing else. It
 * turns the SELECTED checks into a gather plan through the registry's
 * `requires` / `enriches` lists, materialises one {@link LidarrAuditSlot} per
 * requirement, and hands the result to the pure engine in
 * `../../lib/lidarr/audit.js`. Because the plan is derived from the selection,
 * `--check retry-backlog` costs zero Lidarr round-trips and
 * `--check duplicate-identity` costs exactly two (health probe + artist list).
 *
 * Strictly non-mutating: no writes, no artifacts, no cache population. Findings
 * never fail this call either — the command layer owns exit behavior, so a CI
 * gate stays an explicit opt-in.
 *
 * Two scheduling rules matter here:
 *
 * 1. Exactly ONE `runSingle` task wraps the Lidarr HTTP gather, and it always
 *    exists even when nothing Lidarr-backed is planned, so `execution` metadata
 *    is deterministic for every invocation.
 * 2. The deep album scan, the tracking-database read, and the Plex probe run
 *    OUTSIDE that task. Nesting the scan would make the outer task hold one of
 *    the `local-only` lane's concurrency slots while its own batch competes for
 *    the rest (the `./albums.js` precedent).
 */

import { LidarrPlanValidationError } from "../../lib/errors.js";
import {
  resolveLidarrAuditRequirements,
  resolveLidarrAuditSelection,
  runLidarrAudit,
} from "../../lib/lidarr/audit.js";
import { collectLidarrAuditQueueState } from "../../lib/lidarr/audit-queue.js";
import { LidarrValidationError } from "../../lib/lidarr/errors.js";
import { isTransportOutage, runHealthProbe } from "../../lib/lidarr/health.js";
import {
  resolveLidarrScheduler,
  resolveRequiredLidarrClient,
  resolveRequiredLidarrOrigin,
} from "../../lib/lidarr/index.js";
import { logDebug, logInfo } from "../../lib/logger.js";
import { LIDARR_AUDIT_UNREACHABLE_DETAIL } from "../../types/lidarr-audit.js";
import { scanSelectedArtists, type AlbumScanTaskOptions } from "./album-scan.js";
import { probeLidarrAuditPlex } from "./audit-plex.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import type { LidarrHealthReport } from "../../lib/lidarr/health.js";
import type { LidarrExecutionSuccessMetadata } from "../../lib/lidarr/scheduler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import type { LidarrArtist } from "../../types/lidarr.js";
import type {
  LidarrAuditAlbumData,
  LidarrAuditCheckId,
  LidarrAuditGatheredData,
  LidarrAuditPlexProbe,
  LidarrAuditQueueState,
  LidarrAuditReport,
  LidarrAuditRequirement,
  LidarrAuditSlot,
  LidarrAuditUnavailableReason,
} from "../../types/lidarr-audit.js";

/** Reliability tier for `audit`. Local reads only; never contacts api.lidarr.audio. */
export const TIER: LidarrTier = "local-only";

/** Scheduler task naming for this action's deep album scan. */
const ALBUM_SCAN_TASK_OPTIONS: AlbumScanTaskOptions = {
  taskIdPrefix: "lidarr-audit-albums",
  operationLabel: "lidarr audit album scan",
};

/** Human label per requirement, used to explain an ungathered slot. */
const REQUIREMENT_LABELS: Readonly<Record<LidarrAuditRequirement, string>> = Object.freeze({
  health: "the Lidarr health probe",
  artists: "the Lidarr artist list",
  wanted: "the Lidarr wanted/missing backlog",
  albums: "the per-artist album scan",
  queue: "the deferred-intent queue state",
  plex: "the Plex probe",
  plexIdentity: "the Plex-Lidarr identity mapping",
});

/** `detail` for the `albums` slot when a selected check wants it but `--deep` is off. */
const REQUIRES_DEEP_DETAIL =
  "the per-artist album scan runs only with --deep (1 + N Lidarr round-trips)";

/** `detail` for the permanently reserved identity-mapping slot. */
const IDENTITY_MAPPING_DETAIL =
  "Use `rfmedia lidarr reconcile` for Plex-Lidarr alignment; this audit check remains reserved";

/** Operation label carried by failures this action raises itself. */
const DEEP_SCAN_OPERATION = "lidarr audit deep scan";

/**
 * Detail prefix of the batch-completion failure `scanSelectedArtists` raises
 * when the per-artist album batch does not finish (`./album-scan.js`).
 *
 * That is the ONLY scan failure the scope/budget hint fits. The scan's other
 * rejection — unknown `--artist-ids` — is raised BEFORE any batch runs, so
 * advising the operator to narrow the very flag that failed, and to raise a
 * budget nothing reached, would be actively misleading. Matching the prefix
 * (rather than the error type) keeps every unrecognised failure unwrapped.
 */
const SCAN_INCOMPLETE_DETAIL_PREFIX = "album listing did not complete";

/** Options for the `lidarr audit` action. */
export interface LidarrAuditActionOptions {
  /** Raw `--check` values; `undefined` selects every registered check. */
  readonly check?: readonly string[];
  /** Enables the 1 + N per-artist album scan. */
  readonly deep?: boolean;
  /** Scopes the deep scan; the command rejects it without `--deep`. */
  readonly artistIds?: readonly number[];
  /** `--lidarr-url` override for the configured base URL. */
  readonly lidarrUrl?: string;
  /** `--lidarr-api-key` override for the configured API key. */
  readonly lidarrApiKey?: string;
  /** `--plex-url` override for the configured media-server URL. */
  readonly plexUrl?: string;
  /** `--plex-token` override for the configured media-server token. */
  readonly plexToken?: string;
}

/** Result of the `lidarr audit` action. */
export interface LidarrAuditActionResult {
  /** Execution-lane metadata for the single scheduled Lidarr gather. */
  readonly execution: LidarrExecutionSuccessMetadata;
  /** The frozen audit report. */
  readonly report: LidarrAuditReport;
}

/**
 * Which data sources this run will actually gather.
 *
 * Derived once from the selection so the same decision drives both the I/O and
 * every slot's absence reason; there is no second capability list to drift.
 */
interface LidarrAuditGatherPlan {
  /** A selected check names `health`. */
  readonly health: boolean;
  /** A selected check names `artists`. */
  readonly artists: boolean;
  /** A selected check names `wanted`. */
  readonly wanted: boolean;
  /** A selected check names `albums`, whether or not `--deep` was passed. */
  readonly albumsRequested: boolean;
  /** The deep album scan will run: `albumsRequested` AND `--deep`. */
  readonly albums: boolean;
  /** A selected check names `queue`. */
  readonly queue: boolean;
  /** A selected check names `plex`. */
  readonly plex: boolean;
  /** At least one Lidarr HTTP read is planned, so the health probe must run. */
  readonly lidarrRead: boolean;
}

/** What the single scheduled Lidarr gather produced. */
interface LidarrAuditLidarrGather {
  /** Available whenever the probe ran, INCLUDING when it reports `unreachable`. */
  readonly health: LidarrAuditSlot<LidarrHealthReport>;
  /** Library-wide artist list. */
  readonly artists: LidarrAuditSlot<readonly LidarrArtist[]>;
  /** Library-wide wanted/missing total. */
  readonly wanted: LidarrAuditSlot<{ readonly total: number }>;
  /**
   * The resolved client, present only when a Lidarr read was planned AND the
   * instance answered the probe. Its absence is what stops the deep scan.
   */
  readonly client?: LidarrClientApi;
}

/**
 * Wraps gathered data in an `available` slot.
 *
 * @param data - The gathered payload.
 * @returns The frozen slot.
 */
function availableSlot<T>(data: T): LidarrAuditSlot<T> {
  const slot: LidarrAuditSlot<T> = { status: "available", data };
  return Object.freeze(slot);
}

/**
 * Builds an `unavailable` slot carrying its own machine-readable reason.
 *
 * @param reason - Why the data is absent; only `"data-unavailable"` degrades
 *   the report.
 * @param detail - Operator-facing explanation, echoed verbatim by every check
 *   the missing slot gates.
 * @returns The frozen slot.
 */
function unavailableSlot(
  reason: LidarrAuditUnavailableReason,
  detail: string,
): LidarrAuditSlot<never> {
  const slot: LidarrAuditSlot<never> = { status: "unavailable", reason, detail };
  return Object.freeze(slot);
}

/**
 * Builds the slot for a requirement no selected check asked for.
 *
 * @param requirement - The ungathered requirement.
 * @returns The frozen `not-requested` slot.
 */
function notRequestedSlot(requirement: LidarrAuditRequirement): LidarrAuditSlot<never> {
  return unavailableSlot(
    "not-requested",
    `${REQUIREMENT_LABELS[requirement]} was not gathered: no selected check needs it`,
  );
}

/**
 * Builds the `detail` for a slot whose OWN Lidarr read failed at the transport
 * level after the health probe had already succeeded.
 *
 * Deliberately distinct from {@link LIDARR_AUDIT_UNREACHABLE_DETAIL}, which
 * documents the slots abandoned because the PROBE came back unreachable:
 * blaming the probe here would send the operator to an endpoint that answered.
 *
 * @param requirement - The requirement whose read failed.
 * @returns The operator-facing explanation for the degraded slot.
 */
function readFailureDetail(requirement: LidarrAuditRequirement): string {
  return (
    `${REQUIREMENT_LABELS[requirement]} could not be read: the request failed at the ` +
    "transport level after Lidarr answered the health probe"
  );
}

/**
 * The reserved identity-mapping slot: a compile-time constant absence.
 *
 * Audit does not independently gather or project identity evidence.
 * `plex-alignment` reads its skip reason from this slot and from the `plex`
 * slot, while its detail directs operators to the reconciliation command.
 */
const PLEX_IDENTITY_SLOT: LidarrAuditSlot<never> = unavailableSlot(
  "identity-mapping-unavailable",
  IDENTITY_MAPPING_DETAIL,
);

/**
 * Turns a selection into the gather plan.
 *
 * `enriches` entries are gathered exactly like `requires` entries — the
 * difference is that they never gate a check — so both sets feed the plan.
 * `plexIdentity` deliberately has no plan entry.
 *
 * @param selected - Selected check ids, already validated.
 * @param deep - Whether `--deep` was passed.
 * @returns The frozen plan.
 */
function planLidarrAuditGather(
  selected: readonly LidarrAuditCheckId[],
  deep: boolean,
): LidarrAuditGatherPlan {
  const { required, enriched } = resolveLidarrAuditRequirements(selected);
  const wants = (requirement: LidarrAuditRequirement): boolean =>
    required.has(requirement) || enriched.has(requirement);

  const health = wants("health");
  const artists = wants("artists");
  const wanted = wants("wanted");
  const albumsRequested = wants("albums");
  const albums = albumsRequested && deep;

  const plan: LidarrAuditGatherPlan = {
    health,
    artists,
    wanted,
    albumsRequested,
    albums,
    queue: wants("queue"),
    plex: wants("plex"),
    lidarrRead: health || artists || wanted || albums,
  };
  return Object.freeze(plan);
}

/**
 * Performs one planned Lidarr read, degrading TRANSPORT failures into a
 * `data-unavailable` slot instead of aborting the whole audit.
 *
 * The health probe absorbs the transport failures it observes itself, but a
 * library-scale read issued after it can still time out (the artist list on a
 * large library is the realistic case). Losing the entire report — including
 * the verdicts that never needed this slot — over one slow endpoint would
 * contradict the degradation contract on {@link executeLidarrAudit}, so only
 * the transport codes degrade; every other failure class still propagates.
 *
 * @param requirement - The requirement this read fills.
 * @param read - The read to perform.
 * @returns An `available` slot, or a `data-unavailable` slot on transport failure.
 * @throws {LidarrError} On any non-transport Lidarr failure.
 */
async function readDegradableSlot<T>(
  requirement: LidarrAuditRequirement,
  read: () => Promise<T>,
): Promise<LidarrAuditSlot<T>> {
  try {
    return availableSlot(await read());
  } catch (error) {
    if (!isTransportOutage(error)) {
      throw error;
    }
    const detail = readFailureDetail(requirement);
    logInfo(`Lidarr audit: ${detail}`);
    return unavailableSlot("data-unavailable", detail);
  }
}

/**
 * Performs the single scheduled Lidarr gather.
 *
 * The health probe runs FIRST whenever any Lidarr read is planned, because it
 * doubles as the reachability pre-check: transport failures surface as
 * `status: "unreachable"` instead of throwing. On `unreachable` no further
 * Lidarr read is issued and the dependent slots become `data-unavailable`, but
 * the `health` slot stays AVAILABLE — that report is the evidence
 * `metadata-dependency` needs to emit its `lidarr-unreachable` finding, and
 * gating it out would produce a degraded report with no explanation in it.
 *
 * The health slot is available whenever the probe ran, even when no selected
 * check named `health`: the probe is mandatory, so reporting `not-requested`
 * for data already in hand would be a lie.
 *
 * The reads issued after the probe degrade their own slot on a transport
 * failure through {@link readDegradableSlot}; nothing here aborts the audit for
 * a reason the report could have carried.
 *
 * @param options - Action options carrying the connection overrides.
 * @param plan - The gather plan for this run.
 * @returns The three Lidarr-backed slots plus the resolved client.
 * @throws {LidarrValidationError} When the client cannot be resolved.
 * @throws {LidarrError} On any non-transport Lidarr failure.
 */
async function gatherLidarrData(
  options: LidarrAuditActionOptions,
  plan: LidarrAuditGatherPlan,
): Promise<LidarrAuditLidarrGather> {
  if (!plan.lidarrRead) {
    logDebug("lidarr audit: no Lidarr data source selected; issuing zero requests");
    return {
      health: notRequestedSlot("health"),
      artists: notRequestedSlot("artists"),
      wanted: notRequestedSlot("wanted"),
    };
  }

  // Resolved HERE rather than before scheduling so a configuration failure is
  // captured inside the scheduler's execution-metadata envelope, exactly as
  // `lidarr health` does.
  const client = resolveRequiredLidarrClient(
    { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey },
    { tier: TIER, retryAttemptsOverride: 0 },
  );

  logDebug("lidarr audit: probing Lidarr health");
  const report = await runHealthProbe(client);
  if (report.status === "unreachable") {
    logInfo("Lidarr audit: Lidarr is unreachable; skipping every remaining Lidarr read");
    return {
      health: availableSlot(report),
      artists: unavailableSlot("data-unavailable", LIDARR_AUDIT_UNREACHABLE_DETAIL),
      wanted: unavailableSlot("data-unavailable", LIDARR_AUDIT_UNREACHABLE_DETAIL),
    };
  }

  let artists: LidarrAuditSlot<readonly LidarrArtist[]> = notRequestedSlot("artists");
  if (plan.artists) {
    logDebug("lidarr audit: reading the library-wide artist list");
    artists = await readDegradableSlot("artists", () => client.listArtists());
  }

  let wanted: LidarrAuditSlot<{ readonly total: number }> = notRequestedSlot("wanted");
  if (plan.wanted) {
    logDebug("lidarr audit: sampling the wanted/missing backlog total");
    wanted = await readDegradableSlot("wanted", async () => {
      const page = await client.getWantedMissing({ page: 1, pageSize: 1 });
      return { total: page.totalRecords };
    });
  }

  return { health: availableSlot(report), artists, wanted, client };
}

/**
 * Runs the fail-closed deep album scan and adapts it to the audit slot payload.
 *
 * The scan issues its OWN library-wide artist listing and returns only the
 * albums plus the names of the artists it visited, narrowed by `--artist-ids`.
 * Its artist data is deliberately NOT reused for the `artists` slot:
 * `operation-safety` and `duplicate-identity` reason over the whole library, so
 * a narrowed list would fabricate clean verdicts. Deep mode therefore costs one
 * extra artist listing, by design.
 *
 * The scan is shared with the album PLAN lane, so an incomplete batch arrives
 * as a {@link LidarrPlanValidationError} whose message is prefixed
 * `Invalid Lidarr plan: `. This command writes no plan, so that failure is
 * re-raised as a plan-free {@link LidarrValidationError} carrying the one hint
 * the scan itself cannot give: the lane budget override. Every other scan
 * rejection — above all the unknown-`--artist-ids` one, which fires before any
 * batch — propagates untouched.
 *
 * @param client - The resolved Lidarr client.
 * @param artistIds - Optional `--artist-ids` scope.
 * @returns The album payload for the `albums` slot.
 * @throws {LidarrValidationError} When the album batch does not complete. Deep
 *   mode is fail-closed on purpose: a partial artist/album set fabricates
 *   duplicate-identity groups and gap findings, and a wrong audit is worse than
 *   a failed one.
 * @throws {LidarrPlanValidationError} Unchanged, for every other scan rejection.
 */
async function scanAuditAlbums(
  client: LidarrClientApi,
  artistIds: readonly number[] | undefined,
): Promise<LidarrAuditAlbumData> {
  try {
    const scan = await scanSelectedArtists(client, artistIds, ALBUM_SCAN_TASK_OPTIONS);
    return {
      albums: scan.albums,
      artistNames: scan.artistNames,
      artistsScanned: scan.artistsScanned,
    };
  } catch (error) {
    if (
      error instanceof LidarrPlanValidationError &&
      error.detail.startsWith(SCAN_INCOMPLETE_DETAIL_PREFIX)
    ) {
      throw new LidarrValidationError(
        DEEP_SCAN_OPERATION,
        `${error.detail}, or raise lidarr.scheduler.lanes.local-only.operationBudget in config`,
      );
    }
    throw error;
  }
}

/**
 * Resolves the `albums` slot, deep scan included.
 *
 * @param plan - The gather plan for this run.
 * @param client - The resolved client, absent when Lidarr never answered.
 * @param artistIds - Optional `--artist-ids` scope.
 * @returns The `albums` slot.
 * @throws {LidarrValidationError} When a planned deep scan's album batch does
 *   not complete.
 * @throws {LidarrPlanValidationError} Unchanged, for every other scan rejection.
 */
async function gatherAuditAlbums(
  plan: LidarrAuditGatherPlan,
  client: LidarrClientApi | undefined,
  artistIds: readonly number[] | undefined,
): Promise<LidarrAuditSlot<LidarrAuditAlbumData>> {
  if (!plan.albumsRequested) {
    return notRequestedSlot("albums");
  }
  if (!plan.albums) {
    return unavailableSlot("requires-deep", REQUIRES_DEEP_DETAIL);
  }
  if (client === undefined) {
    return unavailableSlot("data-unavailable", LIDARR_AUDIT_UNREACHABLE_DETAIL);
  }
  logInfo("Lidarr audit: scanning albums per artist (--deep)");
  return availableSlot(await scanAuditAlbums(client, artistIds));
}

/**
 * Executes one read-only Lidarr library health audit.
 *
 * Gathers only what the SELECTED checks declare, assembles one slot per
 * requirement, and delegates every verdict to the pure engine. Diagnostic by
 * contract: findings never fail this call.
 *
 * @param options - Selection, depth, and connection overrides.
 * @returns The frozen report plus scheduler execution metadata.
 * @throws {LookupNotFoundError} On an unknown `--check` id.
 * @throws {LidarrValidationError} When the Lidarr connection cannot be
 *   resolved, or when a `--deep` album batch does not complete; the latter
 *   failure names both escape hatches.
 * @throws {LidarrError} When a planned Lidarr read fails for a non-transport
 *   reason (transport failures degrade the affected slot instead).
 * @throws {LidarrPlanValidationError} When the `--deep` scan rejects for any
 *   other reason, such as an unknown `--artist-ids` value.
 */
export async function executeLidarrAudit(
  options: LidarrAuditActionOptions,
): Promise<LidarrAuditActionResult> {
  const checkedAt = new Date().toISOString();
  const deep = options.deep === true;
  const selected = resolveLidarrAuditSelection(options.check);
  const plan = planLidarrAuditGather(selected, deep);

  // The origin is needed by the queue read before the scheduled task resolves a
  // client, so it is resolved up front; it carries no credentials.
  const overrides = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const origin = resolveRequiredLidarrOrigin(overrides);

  const scheduled = await resolveLidarrScheduler().runSingle(TIER, {
    id: "lidarr-audit",
    operation: "lidarr audit",
    idempotent: true,
    run: (): Promise<LidarrAuditLidarrGather> => gatherLidarrData(options, plan),
  });
  const lidarr = scheduled.value;

  // Everything below schedules its own tasks or performs no scheduling at all,
  // so it stays outside the task above.
  const albums = await gatherAuditAlbums(plan, lidarr.client, options.artistIds);

  let queue: LidarrAuditSlot<LidarrAuditQueueState> = notRequestedSlot("queue");
  if (plan.queue) {
    logDebug("lidarr audit: reading circuit state and the deferred-intent backlog");
    queue = availableSlot(await collectLidarrAuditQueueState(overrides, origin));
  }

  // The probe owns the credential readiness gate: it returns the
  // `plex-not-configured` slot itself rather than constructing an adapter.
  let plex: LidarrAuditSlot<LidarrAuditPlexProbe> = notRequestedSlot("plex");
  if (plan.plex) {
    plex = await probeLidarrAuditPlex({
      plexUrl: options.plexUrl,
      plexToken: options.plexToken,
    });
  }

  const gathered: LidarrAuditGatheredData = {
    health: lidarr.health,
    artists: lidarr.artists,
    wanted: lidarr.wanted,
    albums,
    queue,
    plex,
    plexIdentity: PLEX_IDENTITY_SLOT,
  };

  const report = runLidarrAudit({
    checkedAt,
    origin,
    deep,
    selected: new Set(selected),
    gathered,
  });
  logInfo(
    `Lidarr audit: ${report.status} — ${report.summary.total} finding(s), ` +
      `${report.summary.checksRun} check(s) run, ${report.summary.checksSkipped} skipped`,
  );

  return Object.freeze({
    execution: Object.freeze({ ...scheduled.execution }),
    report,
  });
}
