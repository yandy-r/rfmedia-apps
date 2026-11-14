# Environment Variables Reference

This document provides a comprehensive reference for all environment variables used in the
rfmedia-apps Docker self-hosting platform.

## Quick Reference

The following table lists the most important variables required for basic operation:

| Variable          | Purpose                             | Required | Default |
| ----------------- | ----------------------------------- | -------- | ------- |
| `TZ`              | System timezone                     | Yes      | -       |
| `PUID`            | User ID for file permissions        | Yes      | -       |
| `PGID`            | Group ID for file permissions       | Yes      | -       |
| `DOCKER_DIR`      | Configuration files location        | Yes      | -       |
| `DOCKER_DATA_DIR` | Data storage location               | Yes      | -       |
| `DATA_DIR`        | Media files location                | Yes      | -       |
| `DOMAIN`          | Primary domain for infrastructure   | Yes      | -       |
| `DOMAIN2`         | Secondary domain for media services | Yes      | -       |
| `TS_AUTHKEY`      | Tailscale authentication key        | Yes      | -       |
| `TS_DOMAIN`       | Tailscale MagicDNS domain           | Yes      | -       |

## Overview

Environment variables in this project are managed through `.env` files that are either encrypted
with dotenvx or hold 1Password `op://` secret references (see
[Secrets Management](../features/secrets-management.md)). The primary environment file is
`.env.local`, with support for multiple environments:

- `.env.local` - Local development (default)
- `.env.dev` - Development environment
- `.env.staging` - Staging environment
- `.env.prod` - Production environment

Variables are loaded using the `rfapps` CLI with dotenvx or 1Password CLI integration for secrets
injection.

## Core Variables

These essential variables are required for all services to function correctly.

### System Configuration

| Variable      | Description                     | Required | Default | Example                   |
| ------------- | ------------------------------- | -------- | ------- | ------------------------- |
| `TZ`          | Timezone for containers         | Yes      | -       | `America/New_York`        |
| `PUID`        | User ID for running containers  | Yes      | -       | `1000`                    |
| `PGID`        | Group ID for running containers | Yes      | -       | `1000`                    |
| `PROJECT_DIR` | Project root directory          | Yes      | -       | `/home/user/rfmedia-apps` |

### Directory Paths

| Variable          | Description                    | Required | Default | Example              |
| ----------------- | ------------------------------ | -------- | ------- | -------------------- |
| `DOCKER_DIR`      | Configuration files location   | Yes      | -       | `/opt/docker/config` |
| `DOCKER_DATA_DIR` | Persistent data storage        | Yes      | -       | `/opt/docker/data`   |
| `DATA_DIR`        | Media files location           | Yes      | -       | `/mnt/media`         |
| `DOWNLOADS_DIR`   | Download directory             | Yes      | -       | `/mnt/downloads`     |
| `PLEX_DOCKER_DIR` | Plex-specific config directory | Yes      | -       | `/opt/plex`          |

### Docker Logging

| Variable                | Description                 | Required | Default | Example |
| ----------------------- | --------------------------- | -------- | ------- | ------- |
| `DOCKERLOGGING_MAXFILE` | Maximum log files to retain | No       | -       | `3`     |
| `DOCKERLOGGING_MAXSIZE` | Maximum size per log file   | No       | -       | `10m`   |

## Domain and SSL Variables

These variables control routing and SSL certificate generation.

### Primary Domains

| Variable       | Description                                | Required | Default | Example               |
| -------------- | ------------------------------------------ | -------- | ------- | --------------------- |
| `DOMAIN`       | Primary domain for infrastructure services | Yes      | -       | `example.com`         |
| `DOMAIN2`      | Secondary domain for media services        | Yes      | -       | `media.example.com`   |
| `SANS_DOMAIN`  | Subject Alternative Name for DOMAIN        | No       | -       | `*.example.com`       |
| `SANS_DOMAIN2` | Subject Alternative Name for DOMAIN2       | No       | -       | `*.media.example.com` |
| `TS_DOMAIN`    | Tailscale MagicDNS domain                  | Yes      | -       | `tailnet-name.ts.net` |

### Cloudflare Configuration

