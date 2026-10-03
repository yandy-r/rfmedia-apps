# Traefik Reverse Proxy with Authentik Forward Authentication

## Overview

This project uses Traefik as the primary reverse proxy for all containerized services, integrated with Authentik for forward authentication. This provides centralized routing, automatic SSL certificate management via Let's Encrypt, and unified authentication across all services.

## Architecture

### Components

1. **Traefik** - Modern reverse proxy and load balancer
   - Container: `traefik`
   - Network: Docker `apps` bridge network
   - Tailnet access: Advertised by Docktail as a Tailscale Service
   - Dashboard available at `traefik.${DOMAIN}` (and via tailnet through Docktail)

2. **Authentik Forward Authentication** - Two separate middleware instances
   - `authentik-dev` - For development/infrastructure services
   - `authentik-media` - For media management services

3. **Service Integration** - All services configured with Traefik labels for routing

### Data Flow

1. **External Request** → Tailnet (Docktail) or Cloudflare tunnel → Traefik on `apps`
2. **Traefik** → Checks routing rules (Host-based routing)
3. **Traefik** → Applies Authentik middleware (if configured)
4. **Authentik** → Validates user session/credentials
5. **Traefik** → Forwards to backend service on success
6. **Backend Service** → Returns response through Traefik

## Service Categories

### Infrastructure Services (authentik-dev middleware)

- **traefik** - Traefik dashboard (traefik.${DOMAIN})
- **authentik-dev** - Authentik development instance (authentik.${DOMAIN})
- **speedtest-tracker** - Network speed monitoring (speedtest.${DOMAIN})
- **uptime-kuma** - Uptime monitoring (uptime.${DOMAIN})

### Media Services (authentik-media middleware)

- **sabnzbd** - Usenet downloader (sabnzbd.${DOMAIN2})
- **prowlarr** - Indexer manager (prowlarr.${DOMAIN2})
- **autobrr** - IRC announce automation (autobrr.${DOMAIN2})
- **notifiarr** - Notification integration (notifiarr.${DOMAIN2})
- **bazarr** - Subtitle management (bazarr.${DOMAIN2})
- **tautulli** - Plex analytics (tautulli.${DOMAIN2})
- **plexseerr** - Plex media requests (plexseerr.${DOMAIN2})
- **jellyseerr** - Jellyfin media requests (jellyseerr.${DOMAIN2})

### External Services (authentik-dev-file middleware)

External services running on separate servers can be proxied through Traefik using file-based configuration:

- **homebridge** - HomeKit bridge (homebridge.${DOMAIN})
- **homeassistant** - Home automation platform (ha.${DOMAIN})
- **scrypted** - Camera and NVR platform (scrypted.${DOMAIN})
- **zigbee2mqtt** - Zigbee device bridge (z2m.${DOMAIN})

These services are defined in file-based Traefik configuration files and route to `${HOMEAUTO_SERVER}`.

### Services Without Authentication

- **plex** - Media server (plex.${DOMAIN2}) - Uses native Plex authentication
- **plex-music** - Music Plex instance (plex-music.${DOMAIN2}) - Uses native Plex authentication
- **uptime-kuma** - Uptime monitoring - Explicitly excluded from Authentik middleware
- **forgejo** - Git forge (git.${DOMAIN}, forgejo.${DOMAIN}) - Uses native Forgejo authentication for web UI, Git HTTP, webhooks, and API tokens. Git SSH is exposed on the tailnet through tsdproxy host `git`, not Traefik.

## Configuration Pattern

Each service integrated with Traefik follows this label pattern:

```yaml
labels:
  # Enable Traefik for this service
  traefik.enable: true

  # Define routing rule (Host-based)
  traefik.http.routers.<service>.rule: Host(`<service>.${DOMAIN}`)

  # Configure HTTPS entrypoint
  traefik.http.routers.<service>.entrypoints: websecure

  # Enable TLS
  traefik.http.routers.<service>.tls: true

  # Use Let's Encrypt for certificate
  traefik.http.routers.<service>.tls.certresolver: letsencrypt

  # Configure TLS domain
  traefik.http.routers.<service>.tls.domains[0].main: <service>.${DOMAIN}

  # Define backend service details
  traefik.http.services.<service>.loadbalancer.server.port: <port>
  traefik.http.services.<service>.loadbalancer.server.scheme: http|https

  # Apply Authentik middleware (optional)
  traefik.http.routers.<service>.middlewares: authentik-dev@docker|authentik-media@docker
```

## Authentik Middleware Configuration

Two separate middleware instances provide authentication for different service groups:

### authentik-dev Middleware

