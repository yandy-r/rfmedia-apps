# Issue 305 Secure-Store Plan I/O Architecture Research

**Implementation fixture note:** Ambient umask `002` made plain fixtures `0664` inside `0775`
parents, contradicting the non-mutating foreign-write rejection contract. Fixture setup now
declares the intended `0644`/`0700` modes explicitly; assertions, payloads, and snapshots do not
change.

> **Superseding reader-policy note:** Corrective issue #321 implements
> `"owner-only" | "allow-foreign-read"`, shipped by PR #326 as `cda0b106`.
> `"allow-foreign-read"` accepts foreign read bits such as ordinary `0o644`, but rejects foreign
> write or execute bits (`mode & 0o033`). Issue #305 reuses that settled seam and adds only
> descriptor-validated final-parent hardening plus writer propagation.

## System Overview

Issue #305 is a delete-and-delegate migration of two domain persistence stacks onto
`packages/rfmedia-cli/src/lib/secure-store/`. The copy-plan stack in `src/lib/plan.ts` owns sealed
`rfmedia.copy-plan.v1` JSON artifacts, while `src/lib/lidarr/plan-engine.ts` owns versioned sealed
Lidarr plan artifacts and per-plan JSONL history. Both currently duplicate safe parent traversal,
bounded no-follow reads, inode checks, private staging, and atomic publication that secure-store
already centralizes.

The safe boundary is below serialization, validation, checksums, history reduction, and public
errors. Those remain in the two plan modules; only filesystem mechanics move behind the supported
`secure-store/index.ts` barrel. Each plan module must translate shared failures back into its
existing `PlanArtifactError` or `LidarrPlanArtifactError` contract so no `SecureStoreError` reaches
CLI callers. The claim migration completed by #304 is the precedent: `plan-engine.ts` already wraps
`acquireExclusiveLock()` and translates shared failures at lines 4657-4714.

The reader seam required for delegation is already supplied by #321: plan readers explicitly use
`"allow-foreign-read"`, while strict `"owner-only"` remains the default. This is not unrestricted
mode acceptance; foreign write/execute bits remain rejected. Copy-plan writes still need the new
seam that deliberately hardens an existing final parent to `0o700`, whereas secure-store normally
refuses silent repair. Defaults stay strict/no-repair for Plex, locks, and preset journals.

## Relevant Components

- `packages/rfmedia-cli/src/lib/plan.ts:1020-1032` — `validateArtifactPath()` is a domain gate and
  must remain ahead of all shared calls. It rejects raw `..` segments before `resolve()`, empty or
  overlong input, NUL, and filesystem roots; `resolveSecurePath()` does not preserve the traversal
  refusal.
- `packages/rfmedia-cli/src/lib/plan.ts:1036-1107` — local symlink walk and final-parent hardener.
  `ensurePrivateArtifactDirectory()` force-chmods the final directory to `0o700`, including a
  pre-existing `0o775` directory under umask `002`; this machinery should become a secure-store
  parent-preparation policy rather than remain local.
- `packages/rfmedia-cli/src/lib/plan.ts:1110-1131` — `inspectExistingArtifact()` owns the
  `PLAN_EXISTS`/`overwrite` decision and regular-file check. Delegation needs the existing file's
  `{dev, ino}` identity for shared replacement, or absence for shared creation.
- `packages/rfmedia-cli/src/lib/plan.ts:1146-1188` — `writePlanArtifact()` retains canonicalization,
  pretty JSON plus trailing newline, and the byte cap. Its temporary-open/fsync/rename/chmod block
  is the writer to replace with shared create/replace operations.
- `packages/rfmedia-cli/src/lib/plan.ts:1190-1277` — `readRawPlanArtifact()` and
  `readPlanArtifact()` separate filesystem reading from JSON parsing, schema validation,
  canonicalization, and checksum verification. Only the first layer delegates.