| Variable                 | Description                                                                          | Required | Default | Example                |
| ------------------------ | ------------------------------------------------------------------------------------ | -------- | ------- | ---------------------- |
| `CF_API_EMAIL`           | Cloudflare account email                                                             | Yes      | -       | `admin@example.com`    |
| `CF_DNS_API_TOKEN`       | Cloudflare DNS API token (primary domain)                                            | Yes      | -       | `cloudflare_api_token` |
| `CF_MEDIA_API_TOKEN`     | Cloudflare DNS API token (media domain)                                              | No       | -       | `cloudflare_api_token` |
| `CF_ACCOUNT_ID`          | Cloudflare account ID (Terraform tunnel stack)                                       | Yes      | -       | `a1b2c3...`            |
| `CF_TERRAFORM_API_TOKEN` | Terraform API token: Tunnel Edit, DNS Edit, Zone Read                                | Yes      | -       | `cloudflare_api_token` |
| `CF_TUNNEL_TOKEN`        | Cloudflared connector token (generated by `tf:apply:cloudflare`, never hand-entered) | Yes      | -       | -                      |

`CF_TUNNEL_ID` is obsolete — removed with the CLI-managed tunnel. See
[Cloudflare Tunnel](../features/cloudflare-tunnel.md).

## Traefik Variables

Configuration for the Traefik reverse proxy.

| Variable           | Description                                      | Required | Default | Example                          |
| ------------------ | ------------------------------------------------ | -------- | ------- | -------------------------------- |
| `DOMAIN`           | Domain for infrastructure routing                | Yes      | -       | `example.com`                    |
| `DOMAIN2`          | Domain for media service routing                 | Yes      | -       | `media.example.com`              |
| `TS_DOMAIN`        | Tailscale domain for internal routing            | Yes      | -       | `tailnet.ts.net`                 |
| `CF_DNS_API_TOKEN` | Cloudflare token for Let's Encrypt DNS challenge | Yes      | -       | -                                |
| `CF_API_EMAIL`     | Email for Let's Encrypt certificate registration | Yes      | -       | -                                |
| `HOMEAUTO_SERVER`  | Home automation server address                   | No       | -       | `192.168.1.100`                  |
| `LOG_LEVEL`        | Traefik log level                                | No       | `INFO`  | `DEBUG`, `INFO`, `WARN`, `ERROR` |

## Authentik Variables

Configuration for the Authentik identity provider.

### Core Settings

| Variable                 | Description                         | Required | Default                      | Example                         |
| ------------------------ | ----------------------------------- | -------- | ---------------------------- | ------------------------------- |
| `AUTHENTIK_SECRET_KEY`   | Secret key for Authentik encryption | Yes      | -                            | `random_secret_key`             |
| `AUTHENTIK_TAG`          | Authentik Docker image tag          | No       | `2025.10`                    | `2025.10`                       |
| `AUTHENTIK_IMAGE`        | Authentik Docker image              | No       | `ghcr.io/goauthentik/server` | -                               |
| `AUTHENTIK_TOKEN`        | API token for Authentik proxy       | Yes      | -                            | -                               |
| `AUTHENTIK_HOST_BROWSER` | Browser-accessible Authentik URL    | Yes      | -                            | `https://authentik.example.com` |

### Database Settings

| Variable                      | Description                       | Required | Default     | Example           |
| ----------------------------- | --------------------------------- | -------- | ----------- | ----------------- |
| `AUTHENTIK_POSTGRES_PASSWORD` | PostgreSQL password for Authentik | Yes      | -           | `secure_password` |
| `PG_USER`                     | PostgreSQL username               | No       | `authentik` | `authentik`       |
| `PG_DB`                       | PostgreSQL database name          | No       | `authentik` | `authentik`       |

### Email Settings

