/**
 * The `rfmedia lidarr audit` engine (issue #211).
 *
 * Pure and synchronous: gathered data in, a frozen {@link LidarrAuditReport}
 * out. Every concern that a single check must NOT own lives here — selection,
 * requirement gating, per-check error isolation, status precedence, summary and
 * coverage accounting — so the evaluators in `./audit-platform-checks.js` and
 * `./audit-library-checks.js` stay trivial functions over already-materialised
 * slots.
 *
 * Three structural guarantees:
 *
 * 1. EVERY registered check appears in `report.checks` exactly once, always,
 *    even when it was deselected or its data was never gathered. A `--json`
 *    consumer can key on ids without probing for their presence.
 * 2. Reserved ids never dispatch an evaluator. {@link EVALUATORS} is keyed on
 *    `LidarrAuditEvaluatedCheckId`, so `plex-alignment` has no unreachable
 *    function body and a newly added evaluated id is a compile error until its
 *    evaluator exists.
 * 3. A throwing evaluator costs exactly one check. It becomes a `check-error`
 *    skip and the report degrades, but every other check still runs.
 *
 * This module MUST NOT statically import `./index.js`: that barrel re-exports
 * `./health.js` and this module's siblings, so an edge back into it would close
 * an ESM cycle. `shouldFailLidarrAudit` lives in `../../types/lidarr-audit.js`
 * for the mirror-image reason — the command layer applies the exit gate without
 * pulling this evaluator graph (and its tracking-database reach) into a cold
 * start.
 */

import {
  LIDARR_AUDIT_CHECK_DESCRIPTORS,
  LIDARR_AUDIT_CHECK_IDS,
  LIDARR_AUDIT_REQUIREMENTS,
  LIDARR_AUDIT_RESERVED_CHECK_IDS,
  severityRank,
} from "../../types/lidarr-audit.js";
import type {
  LidarrAuditCheckDescriptor,
  LidarrAuditCheckId,
  LidarrAuditCheckResult,
  LidarrAuditCoverage,
  LidarrAuditEvaluatedCheckId,
  LidarrAuditEvaluator,
  LidarrAuditFinding,
  LidarrAuditGatheredData,
  LidarrAuditReport,
  LidarrAuditRequirement,
  LidarrAuditReservedCheckId,
  LidarrAuditSeverity,
  LidarrAuditSkipReason,
  LidarrAuditSlot,
  LidarrAuditSummary,
  LidarrAuditUnavailableReason,
} from "../../types/lidarr-audit.js";
import { LookupNotFoundError } from "../errors.js";
import {
  evaluateDuplicateIdentity,
  evaluateLibraryGaps,
  evaluateMonitoringDrift,
} from "./audit-library-checks.js";
import {
  evaluateMetadataDependency,
  evaluateOperationSafety,
  evaluatePlexConnectivity,
  evaluateRetryBacklog,
} from "./audit-platform-checks.js";

/** Skip detail for a check the operator excluded with `--check`. */
const NOT_SELECTED_DETAIL = "check not included in the --check selection";

/**
 * Skip detail for a reserved check once Plex data is present.
 *
 * Directs operators to the shared reconciliation surface instead of implying
 * that the identity foundation is unavailable.
 */
const RESERVED_IDENTITY_DETAIL =
  "Use `rfmedia lidarr reconcile` for Plex-Lidarr alignment; this audit check remains reserved";

/** Skip detail for a reserved check when Plex is not configured at all. */
const RESERVED_PLEX_NOT_CONFIGURED_DETAIL =
  "Plex is not configured; configure Plex before using `rfmedia lidarr reconcile` for Plex-Lidarr alignment";

/**
 * Every evaluated check's verdict function.
 *
 * Keyed on {@link LidarrAuditEvaluatedCheckId} rather than
 * `LidarrAuditCheckId`: reserved ids are excluded by construction, so this map
 * contains no placeholder that could accidentally be dispatched, while a
 * missing evaluator for a real id fails the build.
 */
