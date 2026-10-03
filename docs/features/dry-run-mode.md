# Dry-Run Mode

This document describes the dry-run mode in the rfapps CLI, which allows you to preview actions without executing them, enabling safe validation of configurations and command effects.

## Overview

Dry-run mode (`--dry-run`) simulates command execution without making any changes to your Docker environment. It shows exactly what would happen if you ran the command for real, making it invaluable for:

- Testing configurations before deployment
- Validating service and sidecar expansion
- Reviewing destructive operations before execution
- Training and documentation purposes

## Enabling Dry-Run Mode

Add the `--dry-run` flag to any rfapps command:

```bash
rfapps deploy --dry-run
rfapps rebuild -s traefik --dry-run
rfapps delete -g media-stack --dry-run
```

## What Dry-Run Mode Shows

When dry-run is enabled, the CLI outputs:

1. **Target services** - Services that would be affected
2. **Expanded sidecars** - Sidecars automatically linked to services
3. **Command phases** - Steps that would be executed
4. **Docker commands** - Actual Docker Compose commands that would run
5. **Configuration** - Environment file and compose file being used

## Examples by Command

### Deploy Dry-Run

```bash
rfapps deploy -s plex --dry-run
```

Output:

```
[DRY-RUN] Would deploy the following services:
  - plex
  - ()

[DRY-RUN] Configuration:
  - Compose file: compose.yml
  - Environment: .env.local

[DRY-RUN] Would execute:
  1. docker compose pull plex
  2. docker compose up -d --remove-orphans plex

[DRY-RUN] No changes made
```

#### Staged Deploy Dry-Run

Adding `--staged` replaces the flat execution-plan preview with the batch plan the rollout would
use. Batching is computed from the same dependency phases as `--parallel`, so the preview shows
exactly which services would be gated together and in what order.

```bash
rfapps deploy -g infra-stack --staged --batch-size 3 --dry-run
```

Output:

```text
Staged rollout: 5 batches (batch size 3, on failure: halt)
  Batch 1 [canary]  phase 0    homarr, ofelia, speedtest-tracker
  Batch 2           phase 0    stirling-pdf, uptime-kuma, forgejo-postgres
  Batch 3           phase 0    cloudflared, docktail, traefik
  Batch 4           phase 1-2  forgejo, forgejo-itcn-runner, forgejo-runner
  Batch 5           phase 2    forgejo-runner-2, forgejo-runner-3
```

The worst-case lock-hold line that a real staged deploy prints is omitted in dry-run, because no
gate runs and the per-batch health budget is therefore zero.

### Rebuild Dry-Run

```bash
rfapps rebuild -g media-stack --dry-run
```

Output:

```
[DRY-RUN] Would rebuild the following services:
  - plex
  - sonarr
  - radarr
  - lidarr
  - bazarr

[DRY-RUN] Configuration:
  - Compose file: compose.yml
  - Environment: .env.local

[DRY-RUN] Would execute phases:
  1. Stop: docker compose stop plex sonarr radarr lidarr bazarr
  2. Pull: docker compose pull plex sonarr radarr lidarr bazarr
  3. Build: docker compose build plex sonarr radarr lidarr bazarr
  4. Start: docker compose up -d plex sonarr radarr lidarr bazarr

[DRY-RUN] No changes made
```

### Delete Dry-Run

```bash
rfapps delete -s plex --volumes --images --dry-run
```

Output:

```
[DRY-RUN] Would delete the following services:
  - plex
  - ()

[DRY-RUN] Additional cleanup:
  - Volumes: Would be removed
  - Images: Would be removed

[DRY-RUN] Configuration:
  - Compose file: compose.yml
  - Environment: .env.local

[DRY-RUN] Would execute:
  1. docker compose stop plex
  2. docker compose rm -f plex
  3. docker volume rm [associated volumes]
  4. docker rmi [associated images]

[DRY-RUN] No changes made
```

### Prune Dry-Run

```bash
rfapps prune -g auth-stack --images --volumes --dry-run
```

Output:

```
[DRY-RUN] Would prune the following services:
  - authentik-server
  - authentik-worker
  - authentik-db
  - authentik-redis
  - authentik-media

[DRY-RUN] Cleanup flags:
  - Images: Would remove service images
  - Volumes: Would remove service volumes

[DRY-RUN] Configuration:
  - Compose file: compose.yml
  - Environment: .env.local

[DRY-RUN] Would execute phases:
  1. Stop containers
  2. Remove containers
  3. Remove images (5 estimated)
  4. Remove volumes

[DRY-RUN] No changes made
```

## Use Cases

### Validating Service Expansion

Verify which services and sidecars will be affected:

```bash
# See what services are included in a group
rfapps deploy -g vpn-stack --dry-run

# Check sidecar expansion for a service
rfapps rebuild -s plex --dry-run

# Verify dependency resolution
rfapps delete -s authentik-server --dry-run
```

### Testing Configuration Changes

Before deploying with a new configuration:

