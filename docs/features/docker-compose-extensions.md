# Docker Compose Extensions and Profiles

## Overview

The `compose.yml` file uses Docker Compose extensions (`x-` prefix fields) to eliminate repetitive
configuration across 39 services while improving maintainability.

## User Perspective

### What Are Extensions?

Extensions are reusable configuration templates defined at the top of compose.yml. Instead of
repeating the same logging configuration, restart policy, or environment variables across dozens of
services, we define them once and reference them throughout the file.

**Before Extensions:**

```yaml
traefik:
  restart: unless-stopped
  pull_policy: build
  logging:
    driver: json-file
    options:
      max-file: ${DOCKERLOGGING_MAXFILE}
      max-size: ${DOCKERLOGGING_MAXSIZE}
  environment:
    TZ: ${TZ}
    PUID: ${PUID}
    PGID: ${PGID}
```

**After Extensions:**

```yaml
traefik:
  <<: *service-base
  logging: *logging-default
  environment:
    <<: *common-env
```

### What Are Profiles?

Profiles allow you to selectively start groups of services instead of always starting the full
stack. This is useful for:

- **Development**: Start only core infrastructure for testing
- **Resource Management**: Run only media services on a media server
- **Staged Deployments**: Deploy services incrementally
- **Testing**: Validate specific service categories

## Available Extensions

### Universal Extensions

These extensions apply to most or all services:

#### x-logging-default

Standard JSON file logging with rotation:

```yaml
x-logging-default: &logging-default
  driver: json-file
  options:
    max-file: ${DOCKERLOGGING_MAXFILE}
    max-size: ${DOCKERLOGGING_MAXSIZE}
```

**Used by:** All runtime services

#### x-service-base

Standard restart policy and pull behavior:

```yaml
x-service-base: &service-base
  restart: unless-stopped
  pull_policy: build
```

**Used by:** Most application services (sidecars and select utility services use explicit settings)

#### x-common-env

Common environment variables for LinuxServer.io containers:

```yaml
x-common-env: &common-env
  TZ: ${TZ}
  PUID: ${PUID}
  PGID: ${PGID}
```

**Used by:** 30+ application services

#### x-tsdproxy-rfapps

Shared TSDProxy labels so every host is pinned to Tailscale provider `rfapps`. That prevents a
second TSDProxy on the same Docker socket (praxrr-tsdproxy) from registering duplicate machines.

```yaml
x-tsdproxy-rfapps: &tsdproxy-rfapps
  tsdproxy.enable: "true"
  tsdproxy.proxyprovider: "rfapps"
  tsdproxy.ephemeral: "false"
```

**Used by:** `forgejo`, `plex`, `plex-music`, `jellyfin`, `immich-server`

### Tailscale Sidecar Extensions (removed)

The `x-tailscale-sidecar-base`, `x-ts-env-dns-enabled`, and `x-ts-env-dns-disabled` extensions were
removed when media/photo services migrated to Docktail-only tailnet ingress. Tailnet exposure now
uses `docktail.service.*` labels on `traefik` and shareable `tsdproxy.*` hosts (`git`, `plex`,
`plex-music`, `jellyfin`, `images`) pinned with `tsdproxy.proxyprovider: rfapps`.

## Service Profiles

### Available Profiles

| Profile          | Services                                                       | Count | Description              |
| ---------------- | -------------------------------------------------------------- | ----- | ------------------------ |
| `core`           | docktail, traefik, cloudflared, authentik stack                | 9+    | Essential infrastructure |
| `infrastructure` | homarr, uptime-kuma, stirling-pdf, speedtest-tracker           | 4     | Management tools         |
| `downloads`      | sabnzbd, nzbget, slskd, autobrr, unpackerr, prowlarr           | 6     | Download clients         |
| `arr-stack`      | sonarr, radarr, lidarr, bazarr, notifiarr, praxrr, arr-scripts | 7     | Automation services      |
| `media`          | plex, plex-music, tautulli, plexseerr, jellyseerr, kometa      | 6     | Media servers            |
| `photos`         | immich stack                                                   | 4     | Photo management         |
| `all`            | Everything                                                     | 35    | Complete deployment      |

