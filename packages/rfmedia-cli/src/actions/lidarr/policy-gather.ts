/**
 * Never-throw signal gatherers for `rfmedia lidarr policy evaluate` (issue #209,
 * design §8.1).
 *
 * This module is the ONLY impure edge of the policy flow: it is the single place
 * that resolves a Lidarr client or a media-server adapter and issues round trips.
 * Everything downstream (`src/lib/bridge/policy-*.ts`) is pure and consumes the
 * {@link PolicySignalBundle} slots produced here.
 *
 * Two properties are load-bearing and must survive any future edit:
 *
 * 1. **No gatherer ever throws.** A failed slot is DATA the engine degrades on,
 *    not an exception that kills the report. Every failure — a missing client
 *    configuration, a refused cross-origin credential, a transport error, a
 *    stalled page, an abort — is converted to an `unavailable` slot.
 * 2. **No gatherer ever truncates.** Exceeding a hard bound fails CLOSED with an
 *    `unavailable` slot. A truncated drain would understate play counts and push
 *    real, actively played artists toward an unmonitor proposal — a wrong report
 *    is worse than a missing one.
 *
 * Only the readiness-gate ordering, the adapter-inside-`try` placement, and the
 * raw-override forwarding are copied from `probeLidarrAuditPlex`
 * (`./audit-plex.ts`). Its failure branch is deliberately NOT copied: the audit
 * reports an outage as an *available* probe carrying `reachable: false`, because
 * reachability is the audit's finding. Here reachability is not a finding, it is
 * the absence of a signal, so the same failure becomes an `unavailable` slot.
 *
 * Raw payloads only. Index construction, name normalization, and coverage
 * arithmetic belong to `src/lib/bridge/policy-signals.ts`; performing any of it
 * here would give the impure layer an opinion the pure layer is meant to own.
 *
 * The `bridgeIdentity` slot is NOT gathered here. It is built by the action
 * (`./policy-evaluate.ts`) from `executeLidarrReconcile`, which owns the
 * database, the scheduler lane, and the offline-origin rules this module has no
 * business reproducing.
 *
 * Unavailable reasons emitted: `plex-not-configured` (the readiness gate) and
 * `data-unavailable` (everything else). `lidarr-unreachable` is deliberately not
 * minted: design §8.7 makes `data-unavailable` the reason that marks a report
 * `degraded`, and a Lidarr outage must degrade rather than read as an expected
 * absence.
 */

import { resolveRequiredMediaServerAdapter } from "../../lib/adapters/action-helpers.js";
import { plexAuthStoreExistsSync } from "../../lib/adapters/plex-adapter.js";
import { LidarrError } from "../../lib/lidarr/errors.js";
import { resolveRequiredLidarrClient } from "../../lib/lidarr/index.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import { getLoadedPlexConfig } from "../../lib/loaded-config.js";
import { logDebug } from "../../lib/logger.js";
import { advancePaginationOffset } from "../../lib/pagination.js";
import type { PolicySignalBundle, PolicySignalSlot } from "../../types/lidarr-policy.js";
import { MediaServerError } from "../../types/media-server.js";
import type { MediaItem, MediaPage, MediaServerErrorCode } from "../../types/media-server.js";

/* ── Bounds ──────────────────────────────────────────────────────────────── */

/**
 * Page size for every Plex drain — five times the adapter default of 100.
 *
 * `plex.cache.enabled` defaults to `false`, so a full-library track drain is
 * never free (§9.3). A larger page trades one bigger response for four fewer
 * round trips.
 */
const POLICY_GATHER_PAGE_SIZE = 500;

/** Hard ceiling on drained Plex artists. Exceeding it fails closed. */
const POLICY_MAX_PLEX_ARTISTS = 10_000;

/** Hard ceiling on drained Plex tracks. Exceeding it fails closed. */
const POLICY_MAX_PLEX_TRACKS = 200_000;

