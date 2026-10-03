# Issue #160 Native Backup Code Analysis

## Executive Summary

Native backup should be implemented as a new, isolated feature family rather than
added to the already large generic Docker and plan-storage modules. The existing
CLI, action, dependency-graph, canonical Compose, lock, and formatting layers
provide useful seams, but none of the current file-writing or Docker execution
helpers satisfies the backup contract for manifest-last publication, binary
streaming, inactivity timeouts, exact-container recovery, or deferred signal
re-raising.

The safest dependency direction is: backup types and strict manifest validation;
secure artifact and Docker-stream adapters; deterministic planner; recovery-aware
coordinator; actions and command registration; then CLI lock integration,
completions, and end-to-end tests. Offline verification should remain a separate
action/import boundary so it cannot accidentally initialize configuration,
Docker, prompts, or locks.

## Existing Code Structure

### Command and action boundaries

- `packages/rfapps-cli/src/cli.ts`: constructs the root Commander program,
  reconciles global output flags, acquires the process-wide state lock in a
  `preAction` hook, registers commands, and releases the lock from `main()` in a
  `finally` block.
- `packages/rfapps-cli/src/commands/state.ts`: best example of a parent command
  with lazy-loaded nested actions and an injectable command dependency object.
- `packages/rfapps-cli/src/commands/update.ts`: representative single-action
  command with command-local validation and dynamic action import.
- `packages/rfapps-cli/src/actions/update.ts`: representative orchestration
  action. It resolves selection/configuration, owns approval and output, injects
  a coordinator factory, and sets `process.exitCode` from typed results.
- `packages/rfapps-cli/src/lib/interactive-selection.ts`: resolves explicit
  services, groups, sidecars, profiles, and optional interactive selection.
  Its empty non-interactive result means implicit "all", which backup must not
  inherit.

The relevant registration signatures are:

```ts
registerStateCommand(
  program: Command,
  dependencies: StateCommandDependencies = defaultDependencies,
): void

registerUpdateCommand(program: Command): void

executeUpdate(
  rawOptions: RawUpdateOptions,
  globalOptions: GlobalOptions,
  dependencies: UpdateActionDependencies = defaultDependencies,
): Promise<void>
```

`StateCommandDependencies` exposes async action loaders. The backup command
should use the same shape so syntax failures are reported before either the
creation or offline-verification action is loaded.

### Canonical Compose and runtime evidence

- `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts`: obtains
  `docker compose ... config --format json`, validates bounded JSON, produces a
  secret-free canonical projection, and fingerprints the complete resolved
  payload.
- `packages/rfapps-cli/src/lib/docker.ts`: exposes the canonical evidence
  wrapper, Compose container observation, normal Docker text execution, and
  service-level start/stop helpers.
- `packages/rfapps-cli/src/lib/dependency-graph.ts`: contains the pure
  topological ordering primitive used for dependency phases.
- `packages/rfapps-cli/src/lib/services.ts`: expands sidecars and auto-detects
  profiles, preserving insertion order rather than enforcing backup's stable
  sort.

Important existing types and signatures are:

```ts
interface CanonicalComposeConfigEvidence {
  config: CanonicalComposeConfig;
  resolvedConfigFingerprint: string;
}

interface CanonicalComposeMountConfig {
  type: "bind" | "volume" | "tmpfs";
  source?: string;
  target: string;
  read_only: boolean;
}

getCanonicalComposeConfigEvidence(
  composePath: string,
  options?: DockerExecOptions,
): Promise<CanonicalComposeConfigEvidence>

getComposeContainerObservations(
  composePath: string,
  options?: DockerExecOptions,
): Promise<readonly ComposeContainerObservation[]>

stopServices(
  composePath: string,
  services?: string[],
  options?: DockerExecOptions,
): Promise<DockerExecResult>

topologicalSort(
  dependencyMap: Map<string, string[]>,
  sidecarMapping: Record<string, string>,
): DependencyGraph
```

`ComposeContainerObservation` retains container ID, container name, service,
state, and health. It is the correct pre-stop evidence source because it
preserves multiple replicas. There is no current exact-container-ID restart
operation; existing Compose start/up helpers may recreate or widen scope.

### Locks

- `packages/rfapps-cli/src/lib/state-lock.ts`: implements the root state
  namespace with private-directory, ownership, anti-symlink, stale-lock, token,
  and idempotent-release protections.