### Using Profiles

**Important:** Running `docker compose up` without a profile will start **nothing** because all
services require a profile.

#### Start All Services

```bash
docker compose --profile all up -d
```

#### Start Specific Category

```bash
# Just core infrastructure
docker compose --profile core up -d

# Media services (requires core)
docker compose --profile core --profile media up -d

# Full media stack
docker compose --profile core --profile infrastructure \
  --profile downloads --profile arr-stack --profile media up -d
```

#### Stop Specific Profile

```bash
docker compose --profile arr-stack down
```

#### View Services in Profile

```bash
docker compose --profile media config --services
```

#### Pull Images for Profile

```bash
docker compose --profile photos pull
```

#### Validate Configuration

```bash
# Must use --profile for validation
docker compose --profile all config --quiet
```

### Integration with rfapps CLI

The `rfapps` CLI automatically uses `--profile all` for all operations:

```bash
# Pull all images
rfapps pull --yes

# Deploy all services
rfapps deploy --yes

# Rebuild all services
rfapps rebuild --yes

# Deploy specific service
rfapps deploy -s plex --yes

# Deploy a service group
rfapps deploy -g media-stack --yes
```

For profile-specific operations, use `docker compose` directly:

```bash
docker compose --profile media pull
docker compose --profile media up -d
```

## Data Flow

### Extension Application Flow

1. **Extension Definition** - Extensions defined at top of compose.yml
2. **Service Definition** - Services reference extensions using merge keys (`<<: *extension-name`)
3. **Compose Parsing** - Docker Compose merges extension values into service definitions
4. **Container Creation** - Containers created with merged configuration

### Profile Selection Flow

1. **Profile Specification** - User specifies `--profile <name>` flag
2. **Service Filtering** - Docker Compose filters services matching the profile
3. **Dependency Resolution** - Dependencies are automatically included
4. **Container Startup** - Only selected services are started

## Files Involved

### Primary Files

- **compose.yml** - Main compose file with extensions and profiles
- **.env.local** - Environment variables referenced by extensions

### Documentation Files

- **docs/plans/compose-refactor/extension-patterns.md** - Detailed pattern analysis
- **docs/plans/compose-refactor/implementation-summary.md** - Implementation status
- **docs/plans/compose-refactor/service-profiles.md** - Profile categorization
- **docs/plans/compose-refactor/quick-reference.md** - Quick command reference
- **docs/plans/compose-refactor/shared.md** - Master implementation plan

## Benefits

### Code Reduction

- **Starting Point:** 1400 lines
- **Final State:** 1155 lines
- **Lines Eliminated:** 245 lines (17.5% reduction)
- **Tailscale Impact:** ~190 lines eliminated (48% reduction per sidecar)

### Maintainability

- **Single Source of Truth** - Change logging config once, applies to all services
- **Consistency** - All services use identical patterns
- **Easier Onboarding** - New developers see patterns immediately
- **Reduced Errors** - Fixed 3 critical typos during refactoring

### Flexibility

- **Selective Deployment** - Start only needed services
- **Resource Management** - Reduce memory/CPU usage in development
- **Testing** - Validate specific service categories
- **Staged Rollouts** - Deploy incrementally by profile

### Reliability

- **Fixed Typos:**
  - TS_USERSPACE: "fasle" → "false" (plex-ts)
  - Volume mount: "/etc/mcahine-id" → "/etc/machine-id"
- **Standardized Configuration** - Prevents future inconsistencies
- **Validated Patterns** - Extensions tested across all services

## Common Use Cases

### Development Environment

Start only core infrastructure for testing:

```bash
docker compose --profile core up -d
```

### Media Server

Deploy complete media stack:

```bash
docker compose --profile core --profile infrastructure \
  --profile downloads --profile arr-stack --profile media up -d
```

### Photo Management Only

Deploy just Immich:

```bash
docker compose --profile core --profile photos up -d
```

### Full Production Deployment

Deploy everything:

```bash
# Using rfapps CLI (recommended)
rfapps deploy --yes

# Or using Docker Compose directly
docker compose --profile all up -d
```

### Adding a New Service

When adding a new service, use existing extensions. Most services should use Docker bridge
networking without a Tailscale sidecar:

**Standard Service (Docker Bridge - Recommended):**

```yaml
new-service:
  <<: *service-base
  profiles:
    - infrastructure
    - all
  container_name: new-service
  hostname: new-service
  networks:
    apps: {}
  logging: *logging-default
  environment:
    <<: *common-env
    # Add service-specific variables
  volumes:
    - ${DOCKER_DIR}/new-service:/config
  image: linuxserver/new-service:latest
```

**Service with tailnet exposure (Docktail labels):**

Services that need direct tailnet access use `docktail.service.*` labels on the `apps` network.
The `x-tailscale-sidecar-*` extensions were removed; see the changelog in the Extensions section
above or [`docs/features/tailscale-integration.md`](tailscale-integration.md) for details.

```yaml
new-service:
  <<: *service-base
  profiles:
    - infrastructure
    - all
  container_name: new-service
  hostname: new-service
  networks:
    apps: {}
  labels:
    docktail.service.new-service.hostname: new-service
    docktail.service.new-service.port: "8080"
  logging: *logging-default
  environment:
    <<: *common-env
    # Add service-specific variables
  volumes:
    - ${DOCKER_DIR}/new-service:/config
  image: linuxserver/new-service:latest
```

## Troubleshooting

### Nothing Starts

**Problem:** Running `docker compose up` starts nothing

**Solution:** Specify a profile:

```bash
docker compose --profile all up -d
```

### Validation Fails

**Problem:** `docker compose config` fails

**Solution:** Use `--profile all` for validation:

```bash
docker compose --profile all config --quiet
```

### Service Not Starting

**Problem:** Specific service doesn't start with profile

**Solution:** Check which profile it belongs to:

```bash
grep -A 2 "container_name: servicename" compose.yml | grep profiles
docker compose --profile <profile-name> up -d
```

### Extension Not Applied

**Problem:** Service doesn't have expected configuration

**Solution:** Verify merge key syntax:

```yaml
# Correct
service:
  <<: *extension-name

# Incorrect (missing colon)
service: << *extension-name
```

## Healthcheck Status

Healthcheck rollout is now part of the active architecture, not a roadmap item:

- Dedicated endpoints are used where verified (for example `sonarr/radarr/lidarr/prowlarr` `/ping`
  and `immich-server` `/api/server/ping`).
- Dependency-critical services in `condition: service_healthy` chains use startup-tolerant timing
  values.
- Docktail-advertised services use standard container healthchecks on the `apps` network.
- Services without verified unauthenticated dedicated routes keep explicit fallback probes with
  inline rationale comments.

## Future Enhancements

### Resource Management (Planned)

Add resource limits and security:

- Memory/CPU limits using 5-tier approach
- Security hardening with `no-new-privileges`
- GPU configuration for Plex and Immich
- Docker socket proxy for enhanced security

## Related Documentation

- [Quick Reference](quick-reference.md) - One-page command reference card
- [Compose Profiles](compose-profiles.md) - Service deployment strategy
- [Tailscale Integration](tailscale-integration.md) - Sidecar pattern architecture
- [Traefik Reverse Proxy](traefik-reverse-proxy.md) - Routing and SSL configuration
- [rfapps CLI Reference](../reference/rfapps-cli-reference.md) - Complete command documentation

## External References

- [Docker Compose Extensions Documentation](https://docs.docker.com/compose/compose-file/11-extension/)
- [Docker Compose Profiles Documentation](https://docs.docker.com/compose/profiles/)
