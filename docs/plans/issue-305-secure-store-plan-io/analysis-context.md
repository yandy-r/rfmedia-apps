# Context Analysis: Issue 305 Secure-Store Plan I/O

> **Implementation fixture note:** Ambient umask `002` made plain fixtures `0664` inside `0775`
> parents, contradicting the non-mutating foreign-write rejection contract. Fixture setup now
> declares the intended `0644`/`0700` modes explicitly; assertions, payloads, and snapshots do not
> change.

## Executive Summary

Issue #305 is a behavior-preserving delete-and-delegate migration: copy-plan artifacts and Lidarr
plan/history documents retain their domain validation, serialization, checksums, overwrite rules,
and public errors while shared secure-store primitives take ownership of safe parent traversal,
bounded no-follow reads, private staging, identity checks, atomic publication, cleanup, and
directory durability. Corrective issue #321 already supplies the named `"allow-foreign-read"`
compatibility seam shipped by PR #326 as `cda0b106`; it accepts foreign read bits but rejects
foreign write/execute bits (`0o033`) while `"owner-only"` remains the default. Therefore, #305's
shared work is the copy-only final-parent hardening policy plus propagation through atomic
publication; the adapters reuse the existing reader policy.

## Architecture Context

- **System Structure**: `secure-store` is the filesystem-safety layer; `plan.ts` and
  `lidarr/plan-engine.ts` remain domain adapters above it. Production actions continue importing
  those domain modules, and all shared values and types flow through `secure-store/index.ts` rather
  than deep imports.
- **Data Flow**: Each adapter validates the original input path, constructs the exact current
  serialized bytes, selects shared create or identity-guarded replace publication, and translates
  every shared or raw failure back to its existing domain error. Reads delegate only the bounded
  filesystem operation before returning to local parsing, exact-schema validation,
  canonicalization, and checksum verification.
- **Integration Points**: Extend `secure-store/paths.ts` for explicit read and final-parent
  policies, export the surface from `secure-store/index.ts`, and keep atomic publication in
  `secure-store/atomic.ts`. Then independently replace the duplicate copy-plan and Lidarr
  persistence mechanics without changing their exported signatures or production callers.
- **Operation Routing**: Copy-plan creates when absent, rejects an existing target without
  `overwrite`, and replaces an identity-captured regular file with `overwrite`; Lidarr artifacts
  are create-only; Lidarr history creates when missing and replaces the complete JSONL document
  when present.
- **Intentional Exclusion**: `appendPlanAudit()` remains one local no-follow `O_APPEND` write with
  advisory failure handling. It may delegate safe parent preparation, but it must not be modeled
  as atomic whole-document publication.

## Critical Files Reference

- `packages/rfmedia-cli/src/lib/secure-store/paths.ts`: Add opt-in compatibility policies without
  weakening strict private reads or validate-only parent handling by default.
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts`: Reuse the canonical link-based create and
  identity-guarded rename writers; its open-handle `chmod(0o600)` also subsumes issue #306's
  publication hardening.
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts`: Shared codes are intentionally partial;
  unmapped filesystem errors such as `ENOSPC`, `EIO`, and `EROFS` remain raw and require domain
  fallback translation.
- `packages/rfmedia-cli/src/lib/secure-store/index.ts`: Supported barrel and module-level migration
  documentation; every new policy type/helper must be exported here.
- `packages/rfmedia-cli/src/lib/secure-store/secure-store.test.ts`: Add focused proof that strict
  defaults remain intact while each new opt-in policy preserves no-follow, size, identity, mode,
  and cleanup guarantees.
- `packages/rfmedia-cli/src/lib/plan.ts`: Preserve literal `..` rejection, copy serialization,
  overwrite decisions, and audit behavior while deleting its duplicate parent/read/write stack.
- `packages/rfmedia-cli/src/lib/plan.test.ts`: Protected compatibility suite for modes, traversal,
  overwrite, no temporary residue, error codes, pruning races, and exactly-once audit warnings;
  keep it unmodified.