- `packages/rfapps-cli/src/lib/lifecycle-lock.ts`: implements a project-scoped
  lifecycle lock keyed by canonical project path, Docker authority, and Compose
  project name.

Relevant signatures are:

```ts
acquireStateLock(options: AcquireStateLockOptions): Promise<StateLock>

acquireLifecycleLock(
  options: AcquireLifecycleLockOptions,
): Promise<LifecycleLock>

withLifecycleLock<T>(
  options: AcquireLifecycleLockOptions,
  operation: () => Promise<T>,
): Promise<T>
```

The CLI, not the coordinator, owns the root state lock. The backup coordinator
should own the lifecycle lock only for a real creation operation, after bundle
reservation and helper-image preparation and before pre-mutation revalidation.

### Artifact and schema precedents

- `packages/rfapps-cli/src/lib/plan-storage.ts`: strongest existing example of
  strict exact-key runtime validation, bounded reads, `O_NOFOLLOW`, path/handle
  identity comparison, private directories, and exclusive temporary files.
- `packages/rfapps-cli/src/lib/state-rebuild-files.ts`: demonstrates mode
  `0600` files, mode `0700` directories, backup-before-swap ordering, and
  same-directory rename.
- `packages/rfapps-cli/src/types/update.ts`,
  `packages/rfapps-cli/src/types/reconcile.ts`, and
  `packages/rfapps-cli/src/types/state-rebuild.ts`: show the preferred
  feature-local type-module organization.

Plan storage cannot be reused as-is. It is capped at 1 MiB, reserves empty
placeholder result files, and publishes by a POSIX rename that may replace an
existing destination. Backup requires a 4 MiB manifest cap, an absent manifest
until success, and no-replace final publication followed by durability sync.

### Output, errors, and test infrastructure

- `packages/rfapps-cli/src/formatters/index.ts`: provides
  `formatOutput(format, data, options?)`; text is handled by actions while
  JSON/YAML/CSV/table use shared serializers.
- `packages/rfapps-cli/src/errors.ts` and
  `packages/rfapps-cli/src/error-formatters.ts`: define dependency-free error
  types and the one-time error-formatter registry.
- `packages/rfapps-cli/src/exit-codes.ts`: defines exit codes 0, 1, 2, and 3 and
  feature-specific result resolvers.
- `packages/rfapps-cli/src/actions/completion.ts`: contains manually maintained
  Bash, Zsh, and Fish templates.
- `packages/rfapps-cli/src/actions/completion.spec.ts`: derives option names
  from actual Commander registrations and asserts shell-template parity.
- `packages/rfapps-cli/src/testing/cli-harness.ts`: creates isolated fixture
  projects and fake `HOME` values, puts a mock Docker executable on `PATH`, and
  spawns the real CLI while capturing stdout, stderr, exit status, signals, and
  Docker invocations.
- `packages/rfapps-cli/src/cli.state-rebuild.integration.spec.ts`: proves the
  private root-lock routing behavior through the real CLI and is the closest
  integration-test model for backup.

## Implementation Patterns with Examples

### Parent command with two execution modes

Model `registerBackupCommand` on `registerStateCommand`. Configure help on the
parent before adding the `verify` child, inject action loaders, and attach an
action to the parent so both forms work:

```ts
interface BackupCommandDependencies {
  loadCreateAction(): Promise<{
    executeBackup(options: RawBackupOptions, globals: GlobalOptions): Promise<void>;
  }>;
  loadVerifyAction(): Promise<{
    executeBackupVerify(manifestPath: string, options: RawBackupVerifyOptions, globals: GlobalOptions): Promise<void>;
  }>;
}
```

Validate `--all`/selection conflicts, required destination, and unsupported CSV
before loading either action. The verification loader must import only manifest,
filesystem, hashing, formatting, and error modules.

### Action/coordinator division

Follow `executeUpdate`: the action owns CLI normalization, interactive
selection, one approval prompt, machine-output policy, and terminal emission.
The coordinator accepts already validated, data-only inputs and returns a typed
result containing primary and recovery outcomes.

Use an explicit dependency interface for:

- configuration and selection;
- canonical Compose and container observation;
- destination/artifact operations;
- helper-image resolution;
- archive streaming;
- lifecycle lock acquisition;
- clock/ID generation and signal state.

