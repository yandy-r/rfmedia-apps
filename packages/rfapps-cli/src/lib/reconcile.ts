import { createHash } from "node:crypto";
import { dirname } from "node:path";

import type { ServiceDrift, DriftCategory } from "../types/drift.js";
import type { ReconcileServiceInput } from "./docker.js";
import type { AcquireLifecycleLockOptions, LifecycleLock } from "./lifecycle-lock.js";
import {
  RECONCILE_MAX_SERVICES,
  RECONCILE_MAX_SERVICE_NAME_LENGTH,
  RECONCILE_SCHEMA_VERSION,
  type ReconcileAction,
  type ReconcileActionableKind,
  type ReconcileAutomationDecision,
  type ReconcileAutomationPolicy,
  type ReconcileContainerEvidence,
  type ReconcileDriftProjection,
  type ReconcileEnvironmentDrift,
  type ReconcileResult,
  type ReconcileScope,
  type ReconcileServiceObservation,
  type ReconcileServiceResult,
  type ReconcileSummary,
} from "../types/reconcile.js";

const CATEGORY_ORDER: readonly DriftCategory[] = [
  "image",
  "environment",
  "ports",
  "volumes",
  "networks",
  "runtime-status",
];

const CATEGORY_REASON: Readonly<Record<DriftCategory, string>> = {
  image: "RECONCILE_IMAGE_DRIFT",
  environment: "RECONCILE_ENVIRONMENT_DRIFT",
  ports: "RECONCILE_PORTS_DRIFT",
  volumes: "RECONCILE_VOLUMES_DRIFT",
  networks: "RECONCILE_NETWORKS_DRIFT",
  "runtime-status": "RECONCILE_RUNTIME_STATUS_DRIFT",
};

export interface ReconcilePlanningAuthority {
  composeFingerprint: string;
  /** Hash of the complete resolved Compose model, including includes, interpolation, and env_file. */
  resolvedComposeFingerprint?: string;
  dockerAuthorityFingerprint: string;
  environmentSourceFingerprint: string;
}

export interface ReconcileServicePlanningInput {
  service: string;
  resolvedConfigFingerprint: string;
  observation: ReconcileServiceObservation;
  /** Raw process-local drift. Only the value-free projection is returned or fingerprinted. */
  drift?: ServiceDrift;
}

export interface BuildReconcilePlanInput {
  mode: "report" | "auto-apply";
  dryRun: boolean;
  scope: ReconcileScope;
  authority: ReconcilePlanningAuthority;
  services: readonly ReconcileServicePlanningInput[];
  automation?: ReconcileAutomationDecision;
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(lexical);
}

function assertIdentifier(value: string, label: string): void {
  if (value.length === 0 || value.includes("\0")) throw new Error(`${label} must be non-empty`);
}

/** Reject reconciliation scopes that would make full-scope revalidation unbounded. */
export function assertReconcileScopeServices(services: readonly string[]): void {
  if (services.length > RECONCILE_MAX_SERVICES) {
    throw new Error(`Reconcile scope cannot exceed ${RECONCILE_MAX_SERVICES} services`);
  }
  for (const service of services) {
    assertIdentifier(service, "Service name");
    if (service.length > RECONCILE_MAX_SERVICE_NAME_LENGTH) {
      throw new Error(
        `Reconcile service names cannot exceed ${RECONCILE_MAX_SERVICE_NAME_LENGTH} characters`,
      );
    }
  }
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJsonValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => lexical(left, right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  }
  return value;
}

/** Stable JSON encoding for semantic reconciliation material. */
export function canonicalizeReconcileValue(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value));
}

function sortedCategories(categories: readonly DriftCategory[]): DriftCategory[] {
  const selected = new Set(categories);
  return CATEGORY_ORDER.filter((category) => selected.has(category));
}

function projectEnvironment(drift: ServiceDrift): ReconcileEnvironmentDrift[] {
  return drift.environment
    .map(({ name, changeType }) => ({ name, changeType }))
    .sort(
      (left, right) => lexical(left.name, right.name) || lexical(left.changeType, right.changeType),
    );
}

