/**
 * Contracts for contextual plan annotations (issue #152).
 *
 * These types are serialized into saved plans and into the `rfapps.plan` MCP
 * result, so every addition must be mirrored in `src/mcp/schema.ts`.
 */

/** Versioned marker for the annotation payload. Mirrors the RECONCILE_SCHEMA_VERSION idiom. */
export const PLAN_INTELLIGENCE_SCHEMA_VERSION = "plan-intelligence.v1" as const;

/** Maximum reasons retained per service. */
export const MAX_CHANGE_REASONS = 8;
/** Maximum evidence strings retained per reason. */
export const MAX_REASON_EVIDENCE = 6;
/** Maximum dependent names listed per service. */
export const MAX_IMPACT_DEPENDENTS = 10;
/** Maximum changing-dependency names listed per service. */
export const MAX_CHANGING_DEPENDENCIES = 6;
/** Newest saved plans examined when searching for a scope-compatible baseline. */
export const MAX_BASELINE_CANDIDATES = 10;

/**
 * Stable reason identifiers.
 *
 * Declared as a tuple so `ChangeReasonCode` and the MCP `schemaEnum` are
 * derived from ONE list; adding a code without updating the schema is then a
 * compile error rather than a runtime `No union variant matched at $`.
 */
export const CHANGE_REASON_CODES = [
  // trigger -- explains `ServiceChange.changeType`
  "container-not-running",
  "image-reference-changed",
  "environment-changed",
  "ports-changed",
  "volumes-changed",
  "networks-changed",
  // provenance -- explains where the change originated (needs a baseline)
  "compose-file-edited",
  "resolved-config-changed",
  "unchanged-since-baseline",
  // advisory -- notable, never drives `changeType`
  "registry-image-drifted",
] as const;

export type ChangeReasonCode = (typeof CHANGE_REASON_CODES)[number];

/** What a reason explains. */
export type ChangeReasonKind = "trigger" | "provenance" | "advisory";

/**
 * How firmly a reason is established.
 *
 * `confirmed` -- two observed values were compared directly.
 * `inferred`  -- partial evidence that cannot exclude an alternative cause;
 *                the alternatives are always named in `summary`.
 */
export type ReasonConfidence = "confirmed" | "inferred";

/**
 * One ranked explanation.
 *
 * Deliberately a flat record with a literal-union `code` rather than a
 * ten-variant payload union: `schemaUnion` failures report only
 * `No union variant matched at $`, which would make schema drift undebuggable.
 */
export interface ChangeReason {
  /** Stable machine-readable identifier. */
  code: ChangeReasonCode;
  /** Whether this explains the change type, its origin, or is advisory. */
  kind: ChangeReasonKind;
  /** Whether the reason was proven by direct comparison or inferred. */
  confidence: ReasonConfidence;
  /**
   * True when this dimension alone forced `ServiceChange.changeType` under the
   * `determineChangeType` cascade. Always false for provenance and advisory.
   */
  decisive: boolean;
  /** Canned operator sentence. Never interpolated with a resolved config value. */
  summary: string;
  /**
   * Bounded, secret-free facts: environment variable NAMES (with change type,
   * never the value), image references, `host:container/proto` port mappings,
   * `source:target[:ro]` volume mounts, network and service names,
   * hash/digest prefixes, ISO timestamps.
   *
   * The enforced invariant is narrower than "no values": an `EnvChange.current`
   * or `EnvChange.desired` value is never copied into evidence, because
   * `isSecretEnvVar` is a substring heuristic that cannot be trusted to redact
   * them. Other dimensions quote the declaration verbatim, so a volume source
   * does appear as a host path.
   */
  evidence: string[];
}

/** What applying this service's change does to its container. */
export type ServiceEffect =
  /** Nothing is applied for this service. */
  | "none"
  /** No container exists; one is created. */
  | "create"
  /** The running container is stopped and replaced (update, recreate, delete). */
  | "replace";

/** Declared-dependency impact. Derived from Compose only; no state, no Docker calls. */
export interface ServiceImpact {
  /** Effect on this service's own container. */
  effect: ServiceEffect;
  /** True when `profiles.mapping[service] === "core"`. */
  critical: boolean;
  /**
   * Size of the transitive set of services that declare `depends_on` (or
   * `network_mode: service:`) onto this one, excluding itself.
   *
   * Compose `depends_on` governs start ordering, NOT runtime coupling: these
   * services are not restarted by `rfapps apply`.
   */
  dependentCount: number;
  /** Sorted sample of that set, capped at `MAX_IMPACT_DEPENDENTS`. */
  dependents: string[];
  /** True when `dependents` omits names beyond the cap. */
  dependentsTruncated: boolean;
  /** Subset of the transitive set that currently has a running container. */
  runningDependentCount: number;
  /** Direct dependencies that this plan also replaces, sorted, capped. */
  changingDependencies: string[];
}

