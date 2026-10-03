# Code Analysis: 199-lidarr-artist-bulk-management

## Executive Summary

Issue #199 is an extension of the existing sealed Lidarr plan/apply subsystem, not a standalone
bulk-edit command. The implementation should add two plan producers (`artist-profiles` and
`artist-tags`), move all new plans plus the current monitoring producer to a strict version 2
artifact, and keep `lidarr apply` as the only remote-write path. Existing version 1 monitoring
plans, checksums, history, and resume behavior must remain unchanged.

The repository already has the important safety boundaries: a generated-client facade, a single
authenticated Fetch owner, fresh planning reads, strict artifact parsing, checksum sealing, private
atomic storage, exclusive claims, per-entry history, deferred intents, and exact resume matching.
The principal implementation gap is post-dispatch reconciliation. Current apply calls the editor
and records success immediately; issue #199 requires a targeted artist read after every accepted
write, operation-specific verification, and an uncertain outcome that stops later admissions when
the result cannot be established.

## Existing Code Structure

### Command and action layers

- `packages/rfmedia-cli/src/commands/lidarr.ts` owns Commander grammar, option parsing, lazy action
  imports, text rendering, machine envelopes, interactive review/approval, and exit status.
  Mutation-specific code begins near the `renderMutationPlan`, `renderMutationApply`, `plan`, and
  `apply` declarations.
- `packages/rfmedia-cli/src/commands/lidarr.test.ts` mocks the action barrel with `vi.hoisted()`.
  Its existing v1 plan fixtures, interactive dry-run-before-confirm flow, option forwarding,
  machine-output behavior, and partial/failed exit-code tests are the command regression surface.
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts` is the current monitoring producer. It resolves
  the canonical origin, creates a no-retry resilient client, fetches the complete artist list,
  rejects unknown requested IDs, builds the sealed plan, and writes it only after successful
  construction.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts` owns plan identity checks, origin binding,
  global/caller cancellation, dry-run, claim acquisition, history, whole-plan preflight, immediate
  per-entry checks, deferred replay, sequential mutation admission, durable outcomes, and resume.
- `packages/rfmedia-cli/src/actions/lidarr/list.ts` contains reusable predicate semantics only:
  filter families combine with AND and repeated tags use all-of matching. Its offset/limit slicing
  and optional stale cache are explicitly unsuitable for mutation selection.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts` is the lazy-import barrel and must export the two
  new plan actions and their option types.

### Stable Lidarr client boundary

- `packages/rfmedia-cli/src/types/lidarr.ts` defines generated-independent public domain
  projections. `LidarrArtist` already contains `qualityProfileId`, `metadataProfileId`, and
  `tags`, so the new profile/tag types belong here rather than in generated code.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts` validates unknown wire values and returns fresh,
  frozen domain objects. Existing numeric checks accept any finite number and preserve tag order;
  issue #199 needs stricter positive-safe-integer, count, label, control-character, uniqueness, and
  sorted-tag validation at this boundary.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts` is the sole permitted generated-operation
  importer. It owns operation context, allowlisted editor request construction, generated result
  unwrapping, abort handling, status classification, and strict projection.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts` is the sole authenticated production Fetch
  owner. The new feature must not add Fetch, origin handling, credentials, or handwritten API paths
  anywhere else.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts` explicitly delegates every
  `LidarrClientApi` method. Read retry is deny-by-default through
  `LIDARR_IN_PLACE_RETRY_ALLOWLIST`; mutation methods must remain outside that allowlist and outside
  stale-cache fallback.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts` resolves connection overrides, canonical origin,
  scheduler, base client, and resilience wrapper. New actions should continue using
  `resolveRequiredLidarrClient(..., { tier: "local-only", retryAttemptsOverride: 0 })`.

### Plan, apply, and recovery core

