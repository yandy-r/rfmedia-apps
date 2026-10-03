# Issue #305 Integration Research: Secure-Store Plan I/O

**Implementation fixture note:** Ambient umask `002` made plain fixtures `0664` inside `0775`
parents, contradicting the non-mutating foreign-write rejection contract. Fixture setup now
declares the intended `0644`/`0700` modes explicitly; assertions, payloads, and snapshots do not
change.

> **Superseding reader-policy note:** Corrective issue #321 implements
> `"owner-only" | "allow-foreign-read"`, shipped by PR #326 as `cda0b106`.
> `"allow-foreign-read"` accepts ordinary foreign read bits but rejects foreign write/execute bits
> (`mode & 0o033`). Issue #305 reuses that policy and adds only final-parent hardening plus writer
> propagation.

## Overview

Issue #305 is an internal, behavior-preserving migration of copy-plan artifacts and Lidarr
artifact/history persistence onto `src/lib/secure-store/`. The shared primitives can own the safe
parent walk, bounded read, staged private write, identity checks, atomic publication, cleanup, and
directory sync, but thin operation-specific adapters must preserve the existing copy and Lidarr
error classes, missing-file meanings, overwrite rules, serialization, and caller-visible paths.

There is no HTTP endpoint, generated client, database schema, remote-service, CLI option, or file
schema change. `appendPlanAudit()` remains an `O_APPEND` operation outside the atomic document
writers; its non-blocking warning contract must not be folded into the blocking artifact/history
adapters.

## Relevant Files

- `packages/rfmedia-cli/src/lib/plan.ts`: copy-plan path validation, artifact reader/writer,
  audit ledger, pruning, and the shared `RFMEDIA_PLAN_DIR` resolver.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Lidarr artifact reader/writer, per-plan
  history read/replace, domain error translation, and the already-migrated claim lock.
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`: supported barrel for every shared path,
  reader, writer, identity, and error primitive.
- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`: `prepareSafeParent()`,
  `readBoundedPrivateFile()`, identity assertions, path resolution, and private-mode gates.
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`:
  `createPrivateFileAtomically()`, `replacePrivateFileAtomically()`, and `syncDirectory()`.
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts`: `SecureStoreError`, stable shared codes,
  path sanitization, and raw-errno behavior.
- `packages/rfmedia-cli/src/lib/errors.ts`: public `PlanArtifactError`, `PlanValidationError`,
  `LidarrPlanArtifactError`, and `LidarrPlanValidationError` contracts.
- `packages/rfmedia-cli/src/lib/error-formatters.ts`: copy-plan formatter selected by
  `error instanceof PlanArtifactError` and checksum-specific guidance.
- `packages/rfmedia-cli/src/actions/copy-plan.ts`: only production consumer of copy artifact I/O,
  pruning, audit append, and already-applied lookup.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: main Lidarr artifact reader and history/claim
  coordinator.
- `packages/rfmedia-cli/src/actions/lidarr/apply-track-filter-execution.ts` and
  `apply-artist-add.ts`: independent history readers and apply admission paths.
- `packages/rfmedia-cli/src/actions/lidarr/apply-album-mutation-execution.ts`: direct blocking
  history writer at album mutation boundaries.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: dynamic pre-apply artifact read and structural
  machine-error projection.
- `packages/rfmedia-cli/src/lib/plan.test.ts`, `lib/lidarr/plan-engine.test.ts`,
  `lib/error-formatters.test.ts`, and `actions/copy-plan.test.ts`: compatibility tripwires.
- `packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap`: byte-level copy-plan
  serialization contract; must remain unchanged.

## API and Entry Points

### CLI entry points

No route or option changes are required. Existing flows are:

