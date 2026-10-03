# rfapps Reconcile Command

`rfapps reconcile` compares resolved Docker Compose intent with live Docker state. It reports a
deterministic action for every selected service and makes no changes by default. Add
`--auto-apply` when the declared Compose state should be applied in the same process.

## Report-First Behavior

A bare command is read-only:

```bash
rfapps reconcile
rfapps reconcile -s plex
rfapps reconcile -g media-stack --json
```

Report mode resolves a fixed service scope, observes all running and stopped project containers,
compares them with the resolved Compose configuration, and returns a `reconcile.v1` result. It does
not prompt, acquire the lifecycle lock, change containers, or persist an artifact.

`--dry-run` is an unconditional mutation veto. This remains true when it is combined with
`--auto-apply`:

```bash
rfapps reconcile -s plex --auto-apply --dry-run
```

## Options

```text
rfapps reconcile [options]
```

| Option                       | Description                                     |
| ---------------------------- | ----------------------------------------------- |
| `-s, --service <name>`       | Target one service                              |
| `--services <names>`         | Target comma-separated services                 |
| `-g, --group <name>`         | Target a configured service group               |
| `--no-sidecars`              | Disable configured sidecar expansion            |
| `--auto-apply`               | Apply the reviewed reconciliation actions       |
| `--show-unchanged`           | Include unchanged services in human/flat output |
| `--health-timeout <seconds>` | Set the positive readiness timeout per target   |
| `-f, --compose <path>`       | Use a specific Docker Compose file              |
| `-e, --env-file <path>`      | Use a specific environment file                 |
| `-p, --profile <name>`       | Use a configured Docker Compose profile         |

Global options include `--dry-run`, `--yes`, `--verbose`, `--json`,
`--output <json|yaml|csv|table|text>`, `--use-dotenvx <file>`, and `--use-op <file>`.

Service, group, sidecar, and profile selection is resolved before observation. The resulting
service and profile lists are unique and sorted, and every selected service appears exactly once
in the result. With no selector, reconciliation uses the resolved Compose service scope without an
interactive service-selection prompt.

## Applying a Report

`--auto-apply` is the only reconciliation option that authorizes container mutation:

```bash
# Review, then confirm in a human terminal
rfapps reconcile -s plex --auto-apply

# Explicit non-interactive authorization
rfapps reconcile --services sonarr,radarr --auto-apply --yes

# Machine output requires both mutation flags
rfapps reconcile -g media-stack --auto-apply --yes --json
```

`--yes` only skips the human confirmation. It does not imply `--auto-apply`, bypass policy, or
override stale evidence. JSON, YAML, and CSV auto-apply are machine-format operations and require
`--yes` whenever an actionable service exists. If there is no actionable work, auto-apply returns
without prompting or acquiring the lifecycle lock.

Before any action, auto-apply shows or builds the reviewed report, acquires the lifecycle lock
shared with managed image updates, and captures fresh authority and runtime evidence. A change to
the Compose file, resolved configuration, project, profiles, service scope, environment source,
Docker authority, container identities, policy decision, drift, or proposed action blocks the
reviewed work. There is no force bypass.

Eligible services are processed in dependency phases and in stable service order within each
phase. Each service is observed again immediately before its action. Drift that has disappeared is
reported as `became_in_sync` and is not replayed. After an action, bounded readiness and a fresh
zero-drift observation are both required for `converged`.

## Actions and Safety Boundary

| Observation                                           | Action     |
| ----------------------------------------------------- | ---------- |
| Service matches resolved Compose intent               | `none`     |
| Selected service has no project container             | `create`   |
| One matching container is stopped with runtime drift  | `start`    |
| One matching container has correctable declared drift | `recreate` |
| Evidence is missing, failed, ambiguous, or disallowed | `blocked`  |

Create and start run one reviewed service through Compose `up -d --pull never --no-deps`.
Recreate adds `--force-recreate`. Reconciliation does not remove orphans, pull images, build
images, renew volumes, start implicit dependencies, prune resources, or target an unreviewed
service. Unsupported scaled or otherwise ambiguous service instances are reported and blocked.

Compose configs and secrets backed by `file` or `environment` are intentionally unsupported by
auto-apply because Compose would reopen mutable authority outside the private resolved-model
snapshot. Reconciliation detects these references while building the report and emits stable
`RECONCILE_AUTHORITY_UNSNAPSHOTABLE` blocked evidence before confirmation, lifecycle locking, or
Docker mutation. Convert the resource to immutable image content or another fully resolved Compose
value before using auto-apply.

Compose is authoritative for reconciliation. Runtime changes that should become desired state are
a separate operation:

```bash
rfapps drift import -s plex --backup --yes
```

Registry freshness and same-tag remote digest updates belong to `rfapps update`, not reconciliation.

## reconcile.v1 Result

