# Code Analysis: Lidarr Quality Preset Packs

## Executive Summary

Issue #213 fits the existing one-way rfmedia layering but needs a new desired-state family rather
than another `rfmedia.lidarr-plan.v2` operation. The implementation should add a dependency-injected
Commander subtree, framework-independent orchestration actions, a pure preset resolver/diff engine,
generated-independent domain types, and narrow additions to `LidarrClientApi`. Existing code already
provides the important mechanics: bounded wire projection, a private generated SDK, exact-origin
transport, deny-by-default mutation retries, isolated scheduler lanes, sequential stop-admission,
atomic owner-only storage, machine/human stream separation, and static completion parity.

The critical dependency order is contracts/configuration, pure policy and diff logic, rich facade
projections, read-only commands, then locked and journaled mutation. Keep the new origin-scoped lock
and journal independent from plan IDs, and do not widen the existing narrow
`listQualityProfiles(): LidarrProfile[]` contract used by artist assignment.

## Existing Code Structure

```text
src/commands/lidarr.ts
  -> src/commands/lidarr-search.ts                 # extracted DI subtree precedent
  -> src/actions/lidarr/index.ts                   # action barrel
     -> src/actions/lidarr/*.ts                    # framework-independent orchestration
        -> src/lib/lidarr/index.ts                 # origin/client/scheduler resolution
        -> src/lib/lidarr/resilience.ts            # facade decorator and retry classification
        -> src/lib/lidarr/client.ts                # sole generated-SDK importer
           -> src/lib/lidarr/generated/*           # private generated operations and DTOs
           -> src/lib/lidarr/transport.ts           # sole authenticated Fetch owner
```

- `packages/rfmedia-cli/src/commands/lidarr.ts` owns the namespace, shared format/failure helpers,
  and final subtree registration. It lazy-imports action handlers but is already large.
- `packages/rfmedia-cli/src/commands/lidarr-search.ts` demonstrates the preferred extracted factory:
  the parent injects `resolveFormat`, failure reporting, and execution rendering so the child never
  imports the parent and creates an ESM cycle.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts` validates local intent first,
  resolves origin/client/scheduler through stable helpers, performs independent fresh reads in
  `Promise.all`, freezes a deterministic result, and keeps Commander concerns out of the action.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts` defines the mockable `LidarrClientApi`; every
  implementation method invokes a named generated operation through `#execute`/`#executeVoid` and a
  strict projector.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts` is the unknown-to-domain boundary. Existing
  projectors copy collections and nested values into frozen outputs rather than returning wire
  objects.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts` wraps every facade method explicitly. Safe
  GETs require deliberate addition to `LIDARR_IN_PLACE_RETRY_ALLOWLIST`; absent methods receive no
  retry behavior.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts` owns in-process admission and retry policy.
  `local-only` defaults to concurrent reads; `destructive` defaults to concurrency 1 and zero
  retries.
- `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts` iterates reviewed work
  sequentially and converts all later entries to `not-attempted` when an executor reports a stale,
  uncertain, or non-durable boundary.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` contains reusable storage principles:
  no-follow exclusive opens, private modes, file-identity and parent rechecks, file sync, atomic
  publication, owner tokens, same-host dead-PID recovery, and owner-checked release.
- `packages/rfmedia-cli/src/types/config.ts` and `packages/rfmedia-cli/src/lib/config.ts` define and
  validate the current optional `lidarr` section. The current outer validator recognizes known
  fields but does not reject every unknown sibling key.
- `packages/rfmedia-cli/src/lib/formatters/index.ts` delegates JSON/YAML/CSV to
  `@rfmedia/common`, keeps human rendering in commands, and recursively neutralizes CSV formula
  prefixes without changing JSON or YAML.

## Implementation Patterns

### Extracted command factory with dependency injection

Follow `createLidarrSearchCommands()` in
`packages/rfmedia-cli/src/commands/lidarr-search.ts`. Define a
`LidarrPresetCommandDeps` interface and return the complete `presets list|show|diff|apply` subtree
from a new sibling module. `lidarr.ts` should inject shared output/failure helpers and register one
returned command.

The factory should:

- parse and reject invalid pack references before action loading;
- lazy-import preset actions inside handlers;
- send human review/progress to stderr;
- emit one `{ command, result }`-style versioned machine document to stdout;
- project a fixed CSV row union before calling `formatOutput`; and
- pass API-key overrides as sensitive values to failure reporting.

### Validate before I/O, then schedule an explicit unit of work

`executeLidarrArtistProfilePlan()` validates required options before resolving the origin or
client, creates one task with a stable ID/operation label, and disables inner retries when the
scheduler owns policy. Preset actions should preserve that order:

1. Resolve and fully validate local built-in/configured policy.
2. Return immediately for offline `list`/`show`.
3. Resolve canonical origin and a fresh client only for `diff`/`apply`.
4. Run fresh GET work as explicitly idempotent scheduled work.
5. Run each write as non-idempotent work with no retry, while the action itself preserves
   custom-format → refreshed catalogs/schema → quality-profile → naming order.

### Narrow facade plus whole-response projection

`LidarrClientApi` methods are intention-revealing and generated-independent. Add separate rich
methods for quality-profile definitions/schema, custom formats/schema, naming/examples, and
create/update operations. Do not expand `LidarrProfile`, and do not expose generated DTOs or
string-typed PUT IDs outside `client.ts`.

Each facade method should mirror the existing pattern:

```text
validate domain input
  -> invoke one named generated operation
  -> #execute with operation label and AbortSignal
  -> project unknown response atomically
  -> return copied, deeply frozen domain data
```

Projectors must reject the complete response on malformed entries, duplicate IDs/names, excessive
recursion/collections, unknown dynamic fields, non-finite scores, or unsafe text. This is
authorization state; silently dropping one malformed row would make a destructive diff incomplete.

### Explicit retry classification and wrapper parity

`createLidarrResilienceContext()` builds a frozen object that forwards every interface method.
Adding a facade capability therefore requires three coordinated changes:

- implement it in `LidarrClient`;
- forward it in the resilience wrapper; and
- add only idempotent GETs to `LIDARR_IN_PLACE_RETRY_ALLOWLIST`.

POST/PUT methods must remain absent from the allowlist. An ambiguous post-dispatch failure is
resolved through fresh bounded read-back, never by resending the mutation.

### Pure deterministic domain engine

The new `lib/lidarr/profile-presets.ts` should accept values and return values only. Follow the
repository's `Object.freeze` convention and avoid config loading, logging, client access,
formatting, persistence, or prompts. Pure helpers should cover:

- qualified/unqualified pack resolution and collision errors;
- exact normalized-name lookup and ambiguity rejection;
- strict pack and live-schema validation;
- complete quality-profile body intent while preserving undeclared live scores;
- canonical managed projections and field ordering; and
- stable create/update/unchanged/retained diffs with no input mutation.

Behavioral array order must remain significant for quality trees and custom-format conditions.
Explicit `false`, `0`, empty arrays, and whitespace-bearing naming templates cannot be collapsed by
truthiness or generic JSON cleanup.

### Sequential stop-admission and durable outcomes

`executeLidarrApplyMutations()` is the closest control-flow precedent: it checks cancellation before
each entry, updates execution state, stops on a per-entry boundary, and materializes remaining
entries as `not-attempted`. Preset apply should use the same visible structure but not import the
sealed plan operation registry.

Before each remote write:

1. assert lock ownership;
2. reread and compare the reviewed semantic before-state;
3. durably record pre-dispatch intent;
4. issue one write;
5. stabilize/read back fresh state;
6. durably record `succeeded`, `satisfied`, `failed`, or `uncertain`; and
7. stop every later admission on stale, failed, uncertain, or journal failure.

### Owner-only atomic state

Reuse the storage mechanics in `plan-engine.ts`, not `acquireLidarrPlanClaim()` itself. That claim
requires a UUID and scopes exclusion to one plan ID, while presets need exclusion by
`sha256(canonicalOrigin)` across different pack references. A feature-specific persistence module
should own private directories/files, no-follow opens, bounded reads, temporary-file sync, atomic
replacement, identity rechecks, owner tokens, same-host dead-PID recovery, and owner-checked
release.

## Integration Points

### Files to create

- `packages/rfmedia-cli/src/types/lidarr-presets.ts`: frozen generated-independent pack, live
  projection, diff, resource outcome, journal, and result discriminated unions.
