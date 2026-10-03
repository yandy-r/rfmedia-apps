# Feature Spec: Managed Update Lifecycle

## Executive Summary

Issue #148 adds `rfapps update`: detect image updates, create an inspectable plan, require approval,
apply the exact reviewed image, verify the target, and restore the exact pre-update image on failure.
It composes existing plan, Docker, health, history, and generation modules instead of creating another
deployment engine. The first release is sequential, preview-only by default, and limited to
registry-backed image updates. It never rewrites Compose configuration or claims to restore volumes,
databases, or migrations. Exact restore identity, secret-free plans, pre-apply identity revalidation,
and target-level health are release gates.

## External Dependencies

### APIs and Services

#### Docker Compose CLI

- **Documentation**: [Docker Compose CLI](https://docs.docker.com/reference/cli/docker/compose/)
- **Authentication**: Existing Docker context, credential helpers, SSH, or TLS configuration
- **Key operations**:
  - `docker compose config --format json`: resolve the approved service model
  - `docker compose config --resolve-image-digests`: resolve mutable image references when supported
  - `docker compose pull SERVICE`: fetch a reviewed image without starting it
  - `docker compose up -d --force-recreate --pull never SERVICE`: targeted apply or restore
  - `docker compose ps --all --format json SERVICE`: target state and health evidence
- **Constraints**: Capability-probe digest-resolution and wait options; do not use
  `--remove-orphans` in the transactional update/restore path.

#### Docker Engine Inspection

- **Documentation**: [docker container inspect](https://docs.docker.com/reference/cli/docker/container/inspect/),
  [docker image inspect](https://docs.docker.com/reference/cli/docker/image/inspect/)
- **Authentication**: Same Docker context as plan generation and apply
- **Key data**: container ID, immutable local image ID, configured image reference, matching
  repository digest, platform, running state, exit code, and Docker health state
- **Constraints**: Local image IDs, repository manifest digests, index digests, and config digests are
  different identities and must never be compared interchangeably.

#### OCI / Docker Registry Manifests

- **Documentation**: [Distribution Registry API](https://distribution.github.io/distribution/spec/api/),
  [OCI image index](https://specs.opencontainers.org/image-spec/image-index/)
- **Authentication**: Docker-managed credential helpers and registry challenge flow
- **Key operation**: Resolve the selected tag to an immutable digest for the active platform
- **Rate limits**: Registry-specific; `401`, `403`, `404`, `429`, timeout, and unsupported media type
  are distinct `unknown` outcomes, never `up_to_date`
- **Constraint**: Prefer the existing Docker/Compose subprocess boundary over a new raw registry
  client so credentials, contexts, proxies, and private registries keep one authority boundary.

### Libraries and SDKs

| Library                     | Version                    | Purpose                                        | Decision                                                             |
| --------------------------- | -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------- |
| Docker CLI / Compose plugin | Host-provided              | Registry, pull, recreate, inspect, health      | Reuse existing typed subprocess wrappers                             |
| `better-sqlite3`            | Existing workspace version | Deployment and generation identity persistence | Extend schema additively                                             |
| Vitest                      | Existing workspace version | Unit and integration tests                     | Use injected lifecycle boundaries and temp databases                 |
| New runtime dependency      | None                       | —                                              | Do not add a registry SDK, workflow engine, or state-machine package |

### External Documentation

- [Compose pull](https://docs.docker.com/reference/cli/docker/compose/pull/): pull without starting
- [Compose up](https://docs.docker.com/reference/cli/docker/compose/up/): targeted recreate and wait
- [Docker image digests](https://docs.docker.com/dhi/core-concepts/digests/): immutable artifact identity
- [Docker Engine security](https://docs.docker.com/engine/security/): Docker authority is host-level

## Business Requirements

### User Stories

**Primary User: self-hosting operator**

- As an operator, I want to distinguish confirmed updates, current images, unsupported services, and
  unknown registry results so that an error is never presented as freshness.
- As an operator, I want to review the exact proposed artifact, verification method, and recovery
  generation before mutation so that approval is informed.
- As an operator, I want an unhealthy update restored automatically to its exact prior image so that
  service downtime is bounded.
- As an operator, I want the final report to distinguish update outcome from final runtime health so
  that `restored + healthy` is not mistaken for a successful update.

**Secondary User: automation consumer**

- As an automation consumer, I want a versioned result with stable outcome, stage, and error codes so
  that scripts do not parse human progress output.
- As an automation consumer, I want non-interactive mutation to require `--yes` explicitly and no-op
  detection to return success.

### Business Rules

1. **Preview is read-only**: Bare `rfapps update` detects, saves, and displays a plan. Mutation
   requires `--apply` and confirmation; non-interactive apply also requires `--yes`.
2. **Digest-only changes are actionable**: A moving tag whose selected remote digest differs from the
   running artifact is an update even when the image string is unchanged.
3. **Unknown is not current**: Registry, parsing, authentication, platform, and local-identity errors
   are explicit unknown/unsupported results and are excluded from mutation.
4. **Approved identity is immutable**: Apply binds to the reviewed Compose hash, Docker context,
   scope, platform, current local image ID, and proposed remote digest. Identity drift requires a new
   plan; `--force` cannot bypass it.
5. **Restore is exact and image-only**: Automatic restoration uses the captured local image ID under
   current Compose configuration. Volumes, databases, and migrations are never described as restored.
6. **Verification covers the target**: Success requires the expected image, running target, healthy
   Docker healthcheck when configured, and dependency readiness. A no-healthcheck target may pass only
   after a bounded stable-running window reported as `running-only` assurance.
7. **Verified states create generations**: Only verified updates and verified restores become
   successful generation snapshots. Failed attempts remain deployment-history evidence.
8. **Sequential recovery boundary**: Services update one at a time. Continue after a verified restore
   but return exit 1; stop immediately after restore failure.
9. **Secure persistence**: Managed plan/report DTOs are allowlisted and never persist resolved
   environment values or credentials. Private artifacts use secure directory/file modes and atomic
   writes.
10. **Complete accounting**: Preview and final results account for every requested service, including
    current, unsupported, unknown, blocked, updated, restored, and failed outcomes.

### Edge Cases

| Scenario                           | Expected Behavior                                                             | Notes                                           |
| ---------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------- |
| No updates                         | Successful no-op; no prompt, pull, recreate, or generation write              | All selected services remain visible            |
| Local `build:` service             | `unsupported`; never treated as a registry update                             | Build lifecycle is out of scope                 |
| Digest-pinned Compose image        | `up_to_date` until Compose intent changes                                     | Ordinary plan handles config changes            |
| Registry auth/rate-limit/timeout   | `unknown`, excluded, aggregate exit 1 when requested scope is incomplete      | Preserve sanitized reason                       |
| Tag moves after preview            | Refuse before mutation and require re-plan                                    | Never silently substitute another digest        |
| No exact recovery identity         | Block by default; explicit `--no-restore-on-failure` is reduced-safety mode   | Warning appears in preview and report           |
| Pull fails before mutation         | Report failure; leave current container untouched; no redundant restore       | Exit 1                                          |
| New image starts unhealthy         | Restore exact prior image, verify it, record both outcomes                    | Restored update still exits 1                   |
| Restore fails or remains unhealthy | Stop later work and return `restore_failed` with manual guidance              | No successful generation for failed restore     |
| Concurrent lifecycle               | Second run refuses project/context lock                                       | Lock held through terminal verification/restore |
| Ctrl+C during mutation             | Stop scheduling new services and stabilize/restore active service before exit | Persist interrupted report                      |

### Success Criteria

- [ ] Same-tag digest changes produce actionable managed-update candidates.
- [ ] Unknown registry states never appear as current and never mutate by default.
- [ ] Preview-only, cancelled, no-op, and stale-plan runs perform zero mutation.
- [ ] Apply deploys exactly the reviewed artifact and verifies the target image and health.
- [ ] Pre-update local image identity is captured durably before pull.
- [ ] Failed update plus verified restore returns a healthy final state, a `restored` outcome, and exit 1.
- [ ] Restore failure stops the run and creates no successful generation for the failed restore.
- [ ] Managed plans and reports contain no fixture secrets and use private atomic persistence.
- [ ] Human and machine output account for the same service scope and lifecycle facts.
- [ ] Focused tests cover all lifecycle stages, migrations, plan security, and target verification.
- [ ] Full rfapps typecheck, build, coverage, CLI smoke, and graph update gates pass.

## Technical Specifications

### Architecture Overview

```text
commands/update.ts
       |
       v
actions/update.ts ---- preview / confirmation / formatting / exit code
       |
       v
lib/managed-update.ts ---- sequential per-service state machine + project lock
   |          |           |             |                 |
   v          v           v             v                 v
plan      docker      verification   generations       secure plans/reports
detect    identity    target + deps   image ID/digest  private DTO/files
```

The coordinator returns data and never prints or sets process exit state. It reuses lower-level
libraries, not action-level `execute*` functions, so confirmation, streams, database lifetime, and
errors remain owned by `actions/update.ts`.

### Data Models

#### Deployment and generation image identity

Schema version 3 adds nullable columns so historical rows remain readable:

| Table         | Field          | Type | Constraints | Description                          |
| ------------- | -------------- | ---- | ----------- | ------------------------------------ |
| `deployments` | `image_id`     | TEXT | nullable    | Immutable daemon-local image ID      |
| `deployments` | `image_digest` | TEXT | nullable    | Canonical repository/manifest digest |
| `generations` | `image_id`     | TEXT | nullable    | Exact same-daemon restore identity   |
| `generations` | `image_digest` | TEXT | nullable    | Portable audit/fallback identity     |

`DeploymentAction` and `GenerationAction` gain `update`. Successful `update` state records append a
generation through the existing transaction. Legacy generations without immutable identity remain
listable/manual, but are not automatic-restore eligible.

#### Managed update plan

```typescript
type ImageUpdateStatus = "update-available" | "up-to-date" | "unsupported" | "local-missing" | "unknown";

interface ManagedUpdatePlan extends DeploymentPlan {
  schemaVersion: "update-plan.v1";
  intent: "managed-update";
  dockerContextFingerprint: string;
  createdAt: string;
  services: ManagedUpdatePlanService[];
}

interface ManagedUpdatePlanService {
  service: string;
  status: ImageUpdateStatus;
  configuredImage: string;
  platform?: string;
  currentImageId?: string;
  currentDigest?: string;
  proposedDigest?: string;
  recoveryGeneration?: number;
  recoveryEligible: boolean;
  verification: "healthcheck" | "running-only";
  errorCode?: string;
}
```

The persisted DTO stores no environment values. Ordinary `DeploymentPlan` remains backwards
compatible; generic `rfapps apply` rejects `intent: managed-update` and directs users to
`rfapps update --from-plan ... --apply`.

#### Managed update result

```typescript
type ManagedUpdateOutcome =
  | "up_to_date"
  | "unsupported"
  | "detection_unknown"
  | "blocked"
  | "cancelled"
  | "updated"
  | "restored"
  | "update_failed"
  | "restore_failed";

interface ManagedUpdateResult {
  schemaVersion: "update.v1";
  runId: string;
  planId: string;
  startedAt: string;
  completedAt: string;
  status: "no_updates" | "succeeded" | "recovered_failure" | "partial" | "failed" | "interrupted";
  success: boolean;
  applied: boolean;
  restoreOnFailure: boolean;
  services: ManagedUpdateServiceResult[];
}
```

Per-service results include expected/observed image identities, lifecycle stage, outcome, final
health/assurance, before/after/restore generations, durations, stable error code, and sanitized
message.

### CLI Design

#### `rfapps update`

```text
rfapps update
  -s, --service <name>
  --services <names>
  -g, --group <name>
  --no-sidecars
  --apply
  --from-plan <path>
  -o, --out <path>
  --restore-on-failure / --no-restore-on-failure
  --health-timeout <seconds>
  -f, --compose <path>
  -e, --env-file <path>
  -p, --profile <name>
```

- Bare invocation generates, saves, and renders a preview.
- `--apply` applies the just-generated plan after confirmation.
- `--from-plan` loads and re-renders an existing managed plan; targeting flags are rejected because
  they would change reviewed scope.
- Global `--yes` is required for non-interactive apply; output format never grants approval.
- Global `--dry-run` may perform detection/validation but never creates a generation, pulls,
  recreates, locks long-term, or restores.
- `--no-restore-on-failure` is an explicit expert escape hatch and is repeated in preview/result.
- Parallel flags are intentionally absent in v1.

### Internal APIs

```typescript
generateManagedUpdatePlan(input, dependencies): Promise<ManagedUpdatePlan>;
runManagedUpdate(plan, options, dependencies): Promise<ManagedUpdateResult>;
verifyServiceReadiness(input): Promise<ServiceVerificationSummary>;
recreateServiceWithImage(input): Promise<DockerExecResult>;
restoreServiceToImage(input): Promise<RestoreResult>;
```

Dependencies are a plain object of existing functions for plan, Docker, health, clock, lock, and
state operations. Production defaults use repository modules; tests inject deterministic fakes.

### Apply and Restore Sequence

```text
lock project/context
  -> validate runtime plan schema and secure file
  -> revalidate Compose/context/current image/proposed digest
  -> persist exact pre-update identity
  -> pull reviewed digest through private override
  -> targeted recreate with --pull never (no orphan cleanup)
  -> verify expected image + target + dependencies
     -> verified: record update success/new generation
     -> failed after mutation: restore local image ID and verify
        -> verified restore: record failed update + successful restore generation; continue; exit 1
        -> failed restore: record failure; stop run; exit 1
  -> remove overrides and release lock in finally
```

### System Integration

#### Files to Create

- `packages/rfapps-cli/src/commands/update.ts`: command registration and option compatibility
- `packages/rfapps-cli/src/actions/update.ts`: config/scope, preview, confirmation, streams, result
- `packages/rfapps-cli/src/lib/managed-update.ts`: lifecycle coordinator and injected boundaries
- `packages/rfapps-cli/src/types/update.ts`: plan/result/verification contracts
- Colocated `*.spec.ts` files for update action/coordinator and any extracted primitives

#### Files to Modify

- `src/cli.ts`, `src/lib/index.ts`, `src/types/index.ts`: registration/exports
- `src/types/plan.ts`, `src/lib/plan-generator.ts`, `src/lib/docker.ts`: discriminated detection,
  canonical digest/platform handling, exact image identity, targeted overrides
- `src/lib/plan-storage.ts`: allowlisted secret-free private persistence and runtime validation
- `src/types/state.ts`, `src/lib/state-storage.ts`, `src/lib/generations.ts`,
  `src/lib/state-queries.ts`, `src/lib/schema.sql`, `src/lib/migrations.ts`: image identity and update
  action persistence
- `src/types/health.ts`, `src/lib/health.ts`: target-aware readiness and expected-image evidence
- `src/actions/apply.ts`: reject managed plans
- `src/actions/rollback.ts`: reuse exact-image restore primitive without changing manual UX
- `src/actions/completion.ts`: Bash/Zsh/Fish command/option completion
- `packages/rfapps-cli/README.md`, `ROADMAP.md`: lifecycle, restore scope, examples, completion status

## UX Considerations

### User Workflows

#### Preview then apply

1. Operator selects service/group scope and runs `rfapps update`.
2. CLI displays current/proposed short digests, recovery generation, verification method, and any
   unknown/blocked services; it saves a private plan and exits without mutation.
3. Operator runs `rfapps update --from-plan <path> --apply` or regenerates with `--apply`.
4. CLI revalidates the artifact, asks once, then shows monotonic per-service stage progress.
5. Final summary leads with outcome, final health, generation transition, report path, and exact next
   action.

#### Automatic recovery

1. Updated target fails expected-image or readiness verification.
2. CLI says mutation occurred and names the generation/image being restored.
3. CLI restores without a second prompt because recovery was part of the approved lifecycle.
4. CLI verifies the restored target and reports `restored + healthy` or `restore_failed`.

### UI Patterns

| Component      | Pattern                            | Notes                                                              |
| -------------- | ---------------------------------- | ------------------------------------------------------------------ |
| Preview        | Per-service table                  | Current/proposed digest, recovery generation, verification, status |
| Confirmation   | Default-no prompt                  | Repeat image-only restore scope and reduced-safety services        |
| Progress       | Stage/service counts               | Append-only in non-TTY; heartbeat only on change/retry             |
| Final result   | Outcome plus final state           | Never collapse restored failure into success                       |
| Machine output | One `update.v1` document on stdout | Progress/logs remain stderr; stable codes drive scripts            |

### Accessibility Requirements

- Do not rely on color alone; every state has text and stable symbols/codes.
- Disable spinners/cursor control outside a TTY and keep append-only CI-readable progress.
- Keep tables optional through structured formats and preserve full identifiers in machine output.

### Performance UX

- Show service/stage counts and elapsed time, never fabricated percentages.
- Show the signal and timeout being awaited (`healthcheck`, `running-only`, dependency probe).
- Deduplicate registry queries per image reference and bound retries/concurrency during detection.
- Keep sequential mutation explicit in the preview; raw Docker output is available via verbose/debug.

## Recommendations

### Implementation Approach

**Recommended Strategy**: Build one small sequential coordinator over existing libraries, strengthen
the shared plan/state/restore primitives where correctness requires it, and keep every safety
decision explicit in versioned data.

**Phasing:**

1. **Contracts and secure plans**: discriminated detection, managed intent, secret-free private DTO,
   strict runtime validation.
2. **Immutable recovery foundation**: schema migration, image identity, project lock, targeted
   pinned apply/restore helpers.
3. **Verification and coordinator**: target-plus-dependency readiness, sequential state machine,
   recovery, reports.
4. **CLI and hardening**: registration, completion, docs, integration fixture, full validation.

### Technology Decisions

| Decision         | Recommendation                                          | Rationale                                              |
| ---------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| Command default  | Preview-only; require `--apply`                         | Safe and consistent with plan/apply concepts           |
| Detection model  | Discriminated status, not boolean                       | Unknown must not become current                        |
| Apply artifact   | Reviewed repository digest                              | Prevent tag substitution                               |
| Restore artifact | Same-daemon local image ID plus stored repo digest      | Exact offline restore and auditable identity           |
| Verification     | Expected image + target state/health + dependencies     | Dependency-only checks can accept broken targets       |
| Execution        | Sequential per service                                  | Bounded blast radius and deterministic recovery        |
| Persistence      | Existing plans/deployments/generations, additive schema | Avoid duplicate workflow database                      |
| Dependencies     | None new                                                | Existing Docker boundary owns credentials and contexts |

### Quick Wins

- Match local `RepoDigests` by normalized repository rather than array position.
- Preserve registry lookup errors as `unknown`.
- Reject managed plans in generic `rfapps apply`.
- Omit `--remove-orphans` from lifecycle-specific recreate operations.
- Ensure managed saved plans cannot serialize environment values.

### Future Enhancements

- Configurable HTTP/TCP/command verification and migration-sensitive policies
- Signature/provenance/vulnerability policy hooks
- Dependency-aware parallel recovery units after semantics are proven
- Maintenance windows, notifications, JSON Lines progress, and explicit retained-image cleanup

## Risk Assessment

### Technical Risks

| Risk                                       | Likelihood | Impact | Mitigation                                                                           |
| ------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------ |
| Mutable tag restores wrong image           | High       | High   | Capture local image ID before pull; restore with private override and `--pull never` |
| Saved plan discloses resolved secrets      | High       | High   | Allowlisted DTO, no values, `0700` dirs, atomic `0600` files, canary-secret tests    |
| Tag/context/container changes after review | Medium     | High   | Project lock and fail-closed identity revalidation before mutation                   |
| Multi-platform digest mismatch             | Medium     | High   | Canonical repository/platform identity and manifest/index fixtures                   |
| Dependency readiness accepts broken target | High       | High   | Expected-image and target health verification before dependency evidence             |
| Restore cannot undo a data migration       | Medium     | High   | Image-only language, service policy/hooks later, explicit no-restore escape hatch    |
| Concurrent or broad Compose mutation       | Medium     | High   | Exclusive lock, sequential targeted operations, no orphan cleanup                    |
| Old image unavailable                      | Medium     | High   | Preflight local image identity, retain through terminal state, block default apply   |

### Integration Challenges

- Docker Compose capability varies by version; probe and provide actionable unsupported errors.
- Private registries and remote contexts must use the same Docker authority across every phase.
- Sidecars expand requested scope; report independently and never silently restore unrelated services.
- Ordinary plan/apply and manual rollback behavior must remain backwards compatible.

### Security Considerations

#### Critical — Hard Stops

| Finding                             | Risk                                                  | Required Mitigation                                                |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| Mutable tag used as recovery target | Recovery can redeploy the failed image                | Persist/restore exact local image ID; never auto-fallback to tag   |
| Resolved secrets in saved plan      | Credential disclosure through local artifacts/backups | Secret-free allowlisted plan/report DTO and private atomic storage |

#### Warnings — Must Address

| Finding              | Risk                                    | Mitigation                                                       | Alternatives                          |
| -------------------- | --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| TOCTOU drift         | Apply unreviewed artifact               | Lock and revalidate all identities                               | Re-plan; never force                  |
| Untrusted saved plan | Privileged Docker operands              | Strict versioned runtime schema, size limits, Compose membership | Restrict paths to state dir           |
| False health         | Accept unhealthy target                 | Target identity/state/health plus dependencies                   | Labeled bounded running-only fallback |
| Image-only restore   | Old app incompatible with migrated data | Explicit boundary and policy hooks                               | `--no-restore-on-failure` expert mode |

#### Advisories — Best Practices

- Digests prove identity, not publisher trust; reserve later signature/scanning policy fields.
- Redact and cap subprocess errors before plans/reports/logs persist them.
- Bind remote Docker context identity to the plan without storing connection secrets.

## Task Breakdown Preview

### Phase 1: Secure Plan and Detection Contract

**Focus**: Actionable, secret-free, validated update plans.

**Tasks**:

- Add managed plan/result types and discriminated image status.
- Correct repository/platform digest classification and unknown handling.
- Add private allowlisted plan persistence and generic-apply rejection.
- Cover legacy plan compatibility and secret canary tests.

**Parallelization**: Type/storage contracts and digest fixtures can start together, then converge on
plan generation.

### Phase 2: Immutable Recovery Foundation

**Focus**: Exact image identity, persistence, and targeted Docker operations.
**Dependencies**: Phase 1 contracts.

**Tasks**:

- Add schema version 3 and update actions/image identity fields.
- Add lifecycle lock and current-context/image revalidation.
- Add private temporary overrides for reviewed apply and exact restore.
- Extract the restore primitive for manual rollback compatibility.

### Phase 3: Verification and Lifecycle Coordinator

**Focus**: Decide success from target evidence and recover safely.
**Dependencies**: Phases 1–2.

**Tasks**:

- Add target-aware expected-image/state/health verification plus dependencies.
- Implement sequential state machine and failure-stage semantics.
- Record verified update/restore generations and sanitized `update.v1` reports.
- Cover interruption, restored-continue, and restore-failure-stop behavior.

### Phase 4: CLI, Documentation, and End-to-End Validation

**Focus**: Complete public UX and prove regressions are absent.
**Dependencies**: Phases 1–3.

**Tasks**:

- Register `rfapps update`, options, help, completions, streams, confirmation, and exit codes.
- Document examples, restore scope, unknown results, and automation contract.
- Update `ROADMAP.md` and create a disposable Compose lifecycle integration fixture.
- Run focused tests, workspace typecheck/build/coverage, CLI smoke, graph update, review, and CI.

## Decisions Needed

The design workflow resolves the implementation defaults required for planning:

1. **Default behavior**: preview-only; `--apply` authorizes the mutation phase and still confirms.
2. **Failure scope**: sequential per service; continue after verified restore, stop after restore failure.
3. **Unknown detection**: exclude that service and return an incomplete/non-success aggregate result.
4. **Recovery identity**: tag for display, repo digest for audit, local image ID for same-daemon restore.
5. **Recovery availability**: enabled by default; missing anchor blocks unless the operator explicitly
   chooses `--no-restore-on-failure`.
6. **Verification without healthcheck**: bounded stable-running fallback, labeled `running-only`.
7. **Plan drift**: Compose/context/local/proposed identity mismatches always require regeneration.
8. **Scope exclusions**: parallel mutation, scheduling, notifications, backup/data rollback,
   signatures/scanning, and retention cleanup are follow-ups.

Remaining implementation-time compatibility decisions are limited to the minimum supported Compose
capabilities and whether both index and selected-platform digests can be captured reliably; fixtures
must resolve those without weakening the identity contract.

## Research References

- [research-external.md](./research-external.md): Docker, Compose, registry, digest, and health APIs
- [research-business.md](./research-business.md): user value, rules, state transitions, and criteria
- [research-technical.md](./research-technical.md): architecture, schemas, CLI, and file changes
- [research-ux.md](./research-ux.md): interactive/automation workflows and error recovery UX
- [research-security.md](./research-security.md): severity-calibrated security constraints
- [research-practices.md](./research-practices.md): reuse, KISS, modularity, and testability
- [research-recommendations.md](./research-recommendations.md): resolved defaults and phasing
