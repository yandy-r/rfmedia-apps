# Managed Update Lifecycle: Business and Domain Research

## Executive Summary

The managed update lifecycle should give a self-hosting operator one trustworthy path from
"an image may be newer" to a verified final state:

`detect -> preview/plan -> approve -> apply -> verify -> keep or restore`

The user value is not unattended updating. It is informed control with a bounded recovery path.
This distinction is the feature's strategic advantage over Watchtower-style automation: rfapps
should make updates visible, explain the intended change, require explicit approval, verify the
result, and recover when the update fails.

The feature should be judged as a safety workflow rather than as a convenience wrapper around
`pull` and `deploy`. An update run is successful only when every in-scope service reaches a
verified final state and the operator receives a durable per-service report linked to its plan and
generation history. If an update is applied but later fails verification, successful restoration is
a recovered failure, not a successful update.

Three existing gaps are especially important to the product contract:

- `plan --check-updates` currently annotates a service with an available registry update but does
  not make a same-tag digest change an actionable plan change. The resulting plan may say both
  "unchanged" and "update available," and `apply` then has nothing to apply.
- Existing health behavior primarily evaluates dependency readiness. It does not by itself prove
  that the updated target service is healthy and usable.
- Existing generations are excellent stable identifiers in history, but restoration is explicitly
  image-only and stored image references may use moving tags. A safe recovery target must identify
  the exact pre-update image, not merely the same tag name after that tag has moved.

The initial release should remain deliberately narrow: on-demand, Compose-native, explicit by
default, and focused on image updates. Scheduling, notifications, vulnerability policy, backups,
and full data rollback are adjacent products, not requirements for this lifecycle.

## User Stories

### Primary operator

- As a self-hosting operator, I want to see which selected services have confirmed image updates
  so that I can decide what deserves attention without changing anything.
- As a cautious operator, I want the preview to distinguish available, up-to-date, unsupported,
  and unknown results so that a registry error is never presented as "no update."
- As an operator, I want the update plan to identify the current image, proposed image artifact,
  affected service scope, and recovery generation so that approval is an informed decision.
- As an operator, I want applying the plan to require confirmation by default so that discovery
  cannot unexpectedly mutate my platform.
- As an operator, I want updated services verified after startup so that a running container is not
  mistaken for a healthy application.
- As an operator, I want a failed update automatically restored to its known pre-update generation
  when safe recovery is available so that service downtime is bounded.
- As an operator, I want restoration clearly scoped to images and current Compose configuration so
  that I do not assume application data or database migrations were undone.
- As an operator, I want one final report showing what happened to every selected service so that I
  know which services updated, stayed unchanged, were restored, or need manual intervention.

### Automation consumer

- As a script or CI consumer, I want stable structured output and exit behavior so that I can tell
  a clean update from a recovered failure, partial result, detection error, or failed restoration.
- As an automation consumer, I want a no-update run to be a successful no-op so that routine checks
  are safe and idempotent.
- As an automation consumer, I want non-interactive mutation to require an explicit opt-in so that
  machine-readable output alone never implies approval.

### Recovery operator

- As an operator responding to a bad release, I want the report to name the pre-update generation,
  attempted recovery action, health evidence, and exact final state so that I can continue manually
  without reconstructing the event from logs.
- As an operator whose service cannot be safely restored, I want the lifecycle to stop before
  mutation or clearly exclude that service, rather than promise automatic recovery it cannot
  perform.

## Business Rules and Edge Cases

### Detection and selection

1. Detection is read-only. It must not pull, recreate, stop, or record a successful deployment.
2. Each selected service has one detection outcome: `update_available`, `up_to_date`,
   `unsupported`, or `unknown`.
3. Missing local images, registry authentication failures, rate limits, timeouts, unsupported local
   builds, and unresolvable manifests are not `up_to_date`; they are explicit `unknown` or
   `unsupported` outcomes with a reason.
4. Only `update_available` services enter the proposed mutation set. `up_to_date` services are
   reported as no-ops. Unknown services do not mutate by default.
5. The selected service, services, group, profile, and sidecar policy must remain consistent across
   detection, preview, apply, verification, and reporting. Scope must not silently widen between
   stages.
