# Pattern & Code Analysis: lidarr-similar-artist-discovery

## Executive Summary

Issue #203 fits the existing command → action → scheduler → private boundary structure, with one
important split: ordinary discovery must resolve only Last.fm configuration and the shared
`discovery` lane, while `--add` may resolve Lidarr only after a complete discovery result and one
valid visible rank exist. The closest read precedent is Lidarr search; the closest mutation
precedent is the strict v2 operation registry plus the non-deferable, reconciled artist-delete
apply path.

Implementation should add one Last.fm-specific transport owner, one immutable discovery action,
and one exact `artist-add` plan operation. It should not add provider registries, provider caching,
direct mutation from `discover`, or a second apply engine.

## Implementation Patterns

- **Thin command factory:** Mirror
  `packages/rfmedia-cli/src/commands/lidarr-search.ts` in a new
  `packages/rfmedia-cli/src/commands/lidarr-discover.ts`. Commander owns argument parsing, option
  relationships, lazy action/formatter imports, human stderr presentation, and machine stdout.
  Register the returned leaf in `packages/rfmedia-cli/src/commands/lidarr.ts`.
- **Validate before dependency resolution:** Reuse the exact term policy in
  `packages/rfmedia-cli/src/lib/lidarr/search.ts`: outer trim, NFC normalization, C0/C1/DEL/bidi
  rejection, 256-code-point bound, and 1,024-byte UTF-8 bound. Validate `limit`, `--add`, option
  combinations, and plan path before resolving the scheduler, Last.fm key, or Lidarr client.
- **Last.fm-specific private boundary:** Put the only provider `fetch` call in
  `packages/rfmedia-cli/src/lib/discovery/lastfm.ts`. Follow the hardened mechanics in
  `packages/rfmedia-cli/src/lib/lidarr/transport.ts`: fixed origin, `redirect: "error"`, composed
  caller abort plus timeout, bounded streaming reads, fatal UTF-8, sanitized typed errors, and
  guaranteed cleanup. Unlike the Lidarr transport, the provider key is injected into a fixed
  query parameter and no full `URL`, `Request`, raw body, or cause may cross the boundary.
- **Strict atomic projection:** Follow `packages/rfmedia-cli/src/lib/lidarr/types.ts`: accept
  `unknown`, bound the complete collection/body, validate every member before returning anything,
  copy only allowlisted fields into fresh frozen objects, omit absent optionals with conditional
  spreads, and reject duplicate/invalid identity data atomically.
- **Pure deterministic shaping:** Keep seed removal, canonical lowercase MBID validation,
  conservative fallback identity, first-win dedupe, provider-order preservation, similarity
  validation, and contiguous rank assignment in a pure helper colocated with the Last.fm boundary
  or action. The pattern is `rankLidarrSearchCandidates()` in
  `packages/rfmedia-cli/src/lib/lidarr/search.ts`, but discovery has no paging or cache.
- **Scheduler-owned provider retry:** Submit one `idempotent: true` task to the existing
  `discovery` lane in `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`. That lane has independent
  concurrency/budget/retry policy and requires no Lidarr health preflight
  (`packages/rfmedia-cli/src/lib/lidarr/tiers.ts`). The Last.fm client performs no retry loop.
- **Structural scheduled-error seam:** Generalize `classifyFailure()`, `shouldRetry()`, and
  `retryDelayMs()` in `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts` to read a narrow safe
  structure (`code`, `retryable`, optional status/retry-after) rather than requiring
  `instanceof LidarrError`. Add `discovery-provider-unavailable` only to scheduler failure
  metadata; do not add it to `LidarrErrorCode`, feed Lidarr circuits, or make it deferable.
- **Attributed output in every format:** Mirror the fixed summary-plus-candidate CSV shape in
  `packages/rfmedia-cli/src/commands/lidarr-search.ts`. Always emit one summary row, including for
  zero recommendations; recommendation rows carry rank and candidate data. Route CSV through
  `packages/rfmedia-cli/src/lib/formatters/index.ts` so formula-looking cells are neutralized.
