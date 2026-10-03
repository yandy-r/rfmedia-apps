# rfapps Configuration System

Complete reference for the rfapps CLI configuration system.

## Overview

The rfapps CLI uses a layered YAML configuration system that externalizes service mappings, groups,
and profiles from hardcoded TypeScript constants. This makes the CLI more maintainable and allows
users to customize behavior without modifying code.

## Configuration Search Order

Configuration files are loaded with the following priority (highest priority first):

1. `.rfapps.yaml` / `.rfapps.yml` / `.rfapps.json` in current working directory
2. `~/.config/rfapps/config.yaml` / `.yml` / `.json`
3. `~/.rfapps.yaml` / `.yml` / `.json`
4. `rfapps.config.yaml` in project root (ships with repository, lowest priority)

Later configurations override earlier ones using a merge strategy.

## Configuration File Structure

### Complete Example

```yaml
# Default paths
composePath: compose.yml
envFile: .env.local

# Service-to-sidecar mappings (disabled in shipped rfapps.config.yaml)
sidecars:
  enabled: false
  mapping: {}

# Predefined service groups for batch operations
groups:
  infra-stack:
    - docktail
    - traefik
    - cloudflared
    - homarr
    - uptime-kuma
    - stirling-pdf
    - speedtest-tracker
  download-stack:
    - unpackerr
    - autobrr
    - sabnzbd
    - slskd
    - nzbget
  media-stack:
    - plex
    - kometa
    - tautulli
    - plexseerr
    - jellyseerr
  # ... more groups

# Service-to-profile mappings (Docker Compose profiles)
profiles:
  defaultProfile: all
  validProfiles:
    - core
    - infrastructure
    - downloads
    - arr-stack
    - media
    - photos
    - all
  mapping:
    traefik: core
    authentik-server: core
    plex: media
    sonarr: arr-stack
    # ... more mappings

# Health check configuration
healthCheck:
  timeout: 60
  interval: 5
  retries: 12
  waitForReady: true

# Parallel execution configuration
parallel:
  enabled: false # Enable parallel execution by default
  workers: 4 # Maximum concurrent workers

# Docker configuration
docker:
  sshRetry:
    maxRetries: 3
    delayMs: 2000

# Environment tool configuration
envTool:
  tool: dotenvx # or 'op' or 'none'

# Image vulnerability scanning (opt-in per invocation via plan/deploy --scan)
scan:
  scanner: trivy # trivy | grype
  failOn: none # none | unknown | negligible | low | medium | high | critical
  ignore:
    - id: CVE-2024-56171
      service: plex
      reason: "no upstream fix in the linuxserver image"
      until: "2026-12-31"

# Security hardening rules (`rfapps harden`)
harden:
  includeReview: false
  backup: true
  ignore:
    - rule: harden-memory-limit
      service: plex

# Hierarchical service tags (`--tag`, `rfapps tag`). Optional.
# Service-keyed, mirroring profiles.mapping and sidecars.mapping.
# Store LEAF paths only - ancestors are derived automatically, so a service
# tagged `infrastructure/core/networking` also matches `infrastructure/core`
# and `infrastructure`.
tags:
  mapping:
    traefik:
      - infrastructure/core/networking
      - network/ingress
    authentik-server:
      - infrastructure/core/identity
    plex:
      - media/streaming
      - hardware/gpu
    sonarr:
      - media/automation/tv
    sabnzbd:
      - media/downloads/usenet
```

> **`tags:` replaces; it does not merge.** Every collection in this file is whole-value replacement
> across configuration layers, and `tags.mapping` is no exception. A `tags:` block in
> `.rfapps.yaml`, `~/.config/rfapps/config.yaml`, or `~/.rfapps.yaml` **wholly shadows** the block in
> `rfapps.config.yaml` — adding one personal tag in a local override silently discards the entire
> fleet taxonomy. This is the same rule that already governs `groups`, `lint.ignore`, `scan.ignore`,
> and `harden.ignore`, but it bites harder here because tags are the section an operator would most
> naturally extend incrementally. If you need one extra tag, edit the layer that already owns
> `tags:`; do not start a second one. `rfapps validate` emits a warning whenever more than one layer
> defines `tags:`, and `rfapps tag list` prints the winning layer's absolute path as `Source:`.

