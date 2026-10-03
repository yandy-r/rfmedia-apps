# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Docker-based self-hosting platform orchestrating 26+ containerized applications across multiple categories:

- **Infrastructure**: Reverse proxy (Traefik), authentication (Authentik)
- **Media Management**: Plex, Sonarr, Radarr, Bazarr, Overseerr, Tautulli
- **Download Clients**: SABnzbd, autobrr, Prowlarr
- **Utilities**: Uptime Kuma, Stirling PDF, Speedtest Tracker
- **Networking**: Docktail tailnet ingress, tsdproxy-rfapps (Forgejo, Plex, Jellyfin, Immich), FlareSolverr

**Note**: NPM (Nginx Proxy Manager) is deprecated in favor of Traefik with Authentik forward authentication.

All services are managed from a single `compose.yml` with the `rfapps` CLI.

## Essential Commands

### rfapps CLI (Primary Tool)

The project uses `rfapps`, a TypeScript CLI for Docker orchestration. This is the primary tool for managing all services.

**Available Commands:**

- `rfapps status` - Show status of Docker services
- `rfapps pull` - Pull Docker images
- `rfapps build` - Build containers (pull + build, use `--skip-pull` to skip pull phase)
- `rfapps deploy` - Deploy services (pull + start)
- `rfapps stop` - Stop services
- `rfapps rebuild` - Rebuild services (stop + build + start)
- `rfapps delete` - Delete services (stop + remove, optional `--volumes` and `--images`)
- `rfapps prune` - Prune services with smart image removal (stop + remove + delete images)
- `rfapps plan` - Generate deployment plan showing what will change (Terraform-inspired)
- `rfapps apply` - Apply a saved deployment plan
- `rfapps completion` - Generate shell completions

**Common Options:**

- `-s, --service <name>` - Target a specific service
- `--services <names>` - Target multiple services (comma-separated)
- `-g, --group <name>` - Target a service group
- `--no-sidecars` - Disable automatic sidecar linking
- `-f, --compose <path>` - Path to Docker Compose file
- `-e, --env-file <path>` - Path to environment file
- `-p, --profile <name>` - Docker Compose profile to use
- `--dry-run` - Preview actions without executing
- `--debug` - Enable debug output
- `--json` - Output in JSON format
- `-v, --verbose` - Show detailed output
- `-y, --yes` - Skip confirmation prompts
- `--check-updates` - Check registry for newer image versions (plan command only)
- `--explain` - Annotate changes with likely cause and dependency impact (plan command only)

**Secrets Injection:**

- `--use-dotenvx <file>` - Use dotenvx for secrets injection
- `--use-op <file>` - Use 1Password CLI for secrets injection

**Quick Start Examples:**

```bash
# Deploy all services
rfapps deploy --yes

# Deploy with specific environment file
rfapps deploy -e .env.local --yes

# Rebuild a specific service
rfapps rebuild -s traefik --yes

# Rebuild a service group
rfapps rebuild -g media-stack --yes

# Deploy with 1Password secrets
rfapps deploy --use-op .env --yes

# Dry-run to preview actions
rfapps deploy -s plex --dry-run
```

**Installation:**

```bash
# Link CLI globally from monorepo root
npm run link:rfapps

# Then use directly
rfapps build -s traefik --yes
```

See `packages/rfapps-cli/README.md` for complete documentation.

### npm Scripts

The project provides npm scripts that wrap the rfapps CLI for convenience:

**Basic Operations:**

- `npm run apps:status` - Show status of services
- `npm run apps:pull` - Pull latest images
- `npm run apps:build` - Build containers
- `npm run apps:deploy` or `npm run apps:start` - Deploy services
- `npm run apps:stop` - Stop services
- `npm run apps:rebuild` - Rebuild services
- `npm run apps:delete` - Delete services
- `npm run apps:prune` - Prune services

**Direct rfapps Access:**

For service-specific operations or additional options, use rfapps directly:

```bash
# Via npm run (development mode, no build required)
npm run rfapps -- deploy -s traefik --yes

# Via linked CLI (requires npm run link:rfapps first)
rfapps deploy -s traefik --yes
```

### Docker Compose Operations

```bash
# Start all services with 1Password integration
op run --env-file .env -- docker compose up -d --remove-orphans

# Stop all services
docker compose down --remove-orphans

# View logs
docker compose logs -f [service_name]

# Start specific service
docker compose up -d [service_name]
```

## Architecture

### Directory Structure