- **One sealed add handoff:** `packages/rfmedia-cli/src/actions/lidarr/discover.ts` should return
  the complete successful discovery result, then call
  `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts` only when `--add` is present. That
  producer resolves the selected visible rank, requires an MBID, performs fresh exact Lidarr
  identity/resource reads, returns an already-present no-op when applicable, or writes one plan
  through `writeLidarrPlanArtifact()`.
- **Registry-owned mutation behavior:** Extend
  `packages/rfmedia-cli/src/types/lidarr-plan.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts` with one exact
  `artist-add` operation. Its definition owns canonicalization, risk, referenced resources,
  expected absence, desired state, stable idempotency material, preflight classification,
  dispatch, and verification. Mark it non-deferable and scheduler-non-idempotent.
- **Hardened plan persistence:** Reuse v2 canonical JSON, SHA-256 checksum, target-origin binding,
  private mode, no-follow open, no-overwrite link, history, claim, and resume handling from
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`. Keep the v2 discriminator; extend its exact
  allowlists and correlation checks rather than accepting arbitrary keys.
- **Generated client remains private:** Add root-folder read and artist-create facade methods only
  in `packages/rfmedia-cli/src/lib/lidarr/client.ts`. Consume existing generated
  `getApiV1Rootfolder` and `postApiV1Artist`; construct `ArtistResourceWritable` privately from an
  authoritative exact Lidarr lookup plus the sealed policy. Do not edit generated files or expose
  generated DTOs above the facade.

## Existing Code Structure

- `packages/rfmedia-cli/src/commands/lidarr.ts`: parent command, shared failure redaction,
  execution summary, child registration order, plan/apply approval, and output gate.
- `packages/rfmedia-cli/src/commands/lidarr-search.ts`: closest command factory, fixed CSV schema,
  empty-result summary, lazy imports, and stderr table precedent.
- `packages/rfmedia-cli/src/actions/lidarr/search.ts`: closest scheduled read action; validates
  before I/O, returns immutable execution metadata, and keeps presentation out of the action.
- `packages/rfmedia-cli/src/lib/lidarr/search.ts`: pure Unicode normalization, bounds,
  first-win ranking, and immutable shaping.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: shared lane limiters, cancellation,
  retry/backoff, safe execution metadata, and `runSingle()` error attachment.
- `packages/rfmedia-cli/src/lib/lidarr/tiers.ts`: declares `discovery` as ungated and independent
  of Lidarr metadata health.
- `packages/rfmedia-cli/src/types/config.ts`, `packages/rfmedia-cli/src/lib/config.ts`, and
  `packages/rfmedia-cli/src/lib/loaded-config.ts`: config schema, template-resolved validation,
  recursive sensitive-field redaction, and process-wide loaded config access.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: stable generated-client facade; the only
  handwritten generated-operation importer.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: complete bounded projections for artists,
  profiles, tags, and search records. Add the generated-independent root-folder projector here.
- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`: already contains
  `getApiV1Rootfolder` and `postApiV1Artist`; generated source is read-only.
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`: exact ID-or-name profile resolution,
  ambiguity errors, deterministic resource choices, and positive-ID validation.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`: closest fresh resource
  resolution → strict v2 plan → atomic artifact-write producer.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: v1/v2 operation, entry, summary, observed-state,
  history, failure, and apply-result unions.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: operation behavior registry
  and exact deferable/non-deferable split.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: exact-key parsing, deterministic sealing,
  secure artifact I/O, history/resume, and exclusive claims.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`,
  `apply-entry-execution.ts`, `apply-artist-entry-execution.ts`, and
  `apply-target-types.ts`: whole-plan preflight, just-in-time target classification,
  non-idempotent dispatch, bounded reconciliation, uncertainty, and stop-admission behavior.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: architecture scanner for generated
  boundaries, handwritten API paths, mutation ownership, and exact Fetch owners.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` and
  `templates.spec.ts`: hand-maintained shell trees and exact cross-shell parity contract.