const EVALUATORS: Readonly<Record<LidarrAuditEvaluatedCheckId, LidarrAuditEvaluator>> =
  Object.freeze({
    "metadata-dependency": evaluateMetadataDependency,
    "operation-safety": evaluateOperationSafety,
    "retry-backlog": evaluateRetryBacklog,
    "monitoring-drift": evaluateMonitoringDrift,
    "library-gaps": evaluateLibraryGaps,
    "duplicate-identity": evaluateDuplicateIdentity,
    "plex-connectivity": evaluatePlexConnectivity,
  });

/** Membership set behind {@link isLidarrAuditCheckId}. */
const CHECK_ID_SET: ReadonlySet<string> = new Set(LIDARR_AUDIT_CHECK_IDS);

/** Membership set behind {@link isReservedCheckId}. */
const RESERVED_CHECK_ID_SET: ReadonlySet<string> = new Set(LIDARR_AUDIT_RESERVED_CHECK_IDS);

/** Everything {@link runLidarrAudit} needs; the action supplies all of it. */
export interface LidarrAuditRunInput {
  /** When the audit ran (ISO-8601), stamped by the action. */
  readonly checkedAt: string;
  /** Credential-free canonical Lidarr origin. */
  readonly origin: string;
  /** Whether the per-artist album scan ran. */
  readonly deep: boolean;
  /** Ids the operator selected; everything else reports `not-selected`. */
  readonly selected: ReadonlySet<LidarrAuditCheckId>;
  /** One slot per requirement, already gathered. */
  readonly gathered: LidarrAuditGatheredData;
}

/**
 * Narrows an arbitrary string to a registered check id.
 *
 * @param value - Raw `--check` value.
 * @returns True when the value names a registered check.
 */
function isLidarrAuditCheckId(value: string): value is LidarrAuditCheckId {
  return CHECK_ID_SET.has(value);
}

/**
 * Narrows a registered check id to one declared for schema stability only.
 *
 * Because the arms of `LidarrAuditCheckId` are literals, the `else` branch of a
 * call to this guard is narrowed to {@link LidarrAuditEvaluatedCheckId}, which
 * is what makes the {@link EVALUATORS} lookup total without a cast.
 *
 * @param id - A registered check id.
 * @returns True when the id has no evaluator by design.
 */
function isReservedCheckId(id: LidarrAuditCheckId): id is LidarrAuditReservedCheckId {
  return RESERVED_CHECK_ID_SET.has(id);
}

/**
 * Widens a frozen registry entry to the descriptor interface.
 *
 * The registry is declared `as const`, so a direct index yields a union of
 * literal-typed entries whose `requires` / `enriches` tuples cannot be iterated
 * as one. Reading through this helper collapses that union once.
 *
 * @param id - The check id to describe.
 * @returns The descriptor for that id.
 */
function describeCheck(id: LidarrAuditCheckId): LidarrAuditCheckDescriptor {
  return LIDARR_AUDIT_CHECK_DESCRIPTORS[id];
}

/**
 * Reads one gathered slot without caring about its payload type.
 *
 * @param gathered - Slots gathered by the audit action.
 * @param requirement - Which slot to read.
 * @returns The slot, with its data erased to `unknown`.
 */
function readSlot(
  gathered: LidarrAuditGatheredData,
  requirement: LidarrAuditRequirement,
): LidarrAuditSlot<unknown> {
  return gathered[requirement];
}

/** Extracts a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds a `skipped` verdict.
 *
 * @param id - The check id.
 * @param title - The check's registry title.
 * @param skipReason - Machine-readable reason.
 * @param detail - Operator-facing explanation.
 * @returns The frozen verdict.
 */
function skippedCheck(
  id: LidarrAuditCheckId,
  title: string,
  skipReason: LidarrAuditSkipReason,
  detail: string,
): LidarrAuditCheckResult {
  const result: LidarrAuditCheckResult = {
    id,
    title,
    status: "skipped",
    findingCount: 0,
    skipReason,
    detail,
  };
  return Object.freeze(result);
}

