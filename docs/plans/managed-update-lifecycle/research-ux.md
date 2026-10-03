# Managed Update Lifecycle: UX Research

## Executive Summary

The managed update lifecycle should feel like one controlled operation, not five loosely related
commands. The primary experience should be:

```text
detect -> preview -> approve -> apply -> verify -> keep or restore -> report
```

For an interactive operator, `rfapps update` should run detection, display an update-specific plan,
and stop at an explicit approval prompt before any mutation. After approval, it should keep the user
oriented through pull, recreate, verification, and any automatic restoration. The final screen must
state both the update outcome and the final runtime condition; “restored and healthy” is a recovered
failure, not a successful update.

For automation, the same workflow should be split across a saved, inspectable update plan and a
later explicit apply. Machine output must never imply approval: `--output json` without `--yes`
should fail before mutation rather than silently skip the prompt. The JSON result should use a
versioned `update.v1` schema and account for every service in the requested scope.

This design fits the repository's existing conventions:

- plans are saved under `.rfapps/plans/` and checked against the Compose hash;
- human output and logs go to stderr while structured output goes to stdout;
- `--yes`, `--dry-run`, `--verbose`, and `--output` are global conventions;
- apply already distinguishes pull, deploy, and dependency-readiness phases;
- per-service generations already provide recognizable restore targets;
- `history --generations` and `rollback --to-generation` provide an existing recovery vocabulary.

The current plan UX also exposes the central gap this feature must close: `plan --check-updates` can
show a service as both `unchanged` and `(update available)`, so the saved plan has no actionable image
change for `apply`. The managed update plan must instead treat a confirmed same-tag digest change as
an explicit update action and bind the reviewed remote artifact to the plan.

## User Workflows

### Interactive, end-to-end update

The primary command should be a single guided lifecycle:

```bash
rfapps update -g media-stack
```

Recommended presentation:

```text
Managed Update Plan
Run ID: upd-20260717-8f2a
Plan ID: 6c9f...
Scope: group media-stack (7 services)

SERVICE      CURRENT                       PROPOSED                      RECOVERY       VERIFY
plex         latest@sha256:18ba...         latest@sha256:c941...         generation #8  healthcheck
tautulli     v2.15@sha256:a213...           v2.16@sha256:7f02...          generation #4  running
sonarr       latest@sha256:028c...          up to date                    -              -
radarr       linuxserver/radarr:latest      unknown: registry timeout     -              -

Plan: 2 to update, 4 up to date, 1 unknown, 0 blocked
Plan saved to: .rfapps/plans/update-2026-07-17T14-32-08.json

Apply 2 image updates now?
Failed verification will automatically restore each pre-update generation.
Volumes and databases are not rolled back. (y/N)
```

Important behaviors:

1. Detection and preview are read-only. The prompt appears only when there is at least one
   actionable update.
2. Default answer is no. Escape, Ctrl+C before mutation, or `n` exits cleanly with the saved plan
   intact and a message showing how to resume.
3. Unknown and unsupported services remain visible but do not mutate by default.
4. Services without a safe recovery anchor are blocked or excluded before approval. If a reduced-
   safety override is supported, the plan and prompt must name those services explicitly.
5. Approval covers automatic restore-on-failure. Do not interrupt a failed update with a second
   restore prompt while the service is degraded.
6. The plan binds the proposed digest and recovery generation; apply revalidates both before the
   first mutation.

After approval, show stable stages rather than an unstructured stream:

```text
[1/4] plex      Pulling proposed image                              done  18s
[2/4] plex      Recreating container                                done   4s
[3/4] plex      Verifying health (healthy, 3/3 checks)              done  16s
[4/4] plex      Recording generation #9                             done

[1/4] tautulli  Pulling proposed image                              done   9s
[2/4] tautulli  Recreating container                                done   3s
[3/4] tautulli  Verifying health (timeout after 60s)                failed
[4/4] tautulli  Restoring generation #4 and verifying              done  21s
```

Final output should lead with what the operator needs to know:

```text
Update completed with recovery

SERVICE      OUTCOME       FINAL STATE  GENERATION             DURATION
plex         updated       healthy      #8 -> #9               38s
tautulli     restored      healthy      attempted, restored #4 93s
sonarr       up to date    running      unchanged                -
radarr       unknown       unchanged    registry timeout         -

1 updated, 1 restored, 4 up to date, 1 unknown
Run report: .rfapps/runs/upd-20260717-8f2a.json
Manual follow-up: rfapps update -s radarr
```

