# Quick Reference

One-page reference card for common rfapps CLI operations and Docker Compose management.

## Essential Commands

### Tag Selectors

`--tag <pattern>` narrows any selection below by hierarchical tag. It is available on every command
that takes `-g/--group`, plus `status`.

```bash
# Selecting
rfapps plan --tag media                      # whole subtree (a bare segment is inclusive)
rfapps deploy --tag "media/streaming" --yes  # exact path
rfapps pull --tag "media/**,photos/**"       # OR inside one flag (commas)
rfapps stop --tag "**" --tag "!media/**"     # AND across flags: tagged, not media
rfapps status --tag "**/networking"          # leaf-anchored, any depth
rfapps deploy -g arr-stack --tag "media/automation" --yes  # intersection with -g
rfapps stop -s plex --tag "media/**"         # assertion: exits 2 if plex is not media

# Inspecting
rfapps tag list                              # every effective tag and its services
rfapps tag list --tree                       # indented hierarchy
rfapps tag show -s plex                      # declared vs effective tags
rfapps tag suggest                           # paste-ready tags: fragment
rfapps tag suggest --out tags.yaml           # refuses to clobber an existing file
```

| Pattern         | Selects                                                     |
| --------------- | ----------------------------------------------------------- |
| `media`         | the whole `media` subtree, inclusive                        |
| `media/**`      | identical to `media` — `**` matches zero segments           |
| `media/*`       | **rejected**; write `media` or `media/**`                   |
| `*/core/**`     | interior single-segment wildcard                            |
| `**/networking` | any depth, leaf-anchored                                    |
| `**`            | every **tagged** service (untagged services match nothing)  |
| `!media/**`     | everything except `media` — **including untagged services** |

Tags are authored in the `tags:` section of `rfapps.config.yaml`, leaf paths only: a service tagged
`media/automation/tv` also matches `media/automation` and `media`. A pattern that matches nothing
exits `2` instead of targeting everything. See
[rfapps Tag Selector](rfapps-tag-selector.md).

### Status and Monitoring

```bash
# Check service status
rfapps status                    # Running services
rfapps status --all              # All services including stopped
rfapps status --health           # Health check status
rfapps status --stats            # Resource usage
rfapps status -s traefik         # Specific service

# Unified diagnostics
rfapps doctor                    # Read-only platform diagnostics
rfapps doctor -g media-stack     # Diagnose a service group
rfapps doctor --check-updates    # Include registry freshness checks
rfapps doctor --json             # Versioned doctor.v1 JSON
rfapps audit                     # Security posture audit
rfapps audit -s traefik          # Audit one service
rfapps audit --json              # Versioned audit.v1 JSON
rfapps drift detect              # Detect compose/runtime drift
rfapps drift detect --json       # Versioned drift JSON
rfapps drift detect --report-only --json  # Advisory drift JSON
rfapps drift show -s plex        # Show one service drift
rfapps reconcile -s plex         # Read-only desired/actual report
rfapps reconcile -s plex --json  # Complete reconcile.v1 result

# View logs
docker compose logs -f plex      # Follow logs
docker compose logs --tail 50 traefik  # Last 50 lines
```

### Deploying Services

```bash
# Deploy services
rfapps deploy --yes              # All services
rfapps deploy -s plex --yes      # Single service
rfapps deploy -g media-stack --yes  # Service group
rfapps deploy -p core --yes      # Profile

# Deploy options
rfapps deploy --skip-pull --yes  # Skip image pull
rfapps deploy --force-recreate --yes  # Force recreate
rfapps deploy --dry-run          # Preview only
```

### Rebuilding and Updating

```bash
# Managed image update (preview-only by default)
rfapps update -s plex                       # Preview one service and save update-plan.v1
rfapps update -g media-stack                # Preview a service group
rfapps update -s plex --apply               # Confirm, update, and verify sequentially
rfapps update --from-plan .rfapps/plans/media-update.json --apply --yes

# Rebuild (stop + pull + build + start)
rfapps rebuild -s traefik --yes  # Single service
rfapps rebuild -g arr-stack --yes  # Service group
rfapps rebuild --skip-pull --yes # Skip image pull

# Pull images only
rfapps pull --yes                # All images
rfapps pull -g media-stack --yes # Group images
```

### Reconciling Declared State