| Variable                   | Description                  | Required | Default | Example                 |
| -------------------------- | ---------------------------- | -------- | ------- | ----------------------- |
| `AUTHENTIK_EMAIL_HOST`     | SMTP server hostname         | Yes      | -       | `smtp.gmail.com`        |
| `AUTHENTIK_EMAIL_PORT`     | SMTP server port             | Yes      | -       | `587`                   |
| `AUTHENTIK_EMAIL_USERNAME` | SMTP authentication username | Yes      | -       | `user@gmail.com`        |
| `AUTHENTIK_EMAIL_PASSWORD` | SMTP authentication password | Yes      | -       | `app_password`          |
| `AUTHENTIK_EMAIL_FROM`     | From address for emails      | Yes      | -       | `authentik@example.com` |
| `AUTHENTIK_EMAIL_USE_TLS`  | Enable TLS for SMTP          | No       | `true`  | `true`, `false`         |
| `AUTHENTIK_EMAIL_USE_SSL`  | Enable SSL for SMTP          | No       | `false` | `true`, `false`         |
| `AUTHENTIK_EMAIL_TIMEOUT`  | SMTP connection timeout      | No       | `10`    | `10`                    |

### S3 Media Storage (Optional)

| Variable                                    | Description           | Required | Default     | Example           |
| ------------------------------------------- | --------------------- | -------- | ----------- | ----------------- |
| `AUTHENTIK_STORAGE__MEDIA__BACKEND`         | Media storage backend | No       | `file`      | `file`, `s3`      |
| `AUTHENTIK_STORAGE__MEDIA__S3__BUCKET_NAME` | S3 bucket name        | No       | -           | `authentik-media` |
| `AUTHENTIK_STORAGE__MEDIA__S3__ACCESS_KEY`  | S3 access key         | No       | -           | -                 |
| `AUTHENTIK_STORAGE__MEDIA__S3__SECRET_KEY`  | S3 secret key         | No       | -           | -                 |
| `AUTHENTIK_STORAGE__MEDIA__S3__REGION`      | S3 region             | No       | `us-east-1` | `us-east-1`       |

## Database Variables

### MariaDB (MySQL)

Used by Uptime Kuma and other services.

| Variable              | Description               | Required | Default       | Example                |
| --------------------- | ------------------------- | -------- | ------------- | ---------------------- |
| `MYSQL_ROOT_PASSWORD` | Root password for MariaDB | Yes      | -             | `secure_root_password` |
| `MYSQL_PASSWORD`      | Application user password | Yes      | -             | `secure_password`      |
| `UPTIME_KUMA_DB`      | Uptime Kuma database name | No       | `uptime-kuma` | `uptime-kuma`          |
| `UPTIME_KUMA_DB_USER` | Uptime Kuma database user | No       | `uptime-kuma` | `uptime-kuma`          |

### PostgreSQL

Used by Authentik, Immich, and Forgejo.

| Variable                      | Description                      | Required | Default     | Example     |
| ----------------------------- | -------------------------------- | -------- | ----------- | ----------- |
| `AUTHENTIK_POSTGRES_PASSWORD` | Authentik PostgreSQL password    | Yes      | -           | -           |
| `PG_USER`                     | Authentik PostgreSQL user        | No       | `authentik` | `authentik` |
| `PG_DB`                       | Authentik PostgreSQL database    | No       | `authentik` | `authentik` |
| `IMMICH_DB_PASSWORD`          | Immich PostgreSQL password       | Yes      | -           | -           |
| `IMMICH_DB_USERNAME`          | Immich PostgreSQL user           | Yes      | -           | `immich`    |
| `IMMICH_DB_NAME`              | Immich PostgreSQL database       | Yes      | -           | `immich`    |
| `IMMICH_DATABASE_NAME`        | Immich database name (alternate) | Yes      | -           | `immich`    |
| `FORGEJO_DB_NAME`             | Forgejo PostgreSQL database      | No       | `forgejo`   | `forgejo`   |
| `FORGEJO_DB_USER`             | Forgejo PostgreSQL user          | No       | `forgejo`   | `forgejo`   |
| `FORGEJO_DB_PASSWORD`         | Forgejo PostgreSQL password      | Yes      | -           | -           |

## Service-Specific Variables

### Plex Media Server

