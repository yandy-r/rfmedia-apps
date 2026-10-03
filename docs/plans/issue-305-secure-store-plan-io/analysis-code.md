# Code Analysis: Issue 305 Secure-Store Plan I/O

> **Implementation fixture note:** Ambient umask `002` made plain fixtures `0664` inside `0775`
> parents, contradicting the non-mutating foreign-write rejection contract. Fixture setup now
> declares the intended `0644`/`0700` modes explicitly; assertions, payloads, and snapshots do not
> change.

## Superseding Reader-Policy Update

Corrective issue #321 implements the named `"allow-foreign-read"` policy, shipped by PR #326 as
`cda0b106`. It retains `"owner-only"` as the default, accepts foreign read bits such as
ordinary `0o644`, and rejects foreign write or execute bits (`mode & 0o033`). Any earlier wording
below that proposed a new caller-managed or unrestricted reader is superseded: #305 must reuse the
existing policy and add only its descriptor-validated final-parent policy.

## Executive Summary

Issue #305 should be a delete-and-delegate refactor with narrow additive policy seams in
`secure-store`: plan modules retain path prevalidation, serialization, validation, checksums,
history reduction, and public error types, while shared code takes ownership of parent traversal,
bounded no-follow reads, private staging, atomic publication, identity checks, cleanup, and parent
directory durability. The implementation must preserve strict secure-store defaults, reuse
`"allow-foreign-read"` for plan reads, and add descriptor-based final-parent hardening for
copy-plan only.

## Existing Code Structure

### Shared secure-store layer

- `/packages/rfmedia-cli/src/lib/secure-store/paths.ts` owns `FileIdentity`, `SafeParent`, path
  resolution, parent traversal, inode rechecks, and sync/async bounded readers. Before #321,
  `prepareSafeParent(filePath, createMissing, subject)` validates the final parent's ownership and
  rejects `mode & 0o022`; bounded readers rejected file `mode & 0o077`. PR #326 adds the explicit
  async `"allow-foreign-read"` policy described above without changing missing-as-`undefined`.
- `/packages/rfmedia-cli/src/lib/secure-store/atomic.ts` owns the complete publication lifecycle.
  `createPrivateFileAtomically()` stages and hard-links without clobbering;
  `replacePrivateFileAtomically()` stages and identity-guards a rename. Both use sibling temporary
  files, `handle.chmod(0o600)`, file `fsync`, post-publication inode checks, parent revalidation,
  directory `fsync`, and best-effort stage cleanup.
- `/packages/rfmedia-cli/src/lib/secure-store/errors.ts` deliberately maps only path-shaped errnos
  (`ELOOP`, `ENOTDIR`, `EACCES`, `EPERM`). Other failures such as `ENOSPC`, `EIO`, and `EROFS`
  remain raw, so domain adapters require a final fallback arm.
- `/packages/rfmedia-cli/src/lib/secure-store/index.ts` is the supported import boundary. Its JSDoc
  currently records #305 as deferred and must be updated when the delegation lands.

### Copy-plan adapter

- `/packages/rfmedia-cli/src/lib/plan.ts:1020` `validateArtifactPath()` is a domain policy gate, not
  duplicate secure-store mechanics. It rejects raw `..` segments before `resolve()`, NUL, empty or
  overlong input, and a filesystem root. It must remain first on both read and write paths because
  `resolveSecurePath()` normalizes traversal away.
- `/packages/rfmedia-cli/src/lib/plan.ts:1036` through `:1107` contains the duplicate symlink walk
  and final-parent hardener. `ensurePrivateArtifactDirectory()` opens the final directory with
  `O_DIRECTORY | O_NOFOLLOW` and changes it to `0o700`; this behavior is pinned under permissive
  umasks and is the source of the new shared parent policy.
- `/packages/rfmedia-cli/src/lib/plan.ts:1110` `inspectExistingArtifact()` owns copy-specific
  overwrite policy. It currently returns no identity; it should instead return
  `FileIdentity | undefined` after retaining the regular-file/no-symlink and `PLAN_EXISTS` checks.
- `/packages/rfmedia-cli/src/lib/plan.ts:1146` `writePlanArtifact()` retains canonical key order,
  two-space JSON, one trailing newline, the 10 MiB cap, and its public signature. Its local sibling
  stage, `rename()`, and pathname `chmod()` are the publication block to remove.