```bash
# Observe and plan only; reported drift normally exits 0
rfapps reconcile -g media-stack

# Include unchanged services in human output
rfapps reconcile -s plex --show-unchanged

# Preview authorized intent without mutation
rfapps reconcile -s plex --auto-apply --dry-run

# Confirm, lock, revalidate, apply the exact target, and verify convergence
rfapps reconcile -s plex --auto-apply

# Machine-format mutation must be explicitly non-interactive
rfapps reconcile -s plex --auto-apply --yes --json
```

`--auto-apply` alone grants reconciliation mutation authority; `--yes` only skips confirmation and
`--dry-run` always prevents mutation. The same-process lifecycle acquires the lock shared with
managed update, revalidates reviewed evidence, acts on one exact service at a time, verifies
readiness and fresh zero drift, then releases the lock. It does not save plans or history, pull or
build images, remove orphans, start implicit dependencies, or roll back data or images.

| Exit | Reconciliation result                                    |
| ---- | -------------------------------------------------------- |
| `0`  | Trustworthy report, no action needed, or fully converged |
| `1`  | Observation or reconciliation operation failed           |
| `2`  | Invalid/unsafe usage or cancellation                     |
| `3`  | Partial, blocked, or residual drift                      |

Use `rfapps plan`/`apply` for a persisted deployment plan and `rfapps update` for reviewed registry
digest changes with exact-image recovery. Reconciliation has neither persistence nor rollback; a
later run re-observes current state. Version 1 has an allow-all injected policy after explicit
authorization; maintenance-window enforcement remains issue #169.

### Parallel Operations

```bash
rfapps deploy --all --parallel --yes              # Parallel deploy all services
rfapps deploy --all --parallel --workers 8 --yes  # With 8 workers
rfapps rebuild -s plex --parallel --yes           # Parallel rebuild single service
rfapps deploy --all --parallel --dry-run          # Preview execution plan
```

### Staged Rollouts

```bash
rfapps deploy -g infra-stack --staged --batch-size 3 --yes   # Health-gated batches of 3
rfapps deploy -g infra-stack --staged --yes                  # Canary one service at a time
rfapps deploy -g infra-stack --staged --batch-size 3 --dry-run  # Preview the batch plan
rfapps deploy -g infra-stack --staged --on-failure continue --yes  # Attempt every batch
```

`--staged` gates each batch on the health of the services it just started and halts the rollout on
the first failing batch; later services keep running their previous containers. A halt exits `1`
(or `3` with `--allow-partial`) and prints a resume command scoped to the remaining services.
`--batch-size` and `--on-failure` require `--staged`. See
[rfapps CLI README](../../packages/rfapps-cli/README.md) for the full contract.

### Stopping and Cleanup

```bash
# Stop services
rfapps stop --yes                # All services
rfapps stop -s plex --yes        # Single service

# Delete (stop + remove containers)
rfapps delete -s plex --yes      # Basic delete
rfapps delete -s plex --volumes --yes  # With volumes
rfapps delete -s plex --volumes --images --yes  # Full cleanup

# Prune (smart image removal)
rfapps prune -s plex --yes       # Remove service images
rfapps prune -s plex --volumes --images --yes  # Full cleanup
```

### Native Filesystem Backup

```bash
# Plan without bundle, pull, lock, stop, or archive
rfapps backup -s plex --destination /mnt/backups --dry-run

# Create after one confirmation
rfapps backup -g media-stack --destination /mnt/backups

# Explicit full-project machine-mode creation
rfapps backup --all --destination /mnt/backups --output json --yes

# Offline, lock-free verification
rfapps backup verify /mnt/backups/<bundle>/manifest.json
```

Creation archives eligible bind directories and named volumes. The selected scope determines
sources, while the full resolved Compose project determines writable consumers that must be stopped
and recovered by exact container ID. `manifest.json` is published last in a private bundle after
archive synchronization and recovery.

JSON/YAML creation requires an explicit target or `--all` plus `--yes`. Both creation and
verification reject CSV. Exit `0` means a complete plan, published/recovered bundle, or fully
verified bundle; `1` means an operational or integrity failure; `2` means invalid/unsafe usage,
unsupported manifest, or cancelled approval.

See [rfapps Native Backup](rfapps-backup.md) for helper probing, destination safety, output
envelopes, limitations, and manual restore guidance.

### Vulnerability Scanning

