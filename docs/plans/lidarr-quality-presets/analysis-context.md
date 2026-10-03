# Context Analysis: lidarr-quality-presets

## Executive Summary

Issue #213 adds a dedicated `rfmedia lidarr presets` desired-state workflow for three immutable
built-in packs and strict local configured packs. The implementation should preserve the existing
command → action → pure domain → facade → generated SDK layering, while adding fresh
capability-based semantic diffing and a canonical-origin-locked, journaled, sequential apply path
that never extends the sealed `rfmedia.lidarr-plan.v2` artifact family.

## Architecture Context

- **System Structure**: Add `commands/lidarr-presets.ts` as a dependency-injected subtree factory,
  `actions/lidarr/profile-presets.ts` as the live workflow orchestrator,
  `lib/lidarr/profile-presets.ts` as the pure pack resolver/validator/diff engine, and
  `types/lidarr-presets.ts` as the generated-independent contract owner. Keep rich wire projection
  in `lib/lidarr/types.ts`, generated calls in `lib/lidarr/client.ts`, and authenticated Fetch in
  `lib/lidarr/transport.ts`.
- **Data Flow**: `list` and `show` resolve frozen built-ins plus validated local configuration
  without creating a Lidarr client. `diff` resolves one pack, performs bounded fresh schema and
  resource reads, resolves portable names to live IDs, computes a deterministic semantic review,
  and emits no writes. Real `apply` acquires an origin-scoped lock, repeats complete preflight,
  prompts once when changes remain, then executes drift check → write → read-back → durable outcome
  for custom formats, refreshed catalogs/schema, quality profiles, and naming in that order.
- **Integration Points**: Register one lazy `presets` subtree from `commands/lidarr.ts`; export
  action entrypoints from `actions/lidarr/index.ts`; add strict optional
  `lidarr.profilePresets` config; extend the narrow client facade and resilience wrapper; schedule
  fresh GETs as local-only idempotent work and writes in the serial destructive lane; add a
  preset-specific filesystem lock/journal; integrate human and machine presenters, all shell
  completions, architecture/contract gates, examples, and operator documentation.

## Critical Files Reference

- `docs/plans/lidarr-quality-presets/feature-spec.md`: Frozen v1 scope, ownership, safety, output,
  and apply-state-machine contract.
- `packages/rfmedia-cli/src/commands/lidarr.ts` and
  `packages/rfmedia-cli/src/commands/lidarr-search.ts`: Existing namespace registration, lazy
  subtree factory, and output dependency-injection patterns.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Review-first impact,
  partial-outcome, bounded-preview, and recovery-command presentation precedent.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts`: Approval, interruption,
  stop-admission, sequential mutation, and durable outcome precedents.
- `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts`: Typed facade mock seam
  that must grow with every new facade method.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/types.ts`, and
  `packages/rfmedia-cli/src/lib/lidarr/transport.ts`: Generated-SDK privacy, bounded unknown
  projection, request-body translation, canonical-origin confinement, and sole Fetch ownership.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`, and
  `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Required origin/execution-context resolution,
  explicit safe-read retry allowlist, wrapped-facade parity, and read/destructive execution lanes.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Hardened owner-only, no-follow, bounded,
  atomic filesystem storage and claim mechanics to reuse without reusing its plan-ID claim.
- `packages/rfmedia-cli/src/types/config.ts` and
  `packages/rfmedia-cli/src/lib/config.ts`: Optional typed configuration and bounded `CORE_SCHEMA`
  YAML parsing; strictness must be local to the new nested section to preserve legacy behavior.
