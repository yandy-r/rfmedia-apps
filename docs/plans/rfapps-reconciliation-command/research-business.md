# rfapps Reconciliation Command: Business and Domain Research

## Executive Summary

`rfapps reconcile` should be a safe, on-demand convergence workflow for Docker Compose services:

`observe desired state -> observe actual state -> explain differences -> propose actions -> optionally apply -> verify`

The primary product is the explanation, not the mutation. By default, the command must report what
is out of alignment and what rfapps would do without changing containers, Compose files, images,
volumes, or deployment history. `--auto-apply` is the explicit boundary that authorizes rfapps to
bring correctable services toward the declared Compose state.

This makes the command a top-level, operator-friendly evolution of the shipped drift workflow from
issue #146. Drift detection supplies desired-versus-actual evidence; reconciliation turns that
evidence into deterministic action intent and, only when requested, executes it. It should not
become a continuous daemon, an image-update manager, or a reverse-import operation. Those concerns
belong to external schedulers, `rfapps update`, and `rfapps drift import`, respectively.

The core business promise is level-triggered and idempotent behavior. Each run acts on the current
state, accounts for every selected service, and proves convergence with a post-action observation.
Re-running after full convergence is a successful no-op. A Docker command returning success is not
enough if the observed service remains different from its declared state.

Compatibility with maintenance windows from open issue #169 should be designed in now. Reporting
must always remain available, while automated remediation must have an explicit eligibility result
that can later be blocked outside an allowed window with a clear reason.

## User Stories

### Self-hosting operator

- As an operator, I want one command to compare my selected Compose services with their live Docker
  state so that I can see whether the platform matches what I declared.
- As a cautious operator, I want reconciliation to be report-only by default so that checking state
  cannot unexpectedly restart or recreate a service.
- As an operator, I want each difference paired with the action rfapps proposes so that
  `--auto-apply` is an informed choice rather than a blind force-recreate.
- As an operator, I want Compose to remain the authoritative desired state so that runtime changes
  are not silently imported into source-controlled configuration.
- As an operator, I want every selected service represented in the result, including in-sync,
  blocked, failed, and converged services, so that omissions cannot look like success.
- As an operator, I want a repeated run after successful remediation to do nothing so that routine
  reconciliation is safe and predictable.

### Automation consumer

- As a script or CI consumer, I want a versioned, deterministic result with stable differences,
  action types, reasons, ordering, and aggregate counts so that I do not parse human logs.
- As an automation consumer, I want machine-readable output to remain report-only unless I also
  pass `--auto-apply` so that choosing JSON or YAML never grants mutation authority.
- As an automation consumer, I want report completion, full convergence, partial convergence, and
  operational failure to be distinguishable through both structured status and documented exit
  behavior.
- As a scheduler user, I want maintenance policy to block remediation without blocking observation
  so that I can collect drift reports at any time and mutate only during approved windows.

### Recovery operator

- As an operator recovering from an interrupted run, I want the next invocation to inspect current
  state again and act only on remaining differences so that I do not need to replay an action log.
- As an operator investigating a failed remediation, I want the final report to show the original
  difference, attempted action, observed final state, and failure reason so that I know what remains
  to fix manually.

## Business Rules and Edge Cases

### Scope and authority

1. Resolved Compose configuration is the desired state. Live Docker container configuration and
   runtime condition are the actual state.
2. The command must honor the established service, multi-service, group, profile, Compose-file,
   environment-file, secrets-provider, and sidecar selection rules. Any sidecars added by policy
   are part of the reported resolved scope.
3. Selection must remain fixed within a cycle. The comparison, proposed actions, mutation set, and
   final report must not silently widen to services outside the resolved scope.
4. Reconciliation is one-way: desired Compose state wins. A `container_ahead` or `diverged` result
   must explain that `--auto-apply` will replace runtime-only changes and should direct users who
   intend to keep those changes toward the import workflow.
5. The initial command manages services declared in the selected Compose project. It must not
   delete unrelated containers, Compose orphans, images, networks, or volumes merely because they
   are absent from the selected desired state.

### Observer-first safety

1. `rfapps reconcile` without `--auto-apply` is strictly read-only. It may inspect Compose and
   Docker state and render a report, but it must not start, stop, restart, create, recreate, remove,
   pull, build, edit files, save successful generations, or write deployment history.
2. `--auto-apply` is the sole command-specific authorization for remediation. Global machine-output
   flags, non-interactive execution, stdin state, or `--yes` must never imply `--auto-apply`.
