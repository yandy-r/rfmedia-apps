# Homarr Dashboard

## Overview

Homarr is a customizable dashboard and homepage application that provides a centralized interface for organizing, accessing, and monitoring all self-hosted services in the platform. It integrates with Docker to automatically discover services and provides widgets for real-time status monitoring.

## Architecture

### Components

1. **Homarr Service** - Main dashboard application
   - Container: `homarr`
   - Web interface on port 7575
   - Runs on the `apps` bridge network
   - Configuration stored in `${DOCKER_DIR}/homarr`
   - Runs with user permissions (PUID/PGID)

2. **Docker Socket Integration** - Dynamic service discovery
   - Read-only access to `/var/run/docker.sock`
   - Automatically detects running containers
   - Provides real-time status monitoring

3. **Traefik Routing** - HTTPS access
   - Public access via `homarr.${DOMAIN2}`
   - Protected by Authentik media middleware

### Data Flow

1. **User Access** → Public DNS → Traefik reverse proxy
2. **Authentication** → Authentik media middleware validates session
3. **Dashboard Load** → Homarr serves customizable homepage
4. **Service Discovery** → Homarr queries Docker socket for container status
5. **Widget Updates** → Real-time monitoring of service health and metrics

## Features

### Dashboard Capabilities

- **Customizable Layout** - Drag-and-drop interface for organizing service tiles
- **Service Widgets** - Pre-configured integrations for common applications
- **Status Monitoring** - Real-time health checks and uptime tracking
- **Quick Access** - Direct links to all self-hosted services
- **Custom Widgets** - Support for RSS feeds, weather, calendar, and more

### Docker Integration

- **Auto-Discovery** - Automatically finds running Docker containers
- **Label-Based Config** - Uses Docker labels for service metadata
- **Status Indicators** - Shows container health and running state
- **Resource Metrics** - Displays CPU, memory, and network usage

### Authentication

- **Authentik Integration** - Uses `authentik-media` middleware
- **Session Management** - Single sign-on across all platform services
- **Access Control** - Centralized user permissions via Authentik

## Configuration

### Service Definition

```yaml
homarr:
  <<: *service-base
  container_name: homarr
  networks:
    apps: {}
  logging: *logging-default
  environment:
    <<: *common-env
    SECRET_ENCRYPTION_KEY: ${HOMARR_SECRET_KEY}
  labels:
    traefik.enable: true
    traefik.http.routers.homarr.rule: Host(`homarr.${DOMAIN2}`)
    traefik.http.routers.homarr.entrypoints: websecure
    traefik.http.routers.homarr.tls: true
    traefik.http.routers.homarr.tls.certresolver: letsencrypt
    traefik.http.routers.homarr.tls.domains[0].main: homarr.${DOMAIN2}
    traefik.http.services.homarr.loadbalancer.server.port: 7575
    traefik.http.services.homarr.loadbalancer.server.scheme: http
    traefik.http.routers.homarr.middlewares: authentik-media@docker
  volumes:
    - /etc/localtime:/etc/localtime:ro
    - /var/run/docker.sock:/var/run/docker.sock:ro
    - ${DOCKER_DIR}/homarr:/appdata
  image: ghcr.io/homarr-labs/homarr:latest
```

## Environment Variables

Required environment variables in `.env`:

- `DOMAIN2` - Domain for Homarr dashboard URL (homarr.${DOMAIN2})
- `HOMARR_SECRET_KEY` - Encryption key for sensitive data storage
- `DOCKER_DIR` - Base directory for configuration storage
- `TZ` - Timezone setting
- `PUID`/`PGID` - User and group IDs for file permissions

## Access URLs

- **Public Access**: `https://homarr.${DOMAIN2}` (via Traefik)
- **Authentication**: Required via Authentik media middleware

## Security Considerations

1. **Docker Socket Access** - Read-only mounting prevents container manipulation
2. **Authentik Protection** - All access requires valid authentication session
3. **Network Isolation** - Runs on isolated `apps` network
4. **Encryption Key** - Sensitive data encrypted with `HOMARR_SECRET_KEY`
5. **TLS Encryption** - HTTPS enforced via Traefik with Let's Encrypt certificates

## Implementation Files

- `compose.yml` - Homarr service definition (lines 1045-1082)
- `${DOCKER_DIR}/homarr/` - Configuration and data directory

## Use Cases

### Primary Homepage

Set Homarr as the default homepage for quick access to all services:

- Family members can bookmark `homarr.${DOMAIN2}`
- Single dashboard for all media and utility services
- Status at-a-glance for service availability

### Service Monitoring

Monitor the health of all containerized services:

- Real-time status indicators for each service
- Quick identification of down or unhealthy containers
- Resource usage tracking

### Quick Navigation

Organize services by category for easy access:

- Media services (Plex, Sonarr, Radarr, etc.)
- Download clients (SABnzbd, Prowlarr)
- Utilities (Uptime Kuma, Stirling PDF)
- Infrastructure (Traefik, Authentik, Uptime Kuma)

## Troubleshooting

### Common Issues

1. **Dashboard not loading**: Check Traefik and Homarr logs for routing errors

   ```bash
   docker logs traefik
   docker logs homarr
   ```

2. **Services not discovered**: Verify Docker socket permissions

   ```bash
   docker exec homarr ls -l /var/run/docker.sock
   ```

3. **Authentication loop**: Confirm Authentik media outpost is running

   ```bash
   docker logs authentik-media
   ```

### Debug Mode

View Homarr logs for troubleshooting:

```bash
docker logs homarr --follow
```

## Integration with Other Services

Homarr complements the platform's existing infrastructure:

- **Traefik** - Provides HTTPS routing and SSL certificates
- **Authentik** - Provides unified authentication layer
- **Docker** - Source for service discovery and monitoring
- **Uptime Kuma** - Can be embedded as widget for additional monitoring

## Configuration Best Practices

1. **Organize by Category** - Group similar services together on the dashboard
2. **Use Docker Labels** - Add metadata to containers for better auto-discovery
3. **Custom Widgets** - Configure integrations for enhanced monitoring (Sonarr, Radarr, etc.)
4. **Backup Configuration** - Regularly backup `${DOCKER_DIR}/homarr` directory
5. **Update Regularly** - Keep Homarr updated for latest features and security fixes

## Related Documentation

- [Quick Reference](quick-reference.md) - Common commands and shortcuts
- [Traefik Reverse Proxy](traefik-reverse-proxy.md) - Routing and SSL configuration
- [Authentik Integration](authentik-integration.md) - SSO and authentication
- [Tailscale Integration](tailscale-integration.md) - Docktail tailnet entry point
- [Docker Compose Extensions](docker-compose-extensions.md) - Service configuration patterns
- [Troubleshooting Guide](../guides/troubleshooting.md) - Common issues and recovery