| Variable                   | Description                                    | Required | Default | Example                              |
| -------------------------- | ---------------------------------------------- | -------- | ------- | ------------------------------------ |
| `PLEX_CLAIM`               | Claim token for the primary `plex` server      | Yes      | -       | `claim-xxxx`                         |
| `PLEX_ADVERTISE_URL`       | Advertised URL for the primary `plex` server   | No       | -       | `https://plex.example.com:443`       |
| `PLEX_CLAIM_MUSIC`         | Claim token for the `plex-music` server        | Yes      | -       | `claim-xxxx`                         |
| `PLEX_ADVERTISE_URL_MUSIC` | Advertised URL for the `plex-music` server     | No       | -       | `https://plex-music.example.com:443` |
| `PLEX_TOKEN`               | Plex API token (CLI / rfmedia, not Compose)    | No       | -       | -                                    |
| `PLEX_DOCKER_DIR`          | Parent directory for Plex config and transcode | Yes      | -       | `/opt/plex`                          |

`PLEX_CLAIM` and `PLEX_CLAIM_MUSIC` must be different tokens. Generate each from
[plex.tv/claim](https://www.plex.tv/claim) immediately before the matching container starts; claim
tokens expire within minutes.

### tokenhop

tokenhop (formerly 9Router) uses the published GHCR image and stores persistent application state
under `${DOCKER_DIR}/tokenhop`. This deployment intentionally tracks the `latest` tag without a
digest pin.

| Variable                       | Description                                   | Required | Default                     |
| ------------------------------ | --------------------------------------------- | -------- | --------------------------- |
| `TOKENHOP_IMAGE`               | tokenhop image repository                     | No       | `ghcr.io/tokenhop/tokenhop` |
| `TOKENHOP_TAG`                 | Image tag                                     | No       | `latest`                    |
| `TOKENHOP_INITIAL_PASSWORD`    | Initial native dashboard password             | Yes      | -                           |
| `TOKENHOP_JWT_SECRET`          | Secret used to sign native dashboard sessions | Yes      | -                           |
| `TOKENHOP_API_KEY_SECRET`      | Secret protecting native API-key material     | Yes      | -                           |
| `TOKENHOP_MACHINE_ID_SALT`     | Salt used for the installation identity       | Yes      | -                           |
| `TOKENHOP_AUTH_COOKIE_SECURE`  | Restrict native login cookies to HTTPS        | No       | `true`                      |
| `TOKENHOP_ENABLE_REQUEST_LOGS` | Enable request metadata logging               | No       | `false`                     |
| `TOKENHOP_HEADROOM_URL`        | Internal Headroom compression endpoint        | No       | `http://headroom:8787`      |

These host-side variables map onto the container's unchanged upstream names (`JWT_SECRET`,
`INITIAL_PASSWORD`, `API_KEY_SECRET`, and so on).

Use unique random values for every required secret and keep the environment file restricted to
`0600`. tokenhop defaults its native `requireApiKey` setting to `true`, but does not consume a
`REQUIRE_API_KEY` environment variable. Verify that anonymous `/v1/models` access is denied after
the first start and every image update. See the [tokenhop Setup Guide](../services/tokenhop-setup.md)
for deployment, authentication, backup, and upgrade procedures.

Compose sets tokenhop's `BASE_URL` and `NEXT_PUBLIC_BASE_URL` values directly to
`https://tokenhop.${DOMAIN}`. They are intentionally not user-facing overrides: the public origin is
required for browser authentication and callback URL generation. `CLOUD_URL` and
`NEXT_PUBLIC_CLOUD_URL` still point at `https://9router.com`, the cloud endpoint the app reads.

### T3 Code (optional)

Used only by the `t3` bridge service (Compose profile `t3`). See
[T3 Code Setup](../services/t3-setup.md).

| Variable       | Description                                               | Required | Default |
| -------------- | --------------------------------------------------------- | -------- | ------- |
| `T3_HOST_PORT` | Host port of `t3code.service` that the bridge forwards to | No       | `3773`  |

### Headroom

Headroom runs as an internal-only compression service on the `apps` network. tokenhop reaches it at
`http://headroom:8787`; Compose publishes no Headroom host port and adds no Traefik, Docktail, or
Tailscale labels. Persistent state lives under `${DOCKER_DIR}/headroom`.