3. Global `--dry-run` overrides `--auto-apply`; the combination reports the same intended actions
   but performs no mutation.
4. A clean comparison is a successful no-op. It requires no confirmation and proposes no mutation.
5. Cancellation or an empty interactive selection performs no mutation and must not be represented
   as a completed convergence cycle.

### Differences and proposed actions

1. Every selected service has exactly one comparison outcome: `in_sync`, `drifted`, or
   `observation_failed`.
2. Drift evidence should retain the shipped categories from issue #146: image, environment, ports,
   volumes, networks, and runtime status. Secret-like environment values remain masked in every
   human and machine format.
3. Every service also has exactly one proposed action outcome: `none`, `create`, `start`,
   `recreate`, or `blocked`. The final public taxonomy may combine `create` and `start`, but it must
   distinguish no-op, actionable, and non-actionable results without relying on prose.
4. Missing desired containers are actionable. Stopped containers with otherwise matching
   configuration require a start-equivalent action. Configuration or image-reference drift
   requires recreation. Runtime health that cannot be corrected safely is reported as blocked or
   failed rather than mislabeled as configuration convergence.
5. Multiple drift categories for one service produce one service-level action with all causal
   differences attached; the report must not imply that the same service will be recreated once per
   category.
6. Differences that cannot be observed reliably are not actionable by default. Compose parsing
   errors, Docker inspection failures, ambiguous container identity, and unavailable required data
   must not produce speculative mutation.
7. Registry freshness is not reconciliation drift. A moving tag whose desired and current image
   reference is the same belongs to `rfapps update`; reconciliation must not pull a newer registry
   artifact merely because it exists.
8. Build-only services and locally tagged images can still be reconciled when declared-versus-live
   configuration is observable, but reconciliation must not invent registry-update semantics for
   them.

### Deterministic reporting

1. Machine output must be versioned and include the resolved scope, mode, service comparisons,
   proposed actions, policy decisions, per-service outcomes, and aggregate summary.
2. Given equivalent normalized desired state, actual state, selection, and options, semantic output
   must be identical: services, categories, differences, actions, reasons, and summary counts use a
   documented stable order. Run identifiers and timestamps may vary but must not affect semantic
   ordering or action selection.
3. Human and machine output must describe the same selected services, differences, actions, and
   final outcomes. Progress text must not be required to understand machine output.
4. Current and desired values must use canonical comparison forms where representation order is not
   meaningful. Reordered environment entries, networks, ports, or volumes must not create noisy
   actions when their effective state is equal.
5. Error reasons must be stable, sanitized classifications with operator-safe context. Raw Docker
   output and resolved secrets must not leak into the structured result.

### Applying and proving convergence

1. Auto-apply targets only services whose current comparison is drifted, whose action is
   correctable, and whose policy decision allows mutation. In-sync, failed-to-observe, or
   policy-blocked services are never mutated.
2. The action must be checked against current state immediately before mutation. If the difference
   disappears or materially changes after the report snapshot, rfapps must skip it or re-plan it;
   it must not execute stale action intent.
3. Reconciliation must preserve persistent data surfaces. It does not remove volumes, prune
   images, edit Compose files, or promise to reverse application-level data changes.
4. After each attempted remediation, rfapps must observe the service again after a bounded readiness
   period. `converged` means the relevant desired-versus-actual differences are gone and the desired
   runtime condition is met.
5. A successful Compose subprocess followed by remaining drift is `not_converged`, not success.
6. One service failure must remain visible even if other services converge. The aggregate result is
   partial when selected services end in mixed terminal outcomes.
7. The command does not implicitly roll back configuration reconciliation. Recovery is
   level-triggered: fix the desired state or runtime prerequisite and run reconciliation again.
   Any future rollback policy must be explicit because reverting a container cannot undo volume or
   application-data changes.
8. An interrupted run creates no assumption that planned actions occurred. The next run observes
   current state and derives a fresh action set.

### Maintenance-window compatibility

1. Observation and reporting are permitted regardless of maintenance-window state.
2. Each proposed mutation must have an automation eligibility decision independent from its drift
   classification. Until issue #169 is implemented, the decision is effectively allowed because no
   window is configured, but the result model must leave room for an explicit blocked reason.
3. Once maintenance windows exist, `--auto-apply` outside an allowed window performs no blocked
   action and explains the applicable policy and next eligible condition. It must never report a
   blocked service as converged.
