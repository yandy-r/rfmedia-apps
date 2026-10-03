# Task Structure Analysis: Issue #160 Native Backup

## Executive Summary

Implement issue #160 as one atomic user-facing release and one PR, divided into dependency-bounded
implementation batches. The critical path is contract/schema → Docker evidence and archive
boundary → planner → coordinator/recovery → CLI convergence. Secure bundle publication and offline
verification can proceed in parallel with the Docker lane once the v1 types and runtime schema are
frozen.

The plan deliberately gives one owner to each hotspot: `docker.ts`, the canonical Compose evidence
adapter, the type and library barrels, `cli.ts`, the completion generator, and each documentation
file. Creation and verification remain in the same PR; do not create child issues. Focused tests
prove one distinct boundary each rather than replaying the mount matrix, recovery matrix, and
manifest matrix through every layer.

Authoritative inputs are `feature-spec.md`, `design-review-safety.md`, and
`design-review-completeness.md`; both reviews have resolved every blocking and important finding.

## Recommended Phase Structure

### Phase 0: Freeze the public and persisted contract

- **T01 — Backup types and strict runtime schema**
  - **Depends on:** approved feature spec.
  - **Owns:** `packages/rfapps-cli/src/types/backup.ts` (create),
    `packages/rfapps-cli/src/types/index.ts`,
    `packages/rfapps-cli/src/lib/backup-schema.ts` (create),
    `packages/rfapps-cli/src/lib/backup-schema.spec.ts` (create).
  - Define the exact manifest, plan, artifact, skip/failure, restore-hint, create-result, and
    verify-result discriminated unions and schema/version constants.
  - The runtime parser owns exact keys, 4 MiB input, entry/warning/string bounds, unique IDs and
    artifact paths, safe bundle-relative syntax, and stable schema errors. It performs no file I/O.
  - Test only structural validation, bounds, uniqueness, version rejection, and restore-union
    exhaustiveness; filesystem traversal and checksum behavior belong to T02.

### Phase 1: Independent security and Docker foundations

Run T02 and T03 in parallel after T01. Their file ownership is disjoint.

- **T02 — Secure bundle storage and offline verification**
  - **Depends on:** T01.
  - **Owns:** `packages/rfapps-cli/src/lib/backup-storage.ts` (create),
    `packages/rfapps-cli/src/lib/backup-storage.spec.ts` (create),
    `packages/rfapps-cli/src/lib/backup-verify.ts` (create),
    `packages/rfapps-cli/src/lib/backup-verify.spec.ts` (create).
  - Implement owned, symlink-free destination validation; exclusive `0700` bundle reservation;
    exclusive `0600` files; manifest-last, no-replace publication; file and directory sync; and
    secure idempotent staging cleanup/retention primitives. T05 alone chooses the recovery-aware
    staging disposition.
  - Verification must open with no-follow semantics, compare path/handle identity, require regular
    files, stream size and SHA-256 without extraction, report every declared and unexpected
    artifact deterministically, and reject a manifest-less bundle.
  - Keep this four-file slice together: secure publication and verification share the same path,
    handle, permission, and bundle-validity invariants.

- **T03 — Canonical mount evidence, Docker probes, and binary helper streaming**
  - **Depends on:** T01.
  - **Owns:** `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts`,
    `packages/rfapps-cli/src/lib/docker-conflict-evidence.spec.ts`,
    `packages/rfapps-cli/src/lib/docker.ts`,
    `packages/rfapps-cli/src/lib/docker.spec.ts`,
    `packages/rfapps-cli/src/lib/backup-docker.ts` (create),
    `packages/rfapps-cli/src/lib/backup-docker.spec.ts` (create).
  - Extend the allowlisted canonical Compose mount projection only as needed to preserve enough
    normalized evidence for anonymous and unsupported mounts to receive the spec's stable planner
    codes without exposing unrelated Compose fields.
  - Add a binary-safe process boundary rather than routing archive bytes through `execDocker()`.
    Every attempt gets a fresh process/helper, compressor, hash/count state, and temporary sink;
    stderr is bounded, inactivity is timed, SSH/sink/child failure restarts at byte zero, and
    cancellation tears down the full process group.
  - `backup-docker.ts` owns authority-side bind/volume probes, digest-pinned helper acquisition and
    immutable-ID resolution, safe Docker mount operand encoding, sandboxed direct-tar argv, writer
    observation/stop, and exact container-ID start primitives.
  - Use the literal pinned helper
    `docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1`.
    Persist only the one-way Docker-authority fingerprint and bounded sanitized stderr; never emit
    raw endpoints, environment values, or secrets.
  - Run the existing conflict-evidence and Docker suites because this task changes shared
    adapters. Do not duplicate planner classification or coordinator recovery cases here.

