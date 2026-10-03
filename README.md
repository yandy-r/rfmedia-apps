# RFmedia Apps

A Docker-based self-hosting platform orchestrating 49 containerized services across multiple
categories including infrastructure, media management, downloads, and productivity tools.

## Quick Start

```bash
# Clone the repository (via Tailscale network)
git clone https://github.com/yandy-r/rfmedia-apps.git
# Or via SSH
git clone git@github.com:yandy-r/rfmedia-apps.git

cd rfmedia-apps

# Use Node.js 22 (mise reads the repository's .mise.toml automatically)

# Configure environment
cp .env.example .env.local
chmod 600 .env.local
# Edit .env.local with your values

# Install dependencies and link the CLI
npm install
npm run link:rfapps

# Deploy all services
rfapps deploy --yes
```

> **Note**: Replace `${TS_DOMAIN}` with your Tailscale domain (e.g., `tailnet-name.ts.net`).

## Architecture Overview

### Reverse Proxy and Authentication

- **Traefik** - Primary reverse proxy with automatic SSL via Let's Encrypt
- **Authentik** - Identity provider with SSO, MFA, and OAuth2/SAML support
- npm (Nginx Proxy Manager) is deprecated in favor of Traefik

See [Traefik Reverse Proxy](docs/features/traefik-reverse-proxy.md) and
[Authentik Integration](docs/features/authentik-integration.md) for details.

### Service Categories

| Category           | Services                                                                 | Description                             |
| ------------------ | ------------------------------------------------------------------------ | --------------------------------------- |
| **Core**           | traefik, authentik                                                       | Essential infrastructure (8 containers) |
| **Infrastructure** | uptime-kuma, homarr, tokenhop, headroom, stirling-pdf, speedtest-tracker | Management and productivity tools       |
| **Media**          | plex, plex-music, tautulli, plexseerr, jellyseerr, kometa, watchstate    | Media servers and management            |
| **Arr-Stack**      | sonarr, radarr, lidarr, bazarr, prowlarr, notifiarr, praxrr              | Media automation                        |
| **Downloads**      | sabnzbd, nzbget, slskd, autobrr, unpackerr, prowlarr                     | Download clients and helpers            |
| **Photos**         | immich                                                                   | Photo management with AI (4 containers) |

### Network Architecture

- Custom bridge network `apps` for inter-service communication
- **Docktail** for Tailscale Services (Traefik, jellyfin, images, and other labeled services)
- **tsdproxy-rfapps** for shareable hosts (`git`, `plex`, `plex-music`)
- See [Tailscale Integration](docs/features/tailscale-integration.md) for the full network model

## Management Commands

### rfapps CLI

The project uses `rfapps`, a TypeScript CLI for Docker orchestration:

```bash
rfapps pull      # Pull latest Docker images
rfapps build     # Pull images and build containers
rfapps deploy    # Start services with health checks
rfapps rebuild   # Stop, rebuild, and restart services
rfapps delete    # Stop and remove services with cleanup
rfapps prune     # Delete services and remove images
rfapps status    # View service status
rfapps plan      # Preview deployment changes (Terraform-style)
rfapps update    # Preview and apply verified image updates
rfapps drift     # Detect compose/runtime drift
rfapps reconcile # Report drift or converge reviewed targets
rfapps audit     # Read-only compose security posture audit
rfapps backup    # Create or verify cold filesystem backup bundles
```

