# Issue 305 Secure-Store Plan I/O Documentation Research

**Implementation fixture note:** Ambient umask `002` made plain fixtures `0664` inside `0775`
parents, contradicting the non-mutating foreign-write rejection contract. Fixture setup now
declares the intended `0644`/`0700` modes explicitly; assertions, payloads, and snapshots do not
change.

> **Superseding reader-policy note:** Corrective issue #321 already implements
> `"allow-foreign-read"`, shipped by PR #326 as `cda0b106`. It accepts foreign read bits but
> rejects foreign write/execute bits (`0o033`), while strict `"owner-only"` remains the default.
> Issue #305 documentation must describe reuse of that policy and only a new final-parent policy.

## Overview

Issue [#305](https://github.com/yandy-r/rfmedia-apps/issues/305) is an internal migration of copy
plan and Lidarr plan/history filesystem mechanics onto `src/lib/secure-store/`. Documentation must
preserve the existing user contract, retire internal statements that these implementations remain
local, reconcile the living roadmap/deferral ADR, and explicitly coordinate the publication
hardening overlap with [#306](https://github.com/yandy-r/rfmedia-apps/issues/306).

## Architecture Docs

- `docs/plans/issue-288-secure-store-migration/design.md` is the primary architectural source for
  this follow-up. Read **Decision summary**, **Shared surface changes**, **Site 1**, **Site 2**,
  **Out of scope**, **Test strategy**, and **Completion checks**. It records why #288 migrated only
  constants in `plan.ts` and `lidarr/plan-engine.ts`: reader permission/size precedence, raw-errno
  callers, copy-plan leaf hardening under `umask 002`, traversal rejection, create/overwrite
  differences, and the absent append primitive.
- `docs/plans/issue-288-secure-store-migration/plan.md` is the detailed implementation history.
  Commits 1–3 document the shared barrel and the two constants-only migrations; commit 6 records
  the #304–#308 split. Its `plan.ts` section explicitly defers the post-rename path `chmod` to #306
  and treats the snapshot and `umask 002` run as abort gates.
- `docs/plans/issue-304-claim-lock-secure-store/design.md` is the completed prerequisite and the
  closest `plan-engine.ts` adapter precedent. Its **Error Translation** table and compatibility
  decisions show how shared failures are translated without exposing `SecureStoreError.path` or
  `.remediation`; its non-goals assign plan/history walks, readers, hardeners, and writers to #305.
- `docs/plans/issue-304-claim-lock-secure-store/parallel-plan.md` is the final #304 execution plan.
  Use its frozen-suite, barrel-import, completion-audit, and closeout approach as precedent.
  `prototype-plan-evidence.md` is explicitly superseded and is historical evidence only.
- `docs/plans/issue-304-claim-lock-secure-store/research-docs.md` inventories the prior
  documentation boundary and explains why public plan/apply docs remained unchanged. Its line
  anchors are historical; the current source and #304 design are authoritative.
- `docs/internal/plex-jwt-deferrals.md`, sections 8–9, is the standing ADR for the full sequence.
  It records #288's shipped delegation, #304's shared-lock completion, #305's remaining plan I/O,
  and the independent #306–#308 defects.
- `docs/plans/issue-305-secure-store-plan-io/research-architecture.md`,
  `research-integration.md`, and `research-patterns.md` are the complementary current-workstream
  reports. They establish the boundary: shared filesystem mechanics inside, domain serialization,
  checksums, history reduction, missing-file meanings, and public errors outside.
- `docs/architecture/overview.md` and `docs/architecture/data-flow.md` provide broad CLI layering
  orientation but contain no secure-store or plan-artifact contract. No issue-specific update is
  required there.

## API/User Docs

- `packages/rfmedia-cli/README.md`, **Copy → Plan / Apply**, is the user contract for `plan.ts`.
  It documents managed/custom paths, create/apply/check behavior, hard failures for malformed,
  oversized, or symlinked artifacts, `RFMEDIA_PLAN_DIR`, retention, and the non-blocking JSONL audit
  ledger. These behaviors and error classes must remain unchanged.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`, especially **Review, Check, and Apply**,
  **Write Verification and Recovery**, and **Artifact and Secret Handling**, is the authoritative
  Lidarr operator guide. It promises private `0700`/`0600` storage, bounded no-follow reads, atomic
  no-overwrite plan creation, durable history before later admissions, conservative claims, and
  legacy artifact compatibility.
- `packages/rfmedia-cli/README.md`, **Development → Lidarr Mutation Plan/Apply**, is the condensed
  command reference and links to the feature guide. It repeats the dry-run, claim-free check,
  durable-history, and recovery behavior but does not expose storage implementation details.
- `docs/README.md` indexes the Lidarr plan/apply guide. No new feature page or index entry is needed
  because #305 adds no command, option, schema, configuration key, or environment variable.
- GitHub issue [#306](https://github.com/yandy-r/rfmedia-apps/issues/306) is the overlapping
  publication-hardening contract: replace `plan.ts`'s post-rename pathname `chmod` with pre-close
  descriptor hardening and prove `0600` under restrictive `umask 0277`. Delegation to the shared
  atomic writer performs that exact change, so #305's closeout must state whether #306 is subsumed
  and close/update it accordingly.
- `docs/features/plan-apply-workflow.md` is for `rfapps`, not `rfmedia` copy or Lidarr plans. It is a
  homonymous but unrelated guide and should not be edited for #305.

## Development Guides

- The GitHub issue #305 body is the most concise implementation contract: preserve domain errors,
  permissive fixture behavior, copy-plan directory hardening, the snapshot, and unmodified plan
  suites; do not migrate `appendPlanAudit()` publication.
- `docs/lefthook-usage.md` explains that the root `npm run test:run` normalizes to `umask 022` and
  unsets `FORCE_COLOR`. Direct focused runs must set their umask explicitly; #305 additionally
  requires the `umask 002` compatibility run and #306 overlap warrants `0277` coverage.
- `packages/rfmedia-cli/README.md`, **Development → Testing**, documents focused Vitest,
  typechecking, and package build commands. The issue-specific gate list is stricter and remains
  authoritative.
- `CLAUDE.md`/`AGENTS.md` require Markdown lint compatibility and completion parity when CLI options
  change. #305 changes no CLI surface, so Bash, Zsh, and Fish templates should remain unchanged,
  with the audit result recorded in the PR.
- `.github/pull_request_template.md` requires exact verification results, a documentation decision,
  risk/rollback, and `Closes #305`. If #306 is subsumed, include its closure/link explicitly rather
  than leaving the overlap implicit.
- `ROADMAP.md`, **Current focus**, **Sprint 2 — secure-store completion**, the low-priority backlog,
  **Secure artifact I/O**, and **Maintenance**, is the live completion record. It currently orders
  #305 before #306–#308 and says #288/#304 shipped.
- `docs/roadmap-archive.md` records #288/PR #309. Its maintenance rule says shipped narrative moves
  here only when the full sprint closes, so #305 alone should not be added yet.

## README/Inline Docs

- `packages/rfmedia-cli/src/lib/secure-store/index.ts` is the supported API documentation and
  barrel. Its module JSDoc names safe paths, bounded readers, atomic writers, locks, strict defaults,
  and barrel-only imports; it currently says the remaining plan persistence stays local for #305.
  Any new policy types/options must be exported here, never deep-imported by plan modules.
- `packages/rfmedia-cli/src/lib/secure-store/paths.ts` documents `prepareSafeParent()`,
  `readBoundedPrivateFile()`, `SafeParent`, `FileIdentity`, strict private-mode checking, identity
  reassertion, and the no-silent-repair rule. Its strict default must remain true for credentials,
  locks, and preset journals. Issue #305 reuses #321's explicit `"allow-foreign-read"` policy and
  adds only leaf hardening.
- `packages/rfmedia-cli/src/lib/secure-store/atomic.ts` documents same-directory staging,
  `createPrivateFileAtomically()` versus identity-guarded `replacePrivateFileAtomically()`, mandatory
  handle `chmod(0600)`, cleanup, and directory fsync. These comments define the #306 overlap and the
  umask-independent publication guarantee.
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts` documents the stable shared taxonomy and the
  important partial mapping rule: `ELOOP`/`ENOTDIR` and `EACCES`/`EPERM` are wrapped, while
  `ENOSPC`/`EIO`/`EROFS` remain raw. Domain adapters therefore need explicit raw-I/O fallback arms.
- `packages/rfmedia-cli/src/lib/plan.ts` has accurate public JSDoc for hardened copy-plan I/O,
  `writePlanArtifact()`, `readPlanArtifact()`, and `appendPlanAudit()`. Preserve the documented
  serializer, error codes, overwrite behavior, and audit's single `O_APPEND` write plus
  warning-only failure contract; only implementation-specific local-I/O prose should change.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` documents hardened artifact/history/claim
  storage, create-only plan publication, bounded verified reads, blocking whole-document history
  persistence, missing-history `[]`, and the migrated claim. Public function JSDoc remains valid if
  the migration is behavior-preserving; local-helper comments disappear with the duplicate code.
- The root `README.md` is platform-level and contains no plan storage contract. The package README
  and Lidarr feature guide are the only README/user documents that materially describe these paths.
- `packages/rfmedia-cli/CHANGELOG.md` is historical feature release documentation and contains no
  secure-store contract. A behavior-preserving internal chore does not require a changelog entry;
  if #306 is closed as a hardening fix, note that decision in the PR/release process rather than
  rewriting historical entries.

## Must-Read Documents

Read in this order before implementation:

1. GitHub issue #305 and `docs/plans/issue-288-secure-store-migration/design.md` for exact scope,
   blockers, protected tests, and `appendPlanAudit()` exclusion.
2. `docs/plans/issue-304-claim-lock-secure-store/design.md` for the completed prerequisite and
   domain-error translation precedent.
3. `docs/internal/plex-jwt-deferrals.md` sections 8–9 for the authoritative #288–#308 decision
   history.
4. `src/lib/secure-store/index.ts`, `paths.ts`, `atomic.ts`, and `errors.ts` JSDoc for the current
   shared API and strict defaults.
5. `src/lib/plan.ts` and `src/lib/lidarr/plan-engine.ts` I/O JSDoc plus
   `src/lib/errors.ts` for the public domain contracts that must survive delegation.
6. `packages/rfmedia-cli/README.md` **Plan / Apply** and
   `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` **Artifact and Secret Handling** for the
   operator-visible guarantees.
7. GitHub issue #306 and `ROADMAP.md` for publication-hardening overlap and closeout sequencing.
8. `docs/lefthook-usage.md` and `.github/pull_request_template.md` for verification/reporting.

## Documentation Gaps

### Required with the implementation

1. **Retire the #305 barrel deferral.** Update `secure-store/index.ts` module JSDoc to say copy and
   Lidarr artifact/history walks, bounded reads, and atomic document writers now delegate through
   the barrel. State explicitly that copy `appendPlanAudit()` remains local because it is an
   append-only, non-blocking ledger operation, not atomic whole-document publication.
2. **Correct stale secure-store history prose.** `paths.ts` and `atomic.ts` still describe
   `profile-preset-persistence.ts` as an untouched read-only reference even though #288 migrated it.
   `paths.ts` also says the plan modules each declare the shared path-length ceiling, although they
   now import it. Reword these comments to describe current consumers and provenance.
3. **Keep inline behavior docs, remove local-implementation claims.** Preserve `plan.ts` and
   `plan-engine.ts` public JSDoc, which describes correct observable contracts. Update or delete
   implementation-specific prose that says the stacks are locally ported/implemented once their
   helpers are removed. Do not weaken the `appendPlanAudit()` JSDoc.
4. **Reconcile the ADR.** In `docs/internal/plex-jwt-deferrals.md`, mark #305 resolved with its PR,
   replace the “remains local for #305” statement with what actually delegated, and retain the
   historical reasons for the #288/#304 split. Keep #307/#308 independent. For #306, record whether
   shared descriptor hardening subsumed it.
5. **Reconcile the living roadmap.** Remove closed issues from Sprint 2 and the low-priority table,
   recalculate the hardcoded count/summary, update Current Focus and **Secure artifact I/O**, and
   preserve the remaining order. Do not move #305 into `docs/roadmap-archive.md` until the full
   Sprint 2 exit criteria are met.
6. **Coordinate #306 rather than silently fixing it.** Shared atomic publication eliminates the
   pathname-`chmod` race and enforces `0600` under `0277`. Link #306 in the implementation/PR,
   report its verification, and close or rescope it; leaving the issue and ROADMAP row unchanged
   would make the documentation false.

### Explicitly no change when compatibility gates pass

- Do not rewrite the historical #288/#304 designs or completed plans; their deferral rationale is
  still valuable.
- Do not change copy/Lidarr command syntax, public feature guides, package/root README content, the
  docs index, config/environment docs, or completion templates. No user workflow or CLI surface
  changes.
- Do not change `src/lib/__snapshots__/plan.test.ts.snap`; it is compatibility evidence, not
  documentation to regenerate.
- Do not document or export an append primitive: `appendPlanAudit()` publication is excluded from
  #305, and Lidarr “append” history is whole-document create/replace rather than `O_APPEND`.
- Do not add #305 to the roadmap archive before Sprint 2 closes.
