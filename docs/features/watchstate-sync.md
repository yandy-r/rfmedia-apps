# WatchState Sync

## Overview

WatchState is a web application that synchronizes **users' play state, watched status, and
progress** across media servers such as Jellyfin, Plex, and Emby. It supports one-way or two-way
sync so watch history stays consistent when users split time between Plex and Jellyfin.

## Architecture

### Components

1. **WatchState Service** - Main sync application
   - Container: `watchstate`
   - Web interface on port `8080`
   - Runs on the `apps` bridge network
   - Configuration stored in `${DOCKER_DIR}/watchstate`
   - Runs as `user: "0:0"` (required for `/config` writes under Docker)

2. **Media Backends** - Plex, Jellyfin, or Emby
   - Configured in the WatchState WebUI (backends page)
   - Communicates over the internal `apps` network using backend hostnames and API tokens
   - No Tailscale sidecar required

3. **Traefik Routing** - HTTPS access
   - Public access via `watchstate.${DOMAIN2}`
   - Protected by Authentik media middleware

### Data Flow

1. **User Access** → Public DNS → Traefik reverse proxy
2. **Authentication** → Authentik media middleware validates session
3. **Backend Events** → Plex/Jellyfin webhooks or scheduled import/export tasks
4. **WatchState Processing** → Normalizes play state and maps users across backends
5. **Sync Output** → Updated watched status and progress pushed to target backends

## Features

### Sync Capabilities

- **Watched Status** - Mark items watched or unwatched across backends
- **Progress Tracking** - Resume position and partial watch state
- **User Mapping** - Link accounts on different media servers
- **Direction Control** - One-way or two-way sync per backend pair

### Import Methods

WatchState supports three ways to ingest play-state changes:

1. **Scheduled Tasks** - Cron-style import/export via optional environment variables
2. **On-Demand** - Manual sync from the WebUI or CLI inside the container
3. **Webhooks** - Real-time updates when Plex or Jellyfin reports playback events

### Authentication

- **Authentik Integration** - Uses `authentik-media` middleware
- **First-Run Setup** - WatchState creates a system user on initial startup
- **Backend Tokens** - Plex/Jellyfin API tokens configured in the WebUI, not in static files

## Configuration

### Service Definition

```yaml
watchstate:
  <<: *service-base
  container_name: watchstate
  hostname: watchstate
  user: "0:0"
  networks:
    apps: {}
  logging: *logging-default
  healthcheck:
    test: curl --fail --silent --show-error http://localhost:8080 || exit 1
    interval: 20s
    retries: 5
    start_period: 30s
    timeout: 5s
  environment:
    <<: *common-env
  labels:
    traefik.enable: true
    traefik.http.routers.watchstate.rule: Host(`watchstate.${DOMAIN2}`)
    traefik.http.routers.watchstate.entrypoints: websecure
    traefik.http.routers.watchstate.tls: true
    traefik.http.routers.watchstate.tls.certresolver: letsencrypt
    traefik.http.routers.watchstate.tls.domains[0].main: watchstate.${DOMAIN2}
    traefik.http.services.watchstate.loadbalancer.server.port: 8080
    traefik.http.services.watchstate.loadbalancer.server.scheme: http
    traefik.http.routers.watchstate.middlewares: authentik-media@docker
  volumes:
    - /etc/localtime:/etc/localtime:ro
    - ${DOCKER_DIR}/watchstate:/config
  image: ghcr.io/arabcoders/watchstate:latest
```

### Config Directory Permissions

WatchState **must** be able to write to `/config`. The service runs as root (`0:0`) per upstream
guidance for Docker deployments. Before first deploy, ensure the host directory is owned by root:

```bash
mkdir -p "${DOCKER_DIR}/watchstate"
sudo chown -R 0:0 "${DOCKER_DIR}/watchstate"
```

If permissions are wrong, the container exits on startup with an error such as:
`Unable to write to [/config] data directory`.

### Optional Scheduled Sync

Add optional environment variables under the `environment` section to enable cron-style tasks.
Values use standard cron syntax (minute hour day month weekday):

```yaml
environment:
  <<: *common-env
  WS_CRON_IMPORT: "*/15 * * * *"   # Import play state from backends every 15 minutes
  WS_CRON_EXPORT: "0 * * * *"      # Export play state to backends hourly
```

Other optional variables (see upstream WatchState docs for the full list):

- `WS_CRON_PUSH` - Push queued changes on a schedule
- `WS_CRON_PURGE` - Purge old logs or queue entries

Backends, user mappings, and API tokens are configured in the WebUI after first login.

### Webhook URL Pattern

After adding Plex or Jellyfin backends in the WebUI, copy the webhook URL from the backends page.
The public pattern (via Traefik) is:

```text
https://watchstate.${DOMAIN2}/webhooks/{backend-token}
```