/** Ceiling on any `detail` string, so a verbose server cannot flood the report. */
const POLICY_GATHER_DETAIL_MAX = 300;

/**
 * Reliability tier for every Lidarr read here; matches the action's declared
 * tier. Retries are surrendered to the scheduler lane the action wraps these
 * calls in, exactly as `lidarr list` and `lidarr audit` do.
 */
const POLICY_GATHER_TIER: LidarrTier = "local-only";

/**
 * `detail` for the slot returned when no usable Plex credentials exist.
 *
 * Enrollment (issue #251) is a credential source the policy engine never sees
 * through config, so the text names it explicitly: an install that dropped
 * `plex.token` after `rfmedia plex auth login` is fully configured.
 */
const PLEX_NOT_CONFIGURED_DETAIL =
  "Plex is not configured; set plex.url plus either plex.token or an enrolled credential " +
  "(run rfmedia plex auth login), or pass --plex-url and --plex-token";

/* ── Options ─────────────────────────────────────────────────────────────── */

/** Connection overrides and cancellation for the two Lidarr-backed gatherers. */
export interface PolicyLidarrGatherOptions {
  /** `--lidarr-url` override for the configured base URL. */
  readonly lidarrUrl?: string;
  /** `--lidarr-api-key` override for the configured API key. */
  readonly lidarrApiKey?: string;
  /** Caller abort signal; an abort resolves to an `unavailable` slot. */
  readonly signal?: AbortSignal;
}

/** Library scope, connection overrides, and cancellation for the Plex drains. */
export interface PolicyPlexGatherOptions {
  /** Resolved Plex music library (`policy.plexLibrary` / `--plex-library`). */
  readonly library: string;
  /** `--plex-url` override, forwarded RAW to the adapter factory. */
  readonly plexUrl?: string;
  /** `--plex-token` override, forwarded RAW to the adapter factory. */
  readonly plexToken?: string;
  /** Caller abort signal; an abort resolves to an `unavailable` slot. */
  readonly signal?: AbortSignal;
}

/* ── Internals ───────────────────────────────────────────────────────────── */

/**
 * The `unavailable` arm of any slot. It does not mention the payload type, so a
 * single failure value is assignable to every `PolicySignalSlot<T>`.
 */
type PolicyGatherFailure = Extract<PolicySignalSlot<unknown>, { readonly status: "unavailable" }>;

/** Outcome of a bounded drain: the full page set, or a refusal to truncate. */
type PolicyDrainOutcome<T> =
  | { readonly status: "drained"; readonly items: readonly T[] }
  | { readonly status: "bound-exceeded"; readonly observed: number; readonly maxItems: number };