6. Locally built images and digest-pinned images require explicit semantics. The recommended first
   release treats local builds as unsupported for registry lifecycle management and digest-pinned
   images as up-to-date unless the desired digest in Compose changes.
7. Multi-platform images must be compared for the platform actually used by the service. A manifest
   list change on an unrelated architecture must not create a false update for the current host.

### Preview and approval

1. A confirmed remote digest change for a moving tag is an actionable update even when the image
   reference string is unchanged.
2. The plan must show, per service, the current artifact identity, proposed artifact identity,
   pre-update generation, verification expectation, and whether automatic restoration is eligible.
3. The plan artifact is the approved intent. Applying it must not silently substitute a different
   remote artifact if the tag moves again after preview.
4. A plan is stale when relevant Compose intent changes or the proposed remote artifact no longer
   matches the reviewed artifact. Stale plans are refused by default and should be regenerated.
5. Applying changes requires explicit confirmation in human-readable mode unless the user passed an
   explicit non-interactive approval option. Detection and preview never require mutation approval.
6. A plan with no actionable updates completes successfully without confirmation or mutation.

### Recovery eligibility

1. Every service proposed for update must have a recovery assessment before the first mutation.
2. Automatic restoration is eligible only when rfapps can identify an exact, usable pre-update
   image artifact and a named successful generation for the service.
3. If no eligible recovery target exists, the safe default is to exclude or block that service
   before mutation. An explicit override may allow update without automatic recovery, but the plan
   and confirmation must state that reduced guarantee.
4. Recovery state is safety-critical for this workflow. Failure to read or preserve the recovery
   anchor must not be treated as a non-blocking history warning.
5. Generation numbers are per service. Reports must always pair a generation number with its
   service name and must not imply a platform-wide generation unless such a concept is introduced.
6. Restoration means restoring the pre-update image while using current Compose configuration.
   Volumes, databases, application data, and irreversible schema migrations are outside the
   guarantee.
7. Services known to perform incompatible data migrations may require an explicit no-auto-restore
   policy. The workflow must not claim that reverting a container image makes application data safe.

### Apply and verification

1. Pulling an image, starting a container, and passing verification are distinct stages with
   distinct outcomes.
2. A target service is verified only when the configured verification contract for that service
   passes within its bounded grace period. Container existence alone is insufficient when a health
   signal is expected.
3. Dependency readiness contributes evidence but cannot replace verification of the updated target.
4. Unavailable verification telemetry is not equivalent to healthy. The run must either use a
   documented fallback or classify the outcome as unverifiable and follow the configured recovery
   policy.
5. Sequential and parallel execution must have the same business outcome rules. Performance mode
   must not weaken verification or recovery guarantees.
6. An updated service receives a new successful generation only after its success criteria are met.
   A failed or unverifiable update must not become the new known-good recovery baseline.
7. If verification fails and restoration is eligible, restoration begins automatically without a
   second confirmation; the user already approved a restore-on-failure lifecycle.
8. A restored service must itself be verified. A successful container start is not sufficient to
   label restoration successful.
9. A recovered failure returns a non-success update outcome and non-zero exit status, even when the
   final service state is healthy, because the requested update did not succeed.
10. A restoration failure is the highest-severity operational outcome and must include concrete
    manual recovery guidance and the last observed service state.

### Batch behavior and reporting

1. Every selected service has an independent terminal outcome: `not_selected`, `up_to_date`,
   `detection_unknown`, `planned`, `updated`, `restored`, `update_failed`, or `restore_failed`.
2. The report must preserve both the lifecycle outcome and final runtime condition. For example,
   `restored` can coexist with final health `healthy`, while still representing a failed update.
3. Unchanged services and excluded services must be visible in summaries so the operator can prove
   the original scope was accounted for.
4. The lifecycle report must include a run identifier, plan identifier, timestamps, requested
   scope, confirmation mode, and per-service current/proposed artifact, generation references,
   verification evidence, restoration attempt, final outcome, and actionable errors.
5. Human and machine-readable reports must represent the same facts. Machine output must not depend
   on parsing progress logs.
6. Re-running detection after a successful update should report the service as up-to-date. Re-running
   an already applied plan must not apply the same mutation again without revalidation.

## Primary and Error Recovery Workflows

### Primary workflow: updates available and healthy

