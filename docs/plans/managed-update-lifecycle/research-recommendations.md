# Managed Update Lifecycle: Consolidated Recommendations

## Executive Summary

Implement issue #148 as a dedicated `rfapps update` workflow over existing plan, Docker, health,
state, and generation libraries. The safe lifecycle is `detect -> preview -> approve -> apply ->
verify -> keep or restore -> report`. Bare `rfapps update` is preview-only; mutation requires
`--apply` and interactive confirmation, or `--yes` in non-interactive mode.

The first release should be sequential and image-focused. A confirmed same-tag digest change is an
actionable update, while unknown registry results are excluded and make the aggregate result
non-successful. Before any pull, bind the run to the Compose hash, Docker context, current local image
ID, canonical repository digest, selected platform, and proposed remote digest. Apply and restore
through minimal temporary Compose overrides, then verify the target container and its dependencies.

Restoration is enabled by default and restores only the prior image under current Compose
configuration; it does not undo volumes, databases, or migrations. A verified restore permits later
independent services to continue, but the command exits 1. A restore failure stops the run. No new
runtime dependency, workflow engine, registry SDK, or update-run database is justified.

## Implementation Recommendations

1. Add a thin three-layer feature: `commands/update.ts` for registration, `actions/update.ts` for UI,
   confirmation, output, and exit codes, and `lib/managed-update.ts` for the testable state machine.
   Do not call action-level `executeApply`, `executeHealth`, or `executeRollback` from the coordinator.
2. Reuse `generatePlan({ checkUpdates: true })`, but add managed-update intent and an explicit
   discriminated image status: `update-available`, `up-to-date`, `unsupported`, `local-missing`, or
   `unknown`. Preserve ordinary Compose change semantics; select managed candidates by update status.
3. Persist a versioned, allowlisted, secret-free plan DTO. Store identifiers, hashes, scope, platform,
   image identities, recovery eligibility, and verification policy—not resolved environment values.
   Create state directories as `0700`, files atomically as `0600`, reject unsafe symlinks, and cap
   plan size before runtime validation.
4. Acquire an exclusive project/Compose-context lifecycle lock before final revalidation and hold it
   through terminal verification or restoration. Revalidate the Compose hash, context identity,
   selected service, current image ID/digest, and proposed remote digest before each mutation.
5. Capture the running container's configured tag, exact local image ID, matching canonical repo
   digest, platform, and container ID before pull. Persist image ID and digest in nullable generation
   and deployment fields so legacy history remains readable. Never auto-restore from a mutable tag.
6. Apply the approved `repository@digest` through a private temporary Compose override. Use targeted
   `pull`, followed by `up -d --force-recreate --pull never` without `--remove-orphans`; validate
   service names and digest syntax and remove the override in `finally`.
7. Verify that the target is running, uses the planned image ID, and is `healthy` when a Docker
   healthcheck exists; also run dependency readiness. Without a healthcheck, require a bounded stable
   running window and label the assurance `running-only`. Missing telemetry is failure, not health.
8. On any failure after mutation may have begun, recreate from the captured local image ID with
   `--pull never`, then repeat target and dependency verification. Record only verified updated or
   verified restored states as successful generations.
9. Process candidates sequentially. Continue after a verified restore for independent services,
   retain the original update failure, and exit 1. Stop immediately on `restore_failed`. Pull failure
   proven to occur before mutation does not require a redundant restore.
10. Emit one versioned `update.v1` result accounting for every selected service, separating lifecycle
    outcome from final runtime health. Keep progress on stderr and exactly one machine document on
    stdout. Persist a sanitized report on success, failure, recovery, and interruption.

## Technology Choices

- Use existing `execDocker`/`execDockerCompose` argument-array wrappers for execution, Docker context,
  SSH, credential-helper, and secrets-tool compatibility. Never introduce shell command strings.
- Prefer Compose digest-resolution/lock capabilities when available; capability-probe them and keep
  current Docker CLI resolution only as a typed fallback with multi-platform fixtures.
- Use SQLite migrations to add nullable `image_id` and `image_digest` fields and an `update` action.
  Retain existing plan IDs, deployments, and generations instead of adding lifecycle tables.
- Use existing Vitest, plan storage, confirmation, output formatting, and health polling patterns.
  Add plain dependency injection at coordinator boundaries for deterministic failure-stage tests.
- Add no runtime packages. Built-in Node APIs and the existing Docker/Compose subprocess boundary are
  sufficient.

## Phasing and Quick Wins

### Phase 1: Safe detection and plans

Make digest-only changes actionable; add explicit unknown/unsupported states, managed intent,
secret-free private plan persistence, strict plan validation, and preview-only CLI behavior.

### Phase 2: Exact apply and recovery identity

Add lifecycle locking, context/digest revalidation, image identity persistence, temporary pinned
overrides, targeted recreation, and the reusable restore primitive shared with manual rollback.

### Phase 3: Verification and reporting