### Phase 2: Planning and lifecycle coordination

- **T04 — Deterministic storage and quiesce planner**
  - **Depends on:** T01 and T03.
  - **Owns:** `packages/rfapps-cli/src/lib/backup-planner.ts` (create),
    `packages/rfapps-cli/src/lib/backup-planner.spec.ts` (create).
  - Resolve explicit selected services against the full normalized Compose project; deduplicate
    exact sources; preserve every consumer; classify writers by `read_only === false`; add writable
    equal/ancestor/descendant bind consumers to the quiesce set; reject ambiguous/nested sources;
    and compare local destinations only inside the local Docker-authority namespace.
  - Accept an already validated canonical destination as injected pure input. Do not perform or
    duplicate filesystem canonicalization in this pure planner.
  - One parameterized planner table should prove exact-source deduplication, shared consumers,
    explicit skips, full-project overlap, destination containment, and fail-closed unsupported,
    missing, probe-failed, anonymous, and nested persistent sources.

- **T05 — Backup coordinator and exact-container recovery**
  - **Depends on:** T01 through T04.
  - **Owns:** `packages/rfapps-cli/src/lib/backup-coordinator.ts` (create),
    `packages/rfapps-cli/src/lib/backup-coordinator.spec.ts` (create).
  - Enforce the approved order: validate/canonicalize destination through T02 → plan with that
    injected value → reserve bundle → acquire/resolve helper → lifecycle lock → revalidate →
    capture exact running IDs → stop/re-observe all writers → archive → sync → recover exact IDs
    in dependency-first layers → publish manifest.
  - Recovery begins after any stop attempt and lives in `finally`; it preserves primary plus
    per-container recovery failures and defers signal re-raise until helper cleanup and
    stabilization finish. It must never call Compose `up --remove-orphans`.
  - T05 alone chooses removed versus retained-incomplete staging after observing recovery. It owns
    the lifecycle lock; root state-lock routing remains with T07.
  - Tests own dry-run zero mutation; lifecycle lock/revalidation ordering; refusal to archive a
    still-running writer; successful publication; and exact-ID recovery after success, partial
    stop, archive failure, and interruption. Use a compact scenario table around injected
    dependencies rather than repeating T03 subprocess cases.
  - Prove every eligible planned source archives exactly once, recovery completes before manifest
    publication, and recovery failure never publishes a valid manifest.

### Phase 3: Export and CLI convergence

- **T06 — Public library export convergence**
  - **Depends on:** T01 through T05.
  - **Owns:** `packages/rfapps-cli/src/lib/index.ts`.
  - Export only the settled backup planner/coordinator/verify seams needed by supported library
    consumers. Do not expose an MCP mutation, generic backup framework, restore executor, or
    scheduling API.

