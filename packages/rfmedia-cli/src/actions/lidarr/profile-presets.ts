/** Offline discovery, fresh diff, and verified apply actions for Lidarr profile presets. */

import { randomUUID } from "node:crypto";

import { getLoadedLidarrConfig } from "../../lib/loaded-config.js";
import {
  resolveLidarrScheduler,
  resolveRequiredLidarrExecutionContext,
  resolveRequiredLidarrOrigin,
} from "../../lib/lidarr/index.js";
import type { LidarrClientApi } from "../../lib/lidarr/client.js";
import {
  acquireLidarrPresetApplyLock,
  createLidarrPresetApplyJournal,
  type LidarrPresetApplyJournalHandle,
  type LidarrPresetApplyLock,
} from "../../lib/lidarr/profile-preset-persistence.js";
import {
  BUILTIN_LIDARR_PRESET_PACKS,
  LIDARR_PRESET_SUPPORTED_FIXTURE_V1,
  buildLidarrPresetQualityProfileInput,
  createLidarrPresetDiff,
  resolveLidarrPresetPack,
  type LidarrPresetDiffImpact,
  type LidarrPresetLiveState,
} from "../../lib/lidarr/profile-presets.js";
import {
  getGlobalSignal,
  registerGlobalCleanup,
  unregisterGlobalCleanup,
} from "../../lib/signal-handler.js";
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
import {
  LIDARR_PRESET_APPLY_VERSION,
  LIDARR_PRESET_DIFF_VERSION,
  LIDARR_PRESET_JOURNAL_VERSION,
  LIDARR_PRESET_LIST_VERSION,
  LIDARR_PRESET_SHOW_VERSION,
  type LidarrPresetApplyJournal,
  type LidarrPresetApplyOutcome,
  type LidarrPresetApplyResult,
  type LidarrPresetApplySummary,
  type LidarrPresetDiffResult,
  type LidarrPresetDiffSummary,
  type LidarrPresetExecutionMetadata,
  type LidarrPresetJournalResourceState,
  type LidarrPresetListResult,
  type LidarrPresetPack,
  type LidarrPresetPackIdentity,
  type LidarrPresetQualityProfileDefinition,
  type LidarrPresetResourceDiff,
  type LidarrPresetSafeError,
  type LidarrPresetSemanticValue,
  type LidarrPresetShowResult,
} from "../../types/lidarr-presets.js";
import type { LidarrArtist } from "../../types/lidarr.js";

export const TIER = "local-only" as const satisfies LidarrTier;

export interface LidarrPresetReferenceActionOptions {
  readonly packRef: string;
}

export interface LidarrPresetDiffActionOptions extends LidarrPresetReferenceActionOptions {
  readonly lidarrUrl?: string;
  readonly lidarrApiKey?: string;
  readonly signal?: AbortSignal;
}

export interface LidarrPresetApplyActionOptions extends LidarrPresetDiffActionOptions {
  readonly dryRun?: boolean;
  /** Framework-independent confirmation injected by the CLI boundary. */
  readonly confirm: (review: LidarrPresetDiffResult) => Promise<boolean>;
}

function configuredPacks() {
  return getLoadedLidarrConfig().profilePresets?.packs ?? {};
}

function resolvePack(packRef: string): LidarrPresetPack {
  return resolveLidarrPresetPack(packRef, configuredPacks());
}

function packIdentity(pack: LidarrPresetPack): LidarrPresetPackIdentity {
  return Object.freeze({
    source: pack.source,
    ref: pack.ref,
    id: pack.id,
    version: pack.version,
    digest: pack.digest,
  });
}

function listPacks(): readonly LidarrPresetPack[] {
  const configured = Object.keys(configuredPacks())
    .sort()
    .map((id) => resolvePack(`config:${id}`));
  return Object.freeze([...BUILTIN_LIDARR_PRESET_PACKS, ...configured]);
}

/** Lists all built-in and configured packs without resolving a Lidarr connection. */
export async function executeLidarrPresetList(): Promise<LidarrPresetListResult> {
  return Object.freeze({
    schemaVersion: LIDARR_PRESET_LIST_VERSION,
    packs: listPacks(),
  });
}

