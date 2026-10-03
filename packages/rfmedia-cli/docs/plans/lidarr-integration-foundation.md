<!-- Design artifact for issue #193 — Lidarr Integration Foundation. Authoritative spec for the foundation PR. -->

# Design Spec — Lidarr Integration Foundation (`rfmedia lidarr`)

Issue #193 (foundation) · satisfies #197 (baseline commands) · lays typed groundwork for #194 (client) and #196 (execution lanes + error classification)

---

## 1. Overview & Goals

This PR establishes the **foundation layer** of the layered Lidarr integration in `rfmedia-cli`. It wires a new `rfmedia lidarr` command namespace into the CLI, stands up the layered internal structure (types → client → tiers/errors → actions → command → cli), ships a **minimal, strictly-typed, hand-written Lidarr HTTP client** with boundary validation, encodes the **reliability-tier + error-taxonomy scaffolding** that #193 depends on from #196, and delivers the **4 Layer-1 read-only baseline commands** (`status`, `list`, `wanted`, `health`) with full human + `--json` output parity.

### Goals (mapped)

| Goal                                                   | Issue                 | Delivered here                                                     |
| ------------------------------------------------------ | --------------------- | ------------------------------------------------------------------ |
| `rfmedia lidarr` namespace wired into CLI              | #193                  | `src/commands/lidarr.ts` + `cli.ts` registration                   |
| Layered internal structure                             | #193                  | `src/types/lidarr.ts`, `src/lib/lidarr/*`, `src/actions/lidarr/*`  |
| Minimal typed HTTP client with boundary validation     | #193 (bridge to #194) | `src/lib/lidarr/client.ts` + hand-written wire guards              |
| Reliability-tier encoding + error taxonomy             | #196 (core only)      | `src/lib/lidarr/tiers.ts` + `src/lib/lidarr/errors.ts`             |
| 4 baseline read-only commands, human + `--json` parity | #197                  | `src/actions/lidarr/{status,list,wanted,health}.ts`                |
| `lidarr` config section + secrets template + example   | #193                  | `src/types/config.ts`, `src/lib/config.ts`, `rfmedia.example.yaml` |
| Shell completions (all 4 subcommands)                  | #193                  | `bash.ts`, `zsh.ts`, `fish.ts`, `templates.spec.ts`                |
| ROADMAP update                                         | #193                  | `ROADMAP.md`                                                       |
| Tests for client, errors, tiers, all 4 actions         | #193/#197             | co-located `*.test.ts`                                             |

### Design invariants (mirrored from repo conventions)

- **ESM `.js` import specifiers** everywhere, even for `.ts` files.
- **Command/action separation**: `commands/` parses args and owns output rendering; `actions/` are framework-agnostic (no `commander` import) and return typed data.
- **Lazy dynamic `import()`** of action modules inside `.action()` handlers for fast CLI startup.
- **Logger from `../lib/logger.js`** (never `@rfmedia/common` directly); all human output → stderr, machine data → stdout via `formatOutput`.
- **Discriminated-union / string-literal-union** option & result types; **no `any`** at any public boundary.
- **`--json` / `--output` parity gate**: `const format = globalOpts?.output ?? "text"; if (isMachineFormat(format)) formatOutput(...) else formatHuman(...)`.
- **Boundary validation with hand-written type guards** (no zod/ajv in the repo).
- **`fetch` ownership**: `fetch` is called in exactly one place — `src/lib/lidarr/client.ts` — mirroring the `check-direct-plex-imports.mjs` guard; the client takes `fetch` as an injected dependency and is DI-tested with no network.

### Explicitly deferred (see §11 for full mapping)