- `packages/rfmedia-cli/src/lib/plan.ts:1522-1543` — `appendPlanAudit()` remains append-mode and is
  not an atomic-writer migration target, but it currently calls the local parent hardener. It can
  use the shared parent-preparation policy while retaining one `O_APPEND` open and its non-blocking
  warning contract.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:3835-3851` —
  `resolveLidarrStoragePath()` remains the Lidarr prevalidation gate. It preserves path-free errors
  for empty, overlong, control-bearing, or bidi-bearing input.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:3853-3994` — the complete duplicate Lidarr
  stack: safe-directory checks, `prepareSafeParent()`, parent/file identity rechecks, directory
  fsync, `readBoundedFile()`, and `rejectExistingPath()`. These are the primary deletion seam.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:3997-4097` — plan artifact writer/reader.
  Canonical version dispatch, checksum validation, JSON parsing, and schema validation stay local;
  hard-link creation and bounded reads move to secure-store.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:4289-4458` — history is a bounded
  read/validate/reduce/write cycle. Existing history uses create when missing and identity-guarded
  rename when present, which maps directly to shared create versus replace.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:4657-4714` — #304's
  `translateClaimIoFailure()` family is the in-file precedent. Its common unsafe/permissions,
  too-large, and raw-I/O mapping can become a plan-engine-wide base translator while
  acquisition/assert/release retain their claim-specific `AlreadyRunning` arms.
- `packages/rfmedia-cli/src/lib/secure-store/paths.ts:97-178` — `resolveSecurePath()` and
  `prepareSafeParent()` own canonical path traversal. The existing final-parent rule rejects
  group/other write bits and deliberately does not repair them.
- `packages/rfmedia-cli/src/lib/secure-store/paths.ts:318-370` —
  `readBoundedPrivateFile()` already supplies no-follow open, bounded `maximumBytes + 1` reading,
  before/after inode checks, and parent revalidation. After #321 it returns `undefined` for absence,
  defaults to `"owner-only"`, and offers `"allow-foreign-read"`, which accepts foreign read bits but
  rejects `mode & 0o033`.
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts:100-228` — private sibling staging plus
  `createPrivateFileAtomically()` (`link`, no clobber) and `replacePrivateFileAtomically()`
  (identity-guarded `rename`). Both fsync the stage and parent and chmod the open stage handle, so
  restrictive umasks cannot leave a `0o400` artifact.
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts:12-20` and `:128-203` — shared error codes,
  sanitized paths, and partial errno mapping. Raw `ENOSPC`/`EIO`/`EROFS` can still escape and must
  be caught by each domain translator.
- `packages/rfmedia-cli/src/lib/secure-store/index.ts:20-61` — supported import boundary. Any new
  reader/parent policy types or helpers must be exported here; consumers must not deep-import
  `paths.ts` or `atomic.ts`.
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts:145-168` and `:690-763` — proven
  adapter pattern: serialize locally, call shared create/replace, translate at the domain boundary,
  and retain the returned file identity for later compare-and-swap replacement.

## Data Flow

### Copy-plan artifact write

1. `writePlanArtifact()` calls `validateArtifactPath()` before shared code so raw traversal and root
   paths retain `PLAN_UNSAFE_PATH` behavior.
2. The shared parent seam walks every component without following symlinks, creates missing
   directories, and, for this adapter only, hardens the existing final parent to `0o700` before
   enforcing its final ownership/write-bit checks. The same seam is reusable by `appendPlanAudit()`.
3. Copy-plan code validates whether the target is absent or an existing regular non-symlink and
   captures its identity. No overwrite means shared atomic create; overwrite plus an existing
   identity means shared atomic replace; overwrite plus absence still means create.
4. Copy-plan code builds exactly the current bytes: canonical key order,
   `JSON.stringify(..., null, 2)`, and one trailing newline. It performs the existing byte cap before
   passing text to secure-store.
5. Secure-store stages a sibling `0o600` inode, explicitly chmods the open handle (survives a
   restrictive umask), writes/fsyncs, publishes with `link` or identity-guarded `rename`, validates
   parent/file identity, fsyncs the directory, and removes the stage on every exit.
6. A domain translator maps version conflict to `PLAN_EXISTS`, shared too-large to
   `PLAN_TOO_LARGE`, path/permission failures to the operation's existing safety classification,
   and every raw/unclassified failure to `PLAN_IO`, preserving `planPath` and `cause`.

### Copy-plan artifact read

1. `readPlanArtifact()` retains `validateArtifactPath()` and calls the shared async bounded reader
   with `"allow-foreign-read"`: accept ordinary foreign read bits, reject foreign write/execute
   bits, and keep no-follow, byte ceiling, inode, and parent checks.
