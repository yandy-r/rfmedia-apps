/**
 * Test fixtures for `rfmedia lidarr audit` (issue #211).
 *
 * Complements `lidarr-fixtures.ts` — which builds Lidarr wire shapes (artists,
 * albums, health checks) — with the audit-specific values the engine and action
 * suites consume: health reports, queue state, the Plex probe union, gather
 * slots, and a complete {@link LidarrAuditGatheredData} bundle. Nothing is
 * re-exported from `lidarr-fixtures.ts`; import both modules when a test needs
 * both layers.
 *
 * Factories return fresh frozen values so tests never share mutable nested
 * state, and every default is healthy/empty so a test only has to declare the
 * one condition it exercises.
 */

import type { LidarrHealthReport } from "../../lib/lidarr/health.js";
import type {
  LidarrAuditGatheredData,
  LidarrAuditPlexProbe,
  LidarrAuditQueueState,
  LidarrAuditSlot,
  LidarrAuditUnavailableReason,
} from "../../types/lidarr-audit.js";

/** Fixed probe timestamp so report snapshots stay deterministic. */
const FIXTURE_CHECKED_AT = "2026-07-25T00:00:00.000Z";

/** Detail carried by the reserved identity-mapping slot until #207/#208 land. */
const FIXTURE_IDENTITY_DETAIL = "Plex/Lidarr identity mapping is not implemented yet (#207/#208)";

/** The reachable arm of {@link LidarrAuditPlexProbe} — the only arm with library data. */
type ReachableLidarrAuditPlexProbe = Extract<LidarrAuditPlexProbe, { reachable: true }>;

/**
 * Builds a Lidarr health report as the probe would classify it.
 *
 * Defaults to a healthy instance with no error- or warning-level checks and an
 * available metadata provider. `metadataProvider` is merged over the default so
 * an override supplies the whole block, matching the probe's own shape.
 *
 * @param overrides - Fields to override on the default report.
 * @returns A frozen {@link LidarrHealthReport} value.
 */
export function createLidarrHealthReportFixture(
  overrides: Partial<LidarrHealthReport> = {},
): LidarrHealthReport {
  const defaults: LidarrHealthReport = {
    status: "healthy",
    checkedAt: FIXTURE_CHECKED_AT,
    errors: [],
    warnings: [],
    metadataProvider: { available: true, failingChecks: [] },
  };
  const merged: LidarrHealthReport = { ...defaults, ...overrides };

  return Object.freeze({
    ...merged,
    errors: Object.freeze([...merged.errors]),
    warnings: Object.freeze([...merged.warnings]),
    metadataProvider: Object.freeze({
      available: merged.metadataProvider.available,
      failingChecks: Object.freeze([...merged.metadataProvider.failingChecks]),
    }),
  });
}

/**
 * Builds the circuit and deferred-intent state the `retry-backlog` check reads.
 *
 * Defaults to both circuit scopes closed with no recent failures and all five
 * deferred-intent lifecycle counts at zero, so a test that sets one count
 * declares exactly the backlog it exercises. `counts` is merged over the
 * zero-filled default; the optional detail fields stay absent unless overridden.
 *
 * @param overrides - Fields to override on the default queue state.
 * @returns A frozen {@link LidarrAuditQueueState} value.
 */
export function createLidarrAuditQueueStateFixture(
  overrides: Partial<LidarrAuditQueueState> = {},
): LidarrAuditQueueState {
  const defaults: LidarrAuditQueueState = {
    circuits: [
      { scope: "lidarr", state: { state: "closed", recentFailures: [] } },
      { scope: "metadata", state: { state: "closed", recentFailures: [] } },
    ],
    counts: { pending: 0, "in-progress": 0, succeeded: 0, failed: 0, cancelled: 0 },
  };

  return Object.freeze({
    ...defaults,
    ...overrides,
    circuits: Object.freeze([...(overrides.circuits ?? defaults.circuits)]),
    counts: Object.freeze({ ...defaults.counts, ...overrides.counts }),
  });
}

/**
 * Builds the outcome of the single cheap Plex probe.
 *
 * Defaults to a reachable server exposing one music library. Override
 * `libraries` with `[]` for the "no music library" finding, or pass the
 * unreachable arm of {@link LidarrAuditPlexProbe} directly when a test needs
 * `reachable: false` — this factory only builds the reachable arm.
 *
 * @param overrides - Fields to override on the default reachable probe.
 * @returns A frozen {@link LidarrAuditPlexProbe} value.
 */
export function createLidarrAuditPlexProbeFixture(
  overrides: Partial<ReachableLidarrAuditPlexProbe> = {},
): LidarrAuditPlexProbe {
  const defaults: ReachableLidarrAuditPlexProbe = {
    reachable: true,
    libraries: [{ id: "plex-library-1", title: "Music", kind: "track" }],
  };
  const merged: ReachableLidarrAuditPlexProbe = { ...defaults, ...overrides };

  return Object.freeze({
    ...merged,
    libraries: Object.freeze([...merged.libraries]),
  });
}

/**
 * Wraps gathered data in an available slot.
 *
 * @param data - The gathered payload.
 * @returns An available {@link LidarrAuditSlot} carrying `data`.
 */
export function availableSlot<T>(data: T): LidarrAuditSlot<T> {
  return Object.freeze({ status: "available", data });
}

/**
 * Builds an unavailable slot.
 *
 * The result is assignable to `LidarrAuditSlot<T>` for every `T`, so one helper
 * covers every requirement. Only `"data-unavailable"` marks a report degraded;
 * the other reasons are expected absences.
 *
 * @param reason - Why the data source is absent.
 * @param detail - Operator-facing explanation surfaced on the skipped check.
 * @returns An unavailable {@link LidarrAuditSlot}.
 */
export function unavailableSlot(
  reason: LidarrAuditUnavailableReason,
  detail: string,
): LidarrAuditSlot<never> {
  return Object.freeze({ status: "unavailable", reason, detail });
}

/**
 * Builds a complete gather bundle for the audit engine.
 *
 * Every slot is available with empty or healthy data — an empty artist list, a
 * zero wanted backlog, an empty deep-scan result, closed circuits, a reachable
 * Plex server — except `plexIdentity`, which is the compile-time constant
 * `identity-mapping-unavailable` slot that keeps `plex-alignment` reserved until
 * #207/#208 ship a join key.
 *
 * @param overrides - Slots to override on the default bundle.
 * @returns A frozen {@link LidarrAuditGatheredData} value.
 */
export function createLidarrAuditGatheredDataFixture(
  overrides: Partial<LidarrAuditGatheredData> = {},
): LidarrAuditGatheredData {
  const defaults: LidarrAuditGatheredData = {
    health: availableSlot(createLidarrHealthReportFixture()),
    artists: availableSlot([]),
    wanted: availableSlot({ total: 0 }),
    albums: availableSlot({ albums: [], artistNames: new Map(), artistsScanned: 0 }),
    queue: availableSlot(createLidarrAuditQueueStateFixture()),
    plex: availableSlot(createLidarrAuditPlexProbeFixture()),
    plexIdentity: unavailableSlot("identity-mapping-unavailable", FIXTURE_IDENTITY_DETAIL),
  };

  return Object.freeze({ ...defaults, ...overrides });
}
