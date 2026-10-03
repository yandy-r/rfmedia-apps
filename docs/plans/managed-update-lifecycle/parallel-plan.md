# Managed Update Lifecycle Implementation Plan

Implement issue #148 as a thin `rfapps update` command and action backed by a typed, sequential lifecycle coordinator. Strengthen image detection, Docker identity inspection, target health verification, generation persistence, and exact-image recreation before composing them into preview, apply, verify, and restore phases. Preserve ordinary plan/apply/rollback behavior while introducing a separate secret-free managed-plan contract and a single versioned result document. Complete the slice with integration tests, compatibility surfaces, documentation, ROADMAP closure, PR review, and CI evidence.

## Worktree Setup

- **Parent**: `/home/yandy/.codex-worktrees/rfmedia-apps-issue-148/` (branch: `feat/148-managed-update-lifecycle`)

## Critically Relevant Files and Documentation

- `docs/plans/managed-update-lifecycle/feature-spec.md`: Source-of-truth acceptance criteria and safety invariants.
- `docs/plans/managed-update-lifecycle/shared.md`: Verified codebase paths, patterns, tables, and required reading.
- `docs/plans/managed-update-lifecycle/research-security.md`: Mutable-tag, secret-persistence, TOCTOU, and path threat model.
- `packages/rfapps-cli/src/lib/plan-generator.ts`: Existing registry update detection and Compose plan generation.
- `packages/rfapps-cli/src/lib/docker.ts`: Docker/Compose execution and identity inspection boundary.
- `packages/rfapps-cli/src/lib/health.ts`: Existing dependency readiness polling.
- `packages/rfapps-cli/src/lib/state-storage.ts`: Transactional deployment and generation persistence.
- `packages/rfapps-cli/src/actions/plan.ts`: Config, targeting, rendering, and output pattern.
- `packages/rfapps-cli/src/actions/rollback.ts`: Existing generation restore behavior to harden and reuse.
- `packages/rfapps-cli/src/actions/completion.ts`: Shell compatibility surface.
- `.github/workflows/rfapps-cli.yml`: Required build, typecheck, and coverage gates.
- `.github/pull_request_template.md`: Required PR body and verification evidence.

## Implementation Plan

### Phase 1: Contracts, schema, and safe persistence

#### Task 1.1: Define managed-update and plan contracts Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/feature-spec.md`
- `packages/rfapps-cli/src/types/plan.ts`
- `packages/rfapps-cli/src/types/index.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/types/update.ts`

Files to Modify

- `packages/rfapps-cli/src/types/plan.ts`
- `packages/rfapps-cli/src/types/index.ts`

Define discriminated `ImageUpdateStatus`, `ManagedUpdatePlan` (`update-plan.v1`, `managed-update`), per-service lifecycle outcomes, verification/restore evidence, and `ManagedUpdateResult` (`update.v1`). Preserve legacy `ImageUpdateCheck.updateAvailable` compatibility while preventing unknown/missing/unsupported states from collapsing to current. Model apply/restore policies, reviewed identities, drift failures, interruption, and aggregate exit semantics without `any` or ambiguous optional booleans. Export the public contracts and run the package typecheck.

#### Task 1.2: Migrate SQLite to immutable image identity Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/analysis-integration.md`
- `packages/rfapps-cli/src/lib/schema.sql`
- `packages/rfapps-cli/src/lib/migrations.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/lib/schema.sql`
- `packages/rfapps-cli/src/lib/migrations.ts`
- `packages/rfapps-cli/src/lib/migrations.spec.ts`

Bump the schema to version 3 and add nullable `image_id` and `image_digest` columns to `deployments` and `generations`. Add a transactional v2-to-v3 migration and update the CLI/schema compatibility map without backfilling legacy rows. Test clean initialization, upgrading a real v2 shape, rollback on migration failure, repeated initialization, and readability of legacy null identity fields.

