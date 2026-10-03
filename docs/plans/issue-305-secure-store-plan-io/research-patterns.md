# Issue 305 Secure-Store Plan I/O Research Patterns

**Implementation fixture note:** Ambient umask `002` made plain fixtures `0664` inside `0775`
parents, contradicting the non-mutating foreign-write rejection contract. Fixture setup now
declares the intended `0644`/`0700` modes explicitly; assertions, payloads, and snapshots do not
change.

> **Superseding reader-policy note:** Corrective issue #321 implements
> `"owner-only" | "allow-foreign-read"`, shipped by PR #326 as `cda0b106`.
> `"allow-foreign-read"` accepts foreign read bits such as ordinary `0o644`, but rejects foreign
> write or execute bits (`mode & 0o033`). Issue #305 must reuse that named policy; the new shared
> design work is limited to descriptor-validated final-parent hardening and writer propagation.

## Overview

Issue #305 is a delete-and-delegate migration with two domain adapters: keep copy-plan and Lidarr
serialization, validation, path policy, and error taxonomies local while moving reusable parent
preparation, bounded reads, and atomic publication into `secure-store`. The difficult contracts are
intentional compatibility points: plan artifacts may be read after ordinary `writeFile` creates
them as `0o644`, copy-plan hardens its leaf directory to `0o700`, Lidarr preserves an existing safe
parent's mode, and every shared or raw failure must be translated before it crosses a public API.

## Relevant Files

- `packages/rfmedia-cli/src/lib/plan.ts`: copy-plan path validation, directory hardening, bounded
  artifact read, create/overwrite write routing, audit append/read, and pruning.
- `packages/rfmedia-cli/src/lib/plan.test.ts`: real-filesystem compatibility suite plus the only two
  filesystem module mocks relevant to this migration.
- `packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap`: byte-stable canonical copy-plan
  serialization; it must remain byte-identical.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Lidarr plan/history serializers, local safe
  walk, bounded reader, create-only artifact writer, whole-document history replacement, and the
  existing claim-lock error adapter.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`: real-filesystem tests for artifact and
  history modes, permissive fixtures, missing history, directory durability, and pinned legacy
  bytes.
- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`: canonical safe-parent walk, file/parent
  identity checks, and sync/async bounded private readers.
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`: canonical create-versus-replace writers,
  mandatory post-open chmod, staging cleanup, and directory fsync.
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts`: shared error taxonomy, raw-errno mapping,
  and the rule that unmapped errnos remain raw.
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`: supported barrel; production consumers must
  not deep-import secure-store submodules.
- `packages/rfmedia-cli/src/lib/adapters/plex/credential-store.ts`: clearest domain-adapter example,
  including a total code map, read snapshots, and create/replace routing.
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`: closest Lidarr translator and
  create-then-replace journal precedent.
- `packages/rfmedia-cli/src/lib/errors.ts`: exact `PlanArtifactError`, `PlanValidationError`,
  `LidarrPlanArtifactError`, and `LidarrPlanValidationError` public shapes.
- `packages/rfmedia-cli/src/lib/error-formatters.ts`: proves why `PlanArtifactError` identity and
  `PLAN_CHECKSUM_MISMATCH` must survive the migration.

## Architectural Patterns

- **Domain adapter over shared filesystem mechanics:** `credential-store.ts` delegates every path
  walk, bounded read, lock, and atomic publication, but parses its own document and maps
  `SecureStoreError` to `PlexAuthError`. `profile-preset-persistence.ts` does the same for Lidarr
  journals. Follow that boundary: shared code owns filesystem safety; `plan.ts` and
  `plan-engine.ts` retain domain serialization, validators, checksums, and public errors.
- **Compatibility policies must be explicit, not hidden weakening:** before #321,
  `readBoundedPrivateFile` rejected any group/other access before checking size. Both plan modules
  historically read ordinary caller/test fixtures created as `0o644`; they do not silently chmod
  those files. Preserve the strict private-reader default for credentials and locks, and reuse
  `"allow-foreign-read"`, which retains `O_NOFOLLOW`, byte limits, inode checks, and parent rechecks
  while allowing foreign read bits only. Do not globally relax `readBoundedPrivateFile` or admit
  foreign write/execute bits.