- `/packages/rfmedia-cli/src/lib/plan.ts:1190` `readRawPlanArtifact()` mixes bounded filesystem I/O
  with JSON parsing. Replace only the filesystem portion; retain `PLAN_MALFORMED`, allowlist
  validation with a rebound `planPath`, checksum verification, and canonical return in the domain
  module.
- `/packages/rfmedia-cli/src/lib/plan.ts:1522` `appendPlanAudit()` is intentionally excluded from
  atomic-writer migration. It needs `O_APPEND` and one local `write()`; only its parent preparation
  may delegate. `/packages/rfmedia-cli/src/lib/plan.ts:1567` `findPlanApplications()` also remains
  advisory and local.

### Lidarr plan/history adapter

- `/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:3839`
  `resolveLidarrStoragePath()` remains the domain front door. It preserves path-free
  `LIDARR_PLAN_UNSAFE_PATH` errors for invalid/control-bearing input and still aliases the shared
  maximum path length.
- `/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:3821` through `:3994` is the duplicate
  filesystem stack to delete: private `FileIdentity`/`SafeParent`, `sameIdentity()`, safe-directory
  validation, parent walk, parent sync, file identity checks, bounded read, and existing-path
  rejection.
- `/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:3997` keeps plan schema/checksum validation,
  v1/v2/v3 canonicalization, exact serialized bytes, and the 10 MiB cap, then delegates its
  create-only publication to `createPrivateFileAtomically()`.
- `/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:4060` keeps JSON parsing, exact schema
  validation, checksum verification, and stable errors, but obtains text through the shared reader.
- `/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:4289` treats history as a complete bounded
  document, despite the function name `appendLidarrPlanHistory()`. Existing record parsing,
  identity checks, compaction, ordering, entry cap, and JSONL serialization stay local; publication
  becomes shared create when absent or identity-guarded replace when present.
- `/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:4657` already contains the #304 adapter
  precedent. `translateClaimIoFailure()` preserves domain errors, recognizes shared and raw path
  failures, maps shared oversize, and collapses everything else to Lidarr I/O. Generalize this base
  logic for artifact/history calls while retaining the claim-specific busy/corrupt behavior.

## Implementation Patterns

- **Backward-compatible options, strict by default:** Existing public shared functions use named
  option interfaces when behavior has multiple axes (`SecureStoreLockOptions`,
  `AtomicWriteInput`). Reuse the settled `"owner-only" | "allow-foreign-read"` bounded-read policy
  from #321, and add a descriptive validate-only versus harden-private final-parent policy rather
  than an ambiguous boolean. Omitted options must exactly reproduce today's strict/no-repair
  behavior.
- **Thread policy through composite APIs:** Atomic writers call `prepareSafeParent()` internally,
  so `AtomicWriteInput` must carry the final-parent policy through to that call. The bounded reader
  likewise uses its existing file-mode policy and needs access to the parent policy; copy-plan fixtures can
  live in a `0o775` directory under umask `002`, while Lidarr's existing `0o750` parent must remain
  unchanged.
- **Descriptor hardening, not pathname repair:** For copy-plan's opt-in policy, open the final
  directory with no-follow/directory flags, verify type and owner from the handle, call
  `FileHandle.chmod(PRIVATE_DIRECTORY_MODE)`, re-stat the handle, and reassert pathname identity.
  Do not recreate `plan.ts`'s pathname `chmod` race inside shared code.
- **Domain adapter around shared mechanics:** Follow
  `/packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts:691`: serialize and validate
  locally, call shared create/replace, retain the returned identity, and translate at the catch
  boundary. `/packages/rfmedia-cli/src/lib/adapters/plex/credential-store.ts:400` is the clearest
  create-versus-replace routing example.
- **Create versus replace is caller policy:** Copy-plan uses create for an absent target, replace
  only when `overwrite: true` and inspection captured an identity, and `PLAN_EXISTS` otherwise.
  Lidarr plans always create. Lidarr history creates after a missing read and replaces using the
  exact identity returned by an existing read.
- **Total error translation:** Preserve already-domain-typed errors, translate every
  `SecureStoreError` code explicitly, then map unmatched raw or unknown values to the domain I/O
  code with `cause`. Fixed local messages prevent shared sanitized paths/remediation or raw
  untrusted strings from becoming the public contract.
- **Operation-specific absence:** The shared reader's `undefined` means `PLAN_IO` for copy artifact
  reads, `LIDARR_PLAN_IO` for Lidarr artifact reads, `[]` for history lookup, and the create branch
  for history update. Handle this before destructuring.