- `packages/rfmedia-cli/src/lib/__snapshots__/plan.test.ts.snap`: Byte-level copy-plan contract;
  keep it unchanged rather than regenerating it.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Delete the duplicate persistence stack,
  generalize the existing claim-lock translation precedent, and route artifacts/history through
  shared readers and writers.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`: Protected compatibility suite for all
  artifact versions, permissive fixtures, parent-mode preservation, history reduction, missing
  history, durability ordering, and pinned legacy bytes; keep it unmodified.
- `packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`: Closest Lidarr example of
  local serialization plus shared create/replace and total domain error translation.
- `packages/rfmedia-cli/src/lib/adapters/plex/credential-store.ts`: Strongest precedent for
  barrel-only imports, captured identities, explicit create/replace routing, and exhaustive shared
  error mapping.
- `packages/rfmedia-cli/src/lib/errors.ts`: Authoritative public error classes, stable codes,
  `planPath`, and validation-detail shapes that must survive the migration.
- `packages/rfmedia-cli/src/lib/error-formatters.ts` and
  `packages/rfmedia-cli/src/actions/copy-plan.test.ts`: Downstream proof that concrete
  `PlanArtifactError` identity and checksum-specific behavior cannot be replaced by shared errors.
- `docs/plans/issue-288-secure-store-migration/design.md`: Architectural source for strict shared
  defaults, original deferrals, protected tests, and the append exclusion.
- `docs/plans/issue-304-claim-lock-secure-store/design.md`: Completed plan-engine adapter and error
  translation precedent.
- `docs/internal/plex-jwt-deferrals.md` and `ROADMAP.md`: Required closeout records for #305 and
  the overlapping #306 work.

## Patterns to Follow

- **Domain Adapter over Shared Mechanics**: Keep schema knowledge, canonical bytes, checksums,
  history reduction, and public errors in the domain module; pass only the final text/path/identity
  into secure-store, as in `lidarr/profile-preset-persistence.ts`.
- **Strict Default, Explicit Opt-In**: Preserve the current private-mode reader and validate-only
  parent behavior for every existing consumer. Plan adapters opt into only the compatibility rule
  they require; do not add a global relaxation or public CLI/config flag.
- **Descriptor-Based Leaf Hardening**: Copy-plan must safely open and identity-check only the final
  parent before changing it to `0o700`; do not chmod ancestors or use a pathname-based repair that
  can follow a swapped symlink. Lidarr must keep valid caller-owned modes such as `0o750` unchanged.
- **Local Path Gate before Shared Resolution**: Keep copy-plan's raw-segment traversal rejection and
  Lidarr's control/bidi redaction rules ahead of `resolveSecurePath()`, whose normalization and
  sanitized path retention have different semantics.
- **Create-versus-Replace Selection**: Use `createPrivateFileAtomically()` for absent targets and
  create-only Lidarr artifacts; use `replacePrivateFileAtomically()` only with the `{dev, ino}`
  captured from the observed copy artifact or history file.
- **Operation-Aware Absence**: Convert a shared `undefined` read to `PLAN_IO` or
  `LIDARR_PLAN_IO` for artifacts, `[]` for history reads, and the create branch for history writes.
- **Total Domain Translation**: Preserve already-typed domain failures, explicitly map every
  relevant `SecureStoreError` code, then map all unmatched raw failures to the existing domain I/O
  code with the original value as `cause`.
- **Durable Whole-Document History**: Despite its name, `appendLidarrPlanHistory()` validates,
  compacts, and atomically replaces the entire JSONL document; directory fsync remains blocking
  before later Lidarr dispatch.

## Cross-Cutting Concerns

- **Security**: Retain `O_NOFOLLOW`, parent and opened-file inode rechecks, owner and foreign-write
  validation, bounded `maximumBytes + 1` reads, same-directory private staging, cleanup in
  `finally`, and fsync of both the staged file and containing directory.
- **Compatibility**: Plan reads select `"allow-foreign-read"` so externally seeded `0o644` files
  reach their historical oversized, malformed, validation, and checksum classifications without
  chmod. Files with foreign write/execute bits remain rejected by `mode & 0o033`.
- **Error Stability**: No `SecureStoreError`, shared remediation, or hostile path text may cross a
  public plan API. Copy formatting relies on `instanceof PlanArtifactError`; Lidarr machine output
  relies on stable structural `.code` values and invalid-path redaction.
- **Byte Stability**: Canonical field order, supported schema versions, pretty JSON, JSONL ordering,
  history compaction, checksums, and trailing newlines stay outside secure-store. Temporary names
  and filesystem mechanics may change; artifact bytes may not.
- **Umask Independence**: Shared writers must retain descriptor `chmod(0o600)` under `0277`;
  copy-plan must end with a `0o700` leaf under `002`; Lidarr must preserve the actual mode of an
  existing safe parent under both `022` and `002`.
- **Concurrency and Durability**: Link-based creation prevents clobbering, replacement must reject
  a displaced expected inode, and no successful or failed path may strand a live staging file.
  The design assumes local-filesystem hard-link/rename and directory-fsync semantics, not a network
  filesystem CAS guarantee.
- **Documentation and Issue State**: Retire stale #305 deferral prose in the secure-store barrel
  and ADR, update the live roadmap from authoritative issue state, and explicitly close or rescope
  #306 because shared descriptor-hardening implements its core contract. User guides, changelog,
  public READMEs, and completion templates remain unchanged if compatibility gates pass.
- **Verification**: Keep both domain test files and the copy snapshot unmodified; add tests only for
  the new shared policies. Run the protected copy and Lidarr suites under `umask 022` and `002`, add
  the #306-relevant restrictive-umask proof, then run copy action/formatter coverage, typecheck,
  architecture, build, root `test:run`, formatting, Markdown lint, whitespace, the real pre-push
  path, and `graphify update .` from the repository root of the #305 feature worktree after source
  changes.

## Parallelization Opportunities

- The secure-store policy/API task is the foundation and must land first because both adapters and
  their tests depend on its final names and semantics.
- After that API is stable, copy-plan migration and Lidarr artifact/history migration can proceed
  independently: they modify different domain modules and focused suites while sharing only the
  barrel imports.
- Copy error-translation/formatter verification can run with the copy adapter task; Lidarr's
  generalized base translator and history absence routing belong with the Lidarr task to avoid
  overlapping edits in `plan-engine.ts`.
- Secure-store focused tests, copy-plan compatibility runs, and Lidarr compatibility runs are
  independent verification lanes once their corresponding code is ready; serialize the final
  typecheck/build/codegen and repository-wide gates if they share generated scratch state.
- ADR/barrel documentation and #306 coordination can be prepared alongside adapter work, but the
  final `ROADMAP.md` counts and issue closeout must wait for authoritative merge and live issue
  state.

## Implementation Constraints

- Do not change exported plan/history function signatures, CLI options, configuration, environment
  variables, file schemas, remote-service calls, generated clients, or database state.
- Do not remove `validateArtifactPath()` or replace it with normalized shared resolution; explicit
  traversal segments must continue to fail before filesystem access.
- Do not globally relax `readBoundedPrivateFile()`, silently repair legacy file modes, or change
  credentials, claims, locks, and preset-journal defaults.
- Do not harden existing Lidarr parents, and do not leave copy-plan's permissive final parent
  unchanged; the two policies are deliberately different.
- Do not collapse create and replace into a preflight-plus-unconditional rename, and do not publish
  copy-plan overwrite or history replacement without an expected target identity.
- Do not migrate audit publication, convert audit failures into blocking errors, or introduce a
  shared append primitive for this issue.
- Do not edit protected domain tests or snapshots to make the migration pass. Any required change
  there is evidence of behavioral drift and should stop implementation for review.
- Use the repository's Node 22 runtime via `mise exec`; run generated Lidarr/codegen-related gates
  serially and do not bypass the pre-push hook.

## Key Recommendations

- Freeze test/snapshot hashes and focused-suite results before implementation, then compare them
  after each adapter migration to prove the task deleted duplication without changing contracts.
- Reuse the named `"allow-foreign-read"` policy already implemented in `paths.ts`; design only the
  final-parent policy, default it to current validate-only behavior, and cover only the new seam at
  the shared layer.
- Generalize #304's Lidarr translation helper only enough to share common unsafe, permissions,
  too-large, and raw-I/O mapping; retain claim-specific busy/corrupt branches and operation-specific
  missing/conflict handling.
- Keep copy target inspection and Lidarr history identity capture explicit in their adapters so the
  create/replace choice is visible and reviewable rather than hidden inside a generic writer.
- Treat the migration as complete only when source searches show the duplicate safe-parent walks,
  bounded readers, staging writers, and directory-sync helpers are gone from both domain modules,
  while audit append and all domain serialization remain local.
- Record the no-change completion audit for Bash, Zsh, and Fish and reconcile #305/#306, the ADR,
  and the live roadmap as part of delivery rather than as optional follow-up work.