- **Retain local path policy ahead of shared resolution:** `plan.ts:1020-1034` rejects a literal `..`
  segment before `resolve()` normalizes it away. Lidarr's `resolveLidarrStoragePath` rejects control
  and bidi characters without retaining or rendering the hostile path. Shared resolution is a
  safety layer, not a replacement for either domain rule.
- **Leaf-directory mode is a per-domain policy:** copy-plan deliberately converts the artifact
  directory to `0o700`, including an existing `0o775` leaf created under umask `002`. Lidarr creates
  missing directories as `0o700` but must not chmod an existing caller-owned safe directory; its
  test records the actual initial mode and asserts it is unchanged. Any shared parent API therefore
  needs an explicit harden-leaf versus validate-only policy. The hardening must occur inside the
  safe walk or on an already safely opened directory handle, not as an unsafe pathname chmod before
  validation.
- **Create and replace are separate atomic contracts:** `createPrivateFileAtomically` stages a
  sibling `0o600` file and publishes with `link`, so it cannot clobber. `replacePrivateFileAtomically`
  requires the expected `{dev, ino}` and publishes with `rename`, producing a new inode. Both chmod
  the open staging handle to `0o600`, which neutralizes permissive and restrictive umasks, fsync the
  file and directory, and clean the stage in `finally`.
- **Route each caller by its existing semantics:** Lidarr plan artifacts are create-only. Copy plans
  create when absent; `overwrite: false` must report `PLAN_EXISTS`, while `overwrite: true` replaces
  an existing regular file and also creates when absent. Lidarr history reads the entire per-plan
  document, reduces it to the latest valid record per entry, then atomically replaces it; despite
  the function name `appendLidarrPlanHistory`, it is a whole-document create/replace consumer.
- **No append migration:** copy-plan `appendPlanAudit` requires one `O_APPEND` write against the
  existing inode and is intentionally non-blocking. Secure-store has no append primitive. Keep the
  audit append and advisory scan local; only its reusable directory preparation may delegate. Do
  not reinterpret Lidarr history replacement as an append exception.
- **Durability belongs to the shared writer:** both shared writers wait for directory fsync after
  publication. This preserves the Lidarr test that blocks artist dispatch until the history
  directory sync finishes.

## Code Conventions

- Import all shared runtime values and types from `./secure-store/index.js` or
  `../secure-store/index.js`; `secure-store/index.ts` explicitly defines the barrel as the supported
  import path. Keep Node ESM `.js` suffixes and use `import type` for `FileIdentity` or other
  type-only dependencies.
- Keep the existing serializers immediately before publication: canonical object projection,
  `JSON.stringify(..., null, 2)`, and one trailing newline for artifacts; one JSON object per line
  plus a trailing newline for history. Shared writers receive final text and must not know plan
  schemas.
- Use fixed subject literals at the shared boundary and fixed local messages at the domain boundary.
  Never build a user-facing message from file bytes or a shared remediation string.
- Catches take `unknown`; preserve already-domain-typed errors before translating shared or raw
  failures. Retain the original failure as `cause` on a newly constructed domain error.
- Keep raw-errno checks narrow and structural. Shared `rethrowAsSecureStoreError` maps only
  `ELOOP`/`ENOTDIR` and `EACCES`/`EPERM`; `ENOSPC`, `EIO`, `EROFS`, `ENOENT`, and other unmatched
  errnos intentionally remain raw so the domain translator can classify them faithfully.
- Do not duplicate the safe-parent interfaces, identity comparer, walk, opened-file assertion,
  directory sync, staging-name construction, or cleanup loop in either plan module. Add any needed
  compatibility option/helper in secure-store and export it through the barrel.
- Keep copy-plan's `validateArtifactPath` even after shared path preparation is adopted. It is not
  duplicate implementation: literal traversal rejection is a stricter domain contract.
- Preserve local error classes and fields exactly: `name`, `code`, `planPath`, and validation
  `detail`. A raw `SecureStoreError` escaping would bypass `error-formatters.ts` and alter human and
  machine output.

## Error Handling