```bash
# Advisory report alongside a plan
rfapps plan -g media-stack --scan

# Gate a deploy at high and above; nothing is pulled or started when it blocks
rfapps deploy -s plex --scan --scan-fail-on high --yes

# Pick a backend explicitly
rfapps plan -s sonarr --scan --scanner grype

# Preview the verdict without deploying
rfapps deploy -s plex --scan --scan-fail-on critical --dry-run

# Machine envelope: { planPath, plan, scan }
rfapps plan -s plex --scan --output json
```

`--scan` is opt-in and resolves images from `docker compose config`, so build-only services are
skipped and each distinct image is scanned once. The default threshold is `--scan-fail-on none`
(report only, exit `0`).

With any other threshold the gate is fail-closed: a missing scanner, a timeout, a capture overflow, a
non-zero scanner exit, and an unparsable report all resolve to `inconclusive` and block with exit
`1`. On `deploy` the gate runs before any pull or container start, so a blocked run modifies nothing;
`--yes` does not waive it. `plan` still writes the plan file but suppresses `--apply`.
`plan --dry-run` short-circuits before plan generation, so it scans nothing.

See [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md) for backends, skips,
suppressions, JSON shape, and limitations.

### Security Hardening

```bash
# Propose only; writes nothing
rfapps harden

# Restrict to one rule and emit a compose override fragment
rfapps harden --rule harden-no-new-privileges --out compose.harden.yaml

# Edit compose.yml in place after a .bak copy and one confirmation
rfapps harden --apply

# Include review-confidence rules in the written output
rfapps harden --apply --include-review

# Catalog and machine output
rfapps harden --list-rules
rfapps harden --json
```

A bare `rfapps harden` writes nothing and touches no containers, images, or recorded state. Proposals
are split by confidence: `safe` changes are mechanical, `review` changes can break a workload and are
excluded from writes unless `--include-review`, and `advisory` proposals (healthcheck, memory, CPU)
are never written because rfapps will not invent a probe command or a resource ceiling.

`--apply` refuses to edit a key that resolves to a YAML alias, and refuses when re-serializing
`compose.yml` would reformat lines it did not target unless `--allow-reformat` is passed. Exit `0` on
a clean propose, override, apply, or cancellation; `3` when an apply wrote some patches and refused
others; `1` on compose or write failure; `2` on usage errors.

See [rfapps Harden Command](rfapps-harden-command.md) for the rule catalog, override semantics, and
exit-code contract.

## Service Groups

| Group            | Services                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `media-stack`    | plex, plex-music, jellyfin, plex-ratings-sync, kometa, tautulli, plexseerr, jellyseerr, watchstate, sonarr, radarr, lidarr, bazarr |
| `arr-stack`      | sonarr, radarr, lidarr, bazarr, prowlarr                                                                                           |
| `download-stack` | unpackerr, autobrr, sabnzbd, slskd, nzbget                                                                                         |
| `auth-stack`     | authentik-server, worker, db, redis, media                                                                                         |
| `photo-stack`    | immich-server, ml, redis, postgres                                                                                                 |
| `vpn-stack`      | slskd                                                                                                                              |

```bash
rfapps deploy -g media-stack --yes
rfapps rebuild -g arr-stack --yes
```

## Docker Compose Profiles

| Profile          | Description                                                               | Count |
| ---------------- | ------------------------------------------------------------------------- | ----- |
| `core`           | Essential infrastructure (Traefik, Authentik)                             | 7     |
| `infrastructure` | Management tools (Uptime Kuma, Homarr, StirlingPDF)                       | 4     |
| `downloads`      | Download clients and helpers                                              | 9     |
| `arr-stack`      | Automation (Sonarr, Radarr, Bazarr, Lidarr)                               | 7     |
| `media`          | Media servers (Plex, Tautulli, Plexseerr, Jellyseerr, Kometa, WatchState) | 6+    |
| `photos`         | Photo management (Immich)                                                 | 4     |
| `all`            | All services                                                              | 36    |

```bash
docker compose --profile core up -d
docker compose --profile all config --quiet  # Validate
```

## Sidecar Linking

Sidecar linking is a CLI feature (`sidecars.enabled: true`) that auto-expands service targets to
include mapped sidecar pairs. This repo ships with `sidecars.enabled: false` — tailnet exposure
is handled by Docktail labels on the `apps` network. See
[Sidecar Linking](../features/sidecar-linking.md) for how to enable it in custom forks.

