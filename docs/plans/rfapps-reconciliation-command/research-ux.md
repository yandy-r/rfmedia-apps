# UX Research: `rfapps reconcile`

## Executive Summary

`rfapps reconcile` should feel like an inspection command that can be explicitly promoted into a
convergence command. The default invocation must make that safety boundary unmistakable:

```bash
rfapps reconcile
```

It observes resolved Compose desired state and live Docker actual state, reports deterministic
differences and proposed actions, and changes nothing. Mutation occurs only with the command-specific
gate:

```bash
rfapps reconcile --auto-apply
```

The best interaction model combines Terraform's preview-first clarity with controller-style
re-observation from Argo CD and Flux. The command should not imitate a continuous controller: it is a
single, level-triggered cycle whose final report accounts for every selected service. A successful
Docker subprocess is not the UX definition of success; auto-apply succeeds only when post-action
observation proves the selected scope is converged.

The design should extend established rfapps conventions:

- Human output goes to stderr; structured output remains uncontaminated on stdout.
- `--output json|yaml|csv|table|text` and legacy `--json` retain their global meanings.
- Machine formats never prompt or render interactive progress.
- Service selection continues to support `--service`, `--services`, `--group`, profiles, and
  sidecar policy.
- Exit codes remain `0` success, `1` operational error, `2` usage error, and `3` partial success.
- Colors and symbols supplement words; they never carry meaning alone.

The public result should be versioned (for example, `reconcile.v1`) and separate stable semantic
data from volatile metadata. Service comparisons should be sorted lexicographically; a separate
actions list may use dependency execution order with a lexical tie-breaker. This lets two equivalent
observations produce equivalent diffs and proposed actions while still supporting safe execution.

## User Workflows

### Report-only workflow

Primary commands:

```bash
rfapps reconcile
rfapps reconcile -s plex
rfapps reconcile --services plex,tautulli
rfapps reconcile -g media-stack --output json
```

Expected sequence:

1. Resolve the requested scope, profiles, Compose path, environment, and sidecar policy.
2. Observe desired and actual state.
3. Classify every selected service as in sync, drifted, or observation failed.
4. Attach one proposed action (`none`, `create`, `start`, `recreate`, or `blocked`) and a reason.
5. Print the complete report and a clear statement that no changes were made.
6. Exit `0` when a trustworthy report is produced, even when drift exists.

Recommended human output:

```text
Reconciliation report (report-only)
Compose: /srv/rfmedia-apps/compose.yml
Scope: media-stack (7 services)

DRIFTED  plex       action: recreate  eligibility: allowed
  image: linuxserver/plex:1.40.0 -> linuxserver/plex:1.41.0
IN SYNC  tautulli   action: none
BLOCKED  kometa     action: none      reason: actual state could not be inspected

Summary: 1 drifted, 1 in sync, 1 blocked; 1 action proposed; 0 actions executed
No changes were made. Review the report, then rerun with --auto-apply to remediate eligible drift.
```

Every selected service should have at least one compact line. `--verbose` can expand unchanged
details, but in-sync services should not disappear: omission is ambiguous in reconciliation output.
Direction should be explicit for runtime-only changes, for example `container ahead; Compose will
win`. Operators who intend to preserve runtime changes should be directed to `rfapps drift import`.

Machine output should contain the same scope and decisions without human presentation fields:

```json
{
  "schemaVersion": "reconcile.v1",
  "mode": "report",
  "status": "reported",
  "scope": { "services": ["plex", "tautulli"] },
  "services": [
    {
      "service": "plex",
      "comparison": "drifted",
      "differences": [],
      "proposedAction": "recreate",
      "eligibility": { "status": "allowed", "reasonCode": "policy_allows" },
      "outcome": "report_only"
    }
  ],
  "actions": [],
  "summary": { "total": 2, "drifted": 1, "inSync": 1, "proposed": 1, "executed": 0 }
}
```

The real schema should include typed, secret-safe differences. The abbreviated example illustrates
the interaction contract, not a license to omit them.

### Apply workflow

Primary commands:

```bash
rfapps reconcile -s plex --auto-apply
rfapps reconcile -g media-stack --auto-apply --yes
rfapps reconcile -g media-stack --auto-apply --output json
```

Expected sequence:

1. Produce the same report and proposed actions as report-only mode.
2. In a human TTY, show an exact action summary and request one confirmation unless `--yes` is set.
3. Treat `--auto-apply` as the mutation authorization. Neither `--yes` nor machine output implies
   it; `--yes` only suppresses the confirmation after authorization exists.
4. Re-observe each service immediately before acting. Do not execute stale intent.
5. Apply only eligible, correctable actions and show stage-level progress.
6. Re-observe after bounded readiness checks and report the final state of every selected service.