This enables tests to prove that dry-run never creates directories, reserves a
bundle, pulls an image, prompts, acquires either lock, or stops a container.

### Strict manifest validation

Reuse the style, not the private functions, from `plan-storage.ts`:

- require the exact `rfapps-backup.v1` top-level and nested keys;
- cap encoded manifest input at 4 MiB before parsing;
- cap mounts/artifacts at 10,000, warnings at 1,000, and every string at 4,096
  bytes;
- reject duplicate identifiers and paths;
- reject absolute paths, traversal, empty segments, backslashes where relevant,
  and any non-canonical relative artifact path;
- reject symlinks and non-regular artifact files using `lstat`, `O_NOFOLLOW`,
  and path/handle device/inode comparison;
- compute size and SHA-256 from the opened handle, not from a later path lookup.

Return a fresh validated object instead of trusting or mutating parsed input.
The restore-readiness field should be a discriminated union so contradictory
states are unrepresentable.

### Binary Docker archive boundary

Do not route archive stdout through `execDocker`: it buffers output, converts it
to UTF-8 strings, uses a wall-clock timeout, and automatically re-raises parent
signals when detached children finish.

A backup-specific adapter should create a fresh attempt object for every retry:

```ts
interface ArchiveAttempt {
  helperContainerName: string;
  source: BackupMountSource;
  destinationTempPath: string;
}

interface ArchiveStreamResult {
  compressedBytes: number;
  sha256: string;
  sanitizedStderr: string;
}
```

Each attempt must create a new exclusive temp file, helper name, Docker child,
gzip transform, hash/count transform, inactivity timer, and stderr buffer.
Retryable SSH failure after any emitted byte still restarts from byte zero.
Always remove the attempt's helper and partial file.

The helper command must be direct argv, use the resolved local image ID, disable
networking, use a read-only root filesystem, drop capabilities, enable
`no-new-privileges`, and mount only the source read-only. Docker's `--mount`
value is itself a comma-delimited grammar; validate or reject source tokens that
cannot be encoded safely even though the shell is bypassed.

### Exact recovery

Capture all running writer container IDs immediately before stopping. After any
stop attempt, including a partial failure or timeout, reobserve the full writer
set. In `finally`, restart only captured IDs that are no longer running, in
dependency-first service layers. Add a narrow adapter around:

```text
docker container start <captured-container-id>
```

Do not use Compose `up` or service-level `start`, because they can recreate
containers, start previously stopped replicas, or include a wider scope.

The existing detached-process signal hook is unsuitable here: it queues
`process.kill(process.pid, signal)` as soon as its last child exits. Backup
needs a cancellation tracker that terminates active work, returns control to the
coordinator, completes exact recovery and cleanup, then re-raises the original
SIGINT or SIGTERM.

## Integration Points

| Area                  | Create or modify                                                                                                 | Required integration                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Backup domain types   | Create `src/types/backup.ts`; modify `src/types/index.ts`                                                        | Schema constants, manifest/plan/result/verify types, failure and skip codes, recovery evidence                             |
| Manifest validation   | Create `src/lib/backup-manifest.ts`                                                                              | Strict parse, exact keys, resource caps, safe relative paths, immutable validated result                                   |
| Secure artifacts      | Create `src/lib/backup-artifacts.ts`                                                                             | Private bundle reservation, exclusive temp files, safe handles, file and directory sync, no-replace manifest publication   |
| Planning              | Create `src/lib/backup-planner.ts`                                                                               | Selected-service closure, canonical mounts, named-volume probes, writer consumers, stable IDs/order, dependency layers     |
| Binary Docker work    | Create `src/lib/docker-backup.ts`                                                                                | Helper inspect/pull, hardened helper argv, byte streaming, inactivity timeout, retry, cleanup, exact-ID start              |
| Orchestration         | Create `src/lib/backup-coordinator.ts`                                                                           | Lifecycle lock, revalidation, stop/archive/recovery state machine, manifest-last commit                                    |
| Actions               | Create `src/actions/backup.ts` and `src/actions/backup-verify.ts`                                                | Selection/approval/output boundary and genuinely offline verification boundary                                             |
| Command               | Create `src/commands/backup.ts`                                                                                  | Parent create action, nested `verify`, lazy DI loaders, command-local validation                                           |
| Root CLI              | Modify `src/cli.ts`                                                                                              | Register command and classify root backup as mutating while excluding dry-run and nested verify from state locking         |
| Public exports        | Modify `src/lib/index.ts` only for intended public seams                                                         | Export planner/coordinator/adapters deliberately; keep action internals private                                            |
| Errors and exit codes | Modify `src/errors.ts`, `src/error-formatters.ts`, and `src/exit-codes.ts` if dedicated types/resolvers are used | Exit 2 for usage/schema/path failures, 1 for operational or recovery failure, 0 for success; never 3                       |
| Completions           | Modify `src/actions/completion.ts` and `src/actions/completion.spec.ts`                                          | Bash/Zsh/Fish root options, nested verify context, destination and manifest path completion                                |
| Tests                 | Create feature-local unit specs and `src/cli.backup.integration.spec.ts`                                         | DI non-mutation assertions, strict schema/security cases, byte retry/signals, exact recovery, lock routing, output schemas |