#### Task 1.3: Extend deployment persistence for update identities Depends on [1.2]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/types/state.ts`
- `packages/rfapps-cli/src/lib/state-storage.ts`
- `packages/rfapps-cli/src/lib/state-storage.spec.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/types/state.ts`
- `packages/rfapps-cli/src/lib/state-storage.ts`
- `packages/rfapps-cli/src/lib/state-storage.spec.ts`

Add `update` to deployment/generation action unions and add nullable `imageId`/`imageDigest` to public records and write inputs. Extend insert and row-mapping logic so deployment and successful generation writes remain one transaction. Ensure failed attempts can be recorded without a generation and verified update/restore states can carry exact identity evidence. Test transaction rollback, nullable legacy fields, and update action writes.

#### Task 1.4: Extend generations and history queries Depends on [1.2, 1.3]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/lib/generations.ts`
- `packages/rfapps-cli/src/lib/state-queries.ts`
- `packages/rfapps-cli/src/types/state.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/lib/generations.ts`
- `packages/rfapps-cli/src/lib/generations.spec.ts`
- `packages/rfapps-cli/src/lib/state-queries.ts`

Carry `imageId` and `imageDigest` through generation inserts, selects, action allowlists, and history row mapping. Preserve readability of old rows and expose enough information to distinguish exact-restore-eligible generations from legacy tag-only generations. Add focused generation tests here; leave broader history query assertions for Task 1.5.

#### Task 1.5: Verify backward-compatible state reads Depends on [1.4]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/lib/state-queries.ts`
- `packages/rfapps-cli/src/lib/state-queries.spec.ts`
- `packages/rfapps-cli/src/lib/generations.spec.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/lib/state-queries.spec.ts`

Add read-side coverage for update actions, populated immutable identity fields, legacy null fields, filters, ordering, and unchanged ordinary deployment history. Confirm row aliases map snake_case storage to camelCase public contracts consistently.

#### Task 1.6: Add secure managed-plan persistence Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/research-security.md`
- `packages/rfapps-cli/src/lib/plan-storage.ts`
- `packages/rfapps-cli/src/lib/plan-storage.spec.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/lib/plan-storage.ts`
- `packages/rfapps-cli/src/lib/plan-storage.spec.ts`

Add distinct runtime-validated, allowlisted serialization paths for managed plans and final `update.v1` reports. Exclude resolved environment values, connection credentials, and unbounded subprocess output; cap reads, reject unsafe paths and symlinks, write through a private temporary file plus atomic rename, and enforce `0700` parent/`0600` file permissions where supported. Define report output-path/overwrite semantics so `--out` cannot target an unsafe file, and keep ordinary deployment-plan save/load behavior compatible. Test secret absence in both artifact kinds, malformed/oversized input, wrong schema or intent, traversal/symlink rejection, atomic replacement, permissions, and legacy plan round trips.

### Phase 2: Detection, identity, health, and recovery primitives

#### Task 2.1: Make registry detection explicit and platform-aware Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/analysis-patterns.md`
- `packages/rfapps-cli/src/lib/plan-generator.ts`
- `packages/rfapps-cli/src/lib/plan-generator.spec.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/lib/plan-generator.ts`
- `packages/rfapps-cli/src/lib/plan-generator.spec.ts`

Return the exact stable `update-available`/`up-to-date`/`unsupported`/`local-missing`/`unknown` outcomes with canonical image, repository digest, selected platform, and bounded/redacted error classification. Deduplicate checks by canonical image and platform. Preserve the optional compatibility boolean for ordinary plan/MCP consumers, but never map lookup failure to `up-to-date`. Add tests for auth, not-found, timeout/rate-limit, unsupported/build-only, local missing, multi-platform selection, and mixed aggregate results.

#### Task 2.2: Add immutable Docker identity and targeted recreation Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/research-security.md`
- `packages/rfapps-cli/src/lib/docker.ts`
- `packages/rfapps-cli/src/lib/docker.spec.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/lib/docker.ts`
- `packages/rfapps-cli/src/lib/docker.spec.ts`

