# Architecture Analysis: managed-update-lifecycle

## Executive Summary

Implement issue #148 as a dedicated, sequential coordinator over existing rfapps libraries. CLI and
interaction policy belong in `src/commands/update.ts` and `src/actions/update.ts`; lifecycle state
transitions belong in a new `src/lib/managed-update.ts`. The coordinator must call library functions,
not `executePlan`, `executeApply`, or `executeRollback`, because those actions own prompts, output,
database lifetimes, and `process.exitCode`.

The current plan/apply path is insufficient: `generatePlan({ checkUpdates: true })` annotates an
unchanged service with `image.updateAvailable`, while `executeApply()` selects only Compose change
types. Existing readiness evaluates dependencies, not necessarily the updated target. Existing
generations retain a mutable `imageTag`, and rollback recreates from current Compose rather than an
exact prior image. The managed lifecycle therefore needs explicit plan intent/status, immutable
identity capture and revalidation, target-aware verification, exact-image restore, and secure
plan/report persistence.

## Architecture Context

```text
src/commands/update.ts
  -> src/actions/update.ts
       config + scope resolution + preview + approval + formatting + exit mapping
       -> lib/managed-update.ts
            detect -> validate -> snapshot -> pull -> recreate -> verify
                                                     \-> restore -> verify restore
            -> plan-generator / plan-storage
            -> docker / health
            -> state-storage / generations / SQLite migration
            -> private run report
```

- Preserve the existing command/action/library separation. `actions/update.ts` owns one database
  connection in `try/finally`, all user interaction, and exactly one final machine document.
  `lib/managed-update.ts` returns typed data and never logs user-facing output or changes process
  exit state.
- Reuse `loadConfig`, `applyCliOverrides`, `resolveServicesWithInteractive`, and existing
  service/profile/sidecar expansion so detection, apply, verification, and reporting use one frozen
  resolved scope. A saved managed plan must reject targeting overrides.
- Extend `generatePlan()` with managed-update intent and explicit per-service detection status.
  Preserve ordinary deployment-plan behavior. Generic `apply` must reject managed-update plans and
  direct the caller to `rfapps update --from-plan ... --apply`.
- Execute candidates one at a time. The per-service mutation boundary is:
  `revalidate -> durable snapshot -> pull -> recreate with --pull never -> target/dependency verify`.
  Continue after a verified restore but retain a failed aggregate outcome; stop after restore
  failure.
- Treat the local Docker image ID from `ContainerInspect.Image` as the same-daemon restore identity.
  Keep repository/manifest digest separately for audit and registry comparison; never compare an
  image ID, config digest, platform manifest digest, and index digest as interchangeable values.
- Restore through a temporary Compose override containing only
  `services.<service>.image: sha256:<image-id>`, layered after the current Compose file. Recreate only
  the recovery unit with `--force-recreate --pull never`; do not rewrite checked-in Compose or claim
  to restore volumes, databases, or migrations.

## Critical Files Reference