/** Extracts a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Narrows a configuration or override value to one that carries content. */
function isPresent(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

/** Clamps a detail so no single slot can dominate a `--json` report. */
function boundedDetail(detail: string): string {
  return detail.length <= POLICY_GATHER_DETAIL_MAX
    ? detail
    : `${detail.slice(0, POLICY_GATHER_DETAIL_MAX - 1)}…`;
}

/**
 * Converts any thrown value into the `data-unavailable` slot, tagging it with
 * the wire-level classification code the failure carried.
 *
 * `MediaServerErrorCode` and `LidarrErrorCode` are field-shape compatible (see
 * the `LidarrErrorCode` doc comment), so both boundaries produce the same
 * `<target> unavailable (<code>): <message>` shape. Anything that is neither
 * typed error — an unusable URL, a refused cross-origin override, an abort — is
 * classified `configuration`, mirroring `probeLidarrAuditPlex`.
 */
function failureSlot(queryTarget: string, code: string, error: unknown): PolicyGatherFailure {
  logDebug(`lidarr policy: ${queryTarget} unavailable (${code})`);
  return {
    status: "unavailable",
    reason: "data-unavailable",
    detail: boundedDetail(`${queryTarget} unavailable (${code}): ${errorMessage(error)}`),
  };
}

/** Classifies a media-server failure and converts it to an unavailable slot. */
function mediaServerFailureSlot(queryTarget: string, error: unknown): PolicyGatherFailure {
  const code: MediaServerErrorCode =
    error instanceof MediaServerError ? error.code : "configuration";
  return failureSlot(queryTarget, code, error);
}

/** Classifies a Lidarr failure and converts it to an unavailable slot. */
function lidarrFailureSlot(queryTarget: string, error: unknown): PolicyGatherFailure {
  return failureSlot(
    queryTarget,
    error instanceof LidarrError ? error.code : "configuration",
    error,
  );
}

/**
 * The slot returned when a library is larger than the drain is allowed to hold.
 *
 * Fails closed on purpose. Truncating would silently under-count plays for every
 * artist past the cut, and `stale-monitoring-cleanup` reads a low play count as
 * evidence for unmonitoring — so a truncated drain manufactures exactly the
 * proposal it must never manufacture.
 */
function boundExceededSlot(
  queryTarget: string,
  library: string,
  outcome: Extract<PolicyDrainOutcome<never>, { readonly status: "bound-exceeded" }>,
): PolicyGatherFailure {
  logDebug(`lidarr policy: ${queryTarget} exceeded the gather bound; refusing to truncate`);
  return {
    status: "unavailable",
    reason: "data-unavailable",
    detail: boundedDetail(
      `${queryTarget} in library "${library}" exceed the policy gather bound ` +
        `(${outcome.observed} > ${outcome.maxItems}); refusing to truncate, since a partial ` +
        `drain understates consumption. Point policy.plexLibrary or --plex-library at a ` +
        `smaller library.`,
    ),
  };
}

/**
 * Drains every page of one Plex query under a hard item bound.
 *
 * The loop is design §8.1's mandatory form: `advancePaginationOffset` owns the
 * forward-progress invariant (it throws when a server claims another page while
 * returning none), and `signal?.throwIfAborted()` brackets every await so Ctrl-C
 * lands within one request rather than one library. Hand-rolled `offset += limit`
 * arithmetic is forbidden — it loses the stall guard and can loop forever.
 *
 * The bound is checked against the server-reported total first, so an oversized
 * library costs one request rather than a full drain, and again against what has
 * actually accumulated, so a server that under-reports `total` cannot slip past.
 *
 * @param queryTarget - Human-readable target used in stall and bound messages.
 * @param maxItems - Hard ceiling; more than this fails closed.
 * @param signal - Caller abort signal, checked around every await.
 * @param fetchPage - Issues one page at the given offset.
 * @returns Every item, or the refusal to truncate.
 * @throws Whatever the adapter or the abort signal throws; callers convert it.
 */
async function drainBoundedMediaPages<T extends MediaItem>(
  queryTarget: string,
  maxItems: number,
  signal: AbortSignal | undefined,
  fetchPage: (offset: number) => Promise<MediaPage<T>>,
): Promise<PolicyDrainOutcome<T>> {
  const collected: T[] = [];
  let offset = 0;

  for (;;) {
    signal?.throwIfAborted();
    const page = await fetchPage(offset);
    signal?.throwIfAborted();

    if (page.total > maxItems) {
      return { status: "bound-exceeded", observed: page.total, maxItems };
    }

    collected.push(...page.items);
    if (collected.length > maxItems) {
      return { status: "bound-exceeded", observed: collected.length, maxItems };
    }

    const next = advancePaginationOffset(page, queryTarget);
    if (next === offset) break;
    offset = next;
  }

  return { status: "drained", items: collected };
}

/**
 * Answers "can Plex be reached at all" BEFORE any adapter is constructed.
 *
 * None of the existing factories is a readiness check: `requireMediaServerAdapter`
 * throws on missing credentials, `createOptionalMediaServerAdapter` is gated on
 * the unrelated scan flag, and `getConfiguredMediaServerType` ORs URL and token.
 * The gate below therefore reads the same values the adapter reads, in the same
 * order, and short-circuits so the enrollment store is stat'd only when no static
 * token is present.
 *
 * A credential source is a static token (`--plex-token` or `plex.token`) OR an
 * enrollment store on disk (issue #251). The store probe is deliberately coarse —
 * it asks only "does a store exist", never "is it valid for this origin".
 * Answering the narrower question is the resolver's job, and its refusals surface
 * through the callers' `catch` as `data-unavailable`, which is honest degradation
 * rather than a silent claim that Plex was never configured.
 *
 * @param queryTarget - Human-readable target used in the debug line.
 * @param overrides - RAW CLI overrides; read here ONLY to answer readiness. The
 *   factory still receives the untouched pair, so its guard stays live.
 * @returns The `plex-not-configured` slot, or `undefined` when Plex is usable.
 */
function plexReadinessGate(
  queryTarget: string,
  overrides: PolicyPlexGatherOptions,
): PolicyGatherFailure | undefined {
  const config = getLoadedPlexConfig();
  const url = overrides.plexUrl ?? config.url;
  const token = overrides.plexToken ?? config.token;

  // Short-circuits, so the store is stat'd only when no static token is present.
  const hasCredentialSource =
    isPresent(token) || plexAuthStoreExistsSync({ storePath: config.auth?.storePath });

  if (isPresent(url) && hasCredentialSource) {
    return undefined;
  }

  logDebug(`lidarr policy: Plex credentials absent, skipping ${queryTarget}`);
  return {
    status: "unavailable",
    reason: "plex-not-configured",
    detail: PLEX_NOT_CONFIGURED_DETAIL,
  };
}

/* ── Gatherers ───────────────────────────────────────────────────────────── */

/**
 * Reads the library-wide Lidarr artist list. NEVER throws.
 *
 * The client is resolved inside the `try` for the same reason the adapter is:
 * `resolveRequiredLidarrClient` throws a typed configuration error when the base
 * URL or API key is missing or malformed, and a policy report must be able to
 * say "Lidarr was unreadable" rather than die.
 *
 * @param options - Lidarr connection overrides and cancellation.
 * @returns `PolicySignalSlot<readonly LidarrArtist[]>`.
 */
export async function gatherLidarrArtists(
  options: PolicyLidarrGatherOptions,
): Promise<PolicySignalBundle["lidarrArtists"]> {
  try {
    const client = resolveRequiredLidarrClient(
      { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey },
      { tier: POLICY_GATHER_TIER, retryAttemptsOverride: 0 },
    );

    options.signal?.throwIfAborted();
    logDebug("lidarr policy: reading the library-wide Lidarr artist list");
    const artists = await client.listArtists(options.signal);
    options.signal?.throwIfAborted();

    return { status: "available", data: artists };
  } catch (error) {
    return lidarrFailureSlot("Lidarr artists", error);
  }
}

/**
 * Reads the live Lidarr quality profiles. NEVER throws.
 *
 * The profiles are what turn a configured `targetQualityProfile` name into an
 * id, so an unavailable slot here disables the rules that need one rather than
 * letting them guess.
 *
 * @param options - Lidarr connection overrides and cancellation.
 * @returns `PolicySignalSlot<readonly LidarrProfile[]>`.
 */
export async function gatherLidarrQualityProfiles(
  options: PolicyLidarrGatherOptions,
): Promise<PolicySignalBundle["lidarrQualityProfiles"]> {
  try {
    const client = resolveRequiredLidarrClient(
      { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey },
      { tier: POLICY_GATHER_TIER, retryAttemptsOverride: 0 },
    );

    options.signal?.throwIfAborted();
    logDebug("lidarr policy: reading Lidarr quality profiles");
    const profiles = await client.listQualityProfiles(options.signal);
    options.signal?.throwIfAborted();

    return { status: "available", data: profiles };
  } catch (error) {
    return lidarrFailureSlot("Lidarr quality profiles", error);
  }
}

/**
 * Drains every Plex artist in the policy library. NEVER throws.
 *
 * The readiness gate runs FIRST, before any adapter exists. The adapter is then
 * constructed inside the same `try` as the round trips it enables, because
 * `resolveRequiredMediaServerAdapter` throws a plain `Error` on an unusable URL
 * or a refused cross-origin override.
 *
 * `{ plexUrl, plexToken }` are forwarded to the factory RAW — never pre-resolved
 * against config. The frozen cross-origin credential guard keys on the presence
 * of `overrides.plexToken`, so handing the factory a config-resolved pair would
 * structurally disable it and ship the configured token to whatever host
 * `--plex-url` names. This is a standing recorded regression in this repo.
 *
 * @param options - Library scope, RAW Plex overrides, and cancellation.
 * @returns `PolicySignalSlot<readonly MediaArtist[]>`.
 */
export async function gatherPlexArtistRatings(
  options: PolicyPlexGatherOptions,
): Promise<PolicySignalBundle["plexArtistRatings"]> {
  const notConfigured = plexReadinessGate("the Plex artist drain", options);
  if (notConfigured !== undefined) {
    return notConfigured;
  }

  try {
    const adapter = resolveRequiredMediaServerAdapter({
      plexUrl: options.plexUrl,
      plexToken: options.plexToken,
    });

    logDebug(`lidarr policy: draining Plex artists from library "${options.library}"`);
    const drained = await drainBoundedMediaPages(
      "Plex artists",
      POLICY_MAX_PLEX_ARTISTS,
      options.signal,
      (offset) =>
        adapter.query.artists({
          library: options.library,
          kind: "artist",
          limit: POLICY_GATHER_PAGE_SIZE,
          offset,
        }),
    );

    if (drained.status === "bound-exceeded") {
      return boundExceededSlot("Plex artists", options.library, drained);
    }

    return { status: "available", data: drained.items };
  } catch (error) {
    return mediaServerFailureSlot("Plex artists", error);
  }
}

/**
 * Drains every Plex track in the policy library. NEVER throws.
 *
 * This is the expensive signal — `plex.cache.enabled` defaults to `false`, so a
 * full drain costs a full library walk. The action calls it whenever a selected
 * rule requires OR enriches on `plexTrackPlays` (§8.1 item 7), and every
 * registered rule does one or the other, so `--rule` cannot narrow this cost
 * away. Enabling the Plex cache is the only lever on it.
 *
 * The readiness gate, the adapter-inside-`try` placement, and the RAW override
 * forwarding are identical to {@link gatherPlexArtistRatings}; see its doc for
 * why each one is load-bearing.
 *
 * @param options - Library scope, RAW Plex overrides, and cancellation.
 * @returns `PolicySignalSlot<readonly MediaTrack[]>`.
 */
export async function gatherPlexTrackPlays(
  options: PolicyPlexGatherOptions,
): Promise<PolicySignalBundle["plexTrackPlays"]> {
  const notConfigured = plexReadinessGate("the Plex track drain", options);
  if (notConfigured !== undefined) {
    return notConfigured;
  }

  try {
    const adapter = resolveRequiredMediaServerAdapter({
      plexUrl: options.plexUrl,
      plexToken: options.plexToken,
    });

    logDebug(`lidarr policy: draining Plex tracks from library "${options.library}"`);
    const drained = await drainBoundedMediaPages(
      "Plex tracks",
      POLICY_MAX_PLEX_TRACKS,
      options.signal,
      (offset) =>
        adapter.query.tracks({
          library: options.library,
          kind: "track",
          limit: POLICY_GATHER_PAGE_SIZE,
          offset,
        }),
    );

    if (drained.status === "bound-exceeded") {
      return boundExceededSlot("Plex tracks", options.library, drained);
    }

    return { status: "available", data: drained.items };
  } catch (error) {
    return mediaServerFailureSlot("Plex tracks", error);
  }
}
