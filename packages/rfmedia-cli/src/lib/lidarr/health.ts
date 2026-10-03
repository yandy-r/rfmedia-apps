/**
 * Lidarr health monitor (issue #195).
 *
 * `runHealthProbe` turns one `/health` round-trip into a classified
 * {@link LidarrHealthReport}; `detectMetadataProviderOutage` is the single
 * data-driven matcher deciding "Lidarr up, metadata provider down";
 * `ensureTierHealthy` is the per-lane pre-dispatch gate #196 consumes, keyed
 * strictly off `LIDARR_TIER_DESCRIPTORS`; `readLidarrResilienceSnapshot`
 * surfaces persisted breaker state and deferred-intent counts for the
 * `lidarr health` command.
 *
 * Together with the metadata-scope circuit rejection in the resilience
 * decorator, this module hosts the only documented construction sites of
 * {@link MetadataProviderUnavailableError}.
 */

import type { DbConnection } from "../../types/db.js";
import type { LidarrHealthCheck } from "../../types/lidarr.js";
import type { LidarrResilienceSnapshot } from "../../types/lidarr-resilience.js";
import { closeDatabase, initializeDatabase } from "../db.js";
import { getLoadedLidarrConfig } from "../loaded-config.js";
import { createSqliteCircuitStore, HALF_OPEN_PROBE_TIMEOUT_MS } from "./circuit-breaker.js";
import type {
  CircuitDecision,
  CircuitScope,
  CircuitState,
  LidarrCircuitBreaker,
} from "./circuit-breaker.js";
import type { LidarrClientApi } from "./client.js";
import { countDeferredIntentsByStatus } from "./deferred-queue-db.js";
import { LidarrError, LidarrUnreachableError, MetadataProviderUnavailableError } from "./errors.js";
import { LIDARR_TIER_DESCRIPTORS } from "./tiers.js";
import type { LidarrTier } from "./tiers.js";
import { createLidarrConnectionSettings } from "./types.js";

/** Operation label attached to gate/probe errors (client label convention). */
const HEALTH_GATE_OPERATION = "lidarr health gate";

/**
 * Data-driven signature of a metadata-provider outage in Lidarr health-check
 * payloads. Lidarr wording can drift; a false negative degrades to the
 * `lidarr` scope (safe), never to silent success.
 */
const METADATA_OUTAGE_PATTERN = /metadata|skyhook|api\.lidarr\.audio/i;

/** Both circuit scopes surfaced by the resilience snapshot, in render order. */
const SNAPSHOT_SCOPES: readonly CircuitScope[] = ["lidarr", "metadata"];

/** One snapshot circuit entry (state plus optional next-admission time). */
type SnapshotCircuitEntry = LidarrResilienceSnapshot["circuits"][number];

/** Classified outcome of a single Lidarr health probe. */
export interface LidarrHealthReport {
  /**
   * `"healthy"`: no error-level checks; `"degraded"`: error-level checks
   * present; `"unreachable"`: the probe request itself failed at the
   * transport level (`lidarr-unreachable` / `timeout`).
   */
  readonly status: "healthy" | "degraded" | "unreachable";
  /** When the probe ran (ISO-8601). */
  readonly checkedAt: string;
  /** Error-level health checks reported by Lidarr. */
  readonly errors: readonly LidarrHealthCheck[];
  /** Warning-level health checks reported by Lidarr. */
  readonly warnings: readonly LidarrHealthCheck[];
  /** Metadata-provider outage view derived via {@link detectMetadataProviderOutage}. */
  readonly metadataProvider: {
    /** False when at least one error-level check matches the outage signature. */
    readonly available: boolean;
    /** The matching error-level checks (empty when available). */
    readonly failingChecks: readonly LidarrHealthCheck[];
  };
}

/**
 * True for transport-level Lidarr failures (`lidarr-unreachable`, `timeout`) —
 * exactly the class {@link runHealthProbe} classifies as `"unreachable"`
 * instead of throwing.
 *
 * Exported so callers that must DEGRADE rather than abort on the same failure
 * class (the `lidarr audit` gather) share this one definition of "transport"
 * instead of restating the code list.
 *
 * @param error - Any thrown value.
 * @returns Whether the failure is a transport-level Lidarr outage.
 */
export function isTransportOutage(error: unknown): boolean {
  return (
    error instanceof LidarrError &&
    (error.code === "lidarr-unreachable" || error.code === "timeout")
  );
}