```text
rfmedia copy ... --plan [--plan-output PATH]
  -> executePlanGeneration()
  -> writePlanArtifact()
  -> prunePlans() only for an automatically selected path

rfmedia copy --apply PATH [--dry-run] [--force-stale]
  -> executePlanApply()
  -> readPlanArtifact()
  -> findPlanApplications()
  -> appendPlanAudit() for non-check outcomes

rfmedia lidarr <plan producer>
  -> build/seal plan
  -> writeLidarrPlanArtifact()

rfmedia lidarr apply PATH
  -> command-level readLidarrPlanArtifact() before authorization checks
  -> executeLidarrApply() reads again at action admission
  -> readLidarrPlanHistory()
  -> claim/assert/mutate
  -> appendLidarrPlanHistory()
```

`packages/rfmedia-cli/src/cli.ts` registers the copy error formatters at startup.
`commands/lidarr.ts` instead catches Lidarr action failures and reads `.code` structurally in
`readLidarrFailureMetadata()` for human and JSON/YAML/CSV failure output.

### In-scope internal APIs

The signatures and return values should remain unchanged:

- `writePlanArtifact(path, plan, { overwrite? }): Promise<string>` supports create and explicit
  replacement and returns the resolved target path.
- `readPlanArtifact(path): Promise<CopyPlanV1>` returns a validated, checksum-verified canonical
  plan; absence is a blocking `PlanArtifactError` with `PLAN_IO`.
- `writeLidarrPlanArtifact(path, plan): Promise<string>` is create-only and maps an existing target
  to `LIDARR_PLAN_EXISTS`.
- `readLidarrPlanArtifact(path): Promise<LidarrStoredMutationPlan>` validates all supported v1/v2/v3
  plan families and treats absence as `LIDARR_PLAN_IO`.
- `appendLidarrPlanHistory(record, historyPath?): Promise<void>` is blocking despite its name: it
  reads, validates, compacts, and atomically replaces the complete per-plan JSONL document.
- `readLidarrPlanHistory(planId, checksum, historyPath?): Promise<record[]>` returns `[]` when the
  file or its parent does not exist.

### Complete production caller inventory for persistence exports

`plan.ts` persistence is concentrated in `actions/copy-plan.ts`: generation calls
`writePlanArtifact()` and `prunePlans()`; apply calls `readPlanArtifact()`,
`findPlanApplications()`, and `appendPlanAudit()`. `getDefaultPlanDir()` is additionally consumed by
the Lidarr output-path helpers in `actions/lidarr/plan.ts`, `plan-artist-profiles.ts`,
`plan-artist-tags.ts`, and `plan-artist-delete.ts`, by `lidarr/plan-engine.ts` for history/claims, and
by `lidarr/profile-preset-persistence.ts`.

`writeLidarrPlanArtifact()` is called by the production producers in:

- `actions/lidarr/plan.ts`
- `actions/lidarr/plan-albums.ts`
- `actions/lidarr/plan-album-edit.ts`
- `actions/lidarr/plan-album-delete.ts`
- `actions/lidarr/plan-artist-add.ts`
- `actions/lidarr/plan-artist-profiles.ts`
- `actions/lidarr/plan-artist-tags.ts`
- `actions/lidarr/plan-artist-delete.ts`
- `actions/lidarr/plan-track-filter.ts`

`readLidarrPlanArtifact()` is called by `actions/lidarr/apply.ts` and dynamically by
`commands/lidarr.ts`. `readLidarrPlanHistory()` is called by `apply.ts`,
`apply-track-filter-execution.ts`, and `apply-artist-add.ts`. Direct history writes originate in
`apply.ts`, `apply-track-filter-execution.ts`, `apply-artist-add.ts`, and
`apply-album-mutation-execution.ts`; apply entry/deferred-replay modules receive the same writer as
a callback through their existing typed contexts.

`acquireLidarrPlanClaim()` remains in `plan-engine.ts` but was migrated by #304. It is not an I/O
migration target here; its `translateClaimIoFailure()` family is the nearest precedent for keeping
`SecureStoreError` behind Lidarr-domain errors.

## Persistence and Filesystem Surface

