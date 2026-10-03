/**
 * Lidarr deferred-intent queue — domain API (issue #195).
 *
 * Operation-generic enqueue/list/replay/clear orchestration layered over the
 * row-level CRUD in `deferred-queue-db.ts` (queue.ts / queue-db.ts sibling
 * precedent). Mutations that fail with a retryable code — or are attempted
 * while the relevant circuit is open — are captured as replayable intents so
 * user intent is never lost; #202 registers the real mutation executors.
 *
 * Replay is EXPLICIT-INVOCATION ONLY (#202 `apply --resume`, #196 post-gate
 * dispatch). No auto-replay hook exists anywhere: mutations never run as a
 * side effect of health checks or unrelated commands.
 */

import { createHash, randomUUID } from "node:crypto";

import { logDebug } from "../logger.js";
import {
  claimDeferredIntent,
  clearDeferredIntentRows,
  getDeferredIntentRow,
  insertDeferredIntent,
  listDeferredIntentRows,
  recordDeferredIntentAttempt,
  selectDueDeferredIntents,
  updateDeferredIntentStatus,
} from "./deferred-queue-db.js";
import { LidarrError } from "./errors.js";
import { LIDARR_TIER_DESCRIPTORS } from "./tiers.js";
import type { DbConnection, DbLidarrDeferredIntent } from "../../types/db.js";
import type { CircuitScope, LidarrCircuitBreaker } from "./circuit-breaker.js";
import type { LidarrClientApi } from "./client.js";
import type { LidarrErrorCode } from "./errors.js";
import type { LidarrTier } from "./tiers.js";

/** Base delay of the replay backoff schedule (first retry waits this long). */
const REPLAY_BACKOFF_BASE_MS = 30_000;

/** Ceiling of the replay backoff schedule (one hour). */
const REPLAY_BACKOFF_CAP_MS = 3_600_000;

/** Lifecycle status of a deferred intent. */
export type LidarrDeferredIntentStatus =
  | "pending"
  | "in-progress"
  | "succeeded"
  | "failed"
  | "cancelled";

/**
 * A persisted, replayable unit of user intent (domain view of one
 * `lidarr_deferred_intents` row).
 */
export interface LidarrDeferredIntent {
  /** UUID primary key (queue_jobs TEXT-PK precedent; replay-stable for #202 --resume). */
  readonly id: string;
  /** Credential-free canonical Lidarr origin — never the API key. */
  readonly origin: string;
  /** Executor-map key, e.g. "lidarr add artist" (#202 vocabulary; opaque here). */
  readonly operation: string;
  /** Reliability tier the deferred operation runs in. */
  readonly tier: LidarrTier;
  /** Replayable operation payload (parsed, frozen). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** sha256(operation + canonical JSON payload) unless supplied explicitly. */
  readonly idempotencyKey: string;
  /** Current lifecycle status. */
  readonly status: LidarrDeferredIntentStatus;
  /** Replay attempts made so far. */
  readonly attempts: number;
  /** Attempt ceiling; a retryable failure at this count becomes `failed`. */
  readonly maxAttempts: number;
  /** Classification code of the most recent failure, when any. */
  readonly errorCode: LidarrErrorCode | null;
  /** Scrubbed failure message — never raw bodies or credentials. */
  readonly errorMessage: string | null;
  /** ISO timestamp the intent was first enqueued. */
  readonly createdAt: string;
  /** ISO timestamp of the last row update. */
  readonly updatedAt: string;
  /** ISO timestamp before which replay must not retry, when scheduled. */
  readonly nextAttemptAt: string | null;
  /** ISO timestamp of the most recent replay attempt, when any. */
  readonly lastAttemptAt: string | null;
}

/**
 * Input for {@link enqueueDeferredIntent}.
 *
 * `origin` is required because intents are idempotent per
 * `(origin, idempotency_key)` — the producer supplies the credential-free
 * canonical origin it resolved the client for.
 */
