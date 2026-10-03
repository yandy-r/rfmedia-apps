# Native rfapps Backup and Disaster Recovery

## Problem

rfapps can rebuild its own state database and recover container images, but it cannot create a
portable backup of the bind-mounted and named-volume data that makes a Compose deployment useful.
Operators currently assemble ad hoc `tar`, database, and Docker commands with no shared scope
resolution, completeness record, or integrity verification. Issue #160 closes that first-layer gap
with a deliberately narrow cold filesystem backup and an offline verifier.

## Design Goals

1. Back up persistent directory data used by an explicit service, service list, group, interactive
   selection, or explicit all-services selection.
2. Quiesce every detected running writable consumer in the resolved Compose project, including
   services that mount an equal, ancestor, or descendant bind source outside the requested group,
   and restore the exact container IDs that were running before the backup.
3. Produce one private, versioned bundle with a manifest, per-archive byte counts and SHA-256
   checksums, selection/consumer provenance, consistency metadata, and structured restore hints.
4. Verify a bundle later without Docker, Compose, the original configuration, or archive
   extraction.
5. Preserve established rfapps output, dry-run, confirmation, error, exit-code, selection,
   configuration, and Bash/Zsh/Fish completion behavior.

## Non-Goals

- Application-native PostgreSQL, Redis, SQLite, or service-specific dump hooks
- Online or point-in-time-consistent backups
- Automated restore or archive extraction
- Scheduling, retention, pruning, remote upload, encryption, or signatures
- Anonymous volumes, non-directory bind sources, tmpfs, secrets/configs, devices, sockets, or
  platform-specific mount types
- Mutation by host processes, containers outside the resolved Compose project, or non-rfapps
  clients; lifecycle exclusion is local and cooperative
- MCP exposure

These concerns may become separate issues, but they are not prerequisites for issue #160.

## CLI Contract

### Create a Backup

```text
rfapps backup [selection options] --destination <directory>
```

Selection options are the existing `-s/--service`, `--services`, `-g/--group`,
`--no-sidecars`, `-f/--compose`, `-e/--env-file`, and `-p/--profile` options plus `--all`.
`--destination` is required so a potentially large or sensitive backup is never silently written
into a repository or home directory.

- In an interactive terminal using human text/table output, omitting a target opens the existing
  service selector unless global `--yes` is present.
- In a non-interactive terminal, any machine-output mode, or any invocation with global `--yes`, an
  explicit target or `--all` is required; backup never inherits the shared resolver's implicit-all
  sentinel.
- `--dry-run` resolves the complete storage and quiesce plan when inspect-only helper resolution
  succeeds. If the helper is absent, it returns stable failure evidence while still creating no
  directory, pulling no image, taking no lock, stopping no service, and prompting for no approval.
  A cached-helper dry-run may create only short-lived sandboxed read-only probe containers required
  by the Docker authority; every probe is strictly awaited and removed, and cleanup failure makes
  the dry-run fail.
- A real backup shows one plan and requests one confirmation unless global `--yes` is present.
- Machine-output creation requires global `--yes`; it never prompts.
- `--all` is mutually exclusive with service/group selectors.
- JSON and YAML emit one versioned result document. Table and text are human summaries. CSV is
  rejected as a usage error because nested storage, recovery, and integrity evidence cannot be
  flattened without loss.

The destination contains a generated, no-overwrite bundle directory:

```text
<destination>/rfapps-backup-<project>-<UTC timestamp>/
  manifest.json
  artifacts/
    mount-0001.tar.gz
    mount-0002.tar.gz
```

### Verify a Backup

```text
rfapps backup verify <manifest>
```

Verification is read-only and lock-free. It validates the strict manifest schema and safe
bundle-relative paths, rejects symlink substitution, streams every declared regular archive,
compares exact byte counts and SHA-256 checksums, and reports all integrity failures in
deterministic order. It never loads rfapps configuration, invokes Docker, stops services, or
extracts an archive.

## Storage Discovery and Classification

The workflow reads the fully interpolated, normalized Compose model through the existing canonical
Compose evidence adapter. It never parses raw YAML or colon-delimited mount strings.

For the resolved selected services and the full resolved Compose project:

- Exact duplicate sources become one artifact with every consumer recorded.
- Directory-shaped bind sources and stable named volumes are eligible. Bind kind/existence is
  probed through the selected Docker authority, never by client-local `stat()` for a remote daemon.
- Every consumer is recorded, but only consumers with `read_only === false` are writers.
- Writable equal, ancestor, and descendant bind mounts across the full Compose project contribute
  to the quiesce set. Lexically ambiguous or daemon-unrepresentable paths fail closed.
