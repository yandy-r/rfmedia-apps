# Design — Issue #195: Lidarr Metadata Resilience Layer (FINAL)

**Package:** `packages/rfmedia-cli` · **Schema:** v9 → v10 · **Depends on:** #193 (foundation), #197 (actions), #255 (generated client) · **Feeds:** #196 (scheduler/lanes), #202 (plan/apply)

Synthesized from three competing designs per judge verdicts: **operator** skeleton (winner on correctness-fit, composability, simplicity-value), with **minimal**'s zero-churn resolver wrap, health-output-only visibility, and lean knob discipline grafted in, and **contract**'s explicit executor-map replay seam, claim-race guard, and convention-conforming table shapes grafted in. Every blocker/major defect is fixed; resolutions are enumerated in the Appendix.

---

## 1. Executive summary

Resilience is applied as an **outside decorator** around the existing `LidarrClientApi` facade — `transport.ts`, generated code, and the `LidarrError` taxonomy are untouched, and no new fetch call sites are introduced (verified by `check:architecture`). The decorator is surfaced **transparently through `resolveRequiredLidarrClient`** (additive second parameter), so all four shipped actions and their mock-the-barrel tests keep working with near-zero churn.

Four cooperating primitives ship:

1. **Circuit breaker** (`circuit-breaker.ts`) — a pure, discriminated-union state machine with **windowed failure counting** (3 failures within 5 minutes, matching the researched trip rule), **two scopes per origin** (`"lidarr"` transport vs `"metadata"` provider), an explicit **crashed-probe self-heal rule**, and SQLite-persisted state so consecutive CLI invocations share breaker state.
2. **Health monitor** (`lib/lidarr/health.ts`) — `runHealthProbe` + `ensureTierHealthy`, the per-lane pre-dispatch gate #196 consumes; behavior keyed strictly off `LIDARR_TIER_DESCRIPTORS`; the first (and only) construction sites of `MetadataProviderUnavailableError`.
3. **Deferred intent queue** (`deferred-queue.ts` + `deferred-queue-db.ts`, table `lidarr_deferred_intents` — never `queue_*`) — operation-generic, idempotent-on-enqueue, replayed through an **explicit executor map** whose executors receive a `LidarrClientApi`; #202 registers real mutation executors. **No CLI over the queue ships in #195** (it is empty by construction until #202); no auto-replay ever runs as a side effect.
4. **Metadata cache** (`metadata-cache.ts`, table `lidarr_metadata_cache`) — write-through on successful `listArtists`/`getSystemStatus` (default on; `cacheTtlSeconds: 0` disables), served stale **only** under an explicit `--allow-stale` flag on `lidarr status` and `lidarr list` — the one real, reachable degradation capability a user experiences in #195. A `MetadataFallbackSource` interface is the documented MusicBrainz seam (follow-up issue; needs its own `FETCH_OWNERS` registration).

Local-only tier — the only tier shipped actions use — has **zero pre-call gating overhead**: straight pass-through, breaker fed on the failure path only, with windowed counting guaranteeing that failures spread across healthy weeks can never trip the circuit.