- **Translate at every domain boundary:** follow `credential-store.ts:93-102` for a total shared
  code map and `profile-preset-persistence.ts:119-168` for the required explicit
  non-`SecureStoreError` fallback. TypeScript cannot prevent a raw `ENOSPC` code from leaking into
  command output; the fallback must always construct the site's `*_IO` error.
- **Translation is operation-aware:** do not force one global map where current semantics differ.
  Creation conflicts become `PLAN_EXISTS` or `LIDARR_PLAN_EXISTS`; shared size failures become
  `PLAN_TOO_LARGE` or `LIDARR_PLAN_TOO_LARGE`; symlink/non-directory/path-identity failures remain
  the relevant `*_UNSAFE_PATH`; remaining shared codes and raw I/O failures become `*_IO` unless a
  narrower existing contract says otherwise.
- **Preserve domain errors first:** malformed JSON remains `PLAN_MALFORMED` or
  `LIDARR_PLAN_MALFORMED`; checksum failures remain exact checksum codes; allowlist/schema failures
  remain `PlanValidationError` or `LidarrPlanValidationError` with the resolved plan path. Shared I/O
  errors must never replace these post-read classifications.
- **Model absence explicitly:** the shared bounded reader returns `undefined` for a missing file or
  parent. Adapt that result per call site: missing copy/Lidarr artifact is an existing `*_IO`
  failure, missing Lidarr history returns `[]`, and missing history during persistence selects the
  create path. Never destructure a possibly undefined read and accidentally turn absence into a
  `TypeError`.
- **Preserve size precedence for permissive fixtures:** an oversized `0o644` Lidarr artifact must
  still produce `LIDARR_PLAN_TOO_LARGE`, not a permissions error; tampered and malformed `0o644`
  fixtures must reach checksum/schema validation. `"allow-foreign-read"` provides that precedence
  without chmod while still rejecting foreign write/execute bits.
- **Preserve invalid-path non-disclosure:** Lidarr's invalid control/bidi path test requires
  `planPath: undefined` and a message that does not contain the input. Validate locally before a
  shared error can retain even its sanitized path.
- **Keep advisory audit failures advisory:** `appendPlanAudit` swallows all failures after one
  warning; `findPlanApplications` returns `[]` on missing or unreadable ledgers and logs exactly one
  warning for non-`ENOENT`. Do not route these through a throwing artifact translator.

## Testing Approach

- Treat `plan.test.ts`, `plan-engine.test.ts`, `copy-plan.test.ts`,
  `error-formatters.test.ts`, and `src/lib/__snapshots__/plan.test.ts.snap` as unmodified
  compatibility tripwires. Editing them to accommodate the migration means behavior drifted.
- Run `plan.test.ts` under both umask `022` and `002`. The second run proves the copy-plan hardening
  policy accepts and tightens the default `0o775` parent in the symlink-parent test; both runs must
  still produce `0o700` directories and `0o600` artifacts.
- Run `plan-engine.test.ts` under both umasks as requested by the issue, even though the repository's
  normal root gate forces `022`. The existing-parent test captures its post-creation mode and asserts
  it is unchanged, making the assertion valid under restrictive ambient umasks.
- Preserve the plain-`writeFile` fixture cases: Lidarr checksum tamper, oversize-before-parse,
  malformed history validation, pinned legacy artifact, and pinned legacy history. These are the
  key regression tests for the bounded `"allow-foreign-read"` policy.
- Preserve atomic-publication tripwires: no sibling temp remains after a copy-plan round trip;
  duplicate writes return exact exists codes; artifacts/history end at `0o600`; Lidarr history fsync
  completes before dispatch; canonical and legacy bytes stay unchanged.
- Respect the two module-mock seams in `plan.test.ts`. The prune test dynamically mocks only
  `node:fs/promises.stat` to throw `ENOENT` for one managed file. The audit test dynamically mocks
  `open` for `audit.jsonl` and asserts exactly one warning containing both `audit ledger` and
  `EACCES`. Keep audit read/append routing local so shared wrapping or additional warning sites do
  not consume those expectations. Other persistence tests intentionally use the real filesystem.
- Extend `secure-store/secure-store.test.ts` only for genuinely new #305 policy surface. Preserve
  #321's focused proof that strict private reads remain the default and
  `"allow-foreign-read"` retains size, identity, and foreign-write/execute protection. Add only the
  handle-based, umask-independent final-parent hardening and create/replace propagation coverage.