function emptyDrift(observation: ReconcileServiceObservation): ReconcileDriftProjection {
  const container = observation.containers?.[0];
  const missing = observation.kind === "missing";
  const state = missing ? "missing" : (container?.state ?? "unknown");
  const health = container?.health ?? "unknown";
  const runtimeChanged = state !== "running" || (health !== "healthy" && health !== "none");
  return {
    hasDrift: runtimeChanged,
    direction: "compose_ahead",
    categories: runtimeChanged ? ["runtime-status"] : [],
    image: { changed: false },
    environment: [],
    ports: { changed: false },
    volumes: { changed: false },
    networks: { changed: false },
    runtimeStatus: {
      currentState: state,
      currentHealth: health,
      desiredState: "running",
      desiredHealth: "healthy",
      changed: runtimeChanged,
    },
  };
}

function normalizeRuntimeObservation(
  drift: ReconcileDriftProjection,
  observation: ReconcileServiceObservation,
): ReconcileDriftProjection {
  const containers = canonicalContainers(observation);
  if (observation.kind === "missing" || containers.length === 0) {
    return {
      ...drift,
      hasDrift: true,
      categories: sortedCategories([...drift.categories, "runtime-status"]),
      runtimeStatus: {
        ...drift.runtimeStatus,
        changed: true,
        currentState: "missing",
        currentHealth: "unknown",
      },
    };
  }
  const container = containers[0];
  if (observation.kind !== "present" || container === undefined) return drift;
  const runtimeChanged =
    container.state !== "running" ||
    (container.health !== "healthy" && container.health !== "none");
  return {
    ...drift,
    hasDrift: drift.hasDrift || runtimeChanged,
    categories: runtimeChanged
      ? sortedCategories([...drift.categories, "runtime-status"])
      : drift.categories,
    runtimeStatus: {
      ...drift.runtimeStatus,
      changed: drift.runtimeStatus.changed || runtimeChanged,
      currentState: container.state,
      currentHealth: container.health,
    },
  };
}

/** Remove all desired/current values and normalize ordering before evidence becomes public. */
export function projectReconcileDrift(drift: ServiceDrift): ReconcileDriftProjection {
  const categories = sortedCategories(drift.categories);
  return {
    hasDrift: drift.hasDrift,
    direction: drift.direction,
    categories,
    image: { changed: drift.image.changed },
    environment: projectEnvironment(drift),
    ports: { changed: drift.ports.changed },
    volumes: { changed: drift.volumes.changed },
    networks: { changed: drift.networks.changed },
    runtimeStatus: {
      changed: drift.runtimeStatus.changed,
      currentState: drift.runtimeStatus.current.state,
      currentHealth: drift.runtimeStatus.current.health,
      desiredState: drift.runtimeStatus.desired.state,
      desiredHealth: drift.runtimeStatus.desired.health,
    },
  };
}

function canonicalContainers(
  observation: ReconcileServiceObservation,
): ReconcileContainerEvidence[] {
  return [...(observation.containers ?? [])]
    .map((container) => ({ ...container }))
    .sort((left, right) => lexical(left.id, right.id) || lexical(left.name, right.name));
}

function reasonForCategories(categories: readonly DriftCategory[]) {
  return categories.map((category) => ({ code: CATEGORY_REASON[category], category }));
}

function sortReasons(reasons: ReconcileAction["reasons"]): ReconcileAction["reasons"] {
  return [...reasons].sort((left, right) => {
    const leftIndex =
      left.category === undefined ? CATEGORY_ORDER.length : CATEGORY_ORDER.indexOf(left.category);
    const rightIndex =
      right.category === undefined ? CATEGORY_ORDER.length : CATEGORY_ORDER.indexOf(right.category);
    return leftIndex - rightIndex || lexical(left.code, right.code);
  });
}

