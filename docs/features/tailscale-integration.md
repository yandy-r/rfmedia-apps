# Tailscale Integration

## Overview

This project uses Tailscale for secure remote access to containerized services. **Docktail** advertises
most Docker services on the `apps` bridge network as native Tailscale Services. **tsdproxy-rfapps**
registers shareable Tailscale **hosts** for services that must be device-shared across tailnets
(Forgejo as host `git`, and both Plex instances as hosts `plex` and `plex-music`). There are no
active Tailscale sidecar containers in this deployment.

## Architecture

### Network Model

1. **Docker Bridge Network (`apps`)** — Primary network for inter-service communication
2. **Docktail** — Reconciles `docktail.service.*` labels into Tailscale Services on the tailnet
3. **tsdproxy-rfapps** — Discovers `tsdproxy.*` labels with `tsdproxy.proxyprovider: rfapps` and
   registers shareable Tailscale hosts
4. **Traefik** — Reverse proxy on `apps`; primary HTTPS entry for host-based routing
5. **Cloudflared** — Optional public ingress to Traefik (when enabled)

All application containers, including `plex`, `plex-music`, `jellyfin`, and `immich-server`, connect
directly to the `apps` network with explicit hostnames. Shareable tsdproxy hosts cover Forgejo,
both Plex instances, Jellyfin, and Immich. Docktail advertises Traefik as the tailnet reverse-proxy
entry point.

### Data Flow

**Tailnet (Docktail + tsdproxy-rfapps):**

1. **Tailnet request** → Docktail-advertised Tailscale Service → backend on `apps`
2. **Shareable host** → tsdproxy host (`git`, `plex`, `plex-music`, `jellyfin`, `images`) →
   labeled container ports on `apps`
3. **Traefik-routed services** → `https://traefik` (or `svc:traefik`) → Traefik → backend
4. **Direct media/photo** → tsdproxy `plex` / `plex-music` / `jellyfin` / `images`

**Inter-service (Docker bridge):**

1. **Service** → Docker DNS (`hostname`) → peer on `apps`
2. **Response** → direct container-to-container on `apps`

**Public / Cloudflare Tunnel:**

1. **External request** → Cloudflare edge → `cloudflared` → `https://traefik:443` → backend

## Docktail Services

Docktail runs on the `apps` bridge network and uses the host Tailscale daemon socket at
`/var/run/tailscale` to advertise labeled services.

| Compose service | Tailnet service name | Internal target         | Notes                     |
| --------------- | -------------------- | ----------------------- | ------------------------- |
| `traefik`       | `traefik`            | TCP 443 → `traefik:443` | Reverse proxy entry point |

Forgejo, Plex, Jellyfin, and Immich are **not** advertised via Docktail. They use `tsdproxy-rfapps`
instead (see below).

Tailnet clients reach Traefik at `https://traefik.${TS_DOMAIN}` (or the configured Docktail service
name). Traefik-routed hostnames continue to work once traffic reaches Traefik.

Deploy Docktail with core infrastructure:

```bash
rfapps deploy -s docktail --yes
docker compose logs docktail --tail 50
```

### Docktail Label Pattern

Follow the same label pattern as `traefik`:

```yaml
labels:
  docktail.service.enable: true
  docktail.service.name: traefik
  docktail.service.port: 443
  docktail.service.protocol: tcp
  docktail.service.service-port: 443
  docktail.service.service-protocol: tcp
  docktail.service.network: apps
```

## tsdproxy-rfapps (Shareable Hosts)

`tsdproxy-rfapps` runs on the `apps` network with read-only Docker socket access. It watches for
`tsdproxy.*` labels whose `tsdproxy.proxyprovider` is `rfapps` and registers **Tailscale hosts**
(not Services), which can be shared with users on other tailnets via device sharing.

A second TSDProxy (`praxrr-tsdproxy` in the praxrr repo) also mounts the Docker socket. Without a
distinct provider name, both daemons register the same hostname and Tailscale suffixes the second
node (`git` and `git-1`). Pin every labeled container:

- rfmedia-apps: `tsdproxy.proxyprovider: "rfapps"` (compose extension `*tsdproxy-rfapps`)
- praxrr: `tsdproxy.proxyprovider: "praxrr"`

TSDProxy skips containers whose provider is not defined in that instance's `tsdproxy.yaml`.

