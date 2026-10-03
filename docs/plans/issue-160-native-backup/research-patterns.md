# Pattern Research: issue-160-native-backup

## Architectural Patterns

- Use a dedicated `packages/rfapps-cli/src/commands/backup.ts` registrar. The option surface and
  `verify` subcommand make this closer to `packages/rfapps-cli/src/commands/state.ts` and
  `packages/rfapps-cli/src/commands/update.ts` than to a small inline command in
  `packages/rfapps-cli/src/cli.ts`. Register it from `cli.ts` and dynamically load action modules.
- Keep the layers explicit: Commander registration and argument validation in `commands/backup.ts`;
  configuration, interaction, output, and exit mapping in `actions/backup.ts`; deterministic
  discovery/planning/verification and injected I/O boundaries in `lib/backup.ts`; versioned,
  secret-safe contracts in `types/backup.ts`. This matches the data-only coordinator boundary in
  `packages/rfapps-cli/src/lib/managed-update.ts` and the dependency-injected action boundary in
  `packages/rfapps-cli/src/actions/update.ts`.
- Resolve `-s`, `--services`, `-g`, profiles, interactive selection, and `--no-sidecars` through
  `packages/rfapps-cli/src/lib/interactive-selection.ts`. Its empty service list means implicit
  all-services, so the action must expand that with `getComposeServices()` before producing a
  manifest; never persist an ambiguous empty scope. Group expansion, first-seen deduplication,
  sidecar expansion, and profile detection already live in `packages/rfapps-cli/src/lib/services.ts`.
- Inspect the effective, interpolated Compose model rather than parsing YAML directly.
  `getCanonicalComposeConfigEvidence()` in `packages/rfapps-cli/src/lib/docker.ts` exposes the
  strict bind/volume/tmpfs mount projection and top-level named-volume identities from
  `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts`. Preserve its pinned compose path,
  project name, profiles, environment source, bounded output, allowlisted projection, and
  fail-closed parsing behavior.
- Model backup as plan then execution. The plan should contain a fully expanded, deterministically
  ordered scope; deduplicated storage sources shared by services; explicit skipped/unsupported
  mounts; destination; consistency level; and restore hints. The terminal result should account for
  every planned source. This follows the complete per-service accounting and reviewed-scope
  patterns in `packages/rfapps-cli/src/types/update.ts`.
- Do not treat `execDocker()` as a binary archive transport. Its implementation in
  `packages/rfapps-cli/src/lib/docker.ts` captures bounded UTF-8 stdout/stderr (4 MiB/1 MiB by
  default), or inherits terminal streams; it has no file-stream sink. Add a narrowly injected,
  timeout- and signal-aware archive execution boundary that uses argv without a host shell.
  Explicitly define remote-context behavior: a client-local backup path cannot be bind-mounted into
  a remote daemon. Either stream Docker output directly to an exclusive local file or reject that
  mode before starting; never silently write on the daemon host.
- Publish a complete backup atomically. Build under an unpredictable private sibling staging
  directory, write and sync archives, write the manifest last, then rename the staging directory
  into place. Adapt the sibling-temp/atomic-rename pattern from
  `packages/rfapps-cli/src/lib/state-rebuild-files.ts` and the symlink-safe exclusive artifact
  writer in `packages/rfapps-cli/src/lib/plan-storage.ts`.

## Code Conventions

- TypeScript is strict ESM: use `node:` imports and `.js` extensions for repository imports. Export
  the new public contracts from `packages/rfapps-cli/src/types/index.ts` and reusable primitives
  from `packages/rfapps-cli/src/lib/index.ts`.
- Normalize raw Commander strings once in the action. Reject blank service lists, paths, invalid
  numeric values, and incompatible options with `InvalidArgumentError`, as
  `packages/rfapps-cli/src/commands/state.ts` and `packages/rfapps-cli/src/actions/update.ts` do.
- Give persisted documents literal schema discriminators, for example `backup-manifest.v1` and
  `backup-result.v1`, plus stable string unions for source type, status, consistency, error code,
  and restore-hint kind. Validate loaded manifests as untrusted data with exact keys, bounded
  strings/arrays/counts, safe relative artifact paths, and no unknown fields; use the runtime
  validation style in `packages/rfapps-cli/src/lib/plan-storage.ts`.
