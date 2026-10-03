# Deployment Rollback

The `rfapps rollback` command restores a service image to a previous deployment state. This enables
rapid recovery from failed deployments or problematic updates while keeping the current Compose
configuration and application data in place.

## Overview

Rollback uses the SQLite state database to identify a previous deployment or immutable generation,
recreates the selected service container, verifies the resulting image identity and running state,
and records the rollback action for audit purposes.

Key features:

- Roll back by steps (N deployments ago) or by specific deployment ID
- Restore to an immutable generation snapshot by number (`--to-generation`) or by time (`--to-time`)
- Exact same-daemon restore for modern generation snapshots that contain an immutable `imageId`
- Explicitly labeled best-effort tag restore for legacy/manual targets without an immutable identity
- Automatic sidecar handling when rolling back services with mapped sidecars (when `sidecars.enabled: true`)
- Dry-run mode to preview rollback actions
- Force mode to recreate deleted services
- Validation ensures only successful deployments can be rollback targets

**Restore scope:** rollback restores the service image only. Service configuration comes from the
current Compose file. Volumes, bind-mounted data, databases, configuration changes, and application
or schema migrations are never reversed. A restored older image can therefore be incompatible with
data migrated by the newer image; take service-specific backups before migration-sensitive updates.

## Managed Update Automatic Restore

`rfapps update --apply` creates a pre-update generation with the currently running daemon-local
image ID before it mutates a service. If recreation or target verification fails and restore is
enabled, the update runner recreates that service from the exact captured image on the same Docker
daemon, verifies the restored image and readiness, then records a successful `rollback` row and
generation.

Automatic managed restore never resolves a mutable tag as a fallback. A missing recovery `imageId`
is a preflight failure before mutation unless the operator explicitly selected
`--no-restore-on-failure`. Daemon-local image IDs are not portable: copying the state database to
another host or pruning the captured image does not create a usable recovery image there.

A verified automatic restore lets a multi-service managed update continue with later services, but
the overall run still reports failure because the attempted update did not remain deployed. If the
restore itself fails verification, execution stops.

## Quick Start

```bash
# Roll back traefik to the previous deployment
rfapps rollback -s traefik --yes

# Roll back 3 deployments
rfapps rollback -s plex --steps 3 --yes

# Roll back to a specific deployment ID
rfapps rollback -s sonarr --to-deployment 42 --yes

# Restore to a specific generation snapshot (from rfapps history --generations)
rfapps rollback -s traefik --to-generation 5 --yes

# Restore to whatever was running at a point in time
rfapps rollback -s traefik --to-time 2026-06-01T00:00:00Z --yes

# Preview rollback without executing
rfapps rollback -s traefik --dry-run

# Recreate a deleted service from its last successful deployment
rfapps rollback -s traefik --force --yes
```

## Command Reference

```bash
rfapps rollback -s <service> [options]
```

### Required Options

| Option             | Short | Description                    |
| ------------------ | ----- | ------------------------------ |
| `--service <name>` | `-s`  | Service to rollback (required) |

### Targeting Options

| Option                  | Description                                                |
| ----------------------- | ---------------------------------------------------------- |
| `--steps <number>`      | Number of successful deployments to roll back (default: 1) |
| `--to-deployment <id>`  | Roll back to a specific deployment ID                      |
| `--to-generation <n>`   | Restore to a specific generation number                    |
| `--to-time <timestamp>` | Restore to the generation active at this time (ISO 8601)   |

`--steps`, `--to-deployment`, `--to-generation`, and `--to-time` are mutually exclusive — specify at most one target. With none given, rollback defaults to `--steps 1`.

### Execution Options

| Option      | Description                                         |
| ----------- | --------------------------------------------------- |
| `--dry-run` | Preview what would be rolled back without executing |
| `--force`   | Skip warnings and allow recreating deleted services |
| `--yes`     | Skip confirmation prompts                           |
| `--json`    | Output in JSON format                               |
| `--debug`   | Enable debug output                                 |

## How Rollback Works

### Step-by-Step Process

1. **Find Target**: Locate the rollback target deployment or generation
2. **Validate Target**: Ensure the target represents a successful state
3. **Select Method**: Choose exact local-image restore or legacy best-effort tag restore
4. **Display Plan**: Show the method and request confirmation
5. **Recreate Service**: Recreate only the selected service and linked sidecars
6. **Verify Identity**: Confirm the target container is running with the intended image
7. **Record Action**: Record the verified rollback and immutable identity in the state database

### Rollback Target Selection

**By Steps (default):**

