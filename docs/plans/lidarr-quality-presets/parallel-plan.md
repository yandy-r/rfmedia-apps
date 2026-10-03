# Lidarr Quality Preset Packs Implementation Plan

Issue #213 adds a dedicated `rfmedia lidarr presets list|show|diff|apply` workflow without changing
the existing artist/album plan artifact. Implementation proceeds from generated-independent
contracts into four parallel foundations: strict configuration, bounded wire projection, pure
preset policy/diff, and hardened origin-scoped persistence. Those foundations join at the Lidarr
facade and live diff, after which real apply is implemented as one explicit sequential state
machine with drift checks, no-retry writes, read-back, and durable outcomes. The final phases expose
the command, synchronize Bash/Zsh/Fish completions, document exact policies and recovery, update
release tracking, and run only contract-critical verification plus repository gates.

## Worktree Setup

- **Parent**: `/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-213` (branch:
  `feat/213-lidarr-quality-presets`; this already-created user-required worktree overrides the
  workflow's default `.codex/worktrees/` location)

## Critically Relevant Files and Documentation

- `docs/plans/lidarr-quality-presets/feature-spec.md`: Frozen v1 product and safety contract.
- `docs/plans/lidarr-quality-presets/shared.md`: Repository files, patterns, and mandatory reading.
- `packages/rfmedia-cli/src/commands/lidarr-search.ts`: Extracted command-factory pattern.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Review and recovery presentation precedent.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`: Fresh scheduled read-action pattern.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Approval, interruption, and durable-outcome precedent.
- `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts`: Sequential stop-admission pattern.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Sole handwritten generated-SDK importer.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Bounded unknown-to-domain projection.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts`: Sole authenticated Fetch owner.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Explicit retry allowlist and facade wrapper.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Read and destructive execution lanes.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Hardened owner-only storage and locking precedent.
- `packages/rfmedia-cli/src/lib/config.ts`: Bounded `CORE_SCHEMA` config parser.
- `packages/rfmedia-cli/src/lib/formatters/index.ts`: Machine formats and CSV formula safety.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Three-shell parity gate.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`: Generated-client boundary contract.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: Safety vocabulary and recovery contract.
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`: Scheduler and retry contract.
- `docs/features/shell-completion.md`: Static completion maintenance contract.

## Implementation Plan

### Phase 1: Freeze Shared Contracts and Dependency Baseline

#### Task 1.1: Define Generated-Independent Preset Contracts Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-quality-presets/feature-spec.md`
- `packages/rfmedia-cli/src/types/lidarr.ts`
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`
- `packages/rfmedia-cli/src/types/index.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/types/lidarr-presets.ts`

Files to Modify

- `packages/rfmedia-cli/src/types/index.ts`

Define readonly generated-independent contracts for source-qualified packs, assumptions,
capabilities, custom-format conditions, complete quality profiles, complete naming, rich live
definitions, semantic field changes, resource diffs, impact, versioned list/show/diff/apply
results, dispatch/verification outcomes, and bounded journal state. Use discriminated unions,
positive-integer domain IDs, stable resource keys, and explicit falsy/empty fields. Export only
domain contracts; do not import generated DTOs, Commander, config loaders, clients, or filesystem
types.

Freeze stable schema names and the outcome vocabulary
`succeeded|satisfied|failed|uncertain|not-attempted`. Express create/update inputs separately so an
update requires an ID and a create cannot carry one. Keep the old `LidarrProfile` contract intact.
Run package typecheck after the export and add no type-only test file unless runtime invariants
require it.

#### Task 1.2: Patch the Existing YAML Parser Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/package.json`
- `package-lock.json`
- `docs/plans/lidarr-quality-presets/research-security.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/package.json`
- `package-lock.json`

Upgrade the direct `js-yaml` dependency to `^4.3.0`, the patched compatible v4 floor established by
the security research, using npm so the lockfile remains authoritative. Add no new parser or
validation dependency and do not opportunistically update unrelated packages. Verify the resolved
version, run the existing config tests, and run `npm audit --omit=dev`; record residual unrelated
advisories for PR testing rather than broadening this task.

### Phase 2: Build Parallel Foundations

#### Task 2.1: Add Strict Configured-Pack Parsing Depends on [1.1, 1.2]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-quality-presets/feature-spec.md`
- `packages/rfmedia-cli/src/types/config.ts`
- `packages/rfmedia-cli/src/lib/config.ts`
- `packages/rfmedia-cli/src/lib/config.test.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/types/config.ts`
- `packages/rfmedia-cli/src/lib/config.ts`
- `packages/rfmedia-cli/src/lib/config.test.ts`

Add optional `lidarr.profilePresets` typing and an exact-key recursive validator for strict,
self-contained configured packs. Preserve legacy behavior when the section is absent and do not
make unrelated Lidarr sibling keys newly strict. Reject built-in shadowing, inheritance, URLs,
external paths, executable hooks, prototype/sensitive keys, duplicate normalized names, unknown
fields, non-finite/out-of-range scores, unsafe strings, and unsupported condition shapes before
network access.

Enforce explicit depth, scalar byte, pack/resource/condition, quality-tree, score, naming, and
expanded-result limits while retaining the existing 1 MiB file bound and YAML `CORE_SCHEMA`.
Preserve precise config property paths in errors. Add only critical table-driven tests: compatible
absence, one complete valid configured pack, unknown nested key, duplicate/collision, structural
bound, unsafe regex/naming value, and no client involvement.

#### Task 2.2: Project Rich Lidarr Configuration Responses Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- `packages/rfmedia-cli/src/lib/lidarr/types.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts`
- `docs/plans/lidarr-quality-presets/research-integration.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/types.ts`
- `packages/rfmedia-cli/src/lib/lidarr/types.test.ts`

Add bounded whole-response projectors for custom-format definitions/schema, recursive rich
quality-profile definitions/schema, naming singleton, and naming examples. Treat every input as
`unknown`; copy and deeply freeze outputs. Reject duplicate positive IDs and normalized names,
unknown dynamic field shapes, unsafe/control-bearing labels, non-finite scores, excessive
collections, excessive recursive nodes/depth, and malformed complete resources instead of
truncating authorization state.

Preserve ordered conditions and quality trees, explicit zero/false/empty values, and the narrow
existing quality-profile projector. Add representative valid fixtures plus critical rejection
cases for malformed whole collections, ambiguity, recursive bounds, dynamic values, and unsafe
text. Do not import generated types into public domain modules.

#### Task 2.3: Implement the Pure Preset Registry and Semantic Diff Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-quality-presets/feature-spec.md`
- `docs/plans/lidarr-quality-presets/research-external.md`
- `packages/rfmedia-cli/openapi/lidarr-v1.json`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-validation.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/lidarr/profile-presets.ts`
- `packages/rfmedia-cli/src/lib/lidarr/profile-presets.test.ts`

Files to Modify

- `docs/plans/lidarr-quality-presets/feature-spec.md`

Implement a pure module containing three real immutable `@1` built-ins (`balanced`, `lossless`,
`space-saver`), normalized digests, source-qualified/unqualified pack resolution, portable-name
resolution, capability/schema validation, conservative regex and naming validation, complete
profile/naming intents, custom-format score preservation, canonical projections, impact-ready
references, and deterministic create/update/unchanged/retained diffs.

Derive exact quality names/groups/cutoffs, supported condition fields, scores, and naming tokens
from the committed OpenAPI snapshot plus representative generated-contract fixtures and current
official behavior captured in research. Before implementing the registry, present the exact
`balanced@1`, `lossless@1`, and `space-saver@1` policy table and named representative fixture to
the main design/orchestration owner for independent approval, then persist that approved table and
compatibility assumptions in `feature-spec.md`. Do not begin dependent tasks until that checkpoint
is recorded. Compatibility is capability-based—required endpoints, the four allowed condition
implementations and exact fields, referenced quality/group names, and persisted naming fields must
all resolve—rather than a marketing version string. The safe regex grammar is the documented
subset that rejects controls/bidi, backreferences, lookbehind, nested ambiguous quantifiers, and
configured byte/count limits. Each built-in must contain a real profile, real custom format, and
complete naming policy with disclosed tradeoffs; placeholders are a stop condition. Preserve
behavioral array order and unmanaged live scores. Reject zero/multiple normalized matches and
unsupported live capability intersections. Keep the module free of config loading, clients,
scheduling, persistence, prompts, and rendering.

Add critical table-driven tests for all three built-ins, stable digest/order, qualified ambiguity,
unsupported schema, create/update/no-op/retain, unmanaged-score preservation, unsafe regex/naming,
input immutability, and second-run semantic convergence.

#### Task 2.4: Add Origin-Scoped Locking and Apply Journaling Depends on [1.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/signal-handler.ts`
- `docs/plans/lidarr-quality-presets/research-security.md`
- `docs/plans/lidarr-quality-presets/research-integration.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.test.ts`

Files to Modify

- None.

Implement a self-contained preset-specific exclusive lock keyed by `sha256(canonicalOrigin)` and a
bounded, secret-free, owner-only atomic full-file journal under
`<getDefaultPlanDir()>/lidarr-preset-applies/{locks,journals}`. Mirror the plan engine's
private-directory, no-follow, ownership/mode, device/inode, temporary file, `fsync`, atomic
replacement, ownership-token, same-host dead-PID recovery, and owner-checked release techniques
without modifying `plan-engine.ts`, calling its UUID-scoped claim API, or validating plan-v2
history.

Expose the smallest action-facing interface: acquire/assert/release lock and create/transition/finalize
journal. Ensure intent and pre-dispatch state can be durable before a remote write. Tests must
cover two pack refs contending on one canonical origin, different origins, private modes, symlink
or path-swap rejection, live-owner refusal, same-host dead-owner recovery, bounded/invalid journal
rejection, atomic transition, owner-checked idempotent release, and caller-owned temporary cleanup.
List/show/diff/dry-run/no-op zero-filesystem behavior is tested at the action layer.

### Phase 3: Extend the Stable Lidarr Facade

#### Task 3.1: Add Rich Facade Methods, Retry Classification, and Mock Parity Depends on [2.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/client.ts`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`

Extend `LidarrClientApi` and `LidarrClient` with intention-revealing schema/collection/by-ID,
create/update, naming, and naming-example methods using the committed generated operations. Keep
the existing narrow `listQualityProfiles()` method unchanged. Validate domain inputs, translate
positive numeric PUT IDs to generated string IDs privately, construct complete request bodies,
project all responses through Task 2.2, and preserve caller cancellation and sanitized errors.

Forward every new method explicitly through the resilience wrapper and typed mock. Add only
idempotent GET methods to `LIDARR_IN_PLACE_RETRY_ALLOWLIST`; mutation methods must never be
hot-retried. Make the change compile-safe as one task and run typecheck before handing it off.

#### Task 3.2: Pin Facade, Retry, and Generated Operation Contracts Depends on [3.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/lidarr/client.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/resilience.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`

Add critical facade tests for exact operation selection, method/path/body translation, private
string ID conversion, frozen projected responses, cancellation identity, and sanitized malformed
response failures. Prove safe reads can receive bounded in-place retry and every create/update is
forwarded without retry.

Extend the generated runtime contract test to exercise the newly consumed committed operations and
wire envelopes. Hand the full operation/endpoint list directly to Task 3.3 so its offline generator
requirements pin the same contract; do not edit generated output or refresh the snapshot.

#### Task 3.3: Extend Offline Codegen Requirement Gates Depends on [3.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`
- `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs`
- `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`

Add every newly consumed custom-format, quality-profile, naming, schema, example, create, and
update operation to the offline generator's required-operation and required-endpoint gates. Extend
the generator fixture tests so a missing operation, wrong HTTP method/path, or missing request
envelope fails deterministically. Do not change the manifest, OpenAPI snapshot, generator version,
or generated files because the committed snapshot already supplies these endpoints. Run the
codegen drift check.

### Phase 4: Build Read-Only Discovery and Live Diff

#### Task 4.1: Orchestrate Offline Discovery and Fresh Live Diff Depends on [2.1, 2.3, 3.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts`
- `packages/rfmedia-cli/src/actions/lidarr/search.ts`
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/actions/lidarr/profile-presets.ts`
- `packages/rfmedia-cli/src/actions/lidarr/profile-presets.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/index.ts`

Add exported list/show/diff entrypoints. Resolve and validate local packs before I/O. List/show
must remain offline and credential-free. Diff must resolve the canonical origin, use fresh
local-only reads with stale serving disabled, fetch bounded schemas/resources and artist impact,
validate the entire selected pack against live capabilities, and delegate deterministic comparison
to the pure engine.

Return frozen versioned results containing source-qualified pack identity/digest, target origin,
assumptions, observations, consequences, summary counts, impacts, warnings, naming examples, and
execution metadata. A changed and no-op diff both succeed. Tests must prove offline zero client
resolution, complete fresh reads, stable create/update/unchanged/retain output, correct impact
counts without mutation batch limits, malformed/ambiguous preflight failure, and zero mutation,
lock, or journal calls.

#### Task 4.2: Implement Verified Locked Apply Depends on [2.4, 4.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts`
- `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/actions/lidarr/profile-presets.ts`
- `packages/rfmedia-cli/src/actions/lidarr/profile-presets.test.ts`

Add real apply as an explicit state machine with a framework-independent injected
`confirm(review): Promise<boolean>` callback owned by the command layer. `--dry-run` delegates to
the complete live diff and performs zero API mutation, lock, or journal writes. Real apply returns
without lock/prompt/write when converged; otherwise it acquires the canonical-origin lock, repeats
full preflight under the lock, invokes the callback with that final complete review while retaining
the lock, and only then admits confirmed work. A decline releases the owned lock and leaves no
journal or residual lock; acquiring and releasing the lock is permitted because it protects the
review-to-write interval.

For each resource: assert lock ownership, reread and compare the reviewed before/preserved state,
durably record pre-dispatch intent, issue exactly one no-retry POST/PUT, perform bounded fresh
read-back, durably classify the outcome, and stop all later admissions on stale, failed,
uncertain, or persistence failure. Apply custom formats first, refresh formats and profile schema,
rebuild complete profile bodies preserving unmanaged scores, apply profiles, then apply complete
naming. Schedule every write as `destructive` and `idempotent: false` with zero retry attempts;
scheduler serialization does not replace explicit action ordering or the origin lock. Register
interruption cleanup, stop new admissions, stabilize the in-flight resource, and release only a
still-owned lock. Recovery is a fresh convergence rerun; never rollback or replay from SQLite.

Add critical tests for dry-run/no-op zero effects, under-lock confirmation, declined approval with
no journal/residual lock, default ordered destructive-lane writes, custom-format ID/schema refresh,
pre-write drift, post-dispatch ambiguity, read-back mismatch, journal failure, not-attempted
dependents, interruption/release, and second-run zero mutation.

### Phase 5: Expose the Public Command and Completion Surface

#### Task 5.1: Add the Preset Command Factory and Parent Registration Depends on [4.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/lidarr-search.ts`
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`
- `packages/rfmedia-cli/src/commands/lidarr.ts`
- `packages/rfmedia-cli/src/lib/formatters/index.ts`

**Instructions**

Files to Create

- `packages/rfmedia-cli/src/commands/lidarr-presets.ts`
- `packages/rfmedia-cli/src/commands/lidarr-presets.test.ts`

Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr.ts`

Create a dependency-injected, lazy `presets` subtree with `list`, `show <pack-ref>`,
`diff <pack-ref>`, and `apply <pack-ref>`. Reuse global output, verbose, debug, connection override,
dry-run, and approval conventions without importing the parent module. Validate pack refs before
lazy action loading.

Render a bounded assumptions/impact/resource/field review and progress on human stderr. Emit one
versioned JSON/YAML result on stdout. Project fixed spreadsheet-safe CSV rows with explicit
`rowType` and fixed columns. Show raw naming templates plus sanitized examples and explicit
non-effects. Prompt once, default no, only after the full changing review; machine/non-TTY apply
requires `--yes`, and `--yes` skips no validation. Report stable safe failures and exact
shell-quoted recovery commands without leaking credentials.

Tests should cover the four-leaf hierarchy, option forwarding, offline list/show, changed/no-op
review, default-no cancellation, `--yes` enforcement, dry-run precedence, human/machine stream
purity, fixed CSV columns, partial exit behavior, and redaction.

Use the repository's exact exit contract: valid list/show/diff, changed/no-change diff, converged
apply, and user decline leave exit status successful; validation/config/authentication failure and
failed, partial, or uncertain apply set `process.exitCode = 1`.

#### Task 5.2: Add Bash, Zsh, and Fish Completion Parity Depends on [5.1]

**READ THESE BEFORE TASK**

- `docs/features/shell-completion.md`
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`

Add the identical `presets list|show|diff|apply` hierarchy and exact value-taking flags to all
three static templates. Complete `builtin:balanced`, `builtin:lossless`, and
`builtin:space-saver` where the template convention supports static argument candidates; the
integer version remains result metadata rather than part of the pack-ref grammar. Do not load
configured pack IDs, config, credentials, a client, scheduler, database, or network. Audit every
shell explicitly even if one template needs no implementation beyond parity.

#### Task 5.3: Lock Command and Completion Integration Depends on [5.1, 5.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/src/commands/lidarr.test.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`
- `packages/rfmedia-cli/src/cli.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/src/commands/lidarr.test.ts`
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`

Add parent-namespace/help assertions and three-shell parity tests for every new leaf and
value-taking option. Prove completion generation is static and does not resolve config or Lidarr.
Keep tests focused on public contract differences not already covered in the command-factory suite.
Run the command and completion test files together.

### Phase 6: Documentation, Release Surfaces, and Architecture Evidence

#### Task 6.1: Document Exact Policy, Config, Commands, and Recovery Depends on [5.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/README.md`
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
- `rfmedia.example.yaml`
- `docs/plans/lidarr-quality-presets/research-docs.md`

**Instructions**

Files to Create

- `packages/rfmedia-cli/docs/features/lidarr-quality-presets.md`

Files to Modify

- `packages/rfmedia-cli/README.md`
- `rfmedia.example.yaml`

Document the exact three built-in policies/versions/digests and their storage, bandwidth,
compatibility, upgrade, custom-format, and naming consequences. Add the full command surface,
qualified/configured references, strict self-contained config schema, same-name adoption,
managed/retained state, live capability checks, diff/output behavior, approval/dry-run/no-op
semantics, ordered writes, local-host canonical-origin locking, journal security,
partial/uncertain recovery,
exit behavior, and every explicit non-effect.

Keep the README concise and link the feature guide. Add one complete secret-free configured pack
example using no inheritance, URL, external file, or placeholder policy. Audit
`packages/rfmedia-cli/src/commands/init.ts`; update it only in a separately scoped fix if its
generated example duplicates the changed Lidarr config block. Run Prettier/markdownlint only on
touched docs.

#### Task 6.2: Synchronize Integration and Completion Documentation Depends on [3.3, 5.2]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`
- `docs/README.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`
- `packages/rfmedia-cli/docs/features/shell-completion.doc.md`
- `docs/README.md`

Document the newly consumed committed generated operations, rich-facade boundary, safe-read retry
classification, destructive-lane no-retry writes, and static preset completion subtree. Preserve
the rule that the OpenAPI snapshot was not refreshed. Add the new feature guide to `docs/README.md`
and update the rfmedia-specific completion guide where it enumerates the command surface. Audit the
repository-level `docs/features/shell-completion.md` and record an explicit no-change result because
it documents rfapps rather than rfmedia.

#### Task 6.3: Add Architecture and Changelog Evidence Depends on [3.3, 5.1]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`
- `packages/rfmedia-cli/CHANGELOG.md`
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`
- `packages/rfmedia-cli/CHANGELOG.md`

Audit the production architecture gate against all new source paths. Extend its test fixtures to
prove preset/action/type modules cannot import generated Lidarr modules, construct handwritten
`/api/v1/` paths, or own Fetch/mutation bodies outside the facade. Modify
`check-direct-plex-imports.mjs` only through a separately reviewed scoped fix if the audit proves
its generic discovery misses a new path; otherwise record the explicit no-change result. Add an
Unreleased changelog entry covering all four commands, three built-ins, configured packs, additive
ownership, dry-run/approval/recovery, output formats, and completion/config changes.

### Phase 7: Critical Verification and Local Review

#### Task 7.1: Run Focused Acceptance and Repository Gates Depends on [1.2, 4.2, 5.3, 6.1, 6.2, 6.3]

**READ THESE BEFORE TASK**

- `packages/rfmedia-cli/package.json`
- `package.json`
- `.github/workflows/rfmedia-cli.yml`
- `docs/plans/lidarr-quality-presets/feature-spec.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None unless a failing gate identifies a defect in an owning task's scoped files.

Run the focused config, projector, pure engine, persistence, client, resilience, action, command,
and completion test files. Then run the exact repository/package scripts that map to the current
workflow: rfmedia typecheck, focused/full test as required by changed contracts, build,
lint/Prettier/markdown checks, `codegen:lidarr:check`, architecture check/test,
`npm audit --omit=dev`, and `git diff --check`. Record every exact command and pass/fail outcome for
the PR. Exercise an end-to-end fixture proving list/show are offline, diff and dry-run issue no
writes, a changing apply writes in dependency order with verification, and a second run issues zero
mutations.

Fix failures in the task that owns the affected contract rather than adding speculative tests or
broad cleanup. Explicitly audit Bash, Zsh, and Fish parity and report the result. Run
`graphify update .` in the feature worktree after source changes; if the ignored graph directory is
absent, initialize/update it using the graphify skill's repository-safe command, inspect the scoped
result, and do not commit ignored generated graph data.

#### Task 7.2: Perform Local Code Review and Fix Findings Depends on [7.1]

**READ THESE BEFORE TASK**

- `docs/plans/lidarr-quality-presets/feature-spec.md`
- `docs/plans/lidarr-quality-presets/parallel-plan.md`
- `.github/pull_request_template.md`

**Instructions**

Files to Create

- The repository-standard review artifact under `docs/prps/reviews/`.

Files to Modify

- Only files anchored by actionable review findings.

Run the repository code-review workflow plus the mandatory code-reviewer over the complete
issue #213 diff. Audit correctness, shared-state safety, generated/transport boundaries, secret
handling, concurrency, filesystem hardening, dry-run/no-op guarantees, output/exit contracts,
critical-test sufficiency, completion parity, and documentation accuracy. Apply each actionable
finding through the scoped review-fix workflow, mark its status in the review artifact, and rerun
the focused test/gate that proves the fix. Repeat until no critical/high/medium actionable finding
remains and `git diff --check` is clean.

### Phase 8: Publish the PR and Close Review/CI

#### Task 8.1: Commit, Push, and Open the GitHub PR Depends on [7.2]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `docs/plans/lidarr-quality-presets/feature-spec.md`
- `docs/plans/lidarr-quality-presets/parallel-plan.md`

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Confirm the worktree contains only issue #213 changes, use the repository commit workflow and
validators to create intentional conventional commit(s), and push
`feat/213-lidarr-quality-presets` to the GitHub-hosting `origin` without bypassing hooks. Open a PR
using the exact repository template and preserve Summary, Changes, Testing, Related Issues
(`Closes #213`), Breaking Changes, Risk and Rollback, and Checklist. Include exact verification
commands/outcomes, the completion audit, generated-snapshot no-refresh result, and links to design,
spec, and plan artifacts. Capture the actual PR number and head SHA.

#### Task 8.2: Update ROADMAP and Shipped-Work Archive Depends on [8.1]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `docs/roadmap-archive.md`
- The actual issue #213 PR.

**Instructions**

Files to Create

- None.

Files to Modify

- `ROADMAP.md`
- `docs/roadmap-archive.md`

Using the actual PR link, remove issue #213 from current/open roadmap rows, update affected
sprint/phase context without disturbing other issues, and add one shipped-work archive row with
issue #213, PR, date, and concise delivered outcome using the repository's pre-merge archive
pattern. Run Prettier/markdownlint and `git diff --check`, commit through normal validators, and
push the update. The row may say delivery is via the implementation PR; authoritative merge and
issue-closure claims are verified only in Task 9.1.

#### Task 8.3: Resolve All Actionable PR Review Feedback Depends on [8.2]

**READ THESE BEFORE TASK**

- The live GitHub PR and every review thread/comment.
- `docs/prps/reviews/` issue #213 review artifact.
- `docs/plans/lidarr-quality-presets/feature-spec.md`

**Instructions**

Files to Create

- None unless the repository PR-autofix workflow requires a scoped summary artifact.

Files to Modify

- Only files anchored by actionable review comments.

Use the repository PR review/autofix workflow to discover every unresolved review thread,
file-level review comment, and top-level PR comment from human or bot authors. Apply the smallest
safe fix for each actionable item, run its focused proving test, commit and push normally, reply
with evidence, resolve the thread, and post the repository summary. Requery after the final push and
continue until no actionable thread remains.

#### Task 8.4: Monitor and Fix CI to Green on the Final Head Depends on [8.3]

**READ THESE BEFORE TASK**

- `.github/workflows/rfmedia-cli.yml`
- The live PR status/check rollup.
- Repository CI monitoring helpers.

**Instructions**

Files to Create

- None.

Files to Modify

- Only files implicated by a reproducible CI failure.

Monitor the authoritative checks for the active PR head SHA using the repository-native CI helper
and GitHub status rollup. For each failure, inspect the exact failed step/log, reproduce when safe,
apply the smallest scoped fix, run the matching local gate, commit/push normally, re-audit review
threads, and restart monitoring on the new head. Continue until every required check is successful
or explicitly neutral and the reported green SHA equals the PR head SHA.

### Phase 9: Squash Merge and Clean Up

#### Task 9.1: Squash Merge, Verify Closure, and Remove Issue Worktree Depends on [8.4]

**READ THESE BEFORE TASK**

- The final green PR and unresolved-thread status.
- Issue #213.
- `git worktree list --porcelain`.

**Instructions**

Files to Create

- None.

Files to Modify

- None.

Perform one last actionable-thread and required-check audit, then squash merge the PR using the
repository's normal GitHub workflow. Verify GitHub reports the PR merged with a merge commit on
`master`, issue #213 closed through `Closes #213`, the final ROADMAP/archive content is present on
the merged branch, and the remote feature branch is deleted. Fetch/prune remotes, fast-forward the
clean primary checkout to the authoritative merged `origin/master`, remove only
`/home/yandy/Projects/github.com/yandy-r/rfmedia-apps-issue-213`, delete the local feature branch,
and run `git worktree prune`. Preserve the unrelated issue #211 worktree and any user-owned state.
Report the PR URL, merge SHA, green CI evidence, issue closure, completion audit, and cleanup state.

## Advice

- Treat the three built-ins as versioned policy, not demo data; fixture-backed exact content is a
  release gate.
- Keep generated DTOs private and the existing narrow artist-profile facade method unchanged;
  compilation pressure is not a reason to widen unrelated contracts.
- A quality-profile write must include every fresh current custom format exactly once and preserve
  undeclared scores; refresh after custom-format creation before building any profile body.
- Scheduler serialization is process-local and does not replace the canonical-origin filesystem
  lock. The lock is local-host coordination only and must be documented as such.
- Mutation success requires fresh semantic read-back plus durable journal evidence. A successful
  HTTP response alone is insufficient, and ambiguous dispatch is never hot-retried.
- Do not acquire the origin lock or create a journal for offline, diff, dry-run, or converged
  paths. A changing apply holds the lock across final review/approval; decline or cancellation
  before dispatch must release it without creating a journal or leaving residual state.
- Keep the pure engine resource-specific. A generic reconciler, workflow library, database table,
  deferred replay, remote preset catalog, pruning, inheritance, and rollback all remain outside v1.
- Public completion parity is part of the feature: audit Bash, Zsh, and Fish together whenever the
  command grammar changes.
- Update ROADMAP/archive only with the real PR identity and preserve unrelated issue state.
