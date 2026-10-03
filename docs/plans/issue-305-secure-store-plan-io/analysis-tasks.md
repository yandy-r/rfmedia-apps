# Task Structure Analysis: issue-305-secure-store-plan-io

## Executive Summary

Issue #305 should be implemented as a delete-and-delegate migration with one shared foundation and
two parallel domain adapters. Corrective issue #321 already implements the strict-default
`"allow-foreign-read"` bounded-read policy, shipped by PR #326 as `cda0b106`; #305 reuses it and
adds only copy-plan final-parent hardening without weakening secure-store defaults. Then migrate
`plan.ts` and `lidarr/plan-engine.ts` independently, retaining their local path validation,
serialization, checksums, missing-file meanings, and public error identities.

The critical path is:

```text
T00 baseline freeze
  -> T01 final-parent policy and focused tests
  -> T02 barrel and shared provenance
  -> T03 copy-plan adapter -----\
      +-> T05 closeout docs -> G01 full verification
  -> T04 Lidarr adapter -------/
```

T03 and T04 have disjoint file ownership and may run in parallel after the shared barrel is final.
All tasks use the existing single feature worktree; do not create per-task worktrees. Existing
domain tests and the copy-plan snapshot are compatibility tripwires, not files to update.

## Recommended Phase Structure

### Phase 0 — Freeze the Existing Contract

#### T00 — Baseline and protected-file audit `[SEQUENTIAL GATE]`

**Depends on:** None.

**Protected files (5):**

- `packages/rfmedia-cli/src/lib/plan.test.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`
- `packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap`
- `packages/rfmedia-cli/src/actions/copy-plan.test.ts`
- `packages/rfmedia-cli/src/lib/error-formatters.test.ts`

**READ THESE BEFORE TASK:**

- `docs/plans/issue-305-secure-store-plan-io/shared.md`
- `docs/plans/issue-288-secure-store-migration/design.md`
- `docs/plans/issue-304-claim-lock-secure-store/design.md`

**Actions:** Refresh the feature branch onto PR #326's merged `cda0b106`, then record the starting
diff and fresh SHA-256 values for all five full
repo-relative paths below. Run the two existing domain suites under their required umasks before
implementation. Confirm issue #304's shared claim-lock prerequisite and #321's corrected reader
policy are present and that issues #305 and #306 are still open before writing closeout prose. Do
not modify protected tests to accommodate later behavior drift.

**Critical verification:**

```bash
mise exec -- bash -lc 'cd packages/rfmedia-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/plan.test.ts'
mise exec -- bash -lc 'cd packages/rfmedia-cli && umask 002 && env -u FORCE_COLOR npx vitest run src/lib/plan.test.ts'
mise exec -- bash -lc 'cd packages/rfmedia-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts'
mise exec -- bash -lc 'cd packages/rfmedia-cli && umask 002 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts'
sha256sum packages/rfmedia-cli/src/lib/plan.test.ts \
  packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts \
  packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap \
  packages/rfmedia-cli/src/actions/copy-plan.test.ts \
  packages/rfmedia-cli/src/lib/error-formatters.test.ts
```

### Phase 1 — Shared Secure-Store Foundation

#### T01 — Reuse the reader policy and add final-parent policy `[SEQUENTIAL FOUNDATION]`

**Depends on:** T00.

**Files to modify (2):**

- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`

**READ THESE BEFORE TASK:**

- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`
- `packages/rfmedia-cli/src/lib/adapters/plex/credential-store.ts`
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`

**Actions:** Reuse the existing `"allow-foreign-read"` policy without renaming or duplicating it.
Its strict-default contract is already established by #321: `"owner-only"` rejects any foreign
access, while `"allow-foreign-read"` accepts ordinary foreign read bits (`0o044`) but rejects any
foreign write or execute bits (`mode & 0o033`). Both retain `O_NOFOLLOW`, the
`maximumBytes + 1` ceiling, before/after file identity, parent revalidation, and
missing-as-`undefined`. Add only the opt-in final-parent hardening policy to
`prepareSafeParent()`: safely open the final directory descriptor, prove type, ownership, and
identity, apply `0o700` through the handle, and revalidate it. Keep validate-only/no-repair as the
default and never pathname-`chmod` an unverified existing directory.

Extend only the shared test suite for genuinely new #305 behavior. Preserve #321's focused reader
tests rather than cloning them. Prove validate-only preserves a safe caller-owned mode,
harden-leaf turns an existing `0o775` directory into `0o700`, both atomic writers propagate that
policy, and restrictive umask `0277` still yields `0o600`. Add an identity-displacement case only
if the new directory-handle seam introduces one; do not duplicate domain serialization tests.

**Critical verification:**

```bash
mise exec -- bash -lc 'cd packages/rfmedia-cli && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts'
mise exec -- npm run typecheck -w packages/rfmedia-cli
```

#### T02 — Publish the policy seam and retire stale shared prose `[SEQUENTIAL INTEGRATION]`

**Depends on:** T01.

**Files to modify (2):**

- `packages/rfmedia-cli/src/lib/secure-store/index.ts`
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`

