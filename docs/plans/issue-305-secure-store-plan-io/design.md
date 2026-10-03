# Issue 305 — Migrate Plan I/O onto Secure Store

Status: design complete, ready for implementation.
Branch: `chore/305-secure-store-plan-io`.
Package under change: `packages/rfmedia-cli`.
Depends on: issue #304 (shipped by PR #319).
Corrective prerequisite: issue #321, shipped by PR #326 as `cda0b106`.
Subsumes: issue #306's post-rename pathname-hardening defect.

Implementation reconciliation: the original "unmodified under umask `002`" requirement conflicted
with the safety contract because plain fixture creation inherited `0775` parents and `0664` files.
The implementation therefore makes only fixture setup explicit (`0700` parents and `0644` files);
payloads, assertions, snapshots, and production readers remain unchanged and non-mutating.
PR review additionally restored copy-plan reads from non-private or differently owned final
directories through an explicit `"read-compatible"` parent policy. That policy relaxes only final
parent ownership/mode validation; component symlink/type checks, file modes, and parent/file
identity rechecks remain mandatory and nothing is repaired.

## Context

`plan.ts` and `lidarr/plan-engine.ts` still contain independent implementations of safe parent
walking, bounded no-follow reads, private staging, inode rechecks, atomic publication, cleanup, and
directory durability. PR #309 established `src/lib/secure-store/` as the canonical home for these
mechanics, and PR #319 migrated the Lidarr claim lock while deliberately leaving plan and history
I/O for this issue.

The migration boundary is below the domain contract. Copy-plan and Lidarr retain path policy,
schema/version dispatch, canonicalization, checksums, history reduction, public return types, and
their exact error classes. Secure-store receives only validated paths, final serialized text, byte
ceilings, expected inode identities, and fixed subjects. Every shared or raw filesystem failure is
translated before it can cross a public plan API.

Two legacy behaviors require explicit shared policy seams. Corrective issue #321 already implements
the named `"allow-foreign-read"` bounded-read policy: it accepts foreign read bits, including
ordinary `0o644` fixtures, while rejecting foreign write or execute bits (`mode & 0o033`). The #305
implementation must reuse that policy rather than add a second file-mode policy. Copy-plan also
restricts an existing final parent to `0o700`, including a `0o775` directory under umask `002`,
while Lidarr and every existing secure-store consumer validate safe caller-owned parent modes
without changing them. Copy-plan reads separately opt into `"read-compatible"` for externally
supplied directories. All exceptions remain opt-in; `"owner-only"` reads and validate-only parents
remain the defaults.

## Goals

- Remove local safe-parent walks, bounded readers, staging writers, publication, cleanup, and
  directory-sync helpers from both plan modules.
- Preserve copy-plan's literal `..` rejection ahead of path normalization.
- Reuse `"allow-foreign-read"` for ordinary plan reads without weakening private credential, lock,
  or preset reads or admitting foreign write/execute bits, and opt copy-plan into final-parent-only
  `"read-compatible"` behavior for externally supplied artifacts.
- Preserve copy-plan's final-parent `0o700` hardening through a safely opened directory handle.
- Preserve create/no-clobber, overwrite, and history compare-and-swap semantics through the shared
  create and replace writers.
- Preserve missing-artifact, missing-history, raw-errno, schema, checksum, audit, mode, byte, and
  durability behavior.
- Eliminate copy-plan's post-rename pathname `chmod`, thereby satisfying issue #306 with the shared
  writer's pre-publication handle hardening.
- Keep existing test payloads and assertions plus the copy-plan snapshot byte-identical; change only
  unsafe ambient-umask fixture setup and avoid filler coverage.

## Non-Goals

- Changing any CLI option, command, configuration key, environment variable, schema, or generated
  client.
- Moving serializers, checksums, validators, history compaction, or remote dispatch into
  secure-store.
- Migrating `appendPlanAudit()` to whole-document atomic replacement or adding a shared append API.
- Relaxing secure-store defaults or silently changing modes for Plex credentials, claims, locks,
  preset journals, or Lidarr parents.
- Replacing copy-plan's raw-segment path gate with `resolveSecurePath()`.
- Editing domain assertions, payloads, or the copy-plan snapshot to accommodate behavior drift.
- Closing #307 or #308; their hardening work remains independent.

## Existing Contract

