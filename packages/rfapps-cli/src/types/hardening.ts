/**
 * Compose security hardening contracts for rfapps CLI.
 *
 * Harden proposes (and optionally writes) remediations for the same compose
 * posture that `rfapps lint` and `rfapps audit` report. Rule ids are namespaced
 * `harden-*` so they never collide with LintRuleId or AuditRuleId.
 */

import type { OutputFormat } from "@rfmedia/common";

import type { AuditRuleId } from "./audit.js";
import type { LintRuleId } from "./lint.js";
import type { ComposeOptions, GlobalOptions, ServiceTargetOptions } from "./options.js";

export const HARDEN_SCHEMA_VERSION = "harden.v1" as const;

/** Severity of a harden proposal. Mirrors lint severity vocabulary. */
export type HardenSeverity = "error" | "warn" | "info";

/** Posture area a harden rule belongs to. */
export type HardenCategory =
  | "capabilities"
  | "identity"
  | "filesystem"
  | "logging"
  | "limits"
  | "health"
  | "availability";

/**
 * How a proposal may be written.
 *  safe      -> mechanical and workload-neutral; eligible for --apply by default
 *  review    -> can break the workload; excluded from every write unless --include-review
 *  advisory  -> no safe automatic value exists; never written, ever
 */
export type HardenConfidence = "safe" | "review" | "advisory";

/** Namespaced so they never collide with LintRuleId or AuditRuleId. */
export type HardenRuleId =
  | "harden-no-new-privileges"
  | "harden-cap-drop-all"
  | "harden-log-rotation"
  | "harden-restart-policy"
  | "harden-read-only-rootfs"
  | "harden-run-as-non-root"
  | "harden-healthcheck"
  | "harden-memory-limit"
  | "harden-cpu-limit";

/** What the run did with its proposals. */
export type HardenMode = "propose" | "override" | "apply";

/** JSON-serializable compose value. Recursive, never `any`. */
export type HardenPatchValue =
  | string
  | number
  | boolean
  | readonly HardenPatchValue[]
  | { readonly [key: string]: HardenPatchValue };

/**
 * The two operations the YAML engine understands.
 *  set          -> overwrite (or create) the node at key
 *  merge-unique -> union a sequence into an existing sequence, order-preserving
 */
export type HardenPatchOperation = "set" | "merge-unique";

/**
 * One compose edit.
 *
 * INVARIANT: `key` is a single top-level key under `services.<name>`. Nested
 * paths are forbidden by design (alias/merge hazard) and asserted by
 * hardening.spec.ts; a rule needing a nested write must be `advisory` instead.
 */
export interface HardenPatch {
  /** Single top-level key under `services.<name>`. */
  readonly key: string;
  /** How the value is written into the document. */
  readonly operation: HardenPatchOperation;
  /** Must be an array of scalars for "merge-unique". */
  readonly value: HardenPatchValue;
  /** One-line human rendering, e.g. `security_opt += ["no-new-privileges:true"]`. */
  readonly description: string;
}

/** Declarative harden rule metadata. */
export interface HardenRule {
  /** Unique namespaced rule identifier. */
  readonly id: HardenRuleId;
  /** Posture area this rule covers. */
  readonly category: HardenCategory;
  /** Default severity when the rule fires. */
  readonly severity: HardenSeverity;
  /** Default write eligibility when the rule fires. */
  readonly confidence: HardenConfidence;
  /** Short human-readable title. */
  readonly title: string;
  /** Why this rule exists. */
  readonly rationale: string;
  /** What an operator should do about it. */
  readonly guidance: string;
  /** Provenance: the lint/audit rule this remediates. Keeps the catalogs coherent. */
  readonly detects: { readonly lint?: LintRuleId; readonly audit?: AuditRuleId };
}

