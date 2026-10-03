# Task Structure Analysis: lidarr-quality-presets

## Executive Summary

Implement issue #213 as a dependency-ordered vertical slice with three early parallel foundations:
strict local contracts/config, bounded Lidarr wire projection/facade support, and the pure preset
registry/diff engine. Join those branches before live orchestration, then build the apply state
machine, command surface, completions, and documentation in sequence. Keep every implementation
task to one to three closely related files and use contract-critical tests at each boundary so
parallel agents do not edit the same source.

## Recommended Phase Structure

### Phase 0: Dependency and Contract Baseline

- **T01 — Domain contracts and exports**: Create the generated-independent preset, live state,
  diff, output, and apply-outcome types. This freezes names and data ownership before downstream
  work.
- **T02 — Patch the YAML dependency**: Upgrade the existing direct `js-yaml` dependency and lockfile
  entry to the patched supported release. This is independent of T01 and can run in parallel.

### Phase 1: Parallel Foundations

Begin after T01; T03, T04, and T05 have disjoint file ownership and can run concurrently.

- **T03 — Strict configured-pack validation**: Add optional `lidarr.profilePresets` typing, exact
  nested-key validation, input bounds, and compatibility when the section is absent.
- **T04 — Rich bounded wire projectors**: Project quality-profile/schema, custom-format/schema, and
  naming/example responses from `unknown` into frozen preset-domain values.
- **T05 — Pure registry, validation, and diff engine**: Implement the three immutable built-ins,
  qualified pack resolution, portable validation, canonical body intent, field ordering, and
  deterministic create/update/unchanged/retain diff.

### Phase 2: Lidarr Facade Contract

- **T06 — Facade, resilience, and mock seam**: Add all rich read/write methods to
  `LidarrClientApi`/`LidarrClient`, mirror them in the resilience decorator and typed action mock,
  allowlist only the new GETs, and leave every POST/PUT without hot retry. Depends on T04.
- **T07 — Facade and generated-contract tests**: Pin method/path/body/envelope behavior, malformed
  projection rejection, ID conversion confinement, read retry classification, and mutation
  non-retry behavior. Depends on T06; it may run in parallel with final T05 work only if T05 no
  longer changes shared types.

### Phase 3: Live Reconciliation

- **T08 — Offline actions and live diff orchestration**: Export list/show/diff entrypoints; resolve
  config before I/O, capability-probe fresh live resources through the scheduler, collect bounded
  artist impact, and delegate deterministic comparison to the pure engine. Prove list/show stay
  offline and diff/dry-run perform zero writes or state-file operations. Depends on T03, T05, T06,
  and T07.
- **T09 — Verified apply state machine**: Extend the same action boundary with the
  canonical-origin lock, bounded owner-only journal, final under-lock preflight, ordered custom
  format → refreshed catalog/schema → quality profile → naming mutation, immediate drift checks,
  read-back, durable outcomes, interruption handling, uncertainty classification, stop admission,
  and second-run convergence. Depends on T08 and is intentionally serial.

### Phase 4: Public CLI and Completion Parity

- **T10 — Preset command factory and registration**: Add `list`, `show`, `diff`, and `apply`
  Commander leaves; human review/prompt rendering; versioned JSON/YAML envelopes; fixed-union CSV;
  redacted failures; and registration from `lidarr.ts`. Depends on T09 so output reflects the final
  action contract.
- **T11 — Bash/Zsh/Fish completion templates**: Add the frozen `presets` subtree and relevant flags
  to all three static scripts. This can run in parallel with T10 only after command names and flags
  are frozen and no command source is edited.
- **T12 — Command and completion parity tests**: Verify Commander help/registration, approval rules,
  human-stderr versus machine-stdout behavior, CSV columns, offline completion generation, and
  exact Bash/Zsh/Fish parity. Depends on T10 and T11.

### Phase 5: Operator Documentation and Closeout

- **T13 — Feature and usage documentation**: Add the configured-pack example, feature guide, and
  README command reference after pack contents, flags, output contracts, and recovery behavior are
  stable.
- **T14 — Release tracking documentation**: Update the package changelog, ROADMAP issue state, and
  roadmap archive with the final implementation/PR reference. Defer final identifiers until the PR
  exists; do not let this task block source validation.
- **T15 — Repository validation and graph refresh**: Run targeted critical tests from earlier
  tasks, TypeScript checking, generated-client drift check, architecture checks, build,
  shell-completion parity, markdown formatting, `git diff --check`, and `graphify update .`. Fix
  failures in the owning task files instead of creating a broad cleanup task.

