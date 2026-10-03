# External Integration Research: Managed Update Lifecycle

## Executive Summary

The safest implementation is to keep Docker and Docker Compose as the execution and credential
boundary, while making rfapps responsible for state, policy, and orchestration. The lifecycle should
be:

1. Resolve the selected Compose services and their image references.
2. Capture a pre-update generation containing an immutable registry digest, local image ID, platform,
   and current container identity.
3. Resolve each mutable tag to a remote manifest digest and freeze that digest into the plan.
4. Confirm, pull the exact planned digest, and recreate only the selected services from a temporary
   Compose override pinned to that digest.
5. Wait for target containers to become running or healthy, then inspect them to prove that they use
   the planned image.
6. On failure, run the same pinned-override flow with the pre-update generation digest and verify the
   restored target.

This design avoids a tag race between preview and apply. `docker compose pull SERVICE` only fetches an
image; it does not start containers. `docker compose up` recreates containers when their image or
configuration changed, and `--force-recreate` makes that behavior explicit. After an exact digest has
been pulled, `up --pull never` prevents an unplanned second registry resolution. Docker documents these
behaviors in the official [`compose pull`](https://docs.docker.com/reference/cli/docker/compose/pull/)
and [`compose up`](https://docs.docker.com/reference/cli/docker/compose/up/) references.

The current repository has important integration gaps to close:

- `plan --check-updates` records `updateAvailable`, but does not convert an otherwise `unchanged`
  service into an actionable change. `apply` calculates `hasChanges` only from create/update/recreate
  counts and selects pulls only when `image.changed` is true. An update-only plan therefore currently
  applies nothing.
- Remote detection uses experimental `docker manifest inspect --verbose`; Docker still labels that
  command experimental. Its output also must not be confused with a platform manifest's config digest.
- Local detection takes the first `RepoDigests` entry rather than matching the normalized repository.
  A local image can have multiple repository digests.
- Generations store `image_tag`, which may be mutable. A generation is not a deterministic restore
  point unless it records an immutable `repository@sha256:...` reference.
- The current rollback action displays the historical target image, but calls Compose pull/up using
  the current Compose service definition. It needs a pinned override; pulling a digest separately does
  not make an unchanged Compose service use that digest.
- Existing dependency readiness evaluates dependencies, not necessarily the updated target itself.
  Update verification must explicitly check every target container's state and health.

## Primary APIs

### Docker Registry HTTP API V2

Primary specifications:

- [CNCF Distribution HTTP API V2](https://distribution.github.io/distribution/spec/api/)
- [Docker registry authentication](https://docs.docker.com/reference/api/registry/auth/)
- [Docker manifest schema 2 and manifest lists](https://distribution.github.io/distribution/spec/manifest-v2-2/)
- [OCI image index specification](https://specs.opencontainers.org/image-spec/image-index/)

Relevant endpoints:

| Method | Endpoint                               | Use in this feature                                                                  |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET`  | `/v2/`                                 | Confirm Registry API V2 support; expect `200` or an auth challenge.                  |
| `HEAD` | `/v2/<name>/manifests/<tag-or-digest>` | Resolve existence and `Docker-Content-Digest` without downloading the manifest body. |
| `GET`  | `/v2/<name>/manifests/<tag-or-digest>` | Fallback when the body/media type or platform descriptors are needed.                |
| `GET`  | `/v2/<name>/blobs/<digest>`            | Not needed for detection; Docker pull should own blob transfer.                      |

Manifest requests should advertise all formats rfapps can understand:

```http
HEAD /v2/library/ubuntu/manifests/24.04 HTTP/1.1
Host: registry-1.docker.io
Accept: application/vnd.oci.image.index.v1+json
Accept: application/vnd.oci.image.manifest.v1+json
Accept: application/vnd.docker.distribution.manifest.list.v2+json
Accept: application/vnd.docker.distribution.manifest.v2+json
Authorization: Bearer <token>
```

A successful `HEAD` response provides the selected representation's digest:

```http
HTTP/1.1 200 OK
Content-Type: application/vnd.oci.image.index.v1+json
Docker-Content-Digest: sha256:...
```

Digest rules for implementation:

- Compare like with like. Docker image ID, manifest digest, config digest, and layer digest are distinct
  identifiers. `docker image inspect .Id` is not a substitute for the registry manifest digest.
- For a multi-platform tag, the first response may be an OCI index or Docker manifest list. That
  top-level digest is an immutable pull reference, while child descriptors identify platform-specific
  manifests. The OCI specification requires consumers to handle indexes and describes `os`,
  `architecture`, and `variant` selection.
- Persist the media type and effective platform with the digest. This makes mismatch diagnostics
  possible and avoids silently comparing an index digest with a child manifest or config digest.
- Normalize Docker Hub's implicit names (`nginx` to `docker.io/library/nginx`) before matching a local
  `RepoDigests` entry.
- A digest returned for a mutable tag must be copied into the saved plan. Apply must not resolve the
  tag again and silently accept a different digest.

#### Authentication

Registry authentication is challenge-driven:

1. Request the registry resource.
2. On `401`, parse `WWW-Authenticate: Bearer realm=...,service=...,scope=...`.
3. Request a token from `realm` using `service` and `scope=repository:<name>:pull`.
4. Retry with `Authorization: Bearer <token>`.

Tokens are short-lived and must never be logged or written to plan/generation files. Private registries
also require integration with Docker's configured credential store or credential helpers. This is the
main reason to prefer Docker CLI resolution over implementing raw Registry V2 authentication in rfapps.

#### Rate limits

Docker Hub currently documents these pull limits per six hours: 100 for unauthenticated clients by
IPv4 address or IPv6 `/64`, 200 for authenticated Personal accounts, and unlimited for authenticated
Pro, Team, and Business accounts subject to fair use. Docker Hub also documents a separate dynamic
abuse limit. A pull-limit response and an abuse-limit response both use HTTP 429 but have different
messages. See [Docker Hub pull usage and limits](https://docs.docker.com/docker-hub/usage/pulls/).

Implementation should:

- Deduplicate identical image references before resolution.
- Bound registry concurrency instead of issuing one request per service without a limit.
- Cache resolved digests for the duration of plan generation.
- Treat `401`, `403`, `404`, `429`, timeout, and unsupported media type as distinct structured results.
- Honor `Retry-After` when supplied and otherwise use bounded exponential backoff for transient
  failures; do not report an unknown digest as "no update."

### Docker Compose CLI

Primary references:

- [`docker compose config`](https://docs.docker.com/reference/cli/docker/compose/config/)
- [`docker compose pull`](https://docs.docker.com/reference/cli/docker/compose/pull/)
- [`docker compose up`](https://docs.docker.com/reference/cli/docker/compose/up/)
- [`docker compose ps`](https://docs.docker.com/reference/cli/docker/compose/ps/)
- [`docker compose images`](https://docs.docker.com/reference/cli/docker/compose/images/)

Useful operations:

| Operation         | Command/option                                           | Implementation use                                                                      |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Resolve model     | `compose config --format json`                           | Canonical services, interpolated image refs, profiles, platform, and dependencies.      |
| Resolve/pin tags  | `compose config --resolve-image-digests`                 | Standard Compose path to render tags as digests; capability-probe before relying on it. |
| Emit pin override | `compose config --lock-image-digests`                    | Can produce a digest override; useful for plan/apply artifacts when supported.          |
| Pull              | `compose pull --policy always SERVICE...`                | Fetch service images without starting containers.                                       |
| Recreate          | `compose up -d --force-recreate --pull never SERVICE...` | Use already-pulled, pinned images and recreate selected containers.                     |
| Wait              | `compose up --wait --wait-timeout N`                     | Wait until services are running or healthy; implies detached mode.                      |
| Status            | `compose ps --all --format json SERVICE...`              | Machine-readable `Service`, `State`, `Health`, and `ExitCode`.                          |
| Image inventory   | `compose images --format json SERVICE...`                | Images used by already-created Compose containers.                                      |

`compose config --resolve-image-digests` and `--lock-image-digests` are promising replacements for the
current experimental manifest command because Compose owns name normalization and Docker credential
use. The official reference documents both options but does not state a minimum Compose version on that
page. rfapps should either establish a minimum supported Compose version or capability-probe once at
startup and provide a precise fallback/error.

### Docker Engine inspection and health

Primary references:

- [`docker container inspect`](https://docs.docker.com/reference/cli/docker/container/inspect/)
- [`docker image inspect`](https://docs.docker.com/reference/cli/docker/image/inspect/)
- [Dockerfile `HEALTHCHECK`](https://docs.docker.com/reference/dockerfile/#healthcheck)
- [Docker Engine API and official SDKs](https://docs.docker.com/reference/api/engine/)

Capture these fields before and after recreation:

- Container: `.Id`, `.Image` (local image ID), `.Config.Image`, `.State.Running`, `.State.ExitCode`,
  `.State.Restarting`, `.State.Health.Status`, and recent `.State.Health.Log` output.
- Image: `.Id`, matching `.RepoDigests`, and platform metadata when available.

Docker health begins as `starting`, becomes `healthy` after a successful probe, and becomes `unhealthy`
after the configured consecutive failures. A service without a health check can only be verified as
running unless rfapps has an explicit TCP/application probe. Health log output is diagnostic and may
contain application data, so structured reports should truncate and avoid persisting secrets.

## Libraries/SDKs

### Recommended: existing subprocess layer

Continue using `execDocker` and `execDockerCompose` from `src/lib/docker.ts`. This matches the existing
architecture and preserves support for Docker contexts, SSH, dotenvx/1Password wrapping, CLI credential
helpers, profiles, and Compose interpolation. Add typed helpers for digest resolution, pinned overrides,
target status, and exact image verification rather than introducing a second Docker transport.

### Built-in Node.js `fetch`

Node 22's built-in `fetch` is sufficient for Registry V2 `HEAD`/`GET` calls, but HTTP transport is the
easy part. A production implementation would also need image-reference normalization, Bearer challenge
parsing, Docker config and credential-helper integration, private/insecure registry policy, redirects,
proxy behavior, media-type handling, and platform selection. Use direct HTTP only if Compose-based
resolution proves inadequate.

### Docker Engine SDKs

Docker officially provides Engine SDKs for Go and Python, not TypeScript. Adding an unofficial Node SDK
would duplicate the working CLI boundary and create API-version/context/auth compatibility work. The
official Engine API is versioned and negotiates compatibility; the Docker CLI already performs that
negotiation. No new runtime dependency is recommended for this feature.

### Docker manifest/buildx commands

- `docker manifest inspect` is officially marked experimental and may change or disappear. It should
  not remain the only detection backend.
- `docker buildx imagetools inspect --raw` exposes raw manifest/index JSON and is useful for diagnosis,
  but Buildx is an additional plugin dependency. Treat it as an optional fallback or debug command, not
  the baseline contract. Official reference:
  [`imagetools inspect`](https://docs.docker.com/reference/cli/docker/buildx/imagetools/inspect/).

## Integration Patterns

### 1. Detect and freeze an actionable update plan

For each selected, registry-backed service:

1. Resolve the canonical service model and skip build-only services unless a separate build-update
   policy exists.
2. Inspect the running container and local image.
3. Select the local `RepoDigests` entry matching the normalized desired repository.
4. Resolve the desired tag remotely.
5. Classify the result as `update`, `current`, `local-missing`, `pinned`, or `unknown/error`.
6. When local and remote digests differ, set an actionable plan change such as `recreate` and preserve
   `reason: image-update`, `fromDigest`, `toDigest`, `platform`, and resolution time.

Do not reuse the current meaning of `image.changed` alone: `current` and `desired` tags can be identical
while their registry digests differ. Apply selection, plan summary, display, and persisted JSON all need
an explicit update action/reason.

### 2. Capture an exact pre-update generation

Before any pull changes a mutable local tag, record:

```typescript
interface UpdateGenerationImage {
  service: string;
  configuredReference: string;
  immutableReference: string; // normalized repository@sha256:...
  manifestDigest: string;
  manifestMediaType?: string;
  imageId: string; // local config/image ID used by the old container
  platform?: { os: string; architecture: string; variant?: string };
  containerId: string;
}
```

The existing `image_tag` column can remain for display compatibility, but deterministic restore needs
the immutable reference. Prefer explicit schema fields; if stored temporarily in `config_snapshot`, use
a versioned JSON envelope rather than overloading the current unversioned service diff.

### 3. Apply the exact planned digest

Generate a restricted temporary override from trusted service names and planned digests:

```yaml
services:
  traefik:
    image: docker.io/library/traefik@sha256:PLANNED_DIGEST
```

Then execute the same Compose file set through every phase:

```bash
docker compose -f compose.yml -f /tmp/rfapps-update-PLAN.yml \
  pull --policy always traefik

docker compose -f compose.yml -f /tmp/rfapps-update-PLAN.yml \
  up -d --force-recreate --pull never --wait --wait-timeout 120 traefik
```

This is stronger than pulling `traefik:latest`: if the tag moves after preview, the digest-pinned plan
still deploys exactly what the user approved. Validate generated service names and digest syntax instead
of interpolating arbitrary strings into YAML. Create the override with restrictive permissions and
remove it in `finally`; it must never contain environment values or other secrets.

### 4. Verify the target, not only its dependencies

After `up` succeeds:

1. Run `compose ps --all --format json` for every target.
2. Require `State === "running"`.
3. If `Health` exists, require `Health === "healthy"`; `starting` remains pending until timeout and
   `unhealthy` is failure.
4. Inspect each container and require its local `.Image` ID to equal the ID obtained by inspecting the
   planned immutable reference.
5. Run the repository's existing dependency/TCP readiness checks as an additional layer.

The image-ID equality check proves that Compose did not leave the old container running and did not
resolve a different image. For services without Docker health checks, report the weaker assurance
explicitly (`running-only` or `tcp-ready`) rather than labeling them healthy.

### 5. Restore on failure

On pull, recreation, health, or image-verification failure:

1. Preserve the original failure as the update result.
2. Create a restore override using the pre-update generation's immutable reference.
3. Pull that digest only if it is absent locally.
4. Run targeted `up -d --force-recreate --pull never --wait` with the restore override.
5. Re-run target image and health verification.
6. Record both outcomes: `update=failed` and `restore=succeeded|failed`, with source and restored
   generation numbers.

Do not claim that application data was rolled back. Compose recreation preserves mounted volumes, so
image restore does not reverse database or volume migrations. A failed restore must be a distinct,
high-severity result and exit nonzero.

### 6. Make execution resumable and observable

Persist a lifecycle/run ID and per-service phase (`detected`, `approved`, `pulled`, `recreated`,
`verified`, `restoring`, `restored`, `failed`). Structured output should include old/planned/actual
digests, old/new/restored generations, elapsed verification time, and a stable failure code. This allows
interrupted runs to be diagnosed without treating a half-applied update as success.

## Constraints/Gotchas

- **Mutable tags are not rollback identifiers.** Always store and apply `repository@digest`.
- **Digest namespaces differ.** Never compare a registry manifest digest to `.Id` or a manifest's
  `config.digest`.
- **Multi-platform indexes matter.** Preserve media type and platform; do not take an arbitrary first
  child descriptor.
- **Repository matching matters.** Select the matching `RepoDigests` entry after canonical name
  normalization; do not use array element zero.
- **Pinned Compose images are not update candidates.** A service already configured with `@sha256`
  is current by definition until the Compose configuration changes.
- **Built services are separate.** `build:` without a pullable `image:` needs build/cache policy, not
  registry update detection.
- **Private registry auth must remain opaque.** Never persist Bearer tokens, passwords, or decoded
  Docker credentials.
- **Registry errors are not "current."** Unknown state must be visible and normally block apply for
  that service.
- **Plan staleness has two dimensions.** Validate the Compose hash and the frozen digest contract. A
  moving tag does not invalidate a digest-pinned plan, but a missing/deleted digest does.
- **Pull can retag local names.** Capture the old image ID and digest before pulling a mutable tag.
- **`up --wait` is necessary but not sufficient.** It only has strong application semantics when the
  service defines a meaningful health check.
- **Dependencies and sidecars need policy.** Restore the target and any service forced to recreate as
  one transaction, but do not silently update unrelated dependencies.
- **Volume/database compatibility is outside image rollback.** Warn before updates known to include
  irreversible migrations; automatic restore cannot repair data schema changes.
- **Remote Docker contexts affect verification.** All resolve, pull, inspect, and up calls must use the
  same Docker context/SSH/env-tool configuration.
- **Compose feature availability varies.** Capability-probe `--wait`, `--wait-timeout`,
  `--resolve-image-digests`, and `--lock-image-digests`, or publish a minimum Compose version.
- **Do not parse human tables.** Prefer documented JSON output and typed validation; Compose `ps`
  produces JSON Lines, not necessarily one JSON array.
- **Current orphan cleanup is too broad for a transactional service update.** Avoid an unrelated
  project-wide `--remove-orphans` cleanup during the critical update/restore phases.

## Code Examples

### Capability probe

```typescript
async function requireUpdateCapabilities(): Promise<void> {
  const [composeVersion, upHelp, configHelp] = await Promise.all([
    execDockerCompose(["version", "--short"], { captureOutput: true }),
    execDockerCompose(["up", "--help"], { captureOutput: true }),
    execDockerCompose(["config", "--help"], { captureOutput: true }),
  ]);

  if (!composeVersion.success || !upHelp.stdout.includes("--wait")) {
    throw new Error("Managed updates require Docker Compose with `up --wait`");
  }
  if (!configHelp.stdout.includes("--resolve-image-digests")) {
    throw new Error("Docker Compose cannot resolve image digests on this host");
  }
}
```

### Actionable update classification

```typescript
type UpdateState =
  | { status: "current"; digest: string }
  | { status: "update"; fromDigest: string; toDigest: string }
  | { status: "local-missing"; toDigest: string }
  | { status: "pinned"; digest: string }
  | { status: "unknown"; code: string; message: string };

function classifyUpdate(localDigest: string | undefined, remoteDigest: string): UpdateState {
  if (localDigest === undefined) return { status: "local-missing", toDigest: remoteDigest };
  if (localDigest === remoteDigest) return { status: "current", digest: remoteDigest };
  return { status: "update", fromDigest: localDigest, toDigest: remoteDigest };
}

// Plan synthesis must turn `status: "update"` into an actionable recreate,
// even when configuredReference is unchanged (for example, `traefik:latest`).
```

### Exact post-apply verification

```typescript
interface ComposePsRecord {
  ID: string;
  Service: string;
  State: string;
  Health: string;
  ExitCode: number;
}

async function verifyAppliedImage(containerId: string, immutableReference: string): Promise<boolean> {
  const [container, image] = await Promise.all([
    execDocker(["inspect", "--format", "{{.Image}}", containerId]),
    execDocker(["image", "inspect", "--format", "{{.Id}}", immutableReference]),
  ]);

  return container.success && image.success && container.stdout.trim() === image.stdout.trim();
}
```

## Open Questions

1. What minimum Docker Compose version will rfapps support? If no minimum is declared, which fallback
   should be used when digest-resolution or wait flags are absent?
2. Should the Registry V2 HTTP client exist at all, or should update detection require Compose's
   digest-resolution support to preserve credential-helper and context behavior?
3. Should a plan pin the top-level multi-platform index digest or the selected platform manifest
   digest? The top-level digest is simpler for Docker pull; explicit platform digests provide tighter
   reporting but require exact platform selection parity.
4. Should generations gain explicit `image_digest`, `image_id`, `platform`, and lifecycle/run columns,
   or should a versioned generation JSON envelope hold this data?
5. How should services without Docker health checks be treated: running-only success, TCP readiness,
   configurable grace period, or ineligible for automatic restore decisions?
6. Is restore atomic per service, per dependency phase, or for the entire selected batch? Batch restore
   has larger blast radius; per-service restore can leave cross-service versions mixed.
7. Should an update abort before recreation if the planned digest is no longer retrievable, or may it
   re-plan interactively? Non-interactive mode should never silently substitute a new digest.
8. How are migration-sensitive services declared so the CLI can warn that image restore does not undo
   volume/database changes?
9. Should the update command reuse saved plan files directly or introduce a versioned lifecycle artifact
   that references a plan plus pre-update generation IDs and restore status?
10. Should registry errors fail the whole batch or isolate one service? The safest default is to skip
    mutation for the affected service, continue only independent services, and return nonzero overall.