- `packages/rfmedia-cli/src/lib/lidarr/profile-presets.ts`: three immutable built-ins, strict
  resolution/validation, semantic normalization, body intents, and pure diff.
- `packages/rfmedia-cli/src/lib/lidarr/profile-presets.test.ts`: table-driven pack validation,
  collision, order, retention, canonicalization, and deterministic-diff tests.
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`: canonical-origin lock and
  bounded atomic apply journal.
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts`: ownership, permissions,
  symlink/path swap, stale-owner, durability, and no-write tests.
- `packages/rfmedia-cli/src/actions/lidarr/profile-presets.ts`: offline list/show, fresh diff, and
  locked sequential apply orchestration.
- `packages/rfmedia-cli/src/actions/lidarr/profile-presets.test.ts`: zero-I/O offline behavior,
  fresh preflight, ordered calls, dry-run/no-op, drift, uncertainty, interruption, journaling, and
  convergence coverage.
- `packages/rfmedia-cli/src/commands/lidarr-presets.ts`: subtree factory, human presenter,
  confirmation, envelopes, and fixed CSV projection.
- `packages/rfmedia-cli/src/commands/lidarr-presets.test.ts`: focused hierarchy, forwarding,
  prompt, stream, format, and failure tests if keeping the already large `lidarr.test.ts` bounded.

### Files to modify

- `packages/rfmedia-cli/src/types/config.ts`: optional typed `lidarr.profilePresets`.
- `packages/rfmedia-cli/src/lib/config.ts` and `src/lib/config.test.ts`: strict nested
  configured-pack parser with exact keys and explicit structural limits, while absence remains
  backward compatible.
- `packages/rfmedia-cli/src/commands/init.ts` and `rfmedia.example.yaml`: secret-free local-pack
  examples consistent with the same schema.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts` and `types.test.ts`: rich bounded wire projectors.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts` and `client.test.ts`: generated operation imports,
  narrow facade methods, private body/ID translation, response projection, and cancellation/error
  contracts.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts` and `resilience.test.ts`: complete forwarding,
  safe-read allowlisting, and proof that writes are never hot-retried.
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`,
  `scripts/generate-lidarr-client.mjs`, and `scripts/generate-lidarr-client.test.mjs`: pin every
  newly consumed operation/method/path against the committed snapshot.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts` only if a small preset-specific execution-context
  resolver is needed; retain canonical connection and credential ownership here.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`: export the new action entrypoints/types.
- `packages/rfmedia-cli/src/commands/lidarr.ts` and `commands/lidarr.test.ts`: inject shared helpers,
  register one `presets` subtree, and lock parent integration.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`: typed defaults for every
  new facade method.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`, `zsh.ts`, `fish.ts`, and
  `templates.spec.ts`: identical static hierarchy and exact value-taking options, with no config or
  network calls.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` and its test: keep generated imports
  and mutation body construction confined to the facade and Fetch confined to transport.
- `packages/rfmedia-cli/package.json` and the lockfile: upgrade the existing direct `js-yaml`
  dependency as required by the frozen spec; add no new runtime library.

### Files to use as patterns but not couple to

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: do not add preset operations or artifacts.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: reuse storage principles, not plan identity,
  checksum, history, or claim APIs.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts`: expected to remain unchanged unless a
  contract test identifies a genuine transport defect.
- `packages/rfmedia-cli/src/lib/schema.sql` and deferred-queue modules: no preset table, migration,
  or automatic replay.
- `packages/rfmedia-cli/src/lib/lidarr/generated/**`: replace-only generated output; do not edit by
  hand and do not refresh without a proved snapshot mismatch.

## Code Conventions

- TypeScript targets Node 22/ES2023 with ESM NodeNext imports ending in `.js`.
- Commands parse Commander values and lazy-load actions; actions remain Commander-independent.
- Public models prefer readonly fields and discriminated unions; returned collections and nested
  structures are copied and frozen.
- Validate exact domain invariants at runtime because generated OpenAPI types are permissive wire
  descriptions, not authorization.
- Use stable sanitized operation labels, typed `LidarrError`/`ConfigError` families, exhaustive
  switches with `never`, and concrete safe next actions.
- Use positive safe integer IDs in domain code; isolate the generated string-ID PUT quirk inside
  the facade.