### Copy-plan artifacts

- Default directory: `${RFMEDIA_PLAN_DIR:-~/.config/rfmedia/plans}`.
- Automatic filename: `plan-<compact timestamp>-<first 8 plan-id chars>.json`; `--plan-output`
  selects an explicit path.
- Payload: canonical pretty JSON plus one trailing newline, capped by
  `COPY_PLAN_MAX_BYTES` (10 MiB), with `rfmedia.copy-plan.v1` checksum semantics unchanged.
- Published mode is `0o600`; the current copy writer force-restricts its parent to `0o700`,
  including a pre-existing permissive directory.
- `validateArtifactPath()` must remain in front of shared path resolution because it rejects an
  explicit `..` segment before `resolve()` normalizes it away.
- The writer's `overwrite: false` path must remain `PLAN_EXISTS`; `overwrite: true` must still
  replace an existing regular non-symlink target. Shared create and replace writers have different
  prerequisites, so this needs a create/replace adapter rather than one unconditional call.
- `prunePlans()` is directory maintenance, not document publication. It scans only
  `plan-*.json`, keeps the newest 50 by mtime, preserves audit/unmanaged files, and swallows
  concurrent `ENOENT` from both `stat` and `unlink`.

### Lidarr plan artifacts

- Default output paths also live under `getDefaultPlanDir()` and are selected by each producer.
- Payloads are canonical v1/v2/v3 JSON plus a trailing newline, capped at
  `LIDARR_PLAN_MAX_BYTES` (10 MiB), private `0o600`, and create-only.
- Existing caller-owned safe parents are not chmod-ed. A `0o750` parent is accepted and its mode is
  preserved; a group/other-writable final parent is rejected.
- `createPrivateFileAtomically()` matches the existing `link()` no-clobber publication model and
  adds shared temporary-name cleanup plus parent-directory durability. Its
  `SECURE_STORE_VERSION_CONFLICT` must translate to `LIDARR_PLAN_EXISTS`.

### Lidarr per-plan history

- Default directory: `${RFMEDIA_PLAN_DIR}/lidarr-history`.
- Filename: `<plan UUID>-<64 checksum hex chars>.jsonl`; `historyPath` is an internal test/embedding
  override, not a CLI option.
- The file is a bounded `0o600` document, not an append-only log. Every call rebuilds the latest
  authoritative state per entry, validates identity consistency, writes one trailing newline, and
  replaces the old inode.
- Existing history supplies the `FileIdentity` required by
  `replacePrivateFileAtomically()`; first history uses `createPrivateFileAtomically()`.
- Publication must remain blocking through the containing-directory sync. The artist-add test
  proves remote dispatch cannot start until the history directory sync completes.

### Missing-file behavior is operation-specific

`readBoundedPrivateFile()` returns `undefined` for a missing file or parent. The current local
reader throws raw `ENOENT`, and three `plan-engine.ts` callers intentionally interpret it
differently:

| Caller                      | Existing meaning of missing input       | Required shared-reader adaptation                       |
| --------------------------- | --------------------------------------- | ------------------------------------------------------- |
| `readLidarrPlanArtifact()`  | Blocking `LIDARR_PLAN_IO`               | Convert `undefined` to the existing artifact I/O error. |
| `appendLidarrPlanHistory()` | No prior history; create a new document | Select the shared create writer.                        |
| `readLidarrPlanHistory()`   | Valid empty history, return `[]`        | Return `[]` directly.                                   |

The same distinction exists for copy plans: `readPlanArtifact()` must convert `undefined` to
`PLAN_IO`, while the advisory audit reader separately treats absence as `[]`.

### Shared-reader permission ordering