All services are now managed from the root `compose.yml` file. Configuration files are stored in subdirectories under `${DOCKER_DIR}` as defined in `.env`.

### Docker Compose Extensions and Profiles

The project uses Docker Compose extensions to eliminate repetitive configuration across 47 services, reducing the compose file from 1400 to 1155 lines (17.5% reduction).

**Universal Extensions:**

- `x-logging-default` - Standard JSON file logging with rotation (all 47 services)
- `x-service-base` - Standard restart policy and pull behavior (43 application services)
- `x-common-env` - Common TZ/PUID/PGID environment variables (30+ services)

**Docktail Labels:**

Services requiring tailnet exposure as Tailscale Services use `docktail.service.*` labels on the
`apps` network (see `traefik` in `compose.yml`).

**tsdproxy-rfapps Labels:**

Shareable Tailscale **host** ingress via `tsdproxy.*` labels discovered by `tsdproxy-rfapps`.
Every labeled container must set `tsdproxy.proxyprovider: rfapps` (compose extension
`*tsdproxy-rfapps`) so praxrr-tsdproxy on the same Docker socket does not register duplicate
machines (`git` / `git-1`).

Forgejo (`git`), both Plex instances (`plex`, `plex-music`), Jellyfin, and Immich (`images`).
Config/state: `${DOCKER_DIR}/tsdproxy-rfapps/` (`data/rfapps/<hostname>/`).

**Service Profiles:**

All services require a profile to start. Available profiles:

- `core` - Essential infrastructure (traefik, authentik) - 9 services
- `infrastructure` - Management tools (core + uptime-kuma, homarr, stirlingpdf) - 15 services
- `downloads` - Download clients (sabnzbd, prowlarr) - 4 services
- `arr-stack` - Automation services (sonarr, radarr, bazarr, etc.) - 12 services
- `media` - Media servers (plex, plex-music, tautulli, plexseerr, jellyseerr, etc.)
- `photos` - Photo management (immich) - 5 services
- `all` - Complete deployment - 47 services

**Important:** Running `docker compose up` without `--profile` starts **nothing**. Always specify a profile:

```bash
# Start all services
docker compose --profile all up -d

# Start specific category
docker compose --profile core --profile media up -d

# Validate configuration
docker compose --profile all config --quiet
```

See `docs/features/compose-extensions.md` for complete documentation.

### Service Categories

The `compose.yml` defines 26+ services across these categories:

**Infrastructure & Management:**

- `docktail` - Tailnet ingress via Tailscale Services (advertises Traefik)
- `tsdproxy-rfapps` - Shareable Tailscale hosts (Forgejo as `git`, Plex as `plex` / `plex-music`)
- `traefik` - Traefik reverse proxy on `apps` network
- `uptime-kuma` - Uptime monitoring
- `homarr` - Customizable dashboard and homepage for self-hosted services
- `stirlingpdf` - PDF manipulation tool

**Authentication & Identity:**

- `authentik-server` - Identity provider (uses Docker bridge network)
- `authentik-worker` - Authentik background worker
- `authentik-db` (PostgreSQL) + `authentik-redis` - Authentik dependencies
- `authentik-media` - Media authentication outpost

**Media Services:**

- `plex` - Primary media server on `apps` with tsdproxy host `plex` (GPU passthrough)
- `plex-music` - Music-only Plex instance on `apps` with tsdproxy host `plex-music` (GPU passthrough)
- `jellyfin` - Jellyfin on `apps` with tsdproxy host `jellyfin`
- `sonarr` - TV show management
- `radarr` - Movie management
- `bazarr` - Subtitle management
- `plexseerr` - Plex media request management (Seerr)
- `jellyseerr` - Jellyfin media request management (Seerr)
- `tautulli` - Plex analytics
- `kometa` - Plex metadata management

**Download & Indexing:**

- `sabnzbd` - Usenet downloader
- `prowlarr` - Indexer manager
- `autobrr` - IRC announce automation
- `notifiarr` - Notification integration
- `unpackerr` - Archive extraction

**Utilities:**

- `stirling-pdf` - PDF manipulation tool
- `speedtest-tracker` - Network speed monitoring

### Network Architecture

- Custom bridge network `apps` for inter-service communication
- **Traefik Reverse Proxy** - Primary routing layer with Authentik forward authentication
  - Host-based routing for all services
  - Automatic SSL via Let's Encrypt
  - Two authentication middlewares: `authentik-dev` (infrastructure) and `authentik-media` (media services)
  - Middlewares reference services by Docker container name (e.g., `authentik-server:9443`)
  - See `docs/features/traefik-reverse-proxy.md` for complete Traefik architecture details