/** One fired rule against one service, with the edits that would satisfy it. */
export interface HardenProposal {
  /** Rule that produced this proposal. */
  readonly ruleId: HardenRuleId;
  /** Service name from resolved compose configuration. */
  readonly service: string;
  /** Posture area inherited from the rule. */
  readonly category: HardenCategory;
  /** Severity inherited from the rule. */
  readonly severity: HardenSeverity;
  /** Effective write eligibility (a detector may downgrade the rule default). */
  readonly confidence: HardenConfidence;
  /** Short human-readable title. */
  readonly title: string;
  /** Why this rule exists. */
  readonly rationale: string;
  /** What an operator should do about it. */
  readonly guidance: string;
  /** Provenance of the underlying lint/audit rule. */
  readonly detects: { readonly lint?: LintRuleId; readonly audit?: AuditRuleId };
  /** Why the rule fired, in operator language. */
  readonly evidence: readonly string[];
  /** Extra caution, e.g. "plex has writable bind mounts". */
  readonly note?: string;
  /** Empty for advisory proposals. */
  readonly patches: readonly HardenPatch[];
}

/** Why a patch was withheld rather than written. */
export type HardenRefusalCode =
  /** The target key is a YAML alias (*anchor); editing it would change every sharer. */
  | "alias-target"
  /** The service is absent from the compose document. */
  | "service-missing"
  /** The existing node is not the kind the operation requires. */
  | "unexpected-node"
  /** Defensive: a patch declared a nested path. Should be unreachable. */
  | "nested-path";

/** A patch the engine declined to write, with the safe alternative. */
export interface HardenRefusal {
  /** Machine-readable refusal reason. */
  readonly code: HardenRefusalCode;
  /** Service the refused patch targeted, or "*" for a document-level refusal. */
  readonly service: string;
  /** Rule the refused patch came from, or "*" for a document-level refusal. */
  readonly ruleId: HardenRuleId | "*";
  /** Human-readable explanation of what blocked the write. */
  readonly detail: string;
  /** What to do instead. Always populated. */
  readonly alternative: string;
}

/** One `harden.ignore[]` entry from configuration. */
export interface HardenSuppression {
  /** Rule id to suppress, or "*" for every rule. */
  readonly rule: HardenRuleId | "*";
  /** Service to scope the suppression to; omit to suppress everywhere. */
  readonly service?: string;
  /** Optional: suppressing "add a healthcheck" needs no justification trail. */
  readonly reason?: string;
}

/** Aggregate counts for one harden run. */
export interface HardenSummary {
  /** Proposals surviving suppression. */
  readonly total: number;
  /** Proposals with safe confidence. */
  readonly safe: number;
  /** Proposals with review confidence. */
  readonly review: number;
  /** Proposals with advisory confidence. */
  readonly advisory: number;
  /** Proposals removed by configuration suppressions. */
  readonly suppressed: number;
  /** Distinct services with at least one proposal. */
  readonly servicesAffected: number;
  /** Patches actually written. Always 0 in propose mode. */
  readonly applied: number;
  /** Patches the engine refused to write. */
  readonly refused: number;
}

/** What the run evaluated. */
export interface HardenScope {
  /** Explicit service targets, empty when every service was evaluated. */
  readonly services: readonly string[];
  /** Compose profiles in effect. */
  readonly profiles: readonly string[];
  /** Path of the compose file the resolved configuration came from. */
  readonly composePath: string;
}

/** Disclosure of serialization churn --apply would introduce on untouched lines. */
export interface HardenReformat {
  /** True when parse -> canonical serialize is not byte-identical to the source. */
  readonly wouldReformat: boolean;
  /**
   * Signed line-count delta of the canonical serialization minus the source.
   * Negative when the canonical serializer collapses a multi-line flow sequence
   * onto one line (the only reformat this repo's compose.yml triggers).
   */
  readonly lineDelta: number;
}

/** Discriminated record of what, if anything, the run wrote. */
export type HardenWriteOutcome =
  | { readonly mode: "propose" }
  | { readonly mode: "override"; readonly path: string; readonly patchesWritten: number }
  | {
      readonly mode: "apply";
      readonly path: string;
      readonly backupPath?: string;
      readonly patchesWritten: number;
      readonly servicesPatched: readonly string[];
    };