| Compose service | tsdproxy host | Ports                            | Notes                                         |
| --------------- | ------------- | -------------------------------- | --------------------------------------------- |
| `forgejo`       | `git`         | HTTPS 443, Git SSH TCP 22        | Shareable Git forge on tailnet                |
| `plex`          | `plex`        | HTTPS 443 → `plex:32400`         | Shareable Plex host; self-signed backend TLS  |
| `plex-music`    | `plex-music`  | HTTPS 443 → `plex-music:32400`   | Shareable music Plex; self-signed backend TLS |
| `jellyfin`      | `jellyfin`    | HTTPS 443 → `jellyfin:8096`      | Shareable Jellyfin host                       |
| `immich-server` | `images`      | HTTPS 443 → `immich-server:2283` | Shareable Immich host                         |

Config and Tailscale node state live under `${DOCKER_DIR}/tsdproxy-rfapps/` — isolated from praxrr's
tsdproxy paths. Copy `config/tsdproxy-rfapps/tsdproxy.yaml.example` to
`${DOCKER_DIR}/tsdproxy-rfapps/config/tsdproxy.yaml` and set `authKey` on provider `rfapps` before
first deploy. Existing node state is stored at `data/<provider-name>/<hostname>/`; renaming the
provider without renaming that directory creates new Tailscale machines.

Forgejo label pattern in `compose.yml`:

```yaml
labels:
  <<: *tsdproxy-rfapps
  tsdproxy.name: "git"
  tsdproxy.dash.label: "Forgejo"
  tsdproxy.port.1: "443/https:3000/http"
  tsdproxy.port.2: "22/tcp:2222/tcp"
```

The `*tsdproxy-rfapps` extension sets `tsdproxy.enable`, `tsdproxy.proxyprovider: rfapps`, and
`tsdproxy.ephemeral: "false"`.

Plex uses HTTPS on 32400 with a self-signed certificate, so the backend protocol is `https` with
`no_tlsvalidate` (the tsdproxy equivalent of Docktail `https+insecure`):

```yaml
labels:
  <<: *tsdproxy-rfapps
  tsdproxy.name: "plex"
  tsdproxy.dash.label: "Plex"
  tsdproxy.port.1: "443/https:32400/https, no_tlsvalidate"
```

`plex-music` uses the same port mapping with `tsdproxy.name: "plex-music"`. `jellyfin` and
`immich-server` (`images`) follow the same provider pin with HTTP backends.

Deploy:

```bash
rfapps deploy -s tsdproxy-rfapps --yes
docker compose logs tsdproxy-rfapps --tail 50
```

See [Forgejo Setup](../services/forgejo-setup.md) for cutover and device-sharing steps.

## Environment Variables

### Active (Docktail)

| Variable                        | Purpose                                       |
| ------------------------------- | --------------------------------------------- |
| `TAILSCALE_OAUTH_CLIENT_ID`     | Docktail OAuth client ID                      |
| `TAILSCALE_OAUTH_CLIENT_SECRET` | Docktail OAuth client secret                  |
| `DOCKTAIL_DEFAULT_SERVICE_TAGS` | Default tags for created services (optional)  |
| `DOCKTAIL_LOG_LEVEL`            | Docktail log level (optional)                 |
| `DOCKTAIL_RECONCILE_INTERVAL`   | Reconciliation interval (optional)            |
| `TS_DOMAIN`                     | Tailscale MagicDNS domain for client URLs     |
| `TSDPROXY_AUTHKEY`              | Auth key value for populating tsdproxy config |

### tsdproxy-rfapps config (file-based)

Live configuration is at `${DOCKER_DIR}/tsdproxy-rfapps/config/tsdproxy.yaml` (not committed).
Set `tailscale.providers.rfapps.authKey` from `TSDPROXY_AUTHKEY` or paste the key directly.
Data directory: `${DOCKER_DIR}/tsdproxy-rfapps/data`. Node identity lives under
`data/rfapps/<hostname>/`.

### Legacy (sidecar era)

These variables applied to the removed Tailscale sidecar containers and are no longer required for
this deployment:

| Variable          | Former purpose                          |
| ----------------- | --------------------------------------- |
| `TS_AUTHKEY`      | Sidecar node authentication key         |
| `TS_SERVE_CONFIG` | Per-sidecar `tailscale serve` JSON path |
| `TS_CERT_DOMAIN`  | Sidecar HTTPS certificate domain        |

Per-service Tailscale state under `${DOCKER_DIR}/*-ts` is also legacy and can be removed after
migration.

## Services on Docker Bridge

All services use `networks: apps: {}` with explicit `hostname` where needed. Examples:

- **Infrastructure**: `traefik`, `docktail`, `tsdproxy-rfapps`, `authentik-server`, `uptime-kuma`, `forgejo`
- **Media**: `plex`, `plex-music`, `jellyfin`, `sonarr`, `radarr`, `tautulli`, `kometa`
- **Photos**: `immich-server`, `immich-ml`, `immich-postgres`, `immich-redis`
- **Downloads**: `sabnzbd`, `nzbget`, `slskd`, `prowlarr`