function planAction(
  observation: ReconcileServiceObservation,
  drift: ReconcileDriftProjection,
): Pick<ReconcileAction, "kind" | "proposedKind" | "categories" | "reasons"> {
  const containers = canonicalContainers(observation);
  if (observation.kind === "failed") {
    return {
      kind: "blocked",
      categories: drift.categories,
      reasons: [{ code: observation.reasonCode ?? "RECONCILE_OBSERVATION_FAILED" }],
    };
  }
  if (observation.kind === "ambiguous" || containers.length > 1) {
    return {
      kind: "blocked",
      categories: drift.categories,
      reasons: [{ code: "RECONCILE_AMBIGUOUS_INSTANCES" }],
    };
  }
  if (observation.kind === "missing" || containers.length === 0) {
    const categories = sortedCategories([...drift.categories, "runtime-status"]);
    return {
      kind: "create",
      categories,
      reasons: sortReasons([
        ...reasonForCategories(categories.filter((category) => category !== "runtime-status")),
        { code: "RECONCILE_CONTAINER_MISSING", category: "runtime-status" },
      ]),
    };
  }
  if (!drift.hasDrift) {
    return { kind: "none", categories: [], reasons: [] };
  }
  const onlyRuntime = drift.categories.every((category) => category === "runtime-status");
  if (containers[0]?.state !== "running" && onlyRuntime) {
    return {
      kind: "start",
      categories: drift.categories,
      reasons: [{ code: "RECONCILE_CONTAINER_STOPPED", category: "runtime-status" }],
    };
  }
  return {
    kind: "recreate",
    categories: drift.categories,
    reasons: reasonForCategories(drift.categories),
  };
}

function defaultAutomation(input: BuildReconcilePlanInput): ReconcileAutomationDecision {
  return input.mode === "auto-apply" && !input.dryRun
    ? { status: "allowed" }
    : { status: "not_requested" };
}

function applyEligibility(
  action: Pick<ReconcileAction, "kind" | "proposedKind" | "categories" | "reasons">,
  input: BuildReconcilePlanInput,
  automation: ReconcileAutomationDecision,
): ReconcileAction {
  if (action.kind === "none" || action.kind === "blocked") {
    return { ...action, eligibility: action.kind === "blocked" ? "blocked" : "not_requested" };
  }
  if (input.mode !== "auto-apply" || input.dryRun) {
    return { ...action, eligibility: "not_requested" };
  }
  if (automation.status !== "allowed") {
    return {
      kind: "blocked",
      proposedKind: action.kind,
      categories: action.categories,
      eligibility: "blocked",
      reasons: sortReasons([
        ...action.reasons,
        {
          code:
            automation.reasonCode ??
            (automation.status === "blocked"
              ? "RECONCILE_POLICY_BLOCKED"
              : "RECONCILE_POLICY_NOT_ALLOWED"),
        },
      ]),
    };
  }
  return { ...action, eligibility: "allowed" };
}

function comparisonFor(
  observation: ReconcileServiceObservation,
  drift: ReconcileDriftProjection,
  action: ReconcileAction,
): ReconcileServiceResult["comparison"] {
  if (
    observation.kind === "failed" ||
    observation.kind === "ambiguous" ||
    canonicalContainers(observation).length > 1
  ) {
    return "observation_failed";
  }
  return drift.hasDrift || action.kind !== "none" ? "drifted" : "in_sync";
}

function outcomeFor(
  comparison: ReconcileServiceResult["comparison"],
  action: ReconcileAction,
): ReconcileServiceResult["outcome"] {
  if (comparison === "observation_failed") {
    return "observation_failed";
  }
  if (action.kind === "blocked" && action.proposedKind !== undefined) return "blocked_policy";
  return action.kind === "none" ? "no_action" : "reported";
}

/** V1 policy permits explicitly requested mutation; report/dry-run never request mutation. */
export const allowAllReconcilePolicy: ReconcileAutomationPolicy = {
  evaluate(context) {
    return context.mode === "auto-apply" && !context.dryRun
      ? { status: "allowed" }
      : { status: "not_requested" };
  },
};

/** Complete aggregate counts derived only from terminal service data. */
export function summarizeReconcileServices(
  services: readonly ReconcileServiceResult[],
): ReconcileSummary {
  return {
    selected: services.length,
    inSync: services.filter((service) => service.comparison === "in_sync").length,
    drifted: services.filter((service) => service.comparison === "drifted").length,
    actionable: services.filter(
      (service) =>
        service.action.kind === "create" ||
        service.action.kind === "start" ||
        service.action.kind === "recreate",
    ).length,
    blocked: services.filter((service) => service.action.kind === "blocked").length,
    converged: services.filter(
      (service) =>
        service.outcome === "converged" ||
        service.outcome === "became_in_sync" ||
        service.outcome === "no_action",
    ).length,
    failed: services.filter((service) =>
      ["observation_failed", "action_failed", "not_converged"].includes(service.outcome),
    ).length,
  };
}