- **Supported barrel imports only:** All new policy types and functions must be exported from
  `secure-store/index.ts`; neither plan module should deep-import `paths.ts` or `atomic.ts`.

## Integration Points

### Files to modify

- `/packages/rfmedia-cli/src/lib/secure-store/paths.ts`
  - Preserve the exported strict-default reader policy from #321.
  - Reuse `"allow-foreign-read"`, which accepts foreign read bits but rejects foreign write/execute
    bits (`0o033`) while retaining byte bounding, no-follow open, inode checks, and parent
    revalidation.
  - Add the descriptor-based final-parent hardening branch without weakening validate-only callers.
- `/packages/rfmedia-cli/src/lib/secure-store/atomic.ts`
  - Extend `AtomicWriteInput` so create and replace can pass the selected final-parent policy.
  - Keep staging, publication, durability ordering, and cleanup unchanged.
- `/packages/rfmedia-cli/src/lib/secure-store/index.ts`
  - Export the new policies/options and retire the #305 deferral prose.
- `/packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`
  - Pin strict defaults and each opt-in policy directly at the shared layer.
- `/packages/rfmedia-cli/src/lib/plan.ts`
  - Retain `validateArtifactPath()`, serializers, validators, checksums, public signatures, audit
    append/read, and pruning.
  - Replace the local walk/read/write stack with barrel imports and a copy-domain translator.
  - Convert target inspection to return the identity required by shared replace.
- `/packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`
  - Remove the local path/read/write types and helpers.
  - Add thin plan/history read and publication adapters over the shared APIs.
  - Reuse a generalized base translator from the existing claim translation family.

No new production source file is warranted: the policy belongs with the shared primitive, and both
domain adapters already have clear homes.

### Error mapping

| Shared/raw result                                        | Copy-plan result   | Lidarr result             |
| -------------------------------------------------------- | ------------------ | ------------------------- |
| Existing domain error                                    | Preserve unchanged | Preserve unchanged        |
| `SECURE_STORE_UNSAFE_PATH` or `SECURE_STORE_PERMISSIONS` | `PLAN_UNSAFE_PATH` | `LIDARR_PLAN_UNSAFE_PATH` |
| `SECURE_STORE_TOO_LARGE`                                 | `PLAN_TOO_LARGE`   | `LIDARR_PLAN_TOO_LARGE`   |
| `SECURE_STORE_VERSION_CONFLICT` on create                | `PLAN_EXISTS`      | `LIDARR_PLAN_EXISTS`      |
| Reader returns `undefined` for artifact                  | `PLAN_IO`          | `LIDARR_PLAN_IO`          |
| Reader returns `undefined` for history                   | Not applicable     | `[]` or create branch     |
| Remaining shared code or raw/unknown I/O                 | `PLAN_IO`          | `LIDARR_PLAN_IO`          |

The public classes in `/packages/rfmedia-cli/src/lib/errors.ts` must remain unchanged.
`/packages/rfmedia-cli/src/lib/error-formatters.ts:81` uses `instanceof PlanArtifactError`, and its
checksum-specific guidance depends on the exact `PLAN_CHECKSUM_MISMATCH` code.

### Expected import cleanup

- `plan.ts` should lose artifact-only `chmod`, `mkdir`, and `rename` imports plus
  `PRIVATE_DIRECTORY_MODE`. `FileHandle`, `open`, `constants`, and `PRIVATE_FILE_MODE` remain for
  audit operations; `randomUUID`, `basename`, and `parse` remain for plan IDs and path validation;
  target inspection may retain `lstat`.
- `plan-engine.ts` should lose `node:fs`, `node:fs/promises`, `dirname`, `parse`, `relative`, and
  `sep` after the duplicate storage block disappears. `join` and `resolve` remain. Its secure-store
  barrel import grows to include bounded read, atomic create/replace, relevant policy types, and
  `FileIdentity`; the private-mode constants are no longer needed there.

## Code Conventions

- TypeScript uses ESM `.js` import specifiers, `readonly` interface fields, `unknown` catches, and
  explicit return types on exported functions and substantial helpers.
- Shared error codes are closed unions. Exhaustive `Record<Code, DomainCode>` maps work when the
  mapping is truly operation-independent; use switches plus a raw fallback when create, read,
  history, and claim semantics differ.
- Preserve `Error` causes with the existing conditional `{ cause }` pattern; do not overwrite
  public messages with `SecureStoreError.message` or raw filesystem messages.