Recommended confirmation:

```text
Auto-apply will modify 2 of 7 selected services:
  RECREATE  plex
  START     tautulli
Runtime-only changes will be replaced by the declared Compose state.
Proceed? [y/N]
```

The prompt should appear after differences are visible, not before discovery. Machine modes do not
prompt; `--auto-apply` is already explicit authorization. Global `--dry-run` must override
`--auto-apply`, render proposed actions, execute none, and say so in both human and structured
results.

The final apply report must distinguish `converged`, `became_in_sync`, `blocked`, `action_failed`,
and `not_converged`. It should never collapse mixed outcomes into a generic “complete” message.

### No-op workflow

```bash
rfapps reconcile --auto-apply
```

When all selected services are already in sync:

- Do not prompt, acquire a mutation lock, or call mutating Docker commands.
- Show each service as `IN SYNC` (compactly), action `none`, and executed count `0`.
- End with `All 7 selected services are in sync. No actions were needed.`
- Return exit `0` in report and auto-apply modes.
- Produce the same semantic machine result on repeated equivalent runs.

### Failure and recovery workflow

The command should preserve partial evidence instead of replacing it with one generic error. If
three services converge and one fails, the successful services remain `converged`, the failed
service retains its initial differences and attempted action, and the cycle status is `partial`.

Recovery should be level-triggered:

```bash
# Fix the Docker/Compose prerequisite, then inspect what remains.
rfapps reconcile -g media-stack

# Apply only currently eligible remaining differences.
rfapps reconcile -g media-stack --auto-apply
```

The command must not tell users to replay an old action list. A rerun observes current state and
derives fresh actions. If interrupted, stop scheduling new actions, preserve already completed
outcomes when possible, and never claim rollback unless rollback actually occurred.

## CLI UX Best Practices and Accessibility

- **Use mode in the heading.** Always show `(report-only)`, `(dry-run)`, or `(auto-apply)` so copied
  logs retain the safety context.
- **Lead with state words.** Use `DRIFTED`, `IN SYNC`, `BLOCKED`, `CONVERGED`, and `FAILED`; symbols
  such as `~`, `=`, and `!` are secondary scanning aids.
- **Do not rely on red/green.** Preserve meaning with text, alignment, and stable ordering for
  color-blind users, monochrome terminals, log collectors, and screen readers.
- **Respect terminal capability.** Disable ANSI and animated rendering when stderr is not a TTY.
  Final output must be static and readable after spinner cleanup.
- **Keep language directional.** Label fields `actual` and `desired`, or render
  `actual -> desired`; avoid ambiguous “old/new” for live drift.
- **Make destructive consequences explicit.** `recreate` should say that the container may restart;
  runtime-only configuration will be replaced. Never imply persistent volume or application data
  rollback.
- **Account for scope.** Echo resolved service count, profile, Compose path, and sidecar expansion.
  If a requested service adds a sidecar, state that before confirmation.
- **Keep the happy path concise.** One line per service plus a summary is sufficient by default.
  Put field-level diffs under drifted services and reserve unchanged field dumps for `--verbose`.
- **Make commands copyable.** Recovery hints should be complete commands that preserve the original
  scope where possible.
- **Do not overload existing words.** `report-only` means no mutation; `dry-run` means mutation was
  requested but globally suppressed; `blocked` means an action exists but policy or evidence
  forbids it; `failed` means an attempted operation or required observation failed.
- **Keep secrets masked structurally.** Redaction must be present in JSON/YAML/CSV as well as text,
  not merely applied by the text renderer.

## Error Handling and Recovery