/**
 * Decides how a reserved check reports itself.
 *
 * `plex-alignment` skips unconditionally — even with a fully available `plex`
 * slot — because audit activation remains deferred to the shared
 * reconciliation contract. When Plex is not configured either, that more
 * concrete reason is surfaced instead, but both details direct operators to
 * the reconciliation command.
 *
 * @param gathered - Slots gathered by the audit action.
 * @returns The skip reason and its detail.
 */
function resolveReservedSkip(gathered: LidarrAuditGatheredData): {
  readonly reason: LidarrAuditUnavailableReason;
  readonly detail: string;
} {
  const plex = gathered.plex;
  if (plex.status === "unavailable" && plex.reason === "plex-not-configured") {
    return { reason: "plex-not-configured", detail: RESERVED_PLEX_NOT_CONFIGURED_DETAIL };
  }
  return { reason: "identity-mapping-unavailable", detail: RESERVED_IDENTITY_DETAIL };
}

/**
 * Finds the first hard requirement a check cannot satisfy.
 *
 * The unavailable slot's OWN reason and detail are propagated verbatim, so the
 * report explains the absence at its source (`requires-deep`,
 * `plex-not-configured`, `data-unavailable`, …) rather than inventing a
 * per-check message. `enriches` entries are never consulted: they add depth and
 * must not gate.
 *
 * @param gathered - Slots gathered by the audit action.
 * @param requires - The check's hard requirements, in declaration order.
 * @returns The blocking slot's reason and detail, or `undefined` when the check
 *   may run.
 */
function findBlockingRequirement(
  gathered: LidarrAuditGatheredData,
  requires: readonly LidarrAuditRequirement[],
): { readonly reason: LidarrAuditUnavailableReason; readonly detail: string } | undefined {
  for (const requirement of requires) {
    const slot = readSlot(gathered, requirement);
    if (slot.status === "unavailable") {
      return { reason: slot.reason, detail: slot.detail };
    }
  }
  return undefined;
}

/**
 * Reports whether a selected check consumes a slot that failed to load.
 *
 * `data-unavailable` is the only unavailable reason that signals a real
 * failure; every other reason (`not-requested`, `requires-deep`,
 * `plex-not-configured`, `identity-mapping-unavailable`) is an expected absence
 * and must never degrade the report. Both `requires` and `enriches` count as
 * consumption — a soft enrichment that could not be read still means the check
 * rendered its verdict over less data than it asked for.
 *
 * @param gathered - Slots gathered by the audit action.
 * @param descriptor - The selected check's registry entry.
 * @returns True when at least one consumed slot is `data-unavailable`.
 */
function consumesUnavailableData(
  gathered: LidarrAuditGatheredData,
  descriptor: LidarrAuditCheckDescriptor,
): boolean {
  for (const requirement of [...descriptor.requires, ...descriptor.enriches]) {
    const slot = readSlot(gathered, requirement);
    if (slot.status === "unavailable" && slot.reason === "data-unavailable") {
      return true;
    }
  }
  return false;
}

/**
 * Computes how much data actually backed the report.
 *
 * Derived from slot availability ALONE, never from the selection: an
 * unavailable slot contributes `0` (or `null` for the wanted backlog, which
 * distinguishes "not sampled" from "sampled and empty") no matter why it is
 * absent.
 *
 * @param gathered - Slots gathered by the audit action.
 * @returns The frozen coverage block.
 */
function buildCoverage(gathered: LidarrAuditGatheredData): LidarrAuditCoverage {
  const coverage: LidarrAuditCoverage = {
    artistsExamined: gathered.artists.status === "available" ? gathered.artists.data.length : 0,
    albumsExamined: gathered.albums.status === "available" ? gathered.albums.data.albums.length : 0,
    artistsScanned:
      gathered.albums.status === "available" ? gathered.albums.data.artistsScanned : 0,
    wantedTotal: gathered.wanted.status === "available" ? gathered.wanted.data.total : null,
  };
  return Object.freeze(coverage);
}