function semanticAggregate(
  input: BuildReconcilePlanInput,
  summary: ReconcileSummary,
): Pick<ReconcileResult, "status" | "success" | "exitCode"> {
  if (input.mode === "report") {
    return summary.failed > 0
      ? { status: "failed", success: false, exitCode: 1 }
      : { status: "reported", success: true, exitCode: 0 };
  }
  if (summary.failed > 0 && summary.actionable === 0) {
    return { status: "failed", success: false, exitCode: 1 };
  }
  if (summary.blocked > 0) return { status: "partial", success: false, exitCode: 3 };
  if (summary.actionable > 0) return { status: "planned", success: true, exitCode: 0 };
  return { status: "converged", success: true, exitCode: 0 };
}

function fingerprintMaterial(
  input: BuildReconcilePlanInput,
  scope: ReconcileScope,
  automation: ReconcileAutomationDecision,
  services: readonly ReconcileServiceResult[],
  evidenceByService: ReadonlyMap<string, ReconcileServicePlanningInput[]>,
): unknown {
  return {
    schemaVersion: RECONCILE_SCHEMA_VERSION,
    operation: "reconcile",
    mode: input.mode,
    dryRun: input.dryRun,
    scope,
    authority: input.authority,
    automation: {
      status: automation.status,
      ...(automation.reasonCode === undefined ? {} : { reasonCode: automation.reasonCode }),
    },
    services: services.map((service) => {
      const evidence = evidenceByService.get(service.service)?.[0];
      return {
        service: service.service,
        resolvedConfigFingerprint: evidence?.resolvedConfigFingerprint ?? "missing",
        containers: evidence === undefined ? [] : canonicalContainers(evidence.observation),
        comparison: service.comparison,
        drift: service.drift,
        action: service.action,
      };
    }),
  };
}

/** Build a deterministic, complete, side-effect-free initial reconciliation result. */
export function buildReconcilePlan(input: BuildReconcilePlanInput): ReconcileResult {
  assertIdentifier(input.scope.composePath, "Compose path");
  assertIdentifier(input.scope.project, "Compose project");
  assertReconcileScopeServices(input.scope.services);
  if (input.services.length > RECONCILE_MAX_SERVICES) {
    throw new Error(`Reconcile scope cannot exceed ${RECONCILE_MAX_SERVICES} services`);
  }
  for (const evidence of input.services) assertReconcileScopeServices([evidence.service]);
  const scopeServices = uniqueSorted(input.scope.services);
  if (scopeServices.length !== input.scope.services.length) {
    throw new Error("Reconcile scope services must be unique");
  }
  if (scopeServices.length === 0) throw new Error("Reconcile scope requires at least one service");
  const scope: ReconcileScope = {
    composePath: input.scope.composePath,
    project: input.scope.project,
    profiles: uniqueSorted(input.scope.profiles),
    services: scopeServices,
  };
  const evidenceByService = new Map<string, ReconcileServicePlanningInput[]>();
  for (const evidence of input.services) {
    const entries = evidenceByService.get(evidence.service) ?? [];
    entries.push(evidence);
    evidenceByService.set(evidence.service, entries);
  }
  const automation = input.automation ?? defaultAutomation(input);
  const services = scopeServices.map((service): ReconcileServiceResult => {
    const entries = evidenceByService.get(service) ?? [];
    const duplicateOrMissing = entries.length !== 1;
    const evidence = entries[0];
    const observation: ReconcileServiceObservation = duplicateOrMissing
      ? {
          kind: "failed",
          reasonCode:
            entries.length === 0 ? "RECONCILE_EVIDENCE_MISSING" : "RECONCILE_EVIDENCE_DUPLICATE",
        }
      : (evidence?.observation ?? { kind: "failed", reasonCode: "RECONCILE_EVIDENCE_MISSING" });
    const projectedDrift =
      evidence?.drift === undefined
        ? emptyDrift(observation)
        : projectReconcileDrift(evidence.drift);
    const drift = normalizeRuntimeObservation(projectedDrift, observation);
    const action = applyEligibility(planAction(observation, drift), input, automation);
    const comparison = comparisonFor(observation, drift, action);
    return { service, comparison, drift, action, outcome: outcomeFor(comparison, action) };
  });
  const summary = summarizeReconcileServices(services);
  const aggregate = semanticAggregate(input, summary);
  const actionFingerprint = createHash("sha256")
    .update(
      canonicalizeReconcileValue(
        fingerprintMaterial(input, scope, automation, services, evidenceByService),
      ),
    )
    .digest("hex");
  return {
    schemaVersion: RECONCILE_SCHEMA_VERSION,
    operation: "reconcile",
    mode: input.mode,
    dryRun: input.dryRun,
    status: aggregate.status,
    scope,
    actionFingerprint,
    automation,
    services,
    summary,
    success: aggregate.success,
    exitCode: aggregate.exitCode,
  };
}

