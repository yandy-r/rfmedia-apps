/**
 * Pure platform-state evaluators for `rfmedia lidarr audit` (issue #211).
 *
 * These four checks read the *platform* around the library — Lidarr's own
 * health payload, the resilience circuits and deferred-intent queue, and the
 * media server — as opposed to the catalogue itself, which
 * `./audit-library-checks.js` owns.
 *
 * Every export is synchronous and free of I/O: the audit action gathers data
 * once, and each evaluator turns an already-materialised
 * {@link LidarrAuditGatheredData} into findings. That keeps the checks trivially
 * unit-testable and lets the engine dispatch them behind a per-check
 * `try`/`catch` without owning any transport concern.
 *
 * Three invariants hold across this module:
 *
 * 1. Findings are built ONLY through {@link createLidarrAuditFinding}, so
 *    subject capping, `affected` accounting, and freezing are identical
 *    everywhere.
 * 2. Every `remediation.command` is non-mutating — a read command, never a
 *    mutation. Destructive follow-ups belong in `remediation.action` prose.
 * 3. A hard requirement that is nonetheless missing is an engine or registry
 *    bug, not a data condition, so it throws rather than silently reporting a
 *    clean check. The engine isolates the throw into a `check-error` skip.
 */

import { ARTIST_LIST_COMMAND, requireSlotData, toArtistSubject } from "./audit-check-support.js";
import { detectMetadataProviderOutage } from "./health.js";
import {
  createLidarrAuditFinding,
  type LidarrAuditCheckId,
  type LidarrAuditFinding,
  type LidarrAuditGatheredData,
  type LidarrAuditSeverity,
  type LidarrAuditSubject,
} from "../../types/lidarr-audit.js";
import type { LidarrHealthCheck, LidarrHealthType } from "../../types/lidarr.js";
import type { MediaServerErrorCode } from "../../types/media-server.js";

/** Read command that surfaces the raw health payload behind these findings. */
const HEALTH_COMMAND = "rfmedia lidarr health";

/** Read command scoped to the error-level checks `metadata-dependency` reports. */
const HEALTH_ERRORS_COMMAND = "rfmedia lidarr health --type error";

/** Read command covering both severities `operation-safety` translates. */
const HEALTH_ERRORS_AND_WARNINGS_COMMAND = "rfmedia lidarr health --type error --type warning";

/** Read command that exercises the same Plex credentials this probe used. */
const PLEX_READ_COMMAND = "rfmedia plex playlist list";

/** Subject scope shared by every deferred-intent queue finding. */
const DEFERRED_QUEUE_SCOPE = "deferred-intents";

/**
 * Media-server failure codes that mean the operator is locked out entirely.
 *
 * Everything else (`not-found`, `unsupported`, `invalid-response`, …) is a
 * narrower fault that leaves the rest of the audit usable, so it stays a
 * warning.
 */
const PLEX_CRITICAL_ERROR_CODES: ReadonlySet<MediaServerErrorCode> = new Set([
  "authentication",
  "authorization",
  "network",
  "timeout",
]);

/**
 * Translates Lidarr's wire severity into the audit ladder.
 *
 * The mapping is deliberate rather than adopted: `error` is operator-blocking
 * and becomes `critical`, `warning` maps across, `notice` is informational, and
 * `ok` produces no finding at all. The `never` default makes a future arm on
 * `LidarrHealthType` a compile error instead of a silently dropped check.
 *
 * @param type - Wire severity reported by Lidarr.
 * @returns The audit severity, or `undefined` when the check must not be emitted.
 * @throws {Error} When `LidarrHealthType` gains an unhandled arm.
 */