Extend typed image/container inspection with daemon-local image ID, configured image, normalized repository digest, platform, state, exit code, and Docker health. Match `RepoDigests` by repository instead of taking entry zero and keep local IDs distinct from registry/index/config digests. Probe and cache required Compose digest-resolution/wait capabilities with an actionable unsupported result across known version variance. Pull the reviewed immutable repository digest through the private override, verify the resulting local image identity, then recreate one validated service using `up -d --force-recreate --pull never SERVICE`, with no `--remove-orphans`; never pull the mutable configured tag after approval and clean the override in `finally`. Assert exact argv, capability fallbacks, multi-file Compose order, env-tool propagation, safe service-name/path handling, identity mismatch, and cleanup on failure.

#### Task 2.3: Verify the target service, not only dependencies Depends on [none]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/types/health.ts`
- `packages/rfapps-cli/src/lib/health.ts`
- `packages/rfapps-cli/src/lib/health.spec.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/types/health.ts`
- `packages/rfapps-cli/src/lib/health.ts`
- `packages/rfapps-cli/src/lib/health.spec.ts`

Add target-aware readiness polling that verifies the expected local image ID, running/non-restarting state, successful exit evidence, and Docker health when configured. For services without a healthcheck, require a bounded stable-running interval and label the result `running-only`; retain dependency readiness as supplementary evidence. Use injectable time/poll dependencies and test healthy, unhealthy, wrong-image, exited, restarting, timeout, leaf target, dependency failure, and stable-running paths.

#### Task 2.4: Add project/context lifecycle locking Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/research-security.md`
- `packages/rfapps-cli/src/lib/plan-storage.ts`
- `packages/rfapps-cli/src/lib/db.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/lib/lifecycle-lock.ts`
- `packages/rfapps-cli/src/lib/lifecycle-lock.spec.ts`

Implement an exclusive lock keyed by canonical project path plus Docker context for the entire revalidate/mutate/verify/restore window. Use private state paths, atomic exclusive acquisition, bounded metadata, stale-lock diagnostics without unsafe automatic takeover, and idempotent release in `finally`. Test contention, different projects/contexts, malformed metadata, symlink/path safety, interruption cleanup, and double release.

#### Task 2.5: Reuse exact-image recreation in manual rollback Depends on [1.4, 2.2]

**READ THESE BEFORE TASK**

- `docs/features/deployment-rollback.md`
- `packages/rfapps-cli/src/actions/rollback.ts`
- `packages/rfapps-cli/src/actions/rollback.spec.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/actions/rollback.ts`
- `packages/rfapps-cli/src/actions/rollback.spec.ts`

Use the shared immutable recreation helper when the selected generation contains a daemon-local image ID, then verify the recreated container identity. Preserve explicit best-effort tag behavior for legacy manual rollbacks and clearly label it; automatic managed restore will never use this fallback. Ensure rollback remains targeted, never removes orphans, preserves confirmation/output conventions, and records only verified successful states.

### Phase 3: Sequential lifecycle and CLI integration

#### Task 3.1: Implement the managed lifecycle coordinator Depends on [1.3, 1.4, 1.6, 2.1, 2.2, 2.3, 2.4]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/feature-spec.md`
- `docs/plans/managed-update-lifecycle/analysis-integration.md`
- `packages/rfapps-cli/src/types/update.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/lib/managed-update.ts`
- `packages/rfapps-cli/src/lib/managed-update.spec.ts`

Files to Modify

- `packages/rfapps-cli/src/lib/index.ts`

Implement data-returning `generateManagedUpdatePlan()` and `runManagedUpdate()` with injected Docker, state, health, clock, lock, signal, and filesystem dependencies. Preview must not acquire a long-held mutation lock, pull, recreate, restore, or write generations. Apply must lock, revalidate Compose hash/context/current local image/platform/proposed digest, durably record pre-update recovery identity before pull, update and verify one service at a time, and record versioned per-service evidence. When restore-on-failure is enabled, a missing exact daemon-local recovery image ID is a hard preflight failure before mutation; only explicit `--no-restore-on-failure` may proceed in reduced-safety mode. On verification failure, restore the exact captured local image by default and verify it; continue after verified restore while retaining aggregate failure, stop after restore failure, and stabilize the active unit on interruption. Release locks, database resources, and temporary files in `finally`; never print or set process globals. Cover no-op, mixed unknown, drift, missing recovery identity with/without restore, success, verified restore, disabled restore, restore failure, write failure, and interruption transitions.