/**
 * Aggregates findings and check verdicts into the report summary.
 *
 * @param findings - Every finding emitted across the run.
 * @param checks - Every check verdict, in registry order.
 * @returns The frozen summary.
 */
function buildSummary(
  findings: readonly LidarrAuditFinding[],
  checks: readonly LidarrAuditCheckResult[],
): LidarrAuditSummary {
  const counts: Record<LidarrAuditSeverity, number> = { info: 0, warning: 0, critical: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }

  let checksRun = 0;
  let checksSkipped = 0;
  for (const check of checks) {
    if (check.status === "skipped") {
      checksSkipped += 1;
    } else {
      checksRun += 1;
    }
  }

  const summary: LidarrAuditSummary = {
    critical: counts.critical,
    warning: counts.warning,
    info: counts.info,
    total: findings.length,
    checksRun,
    checksSkipped,
    highestSeverity:
      counts.critical > 0
        ? "critical"
        : counts.warning > 0
          ? "warning"
          : counts.info > 0
            ? "info"
            : "none",
  };
  return Object.freeze(summary);
}

/**
 * Runs every registered check and assembles the report.
 *
 * Each id in `LIDARR_AUDIT_CHECK_IDS` is processed in declaration order through
 * the same four gates, in this exact precedence:
 *
 * 1. **Deselected** — not in `input.selected` ⇒ `skipped` / `not-selected`.
 * 2. **Reserved** — an evaluator-less id ⇒ `skipped` with the identity-mapping
 *    (or `plex-not-configured`) reason. No evaluator is ever dispatched.
 * 3. **Requirement gate** — the first `requires` slot that is unavailable ⇒
 *    `skipped` with THAT slot's own reason and detail. `enriches` never gates.
 * 4. **Dispatch** — the evaluator runs behind a `try`/`catch`; a throw becomes
 *    `skipped` / `check-error` carrying the message, and the run continues. The
 *    selection is passed through so a check that defers a condition to a
 *    sibling check can tell whether that sibling actually ran.
 *
 * `report.status` precedence is strict: `degraded` (any `data-unavailable` slot
 * consumed by a selected check, or any `check-error`) outranks `findings`,
 * which outranks `clean`. Expected absences never degrade.
 *
 * @param input - Timestamp, origin, depth, selection, and gathered data.
 * @returns The frozen report, checks in registry declaration order.
 */
export function runLidarrAudit(input: LidarrAuditRunInput): LidarrAuditReport {
  const checks: LidarrAuditCheckResult[] = [];
  const findings: LidarrAuditFinding[] = [];
  let degraded = false;

  for (const id of LIDARR_AUDIT_CHECK_IDS) {
    const descriptor = describeCheck(id);
    const title = descriptor.title;

    if (!input.selected.has(id)) {
      checks.push(skippedCheck(id, title, "not-selected", NOT_SELECTED_DETAIL));
      continue;
    }

    if (consumesUnavailableData(input.gathered, descriptor)) {
      degraded = true;
    }

    if (isReservedCheckId(id)) {
      const reserved = resolveReservedSkip(input.gathered);
      checks.push(skippedCheck(id, title, reserved.reason, reserved.detail));
      continue;
    }

    const blocked = findBlockingRequirement(input.gathered, descriptor.requires);
    if (blocked !== undefined) {
      checks.push(skippedCheck(id, title, blocked.reason, blocked.detail));
      continue;
    }

    let produced: readonly LidarrAuditFinding[];
    try {
      produced = EVALUATORS[id](input.gathered, input.selected);
    } catch (error) {
      degraded = true;
      checks.push(skippedCheck(id, title, "check-error", errorMessage(error)));
      continue;
    }

    const [firstFinding] = produced;
    if (firstFinding === undefined) {
      const passed: LidarrAuditCheckResult = { id, title, status: "pass", findingCount: 0 };
      checks.push(Object.freeze(passed));
      continue;
    }

    let checkSeverity: LidarrAuditSeverity = firstFinding.severity;
    for (const finding of produced) {
      if (severityRank(finding.severity) > severityRank(checkSeverity)) {
        checkSeverity = finding.severity;
      }
    }

    findings.push(...produced);
    const flagged: LidarrAuditCheckResult = {
      id,
      title,
      status: "findings",
      findingCount: produced.length,
      highestSeverity: checkSeverity,
    };
    checks.push(Object.freeze(flagged));
  }

  const report: LidarrAuditReport = {
    checkedAt: input.checkedAt,
    origin: input.origin,
    deep: input.deep,
    status: degraded ? "degraded" : findings.length > 0 ? "findings" : "clean",
    summary: buildSummary(findings, checks),
    checks: Object.freeze(checks),
    findings: Object.freeze(findings),
    coverage: buildCoverage(input.gathered),
  };
  return Object.freeze(report);
}