Steps count backwards from the current deployment through successful deployments only:

- `--steps 1` (default): Previous successful deployment
- `--steps 2`: Second-most-recent successful deployment
- `--steps 3`: Third-most-recent successful deployment

```bash
# Current state: deployment #45 (success)
# History: #45 (success), #42 (failed), #40 (success), #38 (success)
#
# --steps 1 targets: #40 (skips #42 because it failed)
# --steps 2 targets: #38
```

**By Deployment ID:**

Target a specific deployment directly using its ID from `rfapps history`:

```bash
# Find deployment ID from history
rfapps history -s traefik

# Roll back to that specific deployment
rfapps rollback -s traefik --to-deployment 38
```

**By Generation (Nix-style):**

Every successful deploy-like action (deploy, rebuild, apply, rollback) appends
an immutable, per-service numbered generation snapshot. Unlike deployment IDs
(which are global and include failures), generation numbers are sequential per
service and only ever point at successful configurations:

```bash
# List generations for a service
rfapps history --generations -s traefik

# Restore generation #5
rfapps rollback -s traefik --to-generation 5 --yes
```

A successful restore records a new generation pointing at the restored image — generations are
append-only and never rewritten. When the selected generation contains `imageId`, manual rollback
uses that exact image from the current Docker daemon. A legacy generation without `imageId` uses the
best-effort tag workflow described below.

**By Time:**

Restore the generation that was active at a given moment — useful when you
know _when_ things last worked but not which deployment that was:

```bash
# Restore whatever traefik was running on June 1st
rfapps rollback -s traefik --to-time 2026-06-01T00:00:00Z --yes
```

The target is the newest generation created at or before the given timestamp.

### Exact and Best-Effort Restore Methods

The target form and stored metadata determine the restore method:

| Target                                                     | Restore method                              |
| ---------------------------------------------------------- | ------------------------------------------- |
| Modern `--to-generation`/`--to-time` target with `imageId` | Exact daemon-local image recreation         |
| Legacy generation without `imageId`                        | Best-effort mutable-tag pull and recreation |
| `--steps` or `--to-deployment` manual target               | Best-effort mutable-tag pull and recreation |

The CLI displays `Restore Method` before mutation. `--force` does not upgrade a legacy target to an
exact target and cannot make a daemon-local image ID portable. Prefer a modern generation when
exactness matters.

## Output Examples

### Standard Output

```bash
$ rfapps rollback -s plex --yes

Rollback Target:
  Service: plex
  Target Deployment: #38
  Timestamp: 2026-01-28T16:30:00.000Z
  Original Action: deploy
  Image: lscr.io/linuxserver/plex:latest
  Restore Method: best-effort mutable tag (legacy metadata)
  Sidecars:

Pulling image: lscr.io/linuxserver/plex:latest...
Successfully pulled image
Recreating services...
Successfully rolled back plex to deployment #38 (2026-01-28T16:30:00.000Z)
```

### Dry-Run Output

```bash
$ rfapps rollback -s plex --steps 2 --dry-run

Rollback Target:
  Service: plex
  Target Deployment: #35
  Timestamp: 2026-01-25T10:15:00.000Z
  Original Action: rebuild
  Image: lscr.io/linuxserver/plex:latest
  Restore Method: best-effort mutable tag (legacy metadata)
  Sidecars:

[DRY-RUN] Would rollback plex to deployment #35
  Image: lscr.io/linuxserver/plex:latest
  Will also recreate sidecars:
```

### JSON Output

```bash
rfapps rollback -s sonarr --to-deployment 42 --json --yes
```

```json
{
  "success": true,
  "service": "sonarr",
  "targetDeploymentId": 42,
  "rollbackDeploymentId": 48,
  "restoredImageTag": "linuxserver/sonarr:4.0.0"
}
```

## Sidecar Handling

When `sidecars.enabled: true` in `rfapps.config.yaml` and a service has a mapped sidecar, both
the main service and its sidecar are automatically recreated to ensure network connectivity remains
intact. This repo ships with `sidecars.enabled: false`, so the examples below apply only to custom
forks that have enabled sidecar mapping.

```bash
# Rolling back plex also recreates mapped sidecar (when sidecars.enabled: true)
$ rfapps rollback -s plex --dry-run

Rollback Target:
  Service: plex
  Target Deployment: #40
  Timestamp: 2026-01-29T14:00:00.000Z
  Original Action: deploy
  Image: lscr.io/linuxserver/plex:latest
  Sidecars:

[DRY-RUN] Would rollback plex to deployment #40
  Image: lscr.io/linuxserver/plex:latest
  Will also recreate sidecars:
```

