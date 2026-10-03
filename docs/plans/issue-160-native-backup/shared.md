# Native rfapps Backup and Disaster Recovery

Issue #160 adds a cold, service-scoped filesystem backup to the Commander → action → deterministic
library → typed-contract architecture already used by safety-sensitive rfapps workflows. Creation
resolves the effective Compose storage graph, stops every detected writable equal/overlapping
consumer in that project, streams bind directories and named volumes through a sandboxed
binary-safe Docker helper boundary, and restores exact captured container IDs. A private reserved
bundle becomes valid only when recovery succeeds and its final versioned manifest is published;
`rfapps backup verify` is a separate read-only path that needs no Docker or config, never extracts
data, and fails closed on unsafe paths or byte-integrity mismatches. Database-native dumps, online
consistency, automated restore, scheduling, retention, remote storage, encryption, signatures, and
MCP exposure remain outside this delivery.

## Relevant Files

- `docs/plans/issue-160-native-backup/feature-spec.md`: Approved design and acceptance contract.
- `packages/rfapps-cli/src/cli.ts`: Registration, output setup, and mutating-command lock policy.
- `packages/rfapps-cli/src/commands/state.ts`: Nested create/read-only subcommand precedent.
- `packages/rfapps-cli/src/commands/update.ts`: Large service/group-scoped option validation pattern.
- `packages/rfapps-cli/src/actions/update.ts`: Interaction, machine output, lock, and dependency pattern.
- `packages/rfapps-cli/src/lib/docker.ts`: Compose execution and new binary streaming boundary.
- `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts`: Canonical mount and volume projection.
- `packages/rfapps-cli/src/lib/interactive-selection.ts`: Standard service/group selection behavior.
- `packages/rfapps-cli/src/lib/services.ts`: Group, sidecar, profile, and deduplication logic.
- `packages/rfapps-cli/src/lib/identity.ts`: Compose project and Docker-authority identities.
- `packages/rfapps-cli/src/lib/lifecycle-lock.ts`: Project/authority lifecycle exclusion.
- `packages/rfapps-cli/src/lib/plan-storage.ts`: Strict untrusted JSON and secure artifact patterns.
- `packages/rfapps-cli/src/lib/state-rebuild-files.ts`: Atomic publication and recovery ordering.
- `packages/rfapps-cli/src/lib/errors.ts`: Typed rfapps validation and operational errors.
- `packages/rfapps-cli/src/lib/error-formatters.ts`: Stable user-facing error presentation.
- `packages/rfapps-cli/src/lib/exit-codes.ts`: Shared success, operational, usage, and partial categories.
- `packages/rfapps-cli/src/actions/completion.ts`: Bash, Zsh, and Fish generated templates.
- `packages/rfapps-cli/src/actions/completion.spec.ts`: Commander-derived three-shell parity gates.
- `packages/rfapps-cli/src/types/index.ts`: Public type exports.
- `packages/rfapps-cli/src/lib/index.ts`: Public library exports.
- `packages/rfapps-cli/README.md`: Full CLI contract.
- `docs/guides/backup-restore.md`: Current manual guidance and stale no-native-backup claims.
- `docs/features/shell-completion.md`: Completion behavior and parity documentation.
- `docs/features/json-output.md`: Structured output and stdout/stderr rules.
- `docs/features/error-handling.md`: Failure envelopes and exit semantics.
- `ROADMAP.md`: Live issue inventory and delivery status.

## Relevant Patterns

**Command/action/coordinator separation**: Commander validates syntax, actions own interaction and
presentation, and dependency-injected libraries return typed data. See
`packages/rfapps-cli/src/commands/update.ts` and `packages/rfapps-cli/src/actions/update.ts`.

**Canonical Compose evidence**: Inspect the interpolated normalized Compose model and preserve
project/authority identity rather than parsing YAML or mount strings. See
`packages/rfapps-cli/src/lib/docker-conflict-evidence.ts`.

**Review then mutate**: Fully expand scope and storage consumers, print one deterministic plan,
honor dry-run, obtain one approval, revalidate, then acquire lifecycle exclusion before stopping
services. See `packages/rfapps-cli/src/actions/update.ts`.

**Recovery in finally**: Capture running container IDs before quiescing, re-observe after any stop
attempt, and start exactly the captured IDs that are no longer running after success, partial stop,
archive failure, or interruption. See `packages/rfapps-cli/src/lib/managed-update.ts` for typed
primary/recovery outcome handling.

**Private manifest-last artifacts**: Exclusively reserve the final owner-only bundle directory, use
exclusive no-follow files and fsync, and publish the final manifest with no-replace semantics only
after archives and exact-container recovery succeed. An incomplete directory has no manifest and
cannot verify. See `packages/rfapps-cli/src/lib/plan-storage.ts` and
`packages/rfapps-cli/src/lib/state-rebuild-files.ts`.

**Two cooperative lock namespaces**: Non-dry-run creation uses the root state lock plus the
project/Docker-authority lifecycle lock; dry-run and offline verification use neither. Locks exclude
cooperating local rfapps operations, not external Docker clients or host writers.

**Fresh binary stream attempts**: Each helper retry owns a new sandboxed container, compressor,
hash/counter, and temporary file; any source/sink/SSH/inactivity failure cleans that attempt and
restarts from byte zero. The existing bounded UTF-8 Docker capture path is not reusable.

**Strict versioned input**: Treat a persisted manifest as untrusted; enforce exact keys, bounds,
safe relative paths, schema/version discriminators, and deterministic error codes before reading
artifacts. See `packages/rfapps-cli/src/lib/plan-storage.ts`.

**Complete accounting**: Every eligible or intentionally skipped selected mount appears in the
typed result; shared sources archive once but retain all service consumers. Creation is all-or-
nothing and never publishes a manifest for a partial attempt.

**Machine-output discipline**: Human plans/progress use stderr; structured formats emit one terminal
document, never prompt without explicit authorization, and derive exit status from typed results.
See `packages/rfapps-cli/src/lib/formatters/index.ts` and
`packages/rfapps-cli/src/actions/update.ts`.

**Three-shell parity**: Bash, Zsh, and Fish templates are hand-maintained together and compared with
Commander's registered command/option surface in one table-driven test. See
`packages/rfapps-cli/src/actions/completion.spec.ts`.

## Relevant Docs

**`docs/plans/issue-160-native-backup/feature-spec.md`**: You _must_ read this before any task; it
defines the frozen consistency, mount eligibility, manifest, output, testing, and child-issue
decisions.

**`packages/rfapps-cli/CLAUDE.md`**: You _must_ read this for command/action boundaries, strict ESM,
typed errors, output discipline, focused tests, and documentation requirements.

**`docs/guides/backup-restore.md`**: You _must_ read this when changing backup claims or
distinguishing cold filesystem archives from application-native database dumps.

**`docs/features/shell-completion.md`**: You _must_ read this when adding the `backup` and nested
`verify` completion surfaces.

**`docs/features/json-output.md`** and **`docs/features/error-handling.md`**: You _must_ read these
when defining result schemas, sanitized errors, stdout/stderr behavior, or exit codes.

**`research/rfapps-new-features/persona-findings/negative-space.md`** and
**`research/rfapps-new-features/persona-findings/archaeologist.md`**: You _must_ read these for the
issue's original problem framing, but the approved feature spec controls v1 scope.