Copy-plan validates the raw supplied path, hardens the final parent to `0o700`, creates a private
artifact or replaces an existing regular file only when `overwrite` is true, and emits canonical
pretty JSON plus one trailing newline. Reads reject symlinks, bound bytes, classify malformed JSON
and checksum failures locally, and intentionally accept ordinary file modes. `appendPlanAudit()` is
advisory: it performs one no-follow `O_APPEND` write, swallows failure, and warns at most once.

Lidarr plan artifacts are create-only and retain versioned canonical bytes. Lidarr history is named
as an append operation but is implemented as bounded read, validation and reduction of the whole
JSONL document, then create-if-missing or identity-guarded atomic replacement. Missing plan
artifacts are errors; missing history is `[]` for readers and the create branch for writers. A
valid existing parent such as `0o750` must not be changed.

## Decision

Reuse the bounded-read policy implemented by corrective issue #321 and add only the final-parent
policy required by #305:

- bounded reads remain `"owner-only"` by default; plan adapters explicitly select the already
  implemented `"allow-foreign-read"` policy;
- final parents remain `"validate"` by default; copy-plan writes and audit parent preparation opt
  into `"harden-private"`.

The reader policy name and semantics are settled by PR #326 and must not be duplicated or renamed
in #305. The synchronous reader remains strict because no synchronous plan consumer needs
compatibility mode. An `"allow-foreign-read"` asynchronous read accepts only group/other read bits:
it rejects any foreign write or execute bit using `mode & 0o033`. Both bounded readers share
`O_RDONLY | O_NONBLOCK | O_NOFOLLOW`, so a FIFO or raced special file cannot block before the
descriptor regular-file check. Each reader loops across legal short reads until EOF or the
`maximumBytes + 1` detection capacity. They retain the byte bound, before/after descriptor
identity, pathname identity, parent identity, and missing-as-`undefined` behavior.

The harden-private parent policy operates only on the final directory. The walker first rejects a
symlink/non-directory and verifies current-user ownership, opens the directory using
`O_DIRECTORY | O_NOFOLLOW`, proves the handle and pathname identify the same inode, calls
`handle.chmod(0o700)`, then re-stats and revalidates both the handle and pathname. It never chmods an
unverified pathname or changes ancestor modes. The validate policy preserves today's refusal to
repair group/other-writable final parents.

Atomic create and replace inputs carry the final-parent policy through their internal
`prepareSafeParent()` call. Their private sibling staging, `handle.chmod(0o600)`, file sync,
link/rename publication, identity checks, and cleanup remain otherwise unchanged. Directory sync
opens the captured parent with `O_DIRECTORY | O_NOFOLLOW`, verifies descriptor identity, fsyncs that
exact handle, and rechecks the pathname afterward. Create removes the staging hardlink before this
rename-sensitive window; its publication observer still fires immediately after `link`, allowing
lock acquisition to remove the published inode if staging unlink fails. This threading is necessary
because preparing a copy parent once in the adapter and then invoking a
validate-only writer would either duplicate policy or fail after a race.

## Copy-Plan Adapter

`validateArtifactPath()` remains the first operation on reads and writes. Its literal traversal
check is stricter than normalized shared resolution and remains domain policy, not duplicate
filesystem implementation.

Writes prepare the parent with harden-private policy before inspecting the target, preserving the
current ordering and side effect. `inspectExistingArtifact()` retains its regular-file/no-symlink
and `PLAN_EXISTS` checks but returns `{dev, ino}` for an overwrite target or `undefined` for
absence. After local canonicalization and size checking:

- absent target: shared atomic create with harden-private parent policy;
- existing target with overwrite disabled: existing `PLAN_EXISTS` before publication;
- existing target with overwrite enabled: shared identity-guarded replace with harden-private
  parent policy;
- absent-to-created race: shared version conflict translated to `PLAN_EXISTS`.

Reads call the shared bounded reader with `"allow-foreign-read"` and `"read-compatible"`. The
parent policy admits non-private or differently owned final directories without changing them,
while retaining component type/symlink and final identity rechecks. Shared `undefined` becomes the
existing `PLAN_IO`; returned text goes through the current JSON parser, allowlist validation,
checksum comparison, and canonical return.