Because the requested update did not fully succeed, a run containing `restored`, `update_failed`,
or `restore_failed` should exit non-zero even when all services end healthy.

## Alternative Workflows

### Review now, apply later

Operators and CI systems need a durable two-step flow:

```bash
rfapps update -g media-stack --plan-only \
  --out .rfapps/plans/media-update.json

rfapps update --from-plan .rfapps/plans/media-update.json
```

`--from-plan` should re-render a compact summary and ask for approval in an interactive terminal.
It should refuse the plan if Compose intent, proposed digests, recovery anchors, platform, or
resolved service scope no longer match. The remedy should be “generate a new plan,” not a casual
`--force` suggestion. An advanced override, if retained, must enumerate exactly which checks it
bypasses.

### One-shot automation

```bash
rfapps update -s plex --yes --output json
```

This is appropriate for a trusted automation boundary because `--yes` explicitly authorizes
mutation. Without `--yes`, a non-TTY or machine-output invocation must return a structured usage
error before pulling or recreating anything:

```json
{
  "schemaVersion": "update.v1",
  "status": "approval_required",
  "success": false,
  "message": "Managed updates require --yes in non-interactive mode"
}
```

### Detection-only automation

```bash
rfapps update --plan-only --output json > update-plan.json
```

A clean no-update result is exit 0. Updates present are also a successful detection result and
should be expressed in JSON, not overloaded onto the repository's usage-error exit code. Terraform
and OpenTofu use exit code 2 for “changes present” with `-detailed-exitcode`, but rfapps already uses
2 for usage errors. If demand emerges, add a clearly named opt-in such as
`--changes-exit-code <code>` rather than silently changing the global contract.

### Explicit reduced-safety update

If the product allows an update without an exact recovery target, require a high-friction flag:

```bash
rfapps update -s plex --allow-no-restore
```

The preview should label the service `NO AUTOMATIC RESTORE`, explain why, and repeat that condition
in the confirmation. `--force` is too vague for this decision.

## CLI UX Best Practices

### Make the plan an approval artifact

