/**
 * Contextual plan annotations (issue #152).
 *
 * Turns data the plan generator already holds into ranked `ChangeReason` records
 * plus a declared-dependency `ServiceImpact`, so `rfapps plan --explain` can say
 * *why* a service changed and *what declares `depends_on` it*.
 *
 * PURE: no filesystem, no subprocess, no Docker call, no logging, no exit-code
 * mutation, and `input` is never mutated. The upward dependent traversal is
 * cycle-safe via a visited set.
 *
 * Wording is deliberately weaker than the mechanism suggests: "no running
 * container found" (a stopped container is not inspected), and "the locally
 * cached image ... is behind the registry" (the check compares the local daemon
 * cache, not the running container).
 */

import { buildServiceDependencyGraph, invertDependencyMap } from "./dependency-graph.js";
import {
  CHANGE_REASON_CODES,
  MAX_CHANGE_REASONS,
  MAX_CHANGING_DEPENDENCIES,
  MAX_IMPACT_DEPENDENTS,
  MAX_REASON_EVIDENCE,
  PLAN_INTELLIGENCE_SCHEMA_VERSION,
} from "../types/plan-intelligence.js";

import type { ComposeServiceConfig } from "./docker.js";
import type {
  ChangeDimension,
  ChangeReason,
  ChangeReasonCode,
  ChangeReasonKind,
  PlanBaseline,
  PlanBaselineResult,
  PlanIntelligence,
  PlanProvenance,
  ReasonConfidence,
  ServiceEffect,
  ServiceImpact,
  ServiceIntelligence,
} from "../types/plan-intelligence.js";
import type {
  ChangeType,
  ConfigDiff,
  PortMapping,
  ServiceChange,
  VolumeMapping,
} from "../types/plan.js";

/** Inputs for {@link buildPlanIntelligence}. Never serialized into a plan. */
export interface PlanIntelligenceBuildInput {
  readonly services: readonly ServiceChange[];
  readonly decisiveByService: ReadonlyMap<string, readonly ChangeDimension[]>;
  /** `ComposeConfig.services` already in `generatePlan` scope. */
  readonly composeServices: Readonly<Record<string, ComposeServiceConfig>>;
  /** Compose services with a running container at plan time. */
  readonly runningServices: ReadonlySet<string>;
  /** False when `docker compose ps` failed. */
  readonly runtimeStateObserved: boolean;
  /** True when `--check-updates` ran. */
  readonly registryChecked: boolean;
  readonly profileMapping: Readonly<Record<string, string>>;
  readonly baseline: PlanBaselineResult;
}

/** What each reason code explains. Keyed by the code union so a new code is a compile error. */
const REASON_KIND: Readonly<Record<ChangeReasonCode, ChangeReasonKind>> = {
  "container-not-running": "trigger",
  "image-reference-changed": "trigger",
  "environment-changed": "trigger",
  "ports-changed": "trigger",
  "volumes-changed": "trigger",
  "networks-changed": "trigger",
  "compose-file-edited": "provenance",
  "resolved-config-changed": "provenance",
  "unchanged-since-baseline": "provenance",
  "registry-image-drifted": "advisory",
};

/** Ranking weight per kind: decisive triggers read first. */
const KIND_RANK: Readonly<Record<ChangeReasonKind, number>> = {
  trigger: 0,
  provenance: 1,
  advisory: 2,
};

/** `resolvedServiceConfigFingerprint` output shape; anything else is not comparable. */
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** `sha256:` plus twelve hex characters, the digest prefix used in operator output. */
const DIGEST_PREFIX_LENGTH = 19;

/** Characters of a plan id quoted in a reason summary. */
const PLAN_ID_PREFIX_LENGTH = 8;

/** Characters of a config fingerprint quoted as evidence. */
const FINGERPRINT_PREFIX_LENGTH = 12;

/** Position in `CHANGE_REASON_CODES`; the trigger order mirrors the change-type cascade. */
function codeIndex(code: ChangeReasonCode): number {
  return CHANGE_REASON_CODES.indexOf(code);
}