type Awaitable<T> = T | Promise<T>;

/** Options owned by the action boundary; the coordinator never reads process state. */
export interface RunReconcileOptions {
  projectDir?: string;
  stateDir?: string;
}

export interface ReconcileObservationDependencies {
  /** Capture the complete canonical authority, scope, config, container, and drift snapshot. */
  capture(): Promise<BuildReconcilePlanInput>;
}

export interface ReconcileOrderDependencies {
  /** Return dependency phases limited to the supplied frozen scope. */
  phases(services: readonly string[]): Promise<readonly (readonly string[])[]>;
}

export interface ReconcileExecutionDependencies {
  reconcileService(input: ReconcileServiceInput): Promise<{ success: boolean }>;
  /** Bounded readiness verification for the exact reviewed service. */
  verifyReadiness(service: string): Promise<boolean>;
}

export interface ReconcileLockDependencies {
  acquire(options: AcquireLifecycleLockOptions): Promise<LifecycleLock>;
}

export interface ReconcileSignalDependencies {
  getInterruption(): string | undefined;
}

export interface ReconcileClockDependencies {
  now(): number;
}

/** Grouped seams keep this library deterministic, data-only, and directly testable. */
export interface ReconcileCoordinatorDependencies {
  observation: ReconcileObservationDependencies;
  order: ReconcileOrderDependencies;
  execution: ReconcileExecutionDependencies;
  lock: ReconcileLockDependencies;
  policy: ReconcileAutomationPolicy;
  signal: ReconcileSignalDependencies;
  clock: ReconcileClockDependencies;
}

const ACTIONABLE_KINDS = new Set<ReconcileAction["kind"]>(["create", "start", "recreate"]);
const FAILURE_OUTCOMES = new Set<ReconcileServiceResult["outcome"]>([
  "observation_failed",
  "action_failed",
  "not_converged",
]);
const CANCELLATION_OUTCOMES = new Set<ReconcileServiceResult["outcome"]>([
  "cancelled_before_action",
  "cancelled_during_action",
]);
const BLOCKED_OUTCOMES = new Set<ReconcileServiceResult["outcome"]>([
  "blocked_policy",
  "blocked_stale",
  "skipped_after_unsafe_failure",
]);

function actionable(service: ReconcileServiceResult): boolean {
  return ACTIONABLE_KINDS.has(service.action.kind);
}

function actionableKind(action: ReconcileAction): ReconcileActionableKind | undefined {
  switch (action.kind) {
    case "create":
    case "start":
    case "recreate":
      return action.kind;
    default:
      return action.proposedKind;
  }
}

function addReason(
  service: ReconcileServiceResult,
  code: string,
  outcome: ReconcileServiceResult["outcome"],
): ReconcileServiceResult {
  const proposedKind = actionableKind(service.action);
  return {
    ...service,
    action: {
      kind: "blocked",
      ...(proposedKind === undefined ? {} : { proposedKind }),
      categories: [...service.action.categories],
      eligibility: "blocked",
      reasons: sortReasons([...service.action.reasons, { code }]),
    },
    outcome,
  };
}