`appendPlanAudit()` uses shared harden-private parent preparation, then retains its local no-follow
append handle, `0o600` file hardening, single write, and exactly-once advisory warning. Audit lookup
and pruning remain local because their best-effort and enumeration semantics are not shared atomic
document I/O.

## Lidarr Adapter

`resolveLidarrStoragePath()` remains the non-disclosing validation gate. The module deletes its
private `FileIdentity`/`SafeParent`, identity comparer, directory validator/walker, parent recheck,
directory sync, opened-file recheck, bounded reader, existence guard, and both local staging
writers.

Plan artifacts retain validation, checksum verification, version-specific canonicalization, and
size checking before shared no-clobber creation. Reads use `"allow-foreign-read"` and convert
shared absence to `LIDARR_PLAN_IO` before local parsing, schema validation, and checksum
verification.

History append performs a shared bounded read. Existing text is parsed and reduced exactly as now,
and its returned identity is retained for shared replacement. Shared absence selects atomic create.
History lookup converts shared absence directly to `[]`. The shared writer's directory fsync stays
on the blocking path before later remote dispatch.

Generalize the #304 claim I/O translator only for common domain mapping. Claim-specific
busy/corrupt acquisition, assertion, and release policies remain distinct. No shared error,
remediation string, sanitized shared path, or raw path-bearing error message may escape.

## Error Translation

| Shared/raw result                                        | Copy-plan result   | Lidarr result             |
| -------------------------------------------------------- | ------------------ | ------------------------- |
| Existing domain validation/artifact error                | Preserve unchanged | Preserve unchanged        |
| `SECURE_STORE_UNSAFE_PATH` or `SECURE_STORE_PERMISSIONS` | `PLAN_UNSAFE_PATH` | `LIDARR_PLAN_UNSAFE_PATH` |
| `SECURE_STORE_TOO_LARGE`                                 | `PLAN_TOO_LARGE`   | `LIDARR_PLAN_TOO_LARGE`   |
| Create version conflict                                  | `PLAN_EXISTS`      | `LIDARR_PLAN_EXISTS`      |
| Missing artifact read                                    | `PLAN_IO`          | `LIDARR_PLAN_IO`          |
| Missing history read/update                              | Not applicable     | `[]` / create branch      |
| Remaining shared code or raw/unknown error               | `PLAN_IO`          | `LIDARR_PLAN_IO`          |

New domain errors use fixed local messages, retain the resolved domain path where the current
contract does, and retain the original value as `cause`. Invalid Lidarr input is rejected before
shared resolution so its path remains undisclosed.

## Shared Tests

Add only focused coverage for the new shared policy surface in `secure-store.test.ts`:

- the existing #321 tests continue proving strict reads reject `0o644`, while
  `"allow-foreign-read"` accepts `0o644`, rejects foreign write/execute bits (`0o033`), reports
  too-large input, and rejects symlinks; do not duplicate those tests for #305;
- `"read-compatible"` permits a non-private final read directory without changing it, still rejects
  foreign-writable files, and preserves parent identity checks;
- a real FIFO is rejected promptly by the asynchronous reader, while a hard-timeout subprocess
  proves the synchronous reader cannot block on the same malformed input;
- deterministic three-byte descriptor reads prove both bounded readers accumulate to EOF instead
  of decoding a truncated artifact;
- create and replace reject a parent displaced during descriptor-bound directory fsync, parent
  disappearance remains a typed unsafe-path failure, and no staging name survives in the displaced
  directory;
- fault injection after create publication proves a failed staging unlink removes both the
  published lock and temporary name;
- validate-only parent preparation preserves a safe caller-owned mode;
- harden-private changes an existing `0o775` final parent to `0o700` through the descriptor and
  leaves ancestors alone;
- shared publication still produces `0o600` under a restrictive `0277` umask.

Use a dense test block or the smallest extension of current cases. Add an identity-displacement
case only if the new descriptor seam is not already exercised by an existing safety test. Do not
add domain tests that duplicate the protected compatibility suites.

## Files and Change Boundaries

1. `packages/rfmedia-cli/src/lib/secure-store/paths.ts`
   - Preserve the existing strict-default reader policies and add only the final-parent policy.
   - Implement descriptor-based final-parent hardening.
2. `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`
   - Thread final-parent policy through create and replace inputs.
   - Leave staging/publication/durability algorithms unchanged.