/**
 * Cap an evidence list at `MAX_REASON_EVIDENCE`, spending the final slot on an
 * explicit `+N more` marker so the total length never exceeds the cap.
 */
function capEvidence(entries: readonly string[]): string[] {
  if (entries.length <= MAX_REASON_EVIDENCE) {
    return [...entries];
  }
  const kept = entries.slice(0, MAX_REASON_EVIDENCE - 1);
  return [...kept, `+${entries.length - kept.length} more`];
}

/** Build one reason, deriving `kind` from the code so the two can never disagree. */
function makeReason(
  code: ChangeReasonCode,
  details: { confidence: ReasonConfidence; decisive: boolean; summary: string },
  evidence: readonly string[] = [],
): ChangeReason {
  return {
    code,
    kind: REASON_KIND[code],
    confidence: details.confidence,
    decisive: details.decisive,
    summary: details.summary,
    evidence: capEvidence(evidence),
  };
}

/** `host:container/proto`, or `container/proto` when no host port is published. */
function formatPort(port: PortMapping): string {
  return port.host === undefined
    ? `${port.container}/${port.protocol}`
    : `${port.host}:${port.container}/${port.protocol}`;
}

/** `source:target[:ro]`. */
function formatVolume(volume: VolumeMapping): string {
  return `${volume.source}:${volume.target}${volume.readonly === true ? ":ro" : ""}`;
}

/**
 * Removed (`- `) then added (`+ `) entries of an array diff, deduplicated and
 * sorted so the same diff always yields the same evidence.
 */
function arrayDiffEvidence<TValue>(
  diff: ConfigDiff<TValue[]>,
  format: (value: TValue) => string,
): string[] {
  const current = (diff.current ?? []).map(format);
  const desired = (diff.desired ?? []).map(format);
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  const removed = [...new Set(current.filter((entry) => !desiredSet.has(entry)))].sort();
  const added = [...new Set(desired.filter((entry) => !currentSet.has(entry)))].sort();
  return [...removed.map((entry) => `- ${entry}`), ...added.map((entry) => `+ ${entry}`)];
}

/**
 * Trigger reasons for one service, in `CHANGE_REASON_CODES` order.
 *
 * `decisive` is never re-derived here: it is true iff `determineChangeType`
 * reported that dimension as the one that forced `changeType`.
 *
 * Two suppressions are mandatory. With `runtimeStateObserved === false` no
 * `container-not-running` reason may be asserted for state that was never
 * observed. And a `create` emits ONLY `container-not-running`, because every
 * `current*` value is `undefined` for a service with no container, which makes
 * all five declaration diffs trivially "changed".
 */
function buildTriggerReasons(
  change: ServiceChange,
  decisive: readonly ChangeDimension[],
  runtimeStateObserved: boolean,
): ChangeReason[] {
  if (change.changeType === "create") {
    if (!runtimeStateObserved) {
      return [];
    }
    return [
      makeReason("container-not-running", {
        confidence: "confirmed",
        decisive: decisive.includes("runtime"),
        summary: "no running container found (a stopped container is not inspected)",
      }),
    ];
  }

  const { image, ports, volumes, networks } = change;
  const reasons: ChangeReason[] = [];
  const add = (
    dimension: ChangeDimension,
    code: ChangeReasonCode,
    summary: string,
    evidence: readonly string[],
  ): void => {
    const decision = { confidence: "confirmed" as const, decisive: decisive.includes(dimension) };
    reasons.push(makeReason(code, { ...decision, summary }, evidence));
  };

  if (image.changed) {
    add("image", "image-reference-changed", "image reference changed", [
      ...(image.current === undefined ? [] : [`current=${image.current}`]),
      ...(image.desired === undefined ? [] : [`desired=${image.desired}`]),
    ]);
  }
  // Environment evidence carries variable NAMES and change type only, never a value.
  const changedEnv = change.environment.filter((entry) => entry.changeType !== "unchanged");
  if (changedEnv.length > 0) {
    add(
      "environment",
      "environment-changed",
      "environment changed",
      changedEnv.map((entry) => `${entry.name} (${entry.changeType})`),
    );
  }
  if (ports.changed) {
    add("ports", "ports-changed", "port mappings changed", arrayDiffEvidence(ports, formatPort));
  }
  if (volumes.changed) {
    const evidence = arrayDiffEvidence(volumes, formatVolume);
    add("volumes", "volumes-changed", "volume mounts changed", evidence);
  }
  if (networks.changed) {
    const evidence = arrayDiffEvidence(networks, (network) => network);
    add("networks", "networks-changed", "network attachments changed", evidence);
  }
  return reasons;
}