| Path                                                                             | Current role                                            | Required architecture change                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfapps-cli/src/commands/update.ts`                                     | New command module                                      | Register update-specific flags and forward parsed options only.                                                                                                                                                                       |
| `packages/rfapps-cli/src/cli.ts`                                                 | Root Commander registration                             | Register the update command and preserve global `--yes`, `--dry-run`, secrets, and output conventions.                                                                                                                                |
| `packages/rfapps-cli/src/actions/update.ts`                                      | New action boundary                                     | Resolve config/scope, preview, approval, DB lifetime, report persistence, formatting, and exit-code mapping.                                                                                                                          |
| `packages/rfapps-cli/src/lib/managed-update.ts`                                  | New lifecycle coordinator                               | Implement the project lock and sequential service state machine with injected test seams.                                                                                                                                             |
| `packages/rfapps-cli/src/types/update.ts`                                        | New domain contract                                     | Add versioned plan/result DTOs, stages, outcomes, stable error codes, identity evidence, generations, final health, and durations.                                                                                                    |
| `packages/rfapps-cli/src/types/plan.ts`                                          | Deployment plan and image diff                          | Add backward-compatible plan intent/schema and explicit `update-available`, `up-to-date`, `unsupported`, `local-missing`, and `unknown` classification.                                                                               |
| `packages/rfapps-cli/src/lib/plan-generator.ts`                                  | Compose/current-state diff and digest annotation        | Preserve detector authority, classify local builds/errors explicitly, bind platform and immutable identities, and keep same-tag digest changes actionable without changing ordinary Compose diff semantics.                           |
| `packages/rfapps-cli/src/lib/plan-storage.ts`                                    | Plan save/load/hash validation                          | Validate managed intent separately; add private modes and atomic temp-write/rename. Managed apply must not allow `--force` to bypass identity drift.                                                                                  |
| `packages/rfapps-cli/src/lib/docker.ts`                                          | Docker/Compose subprocess boundary                      | Add typed image/container identity inspection, platform-aware digest resolution, targeted recreate without `--remove-orphans`, and exact-image override restore. Keep every registry/Compose call on the existing `envTool` boundary. |
| `packages/rfapps-cli/src/lib/health.ts`                                          | Dependency readiness polling                            | Add target-aware readiness: expected image ID, running state, Docker health when configured, bounded stable-running fallback, plus dependency evidence. Missing telemetry is failure for managed update.                              |
| `packages/rfapps-cli/src/lib/service-status.ts`                                  | Runtime state/health mapping                            | Reuse or extract uncached target state parsing; managed verification must force fresh observations after every mutation.                                                                                                              |
| `packages/rfapps-cli/src/types/state.ts`                                         | Deployment/generation records                           | Add `update` actions and nullable `imageId`/`imageDigest` fields across entry/input/row types.                                                                                                                                        |
| `packages/rfapps-cli/src/lib/schema.sql`                                         | Fresh SQLite schema                                     | Add immutable image identity columns and advance fresh-database schema version.                                                                                                                                                       |
| `packages/rfapps-cli/src/lib/migrations.ts`                                      | Sequential transactional migrations                     | Add schema v3 nullable columns without inventing identities for legacy rows; update compatibility mapping and tests.                                                                                                                  |
| `packages/rfapps-cli/src/lib/state-storage.ts`                                   | Deployment writes and transactional generation creation | Store identities, include verified `update` in generation actions, and create post-update generations only after verification.                                                                                                        |
| `packages/rfapps-cli/src/lib/generations.ts`                                     | Append-only restore points                              | Read/write immutable identities and expose the exact eligible pre-update generation.                                                                                                                                                  |
| `packages/rfapps-cli/src/actions/apply.ts`                                       | Generic saved-plan apply                                | Reject `intent: managed-update`; do not reuse its change-type selection or non-blocking state policy.                                                                                                                                 |
| `packages/rfapps-cli/src/actions/rollback.ts`                                    | Manual image-only rollback                              | Extract only the lower-level restore primitive; retain rollback target selection, prompts, formatting, and recording in this action.                                                                                                  |
| `packages/rfapps-cli/src/lib/errors.ts`                                          | Typed operational/usage errors                          | Add stable plan-stale, lock, detection, verification, update, and restore error codes with sanitized messages.                                                                                                                        |
| `packages/rfapps-cli/src/lib/index.ts`, `packages/rfapps-cli/src/types/index.ts` | Public internal barrels                                 | Export the new shared contracts and primitives after their APIs stabilize.                                                                                                                                                            |

## Cross-Cutting Concerns

- **Identity and TOCTOU:** Bind plans to Compose hash, Docker-context fingerprint, resolved scope,
  platform, current image ID, and proposed digest. Recheck current and remote identities immediately
  before each pull. Tag drift or context drift requires a new plan; it is never forceable.
- **Persistence safety:** Detection must not write successful deployment/generation state. Before
  mutation, ensure the exact image exists locally and durably record the pre-update anchor. Pair
  verified deployment and generation writes transactionally. Plans, reports, locks, and overrides
  require private directories/files and atomic writes; existing `plan-storage.ts` does not provide
  these guarantees.
- **Secrets:** Persist allowlisted DTOs only. Do not serialize resolved Compose environment values,
  credential-helper output, Docker connection strings, or raw stderr. Sanitize errors and apply
  `envTool` uniformly to all Compose/registry operations.
- **Verification:** Success requires observed expected image identity plus target readiness and
  dependency readiness. Docker `healthy` is mandatory when a healthcheck exists; otherwise use a
  bounded stable-running assurance explicitly labeled `running-only`. Clear/bypass status caches.
- **Concurrency and interruption:** Add a project/context lock held from apply validation through
  terminal verification or restore. On SIGINT/SIGTERM, stop scheduling services, stabilize or
  restore the active service, persist an interrupted report, release temporary resources and lock,
  then exit non-zero.
- **Output and errors:** Human progress stays on stderr; machine modes emit one `update.v1` result on
  stdout after cleanup. Outcome and final runtime state are separate. No-op is exit 0; usage/invalid
  intent is exit 2; unknown detection, recovered update failure, update failure, or restore failure
  is exit 1 according to aggregate completeness.
- **Recovery scope:** Image restoration uses current Compose configuration only. Sidecars and
  `network_mode: service:*` providers must be represented explicitly in the approved recovery unit;
  never silently widen the service scope. `--remove-orphans` is forbidden in update/restore paths.

## Parallelization Opportunities

Implementation work can proceed in dependency-aware streams, while runtime mutation remains
sequential:

1. **Contracts and state foundation:** `types/update.ts`, plan/state types, schema v3, migrations,
   generation/state serialization, and migration/storage tests.
2. **Detection and artifact persistence:** plan-generator classification, managed intent validation,
   secure atomic plan/report storage, digest/platform fixtures, and generic-apply rejection. This can
   run alongside stream 1 after DTO field names are agreed.
3. **Docker and verification primitives:** typed identity inspection, exact-image override restore,
   targeted no-orphan recreate, context fingerprint, target-aware health polling, and focused unit
   tests. This can run alongside streams 1 and 2.
4. **Coordinator:** build `managed-update.ts` only after streams 1-3 stabilize; test ordered calls and
   every failure boundary with injected Docker/state/clock functions.
5. **CLI/action/reporting:** register flags, reuse scope resolution, add approval/output/exit mapping,
   and extend completion/smoke tests after coordinator and DTOs exist.

Avoid parallel implementation where files overlap heavily: `types/index.ts`, `lib/index.ts`,
`cli.ts`, and shared error definitions should be integrated in the final coordinator/CLI stream.

## Implementation Constraints

- No new registry SDK, Docker client, workflow engine, retry package, or state-machine dependency.
- Do not call action-level `execute*` functions from the coordinator; extract only low-level reusable
  primitives.
- Preview, cancellation, no-op, dry-run, stale-plan, and failed preflight paths must perform no pull,
  recreate, restore, or generation write.
- A pull failure is pre-mutation and does not need redundant restore. Recreate/verification failures
  restore when enabled. A failed or unverifiable update never creates a successful generation.
- Automatic restore requires a named generation and exact local image ID. Legacy tag-only
  generations remain readable/manual but are not eligible for guaranteed recovery.
- A managed plan must account for every requested service, including current, unsupported, unknown,
  blocked, updated, restored, and failed outcomes.
- `--yes` is mandatory for non-interactive mutation. Machine output format alone neither grants nor
  suppresses approval. Default command behavior is preview-only; mutation requires explicit
  `--apply` plus approval.
- Locally built services are `unsupported`; digest-pinned Compose services are current until Compose
  intent changes; registry/auth/rate-limit/parse/platform failures are `unknown`, never current.
- Use focused Vitest coverage in `managed-update.spec.ts`, `actions/update.spec.ts`, Docker/health,
  plan storage/generator, migrations/state/generations, apply rejection, CLI completion, and a
  disposable opt-in Docker integration fixture. Final gates are rfapps test, typecheck, build,
  coverage, CLI smoke, and `graphify update .` when a graph exists.