- Make manifests deterministic and portable: sort services and entries by code-point order; use
  relative archive paths; record SHA-256, byte count, source kind, Docker volume identity or bind
  source, container target, read-only flag, selected services, Compose project identity, and an ISO
  timestamp. Restore hints should be structured data, not executable shell snippets.
- Hash archives as binary streams or while writing them. Do not reuse `hashFile()` from
  `packages/rfapps-cli/src/lib/plan-storage.ts` for large archives: it reads the whole file as UTF-8
  and returns an empty string on failure. Backup integrity must fail closed on read/hash errors.
- Treat artifacts as sensitive. Follow the `0700` directory and `0600` file modes, exclusive
  creation, no-overwrite default, `O_NOFOLLOW`, component symlink checks, current-user ownership
  check, fsync, and temp cleanup in `packages/rfapps-cli/src/lib/plan-storage.ts`.
- Preserve exact Docker argv and authority. Named-volume and bind-mount archival must not interpolate
  source names into `sh -c`; validate operands and pass them as arguments, following the safe
  Compose operand and canonical-path checks in `packages/rfapps-cli/src/lib/docker.ts`.
- The repository contains bind mounts for data, configuration, sockets, host devices, and system
  files, plus a named `model-cache` volume in `compose.yml`. The planner must classify these
  explicitly. `tmpfs` is not persistent; Docker sockets/devices are not backup data; read-only
  mounts may still contain essential configuration and must not be discarded merely because the
  container cannot write them. Unsupported/skipped entries belong in the result and manifest.
- Keep human rendering separate from the coordinator. Human summaries go to stderr through logger
  helpers or a dedicated report renderer; machine formats emit one versioned document through
  `formatOutput()` from `packages/rfapps-cli/src/lib/formatters/index.ts`. Do not leak raw Compose,
  environment values, helper-container stderr, or manifest parser payloads.

## Error Handling

- Preserve the repository-wide exit categories from
  `packages/rfapps-cli/src/lib/exit-codes.ts`: `0` complete success (including a non-writing dry
  run), `1` operational failure, `2` invalid/unsafe usage or cancellation, and `3` partial success
  when some independently scoped sources were backed up or verified and others failed.
- Derive `success` and `exitCode` from the terminal typed result in one function. Include bounded,
  sanitized error codes and messages per source; do not infer success only from the last Docker
  process. Verification mismatch, missing archive, changed size, malformed manifest, and unsupported
  schema need distinct stable codes.
- Throw typed validation/path/lookup errors so the `handleCliError()` pipeline in
  `packages/rfapps-cli/src/cli.ts` can format them. Add a backup-specific error class and formatter
  in `packages/rfapps-cli/src/lib/errors.ts` and
  `packages/rfapps-cli/src/lib/error-formatters.ts` only when structured context is needed.
  Per-source Docker/filesystem failures should be accumulated in the result so other independent
  sources can finish, consistent with the action error strategy documented in
  `packages/rfapps-cli/CLAUDE.md`.
- Fail before archival when effective Compose scope or storage evidence is unavailable or
  malformed. During execution, never publish a manifest claiming completeness after an unaccounted
  source failure. A partial backup may be retained only with an explicit partial terminal status
  and entry-level evidence.
- `--dry-run` must veto every mutation: no directory creation, helper container, archive, manifest,
  or confirmation. For a real backup, show the resolved plan and request exactly one confirmation
  unless `--yes`. Machine-format mutation must require `--yes` and never prompt, matching
  `packages/rfapps-cli/src/actions/update.ts` and `packages/rfapps-cli/src/actions/state-rebuild.ts`.
- Backup creation writes artifacts but should not acquire the rfapps state-database lock merely for
  that reason; the lock in `packages/rfapps-cli/src/cli.ts` protects state/Docker lifecycle
  mutations. Reserve the output path atomically before Docker work and use a backup-specific
  staging reservation to prevent concurrent writers. Document v1 filesystem archives as live,
  filesystem-level consistency rather than database-consistent snapshots.

## Testing Approach

- Unit-test `lib/backup.ts` as pure planning and verification logic with injected clock, hasher,
  filesystem, Compose evidence, and archive executor. Use small table-driven cases for mount kinds
  and verify outcomes rather than duplicating end-to-end scenarios.