/** True for a comparable 64-hex resolved-config fingerprint. */
function isFingerprint(value: string | undefined): value is string {
  return value !== undefined && FINGERPRINT_PATTERN.test(value);
}

/**
 * Provenance reason for one service, or `undefined` when origin cannot be
 * attributed: the service is not changing, no baseline, or no comparable
 * fingerprint on either side.
 *
 * The `unchanged` suppression is mandatory. Provenance explains where a change
 * came from, so a service with no change has no origin to attribute:
 * "this change was already pending when you last planned" is simply false for
 * `effect: "none"`. It is also what keeps a no-op plan a no-op — without it
 * every service matching the baseline is annotated, which inflates the saved
 * plan file by two orders of magnitude and pins `dominantReason` to
 * `unchanged-since-baseline` forever. Registry drift on an `unchanged` service
 * stays reachable: `buildAdvisoryReason` is independent of this function.
 *
 * Both "moved" outcomes are `inferred` and name their alternatives in the
 * summary, because the resolved model also moves on a different secrets tool, a
 * Compose CLI upgrade, or a different profile set.
 */
function buildProvenanceReason(
  change: ServiceChange,
  baselineResult: PlanBaselineResult,
): ChangeReason | undefined {
  if (change.changeType === "unchanged" || baselineResult.status !== "loaded") {
    return undefined;
  }
  const { baseline } = baselineResult;
  const previous = baseline.services[change.service]?.resolvedConfigFingerprint;
  const current = change.resolvedConfigFingerprint;
  if (!isFingerprint(previous) || !isFingerprint(current)) {
    return undefined;
  }

  const planId = baseline.planId.slice(0, PLAN_ID_PREFIX_LENGTH);
  const from = previous.slice(0, FINGERPRINT_PREFIX_LENGTH);
  const to = current.slice(0, FINGERPRINT_PREFIX_LENGTH);
  const origin = (
    code: ChangeReasonCode,
    confidence: ReasonConfidence,
    summary: string,
    movement: string,
  ): ChangeReason =>
    makeReason(code, { confidence, decisive: false, summary }, [
      `baseline plan ${planId} (${baseline.createdAt})`,
      movement,
    ]);

  if (previous === current) {
    return origin(
      "unchanged-since-baseline",
      "confirmed",
      `resolved config unchanged since plan ${planId} — this change was already pending when you last planned`,
      `fingerprint ${from} unchanged`,
    );
  }
  if (baseline.composeFileChanged) {
    return origin(
      "compose-file-edited",
      "inferred",
      `the compose file was edited since plan ${planId} — a simultaneous environment change cannot be excluded, and only the top-level compose file is hashed`,
      `fingerprint ${from} → ${to}`,
    );
  }
  return origin(
    "resolved-config-changed",
    "inferred",
    `resolved config changed since plan ${planId} with the compose file unchanged — likely an environment or secrets-tool input; a Compose CLI upgrade produces the same signal`,
    `fingerprint ${from} → ${to}`,
  );
}

/**
 * Registry advisory for one service.
 *
 * Discriminates on the five-valued `updateStatus`, never on the
 * retained-for-compat boolean, so `unsupported` (build-only), `unknown`, and
 * `local-missing` can never render as drift.
 */