- **T07 — Command, action, errors, locks, output, and exit behavior**
  - **Depends on:** T05 and T06.
  - **Owns:** `packages/rfapps-cli/src/commands/backup.ts` (create),
    `packages/rfapps-cli/src/commands/backup.spec.ts` (create),
    `packages/rfapps-cli/src/actions/backup.ts` (create),
    `packages/rfapps-cli/src/actions/backup.spec.ts` (create),
    `packages/rfapps-cli/src/actions/backup-verify.ts` (create),
    `packages/rfapps-cli/src/actions/backup-verify.spec.ts` (create),
    `packages/rfapps-cli/src/cli.ts`,
    `packages/rfapps-cli/src/lib/errors.ts`,
    `packages/rfapps-cli/src/lib/errors.spec.ts`,
    `packages/rfapps-cli/src/lib/error-formatters.ts`,
    `packages/rfapps-cli/src/lib/error-formatters.spec.ts`,
    `packages/rfapps-cli/src/lib/error-formatters-registration.spec.ts`,
    `packages/rfapps-cli/src/lib/exit-codes.ts`,
    `packages/rfapps-cli/src/lib/exit-codes.spec.ts`.
  - The command registrar owns `backup`/`backup verify`, target and destination syntax,
    `--all` mutual exclusion, CSV refusal, and lazy action loading.
  - The action owns config/selection only for creation, explicitly materializes `--all`, rejects
    no-target `--yes` and machine invocations, renders one plan, confirms once, calls the
    coordinator/verifier, emits one versioned terminal document, and maps the typed result to
    process exit status.
  - `verify` must branch before config, Docker, selection, confirmation, and lock-dependent work.
    In `cli.ts`, non-dry-run top-level creation gets the root state lock; dry-run and nested
    `backup verify` get none. T05 owns the second, project/authority lifecycle lock.
  - Prefer existing `InvalidArgumentError` and `ExitCode` behavior. Add a backup-specific global
    error/formatter only for an error that legitimately escapes before a versioned terminal result;
    expected manifest, archive, primary, and recovery failures belong in typed results.
  - Never emit raw Docker endpoints, environment values, secrets, or unsanitized helper stderr.

### Phase 4: Completion and focused integration

Run T08 and T09 in parallel after T07.

- **T08 — Bash, Zsh, and Fish completion parity**
  - **Depends on:** T07's finalized Commander surface.
  - **Owns:** `packages/rfapps-cli/src/actions/completion.ts`,
    `packages/rfapps-cli/src/actions/completion.spec.ts`.
  - Update all three hand-maintained templates as one unit. Add top-level `backup`, nested `verify`,
    exact creation options, context guards, service/group/profile values, destination directory
    completion, and manifest file completion.
  - Use one Commander-derived table across all shells plus one three-shell path-value assertion.
    Do not create per-shell copies of command behavior tests.

- **T09 — Focused real-CLI boundary**
  - **Depends on:** T02 through T07. Run in parallel with T08 after T07.
  - **Owns:** `packages/rfapps-cli/src/cli.backup.integration.spec.ts` (create).
  - Prove only process-level facts not already owned elsewhere: real create is blocked by the root
    state lock and retains it across lifecycle-lock coordination; dry-run creates/pulls/stops
    nothing and takes no locks; machine creation without `--yes` fails before mutation; one
    successful machine create emits exactly one v1 result; and offline verify succeeds/fails
    without loading config or invoking Docker.
  - Use the existing CLI harness/fake executable pattern. Do not require a live daemon or repeat
    the planner, checksum, retry, and recovery matrices.

### Phase 5: Documentation and roadmap

- **T10 — Operator and output documentation**
  - **Depends on:** T07 through T09.
  - **Owns:** `docs/features/rfapps-backup.md` (create),
    `packages/rfapps-cli/README.md`,
    `docs/guides/backup-restore.md`,
    `docs/features/shell-completion.md`,
    `docs/features/quick-reference.md`,
    `docs/features/json-output.md`,
    `docs/features/error-handling.md`,
    `docs/features/output-formats.md`.
  - Document cold filesystem semantics, scope/quiescence, private manifest-last bundles, offline
    verify, both v1 result envelopes, exit codes, CSV rejection, restoration hints, and the limits
    of SHA-256 and detected-Compose-writer consistency.
  - Replace stale “rfapps has no backup” claims but retain database-native dump and manual restore
    guidance. Do not imply automated restore, scheduling, retention, signing, or encryption.

