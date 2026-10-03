# Media Server Adapter

This document defines the provider-neutral `MediaServerAdapter` boundary used by `rfmedia-cli`
actions and the private Plex implementation behind it.

## Purpose

Actions depend on grouped media-server capabilities instead of Plex endpoints, wire fields,
credentials, or cache details. The dependency direction is one way:

```text
commands and MCP -> actions -> generic contract -> PlexAdapter -> private Plex modules
```

- Generic contract: `src/types/media-server.ts`
- Factory and mode handling: `src/lib/adapters/index.ts`
- Action helper entrypoints: `src/lib/adapters/action-helpers.ts`
- Plex composition root: `src/lib/adapters/plex-adapter.ts`
- Private Plex implementation: `src/lib/adapters/plex/`

`PlexAdapter` is the only public Plex implementation. It constructs one origin-bound client and
one adapter-local cache, then composes the private query, library, scan, playlist, collection, and
metadata families around them.

## Generic Contract

The adapter exposes these grouped capabilities:

- `query`: tracks, albums, artists, album tracks, exact track lookup, and library content version
- `library`: list and lookup by name
- `scan`: full, path-scoped, and destination-aware scans
- `playlist`: list, lookup, tracks, create, add, and delete
- `collection`: list, lookup, items, create, add, and delete
- `metadata`: normalized track rating updates

Generic entities use an opaque `id`, a `kind` discriminator, and provider-neutral field names.
Plex `ratingKey`, metadata type codes, machine identifiers, `server://` URIs, wire payloads, and
request parameter names remain private implementation details. Query and CRUD methods throw a
typed `MediaServerError`; scan and rating updates retain result objects for their existing
best-effort action behavior.

Every paginated query accepts an optional `AbortSignal`. Implementations must check an already
aborted signal before returning a cached response and forward the signal through library resolution
and the live provider request. A signal is caller lifecycle state, not query identity: it must never
appear in a cache key or digest.

`trackById()` and `libraryContentVersion()` are mandatory, uncached freshness boundaries.
`trackById()` returns current path identity and metadata for one provider-owned track ID.
`libraryContentVersion()` returns opaque provider evidence whose value changes whenever membership
or any member's path identity changes. Both accept an optional `AbortSignal`, bypass response
caches, and forward cancellation to the provider transport. Reconciliation compares content
versions before and after acquisition and repeats exact track lookups before mutation; an adapter
must fail closed if it cannot supply those guarantees.

### Ratings and Feature Metadata

Ratings crossing the generic boundary are finite values on the closed `0..1` interval, or `null`
for unrated media. The Plex implementation converts at explicit boundaries:

| Boundary          | Scale            |
| ----------------- | ---------------- |
| Generic adapter   | `0..1` or `null` |
| Plex native       | integer `0..10`  |
| CLI compatibility | `0..5` stars     |

The adapter's `features` value describes behavior without exposing Plex protocol details:

- Ratings are readable, writable, normalized, and report the native `0..10` scale with step `1`.
- Smart playlists and smart collections are supported.
- Path-scoped scans and filter pushdown are supported.
- Sonic Analysis is `server-dependent`; it is not exposed as a callable capability.

Plex-branded commands, MCP responses, and persistence fields continue to use their established
names and scales through explicit compatibility projections.

## Factory Modes

Actions use one of two resolution paths:

- `resolveRequiredMediaServerAdapter(...)` is for query and CRUD flows. It throws when the URL or
  every credential source is missing, the URL is invalid, or an override would inherit a credential
  across origins.
- `resolveOptionalScanAdapter(...)` is for scan-only follow-up work. It returns
  `adapter: undefined` when scanning is disabled or the connection cannot be resolved safely, so a
  completed primary operation can continue.

The factory preserves existing config and CLI precedence. A URL override may inherit the configured
credential only when its canonical origin is unchanged. Changing origin requires an explicit paired
`--plex-token`; overriding only the token continues to use the configured origin. Explicit URL and
token overrides remain supported.

`src/lib/plex-origin.ts` is the single origin-normalization authority. The adapter resolver's
cross-origin guard and the `rfmedia plex auth` verbs both call `normalizePlexOrigin` from it, so
"the origin we enrolled" and "the origin the resolver looks up" can never diverge. No module
re-implements or copies it.

## Credential Precedence

One credential source is resolved once, at adapter construction, producing exactly one token
provider. There is no per-request fallback chain.

| #   | Source                               | Behavior                                                                             |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| 1   | `--plex-token`                       | Wins unconditionally; the only escape hatch that unlocks a cross-origin `--plex-url` |
| 2   | `plex.auth.mode: jwt`                | Enrolled credential for the resolved origin; never falls back to a static token      |
| 3   | `plex.token` (including `{{ VAR }}`) | A deliberately-set token outranks the store                                          |
| 4   | Enrolled credential (opportunistic)  | Used only when neither 1 nor 3 exists; origin-keyed                                  |
| 5   | none                                 | Connection reported missing, with the existing message                               |

`plex.auth.mode: jwt` together with `plex.token` is reported, not resolved: the adapter fails with
an `ambiguous-credential` message at use time rather than guessing.

The cross-origin guard is unchanged. It is a presence test on the raw CLI override object
(`--plex-url` supplied without `--plex-token`), so it fires identically whether the credential
would have come from config or from the enrollment store. **A stored credential does not unlock an
origin change.**

## Authentication and Transport Boundary