/** Resolves one complete pack without credentials, scheduling, or network access. */
export async function executeLidarrPresetShow(
  options: LidarrPresetReferenceActionOptions,
): Promise<LidarrPresetShowResult> {
  return Object.freeze({
    schemaVersion: LIDARR_PRESET_SHOW_VERSION,
    pack: resolvePack(options.packRef),
  });
}

function referencingProfilesByCustomFormat(
  profiles: readonly LidarrPresetQualityProfileDefinition[],
): Readonly<Record<string, readonly string[]>> {
  const references = new Map<string, Set<string>>();
  for (const profile of profiles) {
    for (const item of profile.formatItems) {
      const names = references.get(item.customFormat.name) ?? new Set<string>();
      names.add(profile.name);
      references.set(item.customFormat.name, names);
    }
  }
  return Object.freeze(
    Object.fromEntries(
      [...references.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, profileNames]) => [name, Object.freeze([...profileNames].sort())]),
    ),
  );
}

function assignedArtistCountByQualityProfile(
  artists: readonly LidarrArtist[],
  profiles: readonly LidarrPresetQualityProfileDefinition[],
): Readonly<Record<string, number>> {
  const profileNamesById = new Map(profiles.map((profile) => [profile.id, profile.name]));
  const counts = new Map(profiles.map((profile) => [profile.name, 0]));
  for (const artist of artists) {
    const profileName = profileNamesById.get(artist.qualityProfileId);
    if (profileName !== undefined) {
      counts.set(profileName, (counts.get(profileName) ?? 0) + 1);
    }
  }
  return Object.freeze(
    Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right))),
  );
}

function summarize(resources: readonly LidarrPresetResourceDiff[]): LidarrPresetDiffSummary {
  return Object.freeze({
    total: resources.length,
    create: resources.filter(({ action }) => action === "create").length,
    update: resources.filter(({ action }) => action === "update").length,
    unchanged: resources.filter(({ action }) => action === "unchanged").length,
    retained: resources.filter(({ action }) => action === "retained").length,
  });
}

function executionMetadata(
  execution: Readonly<{
    readonly operation: string;
    readonly lane: LidarrTier;
    readonly attempts: number;
    readonly outcome: "succeeded" | "failed" | "skipped";
  }>,
): LidarrPresetExecutionMetadata {
  if (execution.lane !== "local-only" && execution.lane !== "destructive") {
    throw new Error(`Unsupported preset execution lane: ${execution.lane}`);
  }
  return Object.freeze({
    operation: execution.operation,
    lane: execution.lane,
    attempts: execution.attempts,
    outcome: execution.outcome,
  });
}

/** Builds a complete live state and advisory impact from fresh facade reads. */
async function readFreshState(
  pack: LidarrPresetPack,
  options: LidarrPresetDiffActionOptions,
): Promise<{
  readonly state: LidarrPresetLiveState;
  readonly impact: LidarrPresetDiffImpact;
  readonly namingExamples: LidarrPresetDiffResult["namingExamples"];
}> {
  const context = resolveRequiredLidarrExecutionContext(
    { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey },
    {
      tier: TIER,
      allowStale: false,
      retryAttemptsOverride: 0,
    },
  );
  const [
    customFormatSchema,
    customFormats,
    qualityProfileSchema,
    qualityProfiles,
    naming,
    artists,
  ] = await Promise.all([
    context.client.getCustomFormatSchema(options.signal),
    context.client.listCustomFormats(options.signal),
    context.client.getQualityProfileSchema(options.signal),
    context.client.listQualityProfileDefinitions(options.signal),
    context.client.getNamingConfig(options.signal),
    context.client.listArtists(options.signal),
  ]);
  const namingExamples = await context.client.getNamingExamples(
    { id: naming.id, ...pack.naming },
    options.signal,
  );
  return Object.freeze({
    state: Object.freeze({
      capabilities: LIDARR_PRESET_SUPPORTED_FIXTURE_V1.capabilities,
      customFormatSchema,
      customFormats,
      qualityProfileSchema,
      qualityProfiles,
      naming,
    }),
    impact: Object.freeze({
      referencingProfilesByCustomFormat: referencingProfilesByCustomFormat(qualityProfiles),
      assignedArtistCountByQualityProfile: assignedArtistCountByQualityProfile(
        artists,
        qualityProfiles,
      ),
    }),
    namingExamples,
  });
}

