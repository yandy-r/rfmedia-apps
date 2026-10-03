# Integration Research: issue-160-native-backup

## Overview

Issue #160 can ship safely as a cold, filesystem-level backup plus offline integrity verification.
The implementation should resolve the effective Compose model, quiesce every running consumer of a
selected writable mount, stream one archive per canonical mount from the Docker daemon to a private
local bundle, and publish a strict manifest only after every archive is durable and checksummed.
Database-aware dumps, restore execution, retention, and scheduling are separate follow-ups.

## API/CLI Surface

Recommended surface:

```text
rfapps backup [target options] --destination <directory>
rfapps backup verify <manifest.json>
```

- Creation supports the established `-s/--service`, `--services`, `-g/--group`,
  `--no-sidecars`, `-f/--compose`, `-e/--env-file`, and `-p/--profile` vocabulary from
  `packages/rfapps-cli/src/cli.ts` and `packages/rfapps-cli/src/types/options.ts`.
- Reuse `resolveServicesWithInteractive()` for group expansion, validation, de-duplication,
  sidecars, and profile selection; see
  `packages/rfapps-cli/src/lib/interactive-selection.ts` and
  `packages/rfapps-cli/src/lib/services.ts`. For this destructive/large operation, non-interactive
  creation should require an explicit target or an explicit `--all`; the existing empty-array
  "all services" sentinel is too easy to trigger accidentally.
- `verify` is local and read-only: it accepts the manifest path, loads only bundle-relative archive
  paths, validates the complete schema with size/count bounds, recomputes SHA-256 and byte size, and
  returns non-zero if any entry is absent, unexpected, malformed, or mismatched. It must not require
  Docker, Compose, the original config, or the original host.
- Global machine output and exit-code conventions should remain intact. Human progress belongs on
  stderr, while JSON/YAML output is one terminal result. `--dry-run` resolves and reports mounts and
  the quiesce set without stopping services, creating containers, or writing a bundle.
- Because backup stops services and creates helper containers, add it to the mutating-command lock
  set in `packages/rfapps-cli/src/cli.ts` and acquire the project/Docker-authority lifecycle lock
  from `packages/rfapps-cli/src/lib/lifecycle-lock.ts`.

## Database/State

- Do not add backup rows or archive metadata to `state.db`. That database records deployments and
  immutable image/config generations, not external artifacts; see
  `packages/rfapps-cli/src/lib/schema.sql` and `packages/rfapps-cli/src/types/state.ts`. The bundle
  manifest is the portable source of truth.
- A live byte copy is not database-consistent. This repository contains PostgreSQL bind mounts
  (`authentik-db`, `forgejo-postgres`, `immich-postgres`) and Redis data in `compose.yml`; the manual
  guide already distinguishes `pg_dump`, Redis save, and stopped Plex database procedures in
  `docs/guides/backup-restore.md`.
- The MVP must therefore be a **cold filesystem snapshot by default**: capture which selected/shared
  consumers were running, stop them, archive their mounts, and restart only those that were
  previously running. If stopping or archiving fails, attempt the restart in `finally` and report
  both the primary and recovery failures.
- This provides service-level quiescence, not transactional atomicity across storage devices.
  Record `consistency: "services-stopped"` and start/end timestamps rather than claim an atomic
  snapshot. An online mode should not be included in the first contract.
- The SQLite online-backup/fallback logic in
  `packages/rfapps-cli/src/lib/state-rebuild-files.ts` is a useful precedent for private
  permissions, no overwrite, recovery cleanup, and truthful consistency labels, but it is not a
  generic application-database hook.

## External Services and Tools

- Resolve storage from `docker compose ... config --format json`, not from raw YAML or colon
  splitting. `CanonicalComposeMountConfig` already distinguishes `bind`, `volume`, and `tmpfs`;
  top-level volumes already resolve effective runtime names in
  `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts`.
- Back up only directory-shaped `bind` and named `volume` mounts in v1. Skip `tmpfs` and read-only
  mounts, and fail closed on anonymous volumes, unsupported mount kinds, missing named volumes,
  non-directory bind sources, or system/device paths. This matters here because `compose.yml`
  includes `/var/run/docker.sock`, `/dev/dri`, `/dev/bus/usb`, `/etc/localtime`, shared media
  trees, and the named `model-cache` volume.
- Use one pinned helper image, mounted with exactly one source at `/source:ro`, and invoke `tar`
  directly with an argument array (never `sh -c`). Stream helper stdout through gzip, SHA-256, and
  an exclusive local file. This works across Docker contexts; mounting the CLI's local destination
  into a helper does not, because bind sources belong to the daemon host.
- `execDocker()` currently either buffers output or inherits stdio and caps ordinary capture; see
  `packages/rfapps-cli/src/lib/docker.ts`. Large backups require a sibling streaming process API
  that preserves its timeout, SSH retry policy, signal forwarding, bounded stderr, and env-tool
  execution without buffering archive bytes.
- The package has Node 22 crypto, streams, filesystem, and zlib available, but no direct tar/archive
  dependency in `packages/rfapps-cli/package.json`. `tar-fs` is only transitive in
  `package-lock.json` and must not be imported as an undeclared dependency.
- Docker documents both helper-container volume backups and `docker cp`/tar streaming. Relevant
  references: <https://docs.docker.com/engine/storage/volumes/>,
  <https://docs.docker.com/reference/cli/docker/container/cp/>, and
  <https://docs.docker.com/reference/compose-file/services/#volumes>.

## Internal Services

- Reuse canonical path/project resolution and one-way Docker authority identity from
  `packages/rfapps-cli/src/lib/identity.ts`. Record the Compose project name, resolved-config
  fingerprint, and Docker-authority fingerprint, never raw Docker endpoints or resolved
  environment values.
