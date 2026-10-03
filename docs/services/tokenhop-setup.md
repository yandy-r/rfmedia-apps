# tokenhop Setup Guide

This guide covers deploying tokenhop with its published container image, Traefik HTTPS routing,
native authentication, persistent state, and operational recovery.

## Overview

tokenhop (formerly 9Router) provides an OpenAI-compatible gateway for configuring and routing
requests to multiple AI providers. This repository runs the image published from the
[tokenhop/tokenhop repository](https://github.com/tokenhop/tokenhop) and does not build it locally.

| Setting    | Value                                                               |
| ---------- | ------------------------------------------------------------------- |
| Image      | `ghcr.io/tokenhop/tokenhop:latest`                                  |
| URL        | `https://tokenhop.${DOMAIN}`                                        |
| State      | `${DOCKER_DIR}/tokenhop`                                            |
| API prefix | `https://tokenhop.${DOMAIN}/v1`                                     |
| Auth       | Native dashboard login and native API keys; no Authentik middleware |

This deployment intentionally tracks `latest` so production picks up every tokenhop release. There
is no digest pin; rely on backups and the contract test before redeploying a new image.

## Prerequisites

Before deploying tokenhop, ensure you have:

- Docker and Docker Compose installed
- Traefik configured and running on the `apps` network
- DNS for `tokenhop.${DOMAIN}` pointing to the Traefik entry point
- A writable `${DOCKER_DIR}` on the Docker host
- Unique, randomly generated tokenhop secrets

## Configure Secrets

Copy `.env.example` to the environment file used for deployment, then replace every tokenhop
placeholder. Do not commit resolved values.

```bash
TOKENHOP_IMAGE=ghcr.io/tokenhop/tokenhop
TOKENHOP_TAG=latest

TOKENHOP_INITIAL_PASSWORD=replace-with-a-unique-password
TOKENHOP_JWT_SECRET=replace-with-random-secret
TOKENHOP_API_KEY_SECRET=replace-with-random-secret
TOKENHOP_MACHINE_ID_SALT=replace-with-random-secret
TOKENHOP_AUTH_COOKIE_SECURE=true
TOKENHOP_ENABLE_REQUEST_LOGS=false
```

Generate independent values rather than reusing the password or a secret from another service. For
example:

```bash
openssl rand -base64 48
```

Store the values in a `0600` environment file, dotenvx-encrypted file, or 1Password item. Keep
`TOKENHOP_AUTH_COOKIE_SECURE=true` when accessing the service through Traefik HTTPS.

Compose sets both `BASE_URL` and `NEXT_PUBLIC_BASE_URL` to the public origin
`https://tokenhop.${DOMAIN}`. Keep `BASE_URL` public: browser authentication and future OIDC or SAML
callbacks must return through the canonical HTTPS route, not the Docker-internal address.

### API-Key Enforcement

tokenhop initializes its `requireApiKey` setting to `true`. It does **not** consume a
`REQUIRE_API_KEY` environment variable, so do not rely on such an override. After the first start
and after every image update, verify that an anonymous request to `/v1/models` is denied before
adding clients.

## Prepare Persistent Storage

Create the bind-mounted state directory before the first deployment:

```bash
mkdir -p "${DOCKER_DIR}/tokenhop" "${DOCKER_DIR}/headroom"
```

The container stores its configuration, provider credentials, generated API keys, and application
database under `/app/data`, backed by `${DOCKER_DIR}/tokenhop` on the host. Treat this directory and
its backups as secrets.

The image entrypoint starts with narrowly scoped ownership capabilities so it can repair the data
directory, then drops the application process to the `node` user (UID `1000`). Compose drops every
other capability, prevents privilege escalation, makes the root filesystem read-only, and provides
only a bounded `/tmp` tmpfs.

## Deploy

Validate the resolved Compose configuration before starting the service:

```bash
docker compose --env-file .env.local config --quiet
rfapps deploy -s tokenhop -e .env.local --yes
rfapps health -s tokenhop --wait-for-ready
```

If secrets are supplied through another supported provider, use the corresponding `rfapps`
option instead:

```bash
rfapps deploy -s tokenhop --use-dotenvx .env --yes
rfapps deploy -s tokenhop --use-op .env --yes
```

Open `https://tokenhop.${DOMAIN}` and sign in with `TOKENHOP_INITIAL_PASSWORD`. Configure provider
credentials in the dashboard, create a tokenhop API key, and use that key in clients with the base URL
`https://tokenhop.${DOMAIN}/v1`.

Before the first deployment and after every image update, run the opt-in container contract test:

```bash
RUN_TOKENHOP_CONTRACT_TEST=1 scripts/test-tokenhop-service.sh
```

The test pulls `tokenhop:latest` (or `${TOKENHOP_IMAGE}:${TOKENHOP_TAG}@${TOKENHOP_DIGEST}` when a
digest is supplied), checks both supported architectures, starts a hardened temporary
container, verifies native login and API-key behavior, exercises spoofed proxy headers, confirms
persistence across recreation, and removes its temporary container and volume.

## Authentication Boundary

Two Traefik routers share the tokenhop backend:

| Router         | Rule                                          | Middleware | Guard                    |
| -------------- | --------------------------------------------- | ---------- | ------------------------ |
| `tokenhop`     | `Host(tokenhop.${DOMAIN})`                    | none       | Native dashboard login   |
| `tokenhop-api` | `Host(tokenhop.${DOMAIN}) && PathPrefix(/v1)` | none       | Native tokenhop API keys |

`/v1` never uses Authentik because OpenAI-compatible clients send a bearer key and cannot complete
Authentik's browser flow.

- Use a unique, high-entropy initial password.
- Keep the JWT, API-key, and machine-ID secrets private and independent.
- Keep secure cookies enabled behind HTTPS.
- Do not publish container port `20128` directly on the host.
- Verify anonymous API denial after startup and upgrades.
- Rotate provider credentials and generated API keys if the state directory or a backup is exposed.

Confirm the API boundary from a client that can reach Traefik:

```bash
curl -i "https://tokenhop.${DOMAIN}/api/health"
curl -i "https://tokenhop.${DOMAIN}/v1/models"
curl -i \
  -H "Authorization: Bearer ${TOKENHOP_CLIENT_API_KEY}" \
  "https://tokenhop.${DOMAIN}/v1/models"
```

The health request should succeed. The second request must be denied, and the request with a valid
tokenhop-generated key should pass authentication.

## Backup and Restore

The native `rfapps backup` workflow includes the `${DOCKER_DIR}/tokenhop` bind mount when tokenhop is
in scope. It stops detected writers before archiving the directory and records a restore hint in the
published manifest.

```bash
rfapps backup -s tokenhop,headroom --destination /path/to/private/backups --yes
rfapps backup verify /path/to/backup-bundle/manifest.json
```

Keep backup bundles private and encrypted at rest because they can contain provider credentials,
application secrets, and API-key material.

Restore is intentionally manual:

1. Stop tokenhop.
2. Run `rfapps backup verify <manifest>`.
3. Inspect the tokenhop archive entry and its `restore` hint in the manifest.
4. Restore into a staging directory and verify paths and ownership.
5. Replace `${DOCKER_DIR}/tokenhop` only after preserving the current directory separately.
6. Deploy an image compatible with the restored data, then verify health, native login, and
   anonymous API denial.

See [rfapps Native Backup](../features/rfapps-backup.md) for the fail-closed extraction and restore
procedure. An image rollback alone does not roll back application state or database migrations.

## Upgrade

Production tracks `tokenhop:latest`, so an upgrade is a pull and redeploy:

1. Review the [tokenhop releases](https://github.com/tokenhop/tokenhop/releases).
2. Record a verified backup of `${DOCKER_DIR}/tokenhop`.
3. Run the contract test against the new `latest` image.
4. Preview and deploy, then verify health, login, API-key creation, authenticated access, anonymous
   denial, and persistence across recreation.

```bash
RUN_TOKENHOP_CONTRACT_TEST=1 scripts/test-tokenhop-service.sh
rfapps plan -s tokenhop -e .env.local --check-updates --yes
rfapps deploy -s tokenhop -e .env.local --yes
```

## Rollback

`latest` moves forward, so roll back by temporarily setting `TOKENHOP_TAG` to the last known-good
release tag (for example `0.5.1`) and redeploying. If the application migrated or modified its
database, restore the matching verified data backup before starting the older image. Return
`TOKENHOP_TAG` to `latest` once the fix ships.

```bash
rfapps deploy -s tokenhop -e .env.local --yes
rfapps health -s tokenhop --wait-for-ready
```

After rollback, verify dashboard login, an authenticated `/v1/models` request, anonymous denial, and
provider connectivity. Do not assume an image-only downgrade is compatible with newer persisted
state.

## Health and Troubleshooting

```bash
rfapps status -s tokenhop
rfapps health -s tokenhop --wait-for-ready
docker compose logs --tail 200 tokenhop
curl -fsS "https://tokenhop.${DOMAIN}/api/health"
```

Common failure modes:

| Symptom                     | Check                                                                  |
| --------------------------- | ---------------------------------------------------------------------- |
| Container is unhealthy      | Inspect logs and verify `${DOCKER_DIR}/tokenhop` is writable           |
| Traefik returns 404         | Verify DNS, the `apps` network, and the `tokenhop.${DOMAIN}` host rule |
| TLS or login cookie fails   | Use HTTPS and keep `TOKENHOP_AUTH_COOKIE_SECURE=true`                  |
| Dashboard login fails       | Verify the initial password and persistent state used on first start   |
| Anonymous API request works | Disable client access and correct `requireApiKey` in native settings   |
| Provider calls fail         | Recheck provider credentials, model mappings, quotas, and logs         |

Request logging defaults to disabled to reduce sensitive metadata collection. Enable it only after
reviewing its data exposure and retention implications.

## Headroom Integration

The stack runs Headroom as a separate internal-only service. tokenhop calls its compression API at
`http://headroom:8787`; no Headroom port is published to the host, Traefik, Docktail, or tsdproxy.

Compose sets `HEADROOM_COMPRESS_ALLOW_REMOTE=1` because tokenhop reaches `/v1/compress` from another
container rather than loopback. Headroom state persists under `${DOCKER_DIR}/headroom`. Its anonymous
beacon and local telemetry default to disabled through `HEADROOM_BEACON=off` and
`HEADROOM_TELEMETRY=off`.

In tokenhop, open **Endpoint → Token Saver → Headroom**, confirm the URL is
`http://headroom:8787`, recheck status, then enable Headroom. tokenhop fails open when Headroom is
unavailable and sends the original request.

Use these checks after deployment:

```bash
rfapps health -s headroom --wait-for-ready
docker compose exec tokenhop wget -qO- http://headroom:8787/health
```

Update `HEADROOM_TAG` and `HEADROOM_DIGEST` together after reviewing upstream releases and security
advisories.