- **T11 — Navigation, architecture guidance, and live roadmap**
  - **Depends on:** T10 and passing focused validation.
  - **Owns:** `README.md`, `docs/README.md`, `packages/rfapps-cli/CLAUDE.md`, `ROADMAP.md`;
    conditionally `docs/roadmap-archive.md` only if the enclosing follow-on track is actually
    archived.
  - Add command/architecture navigation and mark #160 delivered without changing unrelated issue
    state. Audit live state before the edit and record the expected post-close total; T12 owns
    authoritative post-merge verification. Do not create child issues or placeholder PR references.

### Phase 6: Exclusive final gate

- **T12 — Validation, review, and one-PR delivery gate**
  - **Depends on:** T01 through T11.
  - **Owns:** no source files. Findings return to the task that owns the implicated file.
  - Run focused schema, storage/verify, Docker, planner, coordinator, command/action, completion,
    and CLI integration specs; then rfapps typecheck, full rfapps tests/coverage, build, formatting,
    Markdown lint, `git diff --check`, and repository-required integration/contract gates.
  - Run the repository-required graph update only after code changes converge, then review its
    generated delta separately. Perform a security/recovery review before the single PR is ready.
  - Bind review and CI evidence to the active PR head SHA after every push, require zero unresolved
    threads, squash merge, verify the issue closed plus the actual post-merge roadmap total, remove
    only this worktree and branch, and leave the primary checkout untouched while reporting its
    alignment.

## Task Granularity Recommendations

- Keep one behavior and its closest test under one owner. T02, T03, and T07 intentionally exceed a
  generic one-to-three-file target because splitting their security/process/public-CLI invariants
  would create unsafe handoffs and same-file conflicts.
- Do not split T03 between the generic stream primitive and backup helper policy: retry,
  cancellation, sink cleanup, and helper cleanup must be reviewed together.
- Do not combine T04 and T05. Pure classification is independently testable; mutation and recovery
  ordering carry different risks.
- Keep `types/index.ts` solely with T01 and `lib/index.ts` solely with T06. New leaf modules should
  use direct imports until export convergence.
- Keep `cli.ts`, error/exit plumbing, command registration, and action output with T07. This is the
  single convergence point for root locking and versioned terminal behavior.
- Keep all three completion templates in the one generated file and parity suite under T08.
- T12 must not become a bulk-fix owner. Reopen the original task for any failure so concurrent
  agents never edit the same source file.

Distinct critical-test ownership:

| Boundary                                                                      | Owning task | Do not duplicate in         |
| ----------------------------------------------------------------------------- | ----------- | --------------------------- |
| Exact schema, bounds, uniqueness, versions                                    | T01         | Filesystem and CLI matrices |
| Secure publication, no-follow reads, hash/size/unexpected files               | T02         | Planner and action suites   |
| Binary stream, fresh retry, timeout, sandbox argv, remote probes              | T03         | Coordinator and CLI suites  |
| Mount classification, deduplication, overlap, destination containment         | T04         | Action/integration suites   |
| Locks after planning, stop/re-observe, exact-ID recovery, cleanup disposition | T05         | Docker and command suites   |
| Target authorization, one prompt/document, formats and exit mapping           | T07         | Shell and planner suites    |
| Commander/nested/path completion parity                                       | T08         | CLI subprocess matrix       |
| True process/config/Docker/lock/output boundary                               | T09         | Broad unit permutations     |

## Dependency Analysis

Critical path:

`T01 → T03 → T04 → T05 → T06 → T07 → T08/T09 → T10 → T11 → T12`

Parallel secure path:

`T01 → T02 → T05`

There is no circular dependency:

- schema defines persisted and terminal facts;
- storage/verify secures those facts without Docker;
- Docker adapters provide canonical evidence and byte streams;
- the planner produces a deterministic immutable plan;
- the coordinator consumes the plan and owns mutation/recovery;
- the action owns interaction and presentation;
- the command/CLI own registration and root-lock policy;
- completions and docs describe the finalized surface.

T02 and T03 can run concurrently. T08 and T09 can run concurrently after T07. Documentation may
start after the public behavior and completion surface stabilize, but `ROADMAP.md` waits for focused
evidence. No task may introduce a dependency from core code back into actions, commands, completion,
or docs.