```bash
# Disable sidecar linking explicitly (already off in this repo)
rfapps deploy -s plex --no-sidecars --yes

# Preview services that would be selected
rfapps deploy -s plex --dry-run
```

## Plan/Apply Workflow

Preview changes before deploying (Terraform-inspired).

```bash
# Generate plan
rfapps plan -s traefik                    # Basic plan
rfapps plan -s traefik --check-updates    # Check for newer images
rfapps plan -s traefik --explain          # Annotate cause and dependency impact
rfapps plan -g media-stack --verbose      # Detailed output

# Apply plan
rfapps apply .rfapps/plans/plan-*.json --yes

# Combined
rfapps plan -s traefik --apply --yes
```

`plan --check-updates` is advisory. For a reviewed image lifecycle, use `rfapps update`: bare
invocation saves a secret-free managed plan, while `--apply` prompts once and then updates services
one at a time. A saved managed plan must be routed back through update:

```bash
rfapps update -g media-stack --out .rfapps/plans/media-update.json
rfapps update --from-plan .rfapps/plans/media-update.json --apply --yes
```

Do not pass a managed plan to ordinary `rfapps apply`; it is rejected even with `--force`. Managed
apply also refuses Compose, Docker-context, scope, current-image, platform, or proposed-digest drift
and requires a new preview.

Automatic recovery restores the exact previous daemon-local image and verifies it. Recovery is
image-only under current Compose configuration: volumes, data, databases, and migrations are not
restored. Services run sequentially; a verified restore continues later work but exits `1`, while a
restore failure stops the run. Complete previews/no updates and verified updates exit `0`; lifecycle
failures exit `1`; invalid arguments or plans exit `2`.

**Change symbols:**

- `+` (green) - Create
- `~` (cyan) - Recreate (image changed)
- `!` (yellow) - Update (config changed)
- `-` (red) - Delete
- `=` (gray) - Unchanged
- `^` (yellow) - Update available

## Secrets Management

```bash
# Using dotenvx (encrypted files)
rfapps deploy --use-dotenvx .env.local --yes

# Using 1Password CLI
rfapps deploy --use-op .env --yes

# Setup dotenvx
dotenvx encrypt .env.local
```

## Common Options

| Option               | Short | Description                         |
| -------------------- | ----- | ----------------------------------- |
| `--service <name>`   | `-s`  | Target specific service             |
| `--services <names>` |       | Multiple services (comma-separated) |
| `--group <name>`     | `-g`  | Target service group                |
| `--profile <name>`   | `-p`  | Docker Compose profile              |
| `--compose <path>`   | `-f`  | Custom compose file                 |
| `--env-file <path>`  | `-e`  | Custom environment file             |
| `--dry-run`          |       | Preview without executing           |
| `--json`             |       | JSON output for scripting           |
| `--verbose`          | `-v`  | Detailed output                     |
| `--yes`              | `-y`  | Skip confirmations                  |
| `--no-sidecars`      |       | Disable sidecar linking             |
| `--skip-pull`        |       | Skip pulling images                 |
| `--force-recreate`   |       | Force recreate containers           |

Reconciliation also supports `--auto-apply`, `--show-unchanged`, and
`--health-timeout <seconds>`, plus the service/group/profile/Compose/environment selectors above.

## Shell Completion

```bash
# Install completion
rfapps completion bash --install
rfapps completion zsh --install
rfapps completion fish --install
```

## JSON Output for Scripting

```bash
# Get status as JSON
rfapps status --json | jq '.services'

# Check for failures
rfapps deploy -g media-stack --json --yes | jq '.failed'

# Filter unhealthy
rfapps status --json | jq '.services[] | select(.health == "unhealthy")'

# Summarize doctor findings
rfapps doctor --json | jq '.summary'
rfapps doctor --json | jq -r '.findings[].suggestedCommand // empty'

# Summarize audit findings
rfapps audit --json | jq '.summary'
rfapps audit --json | jq -r '.findings[] | "\(.severity) \(.service): \(.ruleId)"'

# Summarize drift findings
rfapps drift detect --report-only --json | jq '.summary'
rfapps drift detect --report-only --json | jq '.services[] | select(.hasDrift)'

# Summarize deterministic reconciliation output
rfapps reconcile --json | jq '.summary'
rfapps reconcile --json | jq '.services[] | select(.comparison != "in_sync")'

# Create one versioned backup result
rfapps backup -s plex --destination /mnt/backups --yes --json | jq '.summary'

# Verify one bundle without config or Docker
rfapps backup verify /mnt/backups/<bundle>/manifest.json --json | jq '.summary'
```

