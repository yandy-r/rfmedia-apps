# Native `rfapps backup` Implementation Plan

Issue #160 will ship as one cohesive producer-and-verifier feature with a strict, versioned
manifest. The implementation separates pure storage planning, secure offline bundle handling,
Docker-authority archive transport, exact-container recovery, and CLI presentation so each
high-risk boundary can be tested directly. Work proceeds in dependency-resolved batches with
exclusive ownership of every shared hotspot, then converges on all three completion templates,
operator documentation, live roadmap state, and one squash-merged pull request.

## Worktree Setup

- **Parent**: /home/yandy/Projects/github.com/yandy-r/rfmedia-apps/.codex/worktrees/rfmedia-apps-issue-160-native-backup/ (branch: feat/issue-160-native-backup)

This worktree already exists at the issue's frozen `origin/master` base. All implementation,
validation, review fixes, commits, and PR updates must happen here; the primary checkout must remain
untouched.

## Critically Relevant Files and Documentation

- `docs/plans/issue-160-native-backup/feature-spec.md`: authoritative corrected v1 contract.
- `docs/plans/issue-160-native-backup/design-review-safety.md`: resolved mutation/recovery review.
- `docs/plans/issue-160-native-backup/design-review-completeness.md`: resolved contract review.
- `docs/plans/issue-160-native-backup/analysis-context.md`: architecture and safety synthesis.
- `docs/plans/issue-160-native-backup/analysis-code.md`: concrete seams and existing signatures.
- `docs/plans/issue-160-native-backup/analysis-tasks.md`: dependency and file-ownership analysis.
- `packages/rfapps-cli/CLAUDE.md`: package layering, ESM, testing, and documentation rules.
- `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts`: canonical resolved Compose evidence.
- `packages/rfapps-cli/src/lib/plan-storage.ts`: secure small-file validation precedents only.
- `packages/rfapps-cli/src/lib/lifecycle-lock.ts`: project/Docker-authority mutation lock.
- `packages/rfapps-cli/src/lib/state-lock.ts`: process-wide root mutation lock.
- `packages/rfapps-cli/src/lib/dependency-graph.ts`: dependency-first service ordering.
- `packages/rfapps-cli/src/actions/update.ts`: injected action and coordinator precedent.
- `packages/rfapps-cli/src/commands/state.ts`: parent/nested lazy command precedent.
- `packages/rfapps-cli/src/actions/completion.ts`: Bash, Zsh, and Fish templates.
- `packages/rfapps-cli/src/testing/cli-harness.ts`: real-CLI fake-Docker integration harness.

## Implementation Plan

### Phase 1: Freeze the persisted and terminal contracts

#### Task 1.1: Define backup types and exact runtime schema Depends on [none]

**READ THESE BEFORE TASK**

- `docs/plans/issue-160-native-backup/feature-spec.md`
- `packages/rfapps-cli/src/types/update.ts`
- `packages/rfapps-cli/src/lib/plan-storage.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/types/backup.ts`
- `packages/rfapps-cli/src/lib/backup-schema.ts`
- `packages/rfapps-cli/src/lib/backup-schema.spec.ts`

Files to Modify

- `packages/rfapps-cli/src/types/index.ts`

Define the exact `rfapps-backup.v1`, `rfapps-backup-result.v1`, and
`rfapps-backup-verify-result.v1` contracts as strict discriminated unions, including the approved
skip/failure codes, restore hints, consistency evidence, primary/recovery failures, and staging
disposition. Build a pure runtime validator with exact keys, safe canonical relative artifact
paths, 4 MiB/10,000-entry/1,000-warning/4,096-byte-string caps, unique IDs and paths, stable
sanitized schema failures, and fresh validated outputs. Use focused parameterized tests for schema
shape, bounds, version rejection, uniqueness, path safety, and union exhaustiveness; do not perform
filesystem I/O here. Structured failures must never expose raw Docker endpoints, environment
values, secrets, or unbounded external payloads.

### Phase 2: Build independent security and Docker foundations