```yaml
traefik.http.middlewares.authentik-dev.forwardauth.address: https://authentik-server:9443/outpost.goauthentik.io/auth/traefik
traefik.http.middlewares.authentik-dev.forwardauth.tls.insecureSkipVerify: true
traefik.http.middlewares.authentik-dev.forwardauth.trustForwardHeader: true
traefik.http.middlewares.authentik-dev.forwardauth.maxResponseBodySize: "1048576"
traefik.http.middlewares.authentik-dev.forwardauth.authResponseHeaders: X-authentik-username,X-authentik-groups,X-authentik-entitlements,X-authentik-email,X-authentik-name,X-authentik-uid,X-authentik-jwt,X-authentik-meta-jwks,X-authentik-meta-outpost,X-authentik-meta-provider,X-authentik-meta-app,X-authentik-meta-version
```

### authentik-media Middleware

```yaml
traefik.http.middlewares.authentik-media.forwardauth.address: https://authentik-server:9443/outpost.goauthentik.io/auth/traefik
traefik.http.middlewares.authentik-media.forwardauth.tls.insecureSkipVerify: true
traefik.http.middlewares.authentik-media.forwardauth.trustForwardHeader: true
traefik.http.middlewares.authentik-media.forwardauth.maxResponseBodySize: "1048576"
traefik.http.middlewares.authentik-media.forwardauth.authResponseHeaders: X-authentik-username,X-authentik-groups,X-authentik-entitlements,X-authentik-email,X-authentik-name,X-authentik-uid,X-authentik-jwt,X-authentik-meta-jwks,X-authentik-meta-outpost,X-authentik-meta-provider,X-authentik-meta-app,X-authentik-meta-version
```

## SSL Certificate Management

Traefik automatically manages SSL certificates using Let's Encrypt:

- **Certificate Resolver**: `letsencrypt`
- **Storage**: `/etc/traefik/acme/acme.json`
- **Domains**: Supports multiple domains via `${DOMAIN}` and `${DOMAIN2}`
- **SANs**: Subject Alternative Names configured for additional domain coverage

## Network Integration

### Tailscale Integration (Docktail)

Traefik connects directly to the `apps` Docker bridge network. **Docktail** advertises Traefik HTTPS
over the tailnet using `docktail.service.*` labels (same pattern as `uptime-kuma`).

- **docktail** - Tailscale Services reconciler (host daemon mode)
- **traefik** - Reverse proxy on `apps`; reached by tailnet clients via Docktail

Direct media and photo services are advertised on the tailnet in addition to Traefik host routing:
`plex` and `plex-music` via tsdproxy hosts, and `jellyfin` / `immich-server` (`images`) via Docktail
labels.

### Docker Network

All services connect to the `apps` custom bridge network, allowing Traefik to route traffic to backend services by container name.

## Implementation Files

- `compose.yml` - Service definitions and Traefik labels
- `${DOCKER_DIR}/traefik/` - Traefik configuration directory (formerly `config/traefik-external/`)
- `${DOCKER_DIR}/traefik/acme/acme.json` - Let's Encrypt certificate storage
- `config/traefik/` - File-based configuration for both Docker and external services
  - Static configuration files for Traefik routing rules
  - Dynamic configuration for services outside the Docker stack

## Environment Variables

Required environment variables in `.env`:

- `DOMAIN` - Primary domain for infrastructure services
- `DOMAIN2` - Secondary domain for media services
- `SAN_DOMAIN` - Subject Alternative Name for primary domain
- `SAN_DOMAIN2` - Subject Alternative Name for secondary domain
- `HOMEAUTO_SERVER` - IP address or hostname of external home automation server

## Security Considerations

1. **TLS Encryption** - All services use HTTPS via Let's Encrypt certificates
2. **Forward Authentication** - Centralized authentication via Authentik
3. **Network Isolation** - Services only accessible through Traefik proxy
4. **Tailscale Access** - Additional network-level security via Tailscale VPN
5. **Middleware Separation** - Different authentication policies for different service categories

## Troubleshooting

### Common Issues

1. **Service not accessible**: Check Traefik logs for routing errors

   ```bash
   docker logs traefik
   ```

2. **Authentication loop**: Verify Authentik outpost is running and configured

   ```bash
   docker logs authentik-server
   docker logs authentik-worker
   ```

3. **Certificate issues**: Check Let's Encrypt rate limits and DNS configuration

   ```bash
   docker exec traefik cat /etc/traefik/acme/acme.json
   ```

### Debug Mode

Enable debug logging in Traefik by adding to command arguments:

```yaml
command:
  - --log.level=DEBUG
```

## External Service Routing

Traefik can route to services running on external servers using file-based configuration providers. This allows centralized access control and SSL termination for services not running in the Docker stack.

### Configuration Structure

External services are defined in file-based Traefik configuration with two components:

1. **Service Routing** - Defines routers and backend services
2. **Middleware** - Defines authentication middleware for file-based configs