Tag paths are lowercase, slash-separated, at most 8 segments, at most 40 characters per segment, and
at most 128 characters overall; each segment starts and ends with `[a-z0-9]` and may otherwise
contain `.`, `_`, and `-`. Values are case-folded on load, which produces a validation warning so the
normalization is visible rather than silent. A malformed path is a configuration error (exit `2`)
raised when the tag index is built.

`tags:` is **not** written by any command. `rfapps tag suggest` prints a paste-ready fragment and
`rfapps init` does not generate the section; there is no `RFAPPS_TAGS` environment override. See
[rfapps Tag Selector](rfapps-tag-selector.md).

### Required Fields

The following fields are **required** in the base configuration (`rfapps.config.yaml`):

- `sidecars.mapping` - Service-to-sidecar mapping
- `groups` - Service group definitions (direct mapping of group name to service list)
- `profiles.mapping` - Service-to-profile mapping
- `profiles.validProfiles` - List of valid profile names

All other fields have sensible defaults.

### Optional Fields

Override these in `.rfapps.yaml` as needed:

- `composePath` - Path to Docker Compose file (default: `compose.yml`)
- `envFile` - Path to environment file (default: `.env.local`)
- `sidecars.enabled` - Enable/disable automatic sidecar linking (default: `true`)
- `profiles.defaultProfile` - Default profile when none specified (default: `all`)
- `healthCheck.*` - Health check timeouts and intervals
- `healthCheck.waitForReady` - Whether deploy/rebuild/apply wait for dependency readiness (default:
  `true`)
- `parallel.enabled` - Enable parallel execution by default for deploy/rebuild (default: `false`)
- `parallel.workers` - Maximum concurrent workers for parallel execution (default: `4`)
- `docker.*` - Docker-specific configuration
- `envTool.*` - Environment variable injection tool settings
- `scan.scanner` - Default backend for `plan --scan` / `deploy --scan` (`trivy` or `grype`; default:
  `trivy`)
- `scan.failOn` - Default gate threshold: `none`, `unknown`, `negligible`, `low`, `medium`, `high`,
  or `critical` (default: `none`, report only)
- `scan.ignore` - Time-boxed CVE suppressions; `reason` is required and an expired `until` stops
  suppressing
- `scan.timeoutMs` / `scan.maxTargets` / `scan.concurrency` - Per-image scanner timeout, cap on
  distinct images scanned per invocation, and concurrent scanner processes
- `harden.includeReview` - Include review-confidence proposals in `rfapps harden` written output
  (default: `false`)