| Situation                                     | Human presentation                                                                    | Machine classification                                                                          |                                              Exit | Recovery                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------: | ------------------------------------------------------------------------- |
| Invalid option combination or unknown service | Short usage error plus valid alternatives                                             | No reconciliation result required                                                               |                                                 2 | Correct flags or service name and rerun                                   |
| Compose cannot be resolved                    | Identify file/profile and sanitized root cause                                        | `status: failed`, stable reason such as `desired_state_unavailable` when a result can be formed |                                                 1 | Run Compose validation, correct env/profile inputs, rerun                 |
| Docker is unavailable or unauthorized         | Name the Docker context and failed observation stage                                  | `actual_state_unavailable`                                                                      |                                                 1 | Restore daemon/context/permissions, rerun report-only                     |
| One service cannot be inspected               | Keep other service evidence; mark this service blocked                                | `observation_failed`; aggregate `partial`                                                       |                                                 3 | Fix container ambiguity or inspect permission, rerun the same scope       |
| Drift changes before action                   | Say the original action was not executed and show the new observation                 | `became_in_sync`, `stale`, or re-planned outcome                                                |                       0 or 3 by final scope state | No replay; trust final observation and rerun if drift remains             |
| Confirmation declined                         | Say `Cancelled; no actions executed`                                                  | `status: cancelled`, all actions unexecuted                                                     |                                                 0 | Rerun with `--auto-apply` when ready                                      |
| Maintenance window blocks action              | Still show full report and next eligible time when known                              | eligibility `blocked`, stable policy reason                                                     |                 3 in auto-apply; 0 in report mode | Invoke from an external scheduler during the allowed window               |
| Docker action fails                           | Show service, stage, sanitized cause, and remaining drift                             | `action_failed`; aggregate `partial` or `failed`                                                | 3 when other evidence/outcomes exist; otherwise 1 | Fix prerequisite and rerun; do not replay stale action data               |
| Docker reports success but drift remains      | Explicitly say `not converged` and show final differences                             | `not_converged`                                                                                 |                                                 3 | Inspect final differences/health, correct desired state or runtime, rerun |
| SIGINT/SIGTERM during apply                   | Stop scheduling, show interrupted stage and truthful completed outcomes when possible | `status: interrupted`                                                                           |                                                 1 | Rerun report-only to discover current state                               |

Reason codes must be stable and sanitized; raw Docker stderr can appear only in debug diagnostics on
stderr. Errors should name the failing lifecycle stage (`resolve`, `observe`, `revalidate`, `apply`,
or `verify`) so recovery does not require reading a stack trace.

## Performance UX, Progress, and Output-Channel Behavior

### Human TTY

Use a small number of durable stages rather than one spinner per field:

```text
Observing desired state... done
Inspecting 7 services... done
Planning actions... 2 proposed
Applying 1/2: plex (recreate)... done
Verifying 1/2: plex... converged
```

Show counts and current service for operations that may take seconds. For health waits, show elapsed
time and the configured timeout. Avoid optimistic completion messages before verification.
Dependency-aware parallelism may interleave progress, but the final report must return to stable
ordering. Do not stream unbounded container logs into reconciliation output.

### Non-TTY text

Emit plain, newline-delimited stage transitions to stderr with no cursor movement or ANSI codes.
Avoid high-frequency polling messages; print a new line only when a service changes stage, a warning
occurs, or a periodic long-wait threshold is reached.

### Machine formats

- Emit exactly one final structured document on stdout for JSON/YAML/table/CSV modes, matching the
  existing `formatOutput` convention.
- Suppress prompts, spinners, and ordinary progress. Optional debug diagnostics go to stderr and
  must never contain secrets.
- The final document alone must explain scope, initial differences, proposed actions, attempts,
  final observations, and aggregate status. Consumers must not need stderr to interpret it.
- Keep service comparisons lexicographically ordered. Keep action execution order explicit and
  deterministic by dependency phase, then service name.
- Include a schema version and stable reason codes. Timestamps, duration, and cycle IDs may vary,
  but must not influence action choice or semantic ordering.

### Large scopes and future scheduling

Observation should visibly progress by service count without printing every inspected field.
Maintenance-window compatibility should be modeled as an eligibility decision, not a foreground
wait: report at any time, label blocked actions, include `nextEligibleAt` when policy can calculate
it, and let an external scheduler invoke the command later. A foreground command must not sleep
until a window opens.

## Competitive Analysis