| Variable                   | Description                                    | Required | Default                            |
| -------------------------- | ---------------------------------------------- | -------- | ---------------------------------- |
| `HEADROOM_IMAGE`           | Official Headroom image repository             | No       | `ghcr.io/headroomlabs-ai/headroom` |
| `HEADROOM_TAG`             | Human-readable image release                   | No       | `0.37.0`                           |
| `HEADROOM_DIGEST`          | Immutable manifest digest for selected tag     | No       | See pinned digest below            |
| `HEADROOM_MODE`            | Proxy optimization mode                        | No       | `cache`                            |
| `HEADROOM_SAVINGS_PROFILE` | Compression profile                            | No       | `coding`                           |
| `HEADROOM_BEACON`          | Anonymous upstream usage beacon                | No       | `off`                              |
| `HEADROOM_TELEMETRY`       | Local-only stats and dashboard data collection | No       | `off`                              |

The pinned `0.37.0` digest is
`sha256:4e559273659ebc5ce8711a60278e288550fa596377af18a7058e10036d63ef0b`. Update the tag and
digest together after reviewing upstream releases and security advisories. Compose always sets
`HEADROOM_COMPRESS_ALLOW_REMOTE=1`; Headroom otherwise rejects `/v1/compress` requests originating
from the tokenhop container.

### ARR Stack (Sonarr, Radarr, etc.)

| Variable           | Description      | Required | Default | Example |
| ------------------ | ---------------- | -------- | ------- | ------- |
| `SONARR_API_KEY`   | Sonarr API key   | No       | -       | -       |
| `RADARR_API_KEY`   | Radarr API key   | No       | -       | -       |
| `PROWLARR_API_KEY` | Prowlarr API key | No       | -       | -       |
| `TAUTULLI_API_KEY` | Tautulli API key | No       | -       | -       |
| `AUTOBRR_API_KEY`  | Autobrr API key  | No       | -       | -       |
| `SABNZBD_API_KEY`  | SABnzbd API key  | No       | -       | -       |

### Theme Park (Theming)

| Variable   | Description           | Required | Default | Example                         |
| ---------- | --------------------- | -------- | ------- | ------------------------------- |
| `TP_THEME` | Theme Park theme name | No       | -       | `dracula`, `nord`, `aquamarine` |

### Homarr

| Variable            | Description                       | Required | Default | Example |
| ------------------- | --------------------------------- | -------- | ------- | ------- |
| `HOMARR_SECRET_KEY` | Encryption key for Homarr secrets | Yes      | -       | -       |

### Speedtest Tracker

| Variable            | Description             | Required | Default | Example       |
| ------------------- | ----------------------- | -------- | ------- | ------------- |
| `SPEEDTEST_APP_KEY` | Laravel application key | Yes      | -       | `base64:xxxx` |

### Immich

| Variable               | Description                 | Required | Default   | Example             |
| ---------------------- | --------------------------- | -------- | --------- | ------------------- |
| `IMMICH_VERSION`       | Immich Docker image version | No       | `release` | `release`, `v1.x.x` |
| `IMMICH_DB_PASSWORD`   | PostgreSQL password         | Yes      | -         | -                   |
| `IMMICH_DB_USERNAME`   | PostgreSQL username         | Yes      | -         | `immich`            |
| `IMMICH_DB_NAME`       | PostgreSQL database name    | Yes      | -         | `immich`            |
| `IMMICH_DATABASE_NAME` | Database name (alternate)   | Yes      | -         | `immich`            |

### Forgejo

| Variable                      | Description                                                                                                         | Required | Default   | Example                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------- | --------- | ------------------------- |
| `FORGEJO_DB_NAME`             | PostgreSQL database name                                                                                            | No       | `forgejo` | `forgejo`                 |
| `FORGEJO_DB_USER`             | PostgreSQL username                                                                                                 | No       | `forgejo` | `forgejo`                 |
| `FORGEJO_DB_PASSWORD`         | PostgreSQL password (secret)                                                                                        | Yes      | -         | -                         |
| `FORGEJO_RUNNER_INSTANCE_URL` | Public Forgejo URL (reference for `server.connections.url` if not using the internal URL)                           | No       | -         | `https://git.example.com` |
| `FORGEJO_RUNNER_INTERNAL_URL` | Docker-network URL for runner-to-Forgejo traffic; typical value for `server.connections.url` in `runner-config.yml` | No       | -         | `http://forgejo:3000`     |