3. `packages/rfmedia-cli/src/lib/secure-store/index.ts`
   - Export the settled policy surface and retire stale #305 deferral prose.
4. `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`
   - Add only critical shared-policy coverage.
5. `packages/rfmedia-cli/src/lib/plan.ts`
   - Replace duplicate artifact path/read/write mechanics with thin shared adapters.
   - Retain raw path validation and local audit append/read behavior.
6. `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
   - Replace duplicate plan/history mechanics and generalize the shared-error base translator.
7. `docs/internal/plex-jwt-deferrals.md`
   - Record #305 completion, the audit exclusion, and #306 overlap using the real PR number.
8. `ROADMAP.md`
   - Reconcile #305 and #306 against live issue state immediately before closeout.

No public guide, package README, completion template, generated client, command module, schema,
configuration file, or public error type should change.

## Critical Verification

The two domain suites retain their assertions and payloads; only safe fixture modes are explicit.
The copy-plan snapshot remains unmodified. From the repository root, under Node 22:

```bash
mise exec -- bash -lc 'cd packages/rfmedia-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/secure-store/secure-store.test.ts'
mise exec -- bash -lc 'cd packages/rfmedia-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/plan.test.ts'
mise exec -- bash -lc 'cd packages/rfmedia-cli && umask 002 && env -u FORCE_COLOR npx vitest run src/lib/plan.test.ts'
mise exec -- bash -lc 'cd packages/rfmedia-cli && umask 077 && env -u FORCE_COLOR npx vitest run src/lib/plan.test.ts'
mise exec -- bash -lc 'cd packages/rfmedia-cli && umask 022 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts'
mise exec -- bash -lc 'cd packages/rfmedia-cli && umask 002 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts'
mise exec -- bash -lc 'cd packages/rfmedia-cli && env -u FORCE_COLOR npx vitest run src/actions/copy-plan.test.ts src/lib/error-formatters.test.ts src/lib/shell-completions/templates.spec.ts'
mise exec -- npm run typecheck -w packages/rfmedia-cli
mise exec -- npm run check:architecture -w packages/rfmedia-cli
mise exec -- npm run build -w packages/rfmedia-cli
mise exec -- npm run test:run
```

Repository closeout also runs Markdown lint, format check, `git diff --check`, the real pre-push
hook, and `graphify update .` from the repository root of the #305 feature worktree after source
changes. Additional invariants:

- `packages/rfmedia-cli/src/lib/plan.test.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`,
  `packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap`,
  `packages/rfmedia-cli/src/actions/copy-plan.test.ts`, and
  `packages/rfmedia-cli/src/lib/error-formatters.test.ts` have their baseline SHA-256 hashes.
- Neither plan module retains a local safe-parent walk, bounded artifact reader, staging writer, or
  directory-sync implementation.
- `appendPlanAudit()` still uses one local `O_APPEND` write and its warning test passes unchanged.
- Existing safe Lidarr parent modes remain unchanged; copy parent/artifact end at `0o700`/`0o600`.
- Shared private readers remain strict by default.
- Bash, Zsh, and Fish templates have no diff and their exact parity suite passes.
- Public plan/history signatures and serialized bytes are unchanged.

## Documentation and Issue Closeout

The PR will use the repository template and include `Closes #305` and `Closes #306`, because the
shared staging-handle publication directly implements #306's complete mitigation and its `0277`
verification. The internal deferral ADR will record the completed delegation and why audit append
remains local. ROADMAP counts and rows will be derived from live GitHub state immediately before
the closeout commit; #307 and #308 remain open. `docs/roadmap-archive.md` remains unchanged until the
whole sprint qualifies for archival.

## Risks and Rollback

The highest risks are weakening private-reader defaults, hardening the wrong directory through a
race, changing parent-mode policy for Lidarr, losing create/overwrite classification, leaking
shared errors, mishandling missing history, breaking audit warning behavior, and changing bytes.
Each is controlled by an explicit opt-in policy, descriptor and identity checks, operation-specific
adapter routing, focused shared coverage, and unmodified domain tripwires under multiple umasks.

The shared-policy amendment and the two domain adapters should remain reviewable commits, followed
by documentation/ROADMAP closeout. If an adapter fails compatibility, revert that adapter while
leaving the strict-default shared surface available for the other; never weaken a test or shared
default to force the migration through.
