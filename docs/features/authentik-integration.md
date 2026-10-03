# Authentik Integration

## Overview

Authentik provides identity and access management for the platform, including SSO, MFA, and forward authentication for Traefik routes. All Authentik services run on the `apps` bridge network with Traefik forwarding traffic to `authentik-server`.

## Services

- **authentik-server** - Web UI and API (HTTPS on 9443)
- **authentik-worker** - Background tasks and outpost provisioning
- **authentik-db** - PostgreSQL database
- **authentik-redis** - Redis cache
- **authentik-media** - Media outpost for Traefik forward auth

## Network Model

- All services use `networks: apps: {}`
- Traefik middlewares reference `authentik-server:9443`
- No Tailscale sidecars are required for Authentik

## Traefik Middleware Example

```yaml
traefik.http.middlewares.authentik-dev.forwardauth.address: https://authentik-server:9443/outpost.goauthentik.io/auth/traefik
traefik.http.middlewares.authentik-dev.forwardauth.trustForwardHeader: true
traefik.http.middlewares.authentik-dev.forwardauth.authResponseHeaders: X-authentik-username,X-authentik-groups,X-authentik-email
```

## Compose Snippet (authentik-server)

```yaml
authentik-server:
  <<: *service-base
  container_name: authentik-server
  networks:
    apps: {}
  logging: *logging-default
  environment:
    <<: *common-env
    AUTHENTIK_SECRET_KEY: ${AUTHENTIK_SECRET_KEY}
    AUTHENTIK_REDIS__HOST: authentik-redis
    AUTHENTIK_POSTGRESQL__HOST: authentik-db
  depends_on:
    - authentik-db
    - authentik-redis
  labels:
    traefik.enable: true
    traefik.http.routers.authentik.rule: Host(`authentik.${DOMAIN}`)
    traefik.http.routers.authentik.entrypoints: websecure
    traefik.http.routers.authentik.tls: true
    traefik.http.routers.authentik.tls.certresolver: letsencrypt
    traefik.http.services.authentik.loadbalancer.server.port: 9443
    traefik.http.services.authentik.loadbalancer.server.scheme: https
```

## Initial Setup

1. Access Authentik at `https://authentik.${DOMAIN}`
2. Complete the initial setup wizard
3. Configure providers and applications
4. Create a Traefik outpost for forward authentication

## Troubleshooting

### Authentik UI Not Loading

```bash
# Check server logs
docker compose logs authentik-server

# Verify database and redis
docker compose ps authentik-db authentik-redis
```

### Forward Auth Errors

- Confirm middleware uses `authentik-server:9443`
- Check outpost status in Authentik UI
- Verify `authentik-media` is running

## Related Documentation

- [Traefik Reverse Proxy](traefik-reverse-proxy.md)
- [Secrets Management](secrets-management.md)
- [Quick Reference](quick-reference.md)