> **Note:** `FORGEJO_DB_PASSWORD` is a secret and should be injected via dotenvx or 1Password CLI.
> Forgejo Git SSH is exposed on the tailnet through Docktail at `git.${TS_DOMAIN}:22`; Traefik only
> exposes Forgejo HTTP(S). Forgejo Actions runner credentials
> (UUID and token) belong in `${DOCKER_DIR}/forgejo-runner/runner-config.yml` and
> `${DOCKER_DIR}/forgejo-runner/runner-token`, not in `.env`. See
> [Forgejo setup](../services/forgejo-setup.md).

### Kometa (Plex Meta Manager)

| Variable                   | Description               | Required | Default | Example |
| -------------------------- | ------------------------- | -------- | ------- | ------- |
| `KOMETA_MAL_CLIENT_ID`     | MyAnimeList client ID     | No       | -       | -       |
| `KOMETA_MAL_CLIENT_SECRET` | MyAnimeList client secret | No       | -       | -       |
| `MDBLIST_API_KEY`          | MDBList API key           | No       | -       | -       |

## Tailscale Variables

Configuration for Docktail-managed Tailscale Services (active) and legacy sidecar variables.

| Variable                        | Description                                      | Required | Default         | Example               |
| ------------------------------- | ------------------------------------------------ | -------- | --------------- | --------------------- |
| `TAILSCALE_OAUTH_CLIENT_ID`     | Docktail OAuth client ID for service management  | Yes      | -               | -                     |
| `TAILSCALE_OAUTH_CLIENT_SECRET` | Docktail OAuth client secret                     | Yes      | -               | -                     |
| `TS_DOMAIN`                     | Tailscale MagicDNS domain                        | Yes      | -               | `tailnet-name.ts.net` |
| `DOCKTAIL_DEFAULT_SERVICE_TAGS` | Default tags Docktail assigns to created service | No       | `tag:container` | `tag:container`       |
| `DOCKTAIL_LOG_LEVEL`            | Docktail log level                               | No       | `info`          | `info`                |
| `DOCKTAIL_RECONCILE_INTERVAL`   | Docktail reconciliation interval                 | No       | `60s`           | `60s`                 |
| `TS_AUTHKEY`                    | **Legacy** — former sidecar authentication key   | No       | -               | `tskey-auth-xxxx`     |
| `TSDPROXY_AUTHKEY`              | Auth key for `tsdproxy-rfapps` config file       | No       | -               | `tskey-auth-xxxx`     |

Docktail uses the host-running-Tailscale mode and mounts `/var/run/tailscale` from the host. The
host Tailscale node must be allowed to advertise Tailscale Services for the configured Docktail
service tag. Docktail advertises Traefik, `jellyfin`, `images` (Immich), and `uptime` among other
labeled services. Forgejo (`git`) and both Plex instances (`plex`, `plex-music`) use
`tsdproxy-rfapps` instead — populate `${DOCKER_DIR}/tsdproxy-rfapps/config/tsdproxy.yaml` with
`TSDPROXY_AUTHKEY`.

### Legacy Sidecar Environment (removed from this deployment)

These variables applied to the removed Tailscale sidecar containers (`plex-ts`, `jellyfin-ts`,
`immich-ts`). Retained for reference when using sidecars in custom forks:

| Variable          | Description                    | Default                                                                           |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------------- |
| `TS_STATE_DIR`    | Tailscale state directory      | `/var/lib/tailscale`                                                              |
| `TS_USERSPACE`    | Userspace networking mode      | `false`                                                                           |
| `TS_SERVE_CONFIG` | Path to serve configuration    | `/config/config.json`                                                             |
| `TS_ACCEPT_DNS`   | Accept DNS from Tailscale      | `true` (dns-enabled) / `false` (dns-disabled)                                     |
| `TS_EXTRA_ARGS`   | Additional Tailscale arguments | `--accept-routes=false --accept-dns=true --advertise-tags=tag:docker,tag:network` |
| `TS_HOSTNAME`     | Hostname in Tailnet            | Service-specific                                                                  |

