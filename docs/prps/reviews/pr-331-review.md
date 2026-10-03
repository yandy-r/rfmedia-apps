# PR Review #331 — Migrate Plan I/O onto Secure Store

**Reviewed**: 2026-08-08T05:12:15Z
**Mode**: PR
**Author**: yandy-r
**Branch**: chore/305-secure-store-plan-io → master
**Decision**: APPROVE

## Summary

The shared final-parent policy and both plan adapters preserve the established serialization,
error, audit, history, and claim contracts while removing the duplicate filesystem machinery.
Six findings were corrected before merge: hardening a filesystem-root parent, a temporary
read-time permission-repair workaround, final-parent compatibility for externally supplied copy
plans, blocking special-file opens in the bounded reader, identity-bound directory durability, and
single-call reads that could truncate input after a legal short read. The stable reviewed head has
no remaining findings.

## Findings

### CRITICAL

- **[F001]** `packages/rfmedia-cli/src/lib/secure-store/paths.ts` — The first harden-private
  implementation could treat the filesystem root as the final parent and chmod it to `0o700` when
  asked to publish `/artifact.json`.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Reject filesystem-root final parents before opening or chmoding them and pin
    the root mode as unchanged in the focused shared test.

### HIGH

- **[F002]** `packages/rfmedia-cli/src/lib/plan.ts` — A temporary umask-compatibility workaround
  hardened a plan file and its parent during reads, violating the non-mutating
  `allow-foreign-read` contract.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Keep production reads validate-only and non-mutating. Make only the test
    fixture creation modes explicit (`0o644` file, `0o700` parent) so ambient umask `002` cannot
    manufacture an unsafe `0o664`/`0o775` fixture.

- **[F004]** `packages/rfmedia-cli/src/lib/secure-store/paths.ts` — The asynchronous and synchronous
  bounded readers opened a supplied pathname with blocking `O_RDONLY` before their descriptor
  regular-file check, so a FIFO could wait indefinitely for a writer.
  - **Status**: Fixed
  - **Category**: Security
  - **Suggested fix**: Use one `O_RDONLY | O_NONBLOCK | O_NOFOLLOW` flag for both readers, retain the
    descriptor type and identity checks, and prove async and sync FIFO rejection with a real FIFO
    plus a hard-timeout subprocess.

- **[F005]** `packages/rfmedia-cli/src/lib/secure-store/atomic.ts` — Atomic create and replace
  rechecked the captured parent but then reopened its pathname for directory fsync, so a replacement
  in that gap could be synced and reported successful while the directory containing the published
  history remained non-durable.
  - **Status**: Fixed
  - **Category**: Durability
  - **Suggested fix**: Open and identity-check the captured parent descriptor, verify its pathname
    before and after fsync, translate disappearance to `SECURE_STORE_UNSAFE_PATH`, remove the create
    stage before that window, and keep the publication observer ahead of staging unlink so lock
    cleanup can remove a published inode after any later failure.

- **[F006]** `packages/rfmedia-cli/src/lib/secure-store/paths.ts` — Both bounded readers issued one
  descriptor read and could decode a truncated artifact when the filesystem legally returned fewer
  bytes than requested.
  - **Status**: Fixed
  - **Category**: Correctness
  - **Suggested fix**: Accumulate reads by explicit offset until EOF or the
    `maximumBytes + 1` detection capacity, and prove the async and sync paths with deterministic
    three-byte reads.

### MEDIUM

- **[F003]** `packages/rfmedia-cli/src/lib/plan.ts` — Copy-plan reads initially selected the shared
  strict final-parent policy, rejecting previously readable plans in a non-private or differently
  owned directory such as `/tmp`.
  - **Status**: Fixed
  - **Category**: Compatibility
  - **Suggested fix**: Add an explicit non-mutating read-parent policy that relaxes only final
    ownership/mode validation while retaining component symlink/type checks, file-mode enforcement,
    and parent/file identity rechecks.

### LOW

None.

## Validation Results

| Check      | Result                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------ |
| Type check | Pass — rfmedia typecheck plus generated-client and architecture prechecks                        |
| Lint       | Pass — Prettier, Markdown, normalized whitespace, and graph refresh                              |
| Tests      | Pass — focused multi-umask suites, protected boundaries, and full monorepo pre-push hook         |
| Build      | Pass — rfmedia build                                                                             |
| Review     | Pass — mandatory stable-snapshot review found no remaining critical, high, medium, or low issues |

## Files Reviewed

- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`
- `packages/rfmedia-cli/src/lib/secure-store/atomic-publication.test.ts`
- `packages/rfmedia-cli/src/lib/secure-store/bounded-read-short.test.ts`
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`
- `packages/rfmedia-cli/src/lib/plan.ts`
- `packages/rfmedia-cli/src/lib/plan.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- `docs/plans/issue-305-secure-store-plan-io/`
- `docs/internal/plex-jwt-deferrals.md`
- `ROADMAP.md`