2. Shared absence must be converted to the current `PLAN_IO` result; it must not leak as
   `undefined` or become a destructuring error.
3. The returned text continues through local JSON parsing (`PLAN_MALFORMED`), exact allowlist
   validation (`PlanValidationError` with `planPath`), checksum comparison, and canonical return.
   Serializer and checksum code never move into secure-store.

### Lidarr artifact write/read

1. `writeLidarrPlanArtifact()` retains `resolveLidarrStoragePath()`, schema validation, checksum
   rejection, version-specific canonicalization, current bytes, and size cap.
2. Atomic no-overwrite publication delegates to `createPrivateFileAtomically()`. Shared version
   conflict translates to `LIDARR_PLAN_EXISTS`; all shared/raw failures translate to the current
   Lidarr artifact taxonomy. Existing caller-owned final directories, including a valid `0o750`
   directory, are checked but never chmod-ed.
3. `readLidarrPlanArtifact()` uses the `"allow-foreign-read"` bounded reader. Missing input
   translates to `LIDARR_PLAN_IO`; malformed JSON, validation, and checksum handling remain
   unchanged.

### Lidarr history read/modify/write

1. `appendLidarrPlanHistory()` validates the incoming record, resolves the current history path,
   and performs one shared bounded read. `undefined` means first write; otherwise its returned
   identity is retained for replacement.
2. Existing JSONL parsing, plan-identity checks, possible-dispatch/terminal reduction, entry cap,
   ordering, serialization, and byte cap stay local and therefore byte-stable.
3. First history publication delegates to shared create; an existing history delegates to shared
   replace with the identity captured by the read. This removes the local stage/rename/fsync stack
   while strengthening the compare-and-swap boundary against a displaced history file.
4. `readLidarrPlanHistory()` converts shared absence directly to `[]` before destructuring. All
   non-absence failures pass through the Lidarr translator, then local line/schema/identity
   validation proceeds unchanged.

## Integration Points

- **Reader policy must be opt-in and default-safe.** Plan adapters select
  `"allow-foreign-read"` so `0o644` Lidarr checksum/malformed-history fixtures and copy-plan's
  oversized fixture reach their domain checks. The existing policy still rejects foreign
  write/execute bits (`0o033`); Plex credentials, locks, and preset persistence retain
  `"owner-only"` by default.
- **Copy-plan parent hardening is a distinct opt-in.** Under umask `002`,
  `plan.test.ts:396-405` creates `real-dir` as `0o775`; current copy-plan code changes it to `0o700`
  before writing. Lidarr's `plan-engine.test.ts:1696-1706` asserts the opposite policy for a valid
  pre-existing `0o750` parent: leave its effective mode unchanged. One shared walker therefore
  needs explicit final-parent policy rather than a new global default.
- **Keep `validateArtifactPath()` exactly as a front-door gate.** Replacing it with
  `resolveSecurePath()` accepts `plans/../escape.json` after normalization and breaks both copy-plan
  read and write traversal tests. Lidarr's resolver intentionally has different semantics and
  should not inherit copy-plan's raw-`..` refusal.
- **Generalize #304's translator, do not duplicate it.** A shared plan-engine base can preserve
  already-constructed Lidarr errors, map `SECURE_STORE_UNSAFE_PATH` and
  `SECURE_STORE_PERMISSIONS` to `LIDARR_PLAN_UNSAFE_PATH`, map `SECURE_STORE_TOO_LARGE`, and fall
  back to `LIDARR_PLAN_IO`. Claim acquisition/assert/release remain thin specialized wrappers because
  busy/corrupt have operation-specific meanings there.
- **Translation is operation-aware.** Shared absence is `PLAN_IO` for copy/Lidarr artifact reads,
  `[]` for Lidarr history reads, and the create branch for history append. Shared version conflict
  is `PLAN_EXISTS` or `LIDARR_PLAN_EXISTS` for no-overwrite publication. A raw errno can still escape
  shared code, so translators need an explicit non-`SecureStoreError` fallback.
- **Preserve public error identity.** `error-formatters.ts:79-95` recognizes only
  `PlanArtifactError` and adds a checksum-tamper suggestion. Copy action tests also assert
  `name === "PlanArtifactError"`. No shared error code, sanitized shared path, remediation, or
  generic `Error` may escape either adapter.