#### Task 3.2: Add the interactive update action Depends on [3.1]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/actions/plan.ts`
- `packages/rfapps-cli/src/actions/apply.ts`
- `packages/rfapps-cli/src/lib/managed-update.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/actions/update.ts`
- `packages/rfapps-cli/src/actions/update.spec.ts`

Normalize targeting, Compose/env/profile/sidecar, plan input/output, restore policy, timeout, and secret-tool options. Reuse config and service/group resolution, initialize/close state around lifecycle calls, show an image-only recovery warning, prompt exactly once for mutation, and suppress prompts in machine mode. Persist `--out` through the validated private/atomic managed artifact writer: preview writes `update-plan.v1`, apply writes the final `update.v1` report, and unsafe/ambiguous overwrite requests fail before mutation. Emit progress on stderr and exactly one `update.v1` document on stdout for JSON/YAML; map invalid input/plan to exit 2 and any unknown/update/verification/restore failure to exit 1, including verified restore. Test preview/apply output files and redaction, approval decline, `--apply --yes`, saved-plan targeting conflicts, machine output purity, dry-run interaction, config overrides, and cleanup.

#### Task 3.3: Register the `rfapps update` command Depends on [3.2]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/commands/doctor.ts`
- `packages/rfapps-cli/src/cli.ts`
- `packages/rfapps-cli/src/actions/update.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/commands/update.ts`

Files to Modify

- `packages/rfapps-cli/src/cli.ts`

Register `update` with service/group selection, `--check-updates`-equivalent preview behavior, `--apply`, `--from-plan`, `--out`, `--no-restore-on-failure`, `--health-timeout`, Compose/env/profile/sidecar overrides, and inherited global output, dry-run, yes, and secret-tool options. Make bare invocation preview-only, reject incompatible option combinations with `InvalidArgumentError`, lazy-load the action, and ensure help text states image-only recovery and exit behavior.

#### Task 3.4: Route managed plans away from ordinary apply Depends on [1.1, 1.6]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/actions/apply.ts`
- `packages/rfapps-cli/src/actions/apply.spec.ts`
- `packages/rfapps-cli/src/lib/plan-storage.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/actions/apply.ts`
- `packages/rfapps-cli/src/actions/apply.spec.ts`

Reject managed-update intent before ordinary apply mutation and direct users to `rfapps update --from-plan <path> --apply`. Ensure `--force` cannot bypass the managed boundary and legacy ordinary plans without intent remain accepted. Add tests for managed plans, malformed intent, force, legacy plan, and no mutation before rejection.

#### Task 3.5: Extend read-side MCP compatibility only Depends on [1.1, 1.3]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/analysis-integration.md`
- `packages/rfapps-cli/src/mcp/schema.ts`
- `packages/rfapps-cli/src/mcp/schema.spec.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/mcp/schema.ts`
- `packages/rfapps-cli/src/mcp/schema.spec.ts`

Allow optional plan intent/update-status fields and `update`, `imageId`, and `imageDigest` in existing read results while keeping legacy fields optional. Do not add a managed update mutation tool in v1. Test old and new payloads plus rejection of invalid discriminator combinations.

#### Task 3.6: Add shell completion coverage Depends on [3.3]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/actions/completion.ts`
- `packages/rfapps-cli/src/actions/completion.spec.ts`
- `packages/rfapps-cli/src/commands/update.ts`

**Instructions**

Files to Modify

- `packages/rfapps-cli/src/actions/completion.ts`
- `packages/rfapps-cli/src/actions/completion.spec.ts`