## File-to-Task Mapping

| Files                                                                                                                                              | Owner                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `src/types/backup.ts`, `src/types/index.ts`, `src/lib/backup-schema.ts`, `src/lib/backup-schema.spec.ts`                                           | T01 — types/schema                        |
| `src/lib/backup-storage.ts`, `src/lib/backup-storage.spec.ts`, `src/lib/backup-verify.ts`, `src/lib/backup-verify.spec.ts`                         | T02 — secure manifest publication/verify  |
| `src/lib/docker-conflict-evidence.ts`, its spec, `src/lib/docker.ts`, its spec, `src/lib/backup-docker.ts`, its spec                               | T03 — Docker stream/helper/probes         |
| `src/lib/backup-planner.ts`, `src/lib/backup-planner.spec.ts`                                                                                      | T04 — planner                             |
| `src/lib/backup-coordinator.ts`, `src/lib/backup-coordinator.spec.ts`                                                                              | T05 — coordinator/recovery/lifecycle lock |
| `src/lib/index.ts`                                                                                                                                 | T06 — public exports                      |
| `src/commands/backup.ts`, its spec; both backup action modules and specs; `src/cli.ts`; error/formatter/exit-code modules and their existing specs | T07 — CLI/action/errors/root lock/output  |
| `src/actions/completion.ts`, `src/actions/completion.spec.ts`                                                                                      | T08 — all shell completions               |
| `src/cli.backup.integration.spec.ts`                                                                                                               | T09 — focused process validation          |
| Backup feature, backup guide, package README, shell/quick/JSON/error/output-format docs                                                            | T10 — operator documentation              |
| Root/docs navigation, package `CLAUDE.md`, `ROADMAP.md`, conditional roadmap archive                                                               | T11 — navigation/roadmap                  |

All `src/...` paths in this table are relative to `packages/rfapps-cli/`. Existing
`state-lock.ts`, `lifecycle-lock.ts`, `dependency-graph.ts`, `plan-storage.ts`, and
`state-rebuild-files.ts` are reuse references, not planned edit targets. T07 controls when the root
state lock is acquired; T05 invokes the existing lifecycle-lock API and dependency phase logic.

## Optimization Opportunities

- Reuse canonical Compose evidence, service selection/sidecar/profile resolution, identity
  fingerprints, lifecycle locks, dependency phases, output formatting, and state-file security
  precedents. Do not create a generic backup framework or a second service resolver.
- Keep backup-specific helper policy in `backup-docker.ts`; add only the minimal reusable
  binary-process seam to `docker.ts`.
- Stream archives and verification hashes end to end. Never buffer archive stdout, read an archive
  as UTF-8, or reuse `plan-storage.ts`'s small-file `hashFile()`.
- Use deterministic builders and compact parameterized scenario tables. This reduces fixtures and
  makes recovery/order failures easier to diagnose.
- Resolve the helper image before services stop and keep verification entirely Docker/config-free;
  these two choices shorten downtime and make the lanes independently testable.
- Delay barrel, CLI, completion, and docs convergence until leaf contracts settle. This keeps the
  high-conflict files out of parallel batches.

## Implementation Strategy Recommendations

1. Land T01 first and treat schema names, classification codes, result envelopes, bounds, and
   helper reference as frozen.
2. Run T02/T03 concurrently, then require their focused suites plus existing Docker evidence
   regressions before planning starts.
3. Implement T04 as a pure function over canonical evidence and injected probes. Review its
   deterministic plan before authorizing T05 mutation work.
4. Make T05 the only owner of the stop/archive/recovery state machine. Require a recovery-focused
   review before CLI integration.
5. Converge exports once, then give T07 exclusive ownership of the public command, action, error,
   exit, and root-lock surface.
6. Freeze the Commander surface before T08 completion work and T09 subprocess validation.
7. Update public docs and live roadmap only after focused behavior is green.
8. Deliver creation plus verification in one PR closing #160. Do not create child issues; record
   database-native hooks, restore automation, scheduling/retention/remote storage,
   signing/encryption, and additional mount types only as non-blocking future work.
