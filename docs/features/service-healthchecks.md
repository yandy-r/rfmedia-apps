# Service Healthcheck Policy

## Purpose

This document is the canonical policy matrix for container healthchecks in `compose.yml`.

It defines:

- Immutable exemptions for this feature rollout.
- Per-service probe class decisions.
- Where root/process fallback probes are intentionally retained.
- How managed image updates verify the target separately from its dependencies.

## Managed Update Verification

Container health policy and managed update verification are related but not interchangeable.
`rfapps health` evaluates direct dependency readiness for selected services. By contrast,
`rfapps update --apply` must first prove that the recreated **target service** is the reviewed image
and is running correctly. Dependency evidence cannot make an unready target pass.

Managed target verification checks all of the following:

1. The Compose service maps to an inspectable target container.
2. The container uses the exact daemon-local image ID produced by the reviewed update or restore.
3. The container state is `running`, not restarting, exited, dead, or otherwise pending.
4. Docker inspect reports successful exit evidence for the active container.
5. The target satisfies either Docker-health or bounded running-only assurance.
6. Direct dependencies are ready according to their container-state, Docker-health, and TCP probes.

Overall verification succeeds only when both the target and dependency checks pass. Dependency
readiness is supplementary evidence: it can block overall success, but it cannot hide an image
mismatch, crash loop, unhealthy target, or unavailable target telemetry. Leaf services with no
dependencies must still pass every target check.

### Docker-Health Assurance

When the target defines a Docker `healthcheck`, verification is labeled `healthcheck`:

- `healthy` passes after image, state, and exit evidence also match.
- `starting` remains pending while polling continues.
- `unhealthy` fails verification and triggers managed restore when enabled.
- Unknown or unavailable health telemetry never becomes success.

The probe classes in this document determine what Docker evaluates. A root fallback or process
probe can be weaker than an application-specific readiness probe even when Docker reports
`healthy`; use service-specific post-update validation for higher assurance where needed.

### Running-Only Assurance

When a service has no Docker healthcheck, rfapps does not treat one instantaneous `running` sample
as healthy. It requires the expected image ID, running state, zero exit evidence, and a bounded
stable-running window (five seconds by default). The result is explicitly labeled `running-only`.

`running-only` proves bounded process stability, not application correctness. It does not test an
HTTP API, user workflow, database migration, or persisted data. Add a reliable Compose healthcheck
when stronger automatic verification is required.

These checks govern image update and exact-image restore decisions only. Restore remains image-only
under the current Compose configuration; it never reverses volumes, application data, databases,
or migrations. See [Deployment Rollback](deployment-rollback.md).

## Immutable Exemptions

The following probes are explicitly immutable in this rollout and must not be changed:

- `authentik-server`
- `plex`
- `stirling-pdf`

## Probe Classes

- `dedicated-http`: Verified, unauthenticated service health endpoint.
- `process-command`: Stable daemon/process command probe.
- `root-fallback`: Root/UI probe retained due to unverified or auth-coupled dedicated route.
- `no-check`: Intentional lack of healthcheck (one-shot or schedule-driven jobs).
- `db-cache-native`: Database/cache native probe (`pg_isready`, `redis-cli ping`).
- `sidecar-native`: Tailnet ingress command probe (`tailscale status --json`).

## Service Matrix