Add `update` and every command-specific option to Bash, Zsh, and Fish completion generation without changing existing command output. Update exact fixtures/snapshots and verify service/group/path options receive appropriate completion behavior.

### Phase 4: End-to-end verification and documentation

#### Task 4.1: Exercise the full lifecycle through the CLI Depends on [2.5, 3.2, 3.3, 3.4, 3.5, 3.6]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/feature-spec.md`
- `packages/rfapps-cli/src/actions/update.spec.ts`
- `packages/rfapps-cli/src/lib/managed-update.spec.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/managed-update.integration.spec.ts`

Add an integration-style test harness around the command/action/coordinator boundaries with fake Docker and isolated SQLite/filesystem state. Cover preview immutability, no-op, mixed known/unknown detection, stale-plan rejection, successful sequential multi-service apply, failed verification with exact verified restore, restore-disabled failure, restore-failure stop, interruption stabilization, secret-free persisted plans/results, ordinary apply rejection, and machine output/exit codes. Assert no lifecycle path emits `--remove-orphans` and no automatic restore uses a tag.

#### Task 4.2: Prove targeted update and restore with disposable Compose Depends on [2.2, 2.3, 3.1, 4.1]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/feature-spec.md`
- `packages/rfapps-cli/src/managed-update.integration.spec.ts`
- `.github/workflows/rfapps-cli.yml`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/managed-update.compose.integration.spec.ts`
- `packages/rfapps-cli/test/fixtures/managed-update/compose.yml`
- `packages/rfapps-cli/test/fixtures/managed-update/Dockerfile`

Add an opt-in disposable local Compose smoke fixture that builds two deterministic image variants without registry credentials, exercises reviewed-identity pull/recreate and exact local-image restore, and proves target health/identity plus neighbor-container stability. Gate it with an explicit Docker-availability check so standard unit CI remains deterministic, but make the repository validation task run it when Docker is available. Assert no command contains `--remove-orphans`, the updated service uses the reviewed image, failed health restores the original local image ID, and temporary project resources are removed in teardown.

#### Task 4.3: Document command usage and plan safety Depends on [3.3, 3.4, 4.1]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/analysis-docs.md`
- `packages/rfapps-cli/README.md`
- `docs/features/plan-apply-workflow.md`

**Instructions**

Files to Modify

- `packages/rfapps-cli/README.md`
- `docs/features/quick-reference.md`
- `docs/features/plan-apply-workflow.md`

Document preview-first usage, `--apply`/confirmation, saved managed plans, service selection, sequential behavior, exit codes, output examples, drift rejection, and the image-only recovery boundary. Explain that ordinary `apply` rejects managed plans and show the correct route. Use sanitized examples and preserve markdownlint conventions.

#### Task 4.4: Document history, restore, and health Depends on [2.3, 2.5, 4.1]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/analysis-docs.md`
- `docs/features/deployment-history.md`
- `docs/features/deployment-rollback.md`

**Instructions**

Files to Modify

- `docs/features/deployment-history.md`
- `docs/features/deployment-rollback.md`
- `docs/features/service-healthchecks.md`

Describe update history rows, immutable identity fields, pre-update recovery generations, exact same-daemon automatic restore, best-effort legacy manual rollback, and volumes/data/migrations that are outside recovery scope. Distinguish target verification from dependency readiness and Docker-health from bounded running-only evidence.

#### Task 4.5: Document machine output, errors, and secrets Depends on [1.6, 3.2]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/analysis-docs.md`
- `docs/features/json-output.md`
- `docs/features/secrets-management.md`

**Instructions**

Files to Modify

- `docs/features/json-output.md`
- `docs/features/error-handling.md`
- `docs/features/secrets-management.md`

Document the `update.v1` result, one-document stdout rule, stderr progress, usage exit 2, lifecycle exit 1 (including verified restore), and no-op success. Explain the allowlisted managed artifact boundary, permissions, atomic writes, excluded resolved secrets, and safe `--out` behavior. Cross-link update command docs where helpful without exposing real values.