- `packages/rfmedia-cli/src/types/lidarr-plan.ts` currently defines only
  `rfmedia.lidarr-plan.v1`, artist-monitoring operations/entries, staleness, history, apply
  outcomes, and generation results.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` owns:
  - the operation definition registry;
  - canonical operation/entry/checksum construction;
  - exact untrusted JSON validation;
  - private `0700` directories and `0600` files;
  - bounded, no-follow, identity-checked reads and atomic no-overwrite writes;
  - compacted per-plan JSONL history;
  - resume selection;
  - exclusive claim files.
- The current `LidarrMutationOperationDefinition` centralizes risk, canonicalization,
  classification, idempotency, execution, deferred payload validation, and queued-intent matching.
  It is the correct ownership model, but its monitoring-specific method signatures must become
  discriminated and operation-neutral for v2.
- `packages/rfmedia-cli/src/lib/lidarr/deferred-queue.ts` already stores a credential-free
  operation string, canonical payload, tier, origin, and exact idempotency key in schema-v10
  `lidarr_deferred_intents`. No database migration is needed.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts` supplies the shared `local-only` lane,
  cancellation, attempts, and execution metadata. Planning, targeted reads, editor writes, and
  verification should remain in this lane.

### Generated and executable-policy boundaries

- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts` already contains
  `getApiV1ArtistById`, `getApiV1Qualityprofile`, `getApiV1Metadataprofile`, `getApiV1Tag`, and
  `putApiV1ArtistEditor`.
- The generated `ArtistEditorResource` also exposes dangerous unrelated fields such as
  `rootFolderPath`, `moveFiles`, `deleteFiles`, and `addImportListExclusion`. Callers must never
  receive or construct this broad type; the facade must build minimal intent-specific bodies.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` currently requires only the baseline
  artist/health/status/wanted operations and paths. Its offline required-operation contract must
  be extended for the targeted artist, resource-list, and editor operations without refreshing the
  committed OpenAPI snapshot.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` enforces generated-module privacy,
  rejects handwritten `/api/v1/` literals, and enforces exactly one authenticated Fetch site.
  It needs an additional rule that confines profile/tag editor methods to registered mutation
  owners and/or rejects unsafe editor field construction outside `client.ts`.
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json` pins Lidarr commit
  `3e2858439ff35b372d0af00bcea1b0a357572d26`, snapshot SHA-256, generator
  `@hey-api/openapi-ts@0.93.0`, and bundled Fetch runtime provenance. Normal work uses this
  committed snapshot; only `openapi:lidarr:refresh` contacts upstream.

## Implementation Patterns

### Strict version dispatch

Keep the existing v1 types, parser, canonical key order, checksum function, and monitoring
operation definition behavior byte-for-byte stable. Add a distinct
`LIDARR_PLAN_VERSION_V2 = "rfmedia.lidarr-plan.v2"` plus a
`LidarrMutationPlan = LidarrMutationPlanV1 | LidarrMutationPlanV2` union. Artifact reading must
inspect only the version discriminator and dispatch to an exact v1 or v2 validator; unknown
versions must fail.

V2 should be a strict operation-discriminated union:

- `artist-monitoring`;
- `artist-profile-assignment`;
- `artist-tag-mutation`.

V2 adds a canonical selection object and operation-specific entries. Do not make v2 a loose object
with many optional fields. Pair each operation with exactly its allowed entry shape and risk;
reject inconsistent operation/entry/risk combinations before checksum verification.

All current producers should write v2 after this change, including artist monitoring. V1 remains a
read/apply/history/resume compatibility path and must not be rewritten or normalized through v2.

### Pure complete-cohort selection

Create a focused pure module, recommended as
`packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`, with a co-located
`artist-selection.test.ts`. It should own:

- exactly-one selection mode validation (`ids`, filters, or `all`);
- positive unique ID normalization;
- reference parsing (`decimal` means ID, `name:` forces name, otherwise exact normalized name);
- unknown/ambiguous reference diagnostics with bounded `name (id)` choices;
- AND across predicate families and all-of repeated tag filters;
- deterministic artist sorting by numeric ID;
- full-cohort zero-match and cap validation without truncation;
- sorted unique tag-set algebra and added/removed/retained deltas.