```bash
# Test with different compose file
rfapps deploy -f compose.custom.yml --dry-run

# Test with different environment
rfapps deploy -e .env.staging --dry-run

# Test with secrets injection
rfapps deploy --use-dotenvx .env.local --dry-run
```

### Reviewing Destructive Operations

Always dry-run before destructive commands:

```bash
# Before deleting services
rfapps delete -s critical-service --volumes --dry-run

# Before pruning
rfapps prune -g media-stack --images --volumes --dry-run

# Before force-recreating
rfapps deploy --force-recreate --dry-run
```

### Preview Specific Profiles

```bash
# See what services are in the 'core' profile
rfapps deploy -p core --dry-run

# See what services are in 'all'
rfapps deploy -p all --dry-run
```

## Combining with JSON Output

For scripting and automation, combine dry-run with JSON output:

```bash
# Get dry-run results as JSON
rfapps deploy -g media-stack --dry-run --json
```

```json
{
  "dryRun": true,
  "services": ["plex", "sonarr", "radarr", "lidarr", "bazarr"],
  "sidecarsExpanded": [],
  "phases": ["pull", "up"],
  "composeFile": "compose.yml",
  "envFile": ".env.local"
}
```

Parse with jq:

```bash
# List services that would be affected
rfapps deploy -s plex --dry-run --json | jq -r '.services[]'

# Check if sidecars were expanded
rfapps deploy -s plex --dry-run --json | jq '.sidecarsExpanded'
```

### Combining Dry-Run with Staged Rollouts

`--staged --dry-run` adds a `staged` object to the machine payload describing the batch plan that
would run. It is present only when `--staged` is used:

```bash
rfapps deploy -g infra-stack --staged --batch-size 3 --dry-run --output json
```

```json
{
  "dryRun": true,
  "services": [
    "docktail",
    "traefik",
    "cloudflared",
    "homarr",
    "uptime-kuma",
    "stirling-pdf",
    "speedtest-tracker",
    "ofelia",
    "forgejo",
    "forgejo-postgres",
    "forgejo-runner",
    "forgejo-runner-2",
    "forgejo-runner-3",
    "forgejo-itcn-runner"
  ],
  "profiles": ["core", "infrastructure"],
  "composePath": "compose.yml",
  "skipPull": false,
  "forceRecreate": false,
  "waitForReady": true,
  "healthTimeout": 60,
  "parallel": true,
  "workers": 4,
  "staged": {
    "batchSize": 3,
    "onFailure": "halt",
    "batches": [
      { "index": 1, "services": ["forgejo", "forgejo-itcn-runner", "forgejo-postgres"] },
      { "index": 2, "services": ["forgejo-runner", "forgejo-runner-2", "forgejo-runner-3"] },
      { "index": 3, "services": ["homarr", "ofelia", "speedtest-tracker"] },
      { "index": 4, "services": ["stirling-pdf", "uptime-kuma", "cloudflared"] },
      { "index": 5, "services": ["docktail", "traefik"] }
    ]
  }
}
```

`services[]` is the full resolved set in the order the group declares it, and `staged.batches[]` is
a complete repartition of exactly that set — every service appears in exactly one batch. Batching is
a linear chunk of the blast-radius ordering, so the batch count is
`ceil(services.length / batchSize)` (14 services at `--batch-size 3` give five batches, the last one
short) and the ordering is independent of the order in `services[]`.

`batches[]` is ordered, and `index` is 1-based across the whole rollout. Batch 1 is the canary.
`parallel` is `true` in this payload even without `--parallel`, because `--staged` always forces
dependency-phased execution.

```bash
# Show just the canary batch
rfapps deploy -g infra-stack --staged --dry-run --output json | jq '.staged.batches[0].services'

# Count batches before committing to a rollout
rfapps deploy -g infra-stack --staged --batch-size 3 --dry-run --output json | jq '.staged.batches | length'
```