- Nested bind sources fail preflight because independently archiving parent and child sources would
  create ambiguous restore ownership.
- Anonymous volumes, unknown mount types, missing sources/volumes, and non-directory bind sources
  fail preflight when they are writable persistent data.
- tmpfs, read-only host system files, Docker sockets, devices, and sources rooted at `/dev`,
  `/proc`, `/sys`, `/run`, or `/var/run` are recorded as intentionally skipped with stable reason
  codes.
- No eligible source may disappear from either the terminal result or the manifest.
- For a local Docker authority, the existing canonical destination directory and reserved bundle
  path may not equal or sit beneath an eligible bind source. The destination must already be an
  owned, writable, real directory with no symlinked path component. Remote daemon bind sources and
  client-local destinations are different authority namespaces and are not compared lexically.

The v1 planner uses these stable classification codes:

- skips: `NON_PERSISTENT_TMPFS`, `HOST_SYSTEM_PATH`, `SOCKET_SOURCE`, `DEVICE_SOURCE`, and
  `READ_ONLY_SYSTEM_FILE`;
- preflight failures: `ANONYMOUS_VOLUME`, `UNSUPPORTED_MOUNT_TYPE`, `BIND_SOURCE_MISSING`,
  `BIND_SOURCE_NOT_DIRECTORY`, `NAMED_VOLUME_MISSING`, `NESTED_SELECTED_BIND`,
  `AMBIGUOUS_BIND_PATH`, `DESTINATION_INSIDE_SOURCE`, and `SOURCE_PROBE_FAILED`.

## Cold-Backup Lifecycle

The creation action and coordinator follow this order:

1. Resolve the Compose project, Docker authority, and requested services. A real creation ensures
   the fixed helper image is available before source probing; dry-run uses an inspect-only helper
   lookup, never pulls, and fails closed with stable probe evidence when the helper is unavailable.
   This preparation is required because remote bind kind/existence can only be proved by the Docker
   authority through the pinned helper.
2. Validate and canonicalize the existing destination without writing, resolve canonical mounts,
   the consumer graph, and the deterministic probe-backed archive plan, then render that complete
   plan—including local destination/source containment—before the single operation confirmation.
3. After confirmation, atomically reserve the final private bundle directory with exclusive
   `mkdir`; absence of `manifest.json` marks an incomplete attempt. Pinned helper cache preparation
   plus strictly cleaned sandboxed probe containers are the only permitted pre-confirmation Docker
   mutations; declining confirmation creates no bundle and stops no service.
4. Re-resolve the helper's immutable local image identity without widening its pinned reference.
   Creation already holds the root state lock acquired by the CLI; acquire the project/Docker-
   authority lifecycle lock used by managed mutations. Dry-run and verification acquire neither.
5. Under the lifecycle lock, rerun helper inspection and the probe-backed planner, then require
   exact equality with the approved helper identity, authority/config fingerprints, mount
   classifications, consumers/writers, quiesce set, skips, and recovery layers. Any drift fails
   before service stop and removes the reserved manifest-less bundle.
6. Capture every running container ID for writer services, stop those services, then re-observe the
   full writer set. Refuse to archive while any declared writer remains running.
7. Archive each eligible source through a short-lived helper container with one read-only source
   mount. Stream stdout through gzip, SHA-256, byte counting, and an exclusive local file.
8. Close and sync every archive. Once any stop was attempted, stabilization always re-observes
   state and starts each captured container ID that is no longer running, in dependency-first
   service layers. It never calls the existing `docker compose up --remove-orphans` helper.
9. After exact recovery succeeds, write and sync a temporary manifest, publish `manifest.json`
   with an atomic no-replace regular-file primitive, and sync the bundle and destination
   directories. Cross-filesystem publication is not supported.
10. Remove the private manifest-less bundle after an ordinary failure once recovery succeeds.
    Retain it only when recovery itself fails, with `stagingDisposition:
"retained-incomplete"` and its exact path in the failure result.

Recovery runs in a `finally` boundary after any stop attempt, including a partial or timed-out stop.
Primary and recovery failures are both preserved. SIGINT/SIGTERM request cancellation but process
termination is deferred until helper cleanup and exact-container recovery finish; the signal is
re-raised afterward. Recovery uses captured container IDs and Docker authority so a later Compose
parse/revalidation failure cannot suppress the restart attempt. A manifest-less retained directory
is not a valid bundle and `backup verify` rejects it.

The manifest truthfully records `consistency: "detected-compose-writers-stopped"`. This means every
detected writable equal/overlapping consumer in the resolved Compose project was stopped and
re-observed during each archive. It does not claim exclusion of host processes, other Compose
projects/clients, alias paths the daemon cannot prove, atomicity across filesystems, or
application-native consistency.