Planning must use one fresh complete `listArtists()` result and fresh complete resource lists.
Resolve the complete cohort, then enforce `maxBatch` (default 25, maximum 1,000). Never reuse
`list.ts` paging, `limit`, `offset`, or `allowStale`; never interpret missing selectors as `--all`.
An all-no-op non-empty cohort remains a valid auditable plan.

### Intent-bearing client facade

Extend `LidarrClientApi` with narrow methods, not generic request functions:

- `getArtist(artistId, signal?)`;
- `listQualityProfiles(signal?)`;
- `listMetadataProfiles(signal?)`;
- `listTags(signal?)`;
- one-artist profile assignment with only the requested profile dimensions;
- one-artist tag mutation with `mode` plus normalized tag IDs.

Add stable immutable `LidarrProfile { id, name }` and `LidarrTag { id, label }` types. The facade
should validate one positive artist ID per mutation, construct `artistIds: [id]`, and allowlist
only:

- `qualityProfileId` and/or `metadataProfileId` for profile assignment;
- `tags` and explicit `applyTags` for tag mutation.

Map tag modes as `add -> add`, `remove -> remove`, and `set`/`clear -> replace`; clear must send
`tags: []`. Never pass a generated `ArtistEditorResource` from upper layers. Successful empty-body
or unknown-body 2xx responses, including observed 202, should be accepted by the facade and then
verified independently.

### Operation-owned plan/apply semantics

Generalize `LidarrMutationOperationDefinition` so each definition owns:

- canonical operation and state;
- risk/cascade facts;
- entry construction/change detection;
- idempotency key material;
- live classification and operation-specific stale details;
- resource dependencies and preflight validation;
- minimal execution;
- postcondition verification;
- deferred operation name, exact payload validation, replay, and matching.

Use exact executor identities and credential-free payloads:

- `lidarr.artist-profile-assignment` with
  `{ artistId, qualityProfileId?, metadataProfileId? }`;
- `lidarr.artist-tag-mutation` with `{ artistId, mode, tagIds }`.

Profile classification examines only managed fields. Desired values are `satisfied`; reviewed
before or desired values with work remaining are `ready`; any managed field at a third value is
`drifted`. This deliberately permits partial convergence when a profile plan manages both
dimensions.

Tag classification is mode-specific. Add is satisfied when all requested tags exist and remove
when none exist; unrelated tag changes are tolerated. Set and clear require the exact desired set,
are ready only at the exact reviewed-before set, and drift on every third set. Every tag array must
be sorted and unique in entries, checksums, payloads, comparisons, output, and verification.

### Durable per-target apply

Preserve the current lifecycle order but make these changes:

1. Read and validate v1/v2, checksum, expected identity, and origin.
2. Resolve all desired resource IDs fresh before any write. Missing resources block the entire
   run; same-ID renames update display context and warn but do not redirect intent.
3. Fetch one complete fresh artist snapshot and classify every pending entry before any write.
4. Return dry-run before claim acquisition, history writes, deferred writes, or mutation.
5. Acquire the exclusive claim for real apply.
6. Immediately before each admission, call targeted `getArtist(id)`, not `listArtists()`.
7. Send one minimal editor request for one artist.
8. Call targeted `getArtist(id)` again and verify the operation-owned postcondition.
9. Persist the authoritative result synchronously before admitting the next artist.

Current `classifyLiveTarget()` calls `listArtists()` for every target, and current
`executeMutations()` records success immediately after the editor call. Both must change. A
timeout, cancellation, transport failure, malformed verification response, or failed postcondition
after dispatch is not automatically a definite failure and must not be blindly deferred. Reconcile
with bounded targeted reads; if still unresolved, record `uncertain`, stop later admissions, and
require explicit resume. Retryable failures known to occur before dispatch may still enqueue exact
deferred intent.

Resume must continue to exact-match origin, operation, normalized payload, and idempotency key, then
read live state before deciding whether to replay. New history/apply result types should retain
before, desired after, and observed evidence when available so the command can explain verified,
stale, failed, and uncertain outcomes.

### Rendering and approval