/**
 * Data-driven matcher over error-level checks: a check signals a
 * metadata-provider outage when its `source` or `message` matches
 * `/metadata|skyhook|api\.lidarr\.audio/i`. Non-error checks never match.
 *
 * @param checks - Health checks to scan (any severity; only errors count).
 * @returns The error-level checks matching the outage signature.
 */
export function detectMetadataProviderOutage(
  checks: readonly LidarrHealthCheck[],
): readonly LidarrHealthCheck[] {
  return checks.filter(
    (check) =>
      check.type === "error" &&
      (METADATA_OUTAGE_PATTERN.test(check.source) || METADATA_OUTAGE_PATTERN.test(check.message)),
  );
}

/**
 * Runs one fresh health probe against the Lidarr `/health` endpoint and
 * classifies the outcome. Results are never cached — every call is a new
 * request.
 *
 * Transport-level failures (`lidarr-unreachable`, `timeout`) are classified
 * into an `"unreachable"` report — surfaced, not thrown — because
 * unreachability is precisely the condition the probe exists to detect. All
 * other failures (validation, abort, unexpected errors) propagate unchanged.
 *
 * @param client - Lidarr client facade used for the health request.
 * @param signal - Optional caller abort signal forwarded to the request.
 * @returns The classified {@link LidarrHealthReport}.
 * @throws {LidarrError} Non-transport failures from `client.getHealth`.
 */
export async function runHealthProbe(
  client: LidarrClientApi,
  signal?: AbortSignal,
): Promise<LidarrHealthReport> {
  const checkedAt = new Date().toISOString();
  let checks: readonly LidarrHealthCheck[];
  try {
    checks = await client.getHealth(signal);
  } catch (error) {
    if (isTransportOutage(error)) {
      // No provider outage is observable while the instance itself is down;
      // the transport outage is the surfaced signal.
      return {
        status: "unreachable",
        checkedAt,
        errors: [],
        warnings: [],
        metadataProvider: { available: true, failingChecks: [] },
      };
    }
    throw error;
  }

  const errors = checks.filter((check) => check.type === "error");
  const warnings = checks.filter((check) => check.type === "warning");
  const failingChecks = detectMetadataProviderOutage(errors);
  return {
    status: errors.length > 0 ? "degraded" : "healthy",
    checkedAt,
    errors,
    warnings,
    metadataProvider: { available: failingChecks.length === 0, failingChecks },
  };
}

/**
 * Throws the scope-mapped taxonomy error for a rejected circuit gate, with
 * `retryAfterSeconds = ceil(retryAfterMs / 1000)` and a recovery hint.
 */