function buildAdvisoryReason(
  change: ServiceChange,
  registryChecked: boolean,
): ChangeReason | undefined {
  const { image } = change;
  if (!registryChecked || image.changed || image.updateStatus !== "update-available") {
    return undefined;
  }
  const canonical = image.canonicalImage ?? image.desired;
  const digest = (label: string, value: string | undefined): string[] =>
    value === undefined ? [] : [`${label}=${value.slice(0, DIGEST_PREFIX_LENGTH)}`];

  return makeReason(
    "registry-image-drifted",
    {
      confidence: "confirmed",
      decisive: false,
      summary: "the locally cached image for this reference is behind the registry",
    },
    [
      ...(canonical === undefined ? [] : [`canonical=${canonical}`]),
      ...digest("local", image.localDigest),
      ...digest("remote", image.remoteDigest),
    ],
  );
}

/** Ascending `[kindRank, decisiveRank, codeIndex]`, truncated at `MAX_CHANGE_REASONS`. */
function rankReasons(reasons: readonly ChangeReason[]): ChangeReason[] {
  return [...reasons]
    .sort((left, right) => {
      const kindDelta = KIND_RANK[left.kind] - KIND_RANK[right.kind];
      const decisiveDelta = (left.decisive ? 0 : 1) - (right.decisive ? 0 : 1);
      return kindDelta || decisiveDelta || codeIndex(left.code) - codeIndex(right.code);
    })
    .slice(0, MAX_CHANGE_REASONS);
}

/** What applying this change does to the service's own container. */
function serviceEffect(changeType: ChangeType): ServiceEffect {
  if (changeType === "unchanged") {
    return "none";
  }
  return changeType === "create" ? "create" : "replace";
}

/**
 * Transitive set of services that declare `depends_on` (or `network_mode:
 * service:`) onto `service`, seed excluded.
 *
 * The visited guard is load-bearing: an unguarded upward traversal hangs the CLI
 * on a `depends_on` cycle, which is a first-class condition elsewhere here.
 */
function transitiveDependents(
  service: string,
  dependents: ReadonlyMap<string, readonly string[]>,
): string[] {
  const visited = new Set<string>([service]);
  const closure = new Set<string>();
  const queue: string[] = [service];

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) {
      continue;
    }
    for (const dependent of dependents.get(current) ?? []) {
      if (visited.has(dependent)) {
        continue;
      }
      visited.add(dependent);
      closure.add(dependent);
      queue.push(dependent);
    }
  }
  return [...closure].sort();
}

/** Shared graph and plan facts every `ServiceImpact` is derived from. */
interface ImpactContext {
  forward: ReadonlyMap<string, readonly string[]>;
  effects: ReadonlyMap<string, ServiceEffect>;
  runningServices: ReadonlySet<string>;
  profileMapping: Readonly<Record<string, string>>;
}

/** Declared-dependency impact for one service. Compose only; no state, no Docker calls. */
function buildImpact(
  change: ServiceChange,
  closure: readonly string[],
  context: ImpactContext,
): ServiceImpact {
  return {
    effect: serviceEffect(change.changeType),
    critical: context.profileMapping[change.service] === "core",
    dependentCount: closure.length,
    dependents: closure.slice(0, MAX_IMPACT_DEPENDENTS),
    dependentsTruncated: closure.length > MAX_IMPACT_DEPENDENTS,
    runningDependentCount: closure.filter((dependent) => context.runningServices.has(dependent))
      .length,
    changingDependencies: [...(context.forward.get(change.service) ?? [])]
      .filter((dependency) => context.effects.get(dependency) === "replace")
      .sort()
      .slice(0, MAX_CHANGING_DEPENDENCIES),
  };
}

/** Plan-level origin record derived from the baseline load result. */
function planProvenance(baselineResult: PlanBaselineResult): PlanProvenance {
  if (baselineResult.status === "unavailable") {
    return { baseline: "none", reason: baselineResult.reason };
  }
  const { planId, createdAt, composeFileChanged }: PlanBaseline = baselineResult.baseline;
  return { baseline: "previous-plan", planId, createdAt, composeFileChanged };
}