/** Aggregate only terminal service outcomes; it is exported for exhaustive transition tests. */
export function aggregateReconcileResult(
  services: readonly ReconcileServiceResult[],
): Pick<ReconcileResult, "status" | "success" | "exitCode"> {
  if (services.length > 0 && services.every((service) => service.outcome === "reported")) {
    return { status: "reported", success: true, exitCode: 0 };
  }
  const cancelled = services.some((service) => CANCELLATION_OUTCOMES.has(service.outcome));
  if (cancelled) return { status: "cancelled", success: false, exitCode: 2 };

  const failed = services.some((service) => FAILURE_OUTCOMES.has(service.outcome));
  const blocked = services.some((service) => BLOCKED_OUTCOMES.has(service.outcome));
  const completed = services.some((service) =>
    ["no_action", "became_in_sync", "converged"].includes(service.outcome),
  );
  if (failed) {
    return completed
      ? { status: "partial", success: false, exitCode: 3 }
      : { status: "failed", success: false, exitCode: 1 };
  }
  if (blocked) return { status: "partial", success: false, exitCode: 3 };
  return { status: "converged", success: true, exitCode: 0 };
}

function terminalResult(
  reviewed: ReconcileResult,
  services: readonly ReconcileServiceResult[],
): ReconcileResult {
  const orderedByName = new Map(services.map((service) => [service.service, service]));
  const ordered = reviewed.scope.services.map((service) => {
    const result = orderedByName.get(service);
    if (result === undefined) throw new Error(`Missing reconciliation result for ${service}`);
    return result;
  });
  const aggregate = aggregateReconcileResult(ordered);
  return {
    ...reviewed,
    services: ordered,
    summary: summarizeReconcileServices(ordered),
    ...aggregate,
  };
}

function withAutomation(
  snapshot: BuildReconcilePlanInput,
  automation: ReconcileAutomationDecision,
): BuildReconcilePlanInput {
  return { ...snapshot, automation };
}

async function evaluatePolicy(
  snapshot: BuildReconcilePlanInput,
  dependencies: ReconcileCoordinatorDependencies,
): Promise<ReconcileAutomationDecision> {
  try {
    const preliminary = buildReconcilePlan({
      ...snapshot,
      automation:
        snapshot.mode === "auto-apply" && !snapshot.dryRun
          ? { status: "allowed" }
          : { status: "not_requested" },
    });
    return await dependencies.policy.evaluate({
      mode: snapshot.mode,
      dryRun: snapshot.dryRun,
      scope: snapshot.scope,
      actionableServices: preliminary.services
        .filter(actionable)
        .map(({ service }) => service)
        .sort(lexical),
    });
  } catch {
    return { status: "blocked", reasonCode: "RECONCILE_POLICY_EVALUATION_FAILED" };
  }
}

function sameFrozenScope(left: ReconcileScope, right: ReconcileScope): boolean {
  return canonicalizeReconcileValue(left) === canonicalizeReconcileValue(right);
}

function serviceFingerprint(input: BuildReconcilePlanInput, service: string): string | undefined {
  const evidence = input.services.filter((item) => item.service === service);
  if (evidence.length !== 1) return undefined;
  return buildReconcilePlan({
    ...input,
    scope: { ...input.scope, services: [service] },
    services: evidence,
  }).actionFingerprint;
}

function freshService(
  input: BuildReconcilePlanInput,
  service: string,
): ReconcileServiceResult | undefined {
  if (input.services.filter((item) => item.service === service).length !== 1) return undefined;
  return buildReconcilePlan({
    ...input,
    scope: { ...input.scope, services: [service] },
    services: input.services.filter((item) => item.service === service),
  }).services[0];
}

function validatePhases(
  phases: readonly (readonly string[])[],
  actionableServices: readonly string[],
): string[][] | undefined {
  const normalized = phases.map((phase) => [...phase].sort(lexical));
  const flattened = normalized.flat();
  if (
    flattened.length !== new Set(flattened).size ||
    canonicalizeReconcileValue([...flattened].sort(lexical)) !==
      canonicalizeReconcileValue([...actionableServices].sort(lexical))
  ) {
    return undefined;
  }
  return normalized;
}

async function captureWithPolicy(
  dependencies: ReconcileCoordinatorDependencies,
): Promise<BuildReconcilePlanInput> {
  const snapshot = await dependencies.observation.capture();
  return withAutomation(snapshot, await evaluatePolicy(snapshot, dependencies));
}