Full OpenAPI codegen (#194) · resilience/circuit-breaker/deferred-intent-queue (#195) · scheduler & lane budgets (#196 beyond tier encoding) · discovery Layer 2 (#203+) · reconciliation/policy Layer 3 (#208+) · mutations & plan/apply (#202) · MCP tool exposure (deferrable by repo convention — MCP is a curated allowlist, not 1:1 with commands).

---

## 2. Reliability Tiers & Error Taxonomy

Two **orthogonal** axes, per the ACH synthesis: _feature layers_ vs _reliability tiers_. This foundation encodes the **reliability-tier axis** as a first-class command attribute plus the **error taxonomy** that lets the CLI distinguish _"Lidarr is down"_ from _"Lidarr's metadata server is down"_ (IC1).

### 2.1 Reliability tiers — `src/lib/lidarr/tiers.ts`

String-literal union (repo convention for status/kind unions) plus a frozen descriptor record:

```typescript
// src/lib/lidarr/tiers.ts

/**
 * Execution / reliability lane a command runs in. Orthogonal to feature "layers".
 * - local-only:          Lidarr local DB only; never touches api.lidarr.audio. Always reliable.
 * - metadata-dependent:  lookup/add/refresh/search; best-effort — failure is expected, not exceptional.
 * - discovery:           external open APIs (Last.fm/ListenBrainz/MusicBrainz), multi-source fallback.
 * - destructive:         bulk delete / file-mutating ops; gated behind explicit flags + dry-run.
 */
export type LidarrTier = "local-only" | "metadata-dependent" | "discovery" | "destructive";

/** Static, declarative metadata attached to every lidarr action. */
export interface LidarrTierDescriptor {
  readonly tier: LidarrTier;
  /** True when the op can run while api.lidarr.audio is unavailable. */
  readonly metadataServerRequired: boolean;
  /** True when a pre-flight health gate must run before executing. */
  readonly requiresHealthGate: boolean;
}

export const LIDARR_TIER_DESCRIPTORS = Object.freeze({
  "local-only": { tier: "local-only", metadataServerRequired: false, requiresHealthGate: false },
  "metadata-dependent": { tier: "metadata-dependent", metadataServerRequired: true, requiresHealthGate: true },
  discovery: { tier: "discovery", metadataServerRequired: false, requiresHealthGate: false },
  destructive: { tier: "destructive", metadataServerRequired: false, requiresHealthGate: false },
}) satisfies Record<LidarrTier, LidarrTierDescriptor>;
```

**How a command/action declares its tier.** Each action module exports a `TIER` constant that the command layer reads. All four baseline actions are `"local-only"`:

```typescript
// e.g. src/actions/lidarr/status.ts
import type { LidarrTier } from "../../lib/lidarr/tiers.js";
export const TIER: LidarrTier = "local-only";
```

**Health-gate helper** (scaffold for Tier-3; unused by baseline commands but shipped so #194/#196 build on it):

```typescript
// src/lib/lidarr/tiers.ts
import type { LidarrClient } from "./client.js";
import type { LidarrHealthCheck } from "../../types/lidarr.js";

/**
 * Pre-flight gate for metadata-dependent ops. Baseline read commands do NOT call this;
 * it exists so #194/#196 can gate Tier-3 (lookup/add/refresh/search) without new plumbing.
 * Returns error-level health checks; caller decides whether to proceed.
 */
export async function runHealthGate(client: LidarrClient, signal?: AbortSignal): Promise<readonly LidarrHealthCheck[]> {
  const checks = await client.getHealth(signal);
  return checks.filter((c) => c.type === "error");
}
```

### 2.2 Error taxonomy — `src/lib/lidarr/errors.ts`

The task mandates named domain error classes carrying the _semantic_ distinction the generic `MediaServerErrorCode` union cannot express (down-instance vs down-metadata-server). We therefore define a **dedicated `LidarrError` hierarchy** whose base mirrors the field shape of `MediaServerError` (`code`, `operation`, `statusCode`, `retryable`) for interop, and a `classifyLidarrStatus` mapper the client uses.

> **Divergence note (recorded for reviewers):** the research scaffold proposed reusing `MediaServerError` with `serverType: "lidarr"`. This spec instead ships first-class `LidarrError` subclasses because (a) the task explicitly requires them, (b) #196's error-classification core needs to distinguish _instance-unreachable_ from _metadata-provider-unavailable_, which a shared `MediaServerErrorCode` cannot semantically carry, and (c) Lidarr is an arr-stack manager, not a `MediaServerAdapter`, so a separate error type avoids implying it satisfies that contract. Tests assert on the `LidarrError` subclasses, not `MediaServerError`.

```typescript
// src/lib/lidarr/errors.ts

/** Wire-level classification code. Superset compatible with MediaServerErrorCode field shape. */
export type LidarrErrorCode =
  | "lidarr-unreachable" // local Lidarr instance/API down (network / DNS / connect refused / 5xx from Lidarr itself)
  | "metadata-provider-unavailable" // api.lidarr.audio down while Lidarr is up (Tier-3 only) — expected, not exceptional
  | "rate-limited" // 429 / documented 503 overload; honor Retry-After
  | "validation" // client-side request-shape / input failure, surfaced pre-mutation
  | "authentication" // 401
  | "authorization" // 403
  | "not-found" // 404
  | "invalid-response" // malformed / oversized body, failed boundary guard
  | "timeout" // AbortController timeout
  | "configuration"; // unsafe path, missing url/apiKey

export interface LidarrErrorContext {
  readonly operation: string;
  readonly statusCode?: number;
  readonly retryable?: boolean;
  /** Seconds to wait; parsed from Retry-After when present. */
  readonly retryAfterSeconds?: number;
  readonly cause?: unknown;
}

/** Base class. All lidarr failures cross the boundary as a LidarrError. */
export abstract class LidarrError extends Error {
  abstract readonly code: LidarrErrorCode;
  readonly operation: string;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  protected constructor(message: string, ctx: LidarrErrorContext) {
    super(message, ctx.cause === undefined ? undefined : { cause: ctx.cause });
    this.name = new.target.name;
    this.operation = ctx.operation;
    this.statusCode = ctx.statusCode;
    this.retryable = ctx.retryable ?? false;
    this.retryAfterSeconds = ctx.retryAfterSeconds;
  }
}

/** Local Lidarr instance/API is unreachable or returned 5xx. Hard failure; affects all tiers. */
export class LidarrUnreachableError extends LidarrError {
  readonly code = "lidarr-unreachable" as const;
  constructor(operation: string, message = "Lidarr is unreachable", ctx: Partial<LidarrErrorContext> = {}) {
    super(message, { operation, retryable: true, ...ctx });
  }
}

/** api.lidarr.audio down while local Lidarr is up. Only affects Tier-3. Expected, not exceptional. */
export class MetadataProviderUnavailableError extends LidarrError {
  readonly code = "metadata-provider-unavailable" as const;
  constructor(
    operation: string,
    message = "Lidarr metadata server is unavailable",
    ctx: Partial<LidarrErrorContext> = {},
  ) {
    super(message, { operation, retryable: true, ...ctx });
  }
}

/** 429 / documented 503 overload. Carries Retry-After. */
export class RateLimitedError extends LidarrError {
  readonly code = "rate-limited" as const;
  constructor(operation: string, retryAfterSeconds?: number, ctx: Partial<LidarrErrorContext> = {}) {
    super(
      retryAfterSeconds !== undefined
        ? `Lidarr rate-limited (retry after ${retryAfterSeconds}s)`
        : "Lidarr rate-limited",
      { operation, retryable: true, retryAfterSeconds, ...ctx },
    );
  }
}

/** Client-side request-shape / input validation or malformed-response failure. Not retryable. */
export class LidarrValidationError extends LidarrError {
  readonly code: LidarrErrorCode;
  constructor(
    operation: string,
    message: string,
    code: "validation" | "invalid-response" | "configuration" = "validation",
  ) {
    super(message, { operation, retryable: false });
    this.code = code;
  }
}
```

**Status → error mapping** used by the client. 5xx from the _local Lidarr instance_ means the instance is faulted (`LidarrUnreachableError`); the distinct _metadata-provider-unavailable_ case is raised by Tier-3 endpoints (`artist/lookup`, `POST /artist`, `POST /command`) when Lidarr surfaces a 503/500 from the metadata layer — not reachable via the four baseline endpoints, so the mapper is scaffolded but only `lidarr-unreachable` is reachable in this PR:

```typescript
// src/lib/lidarr/errors.ts

/** Parse a Retry-After header (delta-seconds form; HTTP-date form ignored → undefined). */
export function parseRetryAfter(headerValue: string | null): number | undefined {
  if (headerValue === null) return undefined;
  const seconds = Number(headerValue.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Map an HTTP failure from a Lidarr request into the taxonomy. `retryAfter` from parseRetryAfter. */
export function classifyLidarrStatus(status: number, operation: string, retryAfterSeconds?: number): LidarrError {
  switch (status) {
    case 401:
      return new LidarrValidationError(operation, "Lidarr authentication failed (HTTP 401)", "configuration");
    case 403:
      return new LidarrValidationError(operation, "Lidarr authorization failed (HTTP 403)", "configuration");
    case 404:
      return new LidarrValidationError(operation, "Lidarr resource not found (HTTP 404)", "validation");
    case 429:
      return new RateLimitedError(operation, retryAfterSeconds, { statusCode: 429 });
    default:
      if (status >= 500)
        return new LidarrUnreachableError(operation, `Lidarr returned HTTP ${status}`, { statusCode: status });
      return new LidarrValidationError(operation, `Unexpected Lidarr response (HTTP ${status})`, "validation");
  }
}
```

> Overload signals: research documents **503/500** as the metadata-server overload signals and **429 + `Retry-After` + exponential backoff** as the standard overload contract to honor. This PR **honors `Retry-After`** by surfacing it on `RateLimitedError`; the actual backoff/replay loop is **deferred to #195**.

---

## 3. Full File Layout

```
packages/rfmedia-cli/
├── src/
│   ├── types/
│   │   └── lidarr.ts                     # Config + wire response types for the 4 baseline commands + hand-written guards
│   ├── lib/lidarr/
│   │   ├── client.ts                     # LidarrClient: fetch wrapper, X-Api-Key, origin-pinned URL, timeout, error mapping (ONLY fetch call site)
│   │   ├── errors.ts                     # LidarrError base + subclasses, classifyLidarrStatus, parseRetryAfter
│   │   ├── tiers.ts                      # LidarrTier union, tier descriptors, runHealthGate scaffold
│   │   ├── types.ts                      # (support) connection settings + api-key provider DI seams + wire guards; mirrors plex/types.ts (respects 500-line cap)
│   │   └── index.ts                      # Barrel: re-exports; createLidarrClient factory (config→client); resolveRequiredLidarrClient resolver
│   ├── actions/lidarr/
│   │   ├── status.ts                     # executeLidarrStatus — library overview (counts, disk, version). TIER=local-only
│   │   ├── list.ts                       # executeLidarrList — artist list w/ tag/profile/monitor filters + client-side paging. TIER=local-only
│   │   ├── wanted.ts                     # executeLidarrWanted — wanted/missing (server-paginated). TIER=local-only
│   │   ├── health.ts                     # executeLidarrHealth — system health checks (also the Tier-3 gate probe). TIER=local-only
│   │   └── index.ts                      # Barrel: re-export execute*/option/result types
│   └── commands/
│       └── lidarr.ts                     # `lidarrCommand` parent + 4 leaf subcommands; JSON/human parity; exit handling
├── src/actions/test-helpers/
│   ├── lidarr-fixtures.ts                # EMPTY_* constants + create*Fixture(overrides) factories
│   └── lidarr-client-mocks.ts            # Typed MockedCapability<LidarrClientApi> builder
└── (tests co-located as *.test.ts beside each source file — see §9)
```

> The four files the task names for `src/lib/lidarr/` (`client`, `errors`, `tiers`, `index`) are the mandated core; `types.ts` is a support module added to keep each file under the ~500-line soft cap and to mirror `plex/types.ts` (connection/auth DI seams + wire guards). `src/actions/lidarr/` uses a **subdirectory** (per the task's mandated layout) rather than the flat `plex-query.ts` naming, justified by the namespace growing to 7+ actions across later phases.

---

## 4. Type Definitions — `src/types/lidarr.ts`

Concrete interfaces scoped to exactly what the 4 commands need. Wire types are the minimal subset of the Lidarr `AlbumResource`/`ArtistResource`/`HealthResource`/`SystemResource` fields consumed here (full shapes arrive with codegen in #194).

```typescript
// src/types/lidarr.ts

// ── Config section (re-exported from types/config.ts; defined there, aliased here for cohesion) ──
export interface LidarrConfigOptions {
  /** Lidarr base URL, e.g. "http://localhost:8686". Validated via validateUrl (http/https only). */
  baseUrl?: string;
  /** Lidarr API key, sent as the X-Api-Key header. Redacted in logs (already in SENSITIVE_FIELD_NAMES). */
  apiKey?: string;
  /** Optional request timeout in ms; client default is 30_000. */
  timeoutMs?: number;
}

// ── System status (GET /api/v1/system/status) ──
export interface LidarrSystemStatus {
  readonly version: string;
  readonly appName?: string;
  readonly instanceName?: string;
  readonly isProduction?: boolean;
  readonly runtimeVersion?: string;
}

// ── Artist list item (GET /api/v1/artist) ──
export interface LidarrArtistStatistics {
  readonly albumCount: number;
  readonly trackFileCount: number;
  readonly trackCount: number;
  readonly totalTrackCount?: number;
  readonly sizeOnDisk: number;
  readonly percentOfTracks?: number;
}

export interface LidarrArtist {
  readonly id: number;
  readonly artistName: string;
  /** MusicBrainz artist id — canonical key for the future Plex-Lidarr bridge (#208+). */
  readonly foreignArtistId: string;
  readonly monitored: boolean;
  readonly qualityProfileId: number;
  readonly metadataProfileId: number;
  readonly path?: string;
  readonly tags: readonly number[];
  readonly statistics?: LidarrArtistStatistics;
}

// ── Wanted / missing record (GET /api/v1/wanted/missing — server-paginated) ──
export interface LidarrWantedArtistRef {
  readonly id: number;
  readonly artistName: string;
  readonly foreignArtistId?: string;
}

export interface LidarrWantedRecord {
  /** Album id. */
  readonly id: number;
  readonly title: string;
  readonly artist: LidarrWantedArtistRef;
  readonly releaseDate?: string;
  readonly monitored: boolean;
}

/** Lidarr's PagingResource envelope, narrowed to wanted/missing. */
export interface LidarrWantedPage {
  readonly page: number;
  readonly pageSize: number;
  readonly totalRecords: number;
  readonly sortKey?: string;
  readonly sortDirection?: string;
  readonly records: readonly LidarrWantedRecord[];
}

// ── Health-check record (GET /api/v1/health) ──
export type LidarrHealthType = "ok" | "notice" | "warning" | "error";

export interface LidarrHealthCheck {
  readonly source: string;
  readonly type: LidarrHealthType;
  readonly message: string;
  readonly wikiUrl?: string;
}
```

**Hand-written boundary guards** live in `src/lib/lidarr/types.ts` (built from primitives `isRecord`, `hasString`, `hasFiniteNumber`, `hasBoolean`, `hasOptionalString`), one per wire shape:

```typescript
// src/lib/lidarr/types.ts (guards; primitives omitted for brevity)
export function isLidarrSystemStatus(v: unknown): v is LidarrSystemStatus {
  /* isRecord && hasString(v,"version") */
}
export function isLidarrArtist(v: unknown): v is LidarrArtist {
  /* id, artistName, foreignArtistId, monitored, ids, tags[] */
}
export function isLidarrArtistArray(v: unknown): v is LidarrArtist[] {
  /* Array.isArray && every(isLidarrArtist) */
}
export function isLidarrWantedPage(v: unknown): v is LidarrWantedPage {
  /* page/pageSize/totalRecords numbers, records[] every isLidarrWantedRecord */
}
export function isLidarrHealthCheck(v: unknown): v is LidarrHealthCheck {
  /* source/type/message strings, type ∈ union */
}
export function isLidarrHealthArray(v: unknown): v is LidarrHealthCheck[] {
  /* Array.isArray && every(isLidarrHealthCheck) */
}
```

Every client method requests `unknown` and runs its guard before returning; a guard miss throws `new LidarrValidationError(operation, "...malformed...", "invalid-response")`.

---

## 5. Client Design — `src/lib/lidarr/client.ts`

A minimal, hand-written, strictly-typed fetch wrapper distilled from `PlexClient` (`src/lib/adapters/plex/client.ts`). **Full OpenAPI codegen is explicitly deferred to #194** — this client exists only to unblock the four baseline reads with production-grade boundary safety.

### Structure

- **Injectable `fetch` + test seams.** `fetch` defaults to `globalThis.fetch.bind(globalThis)`, overridable via `LidarrClientDependencies` (`fetch?`, `delay?`, `scheduleTimeout?`, `cancelTimeout?`, `maxSuccessBodyBytes?`, `maxErrorBodyBytes?`). Instance is `Object.freeze(this)`; api key held in `#private` field / module-private `WeakMap` — never enumerable, never serialized.
- **Origin binding.** Factory normalizes `baseUrl` with `normalizeHttpUrl` (http/https only) at the boundary and passes a canonical `origin` in. Connection settings created via `createLidarrConnectionSettings({ origin, apiKey, request })` in `types.ts`.
- **Header-only auth.** Every request sends exactly `{ Accept: "application/json", "X-Api-Key": apiKey }` (header order asserted in tests). `redirect: "error"`.
- **Origin-pinned URL builder.** Path must start with `/`, contain no `//`, `\`, `?`, or `#`; `new URL(path,`${origin}/`)`; assert `url.origin === connection.origin`; structured query appended from `Record<string, string|number|boolean|undefined>` (undefined skipped). Any auth-material-looking query value rejected. Violations → `LidarrValidationError(op, ..., "configuration")` **before** fetch.
- **Timeout.** Composed `AbortController` + caller signal + scheduled timeout (`DEFAULT_REQUEST_TIMEOUT_MS = 30_000`). On timeout → `LidarrValidationError`/dedicated timeout mapping (`code: "timeout"`). Optional post-response `delayMs` honored (mirrors Plex).
- **Bounded body + strict parse.** `readBoundedBody` streams with a hard byte cap (over-cap → `invalid-response`); `parseJsonBody` uses `new TextDecoder("utf-8", { fatal: true })` then `JSON.parse`; empty body → `undefined`.
- **Error mapping.** Non-`ok` responses → `classifyLidarrStatus(status, operation, parseRetryAfter(res.headers.get("retry-after")))`. Network/connect failures (thrown by `fetch`) → `LidarrUnreachableError(operation, ..., { cause })`. Messages scrubbed of the api key via `sanitizeMessage` before crossing the boundary.
- **Boundary validation.** Each typed method validates the parsed body with the matching `isLidarrWire*` guard; miss → `invalid-response`.

### Public surface

```typescript
// src/lib/lidarr/client.ts
export interface LidarrClientDependencies {
  readonly fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  readonly delay?: (ms: number) => Promise<void>;
  readonly scheduleTimeout?: (cb: () => void, ms: number) => unknown;
  readonly cancelTimeout?: (handle: unknown) => void;
  readonly maxSuccessBodyBytes?: number;
  readonly maxErrorBodyBytes?: number;
}

export interface LidarrRequest {
  readonly path: string; // e.g. "/api/v1/artist"
  readonly operation: string; // human label for error context
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly signal?: AbortSignal;
}

export interface LidarrWantedQuery {
  readonly page?: number; // default 1
  readonly pageSize?: number; // default 50
  readonly sortKey?: string; // default "releaseDate"
  readonly sortDirection?: "ascending" | "descending";
  readonly signal?: AbortSignal;
}

/** Narrow interface the actions depend on (mockable seam — see §9). */
export interface LidarrClientApi {
  getSystemStatus(signal?: AbortSignal): Promise<LidarrSystemStatus>;
  getHealth(signal?: AbortSignal): Promise<readonly LidarrHealthCheck[]>;
  listArtists(signal?: AbortSignal): Promise<readonly LidarrArtist[]>;
  getWantedMissing(query?: LidarrWantedQuery): Promise<LidarrWantedPage>;
}

export class LidarrClient implements LidarrClientApi {
  constructor(
    connection: LidarrConnectionSettings, // from createLidarrConnectionSettings(...)
    apiKeyProvider: LidarrApiKeyProvider, // StaticLidarrApiKeyProvider by default
    deps?: LidarrClientDependencies,
  );

  /** Low-level primitive: build url → fetch → bounded read → strict parse → classify. Returns raw unknown. */
  request<T>(input: LidarrRequest): Promise<T>;

  // ── Typed, boundary-validated methods ──
  getSystemStatus(signal?: AbortSignal): Promise<LidarrSystemStatus>; // GET /api/v1/system/status → isLidarrSystemStatus
  getHealth(signal?: AbortSignal): Promise<readonly LidarrHealthCheck[]>; // GET /api/v1/health        → isLidarrHealthArray
  listArtists(signal?: AbortSignal): Promise<readonly LidarrArtist[]>; // GET /api/v1/artist        → isLidarrArtistArray
  getWantedMissing(query?: LidarrWantedQuery): Promise<LidarrWantedPage>; // GET /api/v1/wanted/missing → isLidarrWantedPage
}
```

### Pagination note (load-bearing accuracy)

- **`getWantedMissing` is server-paginated** — Lidarr's `/api/v1/wanted/missing` returns a `PagingResource` (`page`/`pageSize`/`totalRecords`/`records`). Client passes `page`, `pageSize`, `sortKey`, `sortDirection` as query params.
- **`listArtists` is NOT server-paginated** — `/api/v1/artist` returns the full array. Pagination for the `list` command is applied **client-side** in `executeLidarrList` (slice by `--limit`/`--offset`). The spec surfaces this honestly rather than faking a paged endpoint.

### Factory + resolver — `src/lib/lidarr/index.ts`

```typescript
export interface LidarrClientOverrides {
  readonly lidarrUrl?: string; // CLI --lidarr-url override
  readonly lidarrApiKey?: string; // CLI --lidarr-api-key override
}

/** Reads getLoadedLidarrConfig(), applies overrides, normalizeHttpUrl(baseUrl), returns a client or a typed failure. */
export function createLidarrClient(overrides?: LidarrClientOverrides): LidarrClient | undefined;

/** Throws LidarrValidationError("...", "configuration") when url/apiKey missing. Actions call this. */
export function resolveRequiredLidarrClient(overrides?: LidarrClientOverrides): LidarrClientApi;
```

---

## 6. Baseline Command Specs

All four are **Tier `local-only`**, read-only, exit `process.exitCode = 1` on failure (query-style, never `process.exit`), and honor the parity gate. Human tables render to **stderr** via `console.error`/`console-table-printer`; machine formats go to **stdout** via `formatOutput`. Shared flags on every subcommand: `--lidarr-url <url>` and `--lidarr-api-key <key>` (config overrides). Global `--json` / `--output <format>` come from the root program via `lidarrCommand.parent?.opts()`.

Each command file declares a JSON envelope: `interface Lidarr<Verb>JsonOutput { command: "lidarr-<verb>"; result: Lidarr<Verb>ActionResult }`.

### 6.1 `rfmedia lidarr status`

- **Purpose:** library overview.
- **Client calls:** `getSystemStatus()` + `listArtists()`.
- **Flags:** shared only.
- **Behavior:** aggregate artist counts (`total`, `monitored`, `unmonitored`), sum `statistics.sizeOnDisk`, sum `trackFileCount`/`trackCount`; include `version` + `instanceName`.
- **Result type:**

  ```typescript
  export interface LidarrStatusActionResult {
    version: string;
    instanceName?: string;
    artistCount: number;
    monitoredCount: number;
    unmonitoredCount: number;
    totalSizeOnDisk: number;
    trackFileCount: number;
    trackCount: number;
  }
  ```

- **Human:** a labeled summary table (`Version`, `Instance`, `Artists`, `Monitored`, `On Disk`, `Tracks x/y`).
- **`--json`:** `{ command: "lidarr-status", result: LidarrStatusActionResult }`.

### 6.2 `rfmedia lidarr list`

- **Purpose:** list artists with filtering.
- **Client call:** `listArtists()` (client-side filter + page).
- **Flags:** `--tag <id...>` (numeric tag ids, `parsePositiveInt` via `argParser`, repeatable), `--monitored` / `--unmonitored` (mutually `.conflicts`), `--quality-profile <id>` (`parsePositiveInt`), `--limit <n>` (`parsePositiveInt`, default 50), `--offset <n>` (`parsePositiveInt`, default 0) + shared.
- **Behavior:** filter by monitored state, tag membership (all specified tags present), quality profile; then `slice(offset, offset+limit)`. Returns filtered slice + `total` (pre-slice count).
- **Result type:**

  ```typescript
  export interface LidarrListItem {
    id: number;
    artistName: string;
    foreignArtistId: string;
    monitored: boolean;
    qualityProfileId: number;
    tags: readonly number[];
    albumCount: number;
    sizeOnDisk: number;
  }
  export interface LidarrListActionResult {
    artists: readonly LidarrListItem[];
    total: number;
    limit: number;
    offset: number;
  }
  ```

- **Human:** table (`ID`, `Artist`, `Monitored`, `Albums`, `On Disk`, `MBID`) + a `Showing N of TOTAL` footer line to stderr.
- **`--json`:** `{ command: "lidarr-list", result: LidarrListActionResult }`.

### 6.3 `rfmedia lidarr wanted`

- **Purpose:** view wanted/missing albums.
- **Client call:** `getWantedMissing({ page, pageSize, sortKey, sortDirection })` (server-paginated).
- **Flags:** `--page <n>` (default 1), `--page-size <n>` (default 50), `--sort-key <key>` (`new Option(...).choices(["releaseDate","title","artist"])`, default `releaseDate`), `--sort-dir <dir>` (`.choices(["ascending","descending"])`, default `descending`) + shared.
- **Behavior:** single-page fetch (no auto-paging in the foundation — full traversal deferred). Map records to a projection.
- **Result type:**

  ```typescript
  export interface LidarrWantedItem {
    albumId: number;
    title: string;
    artistName: string;
    releaseDate?: string;
    monitored: boolean;
  }
  export interface LidarrWantedActionResult {
    records: readonly LidarrWantedItem[];
    page: number;
    pageSize: number;
    totalRecords: number;
  }
  ```

- **Human:** table (`Album`, `Artist`, `Release`, `Monitored`) + `Page X — TOTAL wanted` footer.
- **`--json`:** `{ command: "lidarr-wanted", result: LidarrWantedActionResult }`.

### 6.4 `rfmedia lidarr health`

- **Purpose:** system health check (also the Tier-3 pre-flight probe surface).
- **Client call:** `getHealth()`.
- **Flags:** `--type <type...>` (`.choices(["ok","notice","warning","error"])`, repeatable filter) + shared.
- **Behavior:** optional filter by `type`; passthrough projection.
- **Result type:**

  ```typescript
  export interface LidarrHealthActionResult {
    checks: readonly LidarrHealthCheck[];
    hasErrors: boolean; // any check.type === "error"
  }
  ```

- **Human:** table (`Type`, `Source`, `Message`); empty → `No health issues reported.` to stderr.
- **Exit:** report-only; a non-empty error list does **not** by itself set exit 1 (surfacing, not gating). Exit 1 only on action throw. (Rationale: `health` is diagnostic; gating semantics belong to the Tier-3 `runHealthGate` consumer in #194/#196.)
- **`--json`:** `{ command: "lidarr-health", result: LidarrHealthActionResult }`.

### Action signature contract (all four)

```typescript
export interface Lidarr<Verb>ActionOptions {
  /* verb-specific flags */
  lidarrUrl?: string;
  lidarrApiKey?: string;
}
export async function executeLidarr<Verb>(options: Lidarr<Verb>ActionOptions): Promise<Lidarr<Verb>ActionResult> {
  const client = resolveRequiredLidarrClient({ lidarrUrl: options.lidarrUrl, lidarrApiKey: options.lidarrApiKey });
  logDebug(`lidarr <verb>: ...`);
  const raw = await client.<method>(...);   // throws typed LidarrError on failure — action does not swallow
  logInfo(`...`);
  return project(raw);                       // pure projection; no output formatting in the action
}
export const TIER: LidarrTier = "local-only";
```

---

## 7. Config + Secrets Template + Example File Edits

### 7.1 `src/types/config.ts`

Add the interface (mirroring `PlexConfigOptions`) and the optional root field:

```typescript
export interface LidarrConfigOptions {
  /** Lidarr base URL (e.g., "http://localhost:8686"). */
  baseUrl?: string;
  /** Lidarr API key (X-Api-Key header). SENSITIVE — never commit. */
  apiKey?: string;
  /** Request timeout in ms; client default 30_000. */
  timeoutMs?: number;
}

export interface ConfigFile {
  // ...existing...
  /** Lidarr integration options */
  lidarr?: LidarrConfigOptions;
}
```

### 7.2 `src/types/index.ts`

Add `LidarrConfigOptions` to the `export type { ... } from "./config.js";` block alongside `PlexConfigOptions`.

### 7.3 `src/lib/config.ts`

- Add per-section validator next to `validatePlexConfigOptions`:

  ```typescript
  function validateLidarrConfigOptions(raw: Record<string, unknown>, configPath: string): LidarrConfigOptions {
    const config: LidarrConfigOptions = {};
    if ("baseUrl" in raw && raw["baseUrl"] !== undefined) {
      config.baseUrl = validateUrl(raw["baseUrl"], "lidarr.baseUrl", configPath);
    }
    if ("apiKey" in raw && raw["apiKey"] !== undefined) {
      config.apiKey = validateString(raw["apiKey"], "lidarr.apiKey", configPath);
    }
    if ("timeoutMs" in raw && raw["timeoutMs"] !== undefined) {
      config.timeoutMs = validatePositiveInteger(raw["timeoutMs"], "lidarr.timeoutMs", configPath);
    }
    return config;
  }
  ```

- Add the dispatch block in `validateConfig` (mirroring the `plex` block):

  ```typescript
  if ("lidarr" in rawObj && rawObj["lidarr"] !== undefined) {
    if (typeof rawObj["lidarr"] !== "object" || rawObj["lidarr"] === null || Array.isArray(rawObj["lidarr"])) {
      throw new ConfigError("lidarr must be an object", configPath, "lidarr");
    }
    config.lidarr = validateLidarrConfigOptions(rawObj["lidarr"] as Record<string, unknown>, configPath);
  }
  ```

- `apiKey` is **already** in `SENSITIVE_FIELD_NAMES` → `lidarr.apiKey` auto-redacted in merge/debug logs. No change needed.

### 7.4 `src/lib/loaded-config.ts`

Add the accessor mirroring `getLoadedPlexConfig`:

```typescript
export function getLoadedLidarrConfig(): LidarrConfigOptions {
  return getLoadedConfig().lidarr ?? {};
}
```

### 7.5 Secrets template

No code needed — `{{ VAR_NAME }}` is resolved generically by `injectSecrets` on raw file text before parse. `apiKey: "{{ LIDARR_API_KEY }}"` works out of the box; missing env var throws `SecretsInjectionError`.

### 7.6 `rfmedia.example.yaml`

Add after the commented `plex:` block:

```yaml
# Lidarr music-management integration
lidarr:
  # Lidarr base URL
  baseUrl: "{{ LIDARR_URL }}"
  # Lidarr API key (SENSITIVE - never commit the actual key)
  apiKey: "{{ LIDARR_API_KEY }}"
  # Optional request timeout in milliseconds (default 30000)
  # timeoutMs: 30000
```

---

## 8. CLI Wiring + Shell Completion Edits

### 8.1 `src/cli.ts`

- Import (alphabetical, after `initCommand`, before `linkVideosCommand`):

  ```typescript
  import { lidarrCommand } from "./commands/lidarr.js";
  ```

- Register (after `program.addCommand(initCommand);`):

  ```typescript
  program.addCommand(lidarrCommand);
  ```

### 8.2 `src/commands/lidarr.ts` (new)

```typescript
export const lidarrCommand = new Command("lidarr").description("Lidarr music-management operations");
// build status/list/wanted/health leaves with new Command(...), lazy-import actions inside .action(),
// apply the isMachineFormat parity gate, then:
lidarrCommand.addCommand(lidarrStatusCommand);
lidarrCommand.addCommand(lidarrListCommand);
lidarrCommand.addCommand(lidarrWantedCommand);
lidarrCommand.addCommand(lidarrHealthCommand);
```

Custom arg parsers throw `InvalidArgumentError` (never plain `Error`). Catch blocks `logError(...)` + `process.exitCode = 1`.

### 8.3 Shell completions — edit all three (hand-maintained static templates)

**`src/lib/shell-completions/bash.ts`** (5 edits): add `lidarr` to the top-level `commands` string; add `local lidarr_subcommands="status list wanted health"` and `local lidarr_list_opts="..."`; add `lidarr` to the top-level command matcher alternation; add `status|wanted|health` to the subcommand-token alternation + a `lidarr` branch; add a `lidarr)` arm in the main `case "$cmd"` dispatch (modeled on the `filter)` arm) routing `status|health` → `global_opts`, `list|wanted` → subcommand opts + `global_opts`.

**`src/lib/shell-completions/zsh.ts`** (3 edits): add `'lidarr:Lidarr music-management operations'` to the `commands` array; add `lidarr` to `__rfmedia_find_command()` alternation; add a `lidarr)` case in the `args`-state `case $cmd` block (modeled on `filter)`) with `lidarr_subcmds` describe + per-subcommand `_arguments`.

**`src/lib/shell-completions/fish.ts`** (3 additions): top-level `complete -c rfmedia -n "__fish_use_subcommand" -a "lidarr" -d "..."`; helper `__fish_rfmedia_lidarr_needs_subcommand`; the four subcommand `complete` lines + per-subcommand flag completes gated by `__fish_seen_subcommand_from lidarr`.

**`src/lib/shell-completions/templates.spec.ts`**: add a `lidarr`-coverage block (mcp-style) asserting `lidarr` and `status list wanted health` render in bash, zsh, and fish.

### 8.4 MCP — deferred

No `src/mcp/*` edits. MCP exposure is a curated allowlist decoupled from CLI registration (only 6 tools exist; `plex` surfaces 1 of 5 subcommands). Ships with zero MCP changes.

---

## 9. Test Plan

Co-located `*.test.ts` (Vitest, `globals: true` but still explicitly `import { describe, expect, it, vi, beforeEach } from "vitest"`). Mock at the seams — never touch network or a real server. Run: `npm test -w packages/rfmedia-cli -- run src/lib/lidarr src/actions/lidarr src/commands/lidarr.test.ts`.

### 9.1 `src/lib/lidarr/client.test.ts`

DI-inject `vi.fn` `fetch` + real `Response` objects (no `vi.mock` of fetch). Key cases:

- Exact request URL via `String(url)` match; `.not.toContain(apiKey)`; `requestInit` `toMatchObject({ method, redirect:"error", headers:{ Accept, "X-Api-Key" } })` + exact `Object.keys(headers)` order `["Accept","X-Api-Key"]`.
- `it.each` unsafe paths (`https://attacker...`, `//attacker...`, `?apikey=leak`, `#frag`, `api/v1/...` no leading slash) → thrown before fetch, `code:"configuration"`, `fetch` not called.
- Secret never in `Object.keys(client)` / `JSON.stringify(client)` / `inspect(client)` / `inspect(error)`.
- Redirect (302) → `LidarrUnreachableError`/mapped, no follow.
- Status table `it.each([[401,...],[403,...],[404,...],[429,...retryAfter],[503,...]])` asserting error class + `code`/`statusCode`/`retryable`; body/secret not leaked into message.
- `429` with `Retry-After: 12` → `RateLimitedError` with `retryAfterSeconds === 12`.
- Malformed + oversized body → `invalid-response` (via `maxSuccessBodyBytes`).
- Each typed method validates via its guard; guard miss → `invalid-response`.

### 9.2 `src/lib/lidarr/errors.test.ts`

Field-assertion style + classification table:

- `it.each([[401,LidarrValidationError],[403,...],[404,...],[429,RateLimitedError],[500,LidarrUnreachableError],[503,LidarrUnreachableError]])` on `classifyLidarrStatus`.
- `parseRetryAfter("30") === 30`; `parseRetryAfter(null) === undefined`; HTTP-date form → `undefined`.
- Each subclass: assert `.name`, `.code`, `.operation`, `.retryable`, `.statusCode`, `.retryAfterSeconds`, `instanceof LidarrError`.

### 9.3 `src/lib/lidarr/tiers.test.ts`

- `LIDARR_TIER_DESCRIPTORS` frozen; `local-only` → `metadataServerRequired:false`, `requiresHealthGate:false`; `metadata-dependent` → both true.
- `runHealthGate` returns only `type==="error"` checks; calls `client.getHealth` once (mock client).

### 9.4 Action tests (`src/actions/lidarr/{status,list,wanted,health}.test.ts`)

Mock-client pattern via `vi.hoisted()` + `vi.mock`:

- Mock `../../lib/lidarr/index.js` → `resolveRequiredLidarrClient` returns a typed `createLidarrClientMock()`.
- Mock `../../lib/loaded-config.js` and `../../lib/logger.js`.
- `beforeEach`: `vi.clearAllMocks()` (NOT `resetAllMocks`), re-seed mock + resolver return.

Per action — key cases:

- **status:** aggregates counts/disk/version from `systemStatus` + `listArtists`; happy projection `toEqual`; resolver throw propagates; client throw rethrows.
- **list:** filter by `--monitored`/tag/quality-profile; `--limit`/`--offset` slice; `total` = pre-slice; forwards overrides via `toHaveBeenCalledWith(expect.objectContaining({ lidarrUrl, lidarrApiKey }))`.
- **wanted:** forwards `page`/`pageSize`/`sortKey`/`sortDirection` to `getWantedMissing`; maps `records`; empty-page edge.
- **health:** projects rows, `hasErrors` true when an `error` check present; `--type` filter; client error rethrows.

Supporting builders: `src/actions/test-helpers/lidarr-fixtures.ts` (`EMPTY_WANTED_PAGE`, `HEALTHY_STATUS`, `createLidarrArtistFixture(overrides={})`, `createLidarrHealthCheckFixture`) and `lidarr-client-mocks.ts` (`createLidarrClientMock(overrides)` using the `MockedCapability<LidarrClientApi>` mapped type + `vi.fn(default)`).

### 9.5 `src/commands/lidarr.test.ts`

Mirror `plex.test.ts`: `vi.hoisted()` action mocks, `vi.mock` before importing `lidarrCommand`, drive with `rootCommand.parseAsync([...], { from: "node" })`. Cases:

- Hierarchy contract: `lidarrCommand.commands.map(c => c.name())` `toEqual(["status","list","wanted","health"])`.
- `--output json lidarr status` → `formatOutput("json", { command:"lidarr-status", result })`.
- `lidarr list --lidarr-url ... --lidarr-api-key ...` forwards to action (`objectContaining`).
- Action rejection → `logError` called + `process.exitCode === 1`; `afterEach` resets `process.exitCode`.
- `--json` and `--output yaml/csv` parity for each subcommand.

### 9.6 `templates.spec.ts`

Add `lidarr` + `status list wanted health` assertions across bash/zsh/fish.

### 9.7 Architecture guard

Mirror `check-direct-plex-imports.mjs`: ensure `fetch` appears only in `src/lib/lidarr/client.ts`. Either extend the existing script to also allowlist the lidarr client, or add a sibling check; wire into `prebuild`/`pretypecheck` `check:architecture`.

---

## 10. ROADMAP.md Update Text

Insert under the CLI/rfmedia roadmap section:

```markdown
### Lidarr integration (layered)

Foundation for a layered Lidarr integration: a `rfmedia lidarr` namespace, a minimal
typed HTTP client, reliability-tier + error-taxonomy scaffolding, and read-only
baseline commands.

- [x] **Foundation (#193)** — `rfmedia lidarr` namespace; layered `types → client →
tiers/errors → actions → command` structure; minimal hand-written typed Lidarr
      HTTP client with boundary validation; reliability-tier encoding
      (`local-only | metadata-dependent | discovery | destructive`) and error taxonomy
      (`LidarrUnreachableError`, `MetadataProviderUnavailableError`, `RateLimitedError`,
      `LidarrValidationError`); config `lidarr` section + secrets + completions.
- [x] **Baseline commands (#197)** — `status`, `list`, `wanted`, `health`
      (read-only, Tier `local-only`, human + `--json` parity).
- [ ] **Generated client (#194)** — replace the hand-written client with an
      auto-generated, regenerable client from Lidarr's OpenAPI spec
      (`@hey-api/openapi-ts`; evaluate TsArr Node compatibility, EG-1).
- [ ] **Resilience layer (#195)** — circuit breaker, exponential backoff/replay, and
      the deferred-intent SQLite queue (auto-replay on recovery). Builds on the tier
      encoding + `Retry-After` honoring shipped in #193.
- [ ] **Execution scheduler & lane budgets (#196)** — per-source/per-indexer budgets,
      health-gated Tier-3 dispatch, cascade caps.
- [ ] **Layer-1 mutations (#202)** — `unmonitor`, `tag`, `profile` behind
      `--dry-run` defaults + `--max-batch` caps (plan/apply).
- [ ] **Discovery — Layer 2 (#203+)** — Last.fm-first federated discovery with
      ListenBrainz/MusicBrainz fallback, loop prevention, `discover`/`add`.
- [ ] **Reconciliation — Layer 3 (#208+)** — Plex↔Lidarr bridge (gap analysis,
      rating-informed quality, MBID join), read+suggest by default, writes behind
      `--apply`.
```

---

## 11. Out-of-Scope / Deferred (Issue Mapping)

| Deferred                                                                                                       | Issue                           | Why not here                                                                                                                                       | Foundation hook left in place                                                         |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Full OpenAPI codegen / regenerable client (TsArr-or-generate)                                                  | **#194**                        | Consensus is _never hand-maintain bindings_, but codegen is blocked on EG-1 (TsArr Node compat); the minimal typed client unblocks the 4 reads now | `LidarrClientApi` interface — swap the impl behind it without touching actions        |
| Circuit breaker, exponential backoff/replay, deferred-intent SQLite queue                                      | **#195**                        | Full resilience is a separate concern; foundation needs only tier encoding + error classification + `Retry-After` surfacing                        | `RateLimitedError.retryAfterSeconds`, `LidarrError.retryable`, tier descriptors       |
| Scheduler, per-source/per-indexer lane budgets, cascade caps, health-gated dispatch                            | **#196** (beyond tier encoding) | Budget/scheduling engine is out of scope; the _tier + error taxonomy_ core (what #193 requires) is delivered                                       | `LidarrTier`, `LIDARR_TIER_DESCRIPTORS`, `runHealthGate` scaffold                     |
| Layer-1 **mutations** (`unmonitor`, `tag`, `profile`) + plan/apply + `--dry-run`/`--max-batch`                 | **#202**                        | Baseline PR is read-only; `unmonitor --type` also blocked on EG-10 (album-type field)                                                              | Command-tree scaffolding + `destructive` tier already defined                         |
| Discovery — Layer 2 (`discover`/`add`, Last.fm/ListenBrainz/MusicBrainz, loop prevention, source abstraction)  | **#203+**                       | Independent subsystem; Lidarr has zero discovery endpoints; gated on EG-7                                                                          | `discovery` tier reserved in `LidarrTier`                                             |
| Reconciliation — Layer 3 (Plex↔Lidarr bridge, gap analysis, rating-informed quality, MBID join, YAML policies) | **#208+**                       | Strategic moat, gated on EG-3 (Plex MBID availability)                                                                                             | `foreignArtistId` (MBID) carried on `LidarrArtist` for the future join                |
| MCP tool exposure of lidarr actions                                                                            | (convention allows deferral)    | MCP is a curated allowlist decoupled from CLI registration (6 tools total; `plex` exposes 1 of 5)                                                  | Actions are already framework-agnostic → trivially wrappable by `invokeLidarr*` later |
| Backend swappability (`MusicCollectionManager` interface)                                                      | tracked with #194               | Premature until a second backend exists; `LidarrClientApi` is the pragmatic seam                                                                   | `LidarrClientApi` interface                                                           |

**Pre-foundation empirical blockers** (do not block this PR): EG-1 (TsArr Node compat — blocks #194), EG-4 (metadata-server status — calibrates #196 strategy), EG-10 (album-type field — blocks `unmonitor --type` in #202), EG-3 (Plex MBID — blocks #208+). None gate `status`/`list`/`wanted`/`health`.