4. A foreground command must not silently wait until a future window. Deferral belongs to an
   external scheduler or a later explicit scheduling feature.
5. Maintenance policy is evaluated again before mutation so a long-running observation cannot
   cross into a denied period and still act on stale eligibility.

### Exit behavior

1. A completed default report exits successfully whether it finds zero or many differences; drift
   is the subject of the report, not an operational failure. Machine consumers use the structured
   convergence summary to branch on drift.
2. Auto-apply exits successfully only when all selected, observable, correctable services are in
   sync at the end of the cycle.
3. An auto-apply cycle with mixed convergence, policy-blocked actions, or uncorrectable selected
   drift uses the CLI's partial-success outcome. A failure that prevents a trustworthy cycle from
   being produced uses the operational-error outcome.
4. Usage errors, such as incompatible options or an unknown service, retain the CLI's established
   usage-error behavior.

### Edge cases

- A container disappears between observation and apply: re-observe and derive the now-appropriate
  create/start action rather than blindly executing the old action.
- Drift disappears between observation and apply: skip mutation and report that the service became
  in sync before action.
- Compose changes during the cycle: stop or re-plan affected services; never apply action intent
  derived from a different desired state.
- A service is missing, paused, restarting, dead, unhealthy, or still starting: report its precise
  runtime condition and do not flatten all cases into “not running.”
- One selected service cannot be inspected: preserve results for the others and mark the aggregate
  report partial or failed according to whether a trustworthy scope-level report was produced.
- Sidecar expansion introduces an already in-sync dependency: include it as accounted-for but do
  not recreate it.
- A service has both container-ahead and compose-ahead differences: mark it diverged, show both
  directions, and make the Compose-authoritative consequence explicit before auto-apply.
- A service uses a same-tag image whose registry digest moved: report it in sync when the declared
  and live references match; direct the user to the managed update workflow for freshness checks.
- Reconciliation is invoked twice concurrently: this feature must not claim concurrency safety
  until state locking exists; each run must at minimum reject or clearly surface observations that
  became stale before mutation.

## Workflows

### Primary workflow: report-only with drift

1. The operator chooses a service scope and runs `rfapps reconcile`.
2. rfapps resolves profiles and sidecar policy, then records the effective scope.
3. rfapps observes the resolved Compose desired state and live Docker actual state.
4. Each selected service receives a comparison outcome, complete difference set, proposed action,
   and automation eligibility decision.
5. rfapps emits a human or machine report in deterministic order.
6. No mutation or persistent operational record occurs. The completed report exits successfully.

### Primary workflow: auto-apply converges

1. The operator runs `rfapps reconcile --auto-apply` for an explicit scope.
2. rfapps performs the same complete observation and action derivation as report-only mode.
3. rfapps excludes in-sync, unobservable, and policy-blocked services from mutation.
4. Before each allowed action, rfapps revalidates the relevant desired state, actual state, and
   automation eligibility.
5. rfapps applies the current action to the correctable service.
6. rfapps observes the resulting state after bounded readiness and classifies the service as
   converged or not converged.
7. The final report accounts for every selected service and exits successfully only when the
   requested convergence is complete.

### Primary workflow: already converged

1. Observation finds every selected service in sync.
2. Each service receives action `none` and terminal outcome `in_sync`.
3. rfapps performs no confirmation or mutation, even when `--auto-apply` was passed.
4. Repeated runs produce the same semantic no-op result.

### Error recovery: observation failure

1. rfapps cannot obtain trustworthy desired or actual state for one or more services.
2. It does not propose speculative actions for affected services.
3. If no trustworthy cycle can be produced, the command ends with an operational error. If other
   selected services are trustworthy, their evidence remains in a partial report.
4. The report gives a stable reason and corrective next step, such as fixing Compose evaluation,
   Docker connectivity, permissions, or container ambiguity.

### Error recovery: stale action intent

1. Revalidation finds that desired state, actual state, or policy eligibility changed after the
   initial observation.
2. rfapps does not execute the stale action.
3. The affected service is re-planned within the same safe cycle or marked skipped with a precise
   reason.
4. A later invocation starts from the newly observed level and requires no action-log replay.

### Error recovery: partial convergence

1. One or more actions fail or remain drifted after post-action observation.
2. Successfully converged services retain their truthful outcomes; they are not relabeled failed
   because a peer failed.
3. Failed services retain original differences, attempted action, final observed differences, and
   actionable error context.