`readBoundedPrivateFile()` defaults to `"owner-only"`, while #321's `"allow-foreign-read"` accepts
foreign read bits but rejects foreign write/execute bits (`mode & 0o033`). Plan adapters select the
latter because tests create `0o644` fixtures with plain `writeFile()` for oversize, malformed,
checksum, and validation cases. The migration must preserve the domain result (`*_TOO_LARGE`,
`*_MALFORMED`, checksum mismatch, or validation error) without admitting writable/executable
foreign modes. This is a bounded reader-policy decision, not permission to update those fixtures
or weaken the public tests.

### Error translation boundary

No `SecureStoreError` may escape an in-scope public API. Translators must retain the original cause
but construct the existing domain class and operation-specific message.

| Shared/raw outcome                                      | Copy-plan result   | Lidarr result                 |
| ------------------------------------------------------- | ------------------ | ----------------------------- |
| Unsafe path/symlink/hostile parent                      | `PLAN_UNSAFE_PATH` | `LIDARR_PLAN_UNSAFE_PATH`     |
| Too large                                               | `PLAN_TOO_LARGE`   | `LIDARR_PLAN_TOO_LARGE`       |
| Create/version conflict                                 | `PLAN_EXISTS`      | `LIDARR_PLAN_EXISTS`          |
| Missing artifact                                        | `PLAN_IO`          | `LIDARR_PLAN_IO`              |
| Missing history                                         | Not applicable     | `[]` on read; create on write |
| Raw/unclassified `ENOSPC`, `EIO`, `EROFS`, or other I/O | `PLAN_IO`          | `LIDARR_PLAN_IO`              |

Malformed JSON, allowlist/exact-schema validation, and checksum mismatches remain local domain
logic after the bounded read. For copy plans, preserving the concrete `PlanArtifactError` instance
is mandatory: `error-formatters.ts` uses `instanceof`, and its checksum arm adds the tamper warning
and regenerate command. `copy-plan.test.ts` also pins `{ name: "PlanArtifactError", code: ... }`.

## External Services

- **Lidarr:** no endpoint, API-key, scheduler, retry, request, or generated-client change. The
  history writer remains immediately before/after existing remote mutation boundaries.
- **Plex and filesystem copy operations:** no provider or copy semantics change. Copy plans still
  freeze local review data and replay through the existing album/filter actions.
- **SQLite deferred-intent store:** no schema or query change. Lidarr history remains a separate
  filesystem durability boundary coordinated with the already-migrated plan claim.
- **No new service:** Docker, MCP, GitHub, networking, and authentication are unaffected.

## Internal Services and Data Flow

```text
copy plan generation
  -> local canonicalization/checksum
  -> copy-domain storage adapter
  -> secure-store create/replace writer

copy plan apply
  -> copy-domain bounded-read adapter
  -> validate/checksum/staleness
  -> existing copy dispatch
  -> excluded appendPlanAudit()

Lidarr producer
  -> local seal/validation/checksum
  -> Lidarr-domain create adapter
  -> secure-store create writer

Lidarr apply
  -> Lidarr-domain bounded-read adapter
  -> local exact-schema/checksum checks
  -> read history (undefined means [])
  -> already-shared claim lock
  -> mutation/deferred replay
  -> history create-or-replace adapter
```

The important layering is domain serialization and validation outside, shared filesystem mechanics
inside, and domain error translation at every call boundary. Callers should continue importing
`plan.ts` or `plan-engine.ts`; they must not import secure-store or handle shared codes themselves.

## Configuration

- `RFMEDIA_PLAN_DIR` remains the only operator-facing base-directory seam.
- Existing `--plan-output` and Lidarr producer output options keep their current path behavior.
- `historyPath` and `claimDirectory` remain TypeScript action/test overrides; neither becomes CLI,
  YAML, or environment configuration.
- No new permission, size, temporary-name, fsync, overwrite, or reader-policy flag should be added
  to the public CLI.
- Bash, Zsh, and Fish completion templates require no edits because no option changes.

## Integration Points and Gotchas