## Task Granularity Recommendations

| Task | File ownership (one to three files)                                                                                      | Critical acceptance evidence                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| T01  | `src/types/lidarr-presets.ts`, `src/types/index.ts`                                                                      | Typecheck of exhaustive discriminated contracts                                     |
| T02  | `packages/rfmedia-cli/package.json`, `package-lock.json`                                                                 | Installed direct parser resolves to patched version                                 |
| T03  | `src/types/config.ts`, `src/lib/config.ts`, `src/lib/config.test.ts`                                                     | Absent-section compatibility plus hostile/unknown/bounded config rejection          |
| T04  | `src/lib/lidarr/types.ts`, `src/lib/lidarr/types.test.ts`                                                                | Representative rich fixtures accepted; malformed whole responses rejected           |
| T05  | `src/lib/lidarr/profile-presets.ts`, `src/lib/lidarr/profile-presets.test.ts`                                            | Three real packs validate; create/update/no-op/retain and ordering fixtures         |
| T06  | `src/lib/lidarr/client.ts`, `src/lib/lidarr/resilience.ts`, `src/actions/test-helpers/lidarr-client-mocks.ts`            | Compiling complete facade; reads classified, writes non-retried                     |
| T07  | `src/lib/lidarr/client.test.ts`, `src/lib/lidarr/resilience.test.ts`, `src/lib/lidarr/generated-contract.test.ts`        | Endpoint, body, isolation, retry, and generated contract assertions                 |
| T08  | `src/actions/lidarr/profile-presets.ts`, `src/actions/lidarr/profile-presets.test.ts`, `src/actions/lidarr/index.ts`     | Offline list/show and fresh deterministic zero-write diff                           |
| T09  | `src/actions/lidarr/profile-presets.ts`, `src/actions/lidarr/profile-presets.test.ts`                                    | Ordered writes, stale stop, uncertainty, durable journal, interruption, convergence |
| T10  | `src/commands/lidarr-presets.ts`, `src/commands/lidarr.ts`, `src/commands/lidarr.test.ts`                                | Four leaves, approval/no-op behavior, output and error contracts                    |
| T11  | `src/lib/shell-completions/bash.ts`, `src/lib/shell-completions/zsh.ts`, `src/lib/shell-completions/fish.ts`             | Generated scripts expose the same frozen subtree                                    |
| T12  | `src/lib/shell-completions/templates.spec.ts`, `src/commands/lidarr.test.ts`                                             | Exact three-shell parity and side-effect-free generation                            |
| T13  | `rfmedia.example.yaml`, `packages/rfmedia-cli/README.md`, `packages/rfmedia-cli/docs/features/lidarr-quality-presets.md` | Exact pack/config/command/recovery documentation                                    |
| T14  | `packages/rfmedia-cli/CHANGELOG.md`, `ROADMAP.md`, `docs/roadmap-archive.md`                                             | Issue and PR tracking agree with delivered scope                                    |

Paths in the table are repository-relative; `src/...` paths are under
`packages/rfmedia-cli/`. T08 and T09 deliberately share the action and test files and therefore
must be sequential. T10 and T12 also share `commands/lidarr.test.ts`; T12 may add only parity and
side-effect assertions after T10 completes.

Avoid splitting one semantic feature across many tiny files merely to manufacture concurrency.
In particular, keep the three built-in packs beside their normalization/digest contract in T05,
and keep lock/journal transitions beside apply admission in T09 unless the file becomes
unreviewable. If extraction is necessary, create at most one action-internal state helper plus its
test and keep it within T09's three-file limit; do not move persistence into the pure engine.

## Dependency Analysis

```text
T01 ─┬─> T03 ───────────────┐
     ├─> T04 ─> T06 ─> T07 ├─> T08 ─> T09 ─> T10 ─┬─> T12 ─> T15
     └─> T05 ───────────────┘                     │
T02 ──────────────────────────────────────────────┤
                                                  └─> T13 ─┐
T10 (frozen flags) ─> T11 ─────────────────> T12          ├─> T15
T13 + final PR identity ───────────────────────────> T14 ──┘
```

- **Hard joins**: Do not begin T08 until configured packs, pure semantics, and the complete
  facade/resilience seam agree on the frozen domain contracts. Do not begin real apply before the
  diff result is authoritative and zero-write behavior is proven.
- **Serialization points**: T06 must update the facade interface, resilience wrapper, and mock in
  one task to avoid a deliberately uncompilable intermediate interface. T08 → T09 and T10 → T12
  share files and must not be assigned concurrently.