interface FreshReview {
  readonly review: LidarrPresetDiffResult;
  readonly snapshot: LidarrPresetLiveState;
}

async function readFreshReview(options: LidarrPresetDiffActionOptions): Promise<FreshReview> {
  const pack = resolvePack(options.packRef);
  const overrides = { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey };
  const targetOrigin = resolveRequiredLidarrOrigin(overrides);
  const scheduled = await resolveLidarrScheduler().runSingle(
    TIER,
    {
      id: "lidarr-presets-diff",
      operation: "lidarr presets diff",
      idempotent: true,
      run: () => readFreshState(pack, options),
    },
    { signal: options.signal },
  );
  const resources = createLidarrPresetDiff(pack, scheduled.value.state, scheduled.value.impact);
  const summary = summarize(resources);
  return Object.freeze({
    snapshot: scheduled.value.state,
    review: Object.freeze({
      schemaVersion: LIDARR_PRESET_DIFF_VERSION,
      pack: packIdentity(pack),
      targetOrigin,
      assumptions: pack.assumptions,
      consequences: pack.consequences,
      observations: Object.freeze([
        `Observed ${scheduled.value.state.customFormats.length} custom formats, ${scheduled.value.state.qualityProfiles.length} quality profiles, and one naming policy.`,
      ]),
      warnings: Object.freeze([]),
      hasChanges: summary.create > 0 || summary.update > 0,
      summary,
      resources,
      namingExamples: scheduled.value.namingExamples,
      execution: Object.freeze([executionMetadata(scheduled.execution)]),
    }),
  });
}

/** Produces one deterministic semantic diff from a fresh, non-stale Lidarr snapshot. */
export async function executeLidarrPresetDiff(
  options: LidarrPresetDiffActionOptions,
): Promise<LidarrPresetDiffResult> {
  return (await readFreshReview(options)).review;
}

function summarizeApply(outcomes: readonly LidarrPresetApplyOutcome[]): LidarrPresetApplySummary {
  return Object.freeze({
    total: outcomes.length,
    succeeded: outcomes.filter(({ outcome }) => outcome === "succeeded").length,
    satisfied: outcomes.filter(({ outcome }) => outcome === "satisfied").length,
    failed: outcomes.filter(({ outcome }) => outcome === "failed").length,
    uncertain: outcomes.filter(({ outcome }) => outcome === "uncertain").length,
    notAttempted: outcomes.filter(({ outcome }) => outcome === "not-attempted").length,
  });
}

function applyResult(
  dryRun: boolean,
  status: LidarrPresetApplyResult["status"],
  review: LidarrPresetDiffResult,
  outcomes: readonly LidarrPresetApplyOutcome[],
  execution: readonly LidarrPresetExecutionMetadata[],
  error?: LidarrPresetSafeError,
): LidarrPresetApplyResult {
  return Object.freeze({
    schemaVersion: LIDARR_PRESET_APPLY_VERSION,
    dryRun,
    status,
    review,
    summary: summarizeApply(outcomes),
    outcomes: Object.freeze([...outcomes]),
    execution: Object.freeze([...execution]),
    ...(error === undefined ? {} : { error }),
  });
}

function outcomeBase(resource: LidarrPresetResourceDiff) {
  return { key: resource.key, resource: resource.resource, name: resource.name } as const;
}

function satisfied(
  resource: LidarrPresetResourceDiff,
  attempted = false,
): LidarrPresetApplyOutcome {
  return Object.freeze({
    ...outcomeBase(resource),
    outcome: "satisfied",
    attempted,
    dispatchState: attempted ? "dispatched" : "not-dispatched",
    verificationState: "verified",
  });
}