function throwCircuitOpenError(
  scope: CircuitScope,
  decision: Extract<CircuitDecision, { allowed: false }>,
): never {
  const retryAfterSeconds = Math.ceil(decision.retryAfterMs / 1000);
  const hint = `circuit open — retries resume at ${decision.retryAtIso}; run \`rfmedia lidarr health\` for details`;
  switch (scope) {
    case "lidarr":
      throw new LidarrUnreachableError(HEALTH_GATE_OPERATION, `Lidarr is unavailable (${hint})`, {
        retryAfterSeconds,
      });
    case "metadata":
      throw new MetadataProviderUnavailableError(
        HEALTH_GATE_OPERATION,
        `Lidarr metadata provider is unavailable (${hint})`,
        { retryAfterSeconds },
      );
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unhandled circuit scope: ${String(exhaustive)}`);
    }
  }
}

/** Gates one breaker scope, throwing the scope-mapped error on rejection. */
function gateScope(breaker: LidarrCircuitBreaker): void {
  const decision = breaker.gate();
  if (!decision.allowed) {
    throwCircuitOpenError(breaker.scope, decision);
  }
}

/**
 * Feeds a probe/health outcome into the breaker handles (design §7 state
 * machine: a failed half-open probe re-opens with a fresh `openedAt`; a
 * closed-state probe failure appends to the failure window). Each handle
 * no-ops error codes that do not feed its scope (§8), so both gated scopes
 * can safely be offered the same error.
 *
 * CRITICAL: gate REJECTIONS (circuit-open fail-fast errors) never reach this
 * function — they are thrown by {@link gateScope} before any network call.
 * Only actual probe outcomes observed by {@link ensureTierHealthy} may feed
 * the breaker.
 *
 * @param breakers - Store-backed breaker handles for both scopes.
 * @param metadataServerRequired - Whether the tier gates the metadata scope.
 * @param error - The probe outcome; non-Lidarr errors feed nothing.
 */
function recordProbeFailure(
  breakers: { readonly lidarr: LidarrCircuitBreaker; readonly metadata: LidarrCircuitBreaker },
  metadataServerRequired: boolean,
  error: unknown,
): void {
  if (!(error instanceof LidarrError)) {
    return;
  }
  breakers.lidarr.recordFailure(error);
  if (metadataServerRequired) {
    breakers.metadata.recordFailure(error);
  }
}

/**
 * Per-lane pre-dispatch gate (#196 contract).
 *
 * Behavior is keyed STRICTLY off `LIDARR_TIER_DESCRIPTORS[tier]`:
 * `requiresHealthGate: false` (today: every tier except
 * `"metadata-dependent"`) returns immediately with zero I/O — no client
 * call, no breaker read, no database open. Otherwise the `lidarr` breaker is
 * gated, then (when `metadataServerRequired`) the `metadata` breaker, then a
 * fresh {@link runHealthProbe} runs. Probe results are NEVER cached across
 * calls; #196 re-gates per batch by calling this again.
 *
 * Probe outcomes feed the breakers (design §7): a probe/health failure calls
 * `recordFailure` on the gated scope(s) — so closed-state failures count
 * toward the trip window and a failed half-open probe re-opens with a fresh
 * `openedAt` — and a passing probe calls `recordSuccess` so a half-open
 * probe claim closes (a clear on an already-closed circuit is harmless).
 * Gate rejections (circuit-open fail-fast) never feed the breaker: they
 * happen before any network call.
 *
 * @param client - Lidarr client facade used for the health probe.
 * @param tier - Reliability tier of the pending operation.
 * @param breakers - Store-backed breaker handles for both scopes of the origin.
 * @param signal - Optional caller abort signal forwarded to the probe.
 * @returns The fresh health report for gated tiers; `undefined` for ungated tiers.
 * @throws {LidarrUnreachableError} When the `lidarr` circuit rejects the call
 *   or the probe finds the instance unreachable.
 * @throws {MetadataProviderUnavailableError} When the `metadata` circuit
 *   rejects the call or {@link detectMetadataProviderOutage} matches.
 */
export async function ensureTierHealthy(
  client: LidarrClientApi,
  tier: LidarrTier,
  breakers: { readonly lidarr: LidarrCircuitBreaker; readonly metadata: LidarrCircuitBreaker },
  signal?: AbortSignal,
): Promise<LidarrHealthReport | undefined> {
  const descriptor = LIDARR_TIER_DESCRIPTORS[tier];
  if (!descriptor.requiresHealthGate) {
    return undefined;
  }

  gateScope(breakers.lidarr);
  if (descriptor.metadataServerRequired) {
    gateScope(breakers.metadata);
  }

  let report: LidarrHealthReport;
  try {
    report = await runHealthProbe(client, signal);
  } catch (probeError) {
    recordProbeFailure(breakers, descriptor.metadataServerRequired, probeError);
    throw probeError;
  }
  if (report.status === "unreachable") {
    const error = new LidarrUnreachableError(
      HEALTH_GATE_OPERATION,
      "Lidarr health probe found the instance unreachable",
    );
    recordProbeFailure(breakers, descriptor.metadataServerRequired, error);
    throw error;
  }
  if (descriptor.metadataServerRequired && !report.metadataProvider.available) {
    const sources = report.metadataProvider.failingChecks.map((check) => check.source).join(", ");
    const error = new MetadataProviderUnavailableError(
      HEALTH_GATE_OPERATION,
      `Lidarr metadata provider is unavailable (failing checks: ${sources})`,
    );
    recordProbeFailure(breakers, descriptor.metadataServerRequired, error);
    throw error;
  }
  // Probe passed: close any half-open probe claim on the gated scope(s).
  breakers.lidarr.recordSuccess();
  if (descriptor.metadataServerRequired) {
    breakers.metadata.recordSuccess();
  }
  return report;
}

/**
 * CLI override fields used to resolve the Lidarr connection.
 *
 * Structurally identical to the barrel's `LidarrClientOverrides`; duplicated
 * here because this module must not import from `./index.js` (the barrel
 * re-exports this module — a static import back would create a cycle).
 */
export interface LidarrClientOverrides {
  /** `--lidarr-url` override for the configured base URL. */
  readonly lidarrUrl?: string;
  /** `--lidarr-api-key` override for the configured API key. */
  readonly lidarrApiKey?: string;
}

/** Test seams for {@link readLidarrResilienceSnapshot}. */
export interface LidarrResilienceSnapshotDependencies {
  /** Lazily opens the tracking database; defaults to `initializeDatabase()`. */
  readonly openDb?: () => Promise<DbConnection>;
}

/** Extracts a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Derives the credential-free canonical origin from loaded config plus CLI
 * overrides, via `createLidarrConnectionSettings` (the single origin
 * authority). The API key participates in resolution but never leaves this
 * function.
 */
function deriveCanonicalLidarrOrigin(overrides?: LidarrClientOverrides): string {
  const config = getLoadedLidarrConfig();
  const rawUrl = overrides?.lidarrUrl ?? config.baseUrl;
  const apiKey = overrides?.lidarrApiKey ?? config.apiKey;
  if (rawUrl === undefined || rawUrl === "" || apiKey === undefined || apiKey === "") {
    throw new Error("Lidarr base URL and API key are not configured");
  }
  const connection = createLidarrConnectionSettings({ origin: new URL(rawUrl).origin, apiKey });
  return connection.origin;
}

/** When a non-closed circuit next admits a call, if derivable from its state. */
function circuitRetryAtIso(state: CircuitState): string | undefined {
  switch (state.state) {
    case "closed":
      return undefined;
    case "open":
      return new Date(Date.parse(state.openedAt) + state.cooldownMs).toISOString();
    case "half-open":
      return new Date(Date.parse(state.probeStartedAt) + HALF_OPEN_PROBE_TIMEOUT_MS).toISOString();
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled circuit state: ${String(exhaustive)}`);
    }
  }
}