- `packages/rfmedia-cli/src/lib/formatters/index.ts` and
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`: Single-document machine
  output, CSV formula neutralization, and Bash/Zsh/Fish command parity contracts.
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts` and
  `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Committed operation/wire-shape
  assertions and architecture enforcement for generated imports and direct Fetch.
- `rfmedia.example.yaml`, `packages/rfmedia-cli/README.md`,
  `packages/rfmedia-cli/CHANGELOG.md`, `ROADMAP.md`, and `docs/roadmap-archive.md`: Required public
  configuration, command, release, and issue-delivery surfaces.
- Planned new files `packages/rfmedia-cli/src/types/lidarr-presets.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/profile-presets.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`,
  `packages/rfmedia-cli/src/actions/lidarr/profile-presets.ts`, and
  `packages/rfmedia-cli/src/commands/lidarr-presets.ts`: Keep contracts, pure reconciliation,
  durable state, live orchestration, and presentation independently testable.

## Patterns to Follow

- **Dependency-Injected Command Factory**: Mirror `commands/lidarr-search.ts`; keep the parent
  command small, lazy, cycle-free, and responsible only for shared callbacks/options.
- **Framework-Independent Scheduled Action**: Mirror
  `actions/lidarr/plan-artist-profiles.ts`; validate local input before client resolution and
  declare fresh-read versus destructive execution metadata explicitly.
- **Private Generated Facade**: Extend `lib/lidarr/client.ts` with narrow rich-definition methods
  instead of widening `listQualityProfiles()`. Generated types and the PUT string-ID quirk stay
  private, while `transport.ts` retains all authentication and origin-security behavior.
- **Bounded Frozen Projection**: Mirror `lib/lidarr/types.ts`; treat complete wire collections,
  dynamic schemas, naming examples, and recursive quality trees as hostile `unknown`, reject
  malformed or ambiguous authorization state, and return copied frozen domain values.
- **Pure Deterministic Reconciliation**: Put exact pack resolution, portable-name normalization,
  body intent, canonicalization, and create/update/unchanged/retained classification in the pure
  preset engine. Preserve behaviorally significant order and explicit falsy/empty values.
- **Review-First Sequential Convergence**: Reuse the principles in `actions/lidarr/apply.ts`;
  complete preflight precedes approval, every write receives a fresh drift check and semantic
  read-back, and stale/failed/uncertain/non-durable results stop every later admission.
- **Owner-Only Atomic State**: Reuse `lib/lidarr/plan-engine.ts` storage hardening, but key a
  dedicated lock by `sha256(canonicalOrigin)` and persist bounded full-file journal transitions
  under a separate preset namespace.
- **Human/Machine Stream Separation**: Human review and progress use stderr; JSON/YAML emit one
  versioned stdout document; CSV uses a fixed spreadsheet-safe row union. Completion remains
  static, offline, and explicitly synchronized across Bash, Zsh, and Fish.

## Cross-Cutting Concerns

- Shared profile, format, and naming changes have library-wide impact: retain unrelated resources
  and undeclared scores, report assignment/reference impact, require complete review and explicit
  approval, and provide no delete, prune, rename, reassignment, or force-stale path.
- Config and live API data require exact-key, byte/depth/count/tree/result bounds; Unicode-safe
  duplicate detection; terminal-control rejection; conservative regex validation; naming token
  and path-safety checks; and live-schema intersection for the four allowed custom-format
  implementations.
- Correctness depends on fresh state, not the resilience cache or SQLite. GETs may use bounded
  safe-read retries, but POST/PUT must never be hot-retried; ambiguous dispatch requires bounded
  read-back and an `uncertain` outcome.
- Credentials, raw headers/bodies, environment values, arbitrary causes, and unsanitized text must
  not reach output, digests, resource keys, lock names, or journals. Preserve header-only API-key
  injection, redirect rejection, same-origin confinement, cancellation, and bounded bodies.
- Tests must prove zero writes and zero lock/journal effects for `list`, `show`, `diff`, dry-run,
  cancellation before dispatch, rejected approval, and converged apply; also prove exact write
  order, unmanaged-score preservation, drift blocking, interruption cleanup, partial durability,
  and second-run convergence.

## Parallelization Opportunities

- Freeze shared contracts, limits, stable errors, fixtures, and output versions first; afterward,
  built-in/config parsing and rich wire projector/facade work can proceed independently against
  those contracts.
- Offline registry validation plus `list`/`show` presentation can overlap facade GET/schema
  integration because it must not depend on a live client.
- Projector/facade tests, config tests, pure diff fixtures, and filesystem persistence tests can be
  developed in parallel once their domain interfaces and limits are fixed.
- After action/result shapes stabilize, command/presenter tests, Bash/Zsh/Fish completion updates,
  docs/examples, architecture checks, and changelog/roadmap work can run concurrently.
- The live diff action depends on both the pure engine and facade reads; safe apply additionally
  depends on diff, facade writes, and persistence. Do not parallelize the mutation pipeline itself.

## Implementation Constraints

- V1 must ship exactly `balanced@1`, `lossless@1`, and `space-saver@1`, plus strict self-contained
  configured packs, and must manage complete quality profiles, real custom formats/scores, and the
  complete persisted naming policy.
- Support only `list`, `show`, `diff`, and `apply`; explicit `builtin:<id>` and `config:<id>`
  references disambiguate collisions. Unqualified IDs are valid only when unique.
- Do not extend `rfmedia.lidarr-plan.v2`, add a generic reconciliation/workflow framework, add a
  new database schema, use deferred mutation replay, fetch remote packs, or introduce a new runtime
  dependency. Patch direct `js-yaml`; refresh generated code only if contract tests prove the
  committed operations are insufficient.
- `list`/`show` are offline, `diff` is read-only, and `apply --dry-run` performs the full live
  preflight with no API mutation, lock-authorized mutation, or journal write. A valid no-change
  diff succeeds; a converged apply neither writes nor prompts.
- Capability probing, whole-state validation, same normalized-name adoption, and fresh
  per-resource drift checks are mandatory. No fuzzy matching, automatic rollback, cached/stale
  authorization state, bulk/delete endpoint, or multi-host coordination is in scope.
- Profile writes must include every current custom format exactly once and preserve undeclared
  live scores; naming examples are sanitized advisory evidence, while PUT plus fresh GET is
  authoritative.

## Key Recommendations

- Organize implementation by dependency depth: contracts/config/built-ins → bounded
  projectors/facade → pure resolver/semantic diff → offline commands and live diff → lock/journal
  and verified apply → command/completion/docs/release integration.
- Freeze representative supported-Lidarr fixtures before policy coding so built-in qualities,
  groups, cutoffs, conditions, scores, and naming tokens are real rather than placeholders; stop
  and revise the spec if committed fixtures or generated operations cannot support the frozen
  scope.
- Keep the pure engine free of Commander, networking, scheduling, and filesystem concerns; keep
  the action responsible for fresh reads, impact analysis, lock lifetime, approval-ready results,
  ordered writes, journaling, interruption, and recovery classification.
- Treat persistence as part of mutation admission: durably record intent before dispatch, record
  pre-dispatch state before each write, verify remotely, then durably record the outcome. Any
  ownership or journal failure prevents or stops later writes.
- Make acceptance evidence explicit per layer and finish with focused Vitest suites, typecheck,
  build, `codegen:lidarr:check`, architecture checks/tests, completion parity, markdown/Prettier,
  dependency audit, `git diff --check`, and a second-run zero-mutation integration case.