export interface EnqueueDeferredIntentInput {
  /** Credential-free canonical Lidarr origin — never the API key. */
  readonly origin: string;
  /** Executor-map key for replay (#202 vocabulary; opaque here). */
  readonly operation: string;
  /** Reliability tier the deferred operation runs in. */
  readonly tier: LidarrTier;
  /** Replayable operation payload (JSON-serializable). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** Explicit idempotency key; defaults to sha256(operation + canonical JSON payload). */
  readonly idempotencyKey?: string;
  /** The failure that deferred this intent; seeds errorCode/errorMessage and, when the error carries `retryAfterSeconds`, `nextAttemptAt`. */
  readonly error?: LidarrError;
  /** Attempt ceiling; when omitted the schema default (5) applies. */
  readonly maxAttempts?: number;
}

/** Exact-match selectors for listing deferred intents. */
export interface DeferredIntentFilter {
  /** Only intents with this lifecycle status. */
  readonly status?: LidarrDeferredIntentStatus;
  /** Only intents for this credential-free canonical origin. */
  readonly origin?: string;
  /** Only intents for this exact executor-map operation. */
  readonly operation?: string;
  /** Only intents with one of these idempotency keys (at most 1,000). */
  readonly idempotencyKeys?: readonly string[];
  /** Maximum number of fully filtered intents to return. */
  readonly limit?: number;
}

/**
 * One replay executor per mutation operation. #202 registers these;
 * #195 ships none. Executors receive the (already-resilient) client.
 */