The sidecar expansion uses `--force-recreate` to prevent stale network state between the main
service and sidecar containers.

## Force Mode

Force mode (`--force`) is required in two scenarios:

### 1. Rolling Back Deleted Services

If a service was previously deleted or pruned, use `--force` to recreate it:

```bash
# Service was deleted
rfapps delete -s traefik --yes

# Normal rollback warns about deleted service
rfapps rollback -s traefik --yes
# Warning: Service 'traefik' was previously deleted. Use --force to recreate from rollback target.

# Force recreates the service
rfapps rollback -s traefik --force --yes
```

### 2. Rolling Back Many Steps

Rolling back more than 5 steps triggers a warning by default:

```bash
# Warning for large rollback
rfapps rollback -s sonarr --steps 10 --yes
# Warning: Rolling back 10 deployments. Use --force to skip this warning...

# Skip warning with --force
rfapps rollback -s sonarr --steps 10 --force --yes
```

## Dry-Run Mode

Always use `--dry-run` to preview rollback actions before executing:

```bash
# Preview what would happen
rfapps rollback -s traefik --dry-run

# Preview with JSON output
rfapps rollback -s traefik --dry-run --json
```

Dry-run output shows:

- Target deployment ID and timestamp
- Original action type (deploy, rebuild, etc.)
- Image tag that would be restored
- Exact local image ID or best-effort tag restore method
- Sidecars that would be recreated (when `sidecars.enabled: true`)

## Validation and Error Handling

### Insufficient History

Rolling back requires enough successful deployments in history:

```bash
$ rfapps rollback -s new-service --steps 1
Error: Not enough deployment history: found 1 successful deployment(s), need at least 2 to rollback 1 step(s)
```

### Invalid Target Status

Only successful deployments can be rollback targets:

```bash
$ rfapps rollback -s traefik --to-deployment 35
Error: Cannot rollback to deployment 35: status is 'failed', not 'success'
```

### Service Mismatch

When using `--to-deployment`, the deployment must belong to the specified service:

```bash
$ rfapps rollback -s traefik --to-deployment 42
Error: Deployment 42 is for service 'plex', not 'traefik'
```

### Missing Image Information

Rollback requires an image reference from the target deployment:

```bash
$ rfapps rollback -s legacy-service --to-deployment 10
Error: No image information available for deployment 10. Cannot rollback without image reference.
```

## Rollback Workflow

### Standard Recovery Workflow

When a deployment causes issues:

```bash
# 1. Check deployment history to identify the problem
rfapps history -s problematic-service --limit 5

# 2. Preview the rollback
rfapps rollback -s problematic-service --dry-run

# 3. Execute the rollback
rfapps rollback -s problematic-service --yes

# 4. Verify the service is healthy
rfapps status -s problematic-service
```

### Rolling Back Multiple Services

Roll back related services in sequence:

```bash
# Roll back the entire arr-stack to previous versions
for service in sonarr radarr bazarr lidarr; do
    rfapps rollback -s "$service" --yes
done
```

### Recovery from Failed Plan Apply

If `rfapps apply` failed partway through:

```bash
# 1. Check which services have issues
rfapps history --action apply --limit 10

# 2. Identify failed services
rfapps history --limit 20 --json | jq '.entries[] | select(.status == "failed")'

# 3. Roll back the failed services
rfapps rollback -s failed-service --yes

# 4. Fix the plan and reapply
rfapps plan -s failed-service
rfapps apply .rfapps/plans/plan-*.json --yes
```

## Use Cases

### Reverting a Bad Image Update

```bash
# After updating to a problematic new version
rfapps history -s plex --limit 3

# Output shows:
#   45  2026-01-31 18:00:00  plex  deploy   success  plexinc/pms-docker:1.33.0
#   42  2026-01-29 12:00:00  plex  deploy   success  plexinc/pms-docker:1.32.0
#   40  2026-01-25 10:00:00  plex  deploy   success  plexinc/pms-docker:1.32.0

# Roll back to 1.32.0
rfapps rollback -s plex --steps 1 --yes
# Or: rfapps rollback -s plex --to-deployment 42 --yes
```

For updates run through the managed lifecycle, automatic exact-image restore is enabled by default:

```bash
# Preview, then update and verify; a verification failure restores the captured prior image.
rfapps update -s plex --out .rfapps/plans/plex-update.json
rfapps update --from-plan .rfapps/plans/plex-update.json --apply --yes
```

