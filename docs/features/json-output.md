# JSON Output Mode

> **Note**: The rfapps and rfmedia CLIs now support multiple output formats (JSON, YAML, CSV, table, text) via the `--output <format>` global option. See [Output Formats](output-formats.md) for comprehensive documentation covering all formats. This page documents the original `--json` flag which remains fully supported as a shorthand for `--output json`.

This document describes the JSON output mode in the rfapps CLI, which provides machine-readable output for scripting, automation, and integration with other tools.

## Overview

The rfapps CLI supports JSON output mode via the `--json` flag. When enabled, all command output is formatted as structured JSON instead of human-readable text, making it easy to parse and process programmatically.

## Enabling JSON Output

Add the `--json` flag to any rfapps command:

```bash
rfapps status --json
rfapps deploy -s traefik --dry-run --json
rfapps prune -g media-stack --json
```

## Output Structure

Each command returns a structured JSON object with command-specific data.

### Status Command

The status command returns service information:

```bash
rfapps status --json
```

The following example is abridged; real results also include reviewed/observed image identities,
verification evidence, restore evidence, generation transitions, and durations for each service.

```json
{
  "timestamp": "2026-01-18T10:30:00.000Z",
  "services": [
    {
      "name": "traefik",
      "containerId": "abc123",
      "state": "running",
      "health": "healthy",
      "status": "Up 5 days",
      "ports": ["80:80", "443:443"],
      "image": "traefik",
      "tag": "v3.0"
    },
    {
      "name": "plex",
      "containerId": "def456",
      "state": "running",
      "health": "healthy",
      "status": "Up 3 days",
      "ports": ["32400:32400"],
      "image": "plexinc/pms-docker",
      "tag": "latest"
    }
  ],
  "total": 35,
  "running": 33,
  "healthy": 32
}
```

### Deploy Command

```bash
rfapps deploy -s plex --json --yes
```

```json
{
  "services": ["plex", ""],
  "failed": [],
  "healthy": ["plex", ""],
  "unhealthy": [],
  "started": 2
}
```

With `--staged`, the result carries an additional `staged` summary object:

```bash
rfapps deploy --services homarr,ofelia,stirling-pdf,uptime-kuma,docktail,traefik \
  --staged --batch-size 2 --json --yes
```

A rollout that halts at batch 2 of 3:

```json
{
  "services": ["homarr", "ofelia", "stirling-pdf", "uptime-kuma", "docktail", "traefik"],
  "failed": [
    {
      "name": "uptime-kuma",
      "code": "STAGE_GATE_FAILED",
      "error": "Batch 2 failed (gate-timeout): not-running"
    },
    {
      "name": "docktail",
      "code": "STAGE_NOT_ATTEMPTED",
      "error": "Not attempted: staged rollout halted after batch 2 of 3"
    },
    {
      "name": "traefik",
      "code": "STAGE_NOT_ATTEMPTED",
      "error": "Not attempted: staged rollout halted after batch 2 of 3"
    }
  ],
  "healthy": ["homarr", "ofelia", "stirling-pdf"],
  "unhealthy": ["uptime-kuma"],
  "started": 4,
  "staged": {
    "status": "halted",
    "batchSize": 2,
    "onFailure": "halt",
    "totalBatches": 3,
    "completedBatches": 1,
    "haltedAtBatch": 2
  }
}
```

| Field              | Type                                        | Notes                                                         |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------- |
| `status`           | `"completed"` \| `"halted"` \| `"degraded"` | `degraded` means a batch failed under `--on-failure continue` |
| `batchSize`        | number                                      | Resolved `--batch-size` (default `1`)                         |
| `onFailure`        | `"halt"` \| `"continue"`                    | Resolved `--on-failure` (default `halt`)                      |
| `totalBatches`     | number                                      | Batches in the plan, including skipped ones                   |
| `completedBatches` | number                                      | Batches that passed their gate                                |
| `haltedAtBatch`    | number (optional)                           | 1-based batch index; absent unless the rollout halted         |