#### Task 2.1: Implement secure bundle storage and offline verification Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-160-native-backup/feature-spec.md`
- `packages/rfapps-cli/src/lib/plan-storage.ts`
- `packages/rfapps-cli/src/lib/state-rebuild-files.ts`
- `packages/rfapps-cli/src/lib/backup-schema.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/lib/backup-storage.ts`
- `packages/rfapps-cli/src/lib/backup-storage.spec.ts`
- `packages/rfapps-cli/src/lib/backup-verify.ts`
- `packages/rfapps-cli/src/lib/backup-verify.spec.ts`

Files to Modify

- None.

Validate an existing owned, writable, symlink-free destination; exclusively reserve the final
`0700` bundle; create `0600` artifact files; and publish `manifest.json` last with a no-replace
primitive plus file and directory sync. Expose secure idempotent remove/retain primitives, but
leave the staging-disposition policy to the coordinator after it observes recovery. Verification must be
Docker/config/lock independent, bounded before parse, no-follow at every path component, compare
path and handle identity, require regular files, stream compressed byte counts and SHA-256, report
all missing/mismatched/unexpected artifacts deterministically, and never extract archives. Test
only those storage and integrity boundaries.

#### Task 2.2: Implement Docker-authority evidence, hardened streaming, and exact restart Depends on [1.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-160-native-backup/feature-spec.md`
- `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts`
- `packages/rfapps-cli/src/lib/docker.ts`
- `packages/rfapps-cli/src/lib/dependency-graph.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/lib/backup-docker.ts`
- `packages/rfapps-cli/src/lib/backup-docker.spec.ts`

Files to Modify

- `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts`
- `packages/rfapps-cli/src/lib/docker-conflict-evidence.spec.ts`
- `packages/rfapps-cli/src/lib/docker.ts`
- `packages/rfapps-cli/src/lib/docker.spec.ts`

Extend canonical mount evidence only enough to classify every approved skip/preflight case. Store
only the one-way Docker-authority fingerprint, never a raw endpoint. Add a binary-safe subprocess
seam that never routes archive bytes through text execution. The
backup-specific adapter must probe bind/volume sources through the selected Docker authority,
pre-pull and resolve
`docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1`
to an immutable image ID, encode safe `--mount` operands,
launch a one-read-only-mount helper by direct argv with no network/read-only root/cap-drop/
no-new-privileges, stream tar output through fresh gzip/hash/count/temp-file state per retry, use
an inactivity timeout, bound and sanitize stderr, clean the full helper/process group, and restart only an exact
captured container ID. Focus tests on arbitrary binary data, fresh retry after partial bytes,
timeout/sink/SSH failures, helper sandbox argv/cleanup, probe behavior, and exact-ID start; rerun
the existing Docker and conflict-evidence suites. Prove the literal digest and that structured
evidence contains no raw endpoints, environment values, secrets, or unsanitized helper stderr.

### Phase 3: Plan and coordinate the cold-backup lifecycle

#### Task 3.1: Implement the deterministic storage and quiesce planner Depends on [1.1, 2.2]

**READ THESE BEFORE TASK**

- `docs/plans/issue-160-native-backup/feature-spec.md`
- `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts`
- `packages/rfapps-cli/src/lib/services.ts`
- `packages/rfapps-cli/src/lib/dependency-graph.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/lib/backup-planner.ts`
- `packages/rfapps-cli/src/lib/backup-planner.spec.ts`

Files to Modify

- None.

Resolve explicit selected services against the full canonical Compose project, deduplicate exact
sources while preserving every consumer, classify writers from `read_only === false`, and add
writable equal/ancestor/descendant bind consumers across the whole project to the quiesce set.
Fail closed for anonymous/unsupported/missing/ambiguous/nested persistent sources and dependency
cycles; compare destination containment only for local Docker authority. Emit stable IDs,
ordering, skip/failure codes, restore hints, and dependency-first recovery layers. Accept an
already validated, canonical destination as injected pure input; do not perform or duplicate
filesystem canonicalization in the planner. Use one compact
scenario table for exact dedupe, shared consumers, skips, overlap, containment, probes, and
fail-closed cases.