/** Annotations for one service. */
export interface ServiceIntelligence {
  /** Ranked reasons, decisive triggers first. Never empty. */
  reasons: ChangeReason[];
  /** Declared-dependency impact. */
  impact: ServiceImpact;
}

/** Why no usable baseline was found. */
export type BaselineUnavailableReason =
  /** No saved plan matched this compose path and profile set. */
  | "no-comparable-plan"
  /** The plan directory could not be read. */
  | "plan-history-unreadable";

/** How change origin was resolved for this plan. */
export type PlanProvenance =
  | {
      /** Discriminant */
      baseline: "none";
      reason: BaselineUnavailableReason;
    }
  | {
      /** Discriminant */
      baseline: "previous-plan";
      /** `DeploymentPlan.id` of the baseline. */
      planId: string;
      /** ISO 8601 `createdAt` of the baseline. */
      createdAt: string;
      /** True when the compose file's current text differs from the baseline `composeHash`. */
      composeFileChanged: boolean;
    };

/** Plan-wide rollup. */
export interface PlanIntelligenceSummary {
  /** Services carrying at least one reason. */
  annotatedServices: number;
  /**
   * Distinct services that transitively declare `depends_on` a service whose
   * `effect` is not `none`, EXCLUDING services that are themselves changing.
   * Computed as a set difference, so it can never be negative.
   */
  downstreamImpacted: number;
  /** Annotated services mapped to the `core` profile. */
  criticalServices: number;
  /** Most frequent reason code across annotated services, when one exists. */
  dominantReason?: ChangeReasonCode;
}

/** Contextual annotations attached to a deployment plan. Present only with `--explain`. */
export interface PlanIntelligence {
  /** Versioned contract marker. */
  schemaVersion: typeof PLAN_INTELLIGENCE_SCHEMA_VERSION;
  /** How change origin was resolved. */
  provenance: PlanProvenance;
  /** True when `--check-updates` ran; false means registry drift was NOT evaluated. */
  registryChecked: boolean;
  /**
   * False when `docker compose ps` failed and no runtime state could be
   * observed. All `container-not-running` reasons are suppressed in that case.
   */
  runtimeStateObserved: boolean;
  /** Annotations keyed by service name. Only services with at least one reason appear. */
  services: Record<string, ServiceIntelligence>;
  /** Plan-wide rollup. */
  summary: PlanIntelligenceSummary;
}

// ---------------------------------------------------------------------------
// Inputs. Never serialized into a plan, so `readonly` is safe here.
// ---------------------------------------------------------------------------

/**
 * Diff dimension that can force a change type.
 *
 * Build-time only: consumed by `determineChangeType` and
 * `PlanIntelligenceBuildInput`, never serialized into a plan, and therefore
 * deliberately NOT mirrored in `src/mcp/schema.ts`.
 */
export type ChangeDimension =
  | "runtime"
  | "image"
  | "environment"
  | "ports"
  | "volumes"
  | "networks";

/** Baseline facts for one service, lifted from a prior saved plan. */
export interface PlanBaselineService {
  /** `ServiceChange.resolvedConfigFingerprint` from the baseline plan (64 hex). */
  readonly resolvedConfigFingerprint: string;
}

/** A scope-compatible prior plan used for change-origin attribution. */
export interface PlanBaseline {
  readonly planId: string;
  readonly createdAt: string;
  /** True when the compose file's current text differs from the baseline `composeHash`. */
  readonly composeFileChanged: boolean;
  readonly services: Readonly<Record<string, PlanBaselineService>>;
}

/** Result of attempting to load a baseline. Always resolves; never throws. */
export type PlanBaselineResult =
  | { /** Discriminant */ status: "loaded"; baseline: PlanBaseline }
  | { /** Discriminant */ status: "unavailable"; reason: BaselineUnavailableReason };

/** Caller-supplied enrichment. Presence of this object is what enables annotation. */
export interface PlanIntelligenceInput {
  /** `RfappsConfig.profiles.mapping`, for the `core` criticality tier. */
  readonly profileMapping: Readonly<Record<string, string>>;
  /** Change-origin baseline. */
  readonly baseline: PlanBaselineResult;
}