### Example: Home Automation Services

The home automation configuration demonstrates routing to services on a separate server:

```yaml
http:
  routers:
    homebridge:
      rule: Host(`homebridge.{{ env "DOMAIN" }}`)
      entryPoints:
        - websecure
      service: homebridge
      middlewares:
        - authentik-dev-file
      tls:
        certResolver: letsencrypt

  services:
    homebridge:
      loadBalancer:
        servers:
          - url: http://{{ env "HOMEAUTO_SERVER" }}:8581
```

This pattern enables:

- Centralized SSL certificate management
- Unified authentication via Authentik
- Single point of access through Tailscale
- Consistent routing rules across all services

## Adding a New Service

To add Traefik routing to a new Docker service:

1. **Add Traefik labels to service definition**:

   ```yaml
   service-name:
     container_name: service-name
     labels:
       traefik.enable: true
       traefik.http.routers.service-name.rule: Host(`service-name.${DOMAIN}`)
       traefik.http.routers.service-name.entrypoints: websecure
       traefik.http.routers.service-name.tls: true
       traefik.http.routers.service-name.tls.certresolver: letsencrypt
       traefik.http.routers.service-name.tls.domains[0].main: service-name.${DOMAIN}
       traefik.http.services.service-name.loadbalancer.server.port: [PORT]
       traefik.http.services.service-name.loadbalancer.server.scheme: http
       traefik.http.routers.service-name.middlewares: authentik-dev@docker
     # ... rest of service configuration
   ```

2. **Choose appropriate middleware**:
   - Use `authentik-dev@docker` for infrastructure services
   - Use `authentik-media@docker` for media services
   - Omit middleware line for services with native authentication (e.g., Plex, Uptime Kuma)

3. **Ensure service is on apps network**:

   ```yaml
   networks:
     apps: {}
   ```

## TCP Routing

Some services use Traefik TCP routers instead of HTTP. Traefik binds TCP entrypoints on the `apps`
network and forwards to backend containers by container name.

### Forgejo Git SSH

Traefik does not expose Forgejo Git SSH. It only routes Forgejo HTTP(S) for the web UI, Git HTTP,
webhooks, and API tokens. Rootless Forgejo listens for Git SSH on container port `2222`, and
`tsdproxy-rfapps` maps tailnet host `git.${TS_DOMAIN}:22` to `forgejo:2222` via TCP proxy labels.

### Authentik PostgreSQL (TLS passthrough)

Authentik database access uses a TLS-aware TCP router on the `postgres-tcp` entrypoint (`:15432`):

```yaml
traefik.tcp.routers.authentik-db.rule: HostSNI(`authentik-db.${DOMAIN}`)
traefik.tcp.routers.authentik-db.entrypoints: postgres-tcp
traefik.tcp.routers.authentik-db.tls: true
traefik.tcp.routers.authentik-db.tls.certresolver: letsencrypt
traefik.tcp.services.authentik-db.loadbalancer.server.port: 5432
```

See [Traefik Setup Guide](../services/traefik-setup.md) for the general TCP label pattern.

## Recent Changes

### File-Based to Label-Based Configuration Migration (2025-11-13)

**Major architectural change**: Migrated from external file-based Traefik configuration to Docker label-based dynamic routing.

#### Problem Statement

The previous architecture used a hybrid approach where:

- **Docker services** used file-based configuration in `config/traefik-external/*.yml`
- **Middleware** was defined in separate files (`middlewares.yml`)
- **External services** also used file-based configuration
- **Configuration scattered** across multiple YAML files that had to be manually synchronized

This created several issues:

- Configuration for Docker services existed in TWO places (compose.yml service definition + external routing files)
- Middleware definitions used outdated hostnames (`authentik-server`, `authentik-media`) instead of container hostnames
- Difficult to understand which services had Traefik routing without checking multiple files
- Risk of configuration drift between service definitions and routing rules
- External file-based configs required container restart to reload

#### Solution

Migrated to a **label-based dynamic configuration** approach where all Docker service routing is defined directly in `compose.yml` using Traefik labels. File-based configuration is now ONLY used for external services (non-Docker services on remote servers).

#### Benefits of Label-Based Configuration

1. **Co-location**: Service configuration and routing rules in one place
2. **Dynamic updates**: Traefik automatically detects label changes when containers restart
3. **Easier maintenance**: Single source of truth per service
4. **Better visibility**: `docker inspect` shows complete routing configuration
5. **Consistency**: All Docker services use labels, all external services use files
6. **Correctness**: Middleware addresses use proper container hostnames

#### Migration Details

**Deleted Files** (moved from file-based to labels):