1. The operator selects a service scope and starts update detection.
2. rfapps reports per-service detection outcomes and creates an actionable plan only for confirmed
   updates.
3. The preview identifies proposed image artifacts and named pre-update recovery generations.
4. The operator approves the reviewed plan.
5. rfapps applies the planned artifacts without substituting unreviewed versions.
6. rfapps waits for target health and required dependency readiness.
7. Verified services are recorded as successful new generations.
8. The final report marks updated services `updated`, unchanged services `up_to_date`, and the run
   successful.

### Primary workflow: no updates

1. Detection completes for the requested scope.
2. All services are up-to-date, unsupported, or explicitly excluded; no actionable plan entries
   exist.
3. rfapps performs no pull, confirmation, deployment, or generation mutation.
4. The report explains every service outcome and returns success if there were no unknown/error
   outcomes.

### Error workflow: detection cannot determine freshness

1. Detection records an `unknown` outcome with the registry or local-state reason.
2. Unknown services are excluded from mutation by default and never labeled up-to-date.
3. If the remaining services can proceed safely, the report preserves the mixed detection result;
   otherwise the lifecycle stops before confirmation.
4. The operator receives a retry or authentication/configuration action rather than an update
   failure after mutation.

### Error workflow: plan becomes stale

1. Before mutation, rfapps revalidates the reviewed Compose intent and proposed image artifact.
2. If either has changed, the lifecycle stops with no service mutation.
3. The report identifies which assumption changed and directs the operator to regenerate and review
   the plan.

### Recovery workflow: update fails verification and restore succeeds

1. The update artifact is applied, but the target service fails its verification contract.
2. rfapps marks the attempted update failed and selects the named pre-update generation.
3. rfapps restores the exact prior image artifact for the service recovery unit.
4. rfapps verifies the restored target and its required dependencies.
5. The successful restoration is appended to history as a new generation without altering the old
   generation.
6. The final report marks the service `restored`, shows both generation references, and returns a
   non-zero update outcome with the final runtime condition healthy.

### Recovery workflow: restoration fails

1. The update fails verification and automatic restoration begins.
2. The prior artifact cannot be pulled, started, or verified.
3. rfapps records the failed restoration attempt without creating a known-good generation.
4. The lifecycle stops further unsafe work for the affected recovery unit.
5. The report marks `restore_failed`, preserves all evidence, and gives exact manual commands or
   generation/artifact identifiers needed for recovery.

### Error workflow: no safe recovery target

1. Preflight cannot resolve an exact usable artifact and named successful generation.
2. The service is blocked or excluded before any mutation.
3. The preview explains the missing safety prerequisite and any explicit reduced-safety override.
4. No report may describe that service as protected by restore-on-failure.

## Domain Model and State Transitions

### Core domain concepts

- **Update run**: One requested lifecycle execution over a resolved service scope. It owns the
  aggregate result and report.
- **Service update**: The per-service lifecycle record within a run.
- **Detection result**: Freshness classification plus evidence and reason.
- **Update artifact**: The immutable image identity proposed for use, separate from its human-facing
  tag.
- **Plan**: The reviewed intent binding service scope, proposed artifacts, Compose state, and
  recovery eligibility.
- **Recovery generation**: A named, successful per-service generation selected before mutation.
- **Recovery unit**: The smallest group that must move together for safe update or restoration,
  typically a service plus required sidecars.
- **Verification contract**: The bounded evidence required to call the updated or restored service
  usable.
- **Lifecycle report**: The durable audit result relating plan, services, generations, evidence, and
  final outcomes.

### Per-service state transition model

```text
selected
  -> detecting
    -> up_to_date -------------------------------> complete
    -> unsupported ------------------------------> complete
    -> detection_unknown ------------------------> blocked
    -> update_available
      -> planned
        -> blocked_no_recovery ------------------> blocked
        -> awaiting_approval
          -> cancelled --------------------------> complete
          -> applying
            -> verifying_update
              -> updated ------------------------> complete
              -> restore_pending
                -> restoring
                  -> verifying_restore
                    -> restored -----------------> recovered_failure
                    -> restore_failed -----------> intervention_required
```

An apply/start failure may transition directly from `applying` to `restore_pending` if mutation may
have occurred. A failure proven to occur before any mutation can terminate as `update_failed`
without restoration.