- Verification commands from issue #305:

  ```bash
  cd packages/rfmedia-cli
  umask 022 && env -u FORCE_COLOR npx vitest run src/lib/plan.test.ts
  umask 002 && env -u FORCE_COLOR npx vitest run src/lib/plan.test.ts
  umask 022 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts
  umask 002 && env -u FORCE_COLOR npx vitest run src/lib/lidarr/plan-engine.test.ts
  npm run typecheck
  npm run check:architecture
  npm run build
  cd ../..
  npm run test:run
  ```

- Completion evidence should include zero diffs for both existing test files and the snapshot, plus
  source searches proving neither plan module retains a safe-parent walk or atomic writer. Because
  no CLI option changes, audit Bash, Zsh, and Fish completion templates and record that no edit is
  required.

## Patterns to Follow

1. After the branch is refreshed onto PR #326, freeze hashes/diffs for the five protected
   full repo-relative paths: `packages/rfmedia-cli/src/lib/plan.test.ts`,
   `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`,
   `packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap`,
   `packages/rfmedia-cli/src/actions/copy-plan.test.ts`, and
   `packages/rfmedia-cli/src/lib/error-formatters.test.ts`. Then run the focused suites under the
   required umasks before implementation.
2. Reuse the settled `"allow-foreign-read"` surface and add only copy-plan leaf hardening; preserve
   strict credential/lock defaults and barrel-only imports.
3. In `plan.ts`, retain literal traversal validation and audit `O_APPEND`; replace the duplicate
   artifact walk/read/write mechanics with thin adapters. Route missing/create, exists/no-overwrite,
   and existing/overwrite to the correct shared writer while preserving exact Plan errors.
4. In `plan-engine.ts`, replace the local walk, reader, opened-file/parent assertions, sync helper,
   and staging writers. Route plan artifacts through create only; route history through create when
   absent and identity-guarded replace when present.
5. Keep serializers, JSON parsing, allowlist validators, checksum verification, history reduction,
   and all public return types unchanged. Translate shared and raw errors separately for artifact
   read, artifact write, history read, and history persistence where their absence/error semantics
   differ.
6. Run shared primitive tests first, then both unchanged domain suites under `022` and `002`, then
   formatter/copy-plan tests, typecheck, architecture, build, and the root test gate. Finish with
   byte-identity and source-duplication checks.

## Gotchas and Edge Cases

- A permissive `0o644` fixture is not evidence that the plan file should be repaired. It is evidence
  that plan artifacts historically had no read-time private-mode requirement.
- `mkdir(..., { mode: 0o700 })` does not tighten an existing directory. Copy-plan requires an
  explicit safe handle chmod; Lidarr explicitly forbids that same behavior for existing parents.
- The `mode` argument to `open(..., O_CREAT, 0o600)` is filtered by umask and ignored for an existing
  file. Shared staging writers correctly call `handle.chmod(0o600)` before writing/publishing.
- Pathname `chmod` after rename follows symlinks. Delegation should eliminate the copy-plan writer's
  current post-rename pathname chmod in favor of the shared staging-handle chmod.
- `createPrivateFileAtomically` uses `link` because rename would clobber; replacement uses `rename`
  because it must swap the target atomically. Do not emulate both contracts with preflight
  `lstat` plus unconditional rename.
- Temporary names may change without affecting snapshots, but successful and failed writes must not
  strand a second copy. Shared writers clean stages in `finally`; crash leftovers are a separate
  orphan-sweep concern.
- The copy-plan snapshot observes serialized bytes only. More fragile checks are exact directory
  entries, modes, error classes/codes, traversal rejection, and the audit warning call count.

## Relevant Docs

- GitHub issue #305: <https://github.com/yandy-r/rfmedia-apps/issues/305>
- `docs/plans/issue-288-secure-store-migration/design.md`: original verified deferral analysis and
  secure-store invariants.
- `docs/plans/issue-304-claim-lock-secure-store/research-patterns.md`: completed plan-engine adapter
  and error-translation precedent.
- `docs/lefthook-usage.md`: root test gate normalizes umask `022` and unsets `FORCE_COLOR`.