#### Task 3.2: Implement coordinator, lifecycle-lock revalidation, and exact recovery Depends on [2.1, 2.2, 3.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-160-native-backup/feature-spec.md`
- `packages/rfapps-cli/src/lib/managed-update.ts`
- `packages/rfapps-cli/src/lib/lifecycle-lock.ts`
- `packages/rfapps-cli/src/lib/backup-planner.ts`
- `packages/rfapps-cli/src/lib/backup-docker.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/lib/backup-coordinator.ts`
- `packages/rfapps-cli/src/lib/backup-coordinator.spec.ts`

Files to Modify

- None.

Enforce real-run helper preparation (inspect-only and no pull for dry-run) → secure destination
validation/canonicalization → probe-backed plan with that injected destination → bundle
reservation → immutable helper re-resolution → lifecycle lock → pre-mutation
revalidation by exact recomputation/comparison of helper identity, fingerprints, classifications,
consumers/writers, quiesce set, skips, and recovery layers → exact running-ID capture →
stop/re-observe all writers → archive/sync → exact-ID
recovery in dependency-first layers → manifest-last publication. Dry-run validates the
destination without writing and produces a complete plan with zero writes, pulls, locks, prompts,
stops, or archives when inspect-only helper resolution succeeds; helper absence returns stable
failure evidence with those same zero-mutation guarantees. The only permitted planning mutation is
a sandboxed read-only authority probe container whose settlement and removal are strictly awaited;
probe cleanup failure fails the operation. After any stop attempt,
recovery runs in `finally` for every captured ID no longer running, including partial stop, archive
failure, timeout, and cancellation; never call Compose `up` or service-level start. Preserve the
primary failure and every per-container recovery failure, defer signal re-raise until cleanup and
stabilization complete, and choose removed versus retained-incomplete staging correctly. Test these
state transitions via injected dependencies without duplicating subprocess or schema matrices.
Explicitly prove every eligible planned source streams exactly once, recovery completes before
manifest publication, recovery failure never publishes a valid manifest, and only the coordinator
chooses removed versus retained-incomplete after observing recovery.

### Phase 4: Converge the supported library and CLI surface

#### Task 4.1: Publish only the intentional backup library seams Depends on [1.1, 2.1, 2.2, 3.1, 3.2]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/lib/index.ts`
- `packages/rfapps-cli/src/types/index.ts`
- `docs/plans/issue-160-native-backup/feature-spec.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfapps-cli/src/lib/index.ts`

Export only the settled schema, planner, coordinator, secure verifier, and deliberately supported
adapter contracts. Keep actions, command internals, helper subprocess internals, MCP mutation,
restore execution, and generic scheduling/framework surfaces private.

#### Task 4.2: Add parent/nested commands, actions, output, errors, and root-lock routing Depends on [4.1]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/commands/state.ts`
- `packages/rfapps-cli/src/commands/update.ts`
- `packages/rfapps-cli/src/actions/update.ts`
- `packages/rfapps-cli/src/cli.ts`
- `packages/rfapps-cli/src/lib/error-formatters.ts`
- `packages/rfapps-cli/src/lib/exit-codes.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/commands/backup.ts`
- `packages/rfapps-cli/src/commands/backup.spec.ts`
- `packages/rfapps-cli/src/actions/backup.ts`
- `packages/rfapps-cli/src/actions/backup.spec.ts`
- `packages/rfapps-cli/src/actions/backup-verify.ts`
- `packages/rfapps-cli/src/actions/backup-verify.spec.ts`

Files to Modify

- `packages/rfapps-cli/src/cli.ts`
- `packages/rfapps-cli/src/lib/errors.ts`
- `packages/rfapps-cli/src/lib/errors.spec.ts`
- `packages/rfapps-cli/src/lib/error-formatters.ts`
- `packages/rfapps-cli/src/lib/error-formatters.spec.ts`
- `packages/rfapps-cli/src/lib/error-formatters-registration.spec.ts`
- `packages/rfapps-cli/src/lib/exit-codes.ts`
- `packages/rfapps-cli/src/lib/exit-codes.spec.ts`

