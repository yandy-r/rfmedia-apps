# Architecture Research: issue-160-native-backup

## System Overview

`rfapps` is a Commander-based TypeScript CLI whose mature features separate option registration
(`packages/rfapps-cli/src/commands/`), interaction and output
(`packages/rfapps-cli/src/actions/`), deterministic/injectable coordination
(`packages/rfapps-cli/src/lib/`), and versioned data contracts
(`packages/rfapps-cli/src/types/`). A native backup fits this model as a dedicated `backup` command
group: bare `rfapps backup` creates a backup for a resolved service scope, while
`rfapps backup verify <manifest>` performs read-only integrity verification.

One cohesive delivery is architecturally feasible. Creation, manifest production, and verification
share the same artifact schema and checksum primitives, so splitting them would create a temporary
format without its validating consumer. No child issue is required for the issue's stated
file/named-volume scope. Database-aware quiescing, scheduling, retention/remote upload, and an
executable restore workflow are separate follow-ups because they introduce application-specific
hooks, background execution, storage policy, or destructive mutation; this issue should emit
restore hints only and clearly label filesystem archives as non-transactional.

The issue's four-file sketch is the correct core but not the complete integration surface. A
production delivery also needs registration in `packages/rfapps-cli/src/cli.ts`, Docker adapter
support in `packages/rfapps-cli/src/lib/docker.ts`, barrel exports, errors/formatters, tests,
documentation, and Bash/Zsh/Fish completion updates.

## Relevant Components

- `packages/rfapps-cli/src/cli.ts` — Root program, global options, pre-action validation, process
  exit handling, and state-lock classification. It should register `registerBackupCommand`; backup
  verification must remain lock-free, while creation needs deliberate serialization with lifecycle
  mutations.
- `packages/rfapps-cli/src/commands/state.ts` — Best nested-command precedent, including lazy action
  loading, command-level option validation, global help propagation, and different read/write
  semantics for sibling subcommands.
- `packages/rfapps-cli/src/commands/update.ts` — Best precedent for a large, safety-sensitive
  service/group-scoped command contract.
- `packages/rfapps-cli/src/commands/backup.ts` — New registration boundary. It should own Commander
  arguments/options and reject incompatible or blank values before loading actions.
- `packages/rfapps-cli/src/actions/backup.ts` — New interactive boundary. It should normalize raw
  options, load/apply configuration, resolve scope, obtain approval, call the coordinator, render
  text or structured output, and set documented exit codes.
- `packages/rfapps-cli/src/lib/backup.ts` — New data-only coordinator and artifact boundary. It
  should discover/deduplicate mounts, archive them, stream SHA-256 checksums, atomically publish the
  manifest, reload and strictly validate untrusted manifests, and verify every artifact.
- `packages/rfapps-cli/src/types/backup.ts` — New versioned manifest/result contracts. Use
  discriminated unions for `bind` versus `volume` entries and stable verification failure codes.
- `packages/rfapps-cli/src/lib/interactive-selection.ts` and
  `packages/rfapps-cli/src/lib/services.ts` — Existing `-s`/`--services`/`-g` resolution, compose
  validation, optional sidecar expansion, interactive selection, and profile inference.
- `packages/rfapps-cli/src/lib/config.ts`, `packages/rfapps-cli/src/types/config.ts`, and
  `packages/rfapps-cli/src/types/options.ts` — Layered config, CLI overrides, profile validation,
  and secrets-wrapper resolution. No new config section is required if the first version uses an
  explicit/default output directory; add one only if retention/helper-image policy becomes
  configurable.
- `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts` and
  `packages/rfapps-cli/src/lib/docker.ts` — Existing strict effective-Compose projection already
  exposes service mounts and top-level named-volume identities through
  `getCanonicalComposeConfig()`. This is preferable to parsing YAML because it honors interpolation,
  profiles, project naming, long/short mount syntax, external volumes, and Compose defaults.
- `packages/rfapps-cli/src/lib/identity.ts` — Canonical Compose path/project identity and Docker
  authority fingerprinting. The manifest should bind to the effective Compose project and Docker
  daemon without storing raw endpoints.