Prefer leaving `docker.ts`, `docker-conflict-evidence.ts`, and
`plan-storage.ts` unchanged. If a shared primitive must be exported, keep that
change small and separately tested; placing backup streaming or publication
inside those modules would couple incompatible contracts.

## Code Conventions

- Use feature-local interfaces and discriminated unions, following
  `types/update.ts` and `types/state-rebuild.ts`.
- Inject effects at the action/coordinator boundary. Tests in this package use
  typed dependency overrides rather than module-level mocking where possible.
- Lazy-load action modules from command callbacks so parsing and help do not
  initialize Docker or filesystem dependencies.
- Preserve deterministic output explicitly with stable sort keys. Existing
  service and sidecar resolution preserves configuration insertion order.
- Use `InvalidArgumentError` for user-controlled syntax, manifest, selection,
  or unsafe-path failures that must exit 2. Keep operational failures in the
  typed backup result so recovery evidence is not lost to a thrown exception.
- Call `formatOutput` exactly once for a machine result. JSON and YAML must emit
  one terminal document; reject CSV before any side effect.
- Direct diagnostic/plan/progress text to stderr. Avoid contaminating
  machine-readable stdout.
- Follow existing secure-file conventions: directory mode `0700`, file mode
  `0600`, exclusive create, `O_NOFOLLOW`, handle-based validation, and
  idempotent cleanup.
- Keep Docker argv arrays shell-free and validate both individual argv and any
  embedded Docker mini-language.
- Use `process.exitCode`; do not call `process.exit()` in actions.

## Dependencies and Services

### Internal dependencies

The planner depends on:

- canonical Compose evidence and its resolved-config fingerprint;
- resolved service selection after sidecar expansion;
- volume existence probes scoped to planned effective volume names;
- pure dependency ordering from `depends_on` plus
  `network_mode: service:<name>`;
- stable backup mount and artifact identity generation.

The coordinator depends on:

- a completed immutable plan;
- private bundle and publication operations;
- the backup-specific Docker adapter;
- lifecycle locking;
- pre-stop and post-stop container observation;
- cancellation state that defers signal re-raise.

The offline verifier depends only on:

- manifest parsing/validation;
- secure artifact opening;
- streaming byte count and SHA-256;
- output formatting.

It must not depend on config loaders, service selection, Compose wrappers,
Docker adapters, either lock, helper-image resolution, or extraction code.

### External/runtime services

- Docker Compose supplies the authoritative resolved service/mount/dependency
  model and container observations.
- Docker Engine supplies named-volume existence, helper-image identity, helper
  containers, service stopping, and exact container-ID restart.
- The helper image is the feature-spec fixed Alpine digest. Pull/inspect it
  before stopping writers, then run the resolved local image ID to prevent tag
  movement.
- Node streams, `zlib`, `crypto`, and `fs` provide client-side gzip,
  SHA-256/byte accounting, bounded stderr, exclusive files, and durability.

No database or network service should be involved in offline verification.

## Gotchas and Warnings

- `resolveServicesWithInteractive()` returns an empty array for
  non-interactive "all". Backup must reject that sentinel unless `--all` was
  explicitly supplied.
- Its interactive predicate is JSON-oriented. Backup should decide human versus
  machine behavior from the resolved `OutputFormat`; YAML must not trigger a
  prompt.
- Canonical mount types still permit short string syntax. The backup planner
  must fail closed on strings rather than parsing colon-delimited mounts.