4. The cycle returns partial success, and the operator can correct the prerequisite and rerun only
   the remaining scope or the original scope idempotently.

### Error recovery: maintenance policy blocks automation

1. The full comparison and proposed-action report is produced.
2. Window-ineligible services receive action eligibility `blocked` with an explainable policy
   reason and are not mutated.
3. Eligible services may proceed if mixed-window policy allows it; otherwise the whole mutation
   phase is a controlled no-op.
4. The final result is not labeled converged while actionable drift remains. An external scheduler
   may invoke the same command again during the next allowed window.

## Domain Model and State Transitions

### Core domain concepts

- **Reconciliation cycle**: One invocation over a fixed resolved service scope, from observation to
  terminal report.
- **Desired-state snapshot**: The resolved, effective Compose declaration used as the authority for
  the cycle.
- **Actual-state snapshot**: The observed Docker container configuration and runtime condition for
  the same scope.
- **Service comparison**: One service's classification plus all differences between desired and
  actual state.
- **Difference**: A typed, directional, secret-safe mismatch in image, environment, ports, volumes,
  networks, or runtime status.
- **Proposed action**: The single level-triggered operation needed to move one service toward its
  desired state, or `none`/`blocked` when no mutation should occur.
- **Automation eligibility**: The policy decision that says whether an otherwise valid action may
  run now, including future maintenance-window constraints.
- **Action attempt**: The auditable relationship between proposed action, pre-action validation,
  execution result, and post-action observation.
- **Service outcome**: The terminal result for one selected service: `in_sync`, `report_only`,
  `converged`, `blocked`, `observation_failed`, `action_failed`, or `not_converged`.
- **Cycle outcome**: Aggregate result: `reported`, `converged`, `partial`, `failed`, or `cancelled`.

### Per-service state transitions

```text
selected
  -> observing
    -> observation_failed -------------------------------> terminal
    -> compared
      -> in_sync (action: none) --------------------------> terminal
      -> drifted
        -> action_blocked --------------------------------> terminal
        -> action_proposed
          -> report_only ---------------------------------> terminal
          -> revalidating
            -> became_in_sync ----------------------------> terminal
            -> stale_or_policy_blocked -------------------> terminal
            -> applying
              -> action_failed ---------------------------> terminal
              -> verifying
                -> converged -----------------------------> terminal
                -> not_converged -------------------------> terminal
```

The state machine is level-triggered. A later cycle does not resume from `applying` or replay an
attempt; it begins at `observing` and derives truth from current desired and actual state.

### Cycle aggregation

- `reported`: report-only observation completed, regardless of whether differences exist.
- `converged`: auto-apply completed and every selected observable service is now in sync.
- `partial`: trustworthy results exist, but at least one selected service is blocked, failed, or
  remains out of sync.
- `failed`: no trustworthy cycle-level result could be completed because of an operational error.
- `cancelled`: the operator cancelled selection or an explicit confirmation boundary before any
  mutation.

## Existing Codebase Integration

- **Drift detection from issue #146** already models image, environment, port, volume, network, and
  runtime-status differences, direction, secret masking, summaries, and a versioned machine result.
  Reconciliation should treat that as the evidence contract rather than create a competing
  definition of drift.
- **`rfapps drift reconcile`** currently force-recreates drifted services and is mutation-first.
  The top-level observer-first command creates a naming and safety overlap. The two entry points must
  not retain divergent semantics indefinitely; compatibility should be handled by an alias,
  deprecation, or clearly narrower legacy contract.
- **Plan/apply** already establishes desired-versus-running comparison patterns and the principle
  that actions should be reviewed before execution. Reconciliation may reuse those user concepts,
  but its report is a current-state cycle rather than a registry update plan or a promise to apply a
  saved deployment plan later.
- **Managed updates** own remote digest discovery, exact image targeting, health verification, and
  restore-on-failure. Reconciliation should not duplicate update discovery when a same-tag registry
  artifact changes.
- **Service resolution** already defines service/group/profile selection and sidecar expansion.
  Reconciliation must expose the same resolved scope in both human and machine output.
- **Global output and error behavior** already supports text, JSON, YAML, CSV, table, dry-run,
  debug, verbosity, and documented exit categories. The new command should preserve those operator
  expectations while ensuring output format never authorizes mutation.
- **Health and service status** already provide runtime readiness evidence. Reconciliation needs a
  bounded post-action observation that distinguishes a successful subprocess from actual
  convergence.