- **Do not migrate the audit append itself.** `appendPlanAudit()` requires one
  `O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW` write to an existing inode; secure-store has no
  append primitive. Only its parent preparation can delegate. Its mocked `EACCES` path must still
  produce exactly one warning containing `audit ledger` and `EACCES`.
- **Preserve create/overwrite semantics.** Copy-plan's `overwrite: true` permits both create-if-
  absent and replace-if-present. Lidarr plan artifacts remain no-overwrite. History remains
  create-if-missing/replace-if-present. These contracts require adapter selection between the two
  shared atomic writers rather than replacing every call with one primitive.
- **Serialization is outside the migration.** After the #305 branch is refreshed onto PR #326,
  freeze fresh SHA-256 values for `packages/rfmedia-cli/src/lib/plan.test.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`,
  `packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap`,
  `packages/rfmedia-cli/src/actions/copy-plan.test.ts`, and
  `packages/rfmedia-cli/src/lib/error-formatters.test.ts`. Lidarr's pinned artifact and history
  fixtures are byte-level contracts. Temporary names, modes, and fsync mechanics may change, but
  serialized bytes may not.
- **Issue #306 overlaps mechanically.** Delegating copy-plan publication removes the post-rename
  path `chmod()` and adopts secure-store's pre-close handle chmod. That is the exact hardening
  tracked by #306, so implementation planning should explicitly mark #306 as subsumed or coordinate
  its closeout rather than leave a duplicate open task.
- **Expected import cleanup is localized.** Once Lidarr persistence delegates, `Stats`,
  `FileHandle`, `chmod`, `lstat`, `link`, `mkdir`, `open`, `rename`, `rm`, `unlink`, `dirname`,
  `parse`, `relative`, and `sep` have no non-persistence uses in `plan-engine.ts`; `join` and
  `resolve` remain. In `plan.ts`, append/read/prune paths still require `open`, `FileHandle`,
  `chmod` through a handle, and `unlink`, while artifact-only `lstat`/`rename` imports may disappear
  depending on where target inspection lives.

## Key Dependencies

- **Domain errors:** `packages/rfmedia-cli/src/lib/errors.ts:55-90` and `:106-142` define the stable
  copy/Lidarr artifact and validation shapes. They remain authoritative above secure-store.
- **Shared filesystem contracts:** `paths.ts` supplies path resolution, parent and inode checks, and
  bounded reads; `atomic.ts` supplies same-directory private staging, create/link, replace/rename,
  and directory durability. Consumers import only through `secure-store/index.ts`.
- **Node filesystem semantics:** the architecture assumes `O_NOFOLLOW`, local-filesystem hard-link
  and rename atomicity, `{dev, ino}` identities, and directory fsync. The Windows guard in
  `syncDirectory()` must remain; network filesystems are not a reliable locking/CAS substrate.
- **Umask behavior:** shared staging must explicitly `chmod(0o600)` on the open descriptor so umask
  `0277` does not yield `0o400`; copy-plan parent preparation must still end at `0o700` under umask
  `002`; Lidarr must preserve valid caller-owned parent modes rather than normalizing them.
- **Consumers:** copy planning/apply enters through `src/actions/copy-plan.ts:360` and `:449`; Lidarr
  plan generation has multiple action producers, artifact apply enters through
  `src/actions/lidarr/apply.ts:1058`, and history is used throughout apply, deferred replay, album,
  artist-add, and track-filter execution. Their signatures should remain unchanged.
- **Regression suites:** `src/lib/plan.test.ts:303-443` pins modes, no temp residue, snapshot bytes,
  overwrite, symlink/traversal, size, malformed, and missing errors; `:754-805` pins audit behavior.
  `src/lib/lidarr/plan-engine.test.ts:1651-1771` pins artifact I/O and path redaction;
  `:1774-2079` pins history semantics; `:2457-2495` pins legacy bytes. These files are compatibility
  evidence and should remain unmodified.
- **Cross-layer verification:** `src/actions/copy-plan.test.ts` and
  `src/lib/error-formatters.test.ts` protect error identity and checksum messaging;
  `src/lib/secure-store/secure-store.test.ts` protects strict defaults for other consumers. The
  repository's Node 22 runtime and package architecture gate remain mandatory for type/barrel
  integrity.