- **Soft dependencies**: T02 can run at any early point. T13 can draft stable conceptual material
  after T05, but exact commands/examples should be finalized only after T10. T14 requires the
  actual final issue/PR state.
- **No generated-code dependency**: The committed generated SDK already contains the endpoints.
  A failed T07 contract is a stop-and-revise gate, not authorization to refresh OpenAPI or edit
  generated files.

## File-to-Task Mapping

### New Files

- `packages/rfmedia-cli/src/types/lidarr-presets.ts` → T01
- `packages/rfmedia-cli/src/lib/lidarr/profile-presets.ts` and
  `profile-presets.test.ts` → T05
- `packages/rfmedia-cli/src/actions/lidarr/profile-presets.ts` and
  `profile-presets.test.ts` → T08, then T09
- `packages/rfmedia-cli/src/commands/lidarr-presets.ts` → T10
- `packages/rfmedia-cli/docs/features/lidarr-quality-presets.md` → T13

### Existing Runtime Files

- Config types/parser/tests → T03
- Lidarr projectors/tests → T04
- Lidarr client, resilience decorator, and typed mock → T06
- Lidarr action barrel → T08
- Lidarr command namespace → T10
- Shared formatter remains unchanged unless T10 proves the fixed-row CSV cannot be expressed;
  formula neutralization already exists.
- Transport remains unchanged; all new calls pass through the existing generated client and
  hardened transport.

### Existing Contract and Surface Files

- Client/resilience/generated-contract tests → T07
- Bash/Zsh/Fish templates → T11
- Completion parity and command tests → T12
- Dependency manifests → T02
- Example config/feature docs/README → T13
- Changelog/ROADMAP/archive → T14
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` remains an unchanged validation gate
  unless T15 exposes a missing generic boundary rule; do not edit it preemptively.

## Optimization Opportunities

- Run T03, T04, and T05 in parallel after T01 because their file sets are disjoint. Their tests
  should use small representative fixtures rather than a combinatorial suite.
- Run T02 concurrently with any foundation work; it has no TypeScript source overlap.
- During T08, fetch independent safe-read catalogs in a bounded scheduler batch, but preserve
  deterministic result sorting after the reads complete.
- Keep all writes serial even if Lidarr exposes bulk endpoints. Fresh schema/catalog refreshes are
  explicit stage barriers, not optimization targets.
- Reuse the existing formatter's CSV formula neutralization, scheduler, canonical origin resolver,
  transport, error taxonomy, signal cleanup, and safe filesystem techniques. Do not introduce a
  second SDK, parser, diff engine, workflow framework, regex engine, or database.
- Let T11 proceed beside late T10 presenter work only once names and flags are frozen; its file set
  is disjoint. T13 can also draft in parallel at that point.
- Validate locally at each boundary with the narrowest high-value test file. Reserve full package
  build/type/architecture/codegen checks for T15 and CI, matching the requirement to add only
  contract-critical tests.

## Implementation Strategy Recommendations

1. Freeze T01 before parallel work. Domain resource keys, outcome states, stable schema versions,
   and exact output fields are the shared protocol between every layer.
2. Treat T05 as policy code, not sample data. Derive every quality, cutoff, condition, score, and
   naming token from committed representative Lidarr fixtures and fail the task if a real pack
   cannot be expressed.
3. Land the facade as one compile-safe change in T06. Generated types never escape `client.ts`;
   path-ID string conversion stays there; projectors receive `unknown`; only GETs enter the retry
   allowlist.
4. Make T08 the safety gate for T09. The complete semantic diff and impact model must be fresh,
   deterministic, bounded, and demonstrably write/state-file free before mutation code exists.
5. Implement T09 as a small explicit state machine rather than a generic reconciler. Acquire the
   canonical-origin lock only for real changing apply, repeat preflight under the lock, classify
   dispatch uncertainty through read-back, persist each terminal outcome before admitting the
   next resource, and recover only through a fresh convergence rerun.
6. Keep Commander out of actions and rendering out of domain logic. T10 should inject shared
   callbacks from `lidarr.ts`, lazy-load actions, prompt once with default-no, reject unapproved
   machine/non-TTY apply, and preserve stderr/stdout separation.
7. Audit the public surface as one unit: Commander help, JSON/YAML/CSV schema, Bash/Zsh/Fish
   completions, example config, README, feature guide, changelog, ROADMAP, and architecture gates
   must all describe the same four commands and non-effects.
8. Stop rather than silently reduce scope if the committed generated contract, representative
   fixture qualities/tokens, or current safe storage primitives cannot meet the frozen spec.