**READ THESE BEFORE TASK:**

- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`
- `docs/plans/issue-288-secure-store-migration/design.md`

**Actions:** Export the settled policy types or helper only through the supported barrel. Update
module documentation so strict defaults remain explicit, profile-preset persistence is described as
a current shared consumer rather than an untouched reference, and #305 is no longer documented as
permanently local. Preserve the existing atomic writer implementation and its mandatory staging
handle `chmod(0o600)`; this is the mechanism that subsumes issue #306's publication hardening.

**Critical verification:** Run package typecheck and the architecture check. Search production
imports to confirm no consumer deep-imports `secure-store/paths.ts` or `secure-store/atomic.ts`.

### Phase 2 — Parallel Domain Adapter Migration

#### T03 — Migrate copy-plan persistence `[PARALLEL AFTER T02]`

**Depends on:** T02. May run in parallel with T04.

**Files to modify (1):**

- `packages/rfmedia-cli/src/lib/plan.ts`

**READ THESE BEFORE TASK:**

- `packages/rfmedia-cli/src/lib/errors.ts`
- `packages/rfmedia-cli/src/lib/error-formatters.ts`
- `packages/rfmedia-cli/src/actions/copy-plan.test.ts`

**Actions:** Keep `validateArtifactPath()` ahead of all shared calls so literal `..`, NUL, empty,
overlong, and root paths retain current behavior. Replace the local component walk, bounded reader,
staging writer, and pathname post-rename `chmod` with thin barrel-based adapters. Make existing-file
inspection return the target identity: absent targets use shared create, existing targets with
`overwrite: true` use identity-guarded replace, and existing targets without overwrite remain
`PLAN_EXISTS`. Preserve canonical pretty JSON, the trailing newline, byte cap, and returned resolved
path.

Add a total copy-domain failure translator that preserves existing `PlanArtifactError` and
`PlanValidationError` instances, maps shared unsafe/permission, too-large, and version-conflict
outcomes to their existing codes, and converts every unmatched shared or raw errno to `PLAN_IO`
with `cause`. Convert a shared missing read (`undefined`) to `PLAN_IO` before parsing. Keep
`appendPlanAudit()` as one local `O_APPEND` write with its current non-blocking one-warning contract;
only its parent preparation may use the harden-leaf policy. Keep `findPlanApplications()` and
`prunePlans()` local and advisory. Remove only imports and helpers made obsolete by this delegation.

**Critical verification:** Run `plan.test.ts` with unchanged payloads/assertions under umasks `022`,
`002`, and `077`; use the focused shared writer test's in-process `0277` seam because Vitest cannot
bootstrap its own cache directory under ambient `0277`. Run unmodified `actions/copy-plan.test.ts`
and `lib/error-formatters.test.ts`. Confirm the snapshot
hash is unchanged, no temporary sibling remains, overwrite replaces the inode, the directory is
`0o700`, the artifact is `0o600`, traversal is rejected, and the audit `EACCES` mock emits exactly
one warning containing both `audit ledger` and `EACCES`.

#### T04 — Migrate Lidarr artifact and history persistence `[PARALLEL AFTER T02]`

**Depends on:** T02. May run in parallel with T03.

**Files to modify (1):**

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`

**READ THESE BEFORE TASK:**

- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`
- `packages/rfmedia-cli/src/lib/errors.ts`
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`

**Actions:** Keep `resolveLidarrStoragePath()` as the non-disclosing front-door validation. Replace
the local safe-parent interfaces/walk, identity helpers, bounded reader, directory sync, existence
guard, and both staging writers with barrel imports. Lidarr artifacts always use shared create and
map version conflict to `LIDARR_PLAN_EXISTS`. Plan/history reads opt into
`"allow-foreign-read"` so ordinary `0o644` `writeFile()` fixtures continue to reach size, JSON,
schema, and checksum classification, while files with foreign write/execute bits remain rejected.