/** Most frequent reason code across annotated services; ties broken by `codeIndex`. */
function dominantReasonCode(
  annotated: readonly ServiceIntelligence[],
): ChangeReasonCode | undefined {
  const counts = new Map<ChangeReasonCode, number>();
  for (const intelligence of annotated) {
    for (const reason of intelligence.reasons) {
      counts.set(reason.code, (counts.get(reason.code) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort(
    ([leftCode, leftCount], [rightCode, rightCount]) =>
      rightCount - leftCount || codeIndex(leftCode) - codeIndex(rightCode),
  );
  return ranked[0]?.[0];
}

/**
 * Derive contextual annotations from data the plan generator already holds.
 *
 * PURE: no I/O, no logging, no exit-code mutation, never mutates `input`.
 * Traversal is cycle-safe via a visited set.
 *
 * Services that end with zero reasons are omitted from `services` entirely:
 * presence is meaningful, so an entry exists iff the service has something to
 * say — which is what makes registry drift on an `unchanged` service reachable.
 *
 * @param input - plan facts, runtime observations, and the change-origin baseline
 * @returns annotations for the services carrying at least one reason
 */
export function buildPlanIntelligence(input: PlanIntelligenceBuildInput): PlanIntelligence {
  const {
    baseline,
    composeServices,
    decisiveByService,
    profileMapping,
    registryChecked,
    runningServices,
    runtimeStateObserved,
    services,
  } = input;

  // ALL compose service keys, never the plan's target subset: the graph builder
  // filters dependencies to the target set, so inverting a target-scoped map
  // silently under-reports dependents. The `{}` sidecar mapping matches this
  // deployment (`sidecars.enabled: false`) and keeps this function pure.
  const forward = buildServiceDependencyGraph(
    { services: { ...composeServices } },
    {},
    Object.keys(composeServices),
  );
  const dependents = invertDependencyMap(forward);

  const effects = new Map<string, ServiceEffect>();
  for (const change of services) {
    effects.set(change.service, serviceEffect(change.changeType));
  }
  const context: ImpactContext = { forward, effects, runningServices, profileMapping };

  const annotatedServices: Record<string, ServiceIntelligence> = {};
  const closures = new Map<string, readonly string[]>();

  for (const change of services) {
    const provenanceReason = buildProvenanceReason(change, baseline);
    const advisoryReason = buildAdvisoryReason(change, registryChecked);
    const reasons = rankReasons([
      ...buildTriggerReasons(
        change,
        decisiveByService.get(change.service) ?? [],
        runtimeStateObserved,
      ),
      ...(provenanceReason === undefined ? [] : [provenanceReason]),
      ...(advisoryReason === undefined ? [] : [advisoryReason]),
    ]);
    if (reasons.length === 0) {
      continue;
    }

    const closure = transitiveDependents(change.service, dependents);
    closures.set(change.service, closure);
    annotatedServices[change.service] = { reasons, impact: buildImpact(change, closure, context) };
  }

  const annotated = Object.values(annotatedServices);
  const changing = new Set(
    Object.entries(annotatedServices)
      .filter(([, intelligence]) => intelligence.impact.effect !== "none")
      .map(([service]) => service),
  );

  // Set difference, never a subtraction: `|reached| - |changing|` goes negative
  // for the modal leaf-service case and fails `schemaNumber({ minimum: 0 })`.
  const reached = new Set<string>();
  for (const service of changing) {
    for (const dependent of closures.get(service) ?? []) {
      reached.add(dependent);
    }
  }
  const downstream = [...reached].filter((service) => !changing.has(service));
  const dominantReason = dominantReasonCode(annotated);

  return {
    schemaVersion: PLAN_INTELLIGENCE_SCHEMA_VERSION,
    provenance: planProvenance(baseline),
    registryChecked,
    runtimeStateObserved,
    services: annotatedServices,
    summary: {
      annotatedServices: annotated.length,
      downstreamImpacted: downstream.length,
      criticalServices: annotated.filter((intelligence) => intelligence.impact.critical).length,
      ...(dominantReason === undefined ? {} : { dominantReason }),
    },
  };
}