/**
 * Run the same-process reconciliation lifecycle.
 *
 * Report and dry-run return before touching any injected side-effect seam. Auto-apply acquires the
 * shared lifecycle lock, fails closed on changed review evidence, rechecks every service and policy
 * immediately before its exact one-service action, then requires readiness and fresh zero drift.
 */
export async function runReconcile(
  input: BuildReconcilePlanInput,
  options: RunReconcileOptions = {},
  dependencies?: ReconcileCoordinatorDependencies,
): Promise<ReconcileResult> {
  const reviewed = buildReconcilePlan(input);
  if (input.mode === "report" || input.dryRun || !reviewed.services.some(actionable)) {
    return reviewed;
  }
  if (dependencies === undefined) {
    throw new Error("Auto-apply reconciliation dependencies are required");
  }

  const results = new Map(reviewed.services.map((service) => [service.service, service]));
  const reviewedInput = input;
  const reviewedActionable = reviewed.services.filter(actionable).map(({ service }) => service);
  const initialSignal = dependencies.signal.getInterruption();
  if (initialSignal !== undefined) {
    for (const service of reviewedActionable) {
      results.set(
        service,
        addReason(results.get(service)!, "RECONCILE_CANCELLED", "cancelled_before_action"),
      );
    }
    return terminalResult(reviewed, [...results.values()]);
  }

  let lock: LifecycleLock | undefined;
  let primaryError: unknown;
  let completed: ReconcileResult | undefined;
  try {
    dependencies.clock.now();
    lock = await dependencies.lock.acquire({
      projectPath: options.projectDir ?? dirname(reviewed.scope.composePath),
      dockerContext: reviewedInput.authority.dockerAuthorityFingerprint,
      composeProjectName: reviewed.scope.project,
      stateDir: options.stateDir,
    });

    let lockedSnapshot: BuildReconcilePlanInput;
    try {
      lockedSnapshot = await captureWithPolicy(dependencies);
    } catch {
      for (const service of reviewedActionable) {
        results.set(
          service,
          addReason(results.get(service)!, "RECONCILE_REVALIDATION_FAILED", "blocked_stale"),
        );
      }
      completed = terminalResult(reviewed, [...results.values()]);
      return completed;
    }

    const lockedPlan = buildReconcilePlan(lockedSnapshot);
    if (!sameFrozenScope(reviewed.scope, lockedPlan.scope)) {
      for (const service of reviewedActionable) {
        results.set(
          service,
          addReason(results.get(service)!, "RECONCILE_REVIEW_STALE", "blocked_stale"),
        );
      }
      completed = terminalResult(reviewed, [...results.values()]);
      return completed;
    }
    if (lockedSnapshot.automation?.status !== "allowed") {
      const reason = lockedSnapshot.automation?.reasonCode ?? "RECONCILE_POLICY_BLOCKED";
      for (const service of reviewedActionable) {
        results.set(service, addReason(results.get(service)!, reason, "blocked_policy"));
      }
      completed = terminalResult(reviewed, [...results.values()]);
      return completed;
    }
    if (lockedPlan.actionFingerprint !== reviewed.actionFingerprint) {
      for (const service of reviewedActionable) {
        results.set(
          service,
          addReason(results.get(service)!, "RECONCILE_REVIEW_STALE", "blocked_stale"),
        );
      }
      completed = terminalResult(reviewed, [...results.values()]);
      return completed;
    }

    let phases: string[][] | undefined;
    try {
      phases = validatePhases(
        await dependencies.order.phases(reviewedActionable),
        reviewedActionable,
      );
    } catch {
      phases = undefined;
    }
    if (phases === undefined) {
      for (const service of reviewedActionable) {
        results.set(
          service,
          addReason(results.get(service)!, "RECONCILE_DEPENDENCY_ORDER_INVALID", "blocked_stale"),
        );
      }
      completed = terminalResult(reviewed, [...results.values()]);
      return completed;
    }

    let stopped = false;
    for (const phase of phases) {
      for (const service of phase) {
        const original = results.get(service)!;
        if (stopped) {
          results.set(
            service,
            addReason(original, "RECONCILE_PRIOR_UNSAFE_FAILURE", "skipped_after_unsafe_failure"),
          );
          continue;
        }
        if (dependencies.signal.getInterruption() !== undefined) {
          results.set(
            service,
            addReason(original, "RECONCILE_CANCELLED", "cancelled_before_action"),
          );
          stopped = true;
          continue;
        }

        let immediate: BuildReconcilePlanInput;
        try {
          immediate = await captureWithPolicy(dependencies);
        } catch {
          results.set(
            service,
            addReason(original, "RECONCILE_OBSERVATION_FAILED", "observation_failed"),
          );
          stopped = true;
          continue;
        }
        if (!sameFrozenScope(reviewed.scope, immediate.scope)) {
          results.set(service, addReason(original, "RECONCILE_REVIEW_STALE", "blocked_stale"));
          stopped = true;
          continue;
        }
        if (immediate.automation?.status !== "allowed") {
          results.set(
            service,
            addReason(
              original,
              immediate.automation?.reasonCode ?? "RECONCILE_POLICY_BLOCKED",
              "blocked_policy",
            ),
          );
          continue;
        }
        const current = freshService(immediate, service);
        if (current === undefined || current.comparison === "observation_failed") {
          results.set(
            service,
            addReason(original, "RECONCILE_OBSERVATION_FAILED", "observation_failed"),
          );
          stopped = true;
          continue;
        }
        if (current.comparison === "in_sync" || current.action.kind === "none") {
          results.set(service, {
            ...original,
            outcome: "became_in_sync",
            finalDrift: current.drift,
          });
          continue;
        }
        if (serviceFingerprint(immediate, service) !== serviceFingerprint(reviewedInput, service)) {
          results.set(service, addReason(original, "RECONCILE_REVIEW_STALE", "blocked_stale"));
          stopped = true;
          continue;
        }

        let actionSucceeded = false;
        try {
          const kind = original.action.kind;
          if (kind !== "create" && kind !== "start" && kind !== "recreate") {
            throw new Error("Reviewed reconciliation action is no longer actionable");
          }
          const execution = await dependencies.execution.reconcileService({
            composePath: reviewed.scope.composePath,
            projectName: reviewed.scope.project,
            profiles: reviewed.scope.profiles,
            service,
            action: kind,
            expectedResolvedComposeFingerprint: immediate.authority.resolvedComposeFingerprint,
          });
          actionSucceeded = execution.success;
        } catch {
          actionSucceeded = false;
        }
        if (!actionSucceeded) {
          results.set(service, { ...original, outcome: "action_failed" });
          stopped = true;
          continue;
        }

        let interruptedDuringAction = dependencies.signal.getInterruption() !== undefined;
        let ready = false;
        let finalSnapshot: BuildReconcilePlanInput | undefined;
        try {
          ready = await dependencies.execution.verifyReadiness(service);
          if (dependencies.signal.getInterruption() !== undefined) interruptedDuringAction = true;
          finalSnapshot = await captureWithPolicy(dependencies);
          if (dependencies.signal.getInterruption() !== undefined) interruptedDuringAction = true;
        } catch {
          ready = false;
          if (dependencies.signal.getInterruption() !== undefined) interruptedDuringAction = true;
        }
        const finalService =
          finalSnapshot === undefined ? undefined : freshService(finalSnapshot, service);
        if (dependencies.signal.getInterruption() !== undefined) interruptedDuringAction = true;
        if (interruptedDuringAction) {
          results.set(service, {
            ...original,
            outcome: "cancelled_during_action",
            ...(finalService === undefined ? {} : { finalDrift: finalService.drift }),
          });
          stopped = true;
          continue;
        }
        const converged =
          ready &&
          finalSnapshot !== undefined &&
          sameFrozenScope(reviewed.scope, finalSnapshot.scope) &&
          finalService?.comparison === "in_sync" &&
          finalService.drift.hasDrift === false;
        results.set(service, {
          ...original,
          outcome: converged ? "converged" : "not_converged",
          ...(finalService === undefined ? {} : { finalDrift: finalService.drift }),
        });
        if (!converged) stopped = true;
      }
    }
    dependencies.clock.now();
    completed = terminalResult(reviewed, [...results.values()]);
    return completed;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (lock !== undefined) {
      try {
        await lock.release();
      } catch (cleanupError) {
        if (primaryError === undefined && completed === undefined) throw cleanupError;
      }
    }
  }
}