function safeError(
  resource: LidarrPresetResourceDiff,
  code: string,
  phase: string,
  retryable: boolean,
): NonNullable<Extract<LidarrPresetApplyOutcome, { outcome: "failed" }>["error"]> {
  return safeRunError(resource.key, code, phase, retryable);
}

function safeRunError(
  resourcePath: string,
  code: string,
  phase: string,
  retryable: boolean,
): LidarrPresetSafeError {
  return Object.freeze({
    code,
    phase,
    resourcePath,
    retryable,
    nextAction: "Run preset diff again, inspect the fresh state, then retry apply.",
  });
}

function reviewedStateMatches(
  reviewed: LidarrPresetResourceDiff,
  current: LidarrPresetResourceDiff,
): boolean {
  return (
    reviewed.key === current.key &&
    reviewed.action === current.action &&
    ("liveId" in reviewed ? reviewed.liveId : undefined) ===
      ("liveId" in current ? current.liveId : undefined) &&
    JSON.stringify(reviewed.before) === JSON.stringify(current.before) &&
    JSON.stringify(reviewed.after) === JSON.stringify(current.after)
  );
}

interface ProfileFormatScoreSemantic {
  readonly [key: string]: LidarrPresetSemanticValue;
  readonly customFormatName: string;
  readonly score: number;
}

function profileSemantic(value: LidarrPresetSemanticValue):
  | (Readonly<Record<string, LidarrPresetSemanticValue>> & {
      readonly formatScores: readonly ProfileFormatScoreSemantic[];
    })
  | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, LidarrPresetSemanticValue>>;
  const formatScores = record["formatScores"];
  if (
    !Array.isArray(formatScores) ||
    !formatScores.every(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        typeof entry["customFormatName"] === "string" &&
        typeof entry["score"] === "number",
    )
  ) {
    return undefined;
  }
  return record as Readonly<Record<string, LidarrPresetSemanticValue>> & {
    readonly formatScores: readonly ProfileFormatScoreSemantic[];
  };
}

function rebaseCreatedFormatDependency(
  baseline: LidarrPresetResourceDiff,
  refreshed: LidarrPresetResourceDiff,
  createdFormat: LidarrPresetResourceDiff,
): LidarrPresetResourceDiff {
  if (
    createdFormat.resource !== "custom-format" ||
    createdFormat.action !== "create" ||
    baseline.resource !== "quality-profile" ||
    baseline.action !== "update" ||
    refreshed.resource !== "quality-profile" ||
    refreshed.action !== "update"
  ) {
    return baseline;
  }
  const baselineBefore = profileSemantic(baseline.before);
  const refreshedBefore = profileSemantic(refreshed.before);
  if (baselineBefore === undefined || refreshedBefore === undefined) return baseline;

  const normalizedFormatName = createdFormat.name.trim().toLocaleLowerCase();
  if (
    baselineBefore.formatScores.some(
      ({ customFormatName }) =>
        customFormatName.trim().toLocaleLowerCase() === normalizedFormatName,
    )
  ) {
    return baseline;
  }
  const dependencyScores = refreshedBefore.formatScores.filter(
    ({ customFormatName, score }) =>
      customFormatName.trim().toLocaleLowerCase() === normalizedFormatName && score === 0,
  );
  if (dependencyScores.length !== 1) return baseline;
  const scoresWithoutDependency = refreshedBefore.formatScores.filter(
    ({ customFormatName }) => customFormatName.trim().toLocaleLowerCase() !== normalizedFormatName,
  );
  if (JSON.stringify(scoresWithoutDependency) !== JSON.stringify(baselineBefore.formatScores)) {
    return baseline;
  }

  return Object.freeze({
    ...baseline,
    before: Object.freeze({
      ...baselineBefore,
      formatScores: Object.freeze([...refreshedBefore.formatScores]),
    }),
  });
}

