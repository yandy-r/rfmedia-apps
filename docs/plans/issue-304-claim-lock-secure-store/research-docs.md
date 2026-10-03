# Issue 304 Claim-Lock Secure-Store Documentation Research

**Status:** Superseded pre-design artifact; retained for historical context and not the
implementation source of truth.
**Canonical design:** [`design.md`](../issue-304-claim-lock-secure-store/design.md)
**Canonical plan:** [`parallel-plan.md`](../issue-304-claim-lock-secure-store/parallel-plan.md)

Issue [#304](https://github.com/yandy-r/rfmedia-apps/issues/304) is an internal,
behavior-preserving migration of the Lidarr per-plan claim lock onto the canonical
`src/lib/secure-store/acquireExclusiveLock` primitive. The documentation work is correspondingly
narrow: preserve the existing operator contract, correct internal architecture statements that
would become false, and update the living roadmap when the issue closes.

## Architecture Docs

### Required reading

- `docs/plans/issue-288-secure-store-migration/design.md` is the architectural source of truth for
  this follow-up. Its **Site 2**, **Lock semantics**, **Out of scope**, **Test strategy**, and
  **Completion checks** sections establish the exact migration boundary and already decide
  `deadlineEpochMs: now()`, `maxAgeMs: null`, `SECURE_STORE_CORRUPT` to
  `LidarrPlanAlreadyRunningError`, and a separate `assertOwned()` adapter arm. It also explains why
  the remaining plan path walks and writers belong to dependent issue #305.
- `docs/internal/plex-jwt-deferrals.md`, especially sections 8 and 9, is the standing ADR/history
  for how `secure-store` became canonical. It records the claim-lock deferral, its three behavioral
  hazards, and the #304 to #308 follow-up chain.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`, especially **Review, Check, and Apply**,
  **Write Verification and Recovery**, and **Artifact and Secret Handling**, is the user-visible
  contract. It promises that dry-run acquires no claim, a lost claim stops admission, only one real
  process applies a plan, a live concurrent owner is rejected, and only a demonstrably stale owner
  is recovered. These statements must remain true without wording changes.
- `packages/rfmedia-cli/docs/features/lidarr-quality-presets.md`, **Lock and Journal Security**, is
  the closest shipped user-facing analogue. Its no-cross-host-steal and never-replace-a-live-owner
  guarantees explain why the already-migrated preset adapter passes `maxAgeMs: null`.
- `docs/plans/issue-304-claim-lock-secure-store/research-architecture.md`,
  `research-integration.md`, and `research-patterns.md` are the current workstream's complementary
  code-flow, integration, and implementation-pattern reports. They agree that the adapter boundary
  stays inside `plan-engine.ts` and that no action-layer signature changes.

### Supporting context

- `docs/architecture/overview.md` and `docs/architecture/data-flow.md` describe the monorepo's broad
  CLI command to action to library layering. They are useful orientation, but are too general to
  govern lock semantics and require no update for #304.
- `docs/reference/architecture-diagram.md` and the root `README.md` focus principally on the Docker
  service platform. They do not describe Lidarr plan claims and are not implementation inputs.
- Historical plans such as `docs/prps/plans/completed/lidarr-mutation-plan-apply.plan.md` and
  `docs/plans/223-lidarr-album-suite/design.md` explain why the claim exists, but the shipped feature
  guide and current tests are more authoritative for this refactor.

## API Docs

The relevant API documentation is inline TypeScript/JSDoc rather than a generated API site.

- `packages/rfmedia-cli/src/lib/secure-store/index.ts:1-18` defines the module boundary: hardened
  owner-only documents, safe paths, bounded reads, atomic writers, and the canonical `link()`-based
  lock. It requires consumers to import through the barrel rather than deep-import submodules.
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts:79-155` documents
  `SecureStoreLockRecord`, `SecureStoreLock`, and `SecureStoreLockOptions`. The load-bearing details
  are full-record plus inode ownership, idempotent owner-safe release, a required deadline,
  `maxAgeMs: null` disabling age theft, and optional caller binding.
- `packages/rfmedia-cli/src/lib/secure-store/lock.ts:364-390` documents
  `acquireExclusiveLock()`: one same-host-dead-pid or age-based steal before deadline handling,
  immediate corruption failure, jittered waiting, and its typed failure set. A deadline equal to
  the injected clock still allows the one stale-owner recovery attempt before failing contention.
- `packages/rfmedia-cli/src/lib/secure-store/errors.ts:1-20` and `:109-202` define the stable,
  subject-parameterized `SecureStoreError` taxonomy. Messages exclude file bytes, but `.path` and
  `.remediation` deliberately retain a sanitized path; the Lidarr adapter therefore must translate
  rather than leak these errors.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:386-399` defines the public internal contract
  that must remain unchanged: `LidarrPlanClaimDependencies` and `LidarrPlanClaim { path,
assertOwned(), release() }`.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts:4737-4741` documents acquisition as exclusive
  and limited to demonstrably stale recovery. After the refactor this JSDoc remains correct, but an
  implementation comment should pin the zero-wait and disabled-age choices at the shared call site.
- `packages/rfmedia-cli/src/lib/errors.ts:106-168` defines the Lidarr-visible error boundary.
  `LidarrPlanAlreadyRunningError` remains authoritative for contention, corrupt partial claims, and
  ownership loss; other failures remain within `LidarrPlanArtifactError` or validation errors.
- `packages/rfmedia-cli/src/commands/lidarr.ts:312-378` documents and implements the final redacted
  Lidarr failure envelope. Claim-lock implementation errors must be translated before reaching this
  boundary so no new secure-store code, path, or remediation enters text or machine output.

`docs/features/error-handling.md` is an rfapps-specific operator guide. It is not the error contract
for `rfmedia lidarr apply` and should not be edited for #304. Likewise,
`src/lib/error-formatters.ts` does not register the Lidarr plan-claim errors; the Lidarr command's
`reportLidarrFailure()` boundary handles them.

## Development Guides

- `docs/plans/issue-288-secure-store-migration/plan.md` is required. Commit 1 documents the shared
  lock API and tests; commit 5 is the exact delete-and-delegate/error-translation precedent; commit
  6 shows how internal debt and follow-up documentation were reconciled. Its gate guidance also
  requires explicit `umask 022` and unset `FORCE_COLOR` for direct Vitest runs.
- `packages/rfmedia-cli/README.md`, **Development** and **Testing**, records package test commands,
  real-filesystem temporary-directory conventions, typechecking, and build commands. It is useful
  for execution, though issue #304's verification plan is more specific.
- Root `package.json` scripts are the executable development contract: `test:run`, `typecheck`,
  `test:contracts`, `lint:md`, and `format:check`. The package scripts add `check:architecture` and
  focused Vitest execution.
- `.github/pull_request_template.md` requires exact test commands/results and either updated docs or
  an explanation that user docs are unnecessary. For #304 the correct statement is that internal
  architecture/roadmap docs changed while command and operator docs did not.
- `CLAUDE.md`/`AGENTS.md` require Markdown lint compatibility and completion parity whenever CLI
  options change. They also make `ROADMAP.md` a live completion artifact.

## README Files

- `packages/rfmedia-cli/README.md` is the only README materially adjacent to #304. Its **Lidarr
  Mutation Plan/Apply** section describes commands and links to the detailed feature guide, but does
  not expose the lock implementation or a lock option. No README edit is required when behavior and
  syntax remain unchanged.
- The root `README.md` and `docs/README.md` index the platform and its feature documentation. Neither
  currently makes a claim about the plan-lock implementation, so neither requires an issue-specific
  edit or new index entry.
- Do not add a public secure-store README for this change. `secure-store/index.ts` is the supported
  API boundary, and the design/ADR already explain its internal policy decisions.

## Must-Read Documents

Read these in order before implementation:

1. GitHub issue #304 body: scope, exact risk fixtures, verification commands, and the rule that
   `plan-engine.test.ts` must pass unmodified.
2. `docs/plans/issue-288-secure-store-migration/design.md`: the already-decided mapping and explicit
   out-of-scope boundary for #305.
3. `docs/plans/issue-288-secure-store-migration/plan.md`: the shared API details, preset adapter
   precedent, error table, gates, and abort criteria.
4. `packages/rfmedia-cli/src/lib/secure-store/index.ts`, `lock.ts`, and `errors.ts` JSDoc: the actual
   current API contract supersedes historical line numbers in plans.
5. `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` claim interfaces/JSDoc and
   `src/lib/errors.ts`: the public internal and error surfaces that cannot change.
6. `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`: the operator-visible concurrency and
   recovery guarantee.
7. `docs/internal/plex-jwt-deferrals.md` and `ROADMAP.md`: completion documentation that must be
   reconciled when #304 ships.
8. `.github/pull_request_template.md`: final documentation and verification reporting contract.

Useful but non-blocking: `packages/rfmedia-cli/docs/features/lidarr-quality-presets.md`, the broad
architecture/data-flow docs, and historical mutation-plan design artifacts.

## Documentation Gaps

### Required changes with the implementation

1. **Correct stale barrel JSDoc.** `src/lib/secure-store/index.ts:9-16` currently says
   `lidarr/plan-engine.ts` sources _only_ mode/path-length constants and leaves its secure-store
   machinery outside. After #304, rewrite this paragraph narrowly: the claim lock delegates to the
   shared lock, while the bounded readers, path walks, directory hardeners, and atomic plan/history
   writers remain local for the documented #305 reasons.
2. **Correct stale UUID JSDoc.** `src/lib/secure-store/lock.ts:70-75` says `plan-engine.ts` and preset
   persistence declare byte-identical UUID patterns. After deleting the bespoke claim machinery,
   update it to describe shared consumption rather than duplicate declarations.
3. **Record the policy at the adapter.** Keep or expand the `acquireLidarrPlanClaim()` JSDoc/local
   comments so `deadlineEpochMs: now` and `maxAgeMs: null` are visibly correctness choices, not
   tuning defaults. Document that the plan ID is already bound by the filename, so no `binding` is
   passed and pre-migration four-key records remain recoverable.
4. **Close the ADR deferral.** Update `docs/internal/plex-jwt-deferrals.md` section 8's statement that
   exactly two lock implementations remain. It should say the #304 migration leaves
   `secure-store/acquireExclusiveLock` as the single plan/preset/credential lock implementation,
   while #305 still owns plan path walks and writers. Mark the #304 row in section 9 resolved with
   its closing PR once known; retain the historical explanation of why it was split from #288.
5. **Update the living roadmap.** On closure, remove #304 from `ROADMAP.md`'s Sprint 2 Next Up table
   and renumber the remaining #305 to #308 sequence; remove it from the rfmedia medium backlog and
   decrement that hardcoded count; update Current Focus and the Secure artifact I/O cross-cutting
   row to say #288/#304 shipped and #305 to #308 remain. Per `ROADMAP.md` Maintenance, do **not** add
   #304 to `docs/roadmap-archive.md` yet: narrative moves there only when the full Sprint 2 closes.

### Explicitly no change

- Do not rewrite either issue-288 design/plan; they are historical records whose deferral decision
  remains useful.
- Do not change `lidarr-plan-apply.md`, `lidarr-quality-presets.md`, package/root READMEs, or the docs
  index if the unmodified contract tests pass. Their user-visible statements remain accurate.
- Do not add release notes, migration instructions, config docs, new environment-variable docs, or
  troubleshooting steps. The lock record path/schema remains compatible and there is no operator
  action.
- Do not document #305's path/writer migration as complete. This refactor is its prerequisite, not
  its implementation.

## Completion/Completions Audit

### CLI and operator surface

Audit result: **no CLI documentation or completion template changes are required**.

- Issue #304 changes `acquireLidarrPlanClaim()` internals only. It adds no command, subcommand,
  positional argument, flag, config key, environment variable, output field, exit code, or recovery
  instruction.
- `src/commands/lidarr.ts:1273-1315` remains the authoritative `lidarr apply` option registration.
  The claim directory is an internal test/embedding dependency, not a CLI option.
- `lidarr-plan-apply.md` already describes the complete observable behavior: dry-run is claim-free,
  real apply is exclusive, contention fails closed, and stale recovery is conservative. The chosen
  shared options preserve exactly that behavior.

### Bash, Zsh, and Fish parity

- Bash's exact apply set is `lidarr_apply_opts` in
  `src/lib/shell-completions/bash.ts`; Zsh's `apply` case is in `zsh.ts`; Fish's apply predicate and
  options are in `fish.ts` under `__fish_rfmedia_lidarr_apply_active`.
- `src/lib/shell-completions/templates.spec.ts`, test **"locks exact Lidarr apply options across all
  shells"**, compares all three generated sets against one expected option list. None of those
  options is lock-implementation-specific.
- Therefore the three templates must remain unmodified. Run the parity spec as a regression gate:

  ```bash
  cd packages/rfmedia-cli
  umask 022 && env -u FORCE_COLOR npx vitest run src/lib/shell-completions/templates.spec.ts
  ```

### Completion evidence

- Run the two issue-mandated suites unmodified, then package typecheck/architecture gates and the
  root test suite. Enforce the repository's Node 22 runtime with `mise exec -- ...` in this checkout.
- Confirm `git diff -- packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts` is empty.
- Confirm the claim-specific `link()` at the old acquisition block is gone. A blanket zero-hit grep
  is not valid until #305: `plan-engine.ts` still legitimately uses `link()` for plan artifact
  publication (currently near `writeLidarrPlanArtifact`).
- Confirm `LidarrPlanClaim` and `LidarrPlanClaimDependencies` are unchanged and all action consumers
  compile unchanged.
- Run `npm run lint:md` and `npm run format:check` after the ADR/ROADMAP edits.
- In the PR body, use `.github/pull_request_template.md`, list exact pass/fail outcomes, state that
  Bash/Zsh/Fish were audited with no surface change, explain why user docs were unchanged, and link
  `Closes #304`.