## Archive Adapter

The Docker layer gains a binary-safe streaming process boundary; the existing bounded UTF-8
`execDocker()` path is not used for archive bytes.

- Commands use argv arrays only, never `sh -c`.
- Both bind sources and named volumes are mounted read-only at a fixed helper path.
- Archive bytes stream over Docker CLI stdout to a client-local temporary file, so the design does
  not bind-mount a client path into a possibly remote daemon.
- Stderr remains bounded and sanitized.
- Each retry creates a fresh helper, gzip/hash/count pipeline, and exclusive temporary file. Any
  child, sink, SSH, or timeout failure tears down that attempt and restarts from byte zero; archive
  bytes and digest state are never appended or reused.
- Archive execution uses a bounded inactivity timeout suitable for large streams, not the existing
  five-minute wall timeout. Cancellation and signals flow through the coordinator's recovery
  boundary.
- The source-controlled helper reference is
  `docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1`.
  It is obtained before services stop, resolved to an immutable daemon-local image ID, and executed
  by that ID. The helper has a unique attempt/container identity, no network, a read-only root
  filesystem, all capabilities dropped, `no-new-privileges`, exactly one read-only source mount,
  and direct tar argv.
- Docker's comma-delimited mount mini-language is encoded safely or rejected before execution;
  passing one argv value alone is not sufficient validation.

## Manifest Contract

`manifest.json` is an exact, runtime-validated `rfapps-backup.v1` document containing:

- creation/completion timestamps and `detected-compose-writers-stopped` consistency;
- Compose project, resolved-config SHA-256, and one-way Docker-authority fingerprint;
- requested, resolved, quiesced, and previously-running service arrays;
- helper image reference and resolved identity;
- intentionally skipped sources and stable reasons;
- a deterministic mount entry for every archive:
  - opaque ID and bundle-relative archive path;
  - `bind` or `volume` discriminator and canonical source identity;
  - all Compose consumers, targets, and read-only flags;
  - byte count and lowercase SHA-256;
  - structured restore strategy, destination identity, and stopped-consumer precondition;
- bounded warnings explaining filesystem-level and database-consistency limitations.

The manifest is sensitive topology metadata. Bundle directories use mode `0700`, regular files use
`0600`, existing bundle paths are never overwritten, and untrusted manifest paths may not be
absolute, contain `..`, escape the bundle, traverse a symlink, or resolve to a non-regular file.
SHA-256 proves byte integrity only; it is not authenticity or signing. Runtime validation caps the
manifest at 4 MiB, mount/artifact entries at 10,000, warnings at 1,000, and individual strings at
4,096 bytes; IDs and artifact paths must be unique. The verifier opens the manifest and archives
with no-follow semantics, compares path and handle identity, requires regular files, and reports
undeclared regular files under `artifacts/` as integrity failures.

Restore hints are strict discriminated unions, never shell snippets:

- bind: `kind: "bind-tar"`, canonical source path, and stopped-writer precondition;
- volume: `kind: "volume-tar"`, effective Docker volume name, driver metadata, and stopped-writer
  precondition.

## Terminal Result Contracts

Creation emits `rfapps-backup-result.v1`; verification emits
`rfapps-backup-verify-result.v1`. Both include `operation`, `status`, `success`, `exitCode`,
`dryRun`, bounded warnings/errors, and summary counts.

Creation additionally includes requested/resolved/writer/previously-running scopes; destination,
bundle, and manifest paths when applicable; complete planned/skipped/artifact outcomes; primary
failure; per-container recovery failures; and `stagingDisposition` (`none`, `removed`, `published`,
or `retained-incomplete`). Verification includes the supplied manifest/bundle, every declared and
unexpected artifact outcome, and mismatch/missing/unsafe-path counts. Human text/table output is a
rendering of these same typed facts.

## Output and Exit Codes

- `0`: dry-run completed, backup bundle published and services restored, or every declared artifact
  verified.
- `1`: Docker/filesystem/archive/restart failure, missing artifact, size mismatch, or checksum
  mismatch.
- `2`: invalid CLI usage, unsafe destination/manifest, unsupported schema, or cancelled approval.
- `3`: not used for creation because a valid bundle is all-or-nothing. Verification may report all
  entry failures but still exits `1`.

Human progress and plans go to stderr. Structured modes emit exactly one terminal result and do not
leak secrets, raw Docker endpoints, environment values, or unbounded helper stderr.

## Critical Tests

Only tests that prove a distinct contract boundary are required:

1. Planner: exact-source deduplication, complete shared-consumer quiesce set, explicit system/tmpfs
   skips, full-project parent/child writer overlap, destination-inside-bind refusal, and fail-closed
   unsupported/nested persistent sources.