**In scope:** the four lib primitives, schema v10 (three tables, one bump), nested `lidarr.resilience` config (8 knobs, config-only), transparent resolver integration, `runHealthGate` param widening, `--allow-stale` on status/list, additive `resilience` + `metadataProvider` fields in `lidarr health` output, tests.
**Out of scope:** scheduler/lane dispatch (#196), plan/apply + mutation executors + `lidarr deferred` CLI (#202 companion), MusicBrainz HTTP client (follow-up; seam shipped here), extra facade ops (`/queue/status`, `/diskspace`).

---

## 2. Module map

All paths relative to `packages/rfmedia-cli`. Soft ~500-line cap respected.

| File                                                                 | Status                                                               | Responsibility                                                                                                                                                                                                                                               | ~Lines    |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `src/lib/lidarr/circuit-breaker.ts`                                  | NEW                                                                  | `CircuitState` discriminated union, `CircuitPolicy`, **pure** `evaluateCircuit`/`recordSuccess`/`recordFailure`, `CircuitStore` interface, SQLite store (**sole owner of `lidarr_circuit_state` CRUD**), `createCircuitBreaker` handle that owns persistence | 300       |
| `src/lib/lidarr/health.ts`                                           | NEW lib module (distinct from action `src/actions/lidarr/health.ts`) | `runHealthProbe`, `LidarrHealthReport`, `detectMetadataProviderOutage`, `ensureTierHealthy` (per-lane gate for #196), `readLidarrResilienceSnapshot`                                                                                                         | 240       |
| `src/lib/lidarr/resilience.ts`                                       | NEW                                                                  | `ResilientLidarrClient implements LidarrClientApi`: retry loop, breaker feed, cache write-through, `--allow-stale` fallback via ordered `MetadataFallbackSource[]`, policy resolution from config                                                            | 350       |
| `src/lib/lidarr/deferred-queue.ts`                                   | NEW                                                                  | Domain API: enqueue/list/replay/clear, idempotency-key derivation, executor-map replay orchestration                                                                                                                                                         | 250       |
| `src/lib/lidarr/deferred-queue-db.ts`                                | NEW                                                                  | CRUD for `lidarr_deferred_intents`, `(db: DbConnection, ...)`-shaped (queue-db.ts sibling precedent — brief flag 8, **not** db.ts)                                                                                                                           | 200       |
| `src/lib/lidarr/metadata-cache.ts`                                   | NEW                                                                  | Cache CRUD for `lidarr_metadata_cache`; `MetadataFallbackSource` interface + `sqliteCacheSource` implementation                                                                                                                                              | 220       |
| `src/lib/lidarr/index.ts`                                            | MOD                                                                  | `resolveRequiredLidarrClient(overrides?, resilience?)` wraps facade in decorator; re-export new modules                                                                                                                                                      | +50       |
| `src/lib/lidarr/tiers.ts`                                            | MOD                                                                  | Widen `runHealthGate(client: LidarrClient, …)` → `LidarrClientApi`; delegate to `runHealthProbe`; `@deprecated` JSDoc pointing at health.ts                                                                                                                  | +10       |
| `src/types/lidarr-resilience.ts`                                     | NEW                                                                  | Command-facing types: `LidarrResilienceSnapshot`, `LidarrCacheStatus`                                                                                                                                                                                        | 90        |
| `src/types/db.ts`                                                    | MOD                                                                  | `DbLidarrDeferredIntent`, `DbLidarrMetadataCacheEntry`, `DbLidarrCircuitState` rows + `CreateLidarrDeferredIntentParams`                                                                                                                                     | +80       |
| `src/lib/schema.sql`                                                 | MOD                                                                  | Three v10 tables + indexes; seed bumped to `'10'`                                                                                                                                                                                                            | +45       |
| `src/lib/migrations.ts`                                              | MOD                                                                  | `CURRENT_SCHEMA_VERSION = 10`; `< 10` version-stamp-only block                                                                                                                                                                                               | +5        |
| `src/lib/db.ts`                                                      | MOD                                                                  | `SUPPORTED_READ_ONLY_SCHEMA_VERSION = 10` **only** — no CRUD added                                                                                                                                                                                           | ±1        |
| `src/types/config.ts`                                                | MOD                                                                  | `LidarrResilienceConfigOptions` nested under `LidarrConfigOptions`                                                                                                                                                                                           | +15       |
| `src/lib/config.ts`                                                  | MOD                                                                  | `validateLidarrResilienceConfig` (per `validatePlexCacheConfig` pattern, config.ts L1004), wired into `validateLidarrConfigOptions`                                                                                                                          | +55       |
| `src/actions/lidarr/status.ts`, `list.ts`                            | MOD                                                                  | Optional `allowStale?: boolean` option; pass `{ tier: TIER, allowStale, onStaleServe }` to resolver; optional additive `cacheStatus?: LidarrCacheStatus` on results                                                                                          | ±15 each  |
| `src/actions/lidarr/health.ts`                                       | MOD                                                                  | Result gains additive `metadataProvider` + `resilience?: LidarrResilienceSnapshot`                                                                                                                                                                           | +20       |
| `src/actions/lidarr/wanted.ts`                                       | MOD                                                                  | None functionally (default tier applies); optional explicit `{ tier: TIER }` pass-through                                                                                                                                                                    | ±3        |
| `src/commands/lidarr.ts`                                             | MOD                                                                  | `--allow-stale` on status/list; render resilience block in `health` text output; stale-serve stderr warning                                                                                                                                                  | +40       |
| `src/lib/shell-completions/{bash,zsh,fish}.ts` + `templates.spec.ts` | MOD                                                                  | `--allow-stale` added to status/list flag lists (no subcommand-list change)                                                                                                                                                                                  | +20 total |

No changes to `transport.ts`, `client.ts`, `errors.ts` (taxonomy untouched), generated code, `REQUIRED_OPERATIONS`, or `cli.ts`.

---

## 3. Public API

### 3.1 Circuit breaker (`circuit-breaker.ts`)

```typescript
export type CircuitScope = "lidarr" | "metadata";

export type CircuitState =
  | { readonly state: "closed"; readonly recentFailures: readonly string[] } // ISO timestamps, pruned to window, bounded to threshold
  | { readonly state: "open"; readonly openedAt: string; readonly cooldownMs: number; readonly reason: LidarrErrorCode }
  | { readonly state: "half-open"; readonly probeStartedAt: string; readonly reason: LidarrErrorCode };

export interface CircuitPolicy {
  readonly failureThreshold: number; // default 3
  readonly failureWindowMs: number; // default 300_000 (research: "3 failures in 5 minutes")
  readonly cooldownMs: number; // default 60_000
}

/** Non-configurable: a crashed half-open probe is presumed dead after this long. */
export const HALF_OPEN_PROBE_TIMEOUT_MS = 120_000; // 4× the 30 s default request timeout

export type CircuitDecision =
  | { readonly allowed: true; readonly probe: boolean; readonly next: CircuitState }
  | {
      readonly allowed: false;
      readonly next: CircuitState;
      readonly retryAtIso: string;
      readonly retryAfterMs: number;
      readonly reason: LidarrErrorCode;
    };

/**
 * Pure transitions — no I/O, exhaustive `switch` with `never` checks.
 * PERSISTENCE CONTRACT: the caller MUST persist `decision.next` via CircuitStore.save
 * whenever it differs from the loaded state, BEFORE dispatching the gated call.
 * Half-open rule: loaded half-open with (now - probeStartedAt) <= HALF_OPEN_PROBE_TIMEOUT_MS
 * ⇒ rejected (a probe is presumed in flight elsewhere; retryAfterMs = remaining window);
 * past the timeout ⇒ the crashed probe is expired and THIS call becomes a fresh probe
 * ({ allowed: true, probe: true, next: half-open with fresh probeStartedAt }).
 */
export function evaluateCircuit(state: CircuitState, policy: CircuitPolicy, nowIso: string): CircuitDecision;
export function recordCircuitSuccess(state: CircuitState): CircuitState; // → closed, recentFailures []
export function recordCircuitFailure(
  state: CircuitState,
  error: Pick<LidarrError, "code" | "retryable" | "retryAfterSeconds">,
  policy: CircuitPolicy,
  nowIso: string,
): CircuitState;
// prunes recentFailures older than failureWindowMs, appends nowIso; trips at threshold with
// cooldownMs = max(policy.cooldownMs, (error.retryAfterSeconds ?? 0) * 1000); half-open failure → open (fresh openedAt)

export interface CircuitStore {
  load(origin: string, scope: CircuitScope): CircuitState; // missing row ⇒ { state: "closed", recentFailures: [] }; malformed state_json ⇒ throws
  save(origin: string, scope: CircuitScope, state: CircuitState): void; // single-row UPSERT
}
export function createSqliteCircuitStore(db: DbConnection): CircuitStore;

/** Store-backed handle: composes the pure functions and OWNS persistence (writes only on state change). */
export interface LidarrCircuitBreaker {
  readonly origin: string;
  readonly scope: CircuitScope;
  gate(): CircuitDecision; // load → evaluate → persist `next` if changed → return
  recordSuccess(): void;
  recordFailure(error: LidarrError): void; // no-op unless error.code feeds this scope (§8)
  getState(): CircuitState;
}
export function createCircuitBreaker(deps: {
  readonly store: CircuitStore;
  readonly origin: string;
  readonly scope: CircuitScope;
  readonly policy: CircuitPolicy;
  readonly now?: () => Date; // deterministic-timer test seam
}): LidarrCircuitBreaker;
```

No new error class: a rejected gated call throws `LidarrUnreachableError` (scope `"lidarr"`) or `MetadataProviderUnavailableError` (scope `"metadata"`) with `retryAfterSeconds = ceil(retryAfterMs / 1000)` and a recovery-hint message — the taxonomy is preserved and #196 routes on `error.code` exactly as today.

### 3.2 Health monitor (`health.ts`)

```typescript
export interface LidarrHealthReport {
  readonly status: "healthy" | "degraded" | "unreachable";
  readonly checkedAt: string;
  readonly errors: readonly LidarrHealthCheck[];
  readonly warnings: readonly LidarrHealthCheck[];
  readonly metadataProvider: { readonly available: boolean; readonly failingChecks: readonly LidarrHealthCheck[] };
}

export function runHealthProbe(client: LidarrClientApi, signal?: AbortSignal): Promise<LidarrHealthReport>;

/** Data-driven matcher over error-level checks: source/message vs /metadata|skyhook|api\.lidarr\.audio/i. */
export function detectMetadataProviderOutage(checks: readonly LidarrHealthCheck[]): readonly LidarrHealthCheck[];

/**
 * Per-lane pre-dispatch gate (#196 contract, brief §9a). Behavior keyed STRICTLY off
 * LIDARR_TIER_DESCRIPTORS[tier]: requiresHealthGate: false ⇒ returns immediately, zero I/O
 * (today: every tier except "metadata-dependent"). Otherwise: breaker.gate() on the "lidarr"
 * scope, then (if metadataServerRequired) the "metadata" scope, then a fresh runHealthProbe —
 * results are NEVER cached across calls; #196 re-gates per batch by calling this again.
 * @throws LidarrUnreachableError | MetadataProviderUnavailableError
 */
export function ensureTierHealthy(
  client: LidarrClientApi,
  tier: LidarrTier,
  breakers: { readonly lidarr: LidarrCircuitBreaker; readonly metadata: LidarrCircuitBreaker },
  signal?: AbortSignal,
): Promise<LidarrHealthReport | undefined>;

export interface LidarrResilienceSnapshot {
  // src/types/lidarr-resilience.ts
  readonly circuits: readonly {
    readonly scope: CircuitScope;
    readonly state: CircuitState | { readonly state: "unknown"; readonly reason: string };
    readonly retryAtIso?: string;
  }[];
  readonly deferredIntents: { readonly pending: number; readonly failed: number };
}
export function readLidarrResilienceSnapshot(overrides?: LidarrClientOverrides): Promise<LidarrResilienceSnapshot>;
// Opens tracking.db lazily; on DB failure reports { state: "unknown", reason } explicitly — surfaced, never silent.
```

`tiers.ts`: `runHealthGate(client: LidarrClientApi, signal?)` — parameter widened only (compatible supersession per brief flag 5), kept and re-exported (#196 docs reference it), delegates to `runHealthProbe(...).errors`, JSDoc `@deprecated use runHealthProbe/ensureTierHealthy`.

`MetadataProviderUnavailableError` has exactly **two documented construction sites** (brief flag 6 resolved): (1) `ensureTierHealthy` when `detectMetadataProviderOutage` matches; (2) the decorator/breaker when the `"metadata"` circuit rejects a call. `classifyLidarrStatus` is untouched — status codes alone cannot distinguish the two outages.

### 3.3 Decorator + resolver (`resilience.ts`, `index.ts`)

```typescript
export interface LidarrCacheStatus {
  // src/types/lidarr-resilience.ts
  readonly source: "stale-cache";
  readonly fetchedAt: string;
  readonly ageSeconds: number;
}

export interface LidarrResilienceCallOptions {
  readonly tier?: LidarrTier; // default "local-only"; keys ALL behavior via LIDARR_TIER_DESCRIPTORS
  readonly allowStale?: boolean; // default false — stale serve is per-invocation, explicit consent only
  readonly onStaleServe?: (status: LidarrCacheStatus) => void; // actions copy into their result's cacheStatus field
}

export interface ResilienceDependencies {
  // test seams only, transport-test style
  readonly now?: () => Date;
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number; // jitter
  readonly openDb?: () => Promise<DbConnection>;
  readonly fallbackSources?: readonly MetadataFallbackSource[]; // default [sqliteCacheSource]
}

export function createResilientLidarrClient(
  inner: LidarrClientApi,
  origin: string, // credential-free canonical origin from LidarrConnectionSettings
  policy: ResolvedResiliencePolicy, // config knobs with defaults applied (??), §5
  call: LidarrResilienceCallOptions,
  deps?: ResilienceDependencies,
): LidarrClientApi;
// Returned object is frozen; JSON.stringify(...) === "{}" (client precedent).

// index.ts — SAME resolver, additive second parameter. No sibling resolver, no action-test churn:
export function resolveRequiredLidarrClient(
  overrides?: LidarrClientOverrides,
  resilience?: LidarrResilienceCallOptions,
): LidarrClientApi; // now returns the decorator
```

Actions keep calling `resolveRequiredLidarrClient({ lidarrUrl, lidarrApiKey })` — existing barrel mocks work unchanged (extra arg ignored by mocks; return type still `LidarrClientApi`). `status`/`list` additionally pass `{ tier: TIER, allowStale, onStaleServe }`.

**In-place retry classification is an explicit allowlist**: the four current facade methods (all idempotent GETs) are retryable-in-place; any method added later (e.g. #202 mutations) defaults to **no in-place retry** until explicitly classified — mutations are defer-only by construction.

### 3.4 Deferred queue (`deferred-queue.ts`)

```typescript
export type LidarrDeferredIntentStatus = "pending" | "in-progress" | "succeeded" | "failed" | "cancelled";

export interface LidarrDeferredIntent {
  readonly id: string; // UUID TEXT PK (queue_jobs precedent; replay-stable for #202 --resume)
  readonly origin: string; // canonical origin — never the API key
  readonly operation: string; // executor-map key, e.g. "lidarr add artist" (#202 vocabulary; opaque here)
  readonly tier: LidarrTier;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string; // sha256(operation + canonical JSON payload), node:crypto
  readonly status: LidarrDeferredIntentStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly errorCode: LidarrErrorCode | null;
  readonly errorMessage: string | null; // scrubbed, never raw bodies/keys
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly nextAttemptAt: string | null;
  readonly lastAttemptAt: string | null;
}

export interface EnqueueDeferredIntentInput {
  readonly operation: string;
  readonly tier: LidarrTier;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey?: string; // default derived as above
  readonly error?: LidarrError; // seeds errorCode + nextAttemptAt (retryAfterSeconds honored)
  readonly maxAttempts?: number; // default config deferredMaxAttempts (5)
}

/** #202 registers one per mutation operation; #195 ships none. Executors receive the client. */
export interface LidarrIntentExecutor {
  readonly operation: string;
  execute(payload: Readonly<Record<string, unknown>>, client: LidarrClientApi, signal?: AbortSignal): Promise<void>;
}

export interface LidarrReplayOutcome {
  readonly id: string;
  readonly operation: string;
  readonly outcome: "succeeded" | "retried-later" | "failed" | "cancelled" | "no-executor" | "skipped-circuit-open";
  readonly errorCode?: LidarrErrorCode;
  readonly message?: string;
}
export interface LidarrReplayReport {
  readonly attempted: number;
  readonly outcomes: readonly LidarrReplayOutcome[];
}

export function enqueueDeferredIntent(db: DbConnection, input: EnqueueDeferredIntentInput): LidarrDeferredIntent;
// INSERT OR IGNORE on UNIQUE(origin, idempotency_key); duplicate returns the existing row — never loses, never duplicates intent.
export function listDeferredIntents(
  db: DbConnection,
  filter?: { status?: LidarrDeferredIntentStatus; limit?: number },
): readonly LidarrDeferredIntent[];
export function clearDeferredIntents(
  db: DbConnection,
  filter: { ids?: readonly string[]; statuses?: readonly LidarrDeferredIntentStatus[] },
): number;

/** Explicit-invocation only (#202 `apply --resume`, #196 post-gate dispatch). NO auto-replay in #195. */
export function replayDeferredIntents(
  db: DbConnection,
  client: LidarrClientApi,
  executors: ReadonlyMap<string, LidarrIntentExecutor>, // explicit map — no module-global registry
  breakers: { readonly lidarr: LidarrCircuitBreaker; readonly metadata: LidarrCircuitBreaker },
  options?: { readonly ids?: readonly string[]; readonly limit?: number; readonly signal?: AbortSignal },
): Promise<LidarrReplayReport>;
```

### 3.5 Metadata cache + fallback seam (`metadata-cache.ts`)

```typescript
export type LidarrCacheCategory = "artists" | "system-status"; // v1 entities; wanted deliberately excluded (page-param explosion)

export interface CacheHit<T> {
  readonly value: T;
  readonly fetchedAt: string;
  readonly ageSeconds: number;
  readonly fresh: boolean; // fresh = age <= ttl; staleness computed at READ time from config
}

export function readLidarrCache<T>(
  db: DbConnection,
  origin: string,
  category: LidarrCacheCategory,
  discriminator: string,
  ttlMs: number,
  staleMaxAgeMs: number,
  now?: () => Date,
): CacheHit<T> | undefined;
// Returns undefined past staleMaxAgeMs; rows past staleMaxAge are pruned opportunistically on write.
export function writeLidarrCache(
  db: DbConnection,
  origin: string,
  category: LidarrCacheCategory,
  discriminator: string,
  value: unknown,
): void; // UPSERT via ON CONFLICT DO UPDATE
export function purgeLidarrCache(db: DbConnection, origin: string, category?: LidarrCacheCategory): number;

/**
 * DOCUMENTED SEAM for Tier-2 MusicBrainz fallback (follow-up issue — requires its own
 * FETCH_OWNERS registration, 1 req/s limiter, and error mapping; hard-out of #195).
 * CONSUMPTION CONTRACT: the decorator holds an ordered readonly MetadataFallbackSource[]
 * (default [sqliteCacheSource]); on a stale-eligible failure (§8) with allowStale it consults
 * sources left-to-right and the first hit within staleMaxAge wins. The MusicBrainz follow-up
 * appends a source to this array — zero rework to the decorator.
 */
export interface MetadataFallbackSource {
  readonly id: string; // "sqlite-cache" in #195
  lookup<T>(origin: string, category: LidarrCacheCategory, discriminator: string): Promise<CacheHit<T> | undefined>;
}
export function createSqliteCacheSource(
  openDb: () => Promise<DbConnection>,
  policy: { readonly ttlMs: number; readonly staleMaxAgeMs: number },
): MetadataFallbackSource;
```

Key rule (plex-cache precedent, rfmedia-cli CLAUDE.md:1171-1176): scoped by `origin` + `category` + `discriminator` (`""` for whole-list snapshots); **never** contains the API key; config read lazily.

---

## 4. Data model (schema v10)

Applied exactly per brief §4 recipe: schema.sql append + seed `'10'` (line 333); `CURRENT_SCHEMA_VERSION = 10` (migrations.ts:13) with a **version-stamp-only** `< 10` block (tables created by the idempotent schema re-run); `SUPPORTED_READ_ONLY_SCHEMA_VERSION = 10` (db.ts:45) in the **same commit** (lockstep). All three tables in one bump (Q14).

```sql
-- Version 10: Lidarr resilience layer (issue #195)
CREATE TABLE IF NOT EXISTS lidarr_deferred_intents (
  id TEXT PRIMARY KEY,                       -- UUID (queue_jobs TEXT-PK precedent: replay-stable ids for #202)
  origin TEXT NOT NULL,
  operation TEXT NOT NULL,
  tier TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending|in-progress|succeeded|failed|cancelled
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  error_code TEXT,
  error_message TEXT,                        -- scrubbed; never raw bodies or credentials
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  UNIQUE(origin, idempotency_key)            -- + INSERT OR IGNORE = idempotent enqueue
);
CREATE INDEX IF NOT EXISTS idx_lidarr_deferred_intents_status
  ON lidarr_deferred_intents(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_lidarr_deferred_intents_origin
  ON lidarr_deferred_intents(origin);

CREATE TABLE IF NOT EXISTS lidarr_metadata_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,      -- schema convention (TEXT-PK exception is queue_jobs only)
  origin TEXT NOT NULL,
  category TEXT NOT NULL,
  discriminator TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,                  -- TTL/staleness computed at read time from config
  UNIQUE(origin, category, discriminator)
);

CREATE TABLE IF NOT EXISTS lidarr_circuit_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  scope TEXT NOT NULL,                       -- 'lidarr' | 'metadata'
  state TEXT NOT NULL DEFAULT 'closed',      -- 'closed' | 'open' | 'half-open' (queryable summary)
  state_json TEXT NOT NULL,                  -- full CircuitState union (extensible without schema bumps)
  updated_at TEXT NOT NULL,
  UNIQUE(origin, scope)
);
```

Row types in `src/types/db.ts` (snake*case, `| null` nullables, string-literal status unions): `DbLidarrDeferredIntent`, `DbLidarrMetadataCacheEntry`, `DbLidarrCircuitState`; camelCase `CreateLidarrDeferredIntentParams`. No `queue*\*`names anywhere. Replay claims use`UPDATE ... SET status='in-progress' WHERE id=? AND status='pending'`guarded by`changes === 1`(cross-process claim-race guard). Upserts via`INSERT ... ON CONFLICT(...) DO UPDATE`; batch status updates via prepared statement + `db.transaction(...)`. Concurrency: WAL + `busy_timeout=5000` already set; breaker writes are single-row UPSERTs; last-writer-wins is documented and acceptable at CLI cadence (worst case: one redundant probe).

---

## 5. Config

One nested sub-object with a dedicated validator (`validatePlexCacheConfig` pattern); unknown keys silently dropped; violations throw `ConfigError` with `lidarr.resilience.<key>` property paths; **defaults applied at consumption site with `??`** (never written into config):

```typescript
export interface LidarrResilienceConfigOptions {
  failureThreshold?: number; // validatePositiveInteger    — default 3
  failureWindowSeconds?: number; // validatePositiveInteger    — default 300
  cooldownSeconds?: number; // validatePositiveInteger    — default 60
  retryAttempts?: number; // validateNonNegativeInteger — default 1 (in-place read retries; 0 disables)
  retryBackoffCapMs?: number; // validatePositiveInteger    — default 15_000 (caps backoff AND honored Retry-After)
  cacheTtlSeconds?: number; // validateNonNegativeInteger — default 900 (fresh window); 0 disables cache entirely
  cacheStaleMaxAgeSeconds?: number; // validatePositiveInteger    — default 86_400 (--allow-stale ceiling)
  deferredMaxAttempts?: number; // validatePositiveInteger    — default 5
}
export interface LidarrConfigOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  resilience?: LidarrResilienceConfigOptions;
}
```

Eight knobs, **all config-only** (precedent: `timeoutMs`). Non-knob constants: `HALF_OPEN_PROBE_TIMEOUT_MS = 120_000`, retry base delay 500 ms (2 000 ms for `timeout` errors — timeout-specific backoff per errors.ts intent), full jitter. Deliberately cut from competing designs: `enabled`, `halfOpenMaxProbes`, `maxCooldownSeconds`/cooldown doubling, `retryBudgetMs`, `cacheEnabled` (subsumed by `cacheTtlSeconds: 0`). The sole new CLI flag is `--allow-stale` — per-invocation consent is inherently a flag. `buildConfigTemplate()` untouched (follow-up).

---

## 6. CLI surface

**No new subcommands in #195** (Q11). The deferred queue is empty by construction until #202 ships mutation producers, so a queue CLI would be a command that can never do anything — it ships as a #202 companion (`lidarr deferred list|retry|clear`, deliberately named `deferred` to avoid the triple `queue` collision: copy-job queue commands/tables and Lidarr's own download queue). Shell-completion subcommand lists are untouched; only flag lists change.

**Changes:**

- `lidarr status --allow-stale`, `lidarr list --allow-stale` — on an eligible failure (§8) with a cache row within `cacheStaleMaxAgeSeconds`, the stale projection is served; the result carries additive `cacheStatus: { source: "stale-cache", fetchedAt, ageSeconds }` (populated via the `onStaleServe` callback) and stderr warns:
  `Warning: Lidarr unreachable — serving cached data from 12m ago (--allow-stale).`
  Without the flag, the failure surfaces normally with a hint (below). `lidarr wanted` does **not** get the flag (wanted pages are not cached — the flag would be inert).
- `lidarr health` result gains two additive fields: `metadataProvider: { available, failingChecks }` (from `runHealthProbe`) and `resilience: LidarrResilienceSnapshot`. JSON envelope stays `{ command: "lidarr-health", result: { checks, hasErrors, metadataProvider, resilience } }` — additive, non-breaking. Text mode appends a compact stderr block, quiet when healthy:
  `Circuit [lidarr]: closed · Circuit [metadata]: closed · Deferred intents: 0 pending`
  Snapshot DB failure reports `{ state: "unknown", reason }` — the health command itself still succeeds.
- **Failure message contract** (stderr, `process.exitCode = 1`, never `process.exit()`):

```
Lidarr list failed: Lidarr unreachable at https://lidarr.example.net after 2 attempts.
Circuit open — automatic retries resume at 14:32:07 (58s).
Hint: rerun with --allow-stale to use cached data (last fetched 12m ago), or run `rfmedia lidarr health`.
```

Completions: `--allow-stale` added to the status/list flag variables in `bash.ts`, `zsh.ts`, `fish.ts`; `templates.spec.ts` flag-parity entries updated. The pinned subcommand list `["status","list","wanted","health"]` is unchanged.

---

## 7. Control flow

**State machine** (pure functions, exhaustive `never`-checked `switch`):

```
closed    --[recordFailure: countable code; failures within failureWindowMs reach threshold]--> open
closed    --[recordSuccess]--> closed (recentFailures cleared)
open      --[gate, now < openedAt + cooldownMs]--> reject { retryAfterMs }
open      --[gate, cooldown elapsed]--> half-open (THIS call is the probe; next persisted before dispatch)
half-open --[gate, now - probeStartedAt <= HALF_OPEN_PROBE_TIMEOUT_MS]--> reject (probe presumed in flight)
half-open --[gate, probe window expired]--> half-open (fresh probeStartedAt; THIS call is a new probe)  ← crashed-probe self-heal
half-open --[probe recordSuccess]--> closed
half-open --[probe recordFailure]--> open (fresh openedAt)
```

- **(a) Healthy call, local-only tier** (all shipped actions): straight pass-through to the inner facade — no gate, no breaker read, no DB open on the success path — then, for `listArtists`/`getSystemStatus` with `cacheTtlSeconds > 0`, a lazy-DB write-through UPSERT. Cache-write failure logs a stderr warning and does not affect the operation result (documented optimization boundary — surfaced, not silent).
- **(a′) Healthy call, gated tier** (`requiresHealthGate: true`; #196's lanes): `ensureTierHealthy` → `lidarr` breaker `gate()` → `metadata` breaker `gate()` (when `metadataServerRequired`) → fresh `runHealthProbe` (never cached across calls) → inner call → `recordSuccess()` on gated scopes (persisted only on state change) → cache write-through → frozen projection returned.
- **(b) Failure → retry → trip:** inner call throws `LidarrError`. If `retryable` and the operation is on the read allowlist: bounded retry (`retryAttempts`, default 1) with delay `min(base × 2^attempt + full jitter, retryBackoffCapMs)`; `rate-limited` waits exactly `retryAfterSeconds × 1000` (fails through immediately if that exceeds the cap); `timeout` uses the 2 000 ms base; `metadata-provider-unavailable` is **never** retried in place (provider outages last minutes, not milliseconds). Waits are abortable via the caller's `AbortSignal`; all timing through injected `now`/`delay`/`random` seams. On exhaustion: `recordFailure` on the mapped scope (lazy DB open — failure-path-only cost for local-only; a persist failure warns and the original error is rethrown unchanged), then rethrow.
- **(c) Call while open** (gated tiers only): `gate()` rejects → decorator throws the scope-mapped taxonomy error (`retryAfterSeconds` = remaining cooldown) **without any network I/O**, message per §6 contract. Local-only calls are never blocked — they execute normally and only feed failure counters. If `allowStale` and the operation is cacheable, the fallback-source chain is consulted instead (§3.5); a hit short-circuits the throw, fires `onStaleServe`, and warns on stderr.
- **(d) Half-open probe:** the triggering call itself is the probe (no separate request); `next` (half-open) is persisted **before** dispatch. Success → `closed` persisted (+ stderr `circuit recovered`); failure → `open` with fresh `openedAt`. Because state is persisted, the **next CLI invocation** performs the probe — the no-daemon recovery story. A CLI killed mid-probe (Ctrl-C) self-heals: after `HALF_OPEN_PROBE_TIMEOUT_MS` the stale probe expires and the next call becomes a fresh probe — no permanent lockout, no manual DB surgery.
- **(e) Deferral (producer contract; #202 is the producer):** a mutation failing with a retryable code, or attempted while the relevant circuit is open, is enqueued via `enqueueDeferredIntent` — idempotent on `(origin, idempotency_key)`, so re-running a half-applied plan cannot duplicate intents; `next_attempt_at = now + (retryAfterSeconds ?? cooldown remainder)`. Reads are **never** deferred (replaying a read hours later serves no one — they fail with the §6 hint instead). In #195 nothing enqueues; the contract ships with tests.
- **(f) Replay (explicit invocation only):** `replayDeferredIntents` selects due rows (`status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now)`, ordered by `created_at`, bounded by `limit`), gates once per distinct tier via the breakers (blocked ⇒ `skipped-circuit-open`, row untouched), claims each row (`pending → in-progress`, `changes === 1` guard), looks up the executor: missing ⇒ `no-executor`, row reset to `pending` untouched (pre-#202 replay is inspect/no-op **by design**); success ⇒ `succeeded`; retryable failure ⇒ `attempts+1`, `next_attempt_at = now + min(30s × 2^attempts, 1h)` (or Retry-After), back to `pending` (`retried-later`), `failed` at `maxAttempts`; non-retryable ⇒ `failed` immediately. **No auto-replay hook exists** — mutations never run as a side effect of health checks or unrelated commands; #202's `apply --resume` and #196's scheduler are the callers.

---

## 8. Error semantics

| `LidarrErrorCode`                                                                                 | In-place retry (reads)                                                   | Circuit scope fed        | Defer-eligible (mutations, #202)      | Stale-fallback eligible                |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------ | ------------------------------------- | -------------------------------------- |
| `lidarr-unreachable`                                                                              | yes (backoff + jitter)                                                   | `lidarr`                 | yes                                   | yes                                    |
| `timeout`                                                                                         | yes (2 000 ms base — timeout-specific backoff)                           | `lidarr`                 | yes                                   | yes                                    |
| `rate-limited`                                                                                    | yes, exactly `retryAfterSeconds` (fail through if > `retryBackoffCapMs`) | **none** (service is up) | yes (`next_attempt_at` = Retry-After) | no (fail with wait time)               |
| `metadata-provider-unavailable`                                                                   | **no** (outage-scale; gate instead)                                      | `metadata`               | yes                                   | yes                                    |
| `validation`, `invalid-response`, `configuration`, `authentication`, `authorization`, `not-found` | never                                                                    | never                    | never                                 | never — surface immediately, unchanged |

The four-way classification #196 requires (brief §9) is preserved end-to-end: `classifyLidarrStatus` untouched, breaker state carries `reason: LidarrErrorCode`, circuit-open rethrows reuse the scope-mapped taxonomy subclass, deferred rows persist `error_code`. Two scopes / one implementation: the `metadata` scope keeps "Lidarr up but provider down" independently routable (the `metadataCircuitOpen` signal #202's `CircuitBreakerPolicy` runtime status needs — see Q5 note), while `lidarr` covers transport-level outage. On trip, `cooldownMs = max(configured, retryAfterSeconds × 1000)` — server hints are honored as a cooldown floor.

Secrets: cache keys, circuit rows, intent rows, and all error messages are credential-free (origin only; `error_message` scrubbed) — enforced by tests (§10).

---

## 9. Decision table — all 14 open questions

| #   | Question                                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                     | Rationale                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Decorator placement & shape                  | Single `ResilientLidarrClient implements LidarrClientApi`, returned **transparently by `resolveRequiredLidarrClient`** (additive second param — no sibling resolver). Local-only: zero pre-call overhead (no gate, no breaker read, no DB open on success); failures feed the persisted breaker on the failure path only, with **windowed counting** so failures spread across healthy weeks can never trip. | Zero action/test churn (barrel-mock pattern intact, brief §2.6); no bypass-footgun second resolver; satisfies the hard "no local-only gating overhead" rule while still warming the breaker for gated callers — and the 5-minute window makes the asymmetric feed (failures recorded, successes not) safe. |
| 2   | Tier awareness at the client seam            | `tier` on `LidarrResilienceCallOptions`; actions pass their exported `TIER`; all behavior keyed off `LIDARR_TIER_DESCRIPTORS[tier]` fields (`requiresHealthGate`, `metadataServerRequired`) — no per-operation map, no parallel enum. `ensureTierHealthy` is the exported per-lane gate #196 calls per dispatch/batch.                                                                                       | Reuses the shipped tier system verbatim (hard constraint); descriptors are the single source of truth #196's lanes are built on — flipping a descriptor flag changes gating with zero resilience-layer edits.                                                                                              |
| 3   | Retry-in-place vs defer-only                 | Both, hard boundary: bounded in-place retry for the explicit read allowlist (default 1 retry, Retry-After honored and capped); mutations are **defer-only** (contract ships now, producers in #202); reads are never deferred; `metadata-provider-unavailable` never retried in place.                                                                                                                       | Reads are idempotent and cheap to retry invisibly; write retry risks duplicates and is exactly what the deferred queue exists for — "never loses user intent" is the write-side promise.                                                                                                                   |
| 4   | `runHealthGate` supersession                 | Widen param to `LidarrClientApi`, keep exported, delegate to `runHealthProbe`, JSDoc `@deprecated`.                                                                                                                                                                                                                                                                                                          | Compatible supersession (brief flag 5); #196 docs referencing the scaffold stay valid; new code targets `runHealthProbe`/`ensureTierHealthy`.                                                                                                                                                              |
| 5   | `MetadataProviderUnavailableError` detection | `/health` payload matching in `health.ts` (`/metadata                                                                                                                                                                                                                                                                                                                                                        | skyhook                                                                                                                                                                                                                                                                                                    | api\.lidarr\.audio/i`, data-driven + unit-tested); **two circuit scopes** (`lidarr`, `metadata`) per origin; exactly two construction sites (detector + metadata-circuit rejection). `classifyLidarrStatus` untouched. | Status codes can't distinguish the two outages; independent scopes are what #196 lane routing and #202's `metadataCircuitOpen` runtime flag require (innovation.md's `CircuitBreakerPolicy { metadataCircuitOpen; maxConcurrentAdds; globalPause }` is a **runtime status shape** — derivable as `metadata` scope `state !== "closed"` — not our tuning policy; no false "verbatim" alignment claimed). |
| 6   | Extra health signals                         | v1 ships on `/health` + `/system/status` only; `/queue/status` + `/diskspace` are a documented follow-up (facade + `REQUIRED_OPERATIONS` + manifest extension).                                                                                                                                                                                                                                              | Keeps #195 out of codegen-gate scope; the two shipped signals cover both scopes today; `LidarrHealthReport` is additive-extensible.                                                                                                                                                                        |
| 7   | Circuit-state persistence                    | SQLite in the same `tracking.db` (`lidarr_circuit_state`, `UNIQUE(origin, scope)`, `state` summary column + `state_json` full union), loaded lazily, written only on state transitions; WAL + `busy_timeout=5000`; last-writer-wins documented; crashed-probe self-heal via `HALF_OPEN_PROBE_TIMEOUT_MS`.                                                                                                    | An in-memory breaker resets every CLI invocation and is decorative; persistence makes cooldown/half-open meaningful across runs — the no-daemon recovery story. A second DB file doubles preflight/version surface for nothing. `state_json` absorbs future state fields without schema bumps.             |
| 8   | Cache storage                                | Persistent SQLite (`lidarr_metadata_cache`, v10) per research Tier-0. Entities: `artists`, `system-status`; wanted excluded (page-param explosion, low fallback value). Key `origin` × `category` × `discriminator`, never credentials. Write-through **default on** (`cacheTtlSeconds` 900; 0 disables); stale served **only** under explicit `--allow-stale`, up to `cacheStaleMaxAgeSeconds` (24 h).      | In-memory (plex-cache precedent) dies with the process — useless for a CLI fallback tier. Default-on write-through + an explicit flag makes the cache **reachable in #195** (the one real degradation capability users get) while keeping stale data deterministic and consented — no hidden fallbacks.    |
| 9   | Deferred-intent record shape                 | TEXT UUID PK (queue_jobs precedent); operation-generic columns (`operation`, `tier`, `payload_json`, `idempotency_key`, attempts/backoff/status per §4); `UNIQUE(origin, idempotency_key)` + `INSERT OR IGNORE`; key = sha256(operation + canonical payload). Pre-#202 replay of unknown operations = structured `no-executor` outcome, row untouched.                                                       | #202 needs replay-stable ids and an operation-keyed executor seam, not read-specific columns; idempotent enqueue means a re-run of a half-applied plan can't duplicate intents; an honest structured no-op beats silence.                                                                                  |
| 10  | Replay trigger                               | **Explicit invocation only**: `replayDeferredIntents` lib API for #202's `apply --resume` and #196's post-gate dispatch. No auto-replay, no health-check side effects, no opportunistic hooks in #195. Pending counts surface passively in `lidarr health`'s resilience block.                                                                                                                               | A CLI that mutates Lidarr as a surprise side effect of a health check or an unrelated command is an operator trap, and any auto-trigger in #195 would be untestable dead weight (nothing can be enqueued). The research's "replay after recovery" intent maps onto explicit resume in a CLI process model. |
| 11  | New CLI surface in #195                      | **No new subcommands.** Ship: `--allow-stale` on `status`/`list` (flag-list completions churn only), additive `metadataProvider` + `resilience` fields in `lidarr health` (JSON + quiet stderr block), and the §6 failure-message contract with recovery hints. `lidarr deferred list                                                                                                                        | retry                                                                                                                                                                                                                                                                                                      | clear` moves to a #202 companion, when intents can actually exist.                                                                                                                                                     | A queue CLI over a provably-empty table is dead surface for a full issue cycle; breaker/queue visibility lands where users already look (`lidarr health`), and `--allow-stale` is the piece of UX that delivers reachable value now. Subcommand pinned lists in three shells stay frozen.                                                                                                               |
| 12  | Config schema shape                          | Nested `lidarr.resilience` (8 knobs, §5) with dedicated `validateLidarrResilienceConfig`; all thresholds config-only; the sole new flag is `--allow-stale`.                                                                                                                                                                                                                                                  | Matches `validatePlexCacheConfig` precedent; `timeoutMs` precedent keeps operational knobs out of the flag surface; per-invocation consent (stale data) is inherently a flag. Cut knobs (enabled/halfOpenMaxProbes/cooldown-doubling/retryBudget/cacheEnabled) were over-parameterization.                 |
| 13  | MusicBrainz fallback                         | **Out.** The seam ships as a real contract: `MetadataFallbackSource` interface + `sqliteCacheSource` implementation + a specified consumption order in the decorator (§3.5). Follow-up child issue: new `FETCH_OWNERS` registration, 1 req/s limiter, taxonomy error mapping, appended as a second source.                                                                                                   | Hard constraint — no new fetch call sites in #195 (the architecture gate would fail); the interface + documented consumption contract makes the follow-up purely additive.                                                                                                                                 |
| 14  | Schema v10 contents                          | One bump: all three tables (intents + cache + circuit state).                                                                                                                                                                                                                                                                                                                                                | Each later table costs another `CURRENT_SCHEMA_VERSION`/`SUPPORTED_READ_ONLY_SCHEMA_VERSION` lockstep bump plus pinned-test churn; all three are #195-scoped and designed now.                                                                                                                             |

---

## 10. Test plan (repo patterns per brief §7)

- **`circuit-breaker.test.ts`** — pure-function unit tests with injected `nowIso`: `it.each` transition matrix (closed→open at threshold **within window**; failures outside `failureWindowMs` pruned — explicit regression test: 3 failures spread over 3 weeks never trip; half-open success/failure; open rejection carries correct `retryAfterMs`; Retry-After cooldown floor); **crashed-probe self-heal**: loaded half-open with `probeStartedAt` older than `HALF_OPEN_PROBE_TIMEOUT_MS` yields `{ allowed: true, probe: true }`, fresher yields rejection; exhaustive-`never` compile guard. Store tests: real better-sqlite3 temp-file DB (`mkdtemp` + `initializeDatabase`, `afterEach` close + `rm` — no `:memory:`), UPSERT round-trip per scope, missing row ⇒ closed, malformed `state_json` throws. Handle tests: `gate()` persists `next` before returning; save only on change.
- **`health.test.ts`** — `createLidarrClientMock` + `createLidarrHealthCheckFixture`; `detectMetadataProviderOutage` matcher matrix (positive/negative sources, case-insensitivity); report classification (healthy/degraded/unreachable); `ensureTierHealthy("local-only")` performs **zero** client calls and zero DB I/O (assert mock + `openDb` seam uncalled); gated tier: breaker gate order, fresh probe per call (no caching — two calls ⇒ two probes), `instanceof MetadataProviderUnavailableError` on outage; snapshot DB-failure path reports `{ state: "unknown", reason }`.
- **`resilience.test.ts`** — decorator over `LidarrClientMock` with injected `delay`/`now`/`random`: local-only pass-through delegates exactly once (result identity, frozen projections preserved); retry honors exact Retry-After and `retryBackoffCapMs` fail-through; timeout-specific base; non-retryable codes bypass retry with zero extra calls; MPU never retried in place; circuit-open throws without invoking inner (`expect(inner.listArtists).not.toHaveBeenCalled()`); read-allowlist: unknown method shape gets no retry; stale fallback only with `allowStale` + within max age, fires `onStaleServe`, consults sources in order; cache-write failure warns and preserves result; secret-leak assertions (`inspect(error)).not.toContain(apiKey)`, stored rows never contain the key); `JSON.stringify(wrapped) === "{}"`.
- **`deferred-queue-db.test.ts` / `deferred-queue.test.ts`** — real temp-file DBs: idempotent enqueue (double `INSERT OR IGNORE` ⇒ 1 row, existing row returned); claim-race guard (`changes === 1`); replay with a test-provided executor map: `succeeded` / `retried-later` (backoff schedule on `next_attempt_at`) / `failed` at `maxAttempts` / non-retryable immediate `failed` / `no-executor` row-untouched / `skipped-circuit-open` via an open test breaker; executors receive the client instance; `db.transaction` batch updates.
- **`metadata-cache.test.ts`** — TTL/staleness computed at read via injected `now`; upsert overwrite; prune past `staleMaxAge`; key contains origin, never API key; `sqliteCacheSource` lookup contract.
- **`db.test.ts` / migrations** — pinned `getCurrentSchemaVersion` `toBe(9)` → `toBe(10)`; read-only version-error message assertions (~db.test.ts:451+); v9→v10 migration test building a v9 DB with raw `new Database(dbPath)` + hand DDL, asserting tables exist and version stamped.
- **Action tests** — `vi.hoisted` barrel mock of `resolveRequiredLidarrClient` **unchanged in shape** (additive second arg); `vi.mock` of loaded-config/logger; SUT imported after mocks; `vi.clearAllMocks()` only (never reset); assert `TIER` exports, override + resilience-option forwarding, rethrow; status/list: `allowStale` plumbed, `cacheStatus` attached when `onStaleServe` fires; health: additive `metadataProvider`/`resilience` fields.
- **Command tests** — hoisted `executeLidarr*` + `formatOutput` mocks: `--allow-stale` parsing on status/list (absent on wanted), JSON envelope parity (additive fields), stale warning on stderr, `process.exitCode = 1`, stdout machine-only.
- **Config tests** — `validateLidarrResilienceConfig` accept/reject matrix, `ConfigError` property paths, unknown keys dropped.
- **Completions** — `templates.spec.ts`: subcommand pinned list **unchanged** (asserted); flag-parity entries gain `--allow-stale` for status/list across bash/zsh/fish.
- **Gates:** `npm run typecheck` (chains `codegen:lidarr:check && check:architecture && test:architecture` — proves zero new fetch call sites and no generated-import leaks), `npm run test:coverage`, `npm run build`, `npm run format`; `graphify update .` after code changes.

---

## 11. Risks & follow-ups

**Risks**

1. _Metadata-outage matching is heuristic_ — Lidarr wording can drift. Mitigated: single exported data-driven matcher with a fixture matrix; false negative degrades to the `lidarr` scope (safe), never to silent success; only gated tiers (none shipped) are blocked by it.
2. _Happy-path lazy DB open for cache write-through_ — sub-ms UPSERT; `cacheTtlSeconds: 0` kill switch; write failure warns and continues (documented optimization boundary); success path without cache remains DB-free.
3. _Concurrent CLI runs racing breaker writes_ — last-writer-wins on single-row UPSERTs under WAL/busy_timeout; worst case one redundant probe. Accepted and documented.
4. _In-place retry changes shipped commands' behavior on transient failures_ (one extra attempt, added latency ≤ `retryBackoffCapMs`) — strict improvement; `retryAttempts: 0` opts out.
5. _Replay engine is production-dormant until #202_ — deliberate: the shape is the mandated #202 contract (brief §9), fully exercised by tests with fake executors; no speculative triggers ship around it.
6. _Read-only DB consumers pinned to v9_ — lockstep constant bump lands in the same commit as the schema change (brief §4 recipe).

**Follow-up candidate child issues**

- **MusicBrainz fallback source**: new `FETCH_OWNERS` registration, 1 req/s limiter, taxonomy error mapping, `MetadataFallbackSource` implementation appended to the decorator's source chain (Q13).
- **`lidarr deferred list|retry|clear` CLI** (with #202, when intents can exist) + three-shell completions churn; `--allow-stale` extension to any newly cached entities.
- **Extend facade + `REQUIRED_OPERATIONS`** with `/api/v1/queue/status` and `/api/v1/diskspace` as richer circuit signals (Q6).
- **Cooldown escalation** (doubling + cap) if the fixed 60 s cooldown proves too coarse in practice — deliberately cut from v1.
- **`buildConfigTemplate()` lidarr section** (resilience keys).
- **#196 wiring**: scheduler consumes `ensureTierHealthy` + `createCircuitBreaker` per lane; lane/failure-type surfacing in JSON output. **#202 wiring**: registers `LidarrIntentExecutor`s; `apply --resume` calls `replayDeferredIntents`; derives its runtime `CircuitBreakerPolicy.metadataCircuitOpen` from the `metadata` scope snapshot.

---

## Appendix — Judge defect resolutions

Every blocker and major is fixed; minors are addressed or explicitly justified.

**Blockers**

| Source                  | Defect                                                                                                                                           | Resolution                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| minimal (composability) | Single per-origin circuit conflates "Lidarr down" vs "metadata provider down"; can't express `metadataCircuitOpen`; retrofit costs a schema bump | Adopted operator's **two scopes** (`lidarr`/`metadata`) with `UNIQUE(origin, scope)` in v10 and independent gating/feeding (§3.1, §4, §8, Q5); `state_json` further insulates against future bumps |
| contract (simplicity)   | `lidarr deferred` CLI over a guaranteed-empty table (~400+ dead lines, bootstrap paradox)                                                        | **No queue CLI in #195** (Q11); lib API only; CLI ships as a #202 companion when producers exist; visibility lands in `lidarr health` instead                                                      |

**Majors**

| Source                                                            | Defect                                                                                                                              | Resolution                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| minimal (correctness)                                             | Unwindowed `consecutiveFailures` + successes never recorded on local-only ⇒ failures across weeks trip the circuit                  | **Windowed counting** (`recentFailures` timestamps pruned to `failureWindowMs`, default 5 min — matches researched trip rule); explicit regression test (§10)                                                                                                   |
| minimal (correctness) + contract (correctness) + all (shared gap) | Half-open deadlock: CLI killed mid-probe locks out all future invocations; probe-outstanding indistinguishable from crashed         | **`HALF_OPEN_PROBE_TIMEOUT_MS = 120_000` self-heal rule** specified in `evaluateCircuit`'s contract: stale probe expires, next call becomes a fresh probe (§3.1, §7d, tested §10)                                                                               |
| minimal (composability)                                           | `LidarrIntentExecutor(intent, signal)` carries no client; replay accepts no client — #202 executors forced to close over a client   | Executor signature is `execute(payload, client, signal)`; `replayDeferredIntents(db, client, executors, breakers, …)` takes the client and an **explicit executor map** (§3.4)                                                                                  |
| minimal (composability)                                           | MusicBrainz seam named but never defined — hand-waving                                                                              | `MetadataFallbackSource` **interface shipped** with `sqliteCacheSource` implementation and a specified consumption contract (ordered array, left-to-right, first fresh-enough hit wins) (§3.5, Q13)                                                             |
| minimal (simplicity)                                              | Write-only cache: stale reads production-unreachable (no flag, no setter path)                                                      | `--allow-stale` on `status`/`list` + `onStaleServe` → `cacheStatus` result field + stderr warning — the cache is reachable and delivers real degradation value (§6, Q8)                                                                                         |
| contract (correctness)                                            | Sibling `resolveResilientLidarrClient` forces 4-action + 4-test churn and leaves the old resolver as a resilience-bypass footgun    | **Transparent wrap**: same `resolveRequiredLidarrClient`, additive second parameter; barrel mocks unchanged; no bypass path exists (§3.3, Q1)                                                                                                                   |
| contract (composability)                                          | `CircuitBreakerPolicy` "shared verbatim with #202" is false (innovation.md defines runtime status flags, not tuning knobs)          | Renamed to `CircuitPolicy` (tuning); explicitly documented that #202's `CircuitBreakerPolicy` is a **runtime status shape** derivable from our snapshot (`metadataCircuitOpen` = metadata scope non-closed) — no false alignment claim (Q5, §11 follow-ups)     |
| contract (composability + simplicity)                             | `replayAfterHealthPass` auto-replay hook: unwired, untestable in #195, surprise-mutation trap once #202 registers executors         | **Cut.** Replay is explicit-invocation only; no health-check side effects (Q10, §7f)                                                                                                                                                                            |
| contract (composability)                                          | Process-lifetime caching of `assertHealthyForTier` goes stale for #196 lanes / #202 per-batch re-checks                             | `ensureTierHealthy` runs a **fresh probe on every call** — never cached; #196 re-gates per batch by calling again (§3.2, tested §10)                                                                                                                            |
| contract (simplicity)                                             | Cache dark by default; three-mode `LidarrCachePolicy` with an unreachable `stale-if-open`; speculative `wanted`/`health` categories | Cache write-through **default on** (TTL knob, 0 disables); single explicit stale path (`--allow-stale`); categories trimmed to `artists` + `system-status` (Q8)                                                                                                 |
| operator (composability)                                          | `ensureTierHealthy` gate has no `save()` access — open→half-open persistence protocol unspecified                                   | Persistence protocol made explicit: pure `evaluateCircuit` returns `next`; the **`LidarrCircuitBreaker` handle owns persistence** (`gate()` persists `next` before returning); `ensureTierHealthy` takes store-backed handles, not bare evaluators (§3.1, §3.2) |
| operator (simplicity)                                             | Dead `lidarr deferred` CLI (~510 lines over an empty table)                                                                         | Cut (see blocker resolution above); operator's failure-message/recovery-hint UX and `--allow-stale` are retained — the live value without the dead surface                                                                                                      |

**Minors (addressed or justified)**

| Source   | Defect                                                                                                                   | Resolution                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| minimal  | MPU construction-site contradiction (health.ts "only" vs decorator rethrow); `timeout` open-state has no mapped subclass | Exactly **two documented construction sites** (detector + metadata-circuit rejection); circuit-open rethrow maps by **scope**, not per-code (`lidarr` → `LidarrUnreachableError`, `metadata` → `MetadataProviderUnavailableError`), eliminating the per-code mapping gap (§3.2, §7c) |
| minimal  | Cache composite TEXT PK deviates from schema convention                                                                  | All non-intent tables use `id INTEGER PRIMARY KEY AUTOINCREMENT` + composite `UNIQUE(...)`; only `lidarr_deferred_intents` keeps TEXT UUID PK, justified by the queue_jobs precedent + replay-stable ids (§4)                                                                        |
| minimal  | Gate applied to discovery/destructive tiers contradicts shipped `LIDARR_TIER_DESCRIPTORS`                                | Gating keyed **strictly off descriptor fields** (`requiresHealthGate`, `metadataServerRequired`) — no ad-hoc tier split (§3.2, Q2)                                                                                                                                                   |
| minimal  | Trip rule lacks the researched 5-minute window                                                                           | Windowed counting adopted (see major above)                                                                                                                                                                                                                                          |
| minimal  | Replay engine production-dead until #202                                                                                 | Retained deliberately — mandated #202 contract (brief §9b), test-exercised; acknowledged in Risks §11.5                                                                                                                                                                              |
| minimal  | Near-zero reachable user value                                                                                           | Fixed via `--allow-stale`, in-place retries, recovery-hint messages, and health-output visibility                                                                                                                                                                                    |
| contract | Dormant machinery (circuit table written by nobody; dead cache knob; empty-table CLI)                                    | Failure-path recording writes circuit state from day one; cache default-on and readable; no CLI over the empty table                                                                                                                                                                 |
| contract | MusicBrainz seam vague                                                                                                   | Concrete interface + consumption contract shipped (§3.5)                                                                                                                                                                                                                             |
| operator | `lidarr_circuit_state` CRUD assigned to two modules                                                                      | `circuit-breaker.ts` is the **sole owner** of circuit-state CRUD; `metadata-cache.ts` owns only the cache table (§2)                                                                                                                                                                 |
| operator | `evaluateCircuit` behavior on loaded half-open unspecified (deadlock vs reprobe)                                         | Specified: probe-window rule with `HALF_OPEN_PROBE_TIMEOUT_MS` (§3.1)                                                                                                                                                                                                                |
| operator | `deferred.ts` action carries two tiers, bending the one-TIER-per-action pattern                                          | Moot — no deferred actions ship in #195                                                                                                                                                                                                                                              |
| operator | Largest surface = execution risk (new command file, 3-shell churn, 13 knobs, dead CLI)                                   | Surface cut to flags-only completions churn, 8 knobs, no new command files                                                                                                                                                                                                           |
| operator | Speculative `ResilienceEvent` union + `drainResilienceEvents()` module-global collector                                  | **Cut.** Replaced by stderr logging plus a single explicit `onStaleServe` callback — no global mutable state (§3.3)                                                                                                                                                                  |
| operator | Knob soup (13 keys; doubling+cap+window+budget over-parameterized)                                                       | Trimmed to 8; cooldown doubling, `retryBudgetMs`, `halfOpenMaxProbes`, `enabled`, `cacheEnabled` cut (doubling listed as a follow-up if needed) (§5)                                                                                                                                 |
| operator | `--allow-stale` inert on `wanted`                                                                                        | Flag only on `status`/`list`; `wanted` is uncached and unflagged (§6)                                                                                                                                                                                                                |
| operator | `MetadataFallbackSource` one-implementation abstraction                                                                  | Retained **by mandate** — the hard constraint requires a documented MusicBrainz seam; its consumption contract is now fully specified so the follow-up is purely additive (§3.5, Q13)                                                                                                |