- Critical planning contracts: service/group/implicit-all expansion; overlap deduplication for a
  shared source; stable ordering and manifest bytes; correct named-volume versus bind restore hints;
  explicit tmpfs/socket/device handling; and fail-closed malformed or unavailable Compose evidence.
- Critical artifact contracts, using real temporary directories: binary SHA-256 and byte counts;
  checksum match/mismatch; missing/extra archive policy; malformed/oversized/wrong-version manifest;
  traversal and symlink rejection; `0700`/`0600` modes; existing-destination no-clobber; atomic
  publication; and cleanup after write, Docker, timeout, or interruption failure. Mirror the
  high-value cases in `packages/rfapps-cli/src/lib/plan-storage.spec.ts` and
  `packages/rfapps-cli/src/lib/state-rebuild.spec.ts`.
- Critical action contracts: dry-run performs zero writes/Docker calls; confirmation occurs once
  and before execution; `--yes` skips it; machine output never prompts and emits exactly one
  document; every planned source receives an outcome; partial/operational/usage exit mapping is
  correct; raw secrets and helper stderr do not appear in persisted or machine output. Follow the
  dependency factories in `packages/rfapps-cli/src/actions/update.spec.ts`.
- Add one focused Docker adapter suite for exact shell-free argv, pinned project/profile/env
  authority, large archive streaming, timeout, signal forwarding, remote-context handling, and
  cleanup. Do not repeat generic retry/overflow tests already covered by
  `packages/rfapps-cli/src/lib/docker.spec.ts`.
- Add a spawned-CLI integration test only for behavior that unit tests cannot prove: registration,
  global option propagation, process exit category, and any lock classification. Reuse
  `packages/rfapps-cli/src/testing/cli-harness.ts` and
  `packages/rfapps-cli/src/testing/mock-docker.ts`; the rationale in
  `packages/rfapps-cli/src/cli.state-rebuild.integration.spec.ts` is the model.
- Audit all three generated completion templates in
  `packages/rfapps-cli/src/actions/completion.ts`. Bash is sourced from
  `~/.bash_completion.d/rfapps`; Zsh is installed in `~/.zfunc/_rfapps` and activated with
  `compinit`; Fish auto-loads `~/.config/fish/completions/rfapps.fish`. Add `backup` and nested
  `verify` contexts, file completion for manifest/destination options, and Fish guards so nested
  names do not leak into unrelated commands.
- Extend `packages/rfapps-cli/src/actions/completion.spec.ts` with one Commander-derived helper that
  compares the exact long-option set for backup creation and verification across Bash, Zsh, and
  Fish. Keep the existing single three-shell loop pattern; do not add separate copies of the same
  assertion per shell. Also retain one top-level command-surface assertion and one nested-context
  disjointness assertion.

## Patterns to Follow

- Recommended flow: canonicalize project/config authority → resolve and fully expand scope → inspect
  strict Compose storage evidence → build deterministic preview → dry-run return or single approval
  → reserve private sibling staging destination → archive each deduplicated source with per-source
  accounting → stream SHA-256 and size → write manifest last → atomically publish → emit one typed
  result.
- Reuse `packages/rfapps-cli/src/lib/interactive-selection.ts`,
  `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts`,
  `packages/rfapps-cli/src/lib/plan-storage.ts`,
  `packages/rfapps-cli/src/lib/state-rebuild-files.ts`, and
  `packages/rfapps-cli/src/lib/exit-codes.ts` as behavioral references, but introduce backup-specific
  primitives where archive streaming, binary hashing, directory publication, or manifest
  validation differs.
- Keep v1 honest: file and Docker-volume archives provide live filesystem consistency only.
  Database quiescing/dumps, scheduled execution, off-site transport, encryption, full restore
  orchestration, and network reconstruction are not implicit in a checksum-valid tar archive.
  `docs/guides/backup-restore.md` and
  `research/rfapps-new-features/persona-findings/negative-space.md` explain why these concerns must
  remain visible.
- Issue #160 should use child issues. Its current scope combines two independently reviewable
  contracts: (1) scoped backup creation plus private atomic artifact/manifest production, and (2)
  untrusted-manifest loading plus `backup verify` integrity reporting. Track database-aware hooks,
  scheduling/retention, encryption/off-site transport, and restore execution as explicit follow-up
  issues; they should not expand the v1 filesystem/volume implementation. The parent issue should
  close only when both in-scope child contracts, completions, docs, and the focused integration
  boundary are complete.
