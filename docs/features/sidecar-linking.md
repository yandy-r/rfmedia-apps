# Automatic Sidecar Linking

## Overview

The `rfapps` CLI includes an optional sidecar linking subsystem: when `sidecars.enabled` is true and
mappings are defined, targeting a main service automatically includes its Tailscale sidecar (and
vice versa).

**This repository does not use active sidecar mappings.** Tailnet ingress is handled by Docktail
labels on `jellyfin`, `immich-server`, `traefik`, and other labeled services, plus tsdproxy hosts
for `plex`, `plex-music`, and Forgejo (`git`). `rfapps.config.yaml` sets `sidecars.enabled: false`
with an empty `mapping`.

The CLI feature remains available for backward compatibility and custom deployments that still use
sidecars. The `--no-sidecars` flag is unchanged.

## Current Deployment (Docktail-only)

| Concern                  | This repo behavior                                     |
| ------------------------ | ------------------------------------------------------ |
| Tailnet ingress          | Docktail services + tsdproxy hosts                     |
| `plex` / `plex-music`    | `apps` network + tsdproxy hosts (`plex`, `plex-music`) |
| `jellyfin`               | `apps` network + Docktail (`jellyfin` service)         |
| `immich-server`          | `apps` network + Docktail (`images` service name)      |
| Sidecar expansion        | Disabled (`sidecars.enabled: false`)                   |
| `rfapps rebuild -s plex` | Operates on `plex` only — no `plex-ts`                 |

```bash
# Deploy Plex — no sidecar auto-linking
rfapps rebuild -s plex --yes

# Deploy core infra including Docktail
rfapps deploy -g infra-stack --yes
```

## How Sidecar Linking Works (when enabled)

When sidecars are configured in `.rfapps.yaml` or `rfapps.config.yaml`:

1. Targeting `plex` also selects `plex-ts` (if mapped)
2. Targeting `plex-ts` also selects `plex`
3. `--force-recreate` is auto-enabled when sidecars expand (prevents stale network state)
4. Use `--no-sidecars` to disable expansion

Applies to: `pull`, `build`, `deploy`, `rebuild`, `delete`, `prune`, `plan`, `apply`.

### Example (custom deployment with sidecars)

```bash
# With sidecars.enabled: true and plex: plex-ts in mapping:
rfapps rebuild -s plex --yes        # includes plex-ts
rfapps rebuild -s plex --no-sidecars --yes  # plex only
```

## Service Groups Reference

Groups in `rfapps.config.yaml` list main services only (no `*-ts` entries):

| Group            | Services Included                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `infra-stack`    | docktail, traefik, cloudflared, homarr, uptime-kuma, stirling-pdf, speedtest-tracker, ofelia                                       |
| `forgejo-stack`  | forgejo, forgejo-postgres, forgejo-runner(-2/-3), forgejo-itcn-runner(-2/-3)                                                       |
| `vpn-stack`      | slskd                                                                                                                              |
| `download-stack` | unpackerr, autobrr, sabnzbd, slskd, nzbget                                                                                         |
| `arr-stack`      | sonarr, radarr, lidarr, bazarr, prowlarr                                                                                           |
| `media-stack`    | plex, plex-music, jellyfin, plex-ratings-sync, kometa, tautulli, plexseerr, jellyseerr, watchstate, sonarr, radarr, lidarr, bazarr |
| `auth-stack`     | authentik-server, authentik-worker, authentik-db, authentik-redis, authentik-media                                                 |
| `photo-stack`    | immich-server, immich-ml, immich-redis, immich-postgres                                                                            |

## Configuration

```yaml
# rfapps.config.yaml (this repo)
sidecars:
  enabled: false
  mapping: {}
```

To enable sidecars in a custom fork:

```yaml
sidecars:
  enabled: true
  mapping:
    myapp: myapp-ts
```

Mappings live in `rfapps.config.yaml`, project `.rfapps.yaml`, or `~/.rfapps.yaml` — not hardcoded in
CLI source.

## CLI Options

| Option               | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `--no-sidecars`      | Disable automatic sidecar linking                             |
| `-g, --group <name>` | Target a predefined service group                             |
| `--force-recreate`   | Force recreate containers (auto-enabled when sidecars expand) |

## Related Documentation

- [Tailscale Integration](tailscale-integration.md) — Docktail-only tailnet ingress
- [rfapps Configuration](rfapps-configuration.md) — CLI configuration system
- [Docker Compose Profiles](compose-profiles.md) — Service deployment strategy
- [Dry-Run Mode](dry-run-mode.md) — Preview operations