Managed image updates are preview-first, operator-invoked, and sequential. See the
[`update` command reference](packages/rfapps-cli/README.md#update) and
[Plan/Apply Workflow](docs/features/plan-apply-workflow.md). Recovery restores an exact prior image
on the same Docker daemon; it does not roll back volumes, application data, databases, or migrations.

Reconciliation is report-only by default. See the
[`reconcile` command reference](packages/rfapps-cli/README.md#reconcile) and
[rfapps Reconcile Command](docs/features/rfapps-reconcile-command.md) guide for deterministic
reports and explicitly authorized, target-only `--auto-apply` behavior.

Native backup archives eligible Compose bind directories and named volumes after stopping every
detected writer in the resolved project, then restores the exact captured containers.
`rfapps backup verify <manifest>` validates a published bundle later without config or Docker. See
the [`backup` command reference](packages/rfapps-cli/README.md#backup) and
[rfapps Native Backup](docs/features/rfapps-backup.md). Database-native dumps remain necessary for
application-level consistency.

### rfmedia CLI

The project also includes `rfmedia` for media management workflows:

```bash
rfmedia copy /source /dest --range=001-003
rfmedia delete /source /dest --range=001-003
rfmedia plex playlist export "Favorites" /exports
rfmedia reconcile scan /mnt/music --library Music
```

See [rfmedia CLI README](packages/rfmedia-cli/README.md) and
[Interactive CLI Workflows](docs/features/interactive-cli.md) for general usage. See
[Metadata Reconciliation](packages/rfmedia-cli/docs/features/metadata-reconciliation.md) for
three-plane file, inventory, and media-server drift detection.

### Command Options

```bash
-s, --service NAME    # Target a specific service
--services N1,N2      # Target multiple services (comma-separated)
-g, --group NAME      # Target a service group
-p, --profile NAME    # Deploy specific service profile
-v, --verbose         # Show detailed progress output
--dry-run             # Preview actions without executing
-y, --yes             # Skip confirmation prompts
--json                # Output in JSON format
```

### Environment Selection

```bash
rfapps deploy -e .env.local --yes    # Uses .env.local
rfapps deploy -e .env.dev --yes      # Uses .env.dev
rfapps deploy -e .env.staging --yes  # Uses .env.staging
rfapps deploy -e .env.prod --yes     # Uses .env.prod
```

### Service Profiles

All services require a profile to start. Available profiles:

| Profile          | Description                                    | Service Count |
| ---------------- | ---------------------------------------------- | ------------- |
| `core`           | Traefik, Authentik                             | 8             |
| `infrastructure` | Core + Uptime Kuma, Homarr, tokenhop, and more | 16            |
| `downloads`      | Download clients and helpers                   | 6             |
| `arr-stack`      | Sonarr, Radarr, Bazarr, etc.                   | 7             |
| `media`          | Plex, Tautulli, Seerr, Kometa, WatchState      | 9             |
| `photos`         | Immich stack                                   | 4             |
| `all`            | Complete deployment                            | 50            |

```bash
# Deploy specific profiles
rfapps deploy -p core --yes
rfapps deploy -p media --yes

# Deploy multiple services
rfapps deploy --services plex,sonarr,radarr --yes

# Deploy a service group
rfapps deploy -g media-stack --yes
```

See [Docker Compose Profiles](docs/features/compose-profiles.md) for complete profile documentation.

### npm Scripts

For convenience, npm scripts wrap common operations:

```bash
# Basic operations
npm run apps:pull      # Pull all images
npm run apps:deploy    # Deploy all services
npm run apps:rebuild   # Rebuild all services
npm run apps:stop      # Stop all services
npm run apps:status    # Show service status

# Direct rfapps access (for additional options)
npm run rfapps -- deploy -s plex --yes
npm run rfapps -- rebuild -g media-stack --yes
```

## Environment Configuration

### Key Environment Variables

| Variable          | Purpose                                    |
| ----------------- | ------------------------------------------ |
| `DOCKER_DIR`      | Configuration files location               |
| `DOCKER_DATA_DIR` | Data storage location                      |
| `DATA_DIR`        | Media files location                       |
| `TZ`              | Timezone (e.g., America/New_York)          |
| `PUID` / `PGID`   | User/Group IDs for file permissions        |
| `DOMAIN`          | Primary domain for infrastructure services |
| `DOMAIN2`         | Secondary domain for media services        |
| `TS_AUTHKEY`      | Tailscale authentication key               |

### 1Password Integration

Secrets are managed via 1Password CLI:

```bash
op run --env-file .env.local -- docker compose up -d
```

## Service Dependencies

Services with database backends and tailnet labels:

- `authentik-server` depends on `authentik-db` (PostgreSQL), `authentik-redis`
- `immich-server` depends on `immich-postgres`, `immich-redis`
- `docktail` advertises `traefik` on the tailnet; Traefik routes on the `apps` network

## SSL Certificates

SSL certificates are managed through:

1. **Traefik** - Automatic Let's Encrypt certificate management
2. **Certbot** - Manual certificate renewal via Cloudflare DNS challenge

## Monitoring and Updates

- **Pullio** - Automatic container update notifications
- **Notifiarr** - Webhook notifications for arr-stack services
- **Uptime Kuma** - Service uptime monitoring
- **Tautulli** - Plex analytics and monitoring

## Documentation

Detailed documentation is available in the `docs/` directory:

- [Documentation Index](docs/README.md) - Complete documentation overview
- [Getting Started Guide](docs/guides/getting-started.md) - Full setup walkthrough
- [rfapps CLI Reference](packages/rfapps-cli/README.md#commands) - Complete CLI documentation

### Feature Documentation

- [Docker Compose Extensions](docs/features/docker-compose-extensions.md) - Reducing configuration
  duplication
- [Docker Compose Profiles](docs/features/compose-profiles.md) - Service profile system
- [Traefik Reverse Proxy](docs/features/traefik-reverse-proxy.md) - Routing and SSL configuration
- [Authentik Integration](docs/features/authentik-integration.md) - Authentication setup
- [tokenhop Setup](docs/services/tokenhop-setup.md) - AI gateway with native authentication and
  Traefik HTTPS routing
- [Tailscale Integration](docs/features/tailscale-integration.md) - Secure remote access
- [Sidecar Linking](docs/features/sidecar-linking.md) - Optional CLI sidecar expansion (disabled in this repo)
- [Managed Image Update Command](packages/rfapps-cli/README.md#update) - Preview, review, apply,
  verify, and exact-image recovery
- [Plan/Apply Workflow](docs/features/plan-apply-workflow.md) - Ordinary deployment plans and managed
  update routing
- [rfapps Reconcile Command](docs/features/rfapps-reconcile-command.md) - Report-first
  desired-state comparison and explicitly authorized convergence
- [rfapps Native Backup](docs/features/rfapps-backup.md) - Cold bind/volume backup, private
  manifest-last bundles, offline verification, and manual restore guidance
- [rfapps Vulnerability Scanning](docs/features/rfapps-vulnerability-scanning.md) - Opt-in image CVE
  scanning with a fail-closed `deploy` gate
- [rfapps Harden Command](docs/features/rfapps-harden-command.md) - Propose, override, or apply
  compose security hardening
- [Deployment History](docs/features/deployment-history.md) and
  [Rollback](docs/features/deployment-rollback.md) - Immutable image identity and recovery records
- [Service Healthchecks](docs/features/service-healthchecks.md) - Target verification and dependency
  readiness
- [Secrets Management](docs/features/secrets-management.md) - dotenvx and 1Password integration

### Package Documentation

- [rfapps-cli](packages/rfapps-cli/README.md) - Docker orchestration CLI
- [rfmedia-cli](packages/rfmedia-cli/README.md) - Media management CLI
- [rf-common](packages/rf-common/README.md) - Shared utilities

## Security Notes

- All services run as non-root users (PUID/PGID)
- SSL/TLS encryption on all web services
- Centralized authentication via Authentik
- Tailscale VPN for secure remote access
- Environment files should have restricted permissions (`chmod 600`)
- Never commit secrets or API keys to version control
- Treat native backup bundles as sensitive topology and application data; SHA-256 verifies bytes,
  not authenticity, encryption, or signing

## Contributing

Use the repository templates for all new issues and pull requests.

- Issue forms live in `.github/ISSUE_TEMPLATE/`:
  - `enhancement.yml`
  - `bug.yml`
  - `question.yml`
  - `docs.yml`
  - `chore.yml`
  - `security.yml`
- Pull requests use `.github/pull_request_template.md`
- Agent-friendly markdown mirrors live in `docs/templates/github/`

Contribution standards:

- Include clear summary, scope, and affected files.
- Include reproducible verification commands and pass/fail outcomes.
- Link work with `Closes #<issue-number>` when applicable.
- Prefer conventional-style PR titles where possible (`feat(...)`, `fix(...)`, `docs(...)`,
  `chore(...)`).

## License

MIT