## Script Configuration Variables (Deprecated)

> **DEPRECATION NOTICE**
>
> The following variables were part of the legacy `manage.sh` script system and are **no longer
> used**. The `rfapps` CLI does not use these configuration variables.
>
> This section is retained for historical reference only. If you are migrating from the old
> `manage.sh` script, these variables can be safely removed from your environment files.

### Logging Configuration (Legacy)

| Variable             | Description                  | Default  | Values                           |
| -------------------- | ---------------------------- | -------- | -------------------------------- |
| `LOG_TO_FILE`        | Enable logging to file       | `false`  | `true`, `false`                  |
| `LOG_LEVEL`          | Minimum log level to display | `INFO`   | `DEBUG`, `INFO`, `WARN`, `ERROR` |
| `LOG_DIR`            | Directory for log files      | `./logs` | Any valid path                   |
| `LOG_RETENTION_DAYS` | Days to keep log files       | `30`     | `0` = disable cleanup            |

### Docker Cleanup Configuration (Legacy)

| Variable           | Description                           | Default | Values          |
| ------------------ | ------------------------------------- | ------- | --------------- |
| `PRUNE_IMAGES`     | Remove unused images after operations | `true`  | `true`, `false` |
| `PRUNE_NETWORKS`   | Remove unused networks after stopping | `true`  | `true`, `false` |
| `PRUNE_VOLUMES`    | Remove unused volumes after stopping  | `false` | `true`, `false` |
| `PRUNE_ALL_IMAGES` | Remove ALL unused images              | `false` | `true`, `false` |

### Health Check Configuration (Legacy)

| Variable                | Description                               | Default | Notes             |
| ----------------------- | ----------------------------------------- | ------- | ----------------- |
| `HEALTH_CHECK_TIMEOUT`  | Max wait time for health checks (seconds) | `300`   | `0` = disable     |
| `HEALTH_CHECK_INTERVAL` | Time between health check polls (seconds) | `5`     | -                 |
| `HEALTH_CHECK_SERVICES` | Space-separated list of critical services | Empty   | Empty = check all |

### Backup Configuration (Legacy)

| Variable                | Description                             | Default     | Notes                 |
| ----------------------- | --------------------------------------- | ----------- | --------------------- |
| `BACKUP_ON_STOP`        | Create backups before stopping services | `false`     | -                     |
| `BACKUP_DIR`            | Backup storage directory                | `./backups` | -                     |
| `BACKUP_RETENTION_DAYS` | Days to keep backups                    | `7`         | `0` = disable cleanup |
| `BACKUP_COMPRESSION`    | Compress backups with gzip              | `true`      | -                     |

### Startup Configuration (Legacy)

| Variable              | Description                          | Default   | Notes                        |
| --------------------- | ------------------------------------ | --------- | ---------------------------- |
| `PULL_BEFORE_START`   | Pull latest images before starting   | `true`    | -                            |
| `PULL_TIMEOUT`        | Max time for image pulls (seconds)   | `600`     | `0` = no timeout             |
| `PULL_POLICY`         | Docker pull policy                   | `always`  | `always`, `missing`          |
| `START_TIMEOUT`       | Max time for service start (seconds) | `300`     | `0` = no timeout             |
| `RECREATE_CONTAINERS` | When to recreate containers          | `changed` | `always`, `never`, `changed` |

### Environment Configuration (Legacy)

| Variable            | Description                    | Default                                   | Notes                   |
| ------------------- | ------------------------------ | ----------------------------------------- | ----------------------- |
| `ENV_FILE`          | Path to environment file       | `.env.local`                              | -                       |
| `ENV_TOOL`          | Tool for loading environment   | `dotenvx`                                 | `dotenvx`, `op`, `none` |
| `ENV_VALIDATION`    | Validate required variables    | `true`                                    | -                       |
| `REQUIRED_ENV_VARS` | Required variables to validate | `DOCKER_DIR DOCKER_DATA_DIR TZ PUID PGID` | Space-separated         |