Make plan/apply rendering operation-aware rather than hard-coded to monitoring. Human previews
show at most 20 entries unless global `--verbose` is active, while artifacts and JSON/YAML/CSV keep
the full bounded cohort. Profile rows need requested old/new profile names and IDs. Tag rows need
full before/after plus added/removed/retained sets, with removed assignments emphasized for set and
clear.

Keep exactly one machine document on stdout; human review, warnings, and progress stay on stderr.
CSV projection must neutralize formula-leading untrusted text through the existing formatter
contract rather than embedding unsafe raw values.

Interactive apply must retain the current live dry-run before a default-no confirmation and pin
the reviewed plan ID/checksum for the real call. Non-interactive and machine-output apply require
`--yes`. High-risk set/clear plans additionally require `--allow-tag-replacement`; this
authorization is purpose-specific and cannot be replaced by the generic confirmation alone.

## Integration Points

### Files to create

- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`: pure selectors, reference resolution,
  complete-cohort validation, deterministic sorting, and tag algebra.
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.test.ts`: table-driven selector,
  ambiguity, numeric-name, all-of, cap, zero-match, ordering, and tag-mode tests.
- `packages/rfmedia-cli/src/actions/lidarr/plan-profiles.ts`: fresh artists/profile resources,
  selection, profile entry construction, sealed artifact write; no remote write.
- `packages/rfmedia-cli/src/actions/lidarr/plan-profiles.test.ts`: forwarding, missing/ambiguous
  resources, no-op, cap, artifact, and zero-mutation tests.
- `packages/rfmedia-cli/src/actions/lidarr/plan-tags.ts`: fresh artists/tags, selection, tag entry
  construction, sealed artifact write; no remote write.
- `packages/rfmedia-cli/src/actions/lidarr/plan-tags.test.ts`: all four modes, deltas, no-op,
  replacement safety, cap, artifact, and zero-mutation tests.

If operation definitions make `plan-engine.ts` unwieldy, a private
`packages/rfmedia-cli/src/lib/lidarr/mutation-operations.ts` plus tests is an acceptable extraction,
provided `plan-engine.ts` remains the registry/version/artifact owner and no generated code leaks
into it.

### Files to modify

- `packages/rfmedia-cli/src/types/lidarr.ts`: `LidarrProfile`, `LidarrTag`, and any narrow
  intent types shared by the facade and actions.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: immutable v1 plus strict v2 operation,
  selection, entry, observed-result, stale, and generation unions.
- `packages/rfmedia-cli/src/types/index.ts`: export the new stable types if this barrel currently
  exports the Lidarr type surface.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: strict profile/tag/targeted-artist projectors,
  safe labels, positive IDs, response bounds, and normalized tags.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: generated imports, new facade methods, minimal
  editor bodies, targeted read, and 2xx/empty-body handling.
- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`: exact generated operation/body, dangerous
  field absence, 202/empty response, abort, malformed resource, bounds, and credential-isolation
  tests.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`: explicit delegation for every new
  method; safe reads deliberately classified; mutations proven non-retrying and non-cacheable.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`: typed defaults for every
  new `LidarrClientApi` member.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-fixtures.ts`: profile/tag fixtures and
  normalized artist-tag/profile variants.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`: strict version dispatch, v2 registry,
  canonicalization, checksums, validators, operation invariants, payloads, history, and exact v1
  compatibility fixtures.
- `packages/rfmedia-cli/src/actions/lidarr/plan.ts` and its tests: make monitoring emit v2 without
  changing its existing command behavior.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts` and its tests: generic preflight,
  targeted checks, resource validation, post-write verification, observed evidence, uncertainty,
  admission stop, and exact resume.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`: export the two new plan producers.
- `packages/rfmedia-cli/src/commands/lidarr.ts` and its tests: both leaves, selector/reference/tag
  parsers, conflicts, operation-aware rendering, 20-row text limit, replacement authorization,
  machine parity, approval, and exits.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: add both plan operations and exact
  options/value candidates.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: assert hierarchy, all shared
  selectors, profile/tag flags, cap values, plan paths, and apply replacement authorization across
  all three shells.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` and its test: require all used
  generated operations/paths offline.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` and its test: enforce mutation-owner
  and safe-body boundaries in addition to existing generated-import/path/Fetch rules.
- `packages/rfmedia-cli/README.md`,
  `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`,
  `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`,
  `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`, and
  `packages/rfmedia-cli/CHANGELOG.md`: operator workflow, risk, recovery, v1 compatibility, facade,
  and lane behavior.
- `ROADMAP.md` and `docs/roadmap-archive.md`: update only with verified issue/PR lifecycle evidence.

## Code Conventions

- TypeScript is ESM/NodeNext; every relative import uses a `.js` extension.
- Do not use `any`. The package enables `noUncheckedIndexedAccess`; narrow array lookups and map
  reads explicitly.
- Prefer strict discriminated unions and exhaustive `never` checks over optional-field bags.
- Exported functions and types require concise JSDoc consistent with adjacent Lidarr modules.
- Actions return typed data and do not print. Commands own formatting, approval, and
  `process.exitCode`.
- Lazy-import action handlers from commands to preserve CLI startup behavior.
- Use `readonly`, fresh copied values, `Object.freeze`, sorted arrays, and deterministic map/set
  projection at trust and checksum boundaries.
- Throw typed validation/artifact/stale errors early. Continue per-target only when the outcome is
  authoritative; stop admission for drift, lost claim, cancellation after dispatch, uncertain
  mutation, or failed durable persistence.
- Use `vi.hoisted()` for module mocks and `vi.clearAllMocks()` in `beforeEach()`; do not use
  `vi.resetAllMocks()` where hoisted implementations must survive.
- Action tests should mock only the typed `LidarrClientApi`/resolver seams. Client tests own
  generated request assertions; pure selection tests own combinatorial semantics; apply tests own
  lifecycle transitions.
- Update Bash, Zsh, and Fish together. Completion parity is a tested contract, not generated from
  Commander automatically.
- Markdown must satisfy repository formatting and markdownlint rules, including blank lines around
  headings.

## Dependencies and Services

- No new runtime or development dependency is required.
- Commander v14 remains the CLI grammar and conflict/mandatory-option layer.
- Existing formatters and `console-table-printer` remain the text/machine rendering layer.
- The generated client remains pinned to `@hey-api/openapi-ts@0.93.0` and the committed Lidarr
  OpenAPI snapshot. Do not refresh the snapshot during ordinary implementation.
- Node Fetch remains reachable only through `src/lib/lidarr/transport.ts`.
- The scheduler and resilience layers own attempts, cancellation, breaker feeds, and retry policy.
  Mutations are never in-place retried by the resilience wrapper.
- Existing SQLite schema-v10 `lidarr_deferred_intents` stores new exact operation/payload records;
  no migration is expected.
- Plan files, compacted JSONL history, and claim files remain private filesystem state, not
  database tables.
- Relevant validation commands include:
  - `npm run test:run --workspace packages/rfmedia-cli`;
  - `npm run typecheck --workspace packages/rfmedia-cli`;
  - `npm run build --workspace packages/rfmedia-cli`;
  - `npm run codegen:lidarr:check --workspace packages/rfmedia-cli`;
  - `npm run test:codegen:lidarr --workspace packages/rfmedia-cli`;
  - `npm run check:architecture --workspace packages/rfmedia-cli`;
  - `npm run test:architecture --workspace packages/rfmedia-cli`.

## Gotchas and Warnings

- Do not modify the v1 checksum representation. Reusing a renamed “current version” constant inside
  v1 canonicalization would silently change old bytes or reject valid reviewed artifacts.
- Do not make the v2 validator permissive. Unknown, prototype, and recursively sensitive keys must
  fail before values cross the artifact boundary.
- Current artist validation accepts finite fractional/negative IDs and unsorted duplicate tag IDs.
  Profile/tag mutation authority requires positive safe integers, bounded response counts, and
  normalized unique tags.
- `getApiV1ArtistById` and the resource/editor operations already exist in generated output, but
  the offline required-operation list does not currently protect them from future drift.
- Generated editor types expose destructive fields. Type reuse alone is not a security boundary;
  construct separate allowlisted bodies inside `client.ts` and test the exact serialized object.
- Current `#executeVoid` expects a generated envelope with a `data` key. Confirm the generated
  client's behavior for 202 and empty bodies; the facade must accept successful 2xx without
  requiring a meaningful editor body.