- Named-volume identity is the explicit Compose volume `name`, otherwise
  `<project>_<volume-key>`. Probe only planned effective names and report
  missing volumes deterministically.
- Bind paths and volume names are resolved evidence, but mount IDs, artifact
  paths, consumer lists, warnings, and dependency layers still require explicit
  sorting.
- Multiple replicas may exist. Never collapse observations to one container per
  service.
- A stop timeout can mean some containers stopped. Always reobserve and enter
  recovery after every stop attempt.
- Dependency cycles must be rejected before stopping writers unless the feature
  defines a safe deterministic recovery layer. Do not discover this during
  `finally`.
- `execDocker()` is text-only and its five-minute timeout is wall-clock, not
  inactivity-based. It is not a binary-stream substrate.
- Existing detached-child signal handling can re-signal the process before
  recovery. A backup-specific deferred-signal lifecycle is mandatory.
- `rename()` is replacing on POSIX. Neither plan storage nor state rebuild
  provides the required no-replace manifest commit.
- Reserving an empty `manifest.json` makes an incomplete bundle appear
  malformed rather than manifest-less. Reserve only the bundle namespace and
  publish the manifest last.
- File sync is insufficient for durable publication; sync the containing
  directory after creation/rename/link operations as appropriate.
- A direct Docker argv is still vulnerable to malformed `--mount` subsyntax.
- `--rm` does not eliminate explicit cleanup requirements after transport or
  signal failure.
- Human approval occurs once and before mutation. Machine mode requires
  `--yes`; dry-run never prompts.
- Creation and verification schemas are different:
  `rfapps-backup-result.v1` and `rfapps-backup-verify-result.v1`.
- Backup outcomes use only exit codes 0, 1, and 2. Do not reuse the general
  partial-success exit code 3.
- Fish completion predicates need explicit exclusion of the nested `verify`
  context, similar to the existing state/rebuild collision handling.

## Task-Specific Guidance

### Recommended dependency order

1. Define `types/backup.ts`, schema constants, stable identifiers, result
   contracts, and any dedicated errors/exit resolver.
2. Implement and exhaustively test strict manifest validation.
3. In parallel after the types are stable, implement secure artifact handling
   and the backup-specific Docker binary/exact-restart adapter.
4. Implement the pure deterministic planner using canonical Compose evidence,
   scoped volume probes, and dependency ordering.
5. Implement the coordinator after planner, artifact, Docker, and lifecycle-lock
   contracts are available. Test stop failures, stream failures, publication
   failures, recovery failures, and signals as separate state transitions.
6. Implement the two actions and parent/nested command. Keep verify's dependency
   graph offline by construction.
7. Register root-lock routing in `cli.ts`, then add real-CLI tests proving:
   real creation is blocked by an existing state lock before Docker; dry-run is
   lock-free; verification is lock-free and needs neither config nor Docker.
8. Update Bash, Zsh, and Fish together and derive parity assertions from the
   actual backup Commander registration.

### Minimum high-value test matrix

- Strict manifests: exact keys, all caps, duplicate IDs/paths, traversal,
  symlink components, non-regular files, handle/path replacement, hash and size
  mismatch.
- Planner: explicit `--all`, no-target rejection, sidecar closure, short-mount
  rejection, bind/volume identity, missing volume, multiple consumers,
  dependency cycles, deterministic ordering.
- Stream adapter: arbitrary binary bytes, bounded stderr, inactivity timeout,
  sink failure, retry before and after emitted bytes, fresh attempt resources,
  helper cleanup, and digest-to-local-image-ID use.
- Coordinator: zero dry-run effects, one prompt boundary, config/volume/container
  revalidation, exact captured-ID recovery, replicas, partial stop, primary plus
  recovery failure, manifest-last success, and signal re-raise only after
  recovery.
- Verify action: fixture with omitted config and unavailable Docker, valid
  bundle, missing manifest, oversized manifest, unsafe artifact, mismatch,
  JSON/YAML/table output, CSV rejection, and exit codes.
- Completion parity: creation options and nested verify options in all three
  shells, plus destination and positional manifest file completion.

This partition gives distinct ownership to schema/storage, Docker execution,
planning, coordination, and CLI-surface work. It also prevents the most
security-sensitive modules from competing for edits in `docker.ts` or
`plan-storage.ts`.