- **Keep `appendPlanAudit()` excluded:** it requires one kernel `write()` under
  `O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW`; secure-store only creates or replaces complete
  documents. It must still chmod the file to `0o600`, swallow every failure, and emit at most the
  existing single warning containing the raw cause (the test pins `audit ledger` and `EACCES`). Its
  directory preparation may reuse shared path machinery, but the append operation and
  non-blocking contract remain local.
- **Keep audit lookup advisory:** `findPlanApplications()` returns `[]` for missing/unreadable
  ledgers and logs only non-`ENOENT` failures. It must never acquire blocking artifact semantics.
- **Do not replace copy path validation:** `resolveSecurePath()` accepts a normalized-away `..`;
  `validateArtifactPath()` rejects the original segment on read and write.
- **Do not change the copy parent contract:** the current writer tightens a pre-existing permissive
  directory to `0o700`; shared `prepareSafeParent()` deliberately rejects rather than repairs.
  Calling the shared writer before that compatibility step breaks the umask-`002` test path.
- **Preserve read classification order:** a new shared permission error must not replace the
  expected size, malformed, validation, or checksum result for legacy/plain fixtures.
- **Choose create versus replace explicitly:** copy overwrite and Lidarr history need both shared
  writers; Lidarr artifacts are create-only. Treating every write as replace loses first-create;
  treating every write as create loses overwrite/history updates.
- **Map unmapped raw errors:** `rethrowAsSecureStoreError()` deliberately rethrows `ENOSPC`, `EIO`,
  and `EROFS`. Every adapter needs a final raw-error arm so machine output retains `PLAN_IO` or
  `LIDARR_PLAN_IO`.
- **Preserve invalid-path redaction:** Lidarr invalid input currently has `planPath: undefined` and
  does not echo terminal-control input. Validate with the existing domain resolver before shared
  calls or translate without copying shared remediation/path text.
- **Keep serialization outside secure-store:** canonical key order, trailing newline, schema
  versions, checksums, history compaction/order, and the copy snapshot are public compatibility
  surfaces, not storage concerns.
- **Import from the barrel:** all new uses belong on `secure-store/index.ts`; no deep import is a
  supported integration boundary.
- **Claim lock is already shared:** avoid rewriting `acquireLidarrPlanClaim()` or its public
  `LidarrPlanClaim` callback contract while migrating the neighboring persistence code.

## Verification Boundaries

The issue requires unmodified focused suites under both ordinary and permissive umasks. The most
important assertions are:

- `lib/plan.test.ts`: `0o600` file, forced `0o700` directory, no stranded stage, overwrite,
  explicit `..` rejection, size/malformed/checksum codes, missing `PLAN_IO`, pruning races, and
  exact audit degradation behavior.
- `lib/lidarr/plan-engine.test.ts`: v1/v2/v3 round trips, `0o600`, unchanged `0o750` parent,
  create-only conflict, symlink rejection, mode-independent size/checksum/validation results,
  history compaction, missing history, and directory-sync-before-dispatch.
- `lib/error-formatters.test.ts` and `actions/copy-plan.test.ts`: concrete copy error class/name,
  stable codes, checksum guidance, and hard corruption remaining non-overridable.
- `lib/secure-store/secure-store.test.ts`: shared reader/writer behavior remains canonical rather
  than being weakened globally without explicit coverage.
- `lib/__snapshots__/plan.test.ts.snap`: byte-identical output.

No completion templates should change. The package architecture check, typecheck, build, the two
focused suites under umask `022` and `002`, and the repository `test:run` path are the appropriate
integration gates.

## Relevant Docs

- [Issue #305](https://github.com/yandy-r/rfmedia-apps/issues/305)
- `docs/plans/issue-288-secure-store-migration/design.md`: predecessor migration decisions and the
  original deferral evidence.
- `docs/plans/issue-304-claim-lock-secure-store/design.md`: completed claim-lock adapter and error
  translation precedent.
- `docs/plans/issue-304-claim-lock-secure-store/research-integration.md`: post-#304 caller and claim
  boundary map.
