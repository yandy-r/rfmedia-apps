# Deployment History

The `rfapps history` command provides visibility into deployment operations by querying the SQLite-based state database. This enables tracking of service deployments, debugging deployment issues, and identifying rollback targets.

## Overview

Every deployment operation (`deploy`, `rebuild`, `delete`, `apply`, `prune`, `update`,
`rollback`) is automatically recorded in a local SQLite database. The history command allows you
to query these records with powerful filtering options.

Key features:

- View deployment history for all services or filter by service name
- Filter by action type (deploy, rebuild, delete, rollback, apply, prune, update)
- Filter by date range using ISO 8601 timestamps
- List immutable generation snapshots with `--generations` (restore targets)
- Inspect immutable daemon-local image IDs and repository digests in JSON output
- Limit results to focus on recent activity
- Output in table format or JSON for scripting

## Quick Start

```bash
# Show last 10 deployments across all services
rfapps history

# Show last 20 deployments for a specific service
rfapps history -s traefik --limit 20

# Show only deploy actions
rfapps history --action deploy

# Show managed image-update attempts
rfapps history --action update

# Show deployments since a specific date
rfapps history --since 2026-01-01

# Output as JSON for scripting
rfapps history --json

# List immutable generation snapshots (restore targets)
rfapps history --generations -s traefik
```

## Command Reference

```bash
rfapps history [options]
```

### Options

| Option             | Short | Description                                                |
| ------------------ | ----- | ---------------------------------------------------------- |
| `--service <name>` | `-s`  | Filter by service name                                     |
| `--limit <number>` |       | Maximum entries to return (default: 10)                    |
| `--since <date>`   |       | Filter entries after this date (ISO 8601)                  |
| `--action <type>`  |       | Filter by action type                                      |
| `--generations`    |       | Show immutable generation snapshots instead of raw history |
| `--json`           |       | Output in JSON format                                      |
| `--debug`          |       | Enable debug output                                        |

`--action` and `--since` apply to raw history only and cannot be combined with
`--generations` (use `rfapps rollback --to-time` to restore by time).

### Valid Action Types

| Action     | Description                                    |
| ---------- | ---------------------------------------------- |
| `deploy`   | Service was deployed with `rfapps deploy`      |
| `rebuild`  | Service was rebuilt with `rfapps rebuild`      |
| `delete`   | Service was removed with `rfapps delete`       |
| `prune`    | Service was pruned with `rfapps prune`         |
| `apply`    | Service was deployed via `rfapps apply`        |
| `update`   | Managed image update was attempted             |
| `rollback` | Service was rolled back with `rfapps rollback` |

## Generation Snapshots

Every successful deploy-like action (deploy, rebuild, apply, update, rollback) appends an
immutable, per-service numbered generation snapshot — Nix-style generational state. Generations
are append-only restore targets: they are never updated or deleted, and only verified or known
running configurations appear in the list. Failed deployment records and destructive actions
(`delete`, `prune`) do not create generations.

A managed update also writes a **pre-update generation** before it pulls or recreates anything.
This generation captures the current configured image reference, daemon-local `imageId`, and
repository `imageDigest`. It is the automatic recovery anchor if update verification later fails.
Because it is a safety snapshot rather than the result of a deployment row, its `deploymentId`
may be absent. A successful verified update appends another generation for the new image; a
verified automatic restore appends a `rollback` generation for the restored image. A failed update
record never creates a post-update generation; its known-good pre-update generation remains.

```bash
$ rfapps history --generations -s traefik

Generations

    Gen  Timestamp            Service   Action    Deploy  Image Tag
  ------------------------------------------------------------------
     #2  2026-05-10 10:00:00  traefik   rebuild        2  traefik:v3.1
     #1  2026-05-01 10:00:00  traefik   deploy         1  traefik:v3.0

Restore with: rfapps rollback -s <service> --to-generation <n>
```

When present, the `Deploy` column links a generation back to its originating deployment ID in raw
history. Pre-update recovery generations can show no deployment ID. Restore a generation with
`rfapps rollback -s <service> --to-generation <n>` or by time with
`--to-time <timestamp>` — see
[Deployment Rollback](deployment-rollback.md) for details and restore scope.

### Immutable Image Identity

Modern history and generation records can include two complementary fields:

| Field         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `imageId`     | Immutable image ID local to the Docker daemon that observed the image   |
| `imageDigest` | Canonical repository digest identifying registry content when available |

An `imageId` makes a generation eligible for exact manual restore while that image remains on the
same Docker daemon. It is not a portable registry reference. `imageDigest` supports auditing and
reviewed update identity, but automatic recovery deliberately uses the captured daemon-local
`imageId` rather than resolving a mutable tag again.

Legacy rows remain readable and can have both fields absent. Such rows are tag-only history, not
exact recovery anchors.

## Table Output

The default table format displays key deployment information in a compact, color-coded layout.

