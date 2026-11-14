# T3 Code Setup Guide

This guide covers publishing a [T3 Code](https://github.com/pingdotgg/t3code) server that runs on
the Docker host through Traefik and the Cloudflare Tunnel. This is an optional deployment.

## Overview

T3 Code is not a container here. It runs on the Docker host as the systemd user unit
`t3code.service`, which `t3 up` installs. The optional `t3` Compose service is a small
[socat](https://hub.docker.com/r/alpine/socat) TCP bridge. It gives Traefik a container target on
the `apps` network and forwards connections to the host.

| Setting       | Value                                                          |
| ------------- | -------------------------------------------------------------- |
| Compose       | Service `t3`, profile `t3` (not `all`)                         |
| Bridge image  | `alpine/socat:1.8.0.3`                                         |
| URL           | `https://t3.${DOMAIN}`                                         |
| Host upstream | `host.docker.internal:${T3_HOST_PORT:-3773}` (docker0 gateway) |
| Auth          | T3 device pairing only; **no** Authentik middleware            |

```text
T3 client / browser
  -> https://t3.${DOMAIN} (Cloudflare edge, proxied CNAME)
  -> cloudflared -> https://traefik:443
  -> Traefik router `t3` (Docker labels on the t3 container)
  -> t3 container (socat :3773)
  -> host.docker.internal:3773 -> t3code.service on the host
```

### Why no Authentik

T3 clients connect to the server over HTTP and WebSocket. They cannot complete Authentik's
browser-based forward-auth flow, so an Authentik middleware would block them. Access control comes
from T3's own device pairing. Anyone who reaches `t3.${DOMAIN}` still has to pair before they can
use the server. That server runs coding agents with shell access on the host, so keep pairing
credentials private, and remove the tunnel hostname when you stop using it.

### Why a bridge container instead of a file-provider route

Traefik loads every file in its dynamic configuration directory no matter which Compose profiles
are active. A Docker-label route exists only while its container runs. The `t3` profile therefore
turns the public route on and off.

## Prerequisites

- T3 Code installed on the Docker host, with `t3code.service` running
  (`systemctl --user status t3code.service`)
- Traefik and `cloudflared` running (see [Cloudflare Tunnel](../features/cloudflare-tunnel.md))
- `DOMAIN` set in your environment file

## Setup

### 1. Bind T3 to the Docker gateway

By default T3 listens only on `127.0.0.1`, which containers cannot reach. Bind it to the `docker0`
gateway, which is the address `host.docker.internal:host-gateway` resolves to:

```bash
ip -4 addr show docker0 | grep inet   # usually 172.17.0.1
echo 'T3CODE_HOST=172.17.0.1' >> ~/.t3/service.env
systemctl --user restart t3code.service
ss -ltnp | grep 3773                  # expect 172.17.0.1:3773
```

Binding to the gateway address keeps T3 off the LAN. Avoid `T3CODE_LAN=true` and `0.0.0.0`. If T3
listens on a port other than 3773, set `T3_HOST_PORT` in your environment file.

### 2. Add the tunnel hostname

Add the entry to `infra/terraform/cloudflare/terraform.tfvars`, then apply:

```hcl
ingress = {
  # ...
  "t3" = { domain = "primary" }
}
```

```bash
npm run tf:plan:apply cloudflare
```

### 3. Deploy the bridge

```bash
rfapps deploy -s t3 --yes
# or: docker compose --profile t3 up -d t3
```

`rfapps` maps `t3` to the `t3` profile and turns that profile on automatically. Neither a bare
`docker compose up -d` nor `--profile all` starts the bridge.

### 4. Verify

```bash
docker inspect --format '{{.State.Health.Status}}' t3   # healthy = host port reachable
curl -sI https://t3.${DOMAIN} | head -1                  # HTTP/2 200
```

Then pair a client against `https://t3.${DOMAIN}`.

## Disabling

```bash
docker compose --profile t3 rm -sf t3
```

Remove the `t3` entry from `terraform.tfvars` and run `npm run tf:plan:apply cloudflare` to delete
the public DNS record. Optionally remove `T3CODE_HOST` from `~/.t3/service.env`.

## Troubleshooting

| Symptom                       | Cause and fix                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `t3` container `unhealthy`    | T3 is not listening on the gateway address. Repeat step 1 and check `ss -ltnp`.           |
| `502 Bad Gateway`             | Same as above. Traefik reaches the bridge, but the bridge cannot reach the host.          |
| `404 page not found`          | The `t3` container is not running, so Traefik has no router. Deploy it (step 3).          |
| Cloudflare `1033` / `530`     | The hostname is missing from tunnel ingress. Re-apply Terraform (step 2).                 |
| T3 fails to bind after reboot | `docker0` did not exist yet when T3 started. The unit restarts automatically; check logs. |

T3 logs: `~/.t3/userdata/logs/`.