- `packages/rfapps-cli/src/lib/state-rebuild-files.ts` and
  `packages/rfapps-cli/src/lib/plan-storage.ts` — Relevant artifact precedents for private
  directories/files, refusal to overwrite, cleanup, atomic publication, strict untrusted JSON
  validation, and checksum use. Existing `hashFile()` reads UTF-8 and returns an empty string on
  failure, so it is not suitable for binary backup archives.
- `packages/rfapps-cli/src/lib/errors.ts`,
  `packages/rfapps-cli/src/lib/error-formatters.ts`, and
  `packages/rfapps-cli/src/lib/exit-codes.ts` — Typed validation/storage/Docker failures, user-facing
  suggestions, and stable `0`/`1`/`2`/`3` process outcomes.
- `packages/rfapps-cli/src/actions/completion.ts` and
  `packages/rfapps-cli/src/actions/completion.spec.ts` — Hand-maintained Bash, Zsh, and Fish command,
  subcommand, option, dynamic service/group, and path completion surfaces with parity tests.
- `compose.yml` — Demonstrates why both storage kinds matter: most service state is bind-mounted
  from `${DOCKER_DIR}`/`${DOCKER_DATA_DIR}`, while `model-cache` is a top-level named volume.
  Shared mounts such as `${DATA_DIR}`, `/etc/localtime`, and `/var/run/docker.sock` require
  classification and deduplication rather than blind per-service copying.

## Data Flow

1. `registerBackupCommand()` parses create options (`--service`, `--services`, `--group`,
   `--no-sidecars`, compose/env/profile overrides, and output destination) or routes
   `backup verify <manifest>` directly to verification.
2. Creation loads `RfappsConfig`, validates the profile, applies CLI overrides, resolves the
   canonical Compose identity/environment, and uses `resolveServicesWithInteractive()`. An empty
   resolved list means all services, so the action must materialize that scope before creating the
   manifest.
3. The coordinator reads the effective model with `getCanonicalComposeConfig()`, filters it to the
   selected services, normalizes each mount, and deduplicates shared sources. Each artifact retains
   all owning services and container targets so selection provenance and restore guidance are not
   lost.
4. `tmpfs`, anonymous volumes, sockets/device-like binds, and missing or unsupported sources must
   become explicit skipped/failed entries, never silently disappear. Read-only host/system mounts
   and broad shared media paths need visible policy because this repository contains both.
5. A Docker adapter archives named volumes and remote-host bind mounts through the selected Docker
   authority; local direct filesystem reads alone are incorrect when `DOCKER_CONTEXT` or
   `DOCKER_HOST` points elsewhere. Archive bytes stream to a private temporary local file while a
   streaming SHA-256 digest and byte count are computed.
6. The coordinator fsyncs/closes each completed artifact, records its relative path, size,
   `sha256:<hex>`, storage kind, source identity, ownership, timestamp, consistency limitation, and
   restore hint, then publishes a versioned manifest last. Temporary/partial files are removed on
   failure, and existing destinations are not overwritten implicitly.
7. Verification loads the manifest as untrusted input, enforces exact keys/schema/bounds/safe
   relative artifact paths, rejects traversal and symlink substitution, recomputes every archive
   checksum/size by streaming, and returns per-artifact plus aggregate status. It does not need
   Compose, Docker, secrets injection, service selection, or a lock.
8. The action emits human-readable progress on stderr or a stable result through
   `formatOutput()`. Complete verification/creation exits `0`, an operational or integrity failure
   exits `1`, invalid usage/manifest shape exits `2`, and mixed created/skipped/failed artifacts may
   use existing partial-success exit `3`.

## Integration Points

- **Command shape:** Model `packages/rfapps-cli/src/commands/state.ts`, but allow the parent
  `backup` command to create while `backup verify` is explicitly read-only. Keep option validation
  in the command and all prompting/output/process state in the action.
- **Selection semantics:** Reuse `resolveServicesWithInteractive()` exactly for service/group
  behavior, but decide sidecar policy explicitly. Automatic sidecar expansion is consistent with
  other lifecycle commands yet may add no data and can duplicate a main service's mounts; the
  manifest must show the resolved scope.