- **Tailscale Integration** - Dual ingress: Docktail for Tailscale Services, tsdproxy-rfapps for shareable hosts
  - Docktail advertises Traefik and labeled services over the tailnet
  - Forgejo: shareable host `git` via tsdproxy-rfapps (HTTPS + Git SSH)
  - Plex: shareable hosts `plex` and `plex-music` via tsdproxy-rfapps
  - Jellyfin / Immich: shareable hosts `jellyfin` and `images` via tsdproxy-rfapps
  - See `docs/features/tailscale-integration.md` for complete Tailscale architecture details

### Environment Management

- All services use a single `.env` file in the root directory
- Environment variables include database credentials, domain settings, and API keys
- 1Password integration via `op run` command for secret management

### Config File Secrets Injection

Both CLI tools support template-based secrets injection in their configuration files using `{{ VAR_NAME }}` syntax. Templates are resolved at config load time from environment variables.

**Supported Files:**

- `.rfmedia.yaml` - rfmedia-cli configuration (Plex filters, media management)
- `.rfapps.yaml` - rfapps-cli configuration (Docker service management)

**Template Syntax:**

```yaml
# Use {{ VAR_NAME }} for secret values
plex:
  url: https://plex.example.com
  token: "{{ PLEX_TOKEN }}"
```

**Common Template Variables:**

| Variable     | Description               | Used In         |
| ------------ | ------------------------- | --------------- |
| `PLEX_TOKEN` | Plex authentication token | `.rfmedia.yaml` |
| `PLEX_URL`   | Plex server URL           | `.rfmedia.yaml` |

**Alternative for Plex:** `PLEX_TOKEN` can be skipped entirely by enrolling the device with
`rfmedia plex auth login`. The credential is then held in an out-of-band `0600` store
(`~/.config/rfmedia/plex-auth/store.json`, relocatable with the `RFMEDIA_PLEX_AUTH_DIR` environment
variable), never in a config file, so it is not `{{ VAR }}`-templated and needs no secrets
injection. See `packages/rfmedia-cli/docs/features/plex-configuration.md`.

**Integration with Secrets Tools:**

Templates work seamlessly with the existing secrets injection options:

```bash
# Environment variables populated by dotenvx
rfapps deploy --use-dotenvx .env --yes

# Environment variables populated by 1Password CLI
rfapps deploy --use-op .env --yes

# Direct environment variables (e.g., from shell or CI/CD)
PLEX_TOKEN=xxx rfmedia filter --list movies
```

**Error Handling:**

- Missing environment variables throw `SecretsInjectionError` immediately
- Empty string values are valid (not treated as missing)
- Config files without templates work unchanged (backward compatible)

**Security Notes:**

- Never commit config files with resolved secrets
- Use `rfmedia.example.yaml` as a template for new environments
- Template variable names are logged for debugging; values are never logged

### Key Environment Variables

- `DOCKER_DIR` - Configuration files location
- `DOCKER_DATA_DIR` - Data storage location
- `DATA_DIR` - Media files location
- `TZ` - Timezone setting
- `PUID`/`PGID` - User/group IDs for file permissions
- `DOMAIN` - Primary domain for infrastructure services (Traefik routing)
- `DOMAIN2` - Secondary domain for media services (Traefik routing)
- `SAN_DOMAIN` / `SAN_DOMAIN2` - Subject Alternative Names for SSL certificates
- `TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET` - Docktail OAuth credentials
- `TS_DOMAIN` - Tailscale MagicDNS domain for client URLs
- `TS_AUTHKEY` - Legacy (former sidecar auth key; not required for Docktail-only deployment)

### Service Dependencies

Services with database backends use `depends_on` declarations:

- `authentik-server` → `authentik-db` (PostgreSQL), `authentik-redis`
- `authentik-worker` → `authentik-db` (PostgreSQL), `authentik-redis`
- `authentik-media` → `authentik-server`, `authentik-db`, `authentik-redis`
- `immich-server` → `immich-postgres`, `immich-redis`, `immich-ml`

### Monitoring & Updates

- Pullio integration for automatic container updates
- Notifiarr webhook notifications
- JSON file logging with configurable rotation

## Development Notes

When working with this codebase:

- Services use LinuxServer.io and official Docker images
- Configuration files are mounted from `${DOCKER_DIR}/[service]`
- Tailnet exposure uses Docktail labels on `apps` network services
- Data persistence handled through bind mounts
- Most services run as non-root users (PUID/PGID)
- SSL certificates managed via Certbot with Cloudflare DNS challenge
- Tailscale integration requires Docktail OAuth credentials (`TAILSCALE_OAUTH_CLIENT_*`)
- Use markdownlint guidelines for all markdown files
- All markdown headings should be surrounded by a newline

### Modifying Services

When adding or modifying services in `compose.yml`:

1. **Use Docker Compose extensions** - See `docs/features/compose-extensions.md`:
   - Apply `<<: *service-base` for restart policy and pull behavior
   - Apply `logging: *logging-default` for standard logging
   - Apply `<<: *common-env` in environment section for TZ/PUID/PGID
   - For tailnet exposure, add `docktail.service.*` labels (see step 6 below)
2. **Assign service profiles** - Add to appropriate profile(s):
   - `core` - Essential infrastructure (traefik, authentik)
   - `infrastructure` - Management tools
   - `downloads` - Download clients
   - `arr-stack` - Automation services
   - `media` - Media servers
   - `photos` - Photo management
   - `all` - Always include in all profile
3. Mount configuration to `${DOCKER_DIR}/[service-name]`
4. Mount data to `${DOCKER_DATA_DIR}/[service-name]` or `${DATA_DIR}` for media
5. Use `apps` network with explicit `hostname` for most services
6. **For tailnet exposure** - See `docs/features/tailscale-integration.md`:
   - Use `apps` network with explicit `hostname`
   - Add `docktail.service.*` labels (mirror `traefik`)
   - For shareable hosts, use `<<: *tsdproxy-rfapps` labels and deploy `tsdproxy-rfapps`
7. **Add Traefik labels for web services** - See `docs/features/traefik-reverse-proxy.md` for label patterns:
   - Enable Traefik routing
   - Configure HTTPS with Let's Encrypt
   - Apply appropriate Authentik middleware (`authentik-dev` or `authentik-media`)
   - Define backend service port and scheme

### Sidecar Linking (CLI — inactive in this repo)

Sidecar linking is disabled (`sidecars.enabled: false` in `rfapps.config.yaml`). The CLI feature
remains for custom deployments; `--no-sidecars` is still supported.

```bash
rfapps rebuild -s plex --yes
rfapps deploy -g infra-stack --yes
```

| Group            | Services                                                               |
| ---------------- | ---------------------------------------------------------------------- |
| `vpn-stack`      | slskd                                                                  |
| `download-stack` | unpackerr, autobrr, sabnzbd, slskd, nzbget                             |
| `arr-stack`      | sonarr, radarr, lidarr, bazarr, prowlarr                               |
| `media-stack`    | plex, plex-music, jellyfin, sonarr, radarr, lidarr, bazarr, watchstate |
| `auth-stack`     | all authentik services                                                 |
| `immich-stack`   | all immich services                                                    |

Mappings are configured in `rfapps.config.yaml` under `sidecars.mapping` (empty in this repo).

## GitHub Contribution Templates

When creating GitHub issues or pull requests, all coding agents must follow repository templates exactly.

### Issue Templates (Required)

- Always use GitHub issue forms from `.github/ISSUE_TEMPLATE/`; do not open blank issues.
- Choose the correct form:
  - Enhancement: `.github/ISSUE_TEMPLATE/enhancement.yml`
  - Bug: `.github/ISSUE_TEMPLATE/bug.yml`
  - Question: `.github/ISSUE_TEMPLATE/question.yml`
  - Documentation: `.github/ISSUE_TEMPLATE/docs.yml`
  - Chore: `.github/ISSUE_TEMPLATE/chore.yml`
  - Security hardening (public-safe only): `.github/ISSUE_TEMPLATE/security.yml`
- For exploitable vulnerabilities or sensitive security details, do not use public issues; use private reporting from `.github/ISSUE_TEMPLATE/config.yml` (`Private Security Report` link).

### Pull Request Template (Required)

- Always use `.github/pull_request_template.md` as the PR body baseline.
- Preserve required sections:
  - `## Summary`
  - `## Changes`
  - `## Testing`
  - `## Related Issues` (use `Closes #<issue-number>` when applicable)
  - `## Breaking Changes`
  - `## Risk and Rollback`
  - `## Checklist`
- Include exact verification commands and pass/fail outcomes in `## Testing`.

### Agent Markdown Mirrors

- For offline drafting, automation, or agent-generated artifacts, use markdown mirrors in `docs/templates/github/`.
- Mirror files are drafting aids only; GitHub issue forms and PR template remain the source of truth for final submissions.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