## Code Conventions

- Use strict ESM TypeScript with local `.js` specifiers, `import type`, readonly interfaces,
  discriminated unions, exhaustive switches, `satisfies`, and fresh `Object.freeze()` projections.
- Keep generated models private. Public discovery types belong in
  `packages/rfmedia-cli/src/types/discovery.ts`; Lidarr add/resource projections belong in
  `packages/rfmedia-cli/src/types/lidarr.ts`.
- Omit absent optional fields rather than emitting `undefined`/`null`. This matters for machine
  schemas, exact-key plan validation, canonical checksums, and minimal create bodies.
- Preserve provider order. Never sort recommendations by name, MBID, or similarity, and never
  relabel Last.fm similarity as confidence or eligibility.
- Keep human output on stderr and JSON/YAML/CSV on stdout through `formatOutput()`. Attribution and
  execution metadata are required even for empty success.
- Duplicate semantic validation at action/facade boundaries; Commander validation alone is not
  sufficient because tests and embedders call actions directly.
- Use explicit resource references containing stable ID plus review label/path. Resolve missing or
  ambiguous root/profile references before writing any plan.
- Use one request per ordinary discovery invocation. No provider cache, stale fallback,
  preliminary search/info call, artwork projection, or provider-returned URL fetch is permitted.
- In tests, use Vitest hoisted mocks and `vi.clearAllMocks()`, not `resetAllMocks()`, matching
  `packages/rfmedia-cli/src/commands/lidarr.test.ts`.

## Integration Points

1. **Configuration and provider boundary**
   - Add `discovery.lastfm.apiKey` and optional `timeoutMs` in
     `packages/rfmedia-cli/src/types/config.ts` and `packages/rfmedia-cli/src/lib/config.ts`.
   - Add a loaded-discovery accessor or use `getLoadedConfig()` without touching the Lidarr
     resolver; missing Last.fm configuration must fail without Lidarr resolution.
   - Add `packages/rfmedia-cli/src/lib/discovery/lastfm.ts` and focused critical tests for fixed
     origin/redirect rejection, key redaction, cancellation/timeout, body bounds, provider logical
     errors in HTTP 200, 429/Retry-After, invalid UTF-8/JSON, strict URL/MBID/similarity projection,
     and empty success.
2. **Read-only action and command**
   - Add discovery types, action export in
     `packages/rfmedia-cli/src/actions/lidarr/index.ts`, command registration, presenter, and fixed
     CSV columns.
   - Critical action tests should prove pre-I/O validation, exactly one provider request, zero
     Lidarr calls without `--add`, stable dedupe/rank, attribution on empty output, cancellation,
     and scheduler execution metadata.
   - Critical command tests should prove exact options/forwarding, no `--yes`, structured
     JSON/YAML/CSV, safe failure redaction, and successful discovery retained when add handoff
     fails.
3. **Scheduler**
   - Extend the structural classifier and discovery retry allowlist while preserving existing
     Lidarr exhaustiveness.
   - Critical scheduler tests should prove discovery-provider retry only for idempotent discovery
     work, safe Retry-After handling, no retry on auth/config/invalid response/cancel, and no
     Lidarr circuit/preflight involvement.
4. **Lidarr facade and add planning**
   - Add `LidarrRootFolder`, `LidarrArtistAddInput`, `listRootFolders()`, and `addArtist()` plus
     strict projectors and defaults in
     `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`.
   - Reuse `resolveLidarrProfileReference()` for quality/metadata profiles; add an equally exact
     root-folder resolver keyed by ID/path with missing/ambiguous failure.
   - Pin existing root-folder GET and artist POST operations in
     `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts` and generator requirement
     assertions. Critical facade tests should prove the exact minimal body, fixed conservative
     policy, abort forwarding, authoritative lookup correlation, and sanitized ambiguous dispatch.