The existing `plex.token` config field and `--plex-token` flag accept either a legacy Plex token or
an already-issued JWT. The static provider treats the value as opaque: it does not decode,
normalize, persist, or make trust decisions from token contents. Empty values and control
characters are rejected.

Every authenticated request is owned by `src/lib/adapters/plex/client.ts` and follows these rules:

- Authentication is sent only in the `X-Plex-Token` header, never in the URL or query string.
- The credential is bound to one normalized HTTP(S) origin and is unavailable for another origin.
- Endpoint modules provide relative paths and structured, non-secret query values only.
- Authenticated redirects are rejected with `redirect: "error"`.
- Errors and bounded response handling redact credential material before crossing the adapter.
- The static provider does not refresh credentials or authorize a retry.
- Mutations are never replayed automatically. Replayability is an explicit per-request property, so
  a scan-trigger `GET` is not auto-retried merely because it uses a safe verb.

### JWT Enrollment Lifecycle

Automatic JWT enrollment, PIN authorization, Ed25519 key and client-identity storage, proactive and
reactive refresh, and durable secret persistence shipped in
[#251](https://github.com/yandy-r/rfmedia-apps/issues/251). They are exposed as
`rfmedia plex auth login | status | refresh | logout` and are documented in
[plex-configuration.md](plex-configuration.md).

- The rotating provider replaces the static one only on the enrolled precedence branches. The
  static path is byte-for-byte unchanged.
- Refresh is single-flight across processes: an exclusive sibling lock file guards the credential
  store, and a waiter that finds a peer's fresher credential adopts it instead of spending the
  IP-scoped nonce budget.
- The credential store is a `0600` file under a `0700` directory, written by atomic
  create-and-rename with full path-safety checks. No secret ever reaches the config file, the
  tracking database, the queue file, an MCP schema, or a JSON envelope.
- Reactive refresh after a `401`/`422` is capped at two attempts per process per store.

Deferred, with rationale recorded in `docs/internal/plex-jwt-deferrals.md`:

- **Server-side revocation.** `logout` destroys local material only; there is no documented
  client-callable revocation endpoint. Every result reports `serverSideRevocation: "manual"` and
  links to the Plex Authorized Devices page.
- **Enrollment Option 2** (`POST /api/v2/auth/jwk`), which expires the legacy token and is
  therefore not reversible.
- **Per-server `exchangeServerAccessToken`**, RS256/JWKS verification, and MCP enrollment
  arguments.

## Cache Boundary

Each `PlexAdapter` constructs its own in-memory TTL cache. Cache settings are captured at adapter
construction, state is isolated across adapter and credential lifecycles, and keys contain bounded
non-secret category discriminators rather than URLs or credentials. Successful playlist,
collection, and rating mutations invalidate the affected categories.

See [plex-api-caching.md](plex-api-caching.md) for cached operations and invalidation details.

## Import Rules

The completed boundary is enforced across production TypeScript:

- Generic types and helpers must not import Plex compatibility types or private Plex modules.
- Actions, commands, and MCP modules must not import `src/lib/adapters/plex/*` directly. This
  includes `import type`: the guard matches module specifiers as raw text and does not exempt
  type-only imports.
- Only `src/lib/adapters/plex-adapter.ts` composes private Plex modules. It is the **façade**: its
  re-export list is the contract for everything above it. A consumer that needs a missing symbol
  adds it to the façade; it never imports around it.
- Only `src/lib/adapters/plex/*` may construct Plex endpoints, parse Plex wire payloads, attach
  authentication, own authenticated `fetch`, or implement Plex cache policy.
- Plex compatibility types are limited to the documented projection/configuration allowlist.
- Deleted legacy API, cache, filter, and pagination modules must not be imported.

Run the architecture guard with:

```bash
node packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs
```

## Test Mocking Pattern

Action tests mock adapter resolution in `src/lib/adapters/action-helpers.ts`:

- `resolveRequiredMediaServerAdapter`
- `resolveOptionalScanAdapter`
- `extractTrackFilePaths` when applicable

Reusable generic fixtures and builders live in:

- `src/actions/test-helpers/media-server-adapter-mocks.ts`
- `src/actions/test-helpers/media-server-fixtures.ts`

Action-specific adapter mocks remain beside their Plex-branded compatibility tests. This keeps
tests focused on action behavior without rebuilding Plex config, transport, or wire internals.

## User Compatibility

The adapter refactor itself required no user migration, and that remains true. Existing `plex.*`
configuration, flags, commands, MCP and JSON fields, saved-query storage, human output, and shell
completion candidates are unchanged.

Issue [#251](https://github.com/yandy-r/rfmedia-apps/issues/251) is purely additive on top of it:

- New commands: `rfmedia plex auth login | status | refresh | logout`, with bash, zsh, and fish
  completions.
- New config block: `plex.auth` (`mode`, `storePath`, `deviceName`, `refreshMarginSeconds`), all
  optional. An absent block and `mode: static` behave identically.
- New environment variable: `RFMEDIA_PLEX_AUTH_DIR`.
- No new MCP argument, no new queue field, and no new `CopyOptions` field — nothing
  credential-shaped is serialized to disk outside the credential store.

An install that never runs `rfmedia plex auth login` sees no behavior change whatsoever: with no
store file on disk the resolver is byte-identical to the pre-#251 gate. Rolling back is one config
key; see [plex-configuration.md](plex-configuration.md).