/** Full machine-readable result of `rfapps harden`. */
export interface HardenResult {
  /** Schema version of this payload. */
  readonly schemaVersion: typeof HARDEN_SCHEMA_VERSION;
  /** ISO 8601 timestamp of the run. */
  readonly timestamp: string;
  /** What the run did with its proposals. */
  readonly mode: HardenMode;
  /** Whether review-confidence proposals were eligible for writing. */
  readonly includeReview: boolean;
  /** What the run evaluated. */
  readonly scope: HardenScope;
  /** Aggregate counts. */
  readonly summary: HardenSummary;
  /** Proposals sorted confidence -> service -> declaration order. */
  readonly proposals: readonly HardenProposal[];
  /** Patches the engine declined to write. */
  readonly refusals: readonly HardenRefusal[];
  /** Serialization churn disclosure. */
  readonly reformat: HardenReformat;
  /** Compose override document holding the writable patches. "" when none. */
  readonly override: string;
  /** What, if anything, was written. */
  readonly write: HardenWriteOutcome;
}

/** `harden:` section of rfapps.config.yaml. */
export interface HardenConfig {
  /** Suppressions applied before proposals are emitted. */
  readonly ignore?: readonly HardenSuppression[];
  /** Rule allowlist; omit or leave empty to run the full catalog. */
  readonly rules?: readonly HardenRuleId[];
  /** Make review-confidence proposals writable by default. */
  readonly includeReview?: boolean;
  /** Take a compose.yml.bak before --apply. Default true. */
  readonly backup?: boolean;
}

/** Combined options for the harden command. */
export interface HardenOptions extends GlobalOptions, ServiceTargetOptions, ComposeOptions {
  /** Write patches back into the compose file. */
  readonly apply: boolean;
  /** Emit a compose override fragment at this path instead of patching in place. */
  readonly overridePath?: string;
  /** Include review-confidence proposals in writes. */
  readonly includeReview: boolean;
  /** Rule allowlist; omit to run the full catalog. */
  readonly rules?: readonly HardenRuleId[];
  /** Take a backup before --apply. */
  readonly backup: boolean;
  /** Permit --apply even when serialization would reformat untargeted lines. */
  readonly allowReformat: boolean;
  /** Output format for structured output. */
  readonly output?: OutputFormat;
}

// --- Harden's own structural view of a resolved compose service. Local by
// --- convention (a third view alongside LintComposeService and
// --- AuditComposeService). Array members are intentionally MUTABLE so this type
// --- stays assignable to LintComposeService, which the reused lint-context
// --- predicates require. Do not add `readonly` to any array type here.

/** Long-form volume mount entry from resolved compose configuration. */
export interface HardenComposeVolumeMount {
  /** Mount path inside the container. */
  readonly target?: string;
  /** Whether the mount is read-only. */
  readonly read_only?: boolean;
  /** Bind mount options. */
  readonly bind?: { readonly create_host_path?: boolean };
}

/** Compose service fields inspected by harden rules. */
export interface HardenComposeService {
  /** Container image reference. */
  readonly image?: string;
  /** Build configuration; presence only, never inspected. */
  readonly build?: unknown;
  /** Restart policy (e.g. "unless-stopped"). */
  readonly restart?: string;
  /** User to run as. */
  readonly user?: string;
  /** Privileged mode. */
  readonly privileged?: boolean;
  /** Read-only root filesystem. */
  readonly read_only?: boolean;
  /** Security options (e.g. "no-new-privileges:true"). */
  readonly security_opt?: string[];
  /** Capabilities to add. */
  readonly cap_add?: string[];
  /** Capabilities to drop. */
  readonly cap_drop?: string[];
  /** Device mappings. */
  readonly devices?: string[];
  /** Volume mounts (short or long syntax). */
  readonly volumes?: (string | HardenComposeVolumeMount)[];
  /** Log driver configuration. */
  readonly logging?: {
    readonly driver?: string;
    readonly options?: Readonly<Record<string, string>>;
  };
  /** Container health check. */
  readonly healthcheck?: { readonly test?: string | string[] } | null;
  /** Deploy configuration. */
  readonly deploy?: {
    readonly restart_policy?: { readonly condition?: string };
    readonly resources?: {
      readonly limits?: { readonly memory?: string; readonly cpus?: string | number };
    };
  };
}

/** Resolved compose configuration shape for harden evaluation. */
export interface HardenComposeConfig {
  /** Services keyed by service name. */
  readonly services: Readonly<Record<string, HardenComposeService>>;
}