5. **Plan/apply**
   - Extend all v2 kind-first surfaces: operation/entry/selection/summary types, definition
     overloads, canonicalization, exact parsing, risk/summary/idempotency correlation, observed
     state, history, resume, presenter labels, and apply sorting/identity.
   - Add an expected-absence foreign-ID target rather than synthesizing a numeric artist ID.
     Preflight and just-in-time admission read by exact MBID: present is satisfied, absent is ready,
     conflicting identity is drift.
   - Persist possible-dispatch evidence before POST, reconcile afterward by fresh exact MBID read,
     record verified presence as success, and mark unresolved presence as uncertain. Never retry,
     defer, or blindly resume the POST.
   - Critical tests should cover sealed round-trip/tamper rejection, already-present no-op,
     apply-time absence/presence drift, exact policy body, lost-response reconciliation,
     unresolved uncertainty stopping admission, history/claim failure, and no deferred executor.
6. **Architecture, completions, and docs**
   - Add the Last.fm module as a distinct exactly-one Fetch owner in
     `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`; add scanner fixtures proving
     upper-layer or second provider Fetch sites fail.
   - Update Bash, Zsh, and Fish with identical `discover` options and extend the existing exact
     parity test. Completion generation must remain static and perform no config/client/network
     work.
   - Update `rfmedia.example.yaml`, package README/CHANGELOG, feature docs, ROADMAP/archive, and
     release-time Last.fm terms documentation.

## Gotchas and Warnings

- `buildLidarrMutationPlanV2()` currently sorts and deduplicates solely by numeric `artistId`.
  `artist-add` has an expected-absent MusicBrainz target and must receive an explicit foreign-ID
  branch; do not invent `artistId: 0` or weaken positive-ID checks for existing operations.
- Current artist apply reads use `getArtist(artistId)`. Initial absence is treated as stale except
  for history-attributed deletion. Artist-add needs operation-owned MBID presence semantics:
  initial absence is ready, exact presence is satisfied, and possibly dispatched POST must be
  reconciled without resending.
- Current non-deferable typing is hard-coded to `"artist-delete"`. Widen it explicitly to include
  `"artist-add"` and keep `createLidarrMutationExecutors()` unchanged; an add must never enter the
  deferred queue.
- The shared scheduler recognizes retryable failures only through `instanceof LidarrError`.
  Making Last.fm errors extend `LidarrError` would corrupt the Lidarr taxonomy and circuit meaning;
  use the narrow structural contract required by the feature.
- The current architecture scanner allows only Plex and Lidarr transport Fetch owners and reports
  other Fetch sites under the legacy `plex-fetch-owner` rule. It must be extended before the new
  Last.fm transport can pass the real-tree architecture gate.
- `getApiV1Artist` supports an `mbId` query in generated code, but `listArtists()` currently
  exposes only an unfiltered full-library read. Keep all handwritten paths out of upper layers and
  add only the narrow facade behavior the plan/apply contract needs.
- Generated `ArtistResourceWritable` is broad and optional. Never spread a Last.fm recommendation
  or public discovery result into it; authoritative Lidarr lookup data and the sealed explicit
  policy are the only create inputs.
- A Last.fm HTTP 200 can still be an API error. Parse the provider error envelope before treating
  a missing/empty `similarartists.artist` member as successful empty output.
- Last.fm catalogue URLs are untrusted data despite being output-only. Require the approved HTTPS
  origin/path shape and reject credentials, query secrets, redirects, and off-origin URLs for the
  complete response.
- Do not reuse Lidarr search caching. Issue #203 explicitly has no provider cache or
  `--allow-stale`; rank is invocation-local and must not become a durable identity.
- `discover --add` must preserve the successful discovery result when Lidarr handoff fails.
  Machine output needs a distinct handoff failure rather than converting the provider success into
  an empty or generic discovery failure.
- Keep testing contract-focused. The required minimum is provider trust-boundary behavior,
  zero-Lidarr read-only execution, deterministic ranking/attribution, one sealed add, no direct
  mutation, non-retry/non-defer reconciliation, architecture ownership, generated endpoint pins,
  and three-shell parity; avoid duplicating broad existing plan/apply matrices.