## Middleware Configuration

Traefik middlewares reference services by Docker container name:

```yaml
address: https://authentik-server:9443/outpost.goauthentik.io/auth/traefik
```

This applies to both `authentik-dev` and `authentik-media` in `config/traefik/middlewares.yml`.

## Jellyfin Hardware Transcoding

After deploy:

1. Ensure the host exposes `/dev/dri` and the container user (`PUID`/`PGID`) can access the render device.
2. In Jellyfin: **Dashboard → Playback → Transcoding**, enable **Intel Quick Sync (QSV)** or **VAAPI**.
3. Set the transcode directory to `/config/cache` (mounted from `${DOCKER_DIR}/jellyfin-transcode`).
4. Add libraries pointing at `/data/media/...`.

## Migration History

### Plex tsdproxy hosts (current)

- Moved `plex` from Docktail Tailscale Services to a shareable tsdproxy host (`plex`)
- Added `plex-music` as a second Plex instance with tsdproxy host `plex-music`
- Backend TLS: `443/https:32400/https, no_tlsvalidate` (Plex self-signed cert on 32400)
- Jellyfin and Immich moved from Docktail Services to shareable tsdproxy hosts (`jellyfin`, `images`)
- `tsdproxy.proxyprovider: rfapps` pins hosts so praxrr-tsdproxy on the same Docker socket cannot
  register duplicate Tailscale machines (`git` / `git-1`)

### Docktail-only ingress

- Removed `plex-ts`, `jellyfin-ts`, and `immich-ts` sidecar containers
- Removed `x-tailscale-sidecar-base` and `x-ts-env-*` Compose extensions
- Added Docktail labels on `plex`, `jellyfin`, and `immich-server` (Plex later moved to tsdproxy)
- Preserved tailnet-facing names: `plex`, `jellyfin`, `images`
- `rfapps.config.yaml`: `sidecars.enabled: false`, empty mapping

### Prior: Traefik sidecar removal

- Removed `traefik-ts`; Traefik connects directly to `apps`
- Docktail advertises Traefik as the tailnet reverse-proxy entry point

### Prior: Architecture simplification

Removed 15+ per-service Tailscale sidecars in favor of Docker bridge networking, retaining only
media/photo sidecars until the Docktail-only migration above.

## Security Considerations

1. **Controlled entry points** — Tailnet traffic enters via Docktail Services and tsdproxy hosts
2. **Forward authentication** — Authentik middleware on Traefik routes where configured
3. **Network isolation** — Backends reachable on `apps` and via explicit ingress paths
4. **Funnel disabled** — Services not exposed to the public internet via Tailscale Funnel
5. **OAuth for Docktail** — Service management uses Tailscale OAuth credentials, not auth keys

## Troubleshooting

### Service not accessible via Traefik

```bash
docker network inspect apps | jq '.[0].Containers'
docker exec traefik ping -c 1 service-name
docker logs traefik 2>&1 | grep service-name
```

### Docktail not advertising a service

1. Confirm `docktail` is running: `docker compose ps docktail`
2. Check labels on the target service in `compose.yml`
3. Review Docktail logs: `docker compose logs docktail --tail 100`
4. Verify OAuth credentials in `.env.local`
5. Confirm the service is on the `apps` network

### Direct media access (plex / plex-music / jellyfin / images)

1. Verify the service container is healthy: `rfapps status -s plex --health` (or `-s plex-music`)
2. Confirm tsdproxy labels include `tsdproxy.proxyprovider: rfapps` and that `tsdproxy-rfapps` is
   running
3. For Plex, confirm `tsdproxy.port.1` is `443/https:32400/https, no_tlsvalidate`
4. Check Tailscale admin console for hosts `plex`, `plex-music`, `jellyfin`, and `images`
5. If you also see `git-1` / `plex-1` machines, another tsdproxy is claiming the same labels — see
   [Troubleshooting](../guides/troubleshooting.md#duplicate-tsdproxy-tailscale-machines)

## Implementation Files

- `compose.yml` — Service definitions, Docktail labels, and tsdproxy labels
- `config/traefik/middlewares.yml` — Traefik middleware configuration
- `rfapps.config.yaml` — CLI groups/profiles (sidecars disabled)

## Related Documentation

- [Quick Reference](quick-reference.md)
- [Traefik Reverse Proxy](traefik-reverse-proxy.md)
- [Sidecar Linking](sidecar-linking.md) — CLI feature (inactive in this repo)
- [Docker Compose Extensions](docker-compose-extensions.md)
- [Troubleshooting Guide](../guides/troubleshooting.md)
- [Plex Setup](../services/plex-setup.md)