Register `rfapps backup ... --destination <existing-directory>` and
`rfapps backup verify <manifest>` with lazy action loaders. Enforce `--all` mutual exclusion,
explicit scope for `--yes`/non-TTY/machine creation, interactive selection only for human
text/table TTY, CSV refusal before effects, one plan/one confirmation, and exact 0/1/2 exits.
For probe-backed planning, a real creation must ensure the pinned helper before rendering the
complete plan; this cache preparation plus strictly cleaned sandboxed probe containers are the only
allowed pre-confirmation Docker mutations. Dry-run must
use inspect-only helper resolution, never pull, and fail closed if the helper is unavailable. Test
cached-helper dry-run success, absent-helper dry-run failure with zero mutation, first-run real
pull/immutable resolution before probing, guaranteed probe cleanup including cleanup failure, and
declined confirmation with no bundle or service stop.
Creation gets the root state lock only when non-dry-run; dry-run and nested verify are lock-free.
Branch verification before config, Compose, Docker, secrets, selection, confirmation, and locks.
JSON/YAML emit exactly one versioned terminal document and human formats render the same facts;
diagnostics stay on stderr. Structured output must never expose raw Docker endpoints, environment
values, secrets, or unsanitized helper stderr. Prefer existing invalid-argument/error behavior and add only minimal
backup-specific global formatting for exceptional pre-result failures.

#### Task 4.3: Add focused real-CLI contract coverage Depends on [4.2]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/testing/cli-harness.ts`
- `packages/rfapps-cli/src/cli.state-rebuild.integration.spec.ts`
- `packages/rfapps-cli/src/actions/backup.ts`
- `packages/rfapps-cli/src/actions/backup-verify.ts`

**Instructions**

Files to Create

- `packages/rfapps-cli/src/cli.backup.integration.spec.ts`

Files to Modify

- None.

Use the real CLI harness and fake Docker executable to prove only process-level boundaries:
dry-run creates no bundle, pulls no image, stops no service, and takes no locks; any transient
probe helper must be removed. Machine creation without `--yes` or an
explicit target fails before mutation; a successful machine create emits exactly one v1 result;
offline verification succeeds and fails with no config and no Docker invocation; CSV is rejected
before side effects. For real creation, prove the root state lock remains held while coordination
acquires the lifecycle lock and performs revalidation/archive/recovery; preserve explicit zero-lock
assertions for dry-run and verify. Do not repeat planner, checksum, retry, recovery, or per-format
unit matrices.

### Phase 5: Complete every public surface

#### Task 5.1: Update Bash, Zsh, and Fish completion parity Depends on [4.2]

**READ THESE BEFORE TASK**

- `packages/rfapps-cli/src/actions/completion.ts`
- `packages/rfapps-cli/src/actions/completion.spec.ts`
- `packages/rfapps-cli/src/commands/backup.ts`

**Instructions**

Files to Create

- None.

Files to Modify

- `packages/rfapps-cli/src/actions/completion.ts`
- `packages/rfapps-cli/src/actions/completion.spec.ts`

Update all three hand-maintained templates together with top-level `backup`, nested `verify`, exact
creation selectors/options, context guards, service/group/profile value completion, destination
directory completion, and manifest file completion. Derive one Commander parity table across Bash,
Zsh, and Fish plus one three-shell path-completion assertion; avoid separate duplicated shell
behavior suites.

#### Task 5.2: Write operator, restore-hint, output, and limitation documentation Depends on [4.3, 5.1]

**READ THESE BEFORE TASK**

- `docs/plans/issue-160-native-backup/feature-spec.md`
- `docs/guides/backup-restore.md`
- `docs/features/output-formats.md`
- `packages/rfapps-cli/README.md`

**Instructions**