- Do not add new generated imports to actions, commands, plan engine, or selection helpers. The
  architecture audit permits only `src/lib/lidarr/client.ts`.
- Do not put resource reads into stale-cache fallback. Stale profiles/tags or a stale artist list
  cannot authorize mutation.
- `list.ts` filters are semantically useful but its slice happens after filtering and its action
  may serve stale data. Copy the pure predicate rules; do not call the list action.
- Enforce the cap after full matching. Early stopping at 25 would conceal a selector that actually
  targets a larger cohort.
- Numeric resource labels are ambiguous by design: bare decimal selects an ID and `name:<value>`
  is required to select a numeric name.
- Unknown or ambiguous resources must fail; never choose the first case-insensitive match and never
  create a missing tag.
- Profile fields cannot be “cleared” through `0`, `null`, or omission. A profile plan manages at
  least one concrete existing profile.
- Empty tag input never means clear. Clear is only `--clear-tags` and maps to explicit replacement
  with an empty array.
- Add/remove tolerate unrelated live tag changes; set/clear do not. A single generic equality
  classifier would either overwrite drift or incorrectly block safe delta operations.
- Current immediate checks call the full artist list once per target, producing severe request
  amplification at the 1,000 cap. Use the generated targeted artist endpoint.
- Current apply treats a returned editor call as success without postcondition verification. This
  is insufficient because the OpenAPI response and observed 202 behavior do not prove persistence.
- A post-dispatch timeout or abort may follow a committed mutation. Do not enqueue and replay it as
  if it were a known pre-write failure; reconcile first, then mark uncertain and stop if unresolved.
- Persist verified state before the next artist. If history persistence fails after remote success,
  preserve the current uncertain/stop behavior.
- A resource rename preserves stable-ID intent; warn and show the current name. A resource deletion
  invalidates intent and blocks every write in initial preflight.
- Interactive review must pin both plan ID and checksum between dry-run and real apply. Set/clear
  also need `--allow-tag-replacement`, including when `--yes` is present.
- Human preview truncation applies only to display. Never truncate the plan or machine output.
- API keys, auth headers, raw generated responses, credential-bearing URLs, host control
  characters, and terminal/bidirectional formatting characters must not enter artifacts, history,
  deferred payloads, or output.
- Existing production dependency advisories are orthogonal to this feature; do not mix dependency
  upgrades into issue #199.

## Task-Specific Guidance

1. First freeze v1 compatibility with fixture-based byte/checksum/read/apply/resume tests, then add
   v2 types and strict version dispatch.
2. In parallel, add stable resource types/projectors and the narrow client facade. Test exact
   generated operations and editor bodies before any action depends on them.
3. Add the pure selection module and exhaust its edge cases: conflicting modes, unknown IDs, zero
   matches, ambiguity, numeric names, repeated-tag all-of, deterministic ordering, full-cohort cap,
   and every tag algebra mode.
4. Register profile/tag operation definitions and build the two plan producers. Move monitoring
   output to v2 only after the v1 reader remains proven unchanged.
5. Generalize apply around operation-owned classification/resource/verification behavior. Replace
   per-target full-list reads with `getArtist(id)` and add post-write reconciliation before durable
   success.
6. Add command leaves and rendering only after action/result shapes stabilize. Preserve one
   machine document, dry-run-before-confirm, ID/checksum pinning, and purpose-specific tag
   replacement authorization.
7. Update all three completions and the parity test in the same change.
8. Extend offline codegen and architecture gates last enough to describe the final ownership
   surface, but run them throughout implementation to prevent boundary drift.
9. Validate focused pure/client/plan/apply/command tests first, then the full package typecheck,
   test, build, offline codegen, architecture, format, lint, and packaging gates.

The safest implementation order is therefore: immutable v1 and v2 contracts; facade/projection;
pure selection; operation definitions and plan producers; verified generic apply; CLI/rendering;
completions and executable policy; documentation and full regression validation.