For history, treat shared `undefined` as the create branch in `appendLidarrPlanHistory()` and as
`[]` in `readLidarrPlanHistory()`. Preserve the captured `FileIdentity` from an existing read for
identity-guarded replace, as well as all current JSONL validation, record reduction/order, one
trailing newline, size cap, and blocking directory-sync-before-dispatch contract. Generalize the
existing claim I/O translator into a domain-wide base without changing claim busy/corrupt special
cases. Preserve already-domain-typed errors first; map shared unsafe/permission, too-large, and
version-conflict outcomes explicitly; map every unmatched raw error to `LIDARR_PLAN_IO` with
`cause`. Remove obsolete Node imports only after verifying they have no non-persistence uses.

**Critical verification:** Run `plan-engine.test.ts` with unchanged payloads/assertions and explicit
safe fixture modes under umasks `022` and `002`.
Verify create-only conflict, symlink rejection, `0o600` output, unchanged safe `0o750` parent,
oversize precedence for `0o644`, checksum/schema errors for plain fixtures, missing history `[]`,
pinned legacy artifact/history bytes, history replacement, and directory sync completing before
remote dispatch.

### Phase 3 — Documentation and State Closeout

#### T05 — Reconcile the deferral record and live roadmap `[SEQUENTIAL CLOSEOUT]`

**Depends on:** T03 and T04 focused verification. Actual PR metadata must be known before finalizing
this task.

**Files to modify (2):**

- `docs/internal/plex-jwt-deferrals.md`
- `ROADMAP.md`

**READ THESE BEFORE TASK:**

- GitHub issues #305 and #306
- `.github/pull_request_template.md`
- `docs/roadmap-archive.md`

**Actions:** Record exactly which copy/Lidarr mechanics now delegate and why audit append remains
local. Mark #305 complete only with real PR evidence. Because shared staging-handle hardening removes
the vulnerable pathname `chmod`, explicitly record whether #306 is closed as subsumed or rescaled;
do not leave its roadmap row silently stale. Recalculate live counts and sprint text, preserve #307
and #308, and do not move #305 to `docs/roadmap-archive.md` until the whole sprint meets its archive
rule. Public command docs, package README, completion templates, and the copy snapshot should remain
unchanged because no user-facing CLI contract changes.

**Critical verification:** Format and lint both Markdown files, compare roadmap counts against live
issue state, and inspect the diff for placeholder PR numbers or claims unsupported by the focused
test results.

### Phase 4 — Integrated Verification

#### G01 — Full repository and completion audit `[SEQUENTIAL GATE]`

**Depends on:** T01–T05.

This gate owns no files. If it finds a defect, return it to the task that owns the implicated file;
do not turn G01 into a broad cleanup task.

Run, in order:

```bash
mise exec -- npm run typecheck -w packages/rfmedia-cli
mise exec -- npm run check:architecture -w packages/rfmedia-cli
mise exec -- npm run build -w packages/rfmedia-cli
mise exec -- npm run test:run
mise exec -- npm run lint:md
mise exec -- npm run format:check
git diff --check
graphify update .
```

Run `graphify update .` from the repository root of the #305 feature worktree after all source
changes have rendezvoused; do not run it from `packages/rfmedia-cli` or an unrelated checkout.

Also rerun the T03/T04 umask matrix after any fix, prove the five protected files remain
unmodified, and search both migrated modules for leftover local safe-parent or atomic-writer
helpers. Audit Bash, Zsh, and Fish completion templates and record `no change required`; do not edit
them because issue #305 changes no commands or options.

## Task Granularity Recommendations

- Keep T01's shared API and focused tests together. Splitting the option design from its tests
  invites accidental weakening of credential and synchronous-reader defaults.
- Keep the barrel/provenance task separate from T01 so T03/T04 consume a settled supported API and
  no adapter deep-imports implementation modules.
- Give `plan.ts` and `plan-engine.ts` exactly one owner each. Both are aggregation points with
  domain-specific error semantics; do not split either module into reader and writer tasks.
- Treat existing plan, Lidarr, action, formatter, and snapshot tests as read-only gates. New tests
  belong only in `secure-store.test.ts` for the newly introduced shared policy surface.
- Keep audit append outside atomic publication. Adding a shared append primitive, changing audit
  warning behavior, or migrating advisory audit lookup would exceed issue #305.
- Keep documentation/state closeout behind focused verification and real PR metadata. Never use
  placeholder issue or PR facts in `ROADMAP.md` or the deferral record.