- `harden.backup` - Take a `compose.yml.bak` before `rfapps harden --apply` (default: `true`)
- `harden.rules` - Restrict the harden catalog to specific `harden-*` rule ids
- `harden.ignore` - Rule/service suppressions for `rfapps harden`
- `tags.mapping` - Service-keyed hierarchical tag paths powering `--tag` and `rfapps tag`; leaf paths
  only, since ancestors are derived. **A `tags:` block in any higher layer replaces this one
  wholesale rather than merging into it** — see the warning under
  [Complete Example](#complete-example)

None of these sections has an environment-variable override: there are no `RFAPPS_SCAN_*`,
`RFAPPS_HARDEN_*`, or `RFAPPS_TAGS` variables, by design.

## Generating Configuration

### Using the init Command

Generate a configuration file from your `compose.yml`:

```bash
# Create project-specific config (.rfapps.yaml)
rfapps init

# Create global config (~/.rfapps.yaml)
rfapps init --global

# Preview without writing
rfapps init --dry-run

# Force overwrite existing
rfapps init --force

# Generate JSON instead of YAML
rfapps init --json
```

### Auto-Detection Logic

The `init` command intelligently assigns services to profiles based on naming patterns:

| Pattern                                                                               | Profile          |
| ------------------------------------------------------------------------------------- | ---------------- |
| `traefik`, `authentik*`                                                               | `core`           |
| `uptime-kuma`, `homarr`, `stirlingpdf`, `speedtest-tracker`                           | `infrastructure` |
| `sabnzbd`, `prowlarr`, `nzbget`, `slskd`                                              | `downloads`      |
| `sonarr`, `radarr`, `lidarr`, `bazarr`, `autobrr`, `notifiarr`, `unpackerr`, `praxrr` | `arr-stack`      |
| `plex`, `kometa`, `tautulli`, `plexseerr`, `jellyseerr`, `homarr`                     | `media`          |
| `immich*`                                                                             | `photos`         |
| Everything else                                                                       | `all`            |

Sidecar linking is disabled in the shipped `rfapps.config.yaml` (`sidecars.enabled: false`, empty
mapping). Tailnet ingress uses Docktail labels on `traefik`, `plex`, `jellyfin`, and
`immich-server`.

## Readiness and Compose Healthchecks

`healthCheck.timeout`, `healthCheck.interval`, and `healthCheck.retries` control how long rfapps
waits for dependency readiness after `deploy`, `rebuild`, and `apply`.

Readiness results are driven by:

- Container running state
- Container health status from `compose.yml` healthchecks
- TCP reachability probes for dependency ports

Because compose healthchecks are now more specific (dedicated endpoints where verified, conservative
fallbacks where not), dependency-gated services should fail faster on real startup issues and
produce fewer false-ready states.

Tune `healthCheck.*` only when validation shows legitimate startup regressions (slow hosts, cold
cache/image pulls, first boot migrations).

### Verification Commands

Use these commands after healthcheck updates:

```bash
# Validate compose syntax first
docker compose config --quiet

# One-shot dependency readiness snapshot
rfapps health -g arr-stack --no-wait-for-ready

# Blocking readiness check for a dependency-gated service
rfapps health -s sonarr --wait-for-ready --health-timeout 180

# Deploy with readiness gating enabled (default)
rfapps deploy -g media-stack --yes
```

Expected behavior for dependency-gated services (`condition: service_healthy`): dependents remain
pending until upstreams become healthy; timeout returns actionable dependency failures instead of
silent partial startup.

## Configuration Validation

The CLI automatically validates configuration against `compose.yml` during `deploy` and `build`
operations. Validation results are identical across repeated checks; within a single CLI run the
compose parsing step is cached in-process to avoid redundant work. The cache is automatic and is not
persisted between runs.

### Validation Checks

1. **Service Coverage** - Warns about services in `compose.yml` not defined in config
2. **Orphaned Services** - Warns about services in config not found in `compose.yml`
3. **Sidecar References** - Validates sidecar mappings point to existing services
4. **Group References** - Validates group members exist
5. **Profile Values** - Validates profile assignments use valid profile names

### Example Output

```bash
$ rfapps deploy -s myservice --yes
⚠️  Service 'myservice' found in compose.yml but not defined in config profiles [myservice]
⚠️  Service 'oldservice' defined in config but not found in compose.yml [oldservice]
Deploying services...
```

Validation warnings do not block operations unless they contain errors (e.g., invalid profile
names).

## Customization Examples

### Disable Sidecar Linking

```yaml
# .rfapps.yaml
sidecars:
  enabled: false
```

### Add Custom Service Group

```yaml
# .rfapps.yaml
groups:
  my-custom-stack:
    - service1
    - service2
    - service3
```

### Change Default Profile

```yaml
# .rfapps.yaml
profiles:
  defaultProfile: media
```

### Enable Parallel Execution

```yaml
# .rfapps.yaml
parallel:
  enabled: true # Enable --parallel by default for deploy/rebuild
  workers: 8 # Increase concurrent workers for local Docker
```

The default worker count of 4 is conservative to accommodate SSH-based remote Docker contexts, which
have connection pressure limits. If you run Docker locally, you can safely increase `workers`. If
you use a remote Docker context over SSH, keep the default or lower it to avoid SSH multiplexing
issues.

### Add New Service

When adding a new service to `compose.yml`:

1. Add service to appropriate profile in config:

```yaml
profiles:
  mapping:
    mynewservice: infrastructure
```

2. Add sidecar mapping only if you are running a custom fork with `sidecars.enabled: true` and
   the service truly needs a Tailscale sidecar (not applicable in this repo — sidecars are
   disabled):

```yaml
sidecars:
  mapping:
    mynewservice: mynewservice-ts
```

3. Optionally add to relevant groups:

```yaml
groups:
  infrastructure-stack:
    - mynewservice
    - mynewservice-ts
```

## Environment Variables

Override configuration via environment variables:

| Variable                  | Description                                            |
| ------------------------- | ------------------------------------------------------ |
| `RFAPPS_COMPOSE_PATH`     | Override compose file path                             |
| `RFAPPS_ENV_FILE`         | Override environment file path                         |
| `RFAPPS_ENV_TOOL`         | Override environment tool (`dotenvx`, `op`, `none`)    |
| `RFAPPS_DEFAULT_PROFILE`  | Override default profile                               |
| `RFAPPS_SIDECARS_ENABLED` | Enable/disable sidecar linking (`true`, `false`)       |
| `RFAPPS_HEALTH_TIMEOUT`   | Override health check timeout (seconds)                |
| `RFAPPS_WAIT_FOR_READY`   | Override readiness waiting behavior (`true`, `false`)  |
| `RFAPPS_PARALLEL_ENABLED` | Enable parallel execution by default (`true`, `false`) |
| `RFAPPS_PARALLEL_WORKERS` | Override maximum concurrent workers (number)           |

Example:

```bash
RFAPPS_SIDECARS_ENABLED=false rfapps deploy -s plex --yes
```

## Migration Guide

### From Hardcoded Version

If upgrading from a version with hardcoded service mappings:

1. **Generate Configuration**:

```bash
rfapps init
```

This creates `.rfapps.yaml` from your existing `compose.yml`.

2. **Review and Customize**:

Edit `.rfapps.yaml` to match your setup. The auto-generated config may need adjustments for:

- Custom service groupings
- Non-standard profile assignments
- Service-specific settings

3. **Test**:

```bash
rfapps deploy --dry-run
```

4. **Commit**:

Add `.rfapps.yaml` to version control for team sharing.

### Sharing Configuration

**Project-specific** (`.rfapps.yaml` in repo root):

- Commit to version control
- Shared across team members
- Overrides project defaults

**Global** (`~/.rfapps.yaml`):

- User-specific customizations
- Not committed to version control
- Overrides project and system defaults

## Troubleshooting

### Configuration Not Found

```
Error: Configuration file not found. Please ensure rfapps.config.yaml exists in the project root,
or run 'rfapps init' to create a new configuration file.
```

**Solution**: Run `rfapps init` to generate a configuration file.

### Validation Warnings

```
⚠️  Service 'myservice' found in compose.yml but not defined in config profiles
```

**Solution**: Add the service to your configuration's `profiles.mapping`:

```yaml
profiles:
  mapping:
    myservice: infrastructure # or appropriate profile
```

### Invalid Profile

```
❌ Service 'myservice' has invalid profile: custom [myservice]
```

**Solution**: Either:

1. Use a valid profile (`core`, `infrastructure`, `downloads`, `arr-stack`, `media`, `photos`,
   `all`)
2. Add custom profile to `profiles.validProfiles` (not recommended)

## Best Practices

1. **Use Project Config** - Commit `.rfapps.yaml` to version control for team sharing
2. **Start with Init** - Use `rfapps init` to generate initial configuration
3. **Validate Often** - Check validation warnings during deployments
4. **Keep Synced** - Update config when adding/removing services in `compose.yml`
5. **Document Groups** - Add comments to explain custom service groups
6. **Profile Consistency** - Use standard profiles unless you have a specific reason not to

## Related Documentation

- [Quick Reference](quick-reference.md) - One-page command reference card
- [rfapps CLI Reference](../reference/rfapps-cli-reference.md) - Complete command documentation
- [Sidecar Linking](sidecar-linking.md) - Tailscale sidecar integration
- [Docker Compose Profiles](compose-profiles.md) - Profile system details
- [Docker Compose Extensions](docker-compose-extensions.md) - Reusable service patterns
- [rfapps Tag Selector](rfapps-tag-selector.md) - `tags:` semantics, `--tag` patterns, and inference
- [Getting Started Guide](../guides/getting-started.md) - Initial setup walkthrough