function translateHealthSeverity(type: LidarrHealthType): LidarrAuditSeverity | undefined {
  switch (type) {
    case "error":
      return "critical";
    case "warning":
      return "warning";
    case "notice":
      return "info";
    case "ok":
      return undefined;
    default: {
      const exhaustive: never = type;
      throw new Error(`Unhandled Lidarr health type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Builds the finding a translated Lidarr health check produces.
 *
 * The check's own `message` becomes the remediation action and its `wikiUrl`
 * is passed through unmodified — Lidarr's wiki is a better target than anything
 * this CLI could write.
 *
 * @param check - The health check to translate.
 * @param severity - Audit severity already derived from `check.type`.
 * @returns The `lidarr-health-check` finding.
 */
function buildHealthCheckFinding(
  check: LidarrHealthCheck,
  severity: LidarrAuditSeverity,
): LidarrAuditFinding {
  return createLidarrAuditFinding({
    checkId: "operation-safety",
    code: "lidarr-health-check",
    severity,
    summary: `${check.source} reported a ${check.type}-level condition`,
    // Health checks describe the instance, and the report origin is stamped by
    // the engine rather than carried on the gathered data, so there is no
    // subject to attach; `affected` counts the one condition instead.
    subjects: [],
    affected: 1,
    evidence: { source: check.source, healthType: check.type, message: check.message },
    remediation: {
      action: check.message,
      command: HEALTH_ERRORS_AND_WARNINGS_COMMAND,
      docUrl: check.wikiUrl,
    },
  });
}

/**
 * Evaluates `metadata-dependency`: is Lidarr answering, and is its upstream
 * metadata provider healthy?
 *
 * Two conditions are reported. An `unreachable` probe yields a single
 * `lidarr-unreachable` critical — this is the finding that explains why every
 * other Lidarr-backed slot in the same report is `data-unavailable`, which is
 * exactly why the action keeps the `health` slot available even when the probe
 * fails. Each entry in `metadataProvider.failingChecks` then yields one
 * `metadata-provider-outage` critical carrying Lidarr's own wiki link.
 *
 * The two conditions are mutually exclusive in practice: an unreachable probe
 * observes no provider checks at all.
 *
 * @param gathered - Slots gathered by the audit action.
 * @returns Frozen findings, unreachability first.
 * @throws {Error} When the required `health` slot is unavailable.
 */
export function evaluateMetadataDependency(
  gathered: LidarrAuditGatheredData,
): readonly LidarrAuditFinding[] {
  const report = requireSlotData(gathered.health, "metadata-dependency", "health");
  const findings: LidarrAuditFinding[] = [];

  if (report.status === "unreachable") {
    findings.push(
      createLidarrAuditFinding({
        checkId: "metadata-dependency",
        code: "lidarr-unreachable",
        severity: "critical",
        summary: "Lidarr did not answer the health probe",
        subjects: [],
        affected: 1,
        evidence: { probeStatus: report.status, checkedAt: report.checkedAt },
        remediation: {
          action:
            "Lidarr failed at the transport level, so every other Lidarr-backed check in this report was abandoned. Confirm the instance is running and that `lidarr.url` (or `--lidarr-url`) points at it.",
          command: HEALTH_COMMAND,
        },
      }),
    );
  }

  for (const check of report.metadataProvider.failingChecks) {
    findings.push(
      createLidarrAuditFinding({
        checkId: "metadata-dependency",
        code: "metadata-provider-outage",
        severity: "critical",
        summary: `Metadata provider outage reported by ${check.source}`,
        subjects: [],
        affected: 1,
        evidence: { source: check.source, healthType: check.type, message: check.message },
        remediation: {
          action:
            "Metadata-dependent operations (`lidarr search`, `lidarr lookup`, artist add) are gated until the provider recovers; local-only commands stay safe.",
          command: HEALTH_ERRORS_COMMAND,
          docUrl: check.wikiUrl,
        },
      }),
    );
  }

  return Object.freeze(findings);
}

/**
 * Evaluates `operation-safety`: conditions that make the next import or search
 * fail.
 *
 * Lidarr's own error- and warning-level checks — root-folder accessibility,
 * disk space, permissions, indexer status — are translated one-for-one, minus
 * every check {@link detectMetadataProviderOutage} already claims, so a
 * provider outage is never counted twice across the two checks. The same
 * detector `metadata-dependency` relies on is reused verbatim rather than
 * re-derived, so the two can never disagree about which checks are metadata
 * checks.
 *
 * That deferral is CONDITIONAL on `metadata-dependency` actually being
 * selected: it is the sole reporter of those checks, so deferring to a check
 * that never ran (`--check operation-safety`) would drop a metadata-provider
 * error from the report entirely and let the `--fail-on` gate read clean.
 *
 * Artists with no root folder are then reported as one aggregate warning: they
 * cannot receive imports, and a library-wide occurrence usually means an
 * unmounted root rather than a per-artist mistake. A blank path counts as
 * unrooted — the boundary projector preserves `""`, and an empty path is
 * precisely the unrooted case.
 *
 * @param gathered - Slots gathered by the audit action.
 * @param selected - The run's full check selection, used to decide whether the
 *   metadata-provider deferral applies.
 * @returns Frozen findings: translated health checks, then unrooted artists.
 * @throws {Error} When the required `health` or `artists` slot is unavailable.
 */
export function evaluateOperationSafety(
  gathered: LidarrAuditGatheredData,
  selected: ReadonlySet<LidarrAuditCheckId>,
): readonly LidarrAuditFinding[] {
  const report = requireSlotData(gathered.health, "operation-safety", "health");
  const artists = requireSlotData(gathered.artists, "operation-safety", "artists");
  const findings: LidarrAuditFinding[] = [];

  const checks = [...report.errors, ...report.warnings];
  const claimedByMetadataDependency = new Set<LidarrHealthCheck>(
    selected.has("metadata-dependency") ? detectMetadataProviderOutage(checks) : [],
  );

  for (const check of checks) {
    if (claimedByMetadataDependency.has(check)) {
      continue;
    }
    const severity = translateHealthSeverity(check.type);
    if (severity === undefined) {
      continue;
    }
    findings.push(buildHealthCheckFinding(check, severity));
  }

  const unrooted = artists.filter(
    (artist) => artist.path === undefined || artist.path.trim() === "",
  );
  if (unrooted.length > 0) {
    const subjects: readonly LidarrAuditSubject[] = unrooted.map(toArtistSubject);
    findings.push(
      createLidarrAuditFinding({
        checkId: "operation-safety",
        code: "artist-missing-root-path",
        severity: "warning",
        summary: `${unrooted.length} artist(s) have no root folder assigned`,
        subjects,
        evidence: { artistCount: unrooted.length },
        remediation: {
          action:
            "Assign a root folder to the artist in Lidarr; no CLI surface assigns one today. An unrooted artist silently accepts monitoring changes but can never receive an import.",
          command: ARTIST_LIST_COMMAND,
        },
      }),
    );
  }

  return Object.freeze(findings);
}

/**
 * Builds the finding one non-closed or unreadable circuit produces.
 *
 * @param scope - Circuit scope (`lidarr` transport or `metadata` provider).
 * @param code - Which circuit condition is being reported.
 * @param severity - Audit severity for that condition.
 * @param summary - Operator-facing one-liner.
 * @param action - Remediation prose.
 * @param evidence - Flat scalar evidence for this circuit.
 * @returns The circuit finding.
 */
function buildCircuitFinding(
  scope: string,
  code: "circuit-open" | "circuit-half-open" | "circuit-state-unknown",
  severity: LidarrAuditSeverity,
  summary: string,
  action: string,
  evidence: Readonly<Record<string, string | number | boolean>>,
): LidarrAuditFinding {
  return createLidarrAuditFinding({
    checkId: "retry-backlog",
    code,
    severity,
    summary,
    subjects: [{ kind: "queue", scope }],
    affected: 1,
    evidence,
    remediation: { action, command: HEALTH_COMMAND },
  });
}

/**
 * Evaluates `retry-backlog`: is the resilience layer holding work back?
 *
 * Circuit entries are reported per scope. An `open` circuit is critical because
 * calls are being rejected outright; `half-open` is a warning because a single
 * probe is in flight; and `{ state: "unknown", reason }` is surfaced as `info`
 * with the reason quoted verbatim — an unreadable circuit is explicitly NOT
 * treated as healthy, which is the whole point of the snapshot modelling it as
 * a distinct state.
 *
 * Deferred intents are then reported from the zero-filled status counts:
 * `failed` rows are critical because that work is permanently dropped, while
 * `pending` rows are a warning enriched with the oldest-pending age, the
 * overdue count, and the near-exhaustion count when the per-row detail read
 * succeeded. That enrichment is windowed while `pending` itself is exact, so
 * the window and its truncation flag ride along in the evidence and, when the
 * window did truncate, in the remediation prose — a lower bound is only useful
 * if it is labelled as one. If the detail read failed outright, its reason
 * ships as its own `info` finding rather than being folded into the pending
 * finding, so the operator can tell "no detail" from "no backlog".
 *
 * @param gathered - Slots gathered by the audit action.
 * @returns Frozen findings: circuits in snapshot order, then queue depth.
 * @throws {Error} When the required `queue` slot is unavailable.
 */
export function evaluateRetryBacklog(
  gathered: LidarrAuditGatheredData,
): readonly LidarrAuditFinding[] {
  const queue = requireSlotData(gathered.queue, "retry-backlog", "queue");
  const findings: LidarrAuditFinding[] = [];

  for (const circuit of queue.circuits) {
    const evidence: Record<string, string | number | boolean> = { scope: circuit.scope };
    if (circuit.retryAtIso !== undefined) {
      evidence["retryAtIso"] = circuit.retryAtIso;
    }
    const circuitState = circuit.state;

    switch (circuitState.state) {
      case "closed":
        break;
      case "open": {
        evidence["openedAt"] = circuitState.openedAt;
        evidence["cooldownMs"] = circuitState.cooldownMs;
        evidence["reason"] = circuitState.reason;
        findings.push(
          buildCircuitFinding(
            circuit.scope,
            "circuit-open",
            "critical",
            `The ${circuit.scope} circuit is open and rejecting calls`,
            circuit.retryAtIso === undefined
              ? "Calls are rejected until the cooldown elapses; automatic retries resume once the circuit admits a probe."
              : `Calls are rejected until the cooldown elapses; automatic retries resume at ${circuit.retryAtIso}.`,
            evidence,
          ),
        );
        break;
      }
      case "half-open": {
        evidence["probeStartedAt"] = circuitState.probeStartedAt;
        evidence["reason"] = circuitState.reason;
        findings.push(
          buildCircuitFinding(
            circuit.scope,
            "circuit-half-open",
            "warning",
            `The ${circuit.scope} circuit is half-open and admitting a single probe`,
            "One probe decides whether the circuit closes or re-opens; no action is needed unless it keeps re-opening.",
            evidence,
          ),
        );
        break;
      }
      case "unknown": {
        evidence["reason"] = circuitState.reason;
        findings.push(
          buildCircuitFinding(
            circuit.scope,
            "circuit-state-unknown",
            "info",
            `The ${circuit.scope} circuit state could not be read`,
            `The persisted circuit state is unreadable, so it is reported as unknown rather than healthy: ${circuitState.reason}`,
            evidence,
          ),
        );
        break;
      }
      default: {
        const exhaustive: never = circuitState;
        throw new Error(`Unhandled circuit state: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  const queueSubjects: readonly LidarrAuditSubject[] = [
    { kind: "queue", scope: DEFERRED_QUEUE_SCOPE },
  ];

  if (queue.counts.failed > 0) {
    findings.push(
      createLidarrAuditFinding({
        checkId: "retry-backlog",
        code: "deferred-intents-failed",
        severity: "critical",
        summary: `${queue.counts.failed} deferred intent(s) exhausted their retry attempts`,
        subjects: queueSubjects,
        affected: queue.counts.failed,
        evidence: { failed: queue.counts.failed },
        remediation: {
          action: `${queue.counts.failed} deferred intents exhausted their attempts and will not replay; re-issue the originating operation.`,
          command: HEALTH_COMMAND,
        },
      }),
    );
  }

  if (queue.counts.pending > 0) {
    const evidence: Record<string, string | number | boolean> = { pending: queue.counts.pending };
    if (queue.oldestPendingAgeSeconds !== undefined) {
      evidence["oldestPendingAgeSeconds"] = queue.oldestPendingAgeSeconds;
    }
    if (queue.overdue !== undefined) {
      evidence["overdue"] = queue.overdue;
    }
    if (queue.nearExhaustion !== undefined) {
      evidence["nearExhaustion"] = queue.nearExhaustion;
    }
    const detailWindow = queue.detailWindow;
    if (detailWindow !== undefined) {
      evidence["detailWindow"] = detailWindow;
      evidence["detailTruncated"] = queue.detailTruncated === true;
    }
    // `overdue` / `nearExhaustion` come from a bounded window over the oldest
    // pending rows while `pending` is an exact aggregate, so a truncated window
    // must say so: otherwise a consumer reads a windowed numerator against an
    // exact denominator and under-reports the backlog.
    const truncationNote =
      queue.detailTruncated === true && detailWindow !== undefined
        ? ` Only the oldest ${detailWindow} pending intents were inspected, so the overdue and near-exhaustion counts are lower bounds.`
        : "";
    findings.push(
      createLidarrAuditFinding({
        checkId: "retry-backlog",
        code: "deferred-intents-pending",
        severity: "warning",
        summary: `${queue.counts.pending} deferred intent(s) are waiting to replay`,
        subjects: queueSubjects,
        affected: queue.counts.pending,
        evidence,
        remediation: {
          action: `Replay is automatic with exponential backoff (30 s base, 1 h cap); a backlog that never drains means the origin is still failing.${truncationNote}`,
          command: HEALTH_COMMAND,
        },
      }),
    );
  }

  if (queue.detailUnavailableReason !== undefined) {
    findings.push(
      createLidarrAuditFinding({
        checkId: "retry-backlog",
        code: "queue-detail-unavailable",
        severity: "info",
        summary: "Deferred-intent detail could not be read",
        subjects: queueSubjects,
        affected: 1,
        evidence: { reason: queue.detailUnavailableReason },
        remediation: {
          action: `Queue counts above may be incomplete: ${queue.detailUnavailableReason}`,
          command: HEALTH_COMMAND,
        },
      }),
    );
  }

  return Object.freeze(findings);
}

/**
 * Evaluates `plex-connectivity`: can the configured media server be reached,
 * and does it expose the music library the operator named?
 *
 * An unreachable server is critical when the failure locks the operator out
 * (`authentication`, `authorization`, `network`, `timeout`) and a warning
 * otherwise. A reachable server exposing zero music libraries is a legitimate
 * warning rather than a transport error, because the adapter drops non-music
 * sections. A configured library name that does not resolve surfaces the
 * adapter's own message verbatim as `evidence.available`, since that message
 * already lists the available titles — the operator can fix the setting without
 * running a second command.
 *
 * This evaluator performs no matching between Plex and Lidarr entities; that is
 * the reserved `plex-alignment` slot's job and needs a join key that does not
 * exist yet.
 *
 * @param gathered - Slots gathered by the audit action.
 * @returns Frozen findings; at most one reachability finding, then library findings.
 * @throws {Error} When the required `plex` slot is unavailable.
 */
export function evaluatePlexConnectivity(
  gathered: LidarrAuditGatheredData,
): readonly LidarrAuditFinding[] {
  const probe = requireSlotData(gathered.plex, "plex-connectivity", "plex");
  const findings: LidarrAuditFinding[] = [];

  if (!probe.reachable) {
    findings.push(
      createLidarrAuditFinding({
        checkId: "plex-connectivity",
        code: "plex-unreachable",
        severity: PLEX_CRITICAL_ERROR_CODES.has(probe.code) ? "critical" : "warning",
        summary: `Plex could not be reached (${probe.code})`,
        subjects: [{ kind: "media-server" }],
        affected: 1,
        evidence: { code: probe.code, message: probe.message },
        remediation: {
          action:
            "Set `plex.url` / `plex.token` in config or pass `--plex-url` / `--plex-token`, then confirm the server answers from this host.",
          command: PLEX_READ_COMMAND,
        },
      }),
    );
    return Object.freeze(findings);
  }

  if (probe.libraries.length === 0) {
    findings.push(
      createLidarrAuditFinding({
        checkId: "plex-connectivity",
        code: "plex-no-music-library",
        severity: "warning",
        summary: "Plex is reachable but exposes no music library",
        subjects: [{ kind: "media-server" }],
        affected: 1,
        evidence: { libraryCount: 0 },
        remediation: {
          action:
            "No music library is exposed by this Plex server. Add one, or point `plex.url` at the server that holds the music sections.",
          command: PLEX_READ_COMMAND,
        },
      }),
    );
  }

  if (probe.configuredLibraryResolved === false) {
    const evidence: Record<string, string | number | boolean> = {
      libraryCount: probe.libraries.length,
    };
    if (probe.configuredLibraryName !== undefined) {
      evidence["configuredLibraryName"] = probe.configuredLibraryName;
    }
    if (probe.resolutionDetail !== undefined) {
      evidence["available"] = probe.resolutionDetail;
    }
    findings.push(
      createLidarrAuditFinding({
        checkId: "plex-connectivity",
        code: "plex-library-name-unresolved",
        severity: "warning",
        summary: `Configured Plex library "${probe.configuredLibraryName ?? ""}" does not resolve`,
        subjects: [{ kind: "media-server", library: probe.configuredLibraryName }],
        affected: 1,
        evidence,
        remediation: {
          action:
            "Correct `plex.libraryName` to one of the titles listed in the evidence; scan-after-copy targets this library by name.",
          command: PLEX_READ_COMMAND,
        },
      }),
    );
  }

  return Object.freeze(findings);
}