| Tool                   | Official UX pattern                                                                                                                                                                                                                                                                                                                                                            | Lesson for rfapps                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terraform `plan`       | [`terraform plan`](https://developer.hashicorp.com/terraform/cli/commands/plan) previews proposed actions without applying them, supports saved plans, disables input in JSON mode, and offers detailed exit codes. It warns that state may change between a speculative plan and apply.                                                                                       | Make report-only the default, revalidate before mutation, and separate drift-as-data from operational failure. Preserve rfapps' established exit codes rather than copying Terraform's optional exit `2` semantics.    |
| Terraform machine UI   | The [machine-readable UI](https://developer.hashicorp.com/terraform/internals/machine-readable-ui) versions its schema, emits typed events, and tells clients to tolerate backward-compatible additions.                                                                                                                                                                       | Version `reconcile.v1`, use stable typed statuses/reasons, and keep human text out of the integration contract. rfapps should retain one final document rather than introduce an event stream solely for this feature. |
| Argo CD sync           | [`argocd app sync`](https://argo-cd.readthedocs.io/en/stable/user-guide/commands/argocd_app_sync/) exposes explicit sync, dry-run, resource scoping, timeout, wait/async, force, and prune controls. [Sync options](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/) distinguish selective apply and destructive prune/replace behavior.                     | Keep scope visible, make forceful recreation explicit, and do not silently delete orphans. Reconciliation should only act on out-of-sync selected services.                                                            |
| Argo CD automated sync | The [automated sync policy](https://argo-cd.readthedocs.io/en/latest/user-guide/auto_sync/) separates automatic sync, self-healing, and pruning; pruning is disabled by default as a safety measure.                                                                                                                                                                           | `--auto-apply` authorizes convergence but should not imply prune, orphan removal, image update, or reverse import.                                                                                                     |
| Flux reconcile         | [`flux reconcile kustomization`](https://fluxcd.io/flux/cmd/flux_reconcile_kustomization/) triggers a cycle and waits for completion, supports source refresh, and inherits a timeout. Flux [Kustomization behavior](https://fluxcd.io/flux/components/kustomize/kustomizations/) separates interval, wait/health, timeout, dependency readiness, suspend, and prune policies. | Auto-apply should wait for bounded verification and report readiness, while future maintenance policy should block actions rather than block observation. Keep dependency and policy decisions explicit.               |
| Docker Compose         | [`docker compose`](https://docs.docker.com/reference/cli/docker/compose/) provides dry-run, controllable progress modes, profiles, and parallelism; `compose up` reconciles changed services by recreating containers while preserving mounted volumes.                                                                                                                        | Reuse Compose as the executor, but provide a higher-level stable report. Match progress to TTY/machine context and do not expose Compose's noisy progress as the machine contract.                                     |

## Recommendations by Priority

### P0: Required for a safe first release

1. Make `rfapps reconcile` strictly report-only; only `--auto-apply` authorizes mutation, and
   `--dry-run` always wins.
2. Print the mode, resolved scope, every selected service, directional differences, proposed action,
   eligibility, and aggregate counts. End report mode with `No changes were made.`
3. Use a versioned deterministic result (`reconcile.v1`) with lexically ordered service evidence,
   dependency-ordered actions, stable reason codes, and secret-safe values.
4. Revalidate immediately before each mutation and verify actual convergence afterward. Treat
   remaining drift as `not_converged`, not success.
5. Preserve stdout for the single structured result and stderr for human/progress/debug output.
   Suppress prompts and progress in machine formats.
6. Retain rfapps exit semantics: report completion/no-op `0`, operational failure `1`, usage `2`,
   and mixed/blocked/not-converged auto-apply `3`.
7. Never imply pruning, orphan deletion, image freshness, reverse import, or data rollback. Point to
   `rfapps update` and `rfapps drift import` for those separate intents.

### P1: Strong usability and operability improvements

1. Use compact word-first service lines and stage-based TTY progress; `--verbose` expands details.
2. Prompt once in a human TTY after displaying exact actions, unless `--yes` is set. Do not prompt
   for an empty action set.
3. Preserve complete partial results and provide copyable recovery commands that rerun the current
   scope from fresh observations.
4. Include per-action lifecycle stages and elapsed/timeout evidence so failures identify whether
   observation, apply, or verification failed.
5. Include `eligibility.status`, `reasonCode`, and an optional `nextEligibleAt` now so maintenance
   windows can be added without changing the comparison model.

### P2: Follow-up enhancements

1. Consider an opt-in `--fail-on-drift` for CI policy checks. Do not make drift an error in the
   default report-first command.
2. Consider persisted, reviewable reconcile artifacts only if they gain authority fingerprints and
   secure file permissions; never apply them without fresh revalidation.
3. Consider asynchronous or scheduled reconciliation only as a separate feature. The initial CLI
   should remain a bounded foreground cycle.

## Open Questions

1. When no scope flags are supplied in a TTY, should report-only reconciliation open the existing
   interactive selector or inspect all services immediately? Whichever rule is chosen must be
   documented and machine/non-TTY behavior must remain deterministic.
2. Should human auto-apply require one confirmation even though `--auto-apply` is explicit, or is
   the flag alone sufficient? The conservative recommendation is one post-report confirmation with
   `--yes` as the suppression mechanism.
3. How should a scope-level failure before any service can be inspected be represented in JSON:
   a minimal `reconcile.v1` failure document or the CLI's common structured error envelope?
4. Which runtime health states are correctable by `start`/`recreate`, and which must be reported as
   blocked without mutation?
5. Should an observation failure for one selected service make report mode exit `3`, or should all
   completed reports exit `0` with consumers branching on `status`? Auto-apply should remain `3`
   when full convergence cannot be established.
6. Will the first release serialize auto-apply under the existing lifecycle lock? If not, the UX
   must explicitly report stale observations and avoid claiming concurrency safety.
7. What maintenance-window source and precedence will issue #169 define, and will mixed eligible
   and blocked scopes partially apply or defer the entire mutation phase?