JSON and YAML emit the complete nested result. Table and CSV emit a service-summary projection.
The top-level contract is:

```json
{
  "schemaVersion": "reconcile.v1",
  "operation": "reconcile",
  "mode": "report",
  "dryRun": false,
  "status": "reported",
  "scope": {
    "composePath": "/srv/rfmedia-apps/compose.yml",
    "project": "rfmedia-apps",
    "profiles": ["media"],
    "services": ["plex"]
  },
  "actionFingerprint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "automation": { "status": "not_requested" },
  "services": [
    {
      "service": "plex",
      "comparison": "drifted",
      "drift": {
        "hasDrift": true,
        "direction": "compose_ahead",
        "categories": ["runtime-status"],
        "image": { "changed": false },
        "environment": [],
        "ports": { "changed": false },
        "volumes": { "changed": false },
        "networks": { "changed": false },
        "runtimeStatus": {
          "changed": true,
          "currentState": "exited",
          "currentHealth": "none",
          "desiredState": "running",
          "desiredHealth": "none"
        }
      },
      "action": {
        "kind": "start",
        "categories": ["runtime-status"],
        "eligibility": "not_requested",
        "reasons": [
          {
            "code": "RECONCILE_CONTAINER_STOPPED",
            "category": "runtime-status"
          }
        ]
      },
      "outcome": "reported"
    }
  ],
  "summary": {
    "selected": 1,
    "inSync": 0,
    "drifted": 1,
    "actionable": 1,
    "blocked": 0,
    "converged": 0,
    "failed": 0
  },
  "success": true,
  "exitCode": 0
}
```

Each service has one comparison (`in_sync`, `drifted`, or `observation_failed`), one action
(`none`, `create`, `start`, `recreate`, or `blocked`), stable reason codes, and one terminal outcome.
Possible outcomes are `reported`, `no_action`, `became_in_sync`, `converged`, `blocked_policy`,
`blocked_stale`, `observation_failed`, `action_failed`, `not_converged`,
`cancelled_before_action`, `cancelled_during_action`, and `skipped_after_unsafe_failure`.

Top-level status summarizes those complete per-service results:

| Status      | Meaning                                                       |
| ----------- | ------------------------------------------------------------- |
| `reported`  | Read-only observation completed                               |
| `planned`   | Dry-run auto-apply found actions but did not execute them     |
| `converged` | Auto-apply completed or found no action to perform            |
| `partial`   | Some work completed, but another result was blocked or failed |
| `failed`    | Observation or execution failed without a completed result    |
| `cancelled` | Confirmation or a signal cancelled authorized work            |

`automation.status` is `not_requested`, `allowed`, or `blocked`. Report mode and dry-run use
`not_requested`; version 1 permits explicitly authorized auto-apply through its policy seam.

Services and profiles use code-point lexical order. Drift categories use `image`, `environment`,
`ports`, `volumes`, `networks`, then `runtime-status`. Public environment drift contains the
variable name and change kind only; desired/current values, Docker endpoints, raw inspect data,
and environment-source paths are not emitted.

The SHA-256 `actionFingerprint` binds the reviewed schema, mode, dry-run state, canonical scope,
non-secret authority fingerprints, resolved service fingerprints, exact container identities,
normalized drift, policy decision, and actions. It excludes timestamps, durations, display text,
and secret values, so equivalent normalized evidence produces the same semantic result and
fingerprint.

## Exit Codes

| Code | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| `0`  | Trustworthy report completed, or every requested service converged |
| `1`  | Observation or reconciliation operation failed                     |
| `2`  | Invalid or unsafe usage, or reconciliation was cancelled           |
| `3`  | Result was partial, blocked, or retained residual drift            |

Reported drift is not an error: a complete report normally exits `0`. Observation failures exit
`1`. Auto-apply exits `0` only after the requested scope is converged or needs no action.

## Legacy Drift Route

`rfapps drift reconcile` remains a compatibility spelling. It delegates to the same coordinator
with auto-apply intent, so it has the same confirmation, lock, stale-review, targeted-action,
verification, and exit behavior:

```bash
rfapps drift reconcile -s plex --yes
```

New scripts should use `rfapps reconcile --auto-apply`. Drift detection and runtime import remain
separate commands; see [rfapps Drift Command](rfapps-drift-command.md).

## Deliberate Non-Goals

Reconciliation does not create or consume a saved reconcile plan, deployment history record,
generation, automatic rollback, registry pull, background daemon, or maintenance schedule. A later
run observes current state instead of replaying an action log. Version 1 has an allow-all policy
seam for explicitly authorized actions; issue #169 will add maintenance-window configuration and
scheduling policy without changing report mode.

For persisted deployment plans, use the [Plan/Apply Workflow](plan-apply-workflow.md). For managed
registry image changes, use `rfapps update`.