## Dependency Analysis

```text
T00
  -> T01
    -> T02
      -> T03 --\
      +-> T05 -> G01
      -> T04 --/
```

- **Maximum dependency depth:** six stages including the final gate.
- **Only implementation parallelism:** T03 and T04, after T02 publishes the shared seam.
- **Within-task sequencing:** each umask matrix is sequential; changing a process umask inside one
  concurrent shell would make evidence unreliable.
- **Conflict control:** T03 and T04 edit disjoint files in the same feature worktree. T05 waits for
  both and edits only documentation/state files.
- **Failure routing:** a shared-policy regression returns to T01; barrel/provenance problems return
  to T02; copy behavior to T03; Lidarr behavior to T04; roadmap/ADR truth to T05.

## File-to-Task Mapping

| File                                                             | Task    | Role                                                  |
| ---------------------------------------------------------------- | ------- | ----------------------------------------------------- |
| `packages/rfmedia-cli/src/lib/secure-store/paths.ts`             | T01     | Existing reader policy plus final-parent policy       |
| `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts` | T01     | New shared-policy regression coverage                 |
| `packages/rfmedia-cli/src/lib/secure-store/index.ts`             | T02     | Supported exports and migration boundary docs         |
| `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`            | T02     | Provenance/JSDoc only; existing writer stays intact   |
| `packages/rfmedia-cli/src/lib/plan.ts`                           | T03     | Copy-plan adapter and audit exclusion                 |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`             | T04     | Lidarr artifact/history adapters and translator reuse |
| `docs/internal/plex-jwt-deferrals.md`                            | T05     | #305/#306 decision history                            |
| `ROADMAP.md`                                                     | T05     | Live sprint and issue state                           |
| `packages/rfmedia-cli/src/lib/plan.test.ts`                      | T00/G01 | Protected compatibility tripwire; no edits            |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`        | T00/G01 | Protected compatibility tripwire; no edits            |
| `packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap`   | T00/G01 | Protected byte baseline; no edits                     |
| `packages/rfmedia-cli/src/actions/copy-plan.test.ts`             | T00/G01 | Protected action boundary; no edits                   |
| `packages/rfmedia-cli/src/lib/error-formatters.test.ts`          | T00/G01 | Protected formatter boundary; no edits                |

No task should modify `packages/rfmedia-cli/README.md`, Lidarr feature docs, command modules,
generated clients, schemas, configuration, completion templates, or public error types unless a
verified contract failure proves the research wrong and the plan is revised first.

## Optimization Opportunities

- Run T03 and T04 concurrently only after T02 lands; their source ownership is disjoint and both can
  consume the same shared API from the existing feature worktree.
- Run focused tests immediately within their owning task, using package-local Vitest invocations.
  This catches policy or translation drift before the much larger root `test:run` gate.
- Use source deletion as a completion metric: remove the duplicate helpers and imports instead of
  wrapping or leaving fallback implementations behind.
- Reuse `createPrivateFileAtomically()` and `replacePrivateFileAtomically()` unchanged. Their staged
  handle chmod, cleanup, identity checks, and directory fsync already cover issue #306 and Lidarr's
  durability boundary.
- Avoid new domain tests unless an existing tripwire reveals a truly uncovered public contract.
  The only newly designed behavior is at the shared-policy boundary and belongs in T01.

## Implementation Strategy Recommendations

- Preserve strict defaults by construction: every compatibility behavior must require an explicit
  plan-site opt-in, never a default change or fixture chmod.
- Validate in the domain before entering secure-store. Copy's raw `..` refusal and Lidarr's
  non-disclosing control/bidi rejection are intentional and cannot be reconstructed after path
  resolution.
- Translate at the domain boundary and preserve causes. No `SecureStoreError`, remediation string,
  sanitized shared path, raw errno, or accidental `TypeError` from destructuring `undefined` may
  escape a public plan API.
- Select create versus replace from operation semantics, not convenience: copy overwrite and
  existing history require the identity-guarded writer; new copy/Lidarr artifacts and first history
  require the no-clobber writer.
- Keep bytes outside secure-store. Canonical projection, JSON formatting, trailing newline,
  checksums, history compaction, and version dispatch remain owned by their domain modules.
- Treat completion as both positive and negative evidence: all focused/full gates pass, protected
  files have zero diff, both duplicate stacks are absent, `appendPlanAudit()` remains local, and all
  three shell completion templates are unchanged.