- **Compose evidence:** Reuse `getCanonicalComposeConfig()` instead of extending the loose
  `ComposeServiceConfig`, but add backup-specific normalization because named-volume service sources
  are Compose keys while top-level volume entries contain effective Docker names.
- **Docker execution:** Keep raw spawning in `packages/rfapps-cli/src/lib/docker.ts`. Current
  `execDocker()` converts buffered stdout to strings and caps it at 4 MiB, so backup needs a new
  binary-safe streaming-to-file adapter that preserves argument-array execution, env-tool wrapping,
  SSH retry/timeout behavior, signal forwarding, and bounded stderr. The coordinator should consume
  this through injected dependencies.
- **Remote authority:** Bind paths belong to the Docker daemon host, not necessarily the CLI host.
  A unified helper-container/archive stream works for both named volumes and remote binds; it also
  introduces a deliberate helper-image availability/pinning decision. Record
  `dockerAuthorityFingerprint()` in the manifest, not the raw Docker endpoint.
- **Consistency and concurrency:** The global state lock in `packages/rfapps-cli/src/cli.ts` already
  serializes ordinary Docker lifecycle mutations, while the project-scoped lifecycle lock protects
  managed update/reconcile. Backup creation should serialize against those mutation paths, but it
  still cannot guarantee application-consistent databases or a group-wide atomic snapshot.
  Verification should acquire neither lock.
- **Artifact security:** Follow private `0700` parent/`0600` file and no-overwrite patterns from
  state export and managed artifacts. Store archive paths relative to the manifest root and validate
  every path component before reading; manifests may reveal host paths and service topology and
  should be treated as sensitive.
- **Public exports:** Add `backup.ts` exports to `packages/rfapps-cli/src/types/index.ts` and any
  reusable coordinator/Docker symbols to `packages/rfapps-cli/src/lib/index.ts`. Add typed backup
  errors and formatter registration rather than leaking raw Docker/tar stderr.
- **Completions:** Add `backup` to all command lists; add nested `verify` recognition; expose service,
  group, profile, compose/env, output, and manifest-path completions in Bash, Zsh, and Fish.
  `completion.spec.ts` should compare each shell surface with Commander and guard Fish's
  context-sensitive subcommand matching.
- **Documentation/MCP:** Update CLI/feature/quick-reference documentation as part of the same
  delivery. Do not automatically expose backup creation through
  `packages/rfapps-cli/src/mcp/`; it writes sensitive artifacts and issue #160 only authorizes a CLI
  workflow. A read-only verify tool can be considered separately after the manifest contract
  stabilizes.

## Key Dependencies

- Node.js 22 built-ins: `node:crypto` streaming hashes, `node:fs`/`node:fs/promises` private and
  no-follow file handling, `node:path` safe relative resolution, streams/pipelines, and
  `node:child_process` for binary-safe Docker/archive transport.
- Commander.js for the parent command and `verify` subcommand; `@rfmedia/common` for confirmation,
  logging, machine-format detection, error output, and structured formatting.
- Docker Compose JSON (`docker compose ... config --format json`) for resolved services, mounts,
  profiles, project name, external flags, and effective named-volume names.
- Docker Engine commands for volume/bind access and helper-container execution. The helper image
  must be pinned or otherwise policy-controlled; assuming a host `tar` binary or buffering archive
  stdout through current `execDocker()` is not portable.
- Existing configuration/secrets plumbing (`loadConfig()`, `applyCliOverrides()`,
  `getEnvToolExecConfig()`) so Compose interpolation and Docker authority match the rest of the CLI.
- Existing identity and lock primitives (`resolveComposeProjectIdentity()`,
  `dockerAuthorityFingerprint()`, state/lifecycle locks) to bind the manifest to reviewed scope and
  avoid concurrent rfapps lifecycle mutation.
- Co-located Vitest coverage should include command parsing, scope/group/sidecar resolution, mount
  normalization/deduplication, local and remote adapter arguments, binary streaming, partial cleanup,
  strict manifest parsing, traversal/symlink refusal, checksum mismatch, missing artifacts, dry-run,
  output/exit-code behavior, and exact three-shell completion parity.