### Aggregate run states

- `no_updates`: no actionable updates and no unresolved detection errors.
- `cancelled`: approval was declined before mutation.
- `succeeded`: every actionable service reached `updated` and no service ended unknown or failed.
- `recovered_failure`: at least one update failed but every affected service was successfully
  restored and verified.
- `partial`: services reached different terminal outcomes that require operator attention or an
  explicit partial-success policy.
- `failed`: an operational failure occurred before a safe terminal state could be established.
- `intervention_required`: at least one restoration failed or final health is unknown/unhealthy.

The run state must never erase per-service outcomes. A healthy final platform after restoration is
still `recovered_failure`, not `succeeded`.

## Existing Codebase Integration

The codebase already contains most of the user-facing primitives, but they are separate workflows
with different guarantees.

### Update awareness and planning

- `plan --check-updates` compares local and remote digests and includes local/remote digest evidence
  in the saved deployment plan.
- Plans already capture service scope and profiles, are saved as JSON, are linked by plan ID, and are
  guarded by a Compose file hash. A plan older than 24 hours currently produces a warning.
- Update-check errors currently collapse into `hasUpdate: false` for planning purposes. The managed
  lifecycle needs a first-class unknown state so errors cannot resemble a clean result.
- A same-reference digest update currently leaves `changeType` as `unchanged`; `apply` only operates
  on create/update/recreate entries. The lifecycle therefore needs update availability to become
  actionable reviewed intent.
- Current plan validation protects Compose-file drift but does not protect against a moving tag
  resolving to a different remote artifact between review and apply.

### Apply and verification

- `apply` already validates saved plans, asks for confirmation, supports sequential and parallel
  execution, pulls images, starts services, checks dependency readiness, and records results by plan
  ID.
- Successful apply records automatically create per-service generations. Failed apply records do
  not create generations.
- State recording is currently best-effort and occurs after deployment. A managed update cannot
  offer automatic restoration if its recovery anchor is unavailable, so recovery preflight has a
  stronger requirement than ordinary apply history.
- Sequential apply checks that service containers are running; parallel apply relies more heavily on
  execution results and dependency readiness. The managed lifecycle needs execution-mode parity.
- Unavailable readiness telemetry is currently a warning that can allow startup verification to
  continue. The managed lifecycle must explicitly classify whether its verification contract was
  satisfied, fell back, or remained unknown.

### Generations and restoration

- Every successful deploy, rebuild, apply, or rollback appends an immutable, per-service generation.
  Generations can be listed and selected by service/number or by time.
- A successful restore appends a new generation, preserving the immutable audit history.
- Existing rollback restores the service image only, uses current Compose configuration, and never
  restores volumes or databases. This is the correct boundary to expose in the managed lifecycle.
- Current generation records store an image reference and configuration snapshot. For moving tags,
  the same reference may identify different image content over time; recovery needs an exact prior
  artifact identity to make "restore" testable.
- Existing rollback records success after the recreate command succeeds but does not run the same
  target verification expected by this lifecycle. Automatic recovery must verify the restored state.

### Health and diagnostics

- `health` provides bounded dependency readiness using container state, container health, and TCP
  probes, with structured evidence and timeout behavior.
- `doctor` and runtime status checks already surface target container health and update awareness as
  read-only diagnostics.
- These are useful evidence sources, but the managed lifecycle needs one explicit per-service
  verification contract rather than treating dependency readiness as application health.

### Product fit

The feature directly advances the roadmap's rfapps lifecycle sprint and its exit criterion of an
end-to-end update workflow with restoration to a named generation. It also passes the research
feature filter: it solves a demonstrated day-two operations problem, leverages persistent state,
cannot be reproduced by a single raw Compose command, and reuses existing plan/apply, health, state,
and generation concepts rather than creating a separate orchestration model.

## Measurable Success Criteria

1. Given a running service whose moving image tag resolves to a different remote artifact, detection
   reports `update_available`, and the saved preview contains an actionable update for that service.
2. Given a registry lookup failure, detection reports `unknown` with a reason, performs no mutation
   for that service, and never reports it up-to-date.
3. Given a local-build service, the lifecycle reports `unsupported` with no registry mutation.
4. Given no actionable updates, the lifecycle performs zero pulls, starts, confirmations, restores,
   or generation writes and returns a successful no-op report accounting for all selected services.