Use manual rollback when the operator selects an earlier known-good generation or when recovering
outside an active managed-update run:

```bash
rfapps history --generations -s plex
rfapps rollback -s plex --to-generation 7 --dry-run
rfapps rollback -s plex --to-generation 7 --yes
```

### Recovering Deleted Service

```bash
# Accidentally deleted a service
rfapps delete -s uptime-kuma --yes

# Check history for last successful state
rfapps history -s uptime-kuma --action deploy --limit 5

# Recreate from last successful deployment
rfapps rollback -s uptime-kuma --force --yes
```

### Quick Undo After Rebuild

```bash
# Rebuild caused issues
rfapps rebuild -s authentik-server --yes

# Immediate rollback to previous state
rfapps rollback -s authentik-server --yes
```

### Rolling Back to Known-Good State

```bash
# Find the last known-good deployment from a specific date
rfapps history -s sonarr --since 2026-01-15 --json | \
    jq -r '.entries[] | select(.status == "success") | .id' | head -1
# Output: 38

# Roll back to that specific deployment
rfapps rollback -s sonarr --to-deployment 38 --yes
```

## State Recording

Each rollback operation is recorded in the state database with:

- `action: "rollback"`
- `status: "success"` or `"failed"`
- `imageTag`: The restored image tag
- `imageId`: The immutable image ID observed after recreation
- `imageDigest`: The repository digest when available
- `configSnapshot`: Configuration from the target deployment

This creates an audit trail and allows rolling forward if needed:

```bash
# View rollback history
rfapps history --action rollback

# The rollback itself becomes a deployment that can be analyzed
rfapps history -s traefik --limit 5
#   50  2026-01-31 20:00:00  traefik  rollback  success  traefik:v2.11
#   45  2026-01-31 18:00:00  traefik  deploy    success  traefik:v3.0
#   42  2026-01-29 12:00:00  traefik  deploy    success  traefik:v2.11
```

## Best Practices

1. **Always dry-run first**: Use `--dry-run` to preview rollback actions
2. **Check history before rollback**: Use `rfapps history` to identify good targets
3. **Prefer modern generations**: A generation with `imageId` enables exact same-daemon restore
4. **Use specific deployment IDs**: When precision matters, use `--to-deployment` instead of `--steps`
5. **Treat legacy rollback as best effort**: Mutable tags can resolve to different image bytes
6. **Verify after rollback**: Check service health with `rfapps status` and `rfapps health`
7. **Document rollback reasons**: Note why rollback was needed for future reference
8. **Roll back sidecars together**: When `sidecars.enabled: true`, let automatic sidecar linking handle related services
9. **Back up migration-sensitive data**: Image restore does not reverse volumes or migrations

## Troubleshooting

### Rollback Fails at Image Pull

If the target image is no longer available in the registry:

```bash
Error: Pull failed: manifest unknown
```

Solutions:

1. Check if image was deleted from registry
2. Use a different rollback target with available image
3. Manually pull the image if it exists elsewhere

This failure applies to legacy best-effort rollback. Exact generation restore uses the already
captured daemon-local image ID and does not pull the mutable target tag.

### Exact Recovery Image Is Missing

An exact restore requires the captured image to remain on the same Docker daemon. If it was pruned
or the state database came from another daemon, choose another modern generation whose image still
exists or perform an explicit legacy/manual recovery. Do not assume a matching tag contains the
same bytes.

### Service Does Not Start After Rollback

If the service fails to start after rollback:

```bash
# Check container logs
docker logs service-name

# Verify the image is compatible with current config
docker compose config --services

# Try a different rollback target
rfapps rollback -s service --steps 2 --yes
```

### Network Issues After Rollback

If network connectivity is broken:

```bash
# Force recreate service
rfapps rebuild -s service --yes
```

### Cannot Find Target Deployment

If the deployment ID is not found:

```bash
# Verify the ID exists
rfapps history --limit 100 --json | jq ".entries[] | select(.id == $TARGET_ID)"

# Check if it belongs to the correct service
rfapps history -s service-name --limit 50
```

## Related Documentation

- [Deployment History](deployment-history.md) - View and query deployment records
- [Plan/Apply Workflow](plan-apply-workflow.md) - Preview and apply deployment plans
- [Dry-Run Mode](dry-run-mode.md) - Preview actions without executing
- [Sidecar Linking](sidecar-linking.md) - Optional sidecar management (disabled in this repo)
- [JSON Output Mode](json-output.md) - Machine-readable output for scripting
- [Quick Reference](quick-reference.md) - One-page command reference card
