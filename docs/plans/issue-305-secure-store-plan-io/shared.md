# Issue 305 Secure-Store Plan I/O Migration

Issue #305 removes the duplicate safe-parent walks, bounded readers, and atomic writers from the
copy-plan and Lidarr plan modules while retaining their domain serialization, validation, checksum,
and error contracts. Corrective issue #321 already provides the strict-default
`"allow-foreign-read"` policy needed for ordinary `0o644` plan fixtures; it permits foreign read
bits but rejects foreign write/execute bits (`0o033`). Issue #305 reuses that policy and adds only a
descriptor-based final-parent hardening mode used by copy-plan. Copy-plan and Lidarr then become
thin adapters that select shared create or identity-guarded replace operations and translate every
shared or raw failure back to their existing public errors. Audit append remains a local `O_APPEND`
operation, and all current CLI options, completions, public docs, fixtures, and serialized bytes
remain unchanged.

PR review added one narrow read-parent compatibility seam for copy-plan: `"read-compatible"`
admits a non-private or differently owned final directory without changing it, while retaining
component symlink/type checks, bounded file-mode validation, and parent/file identity rechecks.
Review also made the shared async and sync bounded readers use one
`O_RDONLY | O_NONBLOCK | O_NOFOLLOW` flag so a FIFO or raced special file is rejected by descriptor
type validation without waiting for another process to open it. Both readers accumulate legal
short reads until EOF or the `maximumBytes + 1` detection capacity, so plan parsing never receives
a truncated artifact merely because one descriptor read returned early.
Atomic create and replace likewise fsync the exact descriptor-validated parent captured before
publication and recheck its pathname afterward. Create removes its staging hardlink before that
durability window while notifying lock ownership immediately after publication, so a failed stage
unlink cannot strand a published lock without its caller knowing the inode to clean up.

## Relevant Files

- /packages/rfmedia-cli/src/lib/secure-store/paths.ts: Shared parent walk and bounded-reader policy seam.
- /packages/rfmedia-cli/src/lib/secure-store/atomic.ts: Canonical create and identity-guarded replace writers.
- /packages/rfmedia-cli/src/lib/secure-store/atomic-publication.test.ts: Post-link failure and lock cleanup contract.
- /packages/rfmedia-cli/src/lib/secure-store/bounded-read-short.test.ts: Async and sync short-read accumulation contract.
- /packages/rfmedia-cli/src/lib/secure-store/errors.ts: Shared errors that domain adapters must translate.
- /packages/rfmedia-cli/src/lib/secure-store/index.ts: Supported barrel and migration-status documentation.
- /packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts: Critical strict-default and opt-in policy coverage.
- /packages/rfmedia-cli/src/lib/plan.ts: Copy-plan persistence adapter and excluded audit append.
- /packages/rfmedia-cli/src/lib/plan.test.ts: Unmodified copy-plan compatibility contract under two umasks.
- /packages/rfmedia-cli/src/lib/**snapshots**/plan.test.ts.snap: Byte-identical copy-plan artifact baseline.
- /packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts: Lidarr plan/history adapters and local duplicate stack.
- /packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts: Unmodified plan/history contract under two umasks.
- /packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts: Existing shared-store domain adapter pattern.
- /packages/rfmedia-cli/src/lib/adapters/plex/credential-store.ts: Total secure-store error translation precedent.
- /packages/rfmedia-cli/src/lib/errors.ts: Stable copy-plan and Lidarr error classes and codes.
- /packages/rfmedia-cli/src/lib/error-formatters.ts: Consumer requiring PlanArtifactError identity preservation.
- /packages/rfmedia-cli/src/lib/error-formatters.test.ts: Unmodified formatter compatibility contract and protected hash.
- /packages/rfmedia-cli/src/actions/copy-plan.test.ts: Action boundary contract for copy-plan failures.
- /docs/internal/plex-jwt-deferrals.md: Secure-store provenance and deferred-work closeout record.
- /ROADMAP.md: Live issue inventory and secure-artifact migration status.

## Relevant Patterns

**Domain adapter over filesystem mechanics**: Keep schema, canonicalization, checksum, and public
errors local while delegating filesystem safety through the barrel. See
[/packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts](/packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts).

**Strict defaults with explicit compatibility policies**: Credential, lock, and preset consumers
retain owner-only reads and validate-only parents; plan consumers opt into only the legacy behavior
they require. See
[/packages/rfmedia-cli/src/lib/secure-store/paths.ts](/packages/rfmedia-cli/src/lib/secure-store/paths.ts).

**Descriptor-based permission hardening**: Safely open and identity-check the final directory before
changing its mode, matching the existing open-handle staging discipline. See
[/packages/rfmedia-cli/src/lib/secure-store/atomic.ts](/packages/rfmedia-cli/src/lib/secure-store/atomic.ts).

**Create-versus-replace routing**: Use link-based no-clobber creation for absent artifacts and
identity-guarded rename replacement only when an existing inode was observed. See
[/packages/rfmedia-cli/src/lib/adapters/plex/credential-store.ts](/packages/rfmedia-cli/src/lib/adapters/plex/credential-store.ts).

**Total domain error translation**: Preserve already-domain-typed failures, map shared codes
explicitly, and convert unmatched raw errnos to the existing domain I/O code with `cause`. See
[/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts](/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts).

**Missing reads are operation-specific**: Convert shared `undefined` to artifact I/O failure, empty
history, or the history create branch according to the calling operation. See
[/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts](/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts).

**Append exclusion**: `appendPlanAudit()` may reuse safe parent preparation but keeps one local
no-follow append write and its exactly-once advisory warning behavior. See
[/packages/rfmedia-cli/src/lib/plan.ts](/packages/rfmedia-cli/src/lib/plan.ts).

## Relevant Docs

**/docs/plans/issue-288-secure-store-migration/design.md**: You _must_ read this when preserving the
original secure-store invariants and migration boundary.

**/docs/plans/issue-304-claim-lock-secure-store/design.md**: You _must_ read this when extending the
existing Lidarr secure-store adapter and translator precedent.

**/docs/features/plan-apply-workflow.md**: You _must_ read this when checking copy-plan user-visible
behavior and serialized artifact expectations.

**/docs/prps/specs/lidarr-mutation-plan-apply.spec.md**: You _must_ read this when checking Lidarr
plan/history lifecycle and durability ordering.

**/docs/lefthook-usage.md**: You _must_ read this when running the real hook path and normalized
umask verification.