Files to Create

- `docs/features/rfapps-backup.md`

Files to Modify

- `packages/rfapps-cli/README.md`
- `docs/guides/backup-restore.md`
- `docs/features/shell-completion.md`
- `docs/features/quick-reference.md`
- `docs/features/json-output.md`
- `docs/features/error-handling.md`
- `docs/features/output-formats.md`

Document command syntax, cold filesystem semantics, full-project detected-writer quiescence,
private manifest-last bundles, offline verify, both v1 result envelopes, exits, CSV rejection,
data-only restore hints, and manual restoration. State that SHA-256 authenticates neither origin
nor author and that host writers, other Compose projects, application-native consistency,
automated restore, scheduling, retention, remote upload, encryption, and signatures are outside
v1. Remove stale claims that rfapps has no native backup while preserving database-native dump
guidance.

#### Task 5.3: Update navigation, package architecture, and live roadmap Depends on [5.2]

**READ THESE BEFORE TASK**

- `README.md`
- `docs/README.md`
- `packages/rfapps-cli/CLAUDE.md`
- `ROADMAP.md`

**Instructions**

Files to Create

- None.

Files to Modify

- `README.md`
- `docs/README.md`
- `packages/rfapps-cli/CLAUDE.md`
- `ROADMAP.md`

Add concise root/docs/package navigation and architecture guidance for the new feature. Refresh
GitHub's live open-issue totals immediately before editing `ROADMAP.md`, calculate and record the
expected post-close total explicitly, and recheck before merge if concurrent issue changes make the
count stale. Task 6.1 owns the authoritative post-merge verification. Mark only #160 delivered; do
not change unrelated issue state. Do not touch
`docs/roadmap-archive.md` because the enclosing track remains active, and do not create child
issues or placeholder PR references.

### Phase 6: Validate, review, and deliver the single PR

#### Task 6.1: Run exclusive quality, security, and delivery gates Depends on [1.1, 2.1, 2.2, 3.1, 3.2, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3]

**READ THESE BEFORE TASK**

- `.github/pull_request_template.md`
- `package.json`
- `packages/rfapps-cli/package.json`
- `.github/workflows/`

**Instructions**

Files to Create

- None.

Files to Modify

- None, except narrowly scoped fixes returned to the original owning task.

Run the focused schema, storage/verify, Docker, planner, coordinator, command/action, completion,
and CLI integration specs first. Then run rfapps typecheck, the full rfapps suite and coverage,
package build, repository formatting/Markdown lint/diff checks, and every applicable
architecture/codegen/integration contract. Update graphify after code convergence and inspect the
generated delta separately. Perform an independent code and security/recovery review, fix every
actionable finding, rerun affected and full gates, commit coherently without bypassing hooks, open
one template-compliant PR closing #160, resolve all review threads, wait for authoritative green
GitHub CI, bind review/check evidence to the active PR head SHA after every push, require zero
unresolved threads, squash merge, verify the issue closed and merged head SHA, remove only this
worktree and branch, verify the actual post-merge open-issue total against the roadmap expectation,
and confirm the primary checkout remains untouched while reporting (not changing) whether it is
aligned with the authoritative default branch.

## Advice

- Treat the corrected feature spec as authoritative whenever older research differs: v1 is cold,
  all-or-nothing, manifest-last, and one PR.
- Keep offline verification's import graph free of config, Compose, Docker, selection, prompts, and
  locks; the real-CLI test must prove this boundary.
- The highest-risk invariant is recovery, not archive creation. Capture exact running container IDs
  before any stop and make recovery unavoidable after the first stop attempt.
- A direct argv avoids shell injection but does not make Docker's comma-delimited `--mount`
  mini-language safe; validate representability before mutation.
- Do not use the current text-buffering Docker helper, Compose `up`, or replacing `rename()` for
  archive streaming, exact restart, or final manifest publication.
- Keep critical tests boundary-focused: each failure mode belongs to exactly one layer, while the
  subprocess integration suite proves only true cross-layer behavior.