/**
 * Validates and expands a raw `--check` selection.
 *
 * Validation is duplicated here on purpose: the command layer validates too, so
 * a mistyped id is rejected before the lazy action import, but this function is
 * public and action-reachable and must not trust its caller.
 *
 * An `undefined` selection means "every registered check". An EMPTY array is
 * taken literally — it selects nothing — rather than being silently rewritten
 * to "everything", which would hide a caller that lost its values.
 *
 * @param raw - Raw check ids, or `undefined` to select every registered check.
 * @returns Deduplicated selected ids in registry declaration order.
 * @throws {LookupNotFoundError} On an unknown id; the available values are the
 *   full registry, which the error formatter turns into a "did you mean" hint.
 */
export function resolveLidarrAuditSelection(
  raw: readonly string[] | undefined,
): readonly LidarrAuditCheckId[] {
  if (raw === undefined) {
    return Object.freeze([...LIDARR_AUDIT_CHECK_IDS]);
  }

  const requested = new Set<LidarrAuditCheckId>();
  for (const entry of raw) {
    if (!isLidarrAuditCheckId(entry)) {
      throw new LookupNotFoundError("audit check", entry, [...LIDARR_AUDIT_CHECK_IDS]);
    }
    requested.add(entry);
  }

  return Object.freeze(LIDARR_AUDIT_CHECK_IDS.filter((id) => requested.has(id)));
}

/**
 * Computes the fetch plan for a selection.
 *
 * The registry's `requires` / `enriches` lists are the single source of truth
 * for what the action gathers, which is what makes `--check retry-backlog` cost
 * zero Lidarr round-trips. A requirement that is hard for one selected check
 * and soft for another counts as hard, so it never appears in both sets.
 *
 * Both sets are ordered by `LIDARR_AUDIT_REQUIREMENTS` regardless of the order
 * the caller listed its checks in.
 *
 * @param selected - Selected check ids.
 * @returns Hard requirements and soft enrichments, deduplicated and disjoint.
 */
export function resolveLidarrAuditRequirements(selected: readonly LidarrAuditCheckId[]): {
  readonly required: ReadonlySet<LidarrAuditRequirement>;
  readonly enriched: ReadonlySet<LidarrAuditRequirement>;
} {
  const hard = new Set<LidarrAuditRequirement>();
  const soft = new Set<LidarrAuditRequirement>();

  for (const id of selected) {
    const descriptor = describeCheck(id);
    for (const requirement of descriptor.requires) {
      hard.add(requirement);
    }
    for (const requirement of descriptor.enriches) {
      soft.add(requirement);
    }
  }

  const required = new Set(
    LIDARR_AUDIT_REQUIREMENTS.filter((requirement) => hard.has(requirement)),
  );
  const enriched = new Set(
    LIDARR_AUDIT_REQUIREMENTS.filter(
      (requirement) => soft.has(requirement) && !hard.has(requirement),
    ),
  );

  return Object.freeze({ required, enriched });
}