/** Builds the all-unknown snapshot used when state cannot be read at all. */
function buildUnknownSnapshot(reason: string): LidarrResilienceSnapshot {
  return {
    circuits: SNAPSHOT_SCOPES.map(
      (scope): SnapshotCircuitEntry => ({ scope, state: { state: "unknown", reason } }),
    ),
    deferredIntents: { pending: 0, failed: 0 },
  };
}

/**
 * Reads a point-in-time resilience snapshot (circuit state per scope plus
 * deferred-intent counts) for the configured Lidarr origin.
 *
 * The tracking database is opened lazily — only when this function runs —
 * and closed before returning. Every failure mode (unresolvable origin,
 * database open failure, malformed persisted state) is reported explicitly
 * as `{ state: "unknown", reason }` circuit entries — surfaced, never
 * silent — so the `lidarr health` command itself still succeeds.
 *
 * @param overrides - CLI URL/API-key overrides (same precedence as the client resolver).
 * @param deps - Optional test seams (database opener).
 * @returns The snapshot; never throws.
 */
export async function readLidarrResilienceSnapshot(
  overrides?: LidarrClientOverrides,
  deps?: LidarrResilienceSnapshotDependencies,
): Promise<LidarrResilienceSnapshot> {
  let origin: string;
  try {
    origin = deriveCanonicalLidarrOrigin(overrides);
  } catch (error) {
    return buildUnknownSnapshot(`cannot resolve Lidarr origin: ${errorMessage(error)}`);
  }

  const openDb = deps?.openDb ?? ((): Promise<DbConnection> => initializeDatabase());
  let db: DbConnection;
  try {
    db = await openDb();
  } catch (error) {
    return buildUnknownSnapshot(`cannot open tracking database: ${errorMessage(error)}`);
  }

  try {
    const store = createSqliteCircuitStore(db);
    const circuits = SNAPSHOT_SCOPES.map((scope): SnapshotCircuitEntry => {
      try {
        const state = store.load(origin, scope);
        const retryAtIso = circuitRetryAtIso(state);
        return { scope, state, ...(retryAtIso === undefined ? {} : { retryAtIso }) };
      } catch (error) {
        return { scope, state: { state: "unknown", reason: errorMessage(error) } };
      }
    });
    const counts = countDeferredIntentsByStatus(db, origin);
    return {
      circuits,
      deferredIntents: { pending: counts.pending, failed: counts.failed },
    };
  } catch (error) {
    return buildUnknownSnapshot(`cannot read resilience state: ${errorMessage(error)}`);
  } finally {
    closeDatabase(db);
  }
}