- Human output uses stderr and color only as supplementary information. Machine formats use stdout
  only; CSV declares fixed columns/row types and relies on shared formula neutralization.
- Cancellation uses the caller `AbortSignal` through scheduler, facade, transport, stabilization,
  and persistence admission checks.
- Tests use Vitest, typed facade mocks, deterministic fixtures, `mkdtemp`-owned temporary roots,
  and explicit assertions that read-only/dry-run paths made no mutation or journal calls.

## Dependencies and Services

- Commander constructs the CLI hierarchy; `console-table-printer` and `picocolors` support human
  presentation.
- `@rfmedia/common` supplies output-format discrimination and JSON/YAML/CSV serialization.
- The private `@hey-api/openapi-ts` output supplies existing Lidarr v1 operations from the
  committed snapshot. It is build-time/generated infrastructure, not a public runtime SDK.
- `p-limit` underlies the existing scheduler. Preset writes still require explicit sequential
  orchestration and a cross-process origin lock.
- `js-yaml` with `CORE_SCHEMA` parses local configuration after the repository's size and secret
  template handling. Its direct version must be upgraded, but no second parser/schema framework is
  needed.
- Lidarr is the only remote service. `list`/`show` are offline; `diff`/`apply` require fresh live
  configuration and capability reads. No database, remote catalog, Plex operation, search,
  download, rename, or artist mutation belongs in this feature.
- The filesystem under the existing rfmedia/XDG plan root is the authority for the origin lock and
  preset apply journal. Existing SQLite resilience state remains best effort and non-authoritative.

## Gotchas and Warnings

- Same-name resource adoption has global impact. Never use fuzzy matching, infer renames, or accept
  zero/multiple normalized matches.
- Quality-profile PUT bodies must contain every current custom format exactly once. Preserve
  undeclared live scores on update and use schema-default zero only for newly created profiles.
- Schema and example endpoints return dynamic/unknown shapes. Generated TypeScript alone does not
  make them safe; reject malformed whole responses before any write.
- Naming examples are advisory. Only PUT followed by a fresh GET can verify persisted state.
- Do not let a successful generated mutation response authorize success. Fresh semantic read-back
  is required, and post-dispatch ambiguity becomes `uncertain`.
- Do not acquire a lock or write a journal for `list`, `show`, `diff`, `apply --dry-run`, declined
  approval, or a converged no-op apply.
- Do not reuse `maxBatch`-style mutation caps for the complete artist impact read.
- Scheduler concurrency 1 is process-local; it does not replace the canonical-origin filesystem
  lock.
- Existing outer Lidarr config validation is permissive. Enforce exact keys inside
  `profilePresets` without introducing an unrelated breaking change for legacy Lidarr siblings.
- Completion generation must remain static. It may contain built-in identifiers, but must not load
  config, resolve credentials, construct a client, or contact Lidarr.
- The committed OpenAPI snapshot already contains the needed operations. Extend contract gates
  first; refresh only if those tests prove an actual mismatch.
- Updating all facade methods means updating the resilience wrapper and the full typed mock in the
  same commit or compilation will fail widely.

## Task-Specific Guidance

1. Freeze `lidarr-presets` domain types, limits, strict config shape, fixture-backed built-ins, and
   digests first. This unblocks pure engine and config work without remote I/O.
2. Implement and exhaustively test pure resolution, validation, body intent, and semantic diff
   before introducing facade or persistence calls.
3. Extend rich projectors, facade methods, generated-operation guards, resilience forwarding, and
   the typed mock as one API-boundary task.
4. Deliver offline `list`/`show` and live read-only `diff` before apply; assert zero write methods
   and stable human/JSON/YAML/CSV ordering.
5. Build origin lock/journal primitives with adversarial filesystem tests independently of Lidarr,
   while reusing the proven plan-engine safety sequence.
6. Implement apply as an explicit dependency-ordered state machine with one complete preflight,
   approval, per-resource drift check, pre-dispatch durability, no-retry write, read-back, terminal
   durability, and stop-admission.
7. Integrate the command subtree, parent registration, all-shell completion parity, config/init
   examples, architecture checks, and docs only after the action contracts are stable.
8. Validate with focused config/pure-engine/projector/client/resilience/persistence/action/command
   tests, generated drift and architecture gates, package typecheck/build/full tests, Prettier,
   audit, and `git diff --check`.