```bash
$ rfapps history -s traefik

Deployment History

    ID  Timestamp            Service               Action      Status        Image Tag
  ----------------------------------------------------------------------------------------------------
    42  2026-01-31 14:23:15  traefik               deploy      success       traefik:v3.0
    40  2026-01-31 13:10:00  traefik               update      failed        traefik:v3.0
    38  2026-01-30 09:45:22  traefik               rebuild     success       traefik:v3.0
    35  2026-01-28 16:30:00  traefik               deploy      failed        traefik:v3.0
    31  2026-01-25 11:15:33  traefik               deploy      success       traefik:v2.11

Showing 5 entries
```

### Color Coding

**Status Colors:**

- Green: `success` - Deployment completed successfully
- Red: `failed` - Deployment encountered an error
- Yellow: `rolled_back` - Deployment was subsequently rolled back

**Action Colors:**

- Green: `deploy` - Standard deployment
- Blue: `rebuild` - Service rebuild (stop + pull + start)
- Red: `delete` / `prune` - Service removal
- Yellow: `rollback` - Rollback to previous state
- Cyan: `apply` - Applied from saved plan
- Gray: `update` - Managed image update attempt

## JSON Output

Use `--json` for machine-readable output suitable for scripting and automation.

```bash
rfapps history -s plex --json
```

```json
{
  "entries": [
    {
      "id": 45,
      "timestamp": "2026-01-31T18:30:00.000Z",
      "service": "plex",
      "action": "update",
      "imageTag": "plexinc/pms-docker:latest",
      "imageId": "sha256:3b4a...9d10",
      "imageDigest": "plexinc/pms-docker@sha256:70a1...e2f3",
      "status": "success",
      "planId": "update-20260131T182900Z-7d91",
      "errorMessage": null
    },
    {
      "id": 40,
      "timestamp": "2026-01-29T12:00:00.000Z",
      "service": "plex",
      "action": "rebuild",
      "imageTag": "plexinc/pms-docker:latest",
      "status": "success",
      "planId": null,
      "errorMessage": null
    }
  ],
  "totalCount": 15,
  "filters": {
    "service": "plex",
    "action": null,
    "since": null,
    "limit": 10
  }
}
```

### Parsing with jq

```bash
# Get list of deployment IDs for a service
rfapps history -s traefik --json | jq -r '.entries[].id'

# Count failed deployments
rfapps history --action deploy --json | jq '[.entries[] | select(.status == "failed")] | length'

# Get the most recent successful deployment ID
rfapps history -s plex --json | jq -r '.entries[] | select(.status == "success") | .id' | head -1

# Extract timestamps of all rollbacks
rfapps history --action rollback --json | jq -r '.entries[].timestamp'
```

## Filtering Examples

### Filter by Service

View history for a specific service:

```bash
# Show traefik deployment history
rfapps history -s traefik

# Show all authentik services
rfapps history -s authentik-server
rfapps history -s authentik-worker
```

### Filter by Action

View history for specific operation types:

```bash
# Show only deployments
rfapps history --action deploy

# Show only rebuilds
rfapps history --action rebuild

# Show only rollbacks
rfapps history --action rollback

# Show only managed updates
rfapps history --action update

# Show deletions and prunes
rfapps history --action delete
rfapps history --action prune
```

### Filter by Date

View history starting from a specific date:

```bash
# Show deployments since January 1st, 2026
rfapps history --since 2026-01-01

# Show deployments since a specific time
rfapps history --since "2026-01-15T14:30:00Z"

# Combine with service filter
rfapps history -s plex --since 2026-01-01
```

### Adjust Result Limit

Control the number of results returned:

```bash
# Show last 5 deployments
rfapps history --limit 5

# Show last 50 deployments
rfapps history --limit 50

# Show all deployments for a service (use high limit)
rfapps history -s traefik --limit 1000
```

### Combined Filters

Multiple filters can be combined:

```bash
# Last 20 successful deploys for traefik since January
rfapps history -s traefik --action deploy --since 2026-01-01 --limit 20

# All rebuilds in the last week
rfapps history --action rebuild --since "$(date -d '7 days ago' -Iseconds)"

# Failed deployments for media services
rfapps history -s plex --limit 50 --json | jq '[.entries[] | select(.status == "failed")]'
```

## Use Cases

### Debugging Failed Deployments

When a deployment fails, use history to investigate:

```bash
# Find recent failed deployments
rfapps history --limit 20 --json | jq '.entries[] | select(.status == "failed")'

# Check specific service history
rfapps history -s sonarr --limit 10

# See what image tags were used
rfapps history -s sonarr --json | jq -r '.entries[] | "\(.timestamp): \(.imageTag)"'
```

### Identifying Rollback Targets

Before rolling back, identify good targets:

```bash
# Find successful deployments for rollback
rfapps history -s traefik --json | jq '.entries[] | select(.status == "success") | {id, timestamp, imageTag}'

# Get deployment IDs
rfapps history -s traefik --limit 5
# Then rollback to specific ID
rfapps rollback -s traefik --to-deployment 38
```

For an exact same-daemon restore, prefer a modern generation that has an `imageId`:

```bash
rfapps history --generations -s traefik --json | \
  jq '.entries[] | {generation, createdByAction, imageId, imageDigest}'
rfapps rollback -s traefik --to-generation 5 --dry-run
```

### Auditing Deployment Activity

Track deployment activity over time:

```bash
# Count deployments per service
rfapps history --limit 100 --json | jq -r '.entries | group_by(.service) | .[] | "\(.[0].service): \(length)"'

# Find most recent deployment per service
rfapps history --limit 200 --json | jq -r '[.entries | group_by(.service) | .[] | .[0]] | .[] | "\(.service): \(.timestamp)"'

# Export deployment log as CSV
rfapps history --limit 500 --json | jq -r '.entries[] | [.id, .timestamp, .service, .action, .status, .imageTag] | @csv'
```

### CI/CD Integration

Verify deployment state in pipelines:

```bash
#!/bin/bash
# check-deployment.sh

service="$1"
output=$(rfapps history -s "$service" --limit 1 --json)

status=$(echo "$output" | jq -r '.entries[0].status')
timestamp=$(echo "$output" | jq -r '.entries[0].timestamp')

if [ "$status" = "success" ]; then
    echo "Latest deployment for $service: SUCCESS at $timestamp"
    exit 0
else
    echo "Latest deployment for $service: $status at $timestamp"
    exit 1
fi
```

## State Database Location

The deployment history is stored in a SQLite database following XDG conventions:

```
~/.config/rfapps/state.db
```

The path is resolved in this order: `~/.config/rfapps/state.db` is preferred (XDG);
`~/.rfapps/state.db` is used only when that legacy directory already exists. The resolved path can
be overridden with the `RFAPPS_STATE_DB_PATH` environment variable or `state.dbPath` in the rfapps
config file.

If the database is corrupt, missing, or has lost services, see
[rfapps State Rebuild](rfapps-state-rebuild.md).

## Entry Fields

Each history entry contains:

| Field            | Description                                          |
| ---------------- | ---------------------------------------------------- |
| `id`             | Unique auto-incrementing identifier                  |
| `timestamp`      | ISO 8601 timestamp of the operation                  |
| `service`        | Name of the service                                  |
| `action`         | Type of operation performed                          |
| `imageTag`       | Configured Docker image reference, if applicable     |
| `imageId`        | Immutable daemon-local image ID, if observed         |
| `imageDigest`    | Canonical repository digest, if observed             |
| `configSnapshot` | JSON snapshot of configuration for audit/rollback    |
| `status`         | Result: success, failed, or rolled_back              |
| `planId`         | Managed or ordinary plan identifier, when applicable |
| `errorMessage`   | Bounded error details when the operation failed      |

## Best Practices

1. **Use service filters for focused queries**: Target specific services to reduce noise
2. **Check history before rollback**: Identify successful deployments as rollback targets
3. **Prefer exact generations**: Use modern generation targets with `imageId` for precise restores
4. **Monitor failed deployments**: Regularly check for failed operations
5. **Export for auditing**: Use JSON output to create deployment audit logs
6. **Set appropriate limits**: Use higher limits for comprehensive searches, lower for quick checks

## Troubleshooting

### No History Found

If `rfapps history` returns no results:

1. Check if any deployments have been recorded since state tracking was enabled
2. Verify the database path exists: `ls ~/.config/rfapps/state.db`
3. Check filters are not too restrictive (remove filters to test)

### Database Not Found

If the database does not exist, it will be created automatically on the first deployment operation. Run a deployment or rebuild to initialize:

```bash
rfapps deploy -s traefik --yes
```

If the database is corrupt, missing, or has lost services, see
[rfapps State Rebuild](rfapps-state-rebuild.md).

### Filter Validation Errors

Invalid filters will produce error messages:

```bash
# Invalid action type
rfapps history --action invalid
# Error: Invalid action filter: "invalid". Valid actions: deploy, rebuild, delete, rollback, apply, prune, update

# Invalid date format
rfapps history --since "not-a-date"
# Error: Invalid date format: "not-a-date". Use ISO 8601 format (e.g., 2024-01-01 or 2024-01-01T00:00:00Z).
```

## Related Documentation

- [Deployment Rollback](deployment-rollback.md) - Roll back to previous deployments
- [Plan/Apply Workflow](plan-apply-workflow.md) - Preview and apply deployment plans
- [Dry-Run Mode](dry-run-mode.md) - Preview actions without executing
- [JSON Output Mode](json-output.md) - Machine-readable output for scripting
- [Quick Reference](quick-reference.md) - One-page command reference card