```bash
config/traefik-external/
├── homeauto.yml       # 64 lines - Home automation routing (kept as external)
├── middlewares.yml    # 27 lines - Authentik middleware definitions
├── network.yml        # 22 lines - Network infrastructure routing
└── synology.yml       # 101 lines - NAS and utility service routing
```

**New Configuration Structure**:

```bash
config/traefik/
├── homeauto.yml       # External services only (homebridge, homeassistant, etc.)
├── middlewares.yml    # File-based middleware for external services
├── network.yml        # External network infrastructure
└── synology.yml       # External NAS and utility services
```

**Services Migrated to Labels** (from synology.yml):

- `uptime-kuma` - Uptime monitoring
- `speedtest-tracker` - Network speed monitoring
- `stirling-pdf` - PDF manipulation tool

These services now have Traefik labels defined directly in compose.yml and connect via the `apps`
network instead of direct IP addresses.

**File-Based Configuration Retained For**:

External services running on separate physical servers:

- Home automation: homebridge, homeassistant, scrypted, zigbee2mqtt
- NAS devices: nas01, nas02
- Network infrastructure: unifi gateway

**Middleware Migration**:

```diff
# OLD (file-based in middlewares.yml)
- address: "https://authentik-server:9443/..."
- address: "https://authentik-media:9443/..."

# NEW (Docker labels)
+ address: "https://authentik-server:9443/..."
+ address: "https://authentik-server:9443/..."
```

All middleware now correctly references Docker service names (`authentik-server`).

#### Label Pattern Used

Standard pattern for Docker services:

```yaml
labels:
  traefik.enable: true
  traefik.http.routers.<service>.rule: Host(`<service>.${DOMAIN}`)
  traefik.http.routers.<service>.entrypoints: websecure
  traefik.http.routers.<service>.tls: true
  traefik.http.routers.<service>.tls.certresolver: letsencrypt
  traefik.http.routers.<service>.tls.domains[0].main: <service>.${DOMAIN}
  traefik.http.services.<service>.loadbalancer.server.port: <port>
  traefik.http.services.<service>.loadbalancer.server.scheme: http
  traefik.http.routers.<service>.middlewares: authentik-dev@docker
```

#### Breaking Changes

1. **Middleware References**: Services using file-based middleware must update references:
   - `authentik-dev-file` → `authentik-dev@docker` (for Docker services)
   - `authentik-media-file` → `authentik-media@docker` (for Docker services)
   - File-based middleware (`*-file` suffix) only for external services

2. **Configuration Directory**: `DOCKER_DIR` environment variable updated from pointing to `config/traefik-external/` to `config/traefik/`

3. **Service Restarts**: Services must be recreated (not just config reload) to apply label changes

#### Migration Checklist for Other Services

If migrating additional services from file-based to label-based configuration:

- [ ] Remove service entry from `config/traefik/*.yml` file
- [ ] Add Traefik labels to service definition in `compose.yml`
- [ ] Update middleware reference to use `@docker` suffix
- [ ] Ensure middleware points to Docker service hostname (e.g., `authentik-server:9443`)
- [ ] Recreate service: `docker compose up -d --force-recreate <service>`
- [ ] Verify routing: `docker logs traefik`
- [ ] Test access via browser
- [ ] Remove empty/unused external config files

### Authentik Integration

Authentik runs on the `apps` bridge network. Traefik middlewares reference Docker service names (e.g., `authentik-server:9443`) instead of Tailscale hostnames.

### Tailscale Usage

Tailnet web ingress flows through **Docktail-advertised Traefik** on the `apps` network. Direct
tailnet access uses tsdproxy hosts for `plex` and `plex-music`, and Docktail labels for `jellyfin`
and `images`. Other services remain on the standard Docker bridge network.

### Platform Integration

This configuration represents the completion of Traefik integration across the platform:

- Added Traefik routing for: autobrr, notifiarr, bazarr, plex, tautulli, plexseerr, jellyseerr
- Added Authentik authentication for: speedtest-tracker, uptime-kuma, sabnzbd, prowlarr, autobrr, notifiarr, bazarr, tautulli, plexseerr, jellyseerr
- Removed Authentik authentication from uptime-kuma (administrative access)
- Added external service routing for home automation services (homebridge, homeassistant, scrypted, zigbee2mqtt)

## Related Documentation

- [Quick Reference](quick-reference.md) - One-page command reference card
- [Authentik Integration](authentik-integration.md) - SSO and authentication setup
- [Tailscale Integration](tailscale-integration.md) - Docktail tailnet access pattern
- [Docker Compose Extensions](docker-compose-extensions.md) - Reusable service patterns
- [Sidecar Linking](sidecar-linking.md) - Optional sidecar management with rfapps CLI (disabled in this repo)
- [Troubleshooting Guide](../guides/troubleshooting.md) - Common issues and recovery