| Service             | Previous probe class | Target probe class | Exempt | Policy notes                                                   |
| ------------------- | -------------------- | ------------------ | ------ | -------------------------------------------------------------- |
| `traefik`           | root-fallback        | root-fallback      | no     | Dashboard root probe on `apps` network.                        |
| `docktail`          | no-check             | process-command    | no     | Reconciler daemon; verify via logs and tailnet service status. |
| `authentik-server`  | dedicated-http       | dedicated-http     | yes    | Immutable exemption.                                           |
| `authentik-worker`  | no-check             | process-command    | no     | Worker daemon process check.                                   |
| `authentik-db`      | db-cache-native      | db-cache-native    | no     | Keep `pg_isready`.                                             |
| `authentik-redis`   | db-cache-native      | db-cache-native    | no     | Keep `redis-cli ping`.                                         |
| `authentik-media`   | no-check             | process-command    | no     | Proxy daemon process check.                                    |
| `uptime-kuma`       | root-fallback        | root-fallback      | no     | Keep root probe; no verified dedicated endpoint in-scope.      |
| `speedtest-tracker` | root-fallback        | dedicated-http     | no     | Migrate to `/api/healthcheck`.                                 |
| `stirling-pdf`      | dedicated-http       | dedicated-http     | yes    | Immutable exemption.                                           |
| `homarr`            | root-fallback        | dedicated-http     | no     | Migrate to `/api/health/live`.                                 |
| `sabnzbd`           | root-fallback        | root-fallback      | no     | Dedicated API likely auth-coupled; keep fallback.              |
| `nzbget`            | root-fallback        | root-fallback      | no     | JSON-RPC version check requires creds; keep fallback.          |
| `slskd`             | root-fallback        | dedicated-http     | no     | Migrate to `/health`.                                          |
| `prowlarr`          | root-fallback        | dedicated-http     | no     | Migrate to `/ping`.                                            |
| `unpackerr`         | root-fallback        | root-fallback      | no     | Dedicated route unverified; keep fallback.                     |
| `autobrr`           | root-fallback        | dedicated-http     | no     | Migrate to `/api/healthz/liveness`.                            |
| `notifiarr`         | root-fallback        | root-fallback      | no     | Dedicated route unverified; keep fallback.                     |
| `bazarr`            | root-fallback        | root-fallback      | no     | Dedicated unauthenticated route unverified.                    |
| `arr-scripts`       | no-check             | no-check           | no     | Helper container; no generic process probe; PID-1 is s6 only.  |
| `sonarr`            | root-fallback        | dedicated-http     | no     | Migrate to `/ping`.                                            |
| `radarr`            | root-fallback        | dedicated-http     | no     | Migrate to `/ping`.                                            |
| `lidarr`            | root-fallback        | dedicated-http     | no     | Migrate to `/ping`.                                            |
| `praxrr`            | root-fallback        | root-fallback      | no     | Dedicated route unverified; keep fallback.                     |
| `plex`              | dedicated-http       | dedicated-http     | yes    | Immutable exemption.                                           |
| `plex-music`        | dedicated-http       | dedicated-http     | no     | Same `/identity` probe as `plex` on port 32400.                |
| `jellyfin`          | dedicated-http       | dedicated-http     | yes    | `/health` on port 8096.                                        |
| `plex-ratings-sync` | no-check             | no-check           | no     | One-shot/schedule-driven; no continuous probe.                 |
| `ofelia`            | no-check             | process-command    | no     | Scheduler daemon process check.                                |
| `kometa`            | no-check             | process-command    | no     | Long-running process check.                                    |
| `tautulli`          | root-fallback        | root-fallback      | no     | Dedicated route unverified; keep fallback.                     |
| `plexseerr`         | dedicated-http       | dedicated-http     | yes    | `curl` on `/api/v1/status` (public settings 404 before setup). |
| `jellyseerr`        | dedicated-http       | dedicated-http     | yes    | `curl` on `/api/v1/status` (public settings 404 before setup). |
| `immich-server`     | dedicated-http       | dedicated-http     | yes    | `/api/server/ping` on port 2283.                               |
| `immich-ml`         | no-check             | process-command    | no     | Worker process check.                                          |
| `immich-redis`      | db-cache-native      | db-cache-native    | no     | Keep `redis-cli ping` with explicit timing fields.             |
| `immich-postgres`   | no-check             | db-cache-native    | no     | Add `pg_isready`.                                              |
| `forgejo-postgres`  | no-check             | db-cache-native    | no     | Add `pg_isready`.                                              |
| `forgejo`           | no-check             | dedicated-http     | no     | Migrate to `/api/healthz`.                                     |

## Guardrails for Future Changes

- Keep exemption probes unchanged unless a separate approved plan explicitly lifts exemption status.
- Do not switch fallback probes to dedicated routes without endpoint verification and no-auth
  confirmation.
- For services in `depends_on.condition: service_healthy` chains, prioritize startup-tolerant probes
  and timings over aggressive failure detection.
- For tailnet ingress containers (e.g. `docktail`), prefer native health commands over app endpoint
  checks.