Replace `{backend-token}` with the token shown on the backend configuration page in WatchState.
Configure that URL in Plex or Jellyfin webhook settings for real-time sync.

## Environment Variables

Required environment variables in `.env`:

- `DOMAIN2` - Domain for WatchState URL (`watchstate.${DOMAIN2}`)
- `DOCKER_DIR` - Base directory for configuration storage
- `TZ` - Timezone setting

Optional scheduled-sync variables (see [Optional Scheduled Sync](#optional-scheduled-sync)):

- `WS_CRON_IMPORT` - Cron schedule for importing from backends
- `WS_CRON_EXPORT` - Cron schedule for exporting to backends

## Access URLs

- **Public Access**: `https://watchstate.${DOMAIN2}` (via Traefik)
- **Authentication**: Required via Authentik media middleware
- **First Run**: Complete initial setup in the WebUI; a system user is created automatically

## rfapps Usage

```bash
# Deploy WatchState only
rfapps deploy -s watchstate --yes

# Rebuild after config or image changes
rfapps rebuild -s watchstate --yes

# Deploy the full media stack (includes watchstate)
rfapps deploy -g media-stack --yes
rfapps rebuild -g media-stack --yes

# Preview media-stack plan
rfapps plan -g media-stack --dry-run
```

## Security Considerations

1. **Authentik Protection** - WebUI access requires a valid Authentik session
2. **Backend Tokens** - Store Plex/Jellyfin API tokens only in WatchState's encrypted config (via WebUI)
3. **Webhook URLs** - Treat backend webhook tokens as secrets; rotate if exposed
4. **Network Isolation** - Runs on the isolated `apps` network; backends reached by internal hostname
5. **TLS Encryption** - HTTPS enforced via Traefik with Let's Encrypt certificates

## Implementation Files

- `compose.yml` - WatchState service definition (media section, after `jellyseerr`)
- `rfapps.config.yaml` - `media-stack` group and `media` profile mapping
- `${DOCKER_DIR}/watchstate/` - Persistent configuration and database

## Use Cases

### Jellyfin ↔ Plex Progress Sync

Keep watch progress aligned when family members use Jellyfin on one device and Plex on another:

- Map Jellyfin and Plex users in the WebUI
- Enable two-way sync or one-way import from the primary server
- Use webhooks for near-real-time updates during playback

### Consolidated Watch History

Import historical watch data from multiple backends into WatchState, then export a unified state:

- Run an on-demand import after initial backend setup
- Schedule `WS_CRON_IMPORT` / `WS_CRON_EXPORT` for ongoing maintenance

## Troubleshooting

### Common Issues

1. **Container exits immediately**: Check `${DOCKER_DIR}/watchstate` ownership is `0:0`

   ```bash
   ls -la "${DOCKER_DIR}/watchstate"
   sudo chown -R 0:0 "${DOCKER_DIR}/watchstate"
   ```

2. **WebUI not loading**: Check Traefik and WatchState logs

   ```bash
   docker logs traefik
   docker logs watchstate
   ```

3. **Sync not updating**: Verify backend tokens and user mappings in the WebUI; confirm webhooks
   reach `https://watchstate.${DOMAIN2}/webhooks/{token}`

4. **Authentication loop**: Confirm Authentik media outpost is running

   ```bash
   docker logs authentik-media
   ```

### Debug Mode

View WatchState logs for troubleshooting:

```bash
docker logs watchstate --follow
```

## Integration with Other Services

WatchState integrates with the platform's media stack:

- **Plex** / **Jellyfin** - Source and target backends for play-state sync
- **Traefik** - HTTPS routing and SSL certificates
- **Authentik** - Unified authentication for the WebUI
- **Tautulli** - Complementary Plex analytics (does not replace WatchState sync)

## Configuration Best Practices

1. **Fix Permissions First** - Create and `chown 0:0` `${DOCKER_DIR}/watchstate` before first deploy
2. **Map Users Explicitly** - Link Plex and Jellyfin accounts in the WebUI before enabling two-way sync
3. **Start with One-Way Sync** - Validate behavior on a test library before enabling bidirectional export
4. **Use Webhooks for Live Playback** - Combine scheduled import with webhooks for best latency
5. **Backup Configuration** - Regularly backup `${DOCKER_DIR}/watchstate`

## Related Documentation

- [Quick Reference](quick-reference.md) - Common commands and shortcuts
- [Traefik Reverse Proxy](traefik-reverse-proxy.md) - Routing and SSL configuration
- [Authentik Integration](authentik-integration.md) - SSO and authentication
- [Compose Profiles](compose-profiles.md) - Media profile and service groups
- [Docker Compose Extensions](docker-compose-extensions.md) - Service configuration patterns
- [Troubleshooting Guide](../guides/troubleshooting.md) - Common issues and recovery