function managedResources(review: LidarrPresetDiffResult): readonly LidarrPresetResourceDiff[] {
  return review.resources.filter(({ action }) => action !== "retained");
}

function changedResources(review: LidarrPresetDiffResult): readonly LidarrPresetResourceDiff[] {
  return review.resources.filter(({ action }) => action === "create" || action === "update");
}

function journalStatus(
  outcomes: readonly LidarrPresetApplyOutcome[],
): LidarrPresetApplyJournal["status"] {
  if (outcomes.some(({ outcome }) => outcome === "uncertain")) return "uncertain";
  if (outcomes.some(({ outcome }) => outcome === "failed" || outcome === "not-attempted")) {
    return outcomes.some(({ outcome }) => outcome === "succeeded" || outcome === "satisfied")
      ? "partial"
      : "failed";
  }
  return "completed";
}

function resultStatus(
  outcomes: readonly LidarrPresetApplyOutcome[],
): LidarrPresetApplyResult["status"] {
  const persistedStatus = journalStatus(outcomes);
  if (persistedStatus === "completed") return "completed";
  if (persistedStatus === "partial") return "partial";
  return outcomes.some(({ outcome }) => outcome === "succeeded" || outcome === "satisfied")
    ? "partial"
    : "failed";
}

function journalWithState(
  journal: LidarrPresetApplyJournal,
  index: number,
  state: LidarrPresetJournalResourceState,
  status: LidarrPresetApplyJournal["status"] = "in-progress",
): LidarrPresetApplyJournal {
  const resources = journal.resources.map((current, currentIndex) =>
    currentIndex === index ? state : current,
  );
  return Object.freeze({
    ...journal,
    updatedAt: new Date().toISOString(),
    status,
    resources: Object.freeze(resources),
  });
}

async function runDestructiveWrite(
  resource: LidarrPresetResourceDiff,
  pack: LidarrPresetPack,
  snapshot: LidarrPresetLiveState,
  client: LidarrClientApi,
  signal: AbortSignal,
): Promise<LidarrPresetExecutionMetadata> {
  const scheduled = await resolveLidarrScheduler().runSingle(
    "destructive",
    {
      id: `lidarr-presets-apply-${resource.key}`,
      operation: `lidarr presets apply ${resource.key}`,
      idempotent: false,
      run: async () => {
        if (resource.resource === "custom-format") {
          const desired = pack.customFormats.find(({ name }) => name === resource.name);
          if (desired === undefined) throw new Error("Reviewed custom format is not in the pack");
          if (resource.action === "create") await client.createCustomFormat(desired, signal);
          else await client.updateCustomFormat({ ...desired, id: resource.liveId }, signal);
          return;
        }
        if (resource.resource === "quality-profile") {
          const desired = pack.qualityProfiles.find(({ name }) => name === resource.name);
          if (desired === undefined) throw new Error("Reviewed quality profile is not in the pack");
          const current =
            resource.action === "update"
              ? snapshot.qualityProfiles.find(({ id }) => id === resource.liveId)
              : undefined;
          const input = buildLidarrPresetQualityProfileInput(
            desired,
            snapshot.qualityProfileSchema,
            current,
          );
          if (resource.action === "create") await client.createQualityProfile(input, signal);
          else await client.updateQualityProfile({ ...input, id: resource.liveId }, signal);
          return;
        }
        if (!("liveId" in resource) || resource.liveId === undefined) {
          throw new Error("Naming apply requires the reviewed singleton ID");
        }
        await client.updateNamingConfig({ id: resource.liveId, ...pack.naming }, signal);
      },
    },
    { signal },
  );
  return executionMetadata(scheduled.execution);
}

async function persistTerminal(
  handle: LidarrPresetApplyJournalHandle,
  journal: LidarrPresetApplyJournal,
  index: number,
  resource: LidarrPresetResourceDiff,
  outcome: LidarrPresetApplyOutcome,
): Promise<LidarrPresetApplyJournal> {
  const next = journalWithState(journal, index, {
    state: "terminal",
    resource,
    outcome,
    recordedAt: new Date().toISOString(),
  });
  await handle.transition(next);
  return next;
}