### Notification Configuration (Legacy)

| Variable               | Description                             | Default | Notes |
| ---------------------- | --------------------------------------- | ------- | ----- |
| `ENABLE_NOTIFICATIONS` | Send notifications on completion/errors | `false` | -     |
| `NOTIFICATION_URL`     | Webhook URL for notifications           | Empty   | -     |
| `NOTIFY_ON_SUCCESS`    | Notify on successful operations         | `false` | -     |
| `NOTIFY_ON_ERROR`      | Notify on errors                        | `true`  | -     |

### Advanced Configuration (Legacy)

| Variable               | Description                       | Default         | Notes                        |
| ---------------------- | --------------------------------- | --------------- | ---------------------------- |
| `DRY_RUN`              | Preview actions without executing | `false`         | -                            |
| `VERBOSE`              | Enable verbose output             | `false`         | -                            |
| `PARALLEL_OPERATIONS`  | Enable parallel Docker operations | `true`          | -                            |
| `COMPOSE_FILE`         | Path to compose.yml               | `./compose.yml` | -                            |
| `COMPOSE_PROJECT_NAME` | Docker Compose project name       | Empty           | Uses directory name if empty |
| `STOP_TIMEOUT`         | Graceful stop timeout (seconds)   | `10`            | -                            |
| `REMOVE_ORPHANS`       | Remove orphaned containers        | `true`          | -                            |
| `ENABLE_COLORS`        | Enable colored terminal output    | `true`          | Auto-disabled if not TTY     |

## Registry and Authentication

| Variable         | Description                        | Required | Default | Example    |
| ---------------- | ---------------------------------- | -------- | ------- | ---------- |
| `GHCR_USERNAME`  | GitHub Container Registry username | No       | -       | `username` |
| `GHCR_TOKEN`     | GitHub Container Registry token    | No       | -       | `ghp_xxxx` |
| `SWARM_TOKEN`    | Docker Swarm join token            | No       | -       | -          |
| `SWARM_JOIN_CMD` | Docker Swarm join command          | No       | -       | -          |

## Miscellaneous

| Variable                  | Description                       | Required | Default | Example         |
| ------------------------- | --------------------------------- | -------- | ------- | --------------- |
| `HOMEAUTO_SERVER`         | Home automation server address    | No       | -       | `192.168.1.100` |
| `ANSIBLE_PROJECT_ROOT`    | Ansible project root path         | No       | -       | -               |
| `DOTENV_PUBLIC_KEY_LOCAL` | Dotenvx public key for encryption | No       | -       | -               |

## Usage Examples

### Setting Core Variables

```bash
# In .env.local
TZ=America/New_York
PUID=1000
PGID=1000
DOCKER_DIR=/opt/docker/config
DOCKER_DATA_DIR=/opt/docker/data
DATA_DIR=/mnt/media
```

### Using Environment Arguments

```bash
# Use local environment (default)
rfapps deploy -e .env.local --yes

# Use production environment
rfapps deploy -e .env.prod --yes

# Override specific variable
LOG_LEVEL=DEBUG rfapps deploy --yes
```

### Customizing CLI Behavior

```bash
# Enable verbose output with health check customization
rfapps deploy -v --health-timeout 600 --yes

# Dry run to preview actions
rfapps rebuild --dry-run

# Use with secrets injection (dotenvx)
rfapps deploy --use-dotenvx .env.local --yes

# Use with secrets injection (1Password)
rfapps deploy --use-op .env --yes
```

## Security Notes

1. **Never commit `.env` files** to version control
2. Use dotenvx encryption or 1Password CLI for secret management
3. Generate unique, strong passwords for all database credentials
4. Keep API keys and tokens confidential
5. Rotate `TS_AUTHKEY` periodically for Tailscale security
6. Use separate Cloudflare API tokens with minimal permissions

## Related Documentation

- [Docker Compose Extensions](/docs/features/compose-extensions.md)
- [Tailscale Integration](/docs/features/tailscale-integration.md)
- [Traefik Reverse Proxy](/docs/features/traefik-reverse-proxy.md)
- [rfapps CLI](/packages/rfapps-cli/README.md)