2. Coordinator: dry-run has no persistent output, image-cache, lock, or lifecycle mutation beyond
   strictly cleaned authority probes; a real backup holds both lock namespaces, re-observes stopped
   writers, exactly recomputes the approved plan under the lifecycle lock, streams/publishes all
   artifacts, and restores exact captured container IDs after success, partial stop, archive
   failure, or interruption.
3. Artifact/verify: private no-clobber publication, binary size/SHA-256 success, mismatch/missing
   and unexpected-file reporting, bounded strict wrong-version/traversal/symlink refusal.
4. Docker adapter: exact sandboxed shell-free read-only mount argv, remote bind probing, binary
   stdout-to-file streaming, fresh retry after emitted bytes, inactivity timeout, and cleanup.
5. CLI/output: registration, required targeting/destination rules, one confirmation, machine-mode
   authorization, lock-free dry-run/verify, both versioned result envelopes, CSV refusal, and stable
   exit mapping. Cached-helper dry-run succeeds without pulling and cleans every transient probe;
   missing-helper dry-run returns stable failure evidence without Docker mutation; first-run real
   creation prepares the pinned helper before probing; declined confirmation creates no bundle and
   stops no service.
6. Completion: one table-driven parity test proves the Commander surface and nested `verify`
   context across Bash, Zsh, and Fish; one three-shell assertion proves destination and manifest
   path-value completion.

Generic Docker retry, formatter, service-resolution, hashing, and filesystem behaviors already
covered elsewhere must not be duplicated.

## Documentation and Roadmap

The delivery updates:

- `packages/rfapps-cli/README.md` with command syntax, safety, manifest, and exit behavior;
- `docs/features/rfapps-backup.md` as the authoritative operator contract;
- `docs/guides/backup-restore.md` to replace stale claims that rfapps has no backup capability while
  retaining database-native guidance;
- `docs/features/shell-completion.md`, `docs/features/quick-reference.md`,
  `docs/features/json-output.md`, and `docs/features/error-handling.md` where their public contracts
  change;
- `README.md`, `docs/README.md`, `packages/rfapps-cli/CLAUDE.md`, and
  `docs/features/output-formats.md` for command/architecture/output navigation;
- `ROADMAP.md` for live delivered status. `docs/roadmap-archive.md` changes only if the enclosing
  rfapps follow-on track is actually archived.

All three shell templates are changed because `backup` and nested `verify` add new command surfaces.

## Child-Issue Decision

No blocking child issue is required. Creation and verification share one new schema and together
form the smallest useful, independently testable release; landing either without the other would
leave an unverified artifact contract or a verifier with no producer. The implementation plan uses
separate dependency-bounded batches and commits for reviewability inside one PR. Database hooks,
automated restore, scheduling/retention/remote storage, cryptographic signing/encryption, and new
mount/platform types are non-blocking future work and are not implied by this delivery.

## Acceptance Criteria

- Service, multi-service, group, interactive, and explicit all selection produce one fully expanded
  deterministic backup plan.
- Cached-helper dry-run produces that plan without persistent output, image-cache, service, or lock
  mutation; absent-helper dry-run fails with stable evidence and zero pulls/writes/locks. The only
  cached-helper dry-run Docker mutation is a
  strictly awaited, sandboxed, read-only authority probe container that must be removed; any cleanup
  failure fails the run. First-run real creation prepares only the pinned helper cache and those
  probes before confirmation, then shows the complete plan; a declined confirmation creates no
  bundle and stops no service.
- Every eligible selected bind directory or named volume is archived exactly once, with all
  consumers represented.
- Every detected running equal/overlapping writer in the resolved Compose project is stopped and
  re-observed before archive reads; exact captured container IDs are restored afterward, including
  partial-stop, archive-failure, and interruption paths.
- The published private bundle contains a strict v1 manifest and a size/SHA-256-verified archive for
  every eligible source; no partial attempt can look complete because only a complete recovered
  attempt publishes `manifest.json`.
- `rfapps backup verify <manifest>` works without Docker and returns non-zero with stable evidence
  for malformed manifests, missing archives, size changes, or checksum changes.
- `--dry-run`, confirmation, `--yes`, both lock namespaces, machine output, errors, and exit codes
  follow existing rfapps contracts; dry-run and verification remain lock-free.
- Bash, Zsh, and Fish expose the same top-level command, creation options, nested verify command,
  and path completions.
- Focused tests, typecheck, build, formatter/lint gates, and repository-required integration tests
  pass.
- Public docs and `ROADMAP.md` no longer describe native backup as missing.