/** Applies a reviewed preset under one origin lock with durable per-resource verification. */
export async function executeLidarrPresetApply(
  options: LidarrPresetApplyActionOptions,
): Promise<LidarrPresetApplyResult> {
  const initial = await readFreshReview(options);
  if (options.dryRun === true) {
    return applyResult(true, "checked", initial.review, [], initial.review.execution);
  }
  const initiallyManaged = managedResources(initial.review);
  if (!initial.review.hasChanges) {
    return applyResult(
      false,
      "completed",
      initial.review,
      initiallyManaged.map((resource) => satisfied(resource)),
      initial.review.execution,
    );
  }

  const pack = resolvePack(options.packRef);
  const lock: LidarrPresetApplyLock = await acquireLidarrPresetApplyLock(
    initial.review.targetOrigin,
  );
  const localAbortController = new AbortController();
  const globalSignal = getGlobalSignal();
  const forwardGlobalAbort = () => localAbortController.abort(globalSignal.reason);
  const forwardCallerAbort = () => localAbortController.abort(options.signal?.reason);
  if (globalSignal.aborted) forwardGlobalAbort();
  else globalSignal.addEventListener("abort", forwardGlobalAbort, { once: true });
  if (options.signal?.aborted === true) forwardCallerAbort();
  else options.signal?.addEventListener("abort", forwardCallerAbort, { once: true });
  const signal = localAbortController.signal;
  const cleanupName = `lidarr-preset-apply-${lock.originDigest}-${randomUUID()}`;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  registerGlobalCleanup({
    priority: 10,
    name: cleanupName,
    cleanup: async () => {
      if (!signal.aborted) localAbortController.abort();
      await settled;
    },
  });

  const execution: LidarrPresetExecutionMetadata[] = [...initial.review.execution];
  let finalReview = initial.review;
  try {
    signal.throwIfAborted();
    await lock.assertOwned();
    const underLock = await readFreshReview({ ...options, signal });
    finalReview = underLock.review;
    execution.push(...underLock.review.execution);
    if (!finalReview.hasChanges) {
      return applyResult(
        false,
        "completed",
        finalReview,
        managedResources(finalReview).map((resource) => satisfied(resource)),
        execution,
      );
    }
    if (!(await options.confirm(finalReview))) {
      return applyResult(false, "declined", finalReview, [], execution);
    }
    signal.throwIfAborted();
    await lock.assertOwned();

    const changed = changedResources(finalReview);
    const createdAt = new Date().toISOString();
    let journal: LidarrPresetApplyJournal = Object.freeze({
      schemaVersion: LIDARR_PRESET_JOURNAL_VERSION,
      id: randomUUID(),
      createdAt,
      updatedAt: createdAt,
      status: "in-progress",
      pack: packIdentity(pack),
      targetOrigin: finalReview.targetOrigin,
      resources: Object.freeze(
        changed.map((resource) => Object.freeze({ state: "pending" as const, resource })),
      ),
    });
    const journalHandle = await createLidarrPresetApplyJournal(lock, journal);
    const reviewedBaselines = new Map(changed.map((resource) => [resource.key, resource]));
    const outcomes = new Map(
      managedResources(finalReview)
        .filter(({ action }) => action === "unchanged")
        .map((resource) => [resource.key, satisfied(resource)]),
    );
    let blockedBy: LidarrPresetResourceDiff | undefined;

    for (const [index, reviewed] of changed.entries()) {
      if (blockedBy !== undefined || signal.aborted) {
        blockedBy ??= reviewed;
        const outcome: LidarrPresetApplyOutcome = Object.freeze({
          ...outcomeBase(reviewed),
          outcome: "not-attempted",
          attempted: false,
          dispatchState: "not-dispatched",
          verificationState: "not-started",
          blockedBy: blockedBy.key,
        });
        outcomes.set(reviewed.key, outcome);
        journal = await persistTerminal(journalHandle, journal, index, reviewed, outcome);
        continue;
      }

      let beforeWrite: FreshReview;
      try {
        await lock.assertOwned();
        beforeWrite = await readFreshReview({ ...options, signal });
        execution.push(...beforeWrite.review.execution);
      } catch {
        const outcome: LidarrPresetApplyOutcome = Object.freeze({
          ...outcomeBase(reviewed),
          outcome: "failed",
          attempted: false,
          dispatchState: "not-dispatched",
          verificationState: "not-started",
          error: safeError(reviewed, "LIDARR_PRESET_PREFLIGHT_FAILED", "pre-dispatch", true),
        });
        outcomes.set(reviewed.key, outcome);
        journal = await persistTerminal(journalHandle, journal, index, reviewed, outcome);
        blockedBy = reviewed;
        continue;
      }
      const current = beforeWrite.review.resources.find(({ key }) => key === reviewed.key);
      if (current?.action === "unchanged") {
        const outcome = satisfied(reviewed);
        outcomes.set(reviewed.key, outcome);
        journal = await persistTerminal(journalHandle, journal, index, reviewed, outcome);
        continue;
      }
      const reviewedBaseline = reviewedBaselines.get(reviewed.key) ?? reviewed;
      if (current === undefined || !reviewedStateMatches(reviewedBaseline, current)) {
        const outcome: LidarrPresetApplyOutcome = Object.freeze({
          ...outcomeBase(reviewed),
          outcome: "failed",
          attempted: false,
          dispatchState: "not-dispatched",
          verificationState: "not-started",
          error: safeError(reviewed, "LIDARR_PRESET_STALE", "pre-dispatch", false),
        });
        outcomes.set(reviewed.key, outcome);
        journal = await persistTerminal(journalHandle, journal, index, reviewed, outcome);
        blockedBy = reviewed;
        continue;
      }

      try {
        journal = journalWithState(journal, index, {
          state: "dispatching",
          resource: reviewed,
          dispatchStartedAt: new Date().toISOString(),
        });
        await journalHandle.transition(journal);
      } catch {
        const outcome: LidarrPresetApplyOutcome = Object.freeze({
          ...outcomeBase(reviewed),
          outcome: "failed",
          attempted: false,
          dispatchState: "not-dispatched",
          verificationState: "not-started",
          error: safeError(reviewed, "LIDARR_PRESET_JOURNAL_WRITE_FAILED", "pre-dispatch", true),
        });
        outcomes.set(reviewed.key, outcome);
        blockedBy = reviewed;
        break;
      }

      let dispatchFailed = false;
      let readBackReview: LidarrPresetDiffResult | undefined;
      try {
        const context = resolveRequiredLidarrExecutionContext(
          { lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey },
          { tier: "destructive", allowStale: false, retryAttemptsOverride: 0 },
        );
        execution.push(
          await runDestructiveWrite(reviewed, pack, beforeWrite.snapshot, context.client, signal),
        );
      } catch {
        dispatchFailed = true;
      }

      let outcome: LidarrPresetApplyOutcome;
      try {
        const readBack = await readFreshReview({ ...options, signal: undefined });
        readBackReview = readBack.review;
        execution.push(...readBack.review.execution);
        const observed = readBack.review.resources.find(({ key }) => key === reviewed.key);
        if (observed?.action === "unchanged") {
          outcome = dispatchFailed
            ? Object.freeze({
                ...outcomeBase(reviewed),
                outcome: "satisfied",
                attempted: true,
                dispatchState: "dispatch-unknown",
                verificationState: "verified",
              })
            : Object.freeze({
                ...outcomeBase(reviewed),
                outcome: "succeeded",
                attempted: true,
                dispatchState: "dispatched",
                verificationState: "verified",
              });
        } else if (dispatchFailed) {
          outcome = Object.freeze({
            ...outcomeBase(reviewed),
            outcome: "uncertain",
            attempted: true,
            dispatchState: "dispatch-unknown",
            verificationState: "inconclusive",
            error: safeError(reviewed, "LIDARR_PRESET_DISPATCH_UNCERTAIN", "read-back", true),
          });
        } else {
          outcome = Object.freeze({
            ...outcomeBase(reviewed),
            outcome: "failed",
            attempted: true,
            dispatchState: "dispatched",
            verificationState: "failed",
            error: safeError(reviewed, "LIDARR_PRESET_READ_BACK_MISMATCH", "read-back", false),
          });
        }
      } catch {
        outcome = Object.freeze({
          ...outcomeBase(reviewed),
          outcome: "uncertain",
          attempted: true,
          dispatchState: dispatchFailed ? "dispatch-unknown" : "dispatched",
          verificationState: "inconclusive",
          error: safeError(reviewed, "LIDARR_PRESET_READ_BACK_FAILED", "read-back", true),
        });
      }
      outcomes.set(reviewed.key, outcome);
      try {
        journal = await persistTerminal(journalHandle, journal, index, reviewed, outcome);
      } catch {
        outcome = Object.freeze({
          ...outcomeBase(reviewed),
          outcome: "uncertain",
          attempted: true,
          dispatchState: dispatchFailed ? "dispatch-unknown" : "dispatched",
          verificationState: "inconclusive",
          error: safeError(reviewed, "LIDARR_PRESET_JOURNAL_WRITE_FAILED", "post-dispatch", true),
        });
        outcomes.set(reviewed.key, outcome);
        blockedBy = reviewed;
        break;
      }
      if (
        reviewed.resource === "custom-format" &&
        readBackReview !== undefined &&
        (outcome.outcome === "succeeded" || outcome.outcome === "satisfied")
      ) {
        for (const refreshed of readBackReview.resources) {
          if (
            reviewedBaselines.has(refreshed.key) &&
            !outcomes.has(refreshed.key) &&
            refreshed.dependencies.includes(reviewed.key)
          ) {
            reviewedBaselines.set(
              refreshed.key,
              rebaseCreatedFormatDependency(
                reviewedBaselines.get(refreshed.key) ?? refreshed,
                refreshed,
                reviewed,
              ),
            );
          }
        }
      }
      if (outcome.outcome !== "succeeded" && outcome.outcome !== "satisfied") {
        blockedBy = reviewed;
      }
    }

    if (blockedBy !== undefined) {
      for (const [index, reviewed] of changed.entries()) {
        if (outcomes.has(reviewed.key)) continue;
        const outcome: LidarrPresetApplyOutcome = Object.freeze({
          ...outcomeBase(reviewed),
          outcome: "not-attempted",
          attempted: false,
          dispatchState: "not-dispatched",
          verificationState: "not-started",
          blockedBy: blockedBy.key,
        });
        outcomes.set(reviewed.key, outcome);
        if (journal.resources[index]?.state === "pending") {
          try {
            journal = await persistTerminal(journalHandle, journal, index, reviewed, outcome);
          } catch {
            break;
          }
        }
      }
    }

    const orderedOutcomes = managedResources(finalReview)
      .map(({ key }) => outcomes.get(key))
      .filter((outcome): outcome is LidarrPresetApplyOutcome => outcome !== undefined);
    const finalJournal = Object.freeze({
      ...journal,
      updatedAt: new Date().toISOString(),
      status: journalStatus(orderedOutcomes),
    });
    let status = resultStatus(orderedOutcomes);
    let error: LidarrPresetSafeError | undefined;
    try {
      await journalHandle.finalize(finalJournal);
    } catch {
      // Remote state is never replayed or rolled back when final journal durability is uncertain.
      status = "partial";
      error = safeRunError(
        journalHandle.path,
        "LIDARR_PRESET_JOURNAL_WRITE_FAILED",
        "finalize",
        true,
      );
    }
    return applyResult(false, status, finalReview, orderedOutcomes, execution, error);
  } finally {
    try {
      await lock.release();
    } finally {
      settle();
      unregisterGlobalCleanup(cleanupName);
      globalSignal.removeEventListener("abort", forwardGlobalAbort);
      options.signal?.removeEventListener("abort", forwardCallerAbort);
    }
  }
}