Add target-aware readiness, restored-state verification, sequential orchestration, `update.v1`
results, interruption handling, completions, documentation, and layered tests.

Quick wins are fixing `RepoDigests` repository matching, distinguishing lookup errors from current
images, rejecting managed plans in generic `rfapps apply`, and removing `--remove-orphans` from the
new lifecycle path.

## Improvement Ideas

- Add configured HTTP/TCP/command probes and migration-sensitive service policy after v1.
- Add signature, provenance, approved-registry, and vulnerability policy hooks without making them
  baseline runtime dependencies.
- Add JSON Lines progress events, maintenance windows, notifications, and dependency-aware
  parallelism only after recovery-unit semantics are proven.
- Add retained-image cleanup as a separate explicit operation; never prune during an active run.

## Risk Assessment

- **CRITICAL — false restoration:** mutable tags can resolve to the failed artifact. Mitigate with
  pre-pull local image ID plus repo digest, pinned override, `--pull never`, and image-ID verification.
- **CRITICAL — secret disclosure:** current resolved plan data can contain credentials. Managed plans
  and reports must use allowlisted secret-free DTOs and private atomic filesystem writes.
- **WARNING — TOCTOU/supply chain:** tags, containers, Compose files, or Docker context can change
  after preview. Lock the lifecycle and fail closed on any identity drift; `--force` cannot bypass it.
- **WARNING — false health:** dependency readiness alone can accept a broken target. Verify target
  identity/state/health and dependencies, with bounded running-only fallback explicitly disclosed.
- **WARNING — concurrent/broad mutation:** overlapping runs and orphan cleanup can widen impact. Use
  one project lock, sequential service operations, exact validated scope, and no orphan removal.
- **WARNING — data migration incompatibility:** image restore does not revert persistent data. Repeat
  this limitation before approval and in reports; `--no-restore-on-failure` is an explicit expert
  escape hatch, never an implied fallback.
- **ADVISORY — digest limits:** digests prove identity, not publisher trust or vulnerability status.
  Reserve policy-result fields for later signature and scanning integrations.

## Alternative Approaches

| Approach                             | Pros                                                 | Cons                                                               | Effort | Recommendation |
| ------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------ | ------ | -------------- |
| Dedicated coordinator over libraries | One approval/result; exact ordering; bounded changes | New action and coordinator                                         | Medium | **Choose**     |
| Chain existing CLI actions           | Fast prototype                                       | Nested prompts/output/exit state; no atomic recovery contract      | Low    | Reject         |
| Extend generic `apply`               | Fewer commands                                       | Blurs Compose drift and registry updates; unsafe for managed plans | Medium | Reject         |
| Raw Registry V2 client               | Precise protocol control                             | Auth helpers, proxies, TLS, platform handling, redirects           | High   | Defer          |
| Parallel batch with global rollback  | Faster                                               | Large blast radius and unclear dependency rollback                 | High   | Defer          |

## Task Breakdown Preview

1. **Contracts and persistence**: plan/result types, runtime schemas, secure DTO/file writes, schema
   migration. No dependencies.
2. **Detection correctness**: discriminated update results, canonical repository/platform matching,
   actionable managed candidates. Depends on task 1.
3. **Docker primitives**: exact identity inspection, private overrides, targeted apply/restore, lock.
   Depends on task 1; can proceed alongside task 2.
4. **Verification**: target-plus-dependency readiness and expected-image checks. Depends on task 3.
5. **Coordinator**: revalidation, snapshot, sequential apply, restore, reporting state machine.
   Depends on tasks 2–4.
6. **CLI/UX**: command registration, preview, confirmation, structured streams, exits, completion.
   Depends on task 5.
7. **Validation/docs**: focused unit and SQLite tests, disposable Compose integration fixture, CLI
   smoke, README and restore-scope documentation. Depends on tasks 1–6.

## Key Decisions Needed

- **Command default:** preview-only; require `--apply`, plus confirmation or `--yes`.
- **Execution:** sequential per service; continue after verified restore, stop on restore failure.
- **Detection errors:** exclude unknown services, continue independent known candidates, exit 1 overall.
- **Recovery identity:** store tag for display, repo digest for audit, local image ID for restoration.
- **Verification:** expected image + target health/state + dependency readiness; running-only is labeled.
- **Recovery policy:** enabled by default; `--no-restore-on-failure` is explicit and prominently reported.
- **Plan drift:** never force through Compose, context, local-image, platform, or remote-digest mismatch.
- **Persistence:** extend existing history/generations; do not add update-run tables or dependencies.

## Open Questions

1. Which minimum Compose version should be supported, and which digest-resolution features require a
   capability fallback?
2. Should plans store both multi-platform index and selected platform manifest digests, or only the
   exact identity Compose consumes? Store both if reliable fixtures confirm parity.
3. What configuration shape will mark migration-sensitive services and optional application probes?
4. What retention policy protects referenced pre-update image IDs and reports without unbounded disk
   use?
5. Should future recovery units include explicitly configured sidecars, or remain one independently
   reported service per transaction?