Unlike the deploy **result**, the dry-run `staged` **plan** survives `--output csv`: it flattens to
`staged.batchSize`, `staged.onFailure`, and a `staged.batches` cell holding the batch array as a
JSON string. The dry-run plan and the deploy-result summary are different shapes — see
[JSON Output](json-output.md#deploy-command) for the result shape.

### Combining Dry-Run with Conflict Validation

Add `--validate-first` when the preview must also inspect the current Docker authority for
service conflicts:

```bash
rfapps deploy -s plex --dry-run --validate-first --output json
```

This combination remains non-mutating, but it runs read-only Compose resolution and bounded Docker
Engine list/inspect calls. A passing preflight emits one JSON or YAML dry-run document with the
`conflict-validation.v1` result nested under `validation`. A `blocked` or `inconclusive`
validation emits one structured deploy result, exits `1`, and does not pull images, start
containers, run readiness checks, or write deployment state.

CSV is not supported for this nested contract. Using `--output csv --validate-first` is an invalid
invocation that exits `2`; use JSON or YAML instead.

## Dry-Run Limitations

Be aware of these limitations:

| Aspect                  | Behavior in Dry-Run                                                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deployment commands** | Pull, build, start, stop, remove, and other mutating commands are not executed                                                                                                                        |
| **Conflict inspection** | Read-only Compose/Engine inspection runs only with `--validate-first`                                                                                                                                 |
| **File operations**     | Mutating file operations are not performed                                                                                                                                                            |
| **Network changes**     | Not applied                                                                                                                                                                                           |
| **Secrets injection**   | Ordinary dry-run validates tool availability without resolving secret values; `--validate-first` resolves the same effective secret-injected environment as deploy, but never logs or persists values |
| **Health checks**       | Not performed (services not started)                                                                                                                                                                  |
| **Service validation**  | Compose file is parsed; the optional preflight inspects Docker-owned resources                                                                                                                        |

### Validation Still Occurs

Even in dry-run mode, these validations happen:

- Compose file syntax validation
- Environment file existence check
- Service name validation
- Secrets tool availability check (ordinary dry-run does not resolve secret values)
- Sidecar mapping resolution

With `rfapps deploy --dry-run --validate-first`, validation additionally resolves the canonical
Compose model, the same effective secret-injected environment as deploy, and the effective service
scope, then performs read-only inspection of relevant containers, volumes, and networks. Resolved
secret values are never logged or persisted. Required evidence that cannot be collected or
interpreted is reported as `inconclusive`, never as a successful empty snapshot.

### What Dry-Run Cannot Detect

Without `--validate-first`, dry-run cannot detect runtime service conflicts. The optional preflight
detects only its documented Docker-owned port, volume-definition, and explicit network-subnet
conflicts. Dry-run still cannot detect:

- Non-Docker host listeners or `network_mode: host` application sockets
- Volume permissions or application-level storage compatibility
- Network connectivity issues
- Image availability (image is not actually pulled)
- Container health check failures
- Resource constraints (memory, CPU)

## Best Practices

### Always Dry-Run Before Destructive Operations

```bash
# Always preview delete operations
rfapps delete -s important-service --volumes --dry-run

# Review before confirming
rfapps delete -s important-service --volumes --yes  # Only after reviewing
```

### Use Verbose Mode with Dry-Run

```bash
# Get maximum detail
rfapps deploy -g media-stack --dry-run -v

# With debug for troubleshooting
rfapps deploy -s plex --dry-run --debug
```

### Automate Dry-Run in CI/CD

```bash
#!/bin/bash
# validate-deployment.sh

# Run dry-run and capture output
output=$(rfapps deploy -p all --dry-run --json 2>&1)

# Check for errors
if [ $? -ne 0 ]; then
    echo "Dry-run validation failed:"
    echo "$output"
    exit 1
fi

# Verify expected services
expected_services=("traefik" "authentik-server" "plex")
for service in "${expected_services[@]}"; do
    if ! echo "$output" | jq -e ".services | index(\"$service\")" > /dev/null; then
        echo "Expected service not found: $service"
        exit 1
    fi
done

echo "Dry-run validation passed"
```

### Document with Dry-Run Output

Use dry-run output to document deployment procedures:

```bash
# Generate deployment documentation
echo "## Deployment Steps" > deployment-doc.md
echo "" >> deployment-doc.md
echo "### Services Affected" >> deployment-doc.md
rfapps deploy -p all --dry-run --json | jq -r '.services[]' | while read service; do
    echo "- $service" >> deployment-doc.md
done
```

## Interpreting Dry-Run Output

### Service Expansion Indicators

```
  - plex
  - ()    # Sidecar was automatically included
```

### Phase Indicators

```
Would execute phases:
  1. Stop: ...      # Services would be stopped first
  2. Pull: ...      # Images would be pulled
  3. Build: ...     # Containers would be built
  4. Start: ...     # Containers would be started
```

### Cleanup Indicators

```
Additional cleanup:
  - Volumes: Would be removed    # Volumes flagged for removal
  - Images: Would be removed     # Images flagged for removal
```

## Troubleshooting

### Dry-Run Shows Unexpected Services

If dry-run includes unexpected services, check:

1. **Sidecar linking**: Use `--no-sidecars` to disable automatic expansion
2. **Group definition**: Verify group membership with `rfapps --list-groups`
3. **Dependencies**: Some services may be included as dependencies

```bash
# Disable sidecar expansion
rfapps deploy -s plex --no-sidecars --dry-run

# Compare with vs without sidecar expansion
rfapps deploy -s plex --dry-run
rfapps deploy -s plex --no-sidecars --dry-run
```

### Dry-Run Fails Validation

If dry-run fails before showing the preview:

```bash
# Check compose file validity
docker compose config --quiet

# Verify environment file exists
ls -la .env.local

# Check service exists in compose file
docker compose config --services | grep traefik
```

## Related Documentation

- [Quick Reference](quick-reference.md) - One-page command reference card
- [rfapps CLI Reference](../reference/rfapps-cli-reference.md) - Complete command documentation
- [JSON Output Mode](json-output.md) - Machine-readable output for scripting
- [Shell Completion](shell-completion.md) - Tab completion setup
- [Sidecar Linking](sidecar-linking.md) - Automatic sidecar management
- [Plan/Apply Workflow](plan-apply-workflow.md) - Preview changes before deploying