export interface LidarrIntentExecutor {
  /** The executor-map key this executor handles. */
  readonly operation: string;
  /**
   * Replay one intent payload against Lidarr.
   *
   * @param payload - Parsed intent payload.
   * @param client - Lidarr client seam to execute against.
   * @param signal - Optional abort signal for cancellation.
   * @throws {LidarrError} Retryable codes reschedule the intent; non-retryable codes fail it immediately.
   */
  execute(
    payload: Readonly<Record<string, unknown>>,
    client: LidarrClientApi,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** Per-intent result of one {@link replayDeferredIntents} pass. */
export interface LidarrReplayOutcome {
  /** Intent row id. */
  readonly id: string;
  /** Executor-map key of the intent. */
  readonly operation: string;
  /**
   * What happened to the intent during this pass. `cancelled` means the
   * in-flight executor was aborted (Ctrl-C): the row is restored to `pending`
   * untouched and the pass stops — cancellation is not a failure.
   */
  readonly outcome:
    | "succeeded"
    | "retried-later"
    | "failed"
    | "cancelled"
    | "no-executor"
    | "skipped-circuit-open";
  /** Classification code of the failure or circuit rejection, when known. */
  readonly errorCode?: LidarrErrorCode;
  /** Human-readable detail (scrubbed — never raw bodies or credentials). */
  readonly message?: string;
}

/** Aggregate result of one {@link replayDeferredIntents} pass. */
export interface LidarrReplayReport {
  /** Number of intents whose executor was actually invoked. */
  readonly attempted: number;
  /** One outcome per due intent considered (including skips). */
  readonly outcomes: readonly LidarrReplayOutcome[];
}

/** All known error codes, kept in lockstep with {@link LidarrErrorCode} via `satisfies`. */
const LIDARR_ERROR_CODE_FLAGS = {
  "lidarr-unreachable": true,
  "metadata-provider-unavailable": true,
  "rate-limited": true,
  validation: true,
  authentication: true,
  authorization: true,
  "not-found": true,
  "invalid-response": true,
  timeout: true,
  configuration: true,
} satisfies Record<LidarrErrorCode, true>;

const KNOWN_LIDARR_ERROR_CODES: ReadonlySet<string> = new Set(Object.keys(LIDARR_ERROR_CODE_FLAGS));

function isLidarrErrorCode(value: string): value is LidarrErrorCode {
  return KNOWN_LIDARR_ERROR_CODES.has(value);
}

function narrowErrorCode(raw: string | null, id: string): LidarrErrorCode | null {
  if (raw === null) {
    return null;
  }
  if (!isLidarrErrorCode(raw)) {
    throw new Error(`Malformed deferred intent ${id}: unknown error_code '${raw}'`);
  }
  return raw;
}

function parseIntentPayload(payloadJson: string, id: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch (cause) {
    throw new Error(`Malformed deferred intent payload for ${id}: not valid JSON`, { cause });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Malformed deferred intent payload for ${id}: expected a JSON object`);
  }
  return Object.freeze(parsed as Record<string, unknown>);
}

/** Deterministic JSON: object keys sorted recursively, `undefined` members dropped. */
function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJsonStringify(entryValue)}`)
    .join(",")}}`;
}

function deriveIdempotencyKey(
  operation: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256")
    .update(`${operation}${canonicalJsonStringify(payload)}`)
    .digest("hex");
}

function toDeferredIntent(row: DbLidarrDeferredIntent): LidarrDeferredIntent {
  return {
    id: row.id,
    origin: row.origin,
    operation: row.operation,
    tier: row.tier,
    payload: parseIntentPayload(row.payload_json, row.id),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    errorCode: narrowErrorCode(row.error_code, row.id),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
  };
}

/**
 * Enqueue a deferred intent idempotently.
 *
 * Idempotent on `(origin, idempotency_key)` via `INSERT OR IGNORE`: re-running
 * a half-applied plan can never duplicate intent, and a duplicate enqueue
 * returns the pre-existing intent unchanged. When `input.error` carries
 * `retryAfterSeconds`, the first replay is scheduled that far in the future;
 * otherwise the intent is immediately due.
 *
 * @param db - Open tracking database connection (schema v10+).
 * @param input - Intent identity, payload, and optional failure seed.
 * @param nowIso - ISO timestamp seam for created_at/updated_at (defaults to now).
 * @returns The canonical intent for `(origin, idempotency_key)` after the insert.
 * @throws {Error} When the persisted row cannot be read back or is malformed.
 */
export function enqueueDeferredIntent(
  db: DbConnection,
  input: EnqueueDeferredIntentInput,
  nowIso: string = new Date().toISOString(),
): LidarrDeferredIntent {
  const idempotencyKey =
    input.idempotencyKey ?? deriveIdempotencyKey(input.operation, input.payload);
  const retryAfterSeconds = input.error?.retryAfterSeconds;
  const nextAttemptAt =
    retryAfterSeconds === undefined
      ? undefined
      : new Date(Date.parse(nowIso) + retryAfterSeconds * 1000).toISOString();

  const row = insertDeferredIntent(
    db,
    {
      id: randomUUID(),
      origin: input.origin,
      operation: input.operation,
      tier: input.tier,
      payloadJson: JSON.stringify(input.payload),
      idempotencyKey,
      maxAttempts: input.maxAttempts,
      errorCode: input.error?.code,
      errorMessage: input.error?.message,
      nextAttemptAt,
    },
    nowIso,
  );
  return toDeferredIntent(row);
}

/**
 * List deferred intents in enqueue order.
 *
 * @param db - Open tracking database connection (schema v10+).
 * @param filter - Optional exact-match filters and final result limit.
 * @returns Matching intents mapped to the domain shape.
 * @throws {Error} When `filter.limit` is invalid or idempotencyKeys exceeds 1,000 entries.
 */
export function listDeferredIntents(
  db: DbConnection,
  filter?: DeferredIntentFilter,
): readonly LidarrDeferredIntent[] {
  return listDeferredIntentRows(db, {
    status: filter?.status,
    origin: filter?.origin,
    operation: filter?.operation,
    idempotencyKeys: filter?.idempotencyKeys,
    limit: filter?.limit,
  }).map(toDeferredIntent);
}

/** Claims one exact pending intent for an exclusive final live-state decision. */
export function claimDeferredIntentForReplay(
  db: DbConnection,
  id: string,
  nowIso: string = new Date().toISOString(),
): LidarrDeferredIntent | undefined {
  if (!claimDeferredIntent(db, id, nowIso)) return undefined;
  const row = getDeferredIntentRow(db, id);
  if (row === undefined || row.status !== "in-progress") {
    throw new Error(`Deferred intent ${id} was not readable after claim`);
  }
  return toDeferredIntent(row);
}

/** Restores a caller-owned claim without changing attempts or failure metadata. */
export function restoreClaimedDeferredIntent(
  db: DbConnection,
  id: string,
  nowIso: string = new Date().toISOString(),
): void {
  const row = getDeferredIntentRow(db, id);
  if (row === undefined || row.status !== "in-progress") return;
  updateDeferredIntentStatus(db, id, "pending", nowIso);
}

/** Marks a caller-owned intent satisfied without invoking its remote executor. */
export function completeClaimedDeferredIntent(
  db: DbConnection,
  intent: LidarrDeferredIntent,
  nowIso: string = new Date().toISOString(),
): void {
  const row = getDeferredIntentRow(db, intent.id);
  if (row === undefined || row.status !== "in-progress") {
    throw new Error(`Deferred intent ${intent.id} is no longer claimed`);
  }
  recordDeferredIntentAttempt(
    db,
    intent.id,
    { status: "succeeded", attempts: intent.attempts },
    nowIso,
  );
}

/**
 * Delete deferred intents by id and/or status (AND semantics when both are
 * provided).
 *
 * @param db - Open tracking database connection (schema v10+).
 * @param filter - Ids and/or statuses to delete (at least one required).
 * @returns Number of intents deleted.
 * @throws {Error} When neither `ids` nor `statuses` is provided.
 */
export function clearDeferredIntents(
  db: DbConnection,
  filter: {
    readonly ids?: readonly string[];
    readonly statuses?: readonly LidarrDeferredIntentStatus[];
  },
): number {
  return clearDeferredIntentRows(db, { ids: filter.ids, statuses: filter.statuses });
}

/** Memoized circuit rejection for one scope during a single replay pass. */
interface ReplayCircuitBlock {
  readonly scope: CircuitScope;
  readonly reason: LidarrErrorCode;
  readonly retryAtIso: string;
}

/**
 * Breaker feedback hooks for one replay pass. Replay gates through the
 * breakers, so it must also resolve the probe claims those gates persist
 * (design §7d): executor successes feed `recordSuccess` on the gated scopes,
 * retryable executor failures feed `recordFailure` on the mapped scope.
 */
interface ReplayBreakerFeed {
  /** A gated executor call succeeded for an intent of this tier. */
  onSuccess(tier: LidarrTier): void;
  /** A gated executor call failed with a retryable {@link LidarrError}. */
  onRetryableFailure(error: LidarrError): void;
}

/** True when the error is an abort (Ctrl-C / AbortSignal) — never a service failure. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Replay due deferred intents through an explicit executor map.
 *
 * EXPLICIT INVOCATION ONLY — nothing in #195 calls this as a side effect;
 * #202's `apply --resume` and #196's post-gate dispatch are the callers.
 *
 * Selects due rows (`status = 'pending'` and unscheduled or `next_attempt_at`
 * at/before now, ordered by `created_at`, bounded by `limit`), gates once per
 * distinct tier via the breakers (`lidarr` scope always; `metadata` scope when
 * the tier descriptor requires the metadata server — blocked tiers yield
 * `skipped-circuit-open` with rows untouched), then claims each row
 * (`pending → in-progress`, `changes === 1` guard). A missing executor yields
 * `no-executor` and resets the row to `pending` untouched (pre-#202 replay is
 * inspect/no-op by design). Success marks the row `succeeded`; a retryable
 * failure below `maxAttempts` reschedules it with backoff
 * `min(30s × 2^(attempts-1), 1h)` — or exactly Retry-After when the error
 * carries it (`retried-later`); a retryable failure at `maxAttempts` or any
 * non-retryable failure marks it `failed`.
 *
 * Breaker feedback (design §7d): because gating an open circuit past its
 * cooldown persists a half-open probe claim, replay resolves that claim with
 * real outcomes — the first successful executor call records success on each
 * scope gated for the intent's tier, and a retryable {@link LidarrError} from
 * an executor records failure on the scope its code feeds (non-matching codes
 * no-op). Gate rejections, `no-executor`, and non-network outcomes never feed
 * the breakers.
 *
 * Cancellation is not a failure: when an in-flight executor aborts
 * (`AbortError` or `options.signal` aborted), the claimed row is restored to
 * `pending` with attempts and error fields untouched, the outcome is
 * `cancelled`, the pass stops, and the breakers are not fed — user intent is
 * never lost to Ctrl-C.
 *
 * @param db - Open tracking database connection (schema v10+).
 * @param client - Lidarr client seam handed to every executor.
 * @param executors - Explicit operation → executor map (no module-global registry).
 * @param breakers - Store-backed circuit handles for both scopes of the origin.
 * @param options - Optional id restriction, row limit, abort signal, and a
 *   deterministic clock seam for tests.
 * @returns A report with one outcome per due intent considered.
 * @throws {Error} When a persisted row is malformed (fail fast — no silent skip).
 */
export async function replayDeferredIntents(
  db: DbConnection,
  client: LidarrClientApi,
  executors: ReadonlyMap<string, LidarrIntentExecutor>,
  breakers: { readonly lidarr: LidarrCircuitBreaker; readonly metadata: LidarrCircuitBreaker },
  options?: {
    readonly ids?: readonly string[];
    /** Exact rows already claimed by this caller before its final live-state check. */
    readonly claimedIds?: readonly string[];
    readonly limit?: number;
    readonly signal?: AbortSignal;
    /** Deterministic clock seam for tests (defaults to the wall clock). */
    readonly now?: () => Date;
  },
): Promise<LidarrReplayReport> {
  const now = options?.now ?? ((): Date => new Date());
  const nowIso = now().toISOString();
  const claimedIds = new Set(options?.claimedIds ?? []);
  const pendingIds = options?.ids?.filter((id) => !claimedIds.has(id));
  const dueRows = selectDueDeferredIntents(db, nowIso, options?.limit, pendingIds);
  for (const id of claimedIds) {
    const row = getDeferredIntentRow(db, id);
    if (row === undefined || row.status !== "in-progress") {
      throw new Error(`Deferred intent ${id} is no longer claimed`);
    }
    if (row.next_attempt_at !== null && row.next_attempt_at > nowIso) {
      updateDeferredIntentStatus(db, id, "pending", nowIso);
      continue;
    }
    dueRows.push(row);
  }
  dueRows.sort((left, right) =>
    left.created_at === right.created_at
      ? left.id.localeCompare(right.id)
      : left.created_at.localeCompare(right.created_at),
  );
  if (options?.limit !== undefined) {
    const removed = dueRows.splice(options.limit);
    for (const row of removed) {
      if (claimedIds.has(row.id)) updateDeferredIntentStatus(db, row.id, "pending", nowIso);
    }
  }

  const scopeBlocks = new Map<CircuitScope, ReplayCircuitBlock | null>();
  const gateScope = (scope: CircuitScope): ReplayCircuitBlock | null => {
    const cached = scopeBlocks.get(scope);
    if (cached !== undefined) {
      return cached;
    }
    const decision = (scope === "lidarr" ? breakers.lidarr : breakers.metadata).gate();
    const block = decision.allowed
      ? null
      : { scope, reason: decision.reason, retryAtIso: decision.retryAtIso };
    scopeBlocks.set(scope, block);
    return block;
  };

  const tierBlocks = new Map<LidarrTier, ReplayCircuitBlock | null>();
  const blockForTier = (tier: LidarrTier): ReplayCircuitBlock | null => {
    const cached = tierBlocks.get(tier);
    if (cached !== undefined) {
      return cached;
    }
    const block =
      gateScope("lidarr") ??
      (LIDARR_TIER_DESCRIPTORS[tier].metadataServerRequired ? gateScope("metadata") : null);
    tierBlocks.set(tier, block);
    return block;
  };

  const successFedScopes = new Set<CircuitScope>();
  const breakerFeed: ReplayBreakerFeed = {
    onSuccess(tier: LidarrTier): void {
      const scopes: readonly CircuitScope[] = LIDARR_TIER_DESCRIPTORS[tier].metadataServerRequired
        ? ["lidarr", "metadata"]
        : ["lidarr"];
      for (const scope of scopes) {
        if (!successFedScopes.has(scope)) {
          successFedScopes.add(scope);
          (scope === "lidarr" ? breakers.lidarr : breakers.metadata).recordSuccess();
        }
      }
    },
    onRetryableFailure(error: LidarrError): void {
      // Each breaker no-ops unless error.code feeds its scope (design §8).
      breakers.lidarr.recordFailure(error);
      breakers.metadata.recordFailure(error);
    },
  };

  const outcomes: LidarrReplayOutcome[] = [];
  let attempted = 0;

  for (const row of dueRows) {
    if (options?.signal?.aborted) {
      for (const claimedId of claimedIds) restoreClaimedDeferredIntent(db, claimedId);
      logDebug("Replay aborted; leaving remaining deferred intents untouched");
      break;
    }

    const block = blockForTier(row.tier);
    if (block !== null) {
      if (claimedIds.has(row.id)) {
        updateDeferredIntentStatus(db, row.id, "pending", now().toISOString());
      }
      outcomes.push({
        id: row.id,
        operation: row.operation,
        outcome: "skipped-circuit-open",
        errorCode: block.reason,
        message: `Circuit open [${block.scope}]; replay resumes at ${block.retryAtIso}`,
      });
      continue;
    }

    if (!claimedIds.has(row.id) && !claimDeferredIntent(db, row.id, now().toISOString())) {
      logDebug(`Deferred intent ${row.id} claimed elsewhere; skipping`);
      continue;
    }

    const executor = executors.get(row.operation);
    if (executor === undefined) {
      updateDeferredIntentStatus(db, row.id, "pending", now().toISOString());
      outcomes.push({
        id: row.id,
        operation: row.operation,
        outcome: "no-executor",
        message: `No executor registered for operation '${row.operation}'`,
      });
      continue;
    }

    attempted += 1;
    const outcome = await executeIntent(
      db,
      client,
      executor,
      row,
      breakerFeed,
      now,
      options?.signal,
    );
    outcomes.push(outcome);
    if (outcome.outcome === "cancelled") {
      logDebug("Replay cancelled mid-executor; leaving remaining deferred intents untouched");
      break;
    }
  }

  return { attempted, outcomes };
}

async function executeIntent(
  db: DbConnection,
  client: LidarrClientApi,
  executor: LidarrIntentExecutor,
  row: DbLidarrDeferredIntent,
  feed: ReplayBreakerFeed,
  now: () => Date,
  signal?: AbortSignal,
): Promise<LidarrReplayOutcome> {
  const attempts = row.attempts + 1;
  try {
    const payload = parseIntentPayload(row.payload_json, row.id);
    await executor.execute(payload, client, signal);
    recordDeferredIntentAttempt(db, row.id, { status: "succeeded", attempts }, now().toISOString());
    feed.onSuccess(row.tier);
    return { id: row.id, operation: row.operation, outcome: "succeeded" };
  } catch (error) {
    if (isAbortError(error) || signal?.aborted === true) {
      // Cancellation is not a failure: restore the claim untouched (no attempt
      // increment, no error fields, no breaker feed) so a later replay picks
      // the intent up again — user intent is never lost (design §1/§7e).
      updateDeferredIntentStatus(db, row.id, "pending", now().toISOString());
      return {
        id: row.id,
        operation: row.operation,
        outcome: "cancelled",
        message: "Replay cancelled; intent restored to pending",
      };
    }
    if (error instanceof LidarrError && error.retryable) {
      feed.onRetryableFailure(error);
    }
    return recordFailedAttempt(db, row, attempts, error, now);
  }
}

function recordFailedAttempt(
  db: DbConnection,
  row: DbLidarrDeferredIntent,
  attempts: number,
  error: unknown,
  now: () => Date,
): LidarrReplayOutcome {
  const nowIso = now().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const lidarrError = error instanceof LidarrError ? error : undefined;

  if (lidarrError !== undefined && lidarrError.retryable && attempts < row.max_attempts) {
    const backoffMs =
      lidarrError.retryAfterSeconds === undefined
        ? Math.min(REPLAY_BACKOFF_BASE_MS * 2 ** row.attempts, REPLAY_BACKOFF_CAP_MS)
        : lidarrError.retryAfterSeconds * 1000;
    const nextAttemptAt = new Date(Date.parse(nowIso) + backoffMs).toISOString();
    recordDeferredIntentAttempt(
      db,
      row.id,
      {
        status: "pending",
        attempts,
        errorCode: lidarrError.code,
        errorMessage: message,
        nextAttemptAt,
      },
      nowIso,
    );
    return {
      id: row.id,
      operation: row.operation,
      outcome: "retried-later",
      errorCode: lidarrError.code,
      message,
    };
  }

  recordDeferredIntentAttempt(
    db,
    row.id,
    {
      status: "failed",
      attempts,
      errorCode: lidarrError?.code ?? null,
      errorMessage: message,
    },
    nowIso,
  );
  return {
    id: row.id,
    operation: row.operation,
    outcome: "failed",
    ...(lidarrError === undefined ? {} : { errorCode: lidarrError.code }),
    message,
  };
}