5. Given an actionable plan in human mode without explicit approval, the lifecycle presents one
   reviewed summary and makes no mutation when approval is declined.
6. Given a plan whose Compose intent or proposed remote artifact changed after preview, apply refuses
   before mutation and directs the operator to regenerate the plan.
7. Given an update-eligible service without an exact prior artifact and named successful generation,
   the default lifecycle blocks that service before mutation and labels automatic recovery
   unavailable.
8. Given a healthy update, the target service and required dependencies pass their verification
   contract, exactly one successful post-update generation is recorded for that service, and the
   report links old generation, new generation, plan, and artifact identities.
9. Given a target that starts but fails health verification, the lifecycle does not classify the
   update successful and automatically begins restoration when eligible.
10. Given a failed update and successful restore, the exact pre-update artifact is running, the
    restored target passes verification, a new rollback generation is recorded, the service outcome
    is `restored`, and the command returns non-zero.
11. Given a failed restoration, no successful generation is created for the failed attempt; the
    report outcome is `restore_failed`, final health is explicit, and manual recovery guidance names
    the recovery generation and artifact.
12. Sequential and parallel runs over the same scenario produce equivalent service terminal states,
    verification evidence requirements, report fields, and exit classification.
13. Human-readable and structured outputs contain the same service scope, update outcomes,
    generation references, verification result, restoration result, and final runtime condition.
14. Re-running detection immediately after a successful update reports the service up-to-date; an
    already-used or stale plan cannot silently apply a different artifact.
15. Automated tests cover at least: no update, confirmed update, detection unknown, cancelled apply,
    stale plan, apply failure before mutation, verification failure, successful restoration,
    restoration failure, unavailable health telemetry, no prior generation, moving tag, sidecar
    recovery unit, mixed-service result, and sequential/parallel parity.

## Open Questions

1. What is the public command shape: one `rfapps update` command with lifecycle options, explicit
   `detect/plan/apply` subcommands, or an orchestration layer over the existing commands? The UX must
   preserve inspectability without duplicating existing concepts.
2. Is a multi-service run atomic? The simplest model restores only failed recovery units and reports
   mixed outcomes; the safest compatibility model restores every service changed by the run when
   any verification fails. This policy must be decided before exit semantics are finalized.
3. What exactly defines a recovery unit beyond legacy sidecars? Dependency-linked services may need
   coordinated restore to avoid version skew, but widening recovery scope increases surprise.
4. Which target-level signals satisfy verification for services with no Compose healthcheck? Options
   include running-state fallback, configured TCP/HTTP probes, or fail-closed unverifiable status.
5. Should unavailable verification telemetry automatically trigger restoration, block before apply,
   or allow an explicit reduced-safety mode?
6. How will a generation retain an exact previous image artifact when the Compose image uses a moving
   tag, and what happens if that artifact is no longer local or available from the registry?
7. Does the first release require an existing named generation, or may it create a dedicated
   pre-update recovery snapshot after preflight? Either way, mutation must not begin until the anchor
   is durable.
8. Should the lifecycle ever allow update without automatic recovery, and if so, what explicit flag,
   warning, report state, and automation contract communicate the reduced guarantee?
9. How should services with known irreversible database migrations declare that image restoration is
   unsafe? A denylist, per-service policy, or explicit operator acknowledgment may be needed.
10. Does successful restoration append only the normal rollback generation, or should the failed
    update attempt also have a dedicated lifecycle event even though it must not become a successful
    generation?
11. What exit-code distinction, if any, should exist between recovered failure, mixed/partial result,
    and intervention-required restoration failure? At minimum, none should return success.
12. Should remote artifact drift ever be force-applicable, or must a changed digest always require a
    new preview because it invalidates what the user approved?
13. Is update policy limited to explicit operator invocation in this issue, or are allowlists,
    maintenance windows, and notification-only scheduling expected? The recommended initial scope is
    explicit invocation only.
14. The original research described restoring a known-good configuration snapshot, while shipped
    generations deliberately restore image only. Should product language remain image restoration,
    or is full configuration restoration a future prerequisite? The current feature must not imply
    data or configuration rollback beyond what it can prove.