- Serialization uses `JSON.stringify(value, null, 2) + "\n"` for artifacts and compact JSONL for
  history/audit. Secure-store receives final text and must remain schema-agnostic.
- Temporary identifiers are stable caller discriminators, not full filenames. Copy-plan can use a
  stable artifact discriminator; Lidarr plans/history can use the validated plan ID while shared
  code supplies the collision-resistant suffix.
- Comments should explain policy and security ordering. Remove stale comments that describe local
  implementations after their helpers are deleted.

## Dependencies and Services

- **Node 22 filesystem APIs:** Correctness depends on `O_NOFOLLOW`, `O_DIRECTORY`, hard-link and
  rename atomicity, `{dev, ino}` identity, handle `chmod`, and file/directory `fsync`. Preserve the
  existing Windows directory-sync no-op.
- **Domain types:** `COPY_PLAN_MAX_BYTES` and `LIDARR_PLAN_MAX_BYTES` are both 10 MiB and remain in
  their type modules; the shared reader receives the applicable ceiling rather than importing
  domain constants.
- **No external service change:** Docker, Lidarr HTTP clients, SQLite, CLI configuration, command
  options, shell completions, and generated clients are outside this refactor.
- **Runtime/verification:** Use the repository's Node 22 contract via `mise exec -- ...`; no new npm
  dependency is required.

## Gotchas and Warnings

- `resolveSecurePath()` is not a replacement for copy-plan's raw traversal check. Calling it first
  makes `plans/../escape.json` appear safe after normalization.
- Do not reinterpret `"allow-foreign-read"` as unrestricted: it accepts foreign read bits but must
  reject foreign write or execute bits (`mode & 0o033`). Globally weakening the default gate would
  expose Plex credentials, locks, and preset journals.
- Copy-plan and Lidarr have opposite final-parent behavior. Copy-plan must produce `0o700` even from
  a pre-existing permissive directory; Lidarr must not chmod a safe caller-owned `0o750` parent.
- `createPrivateFileAtomically()` and `replacePrivateFileAtomically()` prepare parents internally.
  Hardening a parent once in the adapter but failing to thread the same policy into the writer can
  reintroduce rejection or duplicate walks.
- Shared writers strengthen race handling. An absent-then-created target becomes a version
  conflict; an existing-then-replaced target fails the identity guard. Translate these rather than
  leaking `SecureStoreError`.
- `appendPlanAudit()` is not Lidarr-style whole-document history. Do not add an append primitive or
  route it through an atomic replacement; keep its one `O_APPEND` write and exactly-once warning.
- A mocked audit `open()` failure must still log exactly once with both `audit ledger` and the raw
  `EACCES` text. Additional audit-path opens or shared error sanitization can break that contract.
- Copy-plan's current post-rename pathname `chmod()` is the race tracked by #306. Shared descriptor
  staging removes it and guarantees `0o600` even under restrictive umask `0277`; implementation
  closeout must coordinate the overlapping issue rather than leaving it stale.
- Do not regenerate `/packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap`. Any change
  means serialization moved or drifted, which is outside scope.

## Task-Specific Guidance

1. Reuse #321's existing reader policy and implement only the new final-parent seam first. Preserve
   the critical tests proving strict reads reject `0o640`, `"allow-foreign-read"` accepts ordinary
   fixtures but rejects foreign write/execute bits, and all oversize/symlink checks remain. Add only
   the focused #305 proof that validate-only parent handling rejects unsafe permissions and copy's
   opt-in hardens an existing final parent to `0o700` through a descriptor.
2. Migrate `plan.ts` next. Keep `validateArtifactPath()`, make existing-target inspection return an
   identity, route absent/existing targets to create/replace, translate every failure, and retain
   audit append locally with shared parent preparation only.
3. Migrate Lidarr artifact and history I/O after the shared API is stable. Delete the duplicate
   helper block, use `"allow-foreign-read"`, route history by returned identity, and generalize the
   already-shipped claim translator without changing claim behavior.
4. Keep `plan.test.ts`, `plan-engine.test.ts`, `copy-plan.test.ts`,
   `error-formatters.test.ts`, and the snapshot unmodified. Their current assertions are migration
   compatibility gates, not places to encode the new implementation.
5. Run both plan suites under umask `022` and `002`, and add a restrictive-umask `0277` publication
   check for the #306 overlap. Then run focused secure-store, copy action, and formatter suites,
   followed by package typecheck, architecture checks, build, and the root test runner.