- Reuse the strict, allowlisted Compose projection and fingerprinting in
  `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts`; extend its mount projection only if
  backup needs fields such as volume subpaths. Do not use the older narrow `ComposeConfig` in
  `packages/rfapps-cli/src/lib/docker.ts`, which omits volumes.
- Determine every service consuming an exact selected source from the full canonical model.
  De-duplicate exact sources and fail on parent/child overlaps unless the bundle plan explicitly
  reduces them to one archive. Stop all running consumers, including consumers outside the
  requested group, or refuse the backup; otherwise a shared writable mount is not quiescent.
- Capture runtime state through Compose-scoped observations rather than container names alone.
  Existing patterns are `getComposeContainerObservations()` and the project binding used by
  `packages/rfapps-cli/src/lib/deploy-validation.ts`.
- Reuse `stopServices()`/`startServices()` with the same canonical project directory, project name,
  env file, profiles, and captured environment. Revalidate Compose and Docker authority immediately
  before stop and before restart so the reviewed sources cannot silently change.
- Shell completion is generated independently for Bash, Zsh, and Fish in
  `packages/rfapps-cli/src/actions/completion.ts`; the new command and nested `verify` surface need
  parity coverage there.

## Configuration

Add an optional `backup` block to `RfappsConfig` in
`packages/rfapps-cli/src/types/config.ts`, merged and validated by
`packages/rfapps-cli/src/lib/config.ts`:

```yaml
backup:
  destination: /mnt/backups/rfapps
  helperImage: docker.io/library/alpine:<release>@sha256:<digest>
  exclude:
    - /data/media
```

- `--destination` overrides `backup.destination`; require one of them. Do not silently place
  potentially huge archives in the repository or state directory.
- `helperImage` must be digest-pinned. Pulling may be necessary and must be reported; an unavailable
  helper fails before services are stopped.
- `exclude` matches canonical source identities, not container targets. The plan should display
  skipped mounts and reasons. Defaults must reject `/dev`, `/proc`, `/sys`, `/run`, and
  `/var/run`; explicit inclusion of system/device mounts remains unsupported in v1.
- Configuration cannot infer business criticality. For example, `model-cache` is reproducible while
  PostgreSQL data is critical, and broad `${DATA_DIR}` mounts overlap across services in
  `compose.yml`. The manifest must describe what was captured, not label the result a complete
  disaster-recovery backup.

## Security and Portability

- Treat mount contents, filenames, and manifests as untrusted. Never interpolate them into a shell
  command. Generate opaque archive names such as `mount-0001.tar.gz`, reject absolute or `..`
  manifest paths, and never extract during verification.
- Create the bundle directory mode `0700` and each temporary/final file mode `0600`; reject
  symlinked path components and existing destinations. Follow the `O_EXCL | O_NOFOLLOW`, sibling
  temporary file, `fsync`, atomic rename, strict size, and runtime-schema precedents in
  `packages/rfapps-cli/src/lib/plan-storage.ts`.
- Hash archive bytes while streaming with SHA-256, then sync and rename. Publish `manifest.json`
  last. A bundle without a manifest is incomplete; a manifest never references a partial file.
- The manifest is integrity metadata, not authentication. An attacker who can replace both archive
  and manifest can forge SHA-256 values. Signing/encryption and remote object storage are out of
  scope.
- Preserve numeric ownership and modes inside tar for Linux restore hints, while warning that bind
  source paths, UID/GID mappings, SELinux labels, volume drivers/options, and Docker Desktop paths
  are host-specific. Never promise cross-platform restore.
- Current canonical parsing accepts only `bind`, `volume`, and `tmpfs`, while current Compose also
  defines newer mount types. Unknown types must produce a clear unsupported error, not disappear
  from the backup.

## Recommended Contract

Use a versioned, strict `rfapps-backup.v1` manifest:

```json
{
  "schemaVersion": 1,
  "kind": "rfapps-backup",
  "createdAt": "2026-07-29T14:00:00.000Z",
  "completedAt": "2026-07-29T14:03:00.000Z",
  "consistency": "services-stopped",
  "compose": {
    "project": "rfmedia-apps",
    "resolvedConfigSha256": "<64 hex>",
    "dockerAuthoritySha256": "<64 hex>"
  },
  "requestedServices": ["authentik-db"],
  "quiescedServices": ["authentik-db"],
  "mounts": [
    {
      "id": "mount-0001",
      "kind": "bind",
      "source": "/srv/docker-data/authentik-db",
      "consumers": [{ "service": "authentik-db", "target": "/var/lib/postgresql/data" }],
      "archive": "mount-0001.tar.gz",
      "bytes": 123,
      "sha256": "<64 hex>",
      "restoreHint": {
        "strategy": "helper-tar",
        "destinationKind": "bind",
        "requiresStoppedConsumers": true
      }
    }
  ],
  "warnings": ["Filesystem-level backup; no database-native dump was performed."]
}
```

Creation succeeds only when all eligible selected mounts are archived, synced, hashed, the manifest
is atomically published, helper containers are removed, and previously running services are
restored. A partial archive set is retained only as an explicitly incomplete staging directory and
must not verify as a bundle. `verify` validates schema, relative paths, exact archive set, byte
counts, and SHA-256 without extracting data.

No blocking child issue is required if #160 is held to this cold file/volume plus verify contract.
Create non-blocking follow-ups for (1) PostgreSQL/Redis/application-native hooks and online
consistency, (2) an actual restore command with traversal/device-node defenses and restore testing,
(3) retention/scheduling/remote object storage/encryption/signing, and (4) additional Compose mount
types and platform-specific support. Those capabilities should not be implied by the v1 manifest.
