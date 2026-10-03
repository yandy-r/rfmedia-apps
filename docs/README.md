# RFmedia Apps

## Purpose

This is a Docker-based self-hosting platform that orchestrates 49 containerized applications
including reverse proxy, authentication services, media management, file sharing, and infrastructure
management. The project uses Docker Compose with extensions to manage complex multi-container
deployments with a focus on security and ease of management.

## Documentation Index

### Quick Start

- [Getting Started Guide](guides/getting-started.md) - Complete setup walkthrough for new users
- [Getting Started](#getting-started) - Quick reference on this page
- [Essential Commands](#commands) - Common operations with `rfapps` CLI

### Reference Documentation

- [rfapps CLI Reference](../packages/rfapps-cli/README.md#commands) - Complete command reference for
  the TypeScript CLI
- [rfapps CLI README](../packages/rfapps-cli/README.md) - Package documentation and development
  guide
- [Environment Variables Reference](reference/environment-variables.md) - All configuration
  variables
- [Architecture Diagrams](reference/architecture-diagram.md) - Visual service relationships and data
  flows

### Feature Documentation

**Infrastructure Features:**

- [Traefik Reverse Proxy](features/traefik-reverse-proxy.md) - Reverse proxy configuration with
  Authentik forward authentication
- [Docker Compose Extensions](features/docker-compose-extensions.md) - Reusable configuration
  templates
- [Compose Profiles](features/compose-profiles.md) - Docker Compose profile organization
- [Tailscale Integration](features/tailscale-integration.md) - Secure remote access via Docktail and tsdproxy-rfapps
- [Sidecar Linking](features/sidecar-linking.md) - Optional CLI sidecar expansion (disabled in this repo)

**Application Features:**

- [Authentik Integration](features/authentik-integration.md) - Identity provider setup
- [Homarr Dashboard](features/homarr-dashboard.md) - Service dashboard configuration
- [WatchState Sync](features/watchstate-sync.md) - Jellyfin/Plex play-state and progress sync
- [Home Automation Proxy](features/home-automation-proxy.md) - Home Assistant integration

**CLI Features:**

- [Service Conflict Detection](features/service-conflict-detection.md) - Opt-in, fail-closed deploy
  preflight for Docker-owned port, volume, and network conflicts
- [Managed Image Update Command](../packages/rfapps-cli/README.md#update) - Preview-first image
  updates with reviewed plans, target verification, and exact same-daemon image recovery
- [Plan/Apply Workflow](features/plan-apply-workflow.md) - Terraform-inspired preview and apply
  workflow
- [rfapps Plan Intelligence](features/rfapps-plan-intelligence.md) - Opt-in `--explain` cause
  annotations, dependency impact, and the degradation ladder
- [rfapps Drift Command](features/rfapps-drift-command.md) - Read-only drift detection with explicit
  reconcile/import paths
- [rfapps Reconcile Command](features/rfapps-reconcile-command.md) - Report-first desired-state
  comparison with explicitly authorized, target-only convergence
- [rfapps State Rebuild](features/rfapps-state-rebuild.md) - Report-first reconstruction of the
  state database from Docker runtime, with mandatory backup and atomic replacement
- [rfapps Native Backup](features/rfapps-backup.md) - Cold filesystem backup of Compose bind
  directories and named volumes, with offline integrity verification
- [rfapps Vulnerability Scanning](features/rfapps-vulnerability-scanning.md) - Opt-in `--scan` image
  CVE reporting on `plan` and a fail-closed pre-mutation gate on `deploy`
- [rfapps Harden Command](features/rfapps-harden-command.md) - Non-destructive compose hardening
  proposals, override fragments, and alias-safe `--apply`
- [rfapps Tag Selector](features/rfapps-tag-selector.md) - Hierarchical `--tag` service targeting,
  the read-only `rfapps tag` inspection group, and taxonomy inference
- [Deployment History](features/deployment-history.md) - View deployment history for services
- [Deployment Rollback](features/deployment-rollback.md) - Rollback services to previous deployment
  states
- [Service Healthchecks](features/service-healthchecks.md) - Docker health policy, target
  verification, and dependency readiness
- [Shell Completion](features/shell-completion.md) - Tab completion setup for bash, zsh, and fish
- [JSON Output Mode](features/json-output.md) - Machine-readable output for scripting and automation
- [Dry-Run Mode](features/dry-run-mode.md) - Preview actions without executing
- [Error Handling](features/error-handling.md) - Structured error messages with fuzzy-match "Did you
  mean?" suggestions, actionable suggestions, and machine-readable error output
- [Secrets Management](features/secrets-management.md) - dotenvx and 1Password CLI integration
- [rfapps Configuration](features/rfapps-configuration.md) - CLI configuration options
- [rfapps MCP Server](features/rfapps-mcp-server.md) - MCP stdio server mode, tool catalog, and
  response envelopes

**rfmedia CLI Features:**

- [Config Validation Caching](../packages/rfmedia-cli/docs/features/config-validation-caching.md) -
  In-memory mtime+size cache for config loading to skip repeated file discovery, parsing, and
  validation
- [Plex API Response Caching](../packages/rfmedia-cli/docs/features/plex-api-caching.md) - In-memory
  TTL caching for Plex API responses to reduce redundant HTTP requests
- [Plex Collections](../packages/rfmedia-cli/docs/features/plex-collections.md) - Plex collection
  management and synchronization
- [Plex Configuration](../packages/rfmedia-cli/docs/features/plex-configuration.md) - Plex server
  connection, account enrollment (`plex auth`), credential precedence, migration, and rollback
- [Media Server Adapter](../packages/rfmedia-cli/docs/features/media-server-adapter.md) -
  Provider-neutral adapter boundary, import rules, and the JWT credential lifecycle
- [Metadata Reconciliation](../packages/rfmedia-cli/docs/features/metadata-reconciliation.md) -
  Three-plane metadata report and preview-first repair across file tags, SQLite inventory, and the
  media server
- [Lidarr Search and Lookup](../packages/rfmedia-cli/docs/features/lidarr-search-lookup.md) -
  Read-only combined search, typed lookup, paging, output, and explicit stale fallback
- [Lidarr Similar-Artist Discovery](../packages/rfmedia-cli/docs/features/lidarr-discovery.md) -
  Attributed Last.fm recommendations, zero-Lidarr default path, and one sealed artist-add handoff
- [Lidarr Consumption Policy](../packages/rfmedia-cli/docs/features/lidarr-consumption-policy.md) -
  Read-only evaluation, review-first proposal planning, explicit artifact sealing, and the separate
  checksum-pinned apply boundary
- [Lidarr Quality Presets](../packages/rfmedia-cli/docs/features/lidarr-quality-presets.md) -
  Versioned preset discovery, semantic diff, guarded apply, and recovery
- [Lidarr Mutation Plan/Apply](../packages/rfmedia-cli/docs/features/lidarr-plan-apply.md) - Sealed
  mutation artifacts, approval gates, verification, and recovery
- [Lidarr Execution Lanes](../packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md) -
  Scheduling, retry, cancellation, and execution metadata contracts
- [Lidarr Generated Client](../packages/rfmedia-cli/docs/features/lidarr-generated-client.md) -
  Private SDK ownership, offline regeneration, provenance, and review workflow
- [Lidarr Library Health Audit](../packages/rfmedia-cli/docs/features/lidarr-audit.md) - Read-only
  drift, resilience, and coverage checks with an opt-in `--fail-on` CI gate

### Guides

- [Getting Started Guide](guides/getting-started.md) - Complete setup walkthrough for new users
- [Backup and Restore Guide](guides/backup-restore.md) - Backup strategies, procedures, and disaster
  recovery
- [Troubleshooting Guide](guides/troubleshooting.md) - Common issues and recovery procedures
  (enhanced with service-specific debugging)

### Service Setup Guides

Detailed setup instructions for individual services:

- [Traefik Setup](services/traefik-setup.md) - Reverse proxy with SSL, routing, and Authentik
  middleware
- [Authentik Setup](services/authentik-setup.md) - Identity provider with SSO, MFA, and user
  management
- [Plex Setup](services/plex-setup.md) - Media server with hardware transcoding and companion
  services
- [Arr Stack Setup](services/arr-stack-setup.md) - Sonarr, Radarr, Prowlarr, Bazarr, and download
  automation
- [Immich Setup](services/immich-setup.md) - Photo management with ML, mobile apps, and backup
  procedures
- [Forgejo Setup](services/forgejo-setup.md) - Self-hosted Git forge with SSH, DNS, and first-run
  configuration
- [tokenhop Setup](services/tokenhop-setup.md) - AI gateway with native login, API keys, and Traefik
  HTTPS routing

## Architecture

### Directory Structure

All services are managed from the root `compose.yml` file. Configuration files are stored in
subdirectories under `${DOCKER_DIR}` as defined in `.env`.

### Service Overview

The platform manages 50 services across 6 categories:

| Category       | Services | Description                                                               |
| -------------- | -------- | ------------------------------------------------------------------------- |
| Core           | 8        | Essential infrastructure (Traefik, Authentik)                             |
| Infrastructure | 16       | Management tools (Homarr, Uptime Kuma, tokenhop, Stirling PDF, Forgejo)   |
| Downloads      | 6        | Download clients and helpers                                              |
| Arr-Stack      | 7        | Media automation (Sonarr, Radarr, Bazarr, Lidarr)                         |
| Media          | 9        | Media servers (Plex, Tautulli, Plexseerr, Jellyseerr, Kometa, WatchState) |
| Photos         | 4        | Photo management (Immich)                                                 |

### Currently Active Services

**Infrastructure & Routing:**

- **Traefik** - Primary reverse proxy with automatic SSL and Authentik forward authentication
- **Authentik** - Identity provider and authentication system
- **Uptime Kuma** - Uptime monitoring
- **Homarr** - Customizable dashboard and homepage
- **Stirling PDF** - PDF manipulation tool
- **Speedtest Tracker** - Network speed monitoring
- **Forgejo** - Self-hosted Git forge with native authentication
- **tokenhop** - AI gateway with native login and API-key authentication
- **Headroom** - Context compression proxy used internally by tokenhop

**Media & Content:**

- **Plex** - Media server with hardware transcoding
- **Plexseerr** / **Jellyseerr** - Media request management (Seerr per media server)
- **Tautulli** - Plex analytics and monitoring
- **Kometa** - Plex metadata and collection management
- **WatchState** - Jellyfin/Plex play-state and progress sync

**Download & Automation:**

- **SABnzbd** - Usenet download client
- **NZBGet** - Alternative Usenet client
- **Prowlarr** - Indexer manager
- **Autobrr** - IRC announce automation
- **Unpackerr** - Archive extraction
- **slskd** - P2P file sharing
- **Sonarr** / **Radarr** / **Lidarr** / **Bazarr** - TV, movie, music, and subtitle management

**Productivity & Storage:**

- **Immich** - Self-hosted photo and video management

See [Architecture Diagrams](reference/architecture-diagram.md) for visual representations of service
relationships.

## Reverse Proxy

The platform uses **Traefik** as the primary reverse proxy. Most browser applications use Authentik
forward authentication, while services such as tokenhop and Forgejo retain native authentication for
their API and protocol clients. Traefik automatically manages SSL certificates via Let's Encrypt and
provides host-based routing.

### Key Features

- Automatic SSL certificate generation and renewal via Let's Encrypt
- Host-based routing for all services
- Two authentication middlewares:
  - `authentik-dev` - For infrastructure services (DOMAIN)
  - `authentik-media` - For media services (DOMAIN2)
- Explicit native-authentication routes, including tokenhop, omit Authentik middleware
- Tailscale integration for secure remote access to the Traefik entry point

See [Traefik Reverse Proxy](features/traefik-reverse-proxy.md) for complete configuration details.

## Environment Variables

Every service requires certain environment variables. All services require `$DOCKER_DIR` which is
where configuration files are stored (e.g., `/home/[user]/docker`). This is separate from
`$DATA_DIR` where actual data/media files are stored.

### Key Environment Variables

Docker Compose automatically reads a `.env` file from the same directory. Create this file and set
appropriate permissions (`chmod 600 .env`).

| Name              | Purpose                                    |
| ----------------- | ------------------------------------------ |
| `TZ`              | Timezone (e.g., America/New_York)          |
| `PUID`            | User ID for file ownership                 |
| `PGID`            | Group ID for file ownership                |
| `DOCKER_DIR`      | Configuration files location               |
| `DOCKER_DATA_DIR` | Data storage location                      |
| `DATA_DIR`        | Media files location                       |
| `DOMAIN`          | Primary domain for infrastructure services |
| `DOMAIN2`         | Secondary domain for media services        |
| `TS_AUTHKEY`      | Tailscale authentication key               |
| `TS_DOMAIN`       | Tailscale MagicDNS domain                  |

See [Environment Variables Reference](reference/environment-variables.md) for the complete list of
all configuration variables.

## Getting Started

### Prerequisites

1. Docker and Docker Compose installed
2. 1Password CLI (`op`) or dotenvx for secret management
3. Proper environment variables configured
4. Tailscale authentication key (for remote access)

### Setup Steps

1. **Clone the repository** (via Tailscale network):

   ```bash
   # HTTPS
   git clone https://github.com/yandy-r/rfmedia-apps.git

   # Or SSH
   git clone git@github.com:yandy-r/rfmedia-apps.git

   cd rfmedia-apps
   ```

   > Replace `${TS_DOMAIN}` with your Tailscale domain (e.g., `tailnet-name.ts.net`).

2. **Copy and configure environment file**:

   ```bash
   cp .env.example .env.local
   chmod 600 .env.local
   # Edit .env.local with your specific values
   ```

3. **Install the rfapps CLI** (optional but recommended):

   ```bash
   # From the monorepo root
   npm run link:rfapps

   # Verify installation
   rfapps --help
   ```

4. **Deploy the services**:

   ```bash
   # Deploy all services
   rfapps deploy --yes

   # Or deploy specific service
   rfapps deploy -s uptime-kuma --yes
   ```

5. **Check service status**:

   ```bash
   rfapps status --all
   ```

## SSL Certificates

SSL certificates are managed through:

1. **Traefik** - Automatic Let's Encrypt certificates via Cloudflare DNS challenge
2. **Tailscale** - Automatic HTTPS certificates for Tailscale hostnames

### Accessing Services

- **Traefik Dashboard**: `https://traefik.${DOMAIN}`
- **Authentik**: `https://authentik.${DOMAIN}`
- **Uptime Kuma**: `https://uptime.${TS_DOMAIN}`
- **Homarr**: `https://homarr.${TS_DOMAIN}`
- **Stirling PDF**: `https://pdf.${TS_DOMAIN}`
- **Speedtest Tracker**: `https://speedtest.${TS_DOMAIN}`

## Commands

### rfapps CLI

The project uses `rfapps` (TypeScript CLI) for all Docker operations:

| Command                | Description                                  | Confirmation |
| ---------------------- | -------------------------------------------- | ------------ |
| `rfapps pull`          | Pull latest Docker images                    | Yes          |
| `rfapps build`         | Pull images and build containers             | Yes          |
| `rfapps deploy`        | Start services with health checks            | Yes          |
| `rfapps stop`          | Stop services without removing               | Yes          |
| `rfapps rebuild`       | Stop, rebuild, and restart services          | Yes          |
| `rfapps delete`        | Stop and remove services with cleanup        | Yes          |
| `rfapps prune`         | Stop, remove containers, and delete images   | Yes          |
| `rfapps status`        | Show service status                          | No           |
| `rfapps update`        | Preview or apply a reviewed managed update   | Apply only   |
| `rfapps reconcile`     | Report drift or converge reviewed targets    | Apply only   |
| `rfapps state rebuild` | Reconstruct the state DB from Docker runtime | Rewrite only |
| `rfapps backup`        | Create or verify cold filesystem bundles     | Create only  |
| `rfapps harden`        | Propose or apply compose security hardening  | Apply only   |

**Note:** Use `--yes` or `-y` to skip confirmation prompts.

`rfapps update` is operator-invoked and sequential; it does not schedule unattended updates.
Recovery is image-only under the current Compose configuration and does not restore volumes,
application data, databases, or migrations. See the
[`update` command reference](../packages/rfapps-cli/README.md#update),
[plan/apply workflow](features/plan-apply-workflow.md),
[deployment history](features/deployment-history.md),
[rollback](features/deployment-rollback.md), [healthchecks](features/service-healthchecks.md),
[JSON output](features/json-output.md), [error handling](features/error-handling.md), and
[secrets management](features/secrets-management.md) guides.

`rfapps reconcile` reports deterministic desired-versus-actual actions without mutation by
default. See the [`reconcile` command reference](../packages/rfapps-cli/README.md#reconcile) and
[reconciliation guide](features/rfapps-reconcile-command.md) for explicit `--auto-apply`
authorization and target-only safety boundaries.

`rfapps backup` creates private manifest-last bundles after quiescing detected writers across the
resolved Compose project. `rfapps backup verify <manifest>` is offline, read-only, and requires
neither config nor Docker. See [rfapps Native Backup](features/rfapps-backup.md) for selection,
helper, integrity, output, and manual restore contracts. Use database-native dumps alongside it
when application-level consistency is required.

### Quick Examples

```bash
# Deploy all services
rfapps deploy --yes

# Deploy specific service
rfapps deploy -s uptime-kuma --yes

# Deploy multiple services
rfapps deploy --services sonarr,radarr,bazarr --yes

# Rebuild a service
rfapps rebuild -s plex --yes

# Preview and save a managed image-update plan
rfapps update -s plex --out .rfapps/plans/plex-update.json

# Apply the reviewed managed plan
rfapps update --from-plan .rfapps/plans/plex-update.json --apply --yes

# Report desired-versus-actual service state without mutation
rfapps reconcile -g media-stack

# Apply reviewed target-only reconciliation actions
rfapps reconcile -s plex --auto-apply --yes

# Create a cold filesystem backup after reviewing one service's plan
rfapps backup -s plex --destination /mnt/backups

# Verify a published bundle without config or Docker
rfapps backup verify /mnt/backups/<bundle>/manifest.json

# Check status with all details
rfapps status --all

# Stop all services
rfapps stop --yes
```

### Environment Selection

```bash
rfapps deploy -e .env.local --yes   # Uses .env.local (default)
rfapps deploy -e .env.dev --yes     # Uses .env.dev
rfapps deploy -e .env.staging --yes # Uses .env.staging
rfapps deploy -e .env.prod --yes    # Uses .env.prod
```

### npm Scripts

The project also provides npm scripts for convenient Docker operations:

```bash
# Basic operations
npm run apps:deploy         # Deploy all services
npm run apps:start          # Alias for deploy
npm run apps:stop           # Stop all services
npm run apps:rebuild        # Rebuild all services
npm run apps:status         # Show service status
npm run apps:pull           # Pull latest images
npm run apps:build          # Build containers
npm run apps:delete         # Delete services
npm run apps:prune          # Prune services and images
```

See the [rfapps CLI README](../packages/rfapps-cli/README.md) for complete usage documentation.

### Common Options

The `rfapps` CLI supports various options for customization:

```bash
# Skip image pulling for faster startup
rfapps deploy --skip-pull --yes

# Dry run mode (preview without execution)
rfapps deploy --dry-run

# Verbose output with detailed progress
rfapps deploy -v --yes

# Debug mode for troubleshooting
rfapps deploy --debug --yes

# JSON output for scripting
rfapps status --json
```

**Key Command Options:**

| Option             | Short | Description                                             |
| ------------------ | ----- | ------------------------------------------------------- |
| `--yes`            | `-y`  | Skip confirmation prompts                               |
| `--verbose`        | `-v`  | Show detailed output                                    |
| `--dry-run`        |       | Preview actions without executing                       |
| `--debug`          |       | Enable debug output                                     |
| `--json`           |       | Output in JSON format                                   |
| `--service`        | `-s`  | Target a specific service                               |
| `--services`       |       | Target multiple services                                |
| `--group`          | `-g`  | Target a service group                                  |
| `--profile`        | `-p`  | Target a Docker Compose profile                         |
| `--env-file`       | `-e`  | Use custom environment file                             |
| `--compose`        | `-f`  | Use custom Docker Compose file                          |
| `--skip-pull`      |       | Skip image pull phase                                   |
| `--force-recreate` |       | Force recreate containers                               |
| `--no-sidecars`    |       | Disable sidecar linking (when `sidecars.enabled: true`) |
| `--use-dotenvx`    |       | Use dotenvx for secrets injection                       |
| `--use-op`         |       | Use 1Password CLI for secrets                           |

See [rfapps CLI Documentation](../packages/rfapps-cli/README.md) for complete options.

### Docker Compose Operations

For direct Docker Compose access:

```bash
# Start all services with 1Password integration
op run --env-file .env -- docker compose up -d --remove-orphans

# Or with dotenvx
dotenvx run -f .env.local -- docker compose up -d

# Stop all services
docker compose down --remove-orphans

# View logs
docker compose logs -f [service_name]

# Start specific service
docker compose up -d [service_name]
```

## Authentication with Authentik

Authentik provides identity and access management for the platform. It supports:

- Single Sign-On (SSO)
- Multi-Factor Authentication (MFA)
- LDAP/Active Directory integration
- OAuth2 and SAML providers
- Forward authentication proxy for Traefik

### Initial Setup

1. Access Authentik web interface at `https://authentik.${DOMAIN}`
2. Complete initial configuration (admin account)
3. Configure authentication providers
4. Set up user groups and permissions
5. Create outposts for forward authentication

See [Authentik Integration](features/authentik-integration.md) for detailed configuration.

## Network Configuration

- Custom bridge network `apps` (172.21.0.0/24)
- Static IP assignments for database services
- MTU set to 8000 for performance
- Tailscale overlay network for remote access

### Tailscale Integration

Most services use standard Docker bridge networking via the `apps` network. Tailnet ingress uses
**Docktail** for Tailscale Services and **tsdproxy-rfapps** for shareable hosts:

| Compose service | Tailnet exposure    | Purpose                   |
| --------------- | ------------------- | ------------------------- |
| `traefik`       | Docktail `traefik`  | Reverse proxy entry point |
| `plex`          | Docktail `plex`     | Direct Plex streaming     |
| `jellyfin`      | Docktail `jellyfin` | Direct Jellyfin streaming |
| `immich-server` | Docktail `images`   | Direct Immich access      |
| `uptime-kuma`   | Docktail `uptime`   | Monitoring dashboard      |
| `forgejo`       | tsdproxy host `git` | Git hosting (HTTPS + SSH) |

Docktail labels define Tailscale Service exposure; Forgejo uses tsdproxy host labels instead so the
`git` machine can be shared across tailnets. There are no `*-ts` sidecar containers.

See [Tailscale Integration](features/tailscale-integration.md) for complete architecture details.

## Monitoring & Updates

- **Pullio** integration for automatic container updates
- **Notifiarr** webhook notifications
- JSON file logging with configurable rotation
- Health checks for critical services

## Service Dependencies

Services with database backends use `depends_on` declarations:

| Service       | Database                                   | Tailnet exposure   |
| ------------- | ------------------------------------------ | ------------------ |
| immich-server | immich-postgres (PostgreSQL), immich-redis | Docktail `images`  |
| traefik       | -                                          | Docktail `traefik` |
| plex          | -                                          | Docktail `plex`    |

## Security Notes

- All services run as non-root users (PUID/PGID)
- SSL certificates managed automatically via Traefik and Tailscale
- Secrets managed via dotenvx encryption or 1Password integration
- Environment files should have restricted permissions (`chmod 600`)
- Tailscale provides zero-trust network access
- Forward authentication via Authentik for supported web services; documented native-authentication
  exceptions remain outside the middleware
- Native backup bundles contain sensitive topology and application data; their SHA-256 checks byte
  integrity, not authenticity, encryption, or signing

## Troubleshooting

For common issues and recovery procedures, see the
[Troubleshooting Guide](guides/troubleshooting.md).

### Quick Diagnostics

```bash
# Check overall status
rfapps status --all

# View service logs
docker compose logs -f [service_name]

# Check health of services
rfapps status --health

# Enable verbose/debug mode
rfapps deploy -v --yes
rfapps deploy --debug --yes
```