## Troubleshooting Quick Commands

```bash
# Check container status
docker compose ps -a

# View container logs
docker compose logs -f <service>

# Check health
docker inspect --format='{{json .State.Health}}' <container> | jq

# Check network
docker network inspect apps

# Docktail reconciler
docker compose logs docktail --tail 20

# Database checks
docker exec authentik-db pg_isready -U authentik
docker exec authentik-redis redis-cli ping
```

## Environment Variables

**Key Variables:**

```bash
DOCKER_DIR=/opt/docker/config     # Service configs
DOCKER_DATA_DIR=/opt/docker/data  # Service data
DATA_DIR=/mnt/media               # Media files
TZ=America/New_York               # Timezone
PUID=1000                         # User ID
PGID=1000                         # Group ID
DOMAIN=example.com                # Primary domain
DOMAIN2=media.example.com         # Media domain
TS_AUTHKEY=tskey-auth-xxx         # Tailscale auth key (legacy; not required for Docktail-only)
```

**rfapps Override Variables:**

```bash
RFAPPS_COMPOSE_PATH=compose.yml
RFAPPS_ENV_FILE=.env.local
RFAPPS_SIDECARS_ENABLED=true
RFAPPS_DEFAULT_PROFILE=all
RFAPPS_HEALTH_TIMEOUT=60
```

## Configuration Files

| File                   | Purpose                             |
| ---------------------- | ----------------------------------- |
| `compose.yml`          | Docker service definitions          |
| `.env.local`           | Environment variables               |
| `rfapps.config.yaml`   | rfapps CLI configuration            |
| `config/traefik/*.yml` | Traefik routing (external services) |

## Workflow Examples

### Update All Services

```bash
rfapps update                 # Preview and save a managed plan
rfapps update --apply --yes   # Apply after review
```

### Update Single Service

```bash
rfapps update -s plex
rfapps update -s plex --apply --yes
```

### Check for Updates

```bash
rfapps plan --check-updates --verbose  # Advisory only
rfapps update                          # Actionable managed preview
```

### Clean Restart

```bash
rfapps stop -s plex --yes
rfapps deploy -s plex --yes
```

### Full Cleanup and Redeploy

```bash
rfapps prune -s plex --volumes --yes
rfapps deploy -s plex --yes
```

### Validate Configuration

```bash
docker compose --profile all config --quiet
rfapps deploy --dry-run
```

## Related Documentation

**Guides:**

- [Getting Started](../guides/getting-started.md) - Initial setup
- [Troubleshooting](../guides/troubleshooting.md) - Problem resolution

**Features:**

- [rfapps CLI Reference](../reference/rfapps-cli-reference.md) - Complete command docs
- [Sidecar Linking](sidecar-linking.md) - Tailscale integration
- [Plan/Apply Workflow](plan-apply-workflow.md) - Preview changes
- [rfapps Plan Intelligence](rfapps-plan-intelligence.md) - `--explain` cause and impact annotations
- [rfapps Update Command](../../packages/rfapps-cli/README.md#update) - Managed image update reference
- [rfapps Native Backup](rfapps-backup.md) - Cold filesystem backup and offline verification
- [rfapps Vulnerability Scanning](rfapps-vulnerability-scanning.md) - `--scan` CVE reporting and the deploy gate
- [rfapps Harden Command](rfapps-harden-command.md) - Compose hardening proposals, overrides, and `--apply`
- [rfapps Tag Selector](rfapps-tag-selector.md) - `--tag` glob semantics, the `tag` command group, and inference
- [Secrets Management](secrets-management.md) - dotenvx/1Password
- [Dry-Run Mode](dry-run-mode.md) - Preview actions
- [JSON Output](json-output.md) - Scripting support
- [Shell Completion](shell-completion.md) - Tab completion
- [rfapps Configuration](rfapps-configuration.md) - CLI config
- [Compose Extensions](docker-compose-extensions.md) - Reusable patterns
- [Compose Profiles](compose-profiles.md) - Service categories
- [Traefik Reverse Proxy](traefik-reverse-proxy.md) - Routing and SSL
- [Authentik Integration](authentik-integration.md) - SSO setup
- [Tailscale Integration](tailscale-integration.md) - VPN access