#### Task 4.6: Document shell completion Depends on [3.6]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/analysis-docs.md`
- `docs/features/shell-completion.md`
- `packages/rfapps-cli/src/actions/completion.ts`

**Instructions**

Files to Modify

- `docs/features/shell-completion.md`

Add `rfapps update` to the Bash, Zsh, and Fish completion documentation, list its service/group/path/enum option behavior, and keep installation/regeneration guidance accurate. Cross-link the command reference and avoid implying that completions authorize or trigger mutation.

#### Task 4.7: Update architecture and package guidance Depends on [3.1, 4.1]

**READ THESE BEFORE TASK**

- `docs/plans/managed-update-lifecycle/analysis-docs.md`
- `docs/architecture/overview.md`
- `docs/architecture/data-flow.md`

**Instructions**

Files to Modify

- `docs/architecture/overview.md`
- `docs/architecture/data-flow.md`
- `packages/rfapps-cli/CLAUDE.md`

Place managed update in the command/action/library architecture and add a concise detect-preview-lock-revalidate-snapshot-pull-recreate-verify-record-or-restore flow. Record that mutation is CLI-only, sequential, image-only, and lock-scoped; document extension points without implying scheduling, parallelism, or data rollback.

#### Task 4.8: Close roadmap and navigation Depends on [4.3, 4.4, 4.5, 4.6, 4.7]

**READ THESE BEFORE TASK**

- `ROADMAP.md`
- `README.md`
- `docs/README.md`

**Instructions**

Files to Modify

- `ROADMAP.md`
- `README.md`
- `docs/README.md`

Mark issue #148 and the Sprint 1 managed-update exit criterion complete only after implementation and tests pass. Add concise navigation to the command and relevant feature docs, preserve historical roadmap wording where appropriate, and avoid claiming volume/data rollback or unattended scheduling.

### Phase 5: Validation and delivery

#### Task 5.1: Run quality gates, review, PR, and CI Depends on [1.5, 4.1, 4.2, 4.8]

**READ THESE BEFORE TASK**

- `.github/workflows/rfapps-cli.yml`
- `package.json`
- `packages/rfapps-cli/package.json`

**Instructions**

Files to Modify

- `docs/plans/managed-update-lifecycle/parallel-plan.md`

Run `npm run build -w packages/rf-common`, `npm run typecheck --workspace packages/rfapps-cli`, `npm run test:coverage --workspace packages/rfapps-cli`, and the disposable Compose integration spec when Docker is available. Run repository formatting/linting, markdown validation, `git diff --check`, the repo's commit validator, and CLI smoke for `update --help`, preview, invalid managed-plan routing, and machine output. Trace every feature-spec acceptance criterion to a named test or validation command, refresh Graphify from an environment containing `graphify-out/graph.json`, and inspect the final diff for secrets, unrelated changes, and ordinary CLI regressions. Prepare the PR from the repository template with exact pass/fail evidence and `Closes #148`, perform a structured PR review, fix all actionable findings, rerun affected/full gates, push, monitor every required GitHub check to green, squash merge, and then clean the feature branch/worktree.

## Advice

- Treat the daemon-local image ID as the only automatic restore anchor; repository digests are audit/portability evidence, not interchangeable identifiers.
- Keep the managed-plan serializer separate from the existing full deployment plan because display masking does not prevent resolved environment values from reaching disk.
- Do not reuse `startServices()` for update or restore while it injects `--remove-orphans`; every lifecycle mutation must target exactly one validated service.
- Lock and revalidate after user approval but before the first pull. There is intentionally no force bypass for identity or context drift.
- Keep actions interactive and libraries data-oriented so unit tests can exercise every transition without process-global output or exit state.
- Unknown detection is excluded from mutation and makes the aggregate non-successful; a verified restore also returns failure because the requested update did not succeed.
- Preserve legacy generation rows and manual tag-only rollback as explicitly best effort, but never allow that fallback into automatic managed restore.
- Complete child workstreams in dependency order and keep all implementation in the single feature worktree named above.
