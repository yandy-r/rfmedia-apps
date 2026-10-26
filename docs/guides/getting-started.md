# Getting Started

This guide walks you through setting up and deploying the rfmedia-apps Docker self-hosting platform
for the first time.

## Prerequisites

Before you begin, ensure you have the following installed and configured on your system.

### Required Software

| Software       | Minimum Version | Purpose                         |
| -------------- | --------------- | ------------------------------- |
| Docker         | 24.0+           | Container runtime               |
| Docker Compose | 2.20+           | Container orchestration         |
| Git            | 2.30+           | Repository management           |
| Node.js        | 24.22.1         | Monorepo install and rfapps CLI |

`mise` installs Node.js 24.22.1 from `.mise.toml`. The root `package.json` `engines` field requires
`>=24.22.1`. The CLI packages declare `>=22.23.4`; installing them from this repository still uses
the monorepo floor.

### Secret Management (choose one)

You need one of the following tools for managing sensitive environment variables:

| Tool                      | Description                           | Installation                                                       |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| **dotenvx** (recommended) | Encrypted environment file management | `npm install -g @dotenvx/dotenvx`                                  |
| **1Password CLI**         | 1Password integration for secrets     | [Install 1Password CLI](https://developer.1password.com/docs/cli/) |

### Optional but Recommended

| Software           | Purpose                             |
| ------------------ | ----------------------------------- |
| Tailscale          | Secure remote access to services    |
| Cloudflare account | DNS management and SSL certificates |

### System Requirements

- Linux-based operating system (Ubuntu, Debian, Arch, etc.)
- Minimum 8GB RAM (16GB+ recommended for full deployment)
- 100GB+ storage for Docker images and data
- Network access to Docker Hub and GitHub Container Registry

### Verify Installation

Run these commands to verify your environment:

```bash
# Check Docker version
docker --version
# Expected: Docker version 24.x.x or higher

# Check Docker Compose version
docker compose version
# Expected: Docker Compose version v2.20.x or higher

# Check Git version
git --version
# Expected: git version 2.30.x or higher

# Check Node.js version
node --version
# Expected: v24.22.1 or newer

# Check dotenvx (if using)
dotenvx --version
# Expected: x.x.x

# Check 1Password CLI (if using)
op --version
# Expected: 2.x.x
```

## Installing the rfapps CLI

The project uses `rfapps`, a TypeScript CLI, for managing Docker containers. Install it globally for
convenient access:

```bash
# Navigate to the project directory (if not already there)
cd rfmedia-apps

# Install dependencies and link the CLI globally
npm run link:rfapps

# Verify installation
rfapps --help
```

### Shell Completions (Optional)

Enable shell completions for easier command entry:

```bash
# For bash
rfapps completion bash --install

# For zsh
rfapps completion zsh --install

# For fish
rfapps completion fish --install
```

After installation, restart your shell or source your profile to enable completions.

## Initial Setup

### Step 1: Clone the Repository

Clone the repository to your local machine:

```bash
# Using HTTPS
git clone https://github.com/yandy-r/rfmedia-apps.git

# Or using SSH
git clone git@github.com:yandy-r/rfmedia-apps.git

# Navigate to the project directory
cd rfmedia-apps
```

If you have Tailscale configured:

```bash
# Via Tailscale network
git clone https://github.com/yandy-r/rfmedia-apps.git
```

### Step 2: Create the Environment File

The project uses environment files to configure all services. Create your local environment file:

```bash
# Copy the example environment file
cp .env.example .env.local

# Secure the file permissions
chmod 600 .env.local
```

### Step 3: Configure Environment Variables

Edit `.env.local` with your specific values. The following variables are required for basic
operation:

```bash
# Open the file in your preferred editor
nano .env.local
# or
vim .env.local
```

**Required Core Variables:**

```bash
# System Configuration
TZ=America/New_York              # Your timezone
PUID=1000                        # Your user ID (run 'id -u' to find)
PGID=1000                        # Your group ID (run 'id -g' to find)

# Directory Paths
DOCKER_DIR=/opt/docker/config    # Where service configs are stored
DOCKER_DATA_DIR=/opt/docker/data # Where service data is stored
DATA_DIR=/mnt/media              # Where media files are stored
DOWNLOADS_DIR=/mnt/downloads     # Where downloads are stored

# Domain Configuration
DOMAIN=example.com               # Primary domain for infrastructure
DOMAIN2=media.example.com        # Secondary domain for media services
```

**Tailscale Configuration (for remote access):**

```bash
TS_AUTHKEY=tskey-auth-xxxx       # Tailscale authentication key
TS_DOMAIN=tailnet-name.ts.net    # Your Tailscale domain
```

**Cloudflare Configuration (for SSL certificates):**

```bash
CF_API_EMAIL=admin@example.com   # Cloudflare account email
CF_DNS_API_TOKEN=your_token      # Cloudflare DNS API token
```

For a complete list of all configuration variables, see the
[Environment Variables Reference](../reference/environment-variables.md).

### Step 4: Create Required Directories

Create the directories specified in your environment file:

```bash
# Create configuration directories
sudo mkdir -p /opt/docker/config
sudo mkdir -p /opt/docker/data

# Create media directories
sudo mkdir -p /mnt/media
sudo mkdir -p /mnt/downloads

# Set ownership to your user
sudo chown -R $(id -u):$(id -g) /opt/docker
```

### Step 5: Validate Configuration

Before deploying, validate your Docker Compose configuration:

```bash
# Validate compose file syntax
docker compose --profile all config --quiet

# If using dotenvx, validate with environment loaded
dotenvx run -f .env.local -- docker compose --profile all config --quiet
```

If validation passes with no output, your configuration is correct.

## First Deployment

### Understanding Service Profiles

Services are organized into profiles for grouped deployment:

| Profile          | Description                                                   | Service Count |
| ---------------- | ------------------------------------------------------------- | ------------- |
| `core`           | Essential infrastructure (Traefik, Authentik)                 | 7             |
| `infrastructure` | Management tools (Uptime Kuma, Homarr, StirlingPDF)           | 4             |
| `downloads`      | Download clients and helpers                                  | 9             |
| `arr-stack`      | Media automation (Sonarr, Radarr, Bazarr, Lidarr)             | 7             |
| `media`          | Media servers (Plex, Tautulli, Plexseerr, Jellyseerr, Kometa) | 5+            |
| `photos`         | Photo management (Immich)                                     | 4             |
| `all`            | All services                                                  | 35            |

**Important:** Running `docker compose up` without specifying `--profile` starts nothing. Always
specify a profile.

### Deploy Core Services First

For your first deployment, start with just the core infrastructure:

```bash
# Deploy core services (Traefik, Authentik)
rfapps deploy -p core --yes
```

This starts the essential services:

- **Traefik** - Reverse proxy with automatic SSL
- **Authentik** - Identity provider and authentication
- **Tailscale (Docktail)** - Secure remote access via tailnet ingress

Wait for the services to become healthy (this may take 2-5 minutes on first run).

### Deploy Additional Services

Once core services are running, deploy additional profiles:

```bash
# Deploy infrastructure tools
rfapps deploy -p infrastructure --yes

# Deploy media services
rfapps deploy -p media --yes

# Deploy download clients and automation
rfapps deploy -p downloads --yes
rfapps deploy -p arr-stack --yes
```

Or deploy everything at once:

```bash
# Deploy all services
rfapps deploy --yes
```

### Deployment Options

The `rfapps` CLI provides several useful options:

```bash
# Deploy with verbose output (shows detailed progress)
rfapps deploy -v --yes

# Deploy without pulling new images
rfapps deploy --skip-pull --yes

# Deploy a specific service
rfapps deploy -s uptime-kuma --yes

# Deploy multiple specific services
rfapps deploy --services sonarr,radarr,bazarr --yes

# Preview deployment without executing
rfapps deploy --dry-run

# Deploy using a service group
rfapps deploy -g media-stack --yes
```

## Verification Steps

After deployment, verify that services are running correctly.

### Check Service Status

```bash
# View basic status of all services
rfapps status

# View all status details (health, stats, network)
rfapps status --all

# Check health status specifically
rfapps status --health

# Check resource usage
rfapps status --stats

# Output status as JSON (for scripting)
rfapps status --json
```

### View Container Logs

```bash
# View logs for a specific service
docker compose logs -f uptime-kuma

# View last 50 lines of logs
docker compose logs --tail 50 traefik

# View logs for multiple services
docker compose logs -f sonarr radarr bazarr
```

### Verify Service Accessibility

Once services are running, access them via your configured domains:

| Service           | URL Pattern                   |
| ----------------- | ----------------------------- |
| Traefik Dashboard | `https://traefik.${DOMAIN}`   |
| Authentik         | `https://authentik.${DOMAIN}` |
| Uptime Kuma       | `https://uptime.${DOMAIN}`    |
| Homarr Dashboard  | `https://homarr.${DOMAIN2}`   |
| Stirling PDF      | `https://pdf.${DOMAIN2}`      |
| Speedtest Tracker | `https://speedtest.${DOMAIN}` |

Replace `${DOMAIN}` and `${TS_DOMAIN}` with your actual domain values.

### Initial Service Configuration

After deployment, some services require initial setup:

1. **Authentik**: Access the web interface and create your admin account
2. **Uptime Kuma**: Set up the initial admin password
3. **Plex**: Claim your server with your Plex account
4. **Sonarr/Radarr**: Configure download clients and indexers

## Common First-Time Issues

### Issue: Permission Denied Errors

**Symptoms:** Containers fail with permission errors on mounted volumes.

**Solution:**

```bash
# Verify your PUID/PGID match your user
id  # Shows your UID and GID

# Fix ownership of Docker directories
sudo chown -R $(id -u):$(id -g) /opt/docker

# Ensure .env.local has correct PUID/PGID
grep -E "^(PUID|PGID)" .env.local
```

### Issue: Services Not Starting

**Symptoms:** Containers exit immediately or keep restarting.

**Solution:**

```bash
# Check container logs for errors
docker compose logs --tail 100 [service_name]

# Verify environment file is loaded with verbose output
rfapps deploy -v --yes

# Check for missing dependencies
docker compose ps -a
```

### Issue: Cannot Access Services

**Symptoms:** Services running but not accessible via browser.

**Solution:**

```bash
# Check if Traefik is running
docker compose ps traefik

# View Traefik logs for routing errors
docker compose logs -f traefik

# Verify DNS records point to your server
dig +short your-domain.com
```

### Issue: Database Connection Errors

**Symptoms:** Services fail to connect to their databases.

**Solution:**

```bash
# Check database container status
docker compose ps | grep -E "(db|postgres|redis)"

# Wait for databases to initialize (can take 2-3 minutes on first run)
docker compose logs -f authentik-db

# Verify database credentials in .env.local
grep -E "PASSWORD|DB_" .env.local
```

### Issue: Tailnet / Docktail Not Working

**Symptoms:** Services not accessible via Tailscale network; Traefik unreachable on tailnet.

**Solution:**

```bash
# Check Docktail reconciler
docker compose logs docktail --tail 50

# Verify host Tailscale daemon
tailscale status

# Confirm OAuth env vars are set
grep -E "TAILSCALE_OAUTH" .env.local

# Check Traefik is healthy on apps network
docker compose ps traefik
docker compose logs traefik --tail 30
```

### Issue: Docktail / Tailnet Not Connecting

**Symptoms:** Plex/Jellyfin/Immich not accessible via tailnet (MagicDNS or Tailscale Services URL).

**Solution:**

```bash
# Check Docktail logs for reconciler errors
docker compose logs docktail --tail 30

# Verify TAILSCALE_OAUTH_CLIENT_ID / _SECRET are set
grep -E "TAILSCALE_OAUTH" .env.local
```

### Issue: Image Pull Failures

**Symptoms:** Cannot download container images.

**Solution:**

```bash
# Test Docker Hub connectivity
docker pull alpine:latest

# Pull images with verbose output
rfapps pull -v --yes

# Pull images with debug output for troubleshooting
rfapps pull --debug --yes
```

For more troubleshooting scenarios, see the [Troubleshooting Guide](docs/guides/troubleshooting.md).

## Next Steps

Once your deployment is running, explore these resources:

### Configuration and Customization

- [Environment Variables Reference](docs/reference/environment-variables.md) - Complete list of
  configuration options
- [Docker Compose Extensions](docs/features/docker-compose-extensions.md) - Understanding reusable
  service templates
- [rfapps CLI Documentation](packages/rfapps-cli/README.md) - Full CLI documentation

### Feature Guides

- [Traefik Reverse Proxy](docs/features/traefik-reverse-proxy.md) - SSL and routing configuration
- [Authentik Integration](docs/features/authentik-integration.md) - Single sign-on setup
- [Tailscale Integration](docs/features/tailscale-integration.md) - Secure remote access
- [Homarr Dashboard](docs/features/homarr-dashboard.md) - Service dashboard

### Service-Specific Guides

- [Immich Photo Management](docs/features/immich-photo-management.md) - Photo and video management

### Operations

- [Quick Reference](docs/features/quick-reference.md) - One-page command reference card
- [npm Scripts Guide](docs/reference/npm-scripts-guide.md) - npm script shortcuts
- [Troubleshooting Guide](docs/guides/troubleshooting.md) - Common issues and recovery

## Quick Command Reference

For a complete one-page reference, see the
[Quick Reference Guide](docs/features/quick-reference.md).

Here are the most common commands you will use:

```bash
# Deploy all services
rfapps deploy --yes

# Deploy specific profile
rfapps deploy -p media --yes

# Deploy a service group
rfapps deploy -g media-stack --yes

# Check status of all services
rfapps status --all

# View logs for a service
docker compose logs -f [service_name]

# Rebuild a service
rfapps rebuild -s [service_name] --yes

# Stop all services
rfapps stop --yes

# Pull latest images
rfapps pull --yes

# Use different environment file
rfapps deploy -e .env.prod --yes

# Preview without executing
rfapps deploy --dry-run

# Use npm scripts (alternative)
npm run apps:deploy
npm run apps:status
npm run apps:stop
```