- **History and generations** record successful deploy-like operations. Whether a successful
  reconcile should create history or generation entries needs an explicit product decision; the
  default report must never write either.
- **Shell completion** is maintained as bash, zsh, and fish templates in the CLI. All three must
  discover the top-level command and its selection, Compose, output, `--auto-apply`, and inherited
  safety options consistently.
- **Documentation and roadmap** currently describe `drift reconcile` and identify issue #151 as the
  top-level next step. User docs must clearly separate read-only reconciliation, auto-apply,
  reverse import, and managed image updates, and `ROADMAP.md` must reflect the delivered state.
- **Issue #169 maintenance windows** names reconcile as a consumer of future scheduling policy.
  Reconciliation's action eligibility and blocked-reason behavior should be the stable integration
  boundary rather than embedding scheduler behavior into the command.

## Success Criteria

1. Given drifted selected services, running `rfapps reconcile` emits their complete differences and
   proposed actions but performs zero Docker or persistent-state mutations.
2. Given any machine output format, omitting `--auto-apply` remains read-only; machine output alone
   never bypasses the mutation gate.
3. Given `--auto-apply`, only currently drifted, observable, correctable, and policy-eligible
   services are mutated.
4. Given equivalent normalized desired and actual snapshots, two runs produce semantically
   identical ordered differences, actions, reasons, and summary counts apart from documented
   run-specific metadata.
5. Given a successful remediation, post-action observation proves the service is in sync before it
   is labeled converged.
6. Given a Compose action that exits successfully but leaves drift, the service is labeled not
   converged and the aggregate run is not successful.
7. Given no drift, report-only and auto-apply modes both complete as mutation-free successful
   no-ops.
8. Given multiple drift categories for one service, the report proposes one service action with all
   causal differences attached.
9. Given container-ahead or diverged state, the report clearly states that Compose is authoritative
   and does not import runtime configuration.
10. Given a secret-like environment variable difference, no supported human or machine format
    exposes either current or desired secret values.
11. Given a sidecar-expanded or profile-selected scope, every resolved service appears exactly once
    in the final result, including in-sync and failed services.
12. Given an interrupted or partially failed prior run, a new run observes current state and safely
    acts only on remaining drift.
13. Given a future denied maintenance window, reporting still completes, blocked actions do not
    execute, and the result explains why convergence was deferred.
14. Given a mixed auto-apply result, converged services and failed/blocked services remain
    distinguishable, and the aggregate command uses partial-success behavior.
15. Bash, zsh, and fish completion expose `reconcile` and its public options consistently, and user
    documentation examples match the actual safe default.

## Open Questions

1. Should `rfapps drift reconcile` become a compatibility alias for top-level `rfapps reconcile`,
   be deprecated, or remain as an explicitly mutation-only expert command? Keeping its current
   machine-output-implies-mutation behavior would conflict with the new safety contract.
2. Should `--auto-apply` alone authorize mutation, or should interactive users also confirm unless
   they pass global `--yes`? The safest automation contract is that `--auto-apply` is explicit
   authorization, while an optional human confirmation may still improve foreground UX.
3. What is the final stable action taxonomy for missing versus stopped services: separate `create`
   and `start`, or a single Compose `up` action with different reasons?
4. Should an auto-applied successful reconciliation write deployment history and generation
   snapshots? If yes, only post-verification convergence should be recorded as successful, and the
   new action type must be reflected in history filters and documentation.
5. What bounded readiness policy determines when runtime-status drift is considered converged,
   especially for services with no Docker healthcheck or long startup periods?
6. When issue #169 lands, do explicitly invoked foreground auto-apply commands obey maintenance
   windows, or only scheduled invocations? The recommended predictable default is that all
   `--auto-apply` operations obey the policy unless an explicit, auditable override is introduced.
7. Should policy-blocked auto-apply with no executed actions use partial-success exit behavior or a
   dedicated future exit/status contract? Structured output must remain authoritative either way.
8. Are dependency-coupled services reconciled and verified independently, or as an atomic recovery
   unit? The answer affects partial-success reporting and whether a dependent service may proceed
   after its prerequisite fails.
9. Should orphan detection ever be included as report-only evidence? Deletion should remain out of
   scope unless a separate explicit destructive policy is designed.
10. Does the first release need a saved reconcile-plan artifact, or is deterministic same-cycle
    report-and-apply sufficient? A saved artifact would require staleness, approval, and replay
    rules beyond the issue's current contract.