Terraform's official workflow distinguishes speculative plans from plans saved with `-out`; a saved
plan can be inspected and later applied. Both [Terraform](https://developer.hashicorp.com/terraform/cli/commands/plan)
and [OpenTofu](https://opentofu.org/docs/cli/commands/plan/) document detailed exit behavior and saved
plan files. rfapps should follow the inspectable-artifact principle while preserving its own safer
confirmation default.

An update plan should include:

- schema version, plan ID, run ID, creation time, and requested/resolved scope;
- Compose path and content hash, profiles, platform, and sidecar policy;
- current image reference and immutable artifact identity;
- proposed image reference and immutable artifact identity;
- freshness outcome and any registry error;
- pre-update service generation and exact recovery artifact;
- verification method, timeout, and restoration eligibility;
- plan expiration or validation rules.

Show short digests in human output but preserve full values in the plan and JSON. Never require the
operator to infer a change from two nearly identical tag strings.

### Use verbs with one meaning

- `detect` means registry/local comparison only.
- `plan` or `preview` means no runtime mutation.
- `apply` means pull and recreate exactly the reviewed artifacts.
- `verify` means evaluate the configured target-service contract, not merely container existence.
- `restore` means restore the pre-update image using current Compose configuration; it does not
  promise volume, database, or application-data rollback.

Avoid calling a restoration “rollback” in the main lifecycle summary unless the scope is qualified.
The existing `rollback` command can remain, but update messages should say “restoring image from
generation #N; volumes and databases are unchanged.”

### Preserve established flags and streams

- Reuse `-s/--service`, `--services`, `-g/--group`, `--no-sidecars`, `-f/--compose`,
  `-e/--env-file`, and `-p/--profile` without changing their resolution rules.
- Reuse global `--yes`, `--dry-run`, `--verbose`, `--debug`, `--json`, and `--output` semantics.
- Keep human progress on stderr and emit exactly one final structured document on stdout.
- Disable color, cursor control, and spinners when stderr is not a TTY.
- Do not suppress prompts merely because JSON/YAML/CSV/table output was selected. Machine format and
  approval are independent concepts.
- In text mode, always print the saved plan/report path and one concrete next command.

Docker Compose provides a useful precedent for adapting output to context: its global
[`--progress`](https://docs.docker.com/reference/cli/docker/compose/) option supports `auto`, `tty`,
`plain`, `json`, and `quiet`. rfapps can retain its simpler final-document convention while ensuring
plain, monotonic progress in CI logs.

### Use explicit, stable outcomes

Recommended per-service outcomes are:

`up_to_date`, `update_available`, `blocked`, `detection_unknown`, `unsupported`, `updated`,
`restored`, `update_failed`, `restore_failed`, and `cancelled`.

The machine result should separate lifecycle outcome from final runtime condition:

```json
{
  "schemaVersion": "update.v1",
  "runId": "upd-20260717-8f2a",
  "planId": "6c9f...",
  "status": "completed_with_recovery",
  "success": false,
  "summary": {
    "selected": 7,
    "updated": 1,
    "restored": 1,
    "upToDate": 4,
    "unknown": 1,
    "restoreFailed": 0
  },
  "services": [
    {
      "service": "tautulli",
      "outcome": "restored",
      "finalHealth": "healthy",
      "recoveryGeneration": 4,
      "error": {
        "stage": "verify_update",
        "code": "health_timeout",
        "message": "Health verification timed out after 60s"
      }
    }
  ]
}
```

Use stable `code` and `stage` fields for scripts; human messages may evolve. Preserve the repo's
coarse exit convention: 0 for a completed successful/no-op lifecycle, 1 for operational or lifecycle
failure (including recovered failure), and 2 for invalid arguments or prohibited non-interactive
mutation.

## Error States and Recovery

| State                        | User-facing message                                                            | Automatic behavior                                                        | Next action / exit                                                             |
| ---------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| No updates                   | `All 7 selected services are up to date.`                                      | Save/report detection result; do not prompt or mutate                     | Exit 0                                                                         |
| Registry auth failure        | `radarr: update status unknown (registry authentication failed).`              | Exclude service; continue safe detections                                 | Show registry/login retry; exit 1 if the requested result is incomplete        |
| Registry timeout/rate limit  | `Update status unknown; last registry response timed out.`                     | Bounded retries with backoff, then exclude                                | Show retry command and evidence; exit 1 for incomplete run                     |
| Local build                  | `plex: unsupported for managed registry updates (service uses build).`         | Never pull or recreate as an image update                                 | Explain exclusion; no failure if explicitly unsupported                        |
| No recovery anchor           | `plex is blocked: no exact pre-update artifact is available.`                  | Stop before mutation or exclude service                                   | Suggest generation/history inspection; require `--allow-no-restore` to proceed |
| Stale Compose plan           | `Plan refused: compose.yml changed after review.`                              | No mutation                                                               | Regenerate plan; exit 1                                                        |
| Proposed tag moved           | `Plan refused: proposed digest changed after review.`                          | No mutation; never substitute new digest                                  | Regenerate and review; exit 1                                                  |
| Pull failure                 | `plex: proposed image could not be pulled; current container was not changed.` | Preserve current service; do not restore unnecessarily                    | Report pull error; exit 1                                                      |
| Start/recreate failure       | `plex failed to start with the proposed image; restoring generation #8.`       | Restore exact pre-update artifact, then verify                            | Outcome `restored` or `restore_failed`; exit 1                                 |
| Update verification timeout  | `plex did not become healthy within 60s; restoring generation #8.`             | Restore automatically and verify restored service                         | Exit 1 even if restore succeeds                                                |
| Verification unavailable     | `plex cannot be verified: no usable health signal.`                            | Follow explicit policy; default to restoration rather than success        | Report `update_failed`/`restored`; exit 1                                      |
| Restore pull/start failure   | `CRITICAL: plex could not be restored to generation #8.`                       | Stop dependent unsafe work; preserve evidence                             | Print exact artifact/generation and manual commands; exit 1                    |
| Restore verification failure | `CRITICAL: restored plex is not healthy.`                                      | Mark restore failed; do not create known-good generation                  | Manual recovery guidance; exit 1                                               |
| Ctrl+C before apply          | `Cancelled before mutation. Saved plan remains available.`                     | Exit cleanly                                                              | Exit 0; print resume command                                                   |
| Ctrl+C during mutation       | `Interrupt received; stopping new updates and stabilizing active services.`    | Stop scheduling; finish or restore the active recovery unit; write report | Exit 1 with `interrupted` status                                               |
| Non-TTY without approval     | `Managed updates require --yes in non-interactive mode.`                       | No mutation                                                               | Structured usage error; exit 2                                                 |

Errors should state: affected service, failed lifecycle stage, whether mutation occurred, what rfapps
did next, the final observed state, and one actionable recovery command. Avoid generic endings such
as “See output above.”

## Performance UX

Registry checks, pulls, health polling, and restoration all have uncertain durations. Progress
should communicate work completed and current wait conditions without inventing percentages.

- Use stage counts and service counts: `Detecting image updates (4/12)` and
  `Verifying plex (attempt 3/12, 15s/60s)`.
- Print a progress update only on a state change, a retry, or a reasonable heartbeat; repeated
  identical health lines create noise and make failures harder to find.
- Show elapsed time at service and run completion.
- In a TTY, one live row per active service is appropriate. In plain/non-TTY mode, emit append-only
  timestamped stage transitions.
- Respect dependency phases. Parallelism may improve pulls and independent recovery units, but the
  display must name the worker limit and must never imply that dependent services are safe to update
  concurrently.
- Default to a conservative concurrency setting. Expose the existing `--parallel`/`--workers`
  vocabulary if update execution supports it, and show `Execution: dependency-aware, 3 workers` in
  the preview.
- On health waits, show the exact signal being awaited (`container healthcheck`, `TCP dependency`,
  or `running fallback`) and the timeout policy.
- Keep Docker's raw pull output available with `--verbose` or `--debug`; default output should be a
  service-level summary rather than interleaved layer logs.

Docker Compose separates image retrieval from startup:
[`docker compose pull`](https://docs.docker.com/reference/cli/docker/compose/pull/) downloads service
images without starting containers, while [`docker compose up`](https://docs.docker.com/reference/cli/docker/compose/up/)
supports pull policy plus `--wait`/`--wait-timeout` for running-or-healthy state. rfapps should expose
those phases distinctly, then add the target-specific verification and recovery semantics Compose
does not provide.

## Competitive Analysis

| Workflow        | Strong UX pattern                                                                                                             | Limitation for this feature                                                                                                                                                                                                             | rfapps response                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Docker Compose  | Clear pull versus start operations; `up --wait`; TTY/plain/JSON/quiet progress; explicit `--yes`                              | No saved update approval artifact, generation history, or automatic restore-on-failure lifecycle                                                                                                                                        | Use Compose as the execution primitive, but add immutable artifact plans, verification evidence, and recovery reporting       |
| Terraform       | Read-only plan, optional saved plan, inspect with `show`, apply exact reviewed actions, detailed exit code mode               | Saved-plan apply treats passing the file as approval; infrastructure state semantics do not equal application health or image/data recovery                                                                                             | Adopt reviewable plans and staleness checks, but keep explicit approval by default and verify service health                  |
| OpenTofu        | Same plan/apply model plus concise progress and options for simultaneous human and machine output                             | Same saved-plan approval assumption; no container-specific restore contract                                                                                                                                                             | Adopt concise/progress separation and stable JSON concepts, while preserving rfapps streams and lifecycle outcomes            |
| Existing rfapps | Familiar scopes/flags, human stderr plus structured stdout, saved plan validation, readiness checks, generations and rollback | Registry digest availability is advisory, machine output currently bypasses confirmation, readiness is not sufficient target verification, generations store image references rather than clearly surfaced immutable recovery artifacts | Make digest changes actionable, decouple output mode from approval, verify updated targets, and report exact recovery anchors |

Terraform documents that automatic apply creates a plan and prompts, while passing a saved plan
applies without another prompt; OpenTofu follows the same convention
([Terraform apply](https://developer.hashicorp.com/terraform/cli/commands/apply),
[OpenTofu apply](https://opentofu.org/docs/cli/commands/apply/)). rfapps should deliberately differ:
the issue requires explicit approval by default, and a local JSON filename is not a strong enough
authorization boundary for a self-hosted production update.

Both tools also provide human and machine inspection of saved plans
([Terraform show](https://developer.hashicorp.com/terraform/cli/commands/show),
[OpenTofu show](https://opentofu.org/docs/cli/commands/show/)). rfapps update plans are already JSON,
so the CLI can render the same artifact in text or structured form without introducing a separate
opaque format. Plans may contain resolved configuration and operational metadata and should be
treated as sensitive artifacts, excluded from version control by default.

## Must / Should / Nice Recommendations

### Must

- Provide `rfapps update` as a coherent detect-to-report lifecycle with an explicit pre-mutation
  approval prompt.
- Make a confirmed same-tag digest change an actionable plan entry.
- Bind apply to the reviewed immutable proposed artifact; refuse substitution if a tag moves.
- Resolve and display a per-service recovery generation and exact recovery artifact before approval.
- Automatically restore and verify after start or verification failure when recovery is eligible.
- Never claim that image restoration rolls back volumes, databases, or application migrations.
- Account for every selected service in both the preview and final report.
- Separate update outcome from final health; `restored + healthy` remains a failed update.
- Emit a versioned `update.v1` JSON result with stable stage/outcome/error codes.
- Require `--yes` for non-interactive mutation; output format alone must not authorize apply.
- Exit non-zero for recovered update failures and restore failures.
- Write the run report on success, failure, recovery, cancellation during mutation, and interruption.

### Should

- Support `--plan-only --out <path>` and `--from-plan <path>` for review/apply separation.
- Reuse all existing scope, profile, secrets, output, dry-run, and parallelism conventions.
- Show short artifact digests, verification method, timeout, recovery eligibility, and generation
  transitions in human output.
- Use dependency-aware execution and stop scheduling affected dependents after a critical failure.
- Add bounded registry retries and clear `unknown` versus `up_to_date` states.
- Preserve the active service on pull failure and avoid unnecessary restoration.
- Use specific recovery guidance instead of recommending broad `--force` use.
- Provide cancellation semantics that stabilize an active recovery unit before exiting.
- Redact secrets and avoid raw registry credentials or tokens in plans and reports.

### Nice

- Add a separate JSON Lines event stream for long-running automation while retaining one final JSON
  result on stdout.
- Add named verification policies per service, such as container healthcheck, HTTP endpoint, or
  command probe.
- Add update ordering and maintenance-window policy after the manual lifecycle is proven.
- Add an opt-in “changes present” exit-code mode using a code that does not conflict with rfapps
  usage errors.
- Allow comparison of two run reports or generations for post-incident analysis.
- Estimate pull size or use cached-layer evidence when Docker exposes it reliably.

## Open Questions

1. Should bare `rfapps update` run the full interactive lifecycle, or should it default to plan-only
   and require `--apply`? The issue's explicit confirmation requirement supports the guided full
   lifecycle, but consistency with `plan` may favor read-only by default.
2. Should staged apply use `rfapps update --from-plan <file>`, a nested
   `rfapps update apply <file>`, or extend `rfapps apply` to recognize update plans? The chosen form
   must preserve restore-on-failure semantics, not fall back to today's generic apply behavior.
3. What is the exact target-service verification contract when a Compose healthcheck is absent?
   Is `running` an acceptable explicitly disclosed fallback, or should the service be unverifiable?
4. Can the generation store preserve and restore an immutable image ID/digest locally, including
   after the moving tag changes or the old image is pruned?
5. What is the recovery unit for services that must move with sidecars or database dependencies?
   Is generation numbering still per service, or does an update run need a group recovery manifest?
6. Should unknown detection for one service fail the whole run or permit confirmed independent
   updates? A practical default is partial planning with unknown services excluded, but the aggregate
   exit/result contract must remain explicit.
7. Which outcomes create generations? The safest rule is that only verified updated or verified
   restored states become successful generation snapshots; an attempted but unhealthy update must
   not become the next recovery baseline.
8. How should Ctrl+C behave after the container has been recreated but before verification
   completes? The recommended behavior is to stop new work, finish verification or restoration for
   the active recovery unit, and then exit interrupted.
9. Should `--allow-no-restore` exist in the first release, or should lack of an exact recovery anchor
   be an unconditional block until the generation model is strengthened?
10. What retention policy applies to update plans, reports, and exact pre-update images? Automatic
    pruning must not invalidate a plan that still claims restoration eligibility.