The `staged` property is absent when `--staged` is not used, preserving the existing deploy output
contract. There is no per-batch `cause` field; the cause is embedded in each `failed[].error`
string. Services in batches that never ran appear in `failed[]` with code `STAGE_NOT_ATTEMPTED`, so
a halted rollout never reports success. See
[Dry-Run Mode](dry-run-mode.md#combining-dry-run-with-staged-rollouts) for the different `staged`
shape emitted by `--staged --dry-run`.

With `--scan`, the deploy result carries an additional optional `scan` field holding a
`security-scan.v1` report, and when the gate blocks it also carries a `failed[]` entry named `scan`
with code `VULNERABILITY_THRESHOLD` or `SCAN_INCONCLUSIVE`:

```json
{
  "services": ["plex"],
  "failed": [
    {
      "name": "scan",
      "code": "VULNERABILITY_THRESHOLD",
      "error": "Image vulnerability scan found findings at or above the configured severity"
    }
  ],
  "healthy": [],
  "unhealthy": [],
  "started": 0,
  "scan": { "schemaVersion": "security-scan.v1", "gate": { "status": "blocked", "blocking": true } }
}
```

The `scan` key is never created unless `--scan` was passed, and it is stripped for `--output table`
and `--output csv`.

`scan` is not part of the MCP `rfapps.deploy` output schema. `rfapps.deploy` does not accept `scan`,
`scanner`, or `scanFailOn`, so an MCP result never carries the field.

See [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md).

### Build Command

```bash
rfapps build -g media-stack --json --yes
```

```json
{
  "services": ["plex", "sonarr", "radarr"],
  "failed": [],
  "built": 4
}
```

### Pull Command

```bash
rfapps pull -s plex --json --yes
```

```json
{
  "services": ["plex"],
  "skipped": [],
  "failed": [],
  "pulled": 2
}
```

### Stop Command

```bash
rfapps stop -s uptime-kuma --json --yes
```

```json
{
  "services": ["uptime-kuma"],
  "failed": [],
  "stopped": 2
}
```

### Delete Command

```bash
rfapps delete -s traefik --volumes --json --yes
```

```json
{
  "services": ["plex", ""],
  "failed": [],
  "deleted": 3,
  "volumesRemoved": 2,
  "imagesRemoved": 0
}
```

### Prune Command

```bash
rfapps prune -g auth-stack --images --json --yes
```

```json
{
  "services": ["authentik-server", "authentik-worker", "authentik-db", "authentik-redis"],
  "failed": [],
  "containers": 4,
  "images": 4,
  "imagesSkipped": 1,
  "volumes": 0,
  "spaceReclaimed": 1073741824,
  "completedPhases": ["stop", "remove", "images"]
}
```

### Rebuild Command

```bash
rfapps rebuild -s plex --json --yes
```

```json
{
  "services": ["plex"],
  "failed": [],
  "healthy": ["plex"],
  "unhealthy": [],
  "completedPhases": ["stop", "pull", "build", "start"],
  "rebuilt": 2
}
```

### Plan Command

`rfapps plan --output json` emits `{ planPath, plan }`. With `--scan` the envelope gains a third
top-level key, `scan`, carrying a `security-scan.v1` report:

```bash
rfapps plan -g media-stack --scan --scan-fail-on high --output json
```

```json
{
  "planPath": "/home/op/.rfapps/plans/plan-1753900000.json",
  "plan": { "id": "plan-1753900000", "services": [], "summary": {} },
  "scan": {
    "schemaVersion": "security-scan.v1",
    "timestamp": "2026-07-30T18:00:00.000Z",
    "scanner": { "id": "trivy", "binary": "trivy", "version": "0.58.1", "available": true },
    "scope": { "services": ["plex"], "profiles": ["media"], "composePath": "compose.yml" },
    "gate": {
      "failOn": "high",
      "status": "blocked",
      "blocking": true,
      "blockedBy": ["plex: CVE-2024-45490 (critical) in expat@2.5.0"]
    },
    "summary": {
      "critical": 2,
      "high": 6,
      "medium": 18,
      "low": 13,
      "negligible": 2,
      "unknown": 0,
      "total": 41,
      "suppressed": 3,
      "targetsScanned": 1,
      "targetsSkipped": 0,
      "targetsFailed": 0
    },
    "images": [],
    "notes": []
  }
}
```

The report lives on the output envelope and is never written into the saved plan file, so
`rfapps apply <path>` days later cannot re-assert a stale verdict. `table` and `csv` strip it, and
`plan --dry-run --scan` produces no plan and therefore no scan.

See [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md).

### Doctor Command

`rfapps doctor` returns a stable, versioned diagnostic schema:

```bash
rfapps doctor --json
```

```json
{
  "schemaVersion": "doctor.v1",
  "timestamp": "2026-06-10T02:00:00.000Z",
  "scope": {
    "services": ["plex"],
    "profiles": ["media"],
    "composePath": "compose.yml",
    "checkUpdates": false
  },
  "summary": {
    "critical": 0,
    "error": 1,
    "warn": 0,
    "info": 0,
    "total": 1
  },
  "checks": [
    {
      "id": "runtime-status",
      "category": "runtime",
      "status": "run"
    }
  ],
  "findings": [
    {
      "id": "runtime.unhealthy",
      "severity": "error",
      "category": "runtime",
      "service": "plex",
      "message": "Container is unhealthy",
      "evidence": ["state=running", "health=unhealthy"],
      "suggestedCommand": "rfapps health -s plex --no-wait-for-ready"
    }
  ]
}
```

Useful doctor queries:

```bash
rfapps doctor --json | jq '.summary'
rfapps doctor --json | jq -r '.findings[] | "\(.severity) \(.category) \(.service // "-"): \(.message)"'
rfapps doctor --check-updates --json | jq '.findings[] | select(.category == "updates")'
```

### Drift Command

`rfapps drift detect` returns a stable, versioned drift schema. Human text stays
on stderr; JSON is emitted to stdout.

```bash
rfapps drift detect --json
```

```json
{
  "schemaVersion": "1.0.0",
  "timestamp": "2026-06-10T03:30:00.000Z",
  "composePath": "compose.yml",
  "services": [
    {
      "service": "plex",
      "hasDrift": true,
      "direction": "compose_ahead",
      "categories": ["runtime-status"],
      "image": { "changed": false },
      "environment": [],
      "ports": { "changed": false },
      "volumes": { "changed": false },
      "networks": { "changed": false },
      "runtimeStatus": {
        "current": { "state": "exited", "health": "none" },
        "desired": { "state": "running", "health": "none" },
        "changed": true
      }
    }
  ],
  "summary": {
    "total": 1,
    "drifted": 1,
    "unchanged": 0,
    "directions": {
      "composeAhead": 1,
      "containerAhead": 0,
      "diverged": 0
    }
  }
}
```

Useful drift queries:

```bash
rfapps drift detect --report-only --json | jq '.summary'
rfapps drift detect --report-only --json | jq '.services[] | select(.hasDrift)'
rfapps drift detect --report-only --json | jq '.services[] | select(.categories[]? == "runtime-status")'
```

### Reconcile Command

`rfapps reconcile --json` writes exactly one complete `reconcile.v1` document to stdout. Human
progress, confirmation text, and diagnostics use stderr, so redirecting stdout never captures a
partial report or a stream of per-service events. JSON and YAML expose the normative nested result;
CSV and table output use a service-summary projection instead.

```bash
# Read-only report. Reported drift still exits 0 when observation succeeds.
rfapps reconcile -g media-stack --json > reconcile-report.json

# Machine-mode mutation requires both flags.
rfapps reconcile -g media-stack --auto-apply --yes --json > reconcile-result.json
```

The result always contains these top-level fields:

| Field               | Semantics                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`     | Always `reconcile.v1`                                                                                         |
| `operation`         | Always `reconcile`                                                                                            |
| `mode` / `dryRun`   | Requested `report` or `auto-apply` mode and the independent dry-run mutation veto                             |
| `status`            | Aggregate `reported`, `planned`, `converged`, `partial`, `failed`, or `cancelled` state                       |
| `scope`             | Canonical Compose path and project plus sorted profiles and the complete sorted service scope                 |
| `actionFingerprint` | SHA-256 binding of the reviewed non-secret authority, evidence, policy, and actions                           |
| `automation`        | Policy decision: `not_requested`, `allowed`, or `blocked`, with an optional reason and next eligibility time  |
| `services`          | Exactly one comparison, action, and terminal outcome for every selected service                               |
| `summary`           | Counts for selected, in-sync, drifted, actionable, blocked, converged, and failed services                    |
| `success`           | Whether the requested report or convergence operation met its success contract                                |
| `exitCode`          | Stable process result: `0` success, `1` failure, `2` invalid/cancelled, or `3` partial/blocked/residual drift |

Within `services`, `comparison` is `in_sync`, `drifted`, or `observation_failed`; `action.kind` is
`none`, `create`, `start`, `recreate`, or `blocked`. Terminal outcomes are `reported`, `no_action`,
`became_in_sync`, `converged`, `blocked_policy`, `blocked_stale`, `observation_failed`,
`action_failed`, `not_converged`, `cancelled_before_action`, `cancelled_during_action`, or
`skipped_after_unsafe_failure`. `finalDrift` is present when a later observation supplies final
evidence. A trustworthy report may contain drift and still has `success: true` and `exitCode: 0`;
auto-apply succeeds only when the requested scope converges or needs no action.

Semantic ordering is deterministic:

- `scope.services`, `scope.profiles`, and `services` use code-point lexical order.
- Drift categories use `image`, `environment`, `ports`, `volumes`, `networks`, then
  `runtime-status`.
- Environment differences contain only variable name and change kind and are sorted by name.
- Ports, volumes, and networks are normalized before the action fingerprint is calculated.
- Timestamps, durations, display messages, secret values, raw Docker evidence, and authority
  components are excluded from the result and fingerprint.

Useful reconciliation queries:

```bash
jq '.status, .summary, .exitCode' reconcile-result.json
jq '.services[] | select(.action.kind != "none")' reconcile-report.json
jq '.services[] | select(.outcome != "converged" and .outcome != "no_action")' reconcile-result.json
```

For the complete schema, action safety boundary, and exit behavior, see
[rfapps Reconcile Command](rfapps-reconcile-command.md#reconcilev1-result).

### Audit Command

`rfapps audit` returns a stable, versioned security posture schema:

```bash
rfapps audit --json
```

```json
{
  "schemaVersion": "audit.v1",
  "timestamp": "2026-06-10T03:00:00.000Z",
  "scope": {
    "services": ["traefik"],
    "profiles": ["core"],
    "composePath": "compose.yml"
  },
  "summary": {
    "critical": 1,
    "error": 0,
    "warn": 1,
    "info": 2,
    "total": 4
  },
  "findings": [
    {
      "ruleId": "docker-socket-mounted",
      "category": "host-access",
      "severity": "critical",
      "service": "traefik",
      "message": "Docker socket mounted",
      "evidence": ["volume source or target=/var/run/docker.sock"],
      "remediation": "Avoid mounting `/var/run/docker.sock`; use a scoped proxy or limited integration."
    }
  ]
}
```

Useful audit queries:

```bash
rfapps audit --json | jq '.summary'
rfapps audit --json | jq -r '.findings[] | "\(.severity) \(.service): \(.ruleId)"'
rfapps audit --json | jq '.findings[] | select(.severity == "critical")'
```

### Harden Command

`rfapps harden --json` (or the global `--output json` / `--output yaml`) emits exactly one
`harden.v1` document on stdout; human text and diagnostics stay on stderr.

The document carries `schemaVersion`, `timestamp`, `mode` (`propose`, `override`, or `apply`),
`includeReview`, `scope`, `summary`, `proposals`, `refusals`, `reformat`, `override`, and `write`:

```bash
rfapps harden -g media-stack --json
```

```json
{
  "schemaVersion": "harden.v1",
  "timestamp": "2026-07-30T18:00:00.000Z",
  "mode": "propose",
  "includeReview": false,
  "scope": {
    "services": ["plex", "sonarr"],
    "profiles": ["media"],
    "composePath": "compose.yml"
  },
  "summary": {
    "total": 14,
    "safe": 6,
    "review": 5,
    "advisory": 3,
    "suppressed": 2,
    "servicesAffected": 3,
    "applied": 0,
    "refused": 4
  },
  "proposals": [
    {
      "ruleId": "harden-no-new-privileges",
      "service": "sonarr",
      "category": "capabilities",
      "severity": "info",
      "confidence": "safe",
      "title": "no-new-privileges not set",
      "rationale": "A setuid binary inside the container can still escalate privileges.",
      "guidance": "Add `security_opt: [\"no-new-privileges:true\"]` unless the service requires privilege escalation.",
      "detects": { "lint": "no-new-privileges-missing" },
      "evidence": ["security_opt does not include no-new-privileges:true"],
      "patches": [
        {
          "key": "security_opt",
          "operation": "merge-unique",
          "value": ["no-new-privileges:true"],
          "description": "security_opt += [\"no-new-privileges:true\"]"
        }
      ]
    },
    {
      "ruleId": "harden-healthcheck",
      "service": "plex",
      "category": "health",
      "severity": "warn",
      "confidence": "advisory",
      "title": "Health check missing",
      "rationale": "Without a health check, orchestrators cannot detect or replace an unhealthy container.",
      "guidance": "Add a `healthcheck` block with a service-specific `test`, `interval`, `timeout`, `retries`, and `start_period`.",
      "detects": { "lint": "healthcheck-missing" },
      "evidence": ["healthcheck absent"],
      "patches": []
    }
  ],
  "refusals": [
    {
      "code": "alias-target",
      "service": "sonarr",
      "ruleId": "harden-log-rotation",
      "detail": "services.sonarr.logging is a YAML alias (*logging-default); editing it would change every service that shares the anchor",
      "alternative": "use: rfapps harden --rule harden-log-rotation --out compose.harden.yaml"
    }
  ],
  "reformat": { "wouldReformat": true, "lineDelta": -6 },
  "override": "# Generated by rfapps harden at 2026-07-30T18:00:00.000Z\nservices:\n  sonarr:\n    security_opt:\n      - no-new-privileges:true\n",
  "write": { "mode": "propose" }
}
```

`write` has three shapes. Propose mode reports `{ "mode": "propose" }`; `--out` reports
`{ "mode": "override", "path": "…/compose.harden.yaml", "patchesWritten": 6 }`; and `--apply`
reports
`{ "mode": "apply", "path": "…/compose.yml", "backupPath": "…/compose.yml.bak", "patchesWritten": 6, "servicesPatched": ["radarr", "sonarr"] }`.

Output is deterministic: proposals sort by confidence, then service, then catalog order; patches keep
declaration order; refusals sort by service, then rule id.

`table` and `csv` flatten the top level and are not a substitute — `proposals`, `refusals`, and
`override` are JSON and YAML detail. `harden` is not exposed through the MCP server.

See [rfapps Harden Command](rfapps-harden-command.md).

### Native Backup Commands

Backup creation emits exactly one `rfapps-backup-result.v1` document in JSON mode. Machine creation
requires an explicit service/group target or `--all` and explicit `--yes`, including dry-run:

```bash
rfapps backup -s plex --destination /mnt/backups --dry-run --yes --json \
  > backup-plan.json 2> backup-progress.log
```

The following example shows the primary fields of a successful dry-run result:

```json
{
  "schemaVersion": "rfapps-backup-result.v1",
  "operation": "backup",
  "status": "planned",
  "success": true,
  "exitCode": 0,
  "dryRun": true,
  "requestedServices": ["plex"],
  "resolvedServices": ["plex"],
  "writerServices": ["plex"],
  "previouslyRunningContainerIds": [],
  "destinationPath": "/mnt/backups",
  "planned": [
    {
      "id": "mount-0001",
      "artifactPath": "artifacts/mount-0001.tar.gz",
      "source": { "kind": "bind", "path": "/srv/plex" },
      "writerServices": ["plex"]
    }
  ],
  "skipped": [],
  "artifacts": [
    {
      "id": "mount-0001",
      "artifactPath": "artifacts/mount-0001.tar.gz",
      "status": "planned"
    }
  ],
  "errors": [],
  "recoveryFailures": [],
  "stagingDisposition": "none",
  "summary": {
    "plannedArtifacts": 1,
    "archivedArtifacts": 0,
    "failedArtifacts": 0,
    "recoveryFailures": 0
  }
}
```

A successful real creation has `status: "succeeded"`, `dryRun: false`,
`stagingDisposition: "published"`, and includes `bundlePath`, `manifestPath`, compressed byte counts,
and SHA-256 values. Failures preserve `primaryFailure`, all `errors`, exact-container
`recoveryFailures`, and whether a manifest-less bundle was removed or retained.

Offline verification emits exactly one `rfapps-backup-verify-result.v1` document:

```bash
rfapps backup verify /mnt/backups/<bundle>/manifest.json --json > verify-result.json
```

```json
{
  "schemaVersion": "rfapps-backup-verify-result.v1",
  "operation": "backup-verify",
  "status": "succeeded",
  "success": true,
  "exitCode": 0,
  "dryRun": false,
  "manifestPath": "/mnt/backups/<bundle>/manifest.json",
  "bundlePath": "/mnt/backups/<bundle>",
  "artifacts": [
    {
      "id": "mount-0001",
      "artifactPath": "artifacts/mount-0001.tar.gz",
      "status": "verified"
    }
  ],
  "errors": [],
  "summary": {
    "declaredArtifacts": 1,
    "verifiedArtifacts": 1,
    "unexpectedArtifacts": 0,
    "missingArtifacts": 0,
    "unsafeArtifacts": 0,
    "sizeMismatches": 0,
    "checksumMismatches": 0
  }
}
```

Verification loads no rfapps configuration and invokes no Docker command. Exit `1` reports
operational or artifact-integrity failures; exit `2` reports invalid usage or an unsafe,
unsupported manifest. CSV is rejected before creation or verification because these nested
contracts cannot be represented without loss.

Useful queries:

```bash
jq '.status, .summary, .stagingDisposition' backup-result.json
jq '.artifacts[] | select(.status != "archived")' backup-result.json
jq '.summary, .artifacts[] | select(.status != "verified")' verify-result.json
```

See [rfapps Native Backup](rfapps-backup.md) for the complete manifest, lifecycle, and output
contracts.

### Managed Update Command

`rfapps update` emits one versioned `update.v1` result document for JSON and YAML output. Human
progress, warnings, and lifecycle stage messages are written to stderr, so stdout remains safe to
pipe to `jq`, `yq`, or a file.

Machine-mode mutation requires explicit approval with both `--apply` and `--yes`:

```bash
rfapps update -s plex --apply --yes --output json > update-result.json
```

```json
{
  "schemaVersion": "update.v1",
  "runId": "run-20260717-example",
  "planId": "plan-20260717-example",
  "startedAt": "2026-07-17T10:00:00.000Z",
  "completedAt": "2026-07-17T10:00:18.000Z",
  "status": "succeeded",
  "success": true,
  "exitCode": 0,
  "applied": true,
  "restoreOnFailure": true,
  "summary": {
    "selected": 1,
    "actionable": 1,
    "updated": 1,
    "restored": 0,
    "upToDate": 0,
    "unsupported": 0,
    "unknown": 0,
    "blocked": 0,
    "failed": 0,
    "interrupted": 0
  },
  "services": [
    {
      "service": "plex",
      "outcome": "updated",
      "stage": "complete"
    }
  ]
}
```

Important fields for automation are:

- `status`: aggregate state (`no_updates`, `succeeded`, `recovered_failure`, `partial`, `failed`, or
  `interrupted`).
- `exitCode`: the command's stable `0`, `1`, or `2` process result.
- `services[].outcome`: per-service accounting, including `detection_unknown`, `blocked`, `restored`,
  `update_failed`, and `restore_failed`.
- `services[].stage`: the terminal lifecycle stage, such as `validate`, `verify_update`, `restore`,
  or `verify_restore`.
- `services[].error.code`: a stable sanitized error code when a service did not complete normally.
- `services[].verification` and `services[].restore`: target health and exact-image recovery evidence.

A verified automatic restore is intentionally a failed update result. It reports
`status: "recovered_failure"`, `success: false`, `exitCode: 1`, and a per-service `restored` outcome,
even when the restored container is healthy. A scope with no available updates reports
`status: "no_updates"`, `success: true`, and exits `0`.

Preview mode is also machine-readable and non-mutating:

```bash
rfapps update -g media-stack --output json > update-preview.json
```

The command still writes exactly one `update.v1` document to stdout. If `--out` is supplied, preview
writes the reviewed `update-plan.v1` artifact there; apply writes the final `update.v1` report there.
The artifact file is separate from redirected stdout.

Useful managed-update queries:

```bash
jq '.status, .summary' update-result.json
jq '.services[] | select(.outcome != "updated" and .outcome != "up_to_date")' update-result.json
jq '.services[] | select(.restore.status == "succeeded")' update-result.json
```

### tag Command

The three `rfapps tag` subcommands each emit exactly one `tags.v1` document on stdout; prose,
warnings, and the winning configuration layer stay on stderr. Every subcommand carries a local
`--json`, which is checked before the global `--output`, so `rfapps tag list --json` works even
though `--output` always has a value.

`rfapps tag list --json` returns one entry per **effective** tag — declared paths and their derived
ancestors alike, with `declared` distinguishing the two:

```bash
rfapps tag list --json
```

```json
{
  "schemaVersion": "tags.v1",
  "tags": [
    {
      "tag": "infrastructure",
      "depth": 1,
      "declared": false,
      "services": ["authentik-server", "traefik"],
      "serviceCount": 2
    },
    {
      "tag": "infrastructure/core/networking",
      "depth": 3,
      "declared": true,
      "services": ["traefik"],
      "serviceCount": 1
    }
  ],
  "totalTags": 14,
  "totalServices": 8,
  "untaggedServices": ["autobrr", "bazarr"],
  "unresolvedServices": [],
  "source": "/home/yandy/Projects/github.com/yandy-r/rfmedia-apps/rfapps.config.yaml"
}
```

`unresolvedServices` names `tags.mapping` keys that are absent from `compose.yml`, and `source` is
the absolute path of the configuration layer whose `tags:` block won. An empty taxonomy is a
success: the document is emitted with empty arrays and the command exits `0`.

`rfapps tag show --json` reports the declared and effective sets per requested service:

```bash
rfapps tag show -s plex --json
```

```json
{
  "schemaVersion": "tags.v1",
  "services": [
    {
      "service": "plex",
      "declaredTags": ["hardware/gpu", "media/streaming"],
      "effectiveTags": ["hardware", "hardware/gpu", "media", "media/streaming"]
    }
  ]
}
```

`rfapps tag suggest --json` returns the proposals plus the same YAML fragment the text mode prints:

```bash
rfapps tag suggest --json
```

```json
{
  "schemaVersion": "tags.v1",
  "proposals": [
    {
      "service": "traefik",
      "tags": ["network/ingress", "platform/core"],
      "rules": ["tag-infer-ingress", "tag-infer-profile"],
      "confidence": "high",
      "alreadyPresent": false
    }
  ],
  "unresolved": ["arr-scripts"],
  "skippedRules": [],
  "degraded": false,
  "fragment": "tags:\n  mapping:\n    traefik:\n      - network/ingress\n      - platform/core\n",
  "writtenTo": "/abs/path/tags-fragment.yaml"
}
```

`degraded` is `true` when the Docker CLI was unavailable and the label- and image-based rules were
skipped; `skippedRules` names them. `writtenTo` appears only when `--out` was supplied. Zero
proposals is a success, not an error.

Useful tag queries:

```bash
jq -r '.tags[] | select(.declared) | .tag' tags.json          # authored tags only
jq -r '.untaggedServices[]' tags.json                          # what still needs tagging
jq -r '.fragment' suggest.json > tags-fragment.yaml            # the paste block
jq -r '.proposals[] | select(.confidence == "high") | .service' suggest.json
```

`rfapps tag list` and `rfapps tag show` reject `--output csv` with a usage error (exit `2`): both
results are hierarchical and flattening them would be lossy. Use `json`, `yaml`, or `table`.

## Failed Operations

When operations fail, details are included in the `failed` array:

```json
{
  "services": ["sonarr", "radarr"],
  "failed": [
    {
      "name": "bazarr",
      "error": "Container startup timeout exceeded",
      "code": "HEALTH_TIMEOUT"
    }
  ],
  "healthy": ["sonarr", "radarr"],
  "unhealthy": ["bazarr"],
  "started": 2
}
```

Staged deploys add three `code` values to this array:

| Code                       | Meaning                                                              |
| -------------------------- | -------------------------------------------------------------------- |
| `STAGE_DEPENDENCY_SKIPPED` | A dependency failed in an earlier batch, so this service was skipped |
| `STAGE_GATE_FAILED`        | Started but not ready at the batch gate; `error` names the cause     |
| `STAGE_NOT_ATTEMPTED`      | In a batch that never ran because the rollout halted                 |

## Parsing JSON Output

### Using jq

[jq](https://stedolan.github.io/jq/) is the recommended tool for parsing JSON output:

```bash
# Get list of running services
rfapps status --json | jq -r '.services[] | select(.state == "running") | .name'

# Count unhealthy services
rfapps status --json | jq '.services | map(select(.health == "unhealthy")) | length'

# Get services with specific health status
rfapps status --json | jq '.services[] | select(.health == "starting")'

# Extract container IDs
rfapps status --json | jq -r '.services[].containerId'

# Get total running count
rfapps status --json | jq '.running'
```

### Using Node.js

```javascript
const { execSync } = require("child_process");

const output = execSync("rfapps status --json", { encoding: "utf8" });
const status = JSON.parse(output);

console.log(`Total services: ${status.total}`);
console.log(`Running: ${status.running}`);
console.log(`Healthy: ${status.healthy}`);

// Filter unhealthy services
const unhealthy = status.services.filter((s) => s.health === "unhealthy");
unhealthy.forEach((s) => console.log(`Unhealthy: ${s.name}`));
```

### Using Python

```python
import subprocess
import json

result = subprocess.run(['rfapps', 'status', '--json'], capture_output=True, text=True)
status = json.loads(result.stdout)

print(f"Total services: {status['total']}")
print(f"Running: {status['running']}")
print(f"Healthy: {status['healthy']}")

# List stopped services
stopped = [s['name'] for s in status['services'] if s['state'] != 'running']
print(f"Stopped services: {', '.join(stopped)}")
```

### Using Bash

```bash
#!/bin/bash

# Get JSON output
output=$(rfapps status --json)

# Parse with jq
total=$(echo "$output" | jq '.total')
running=$(echo "$output" | jq '.running')
healthy=$(echo "$output" | jq '.healthy')

echo "Service Status:"
echo "  Total: $total"
echo "  Running: $running"
echo "  Healthy: $healthy"

# Check if any services are unhealthy
unhealthy=$(echo "$output" | jq '.services | map(select(.health == "unhealthy")) | length')
if [ "$unhealthy" -gt 0 ]; then
    echo "WARNING: $unhealthy unhealthy services detected"
    echo "$output" | jq -r '.services[] | select(.health == "unhealthy") | "  - \(.name)"'
fi
```

## Use Cases

### Monitoring Scripts

Create monitoring scripts that alert on service health:

```bash
#!/bin/bash
# health-check.sh

output=$(rfapps status --json)
unhealthy=$(echo "$output" | jq '.services | map(select(.health == "unhealthy")) | length')

if [ "$unhealthy" -gt 0 ]; then
    services=$(echo "$output" | jq -r '.services[] | select(.health == "unhealthy") | .name' | tr '\n' ', ')
    # Send alert via webhook
    curl -X POST "https://hooks.example.com/alert" \
         -H "Content-Type: application/json" \
         -d "{\"text\": \"Unhealthy services: $services\"}"
fi
```

### CI/CD Integration

Verify deployment success in CI pipelines:

```bash
#!/bin/bash
# deploy-verify.sh

rfapps deploy -g media-stack --json --yes > deploy-result.json

# Check for failures
failed=$(jq '.failed | length' deploy-result.json)
if [ "$failed" -gt 0 ]; then
    echo "Deployment failed for:"
    jq -r '.failed[] | "  - \(.name): \(.error)"' deploy-result.json
    exit 1
fi

echo "Deployment successful: $(jq '.started' deploy-result.json) services started"
```

### Service Inventory

Generate service inventory reports:

```bash
# Export service inventory
rfapps status --all --json | jq -r '.services[] | [.name, .state, .health, .image, .tag] | @csv' > services.csv

# Generate markdown table
echo "| Service | State | Health | Image |"
echo "|---------|-------|--------|-------|"
rfapps status --json | jq -r '.services[] | "| \(.name) | \(.state) | \(.health) | \(.image):\(.tag) |"'
```

### Dry-Run Preview

Preview changes before execution:

```bash
# Preview deployment in JSON
rfapps deploy -g arr-stack --dry-run --json | jq '.'

# Show what services would be affected
rfapps rebuild -s traefik --dry-run --json | jq -r '.services[]'
```

## Combining with Other Options

JSON output works with all other options:

```bash
# Verbose JSON output (additional debug info)
rfapps status --json --debug

# Dry-run with JSON
rfapps deploy -s plex --dry-run --json

# Status with health details in JSON
rfapps status --health --json
```

## Best Practices

1. **Use jq for parsing**: jq provides powerful JSON manipulation and filtering
2. **Handle failures gracefully**: Always check the `failed` array in responses
3. **Combine with dry-run**: Use `--dry-run --json` to preview operations safely
4. **Store output for debugging**: Redirect JSON output to files for troubleshooting
5. **Use in scripts**: JSON mode is designed for automation, not interactive use
6. **Trust managed update exit codes**: A healthy verified restore still exits `1` because the
   requested update failed
7. **Keep stdout isolated**: Redirect stdout for `update.v1`; send stderr elsewhere only when you
   intentionally want to separate progress logs
8. **Treat reconciliation as one document**: Parse the complete `reconcile.v1` result after the
   command exits; do not expect streamed per-service JSON

## Related Documentation

- [Output Formats](output-formats.md) - All output format options (JSON, YAML, CSV, table, text)
- [Quick Reference](quick-reference.md) - One-page command reference card
- [rfapps CLI Reference](../reference/rfapps-cli-reference.md) - Complete command documentation
- [Dry-Run Mode](dry-run-mode.md) - Preview actions without executing
- [Shell Completion](shell-completion.md) - Tab completion setup
- [Sidecar Linking](sidecar-linking.md) - Automatic sidecar management
- [Plan/Apply Workflow](plan-apply-workflow.md) - Terraform-inspired preview workflow
- [rfapps Reconcile Command](rfapps-reconcile-command.md) - Report-first convergence and
  `reconcile.v1`
- [rfapps Tag Selector](rfapps-tag-selector.md) - `tags.v1` envelopes and `--tag` selection semantics
- [Error Handling](error-handling.md) - Managed update exit and failure semantics
- [Secrets Management](secrets-management.md) - Private managed plan and report persistence
