# Design Completeness Review: Issue #160

## Conclusion

The proposed cold file/named-volume backup plus offline verifier is a coherent product slice, and
the non-goals are disciplined. It is not implementation-ready yet. Four safety or public-contract
questions are blocking: the two-lock concurrency boundary, destination/source containment, exact
quiesce/restart behavior, and terminal result/format schemas.

Creation and verification should ship as one user-visible feature, but that does not require one
large review unit. The likely integration surface is more than twenty source, test, completion, and
documentation files. Two child implementation issues or stacked PRs are advisable, with issue #160
remaining open until both are integrated.

## Existing Reusable Code

- `resolveServicesWithInteractive()` and `getComposeServices()` are the right selection primitives,
  provided backup adds its stricter explicit-target gate rather than inheriting the empty-array
  "all services" sentinel
  (`packages/rfapps-cli/src/lib/interactive-selection.ts:50-52, 76-78, 95-101, 161-180`).
- `getCanonicalComposeConfigEvidence()` and its strict mount projection are the correct Compose
  evidence boundary. The projection already distinguishes `bind`, `volume`, and `tmpfs`, preserves
  `read_only`, and exposes effective top-level volume identities
  (`packages/rfapps-cli/src/lib/docker-conflict-evidence.ts:63-87, 113-124`).
- `acquireStateLock()` and `acquireLifecycleLock()` are both reusable but protect different
  namespaces. The root pre-action lock covers ordinary lifecycle commands
  (`packages/rfapps-cli/src/cli.ts:63-107, 302-305`); the project/Docker-authority lock is the
  coordinator seam used by managed update
  (`packages/rfapps-cli/src/actions/update.ts:224-227`).
- `plan-storage.ts` and `state-rebuild-files.ts` are useful references for private/no-clobber
  artifacts and atomic sibling publication, but their UTF-8 whole-file hash is not an archive
  transport. The spec correctly calls for a backup-specific binary streaming boundary
  (`feature-spec.md:126-139`).
- The `state` registrar is the closest nested-command precedent
  (`packages/rfapps-cli/src/commands/state.ts:47-102`), and the existing completion suite already
  demonstrates Commander-derived, three-shell parity and Fish disjointness
  (`packages/rfapps-cli/src/actions/completion.spec.ts:381-412`).

## Modularity Findings

### [Blocking] Specify both concurrency locks and their lock-free exceptions

`feature-spec.md:108-109` names only the project/Docker-authority lifecycle exclusion. That lock is
not acquired by ordinary `deploy`, `stop`, `rebuild`, and similar commands; those are serialized by
the root state lock (`packages/rfapps-cli/src/cli.ts:63-107`). Acquiring only the lifecycle lock
therefore permits a backup to race an ordinary lifecycle mutation.

Smallest correction:

1. Add creation to `resolveStateLockOperation()` so non-dry-run `rfapps backup` acquires the global
   state lock before action execution.
2. Acquire the project/Docker-authority lifecycle lock inside the coordinator after the reviewed
   project and authority are known, then revalidate under it.
3. State explicitly that dry-run and `backup verify` acquire neither lock.
4. Add one spawned-CLI test proving create is blocked by the root lock while dry-run and verify are
   lock-free, plus one coordinator test proving the shared lifecycle namespace.

### [Blocking] Define an exact writer/quiesce/restart contract

The goals say to stop services that can write (`feature-spec.md:15-17`), while storage discovery says
the full consumer set determines quiescence (`feature-spec.md:88-90`). Those differ for read-only
consumers. The lifecycle also says "restart exactly" without naming a Docker operation
(`feature-spec.md:110-120`). Existing `startServices()` uses `docker compose up -d
--remove-orphans`, which may recreate/start dependencies and mutate orphans
(`packages/rfapps-cli/src/lib/docker.ts:711-752`); it is not safe for exact restoration.

Smallest correction:

- Record all consumers in the manifest, but define `writers` as consumers with
  `read_only === false`; set `quiescedServices` to the running writers only.
- After `stop`, re-observe every writer and refuse to archive if any remains running.
- Restore captured services with targeted `docker compose start <services>`, not the existing
  `startServices()`/`up` helper. Revalidate Compose and authority before restart, but never let a
  revalidation error suppress the restart attempt.
- Define compound failure precedence: the result must retain both the primary stop/archive failure
  and every restart failure.

### [Important] Keep the coordinator split, but do not create a generic backup framework

The proposed command/action/library/type split is consistent with mature rfapps commands
(`feature-spec.md:187-190` and `research-architecture.md:37-46`). Keep planning, execution, and
verification as focused functions with injected Docker/filesystem seams. Do not add a plugin system,
state-database table, retention manager, or generalized archive abstraction for a single v1
producer. A small backup-specific stream adapter is the simpler boundary.

## KISS Assessment

### [Important] Separate release atomicity from PR size

`feature-spec.md:210-216` correctly rejects database hooks, restore execution, scheduling, remote
storage, encryption, and additional mount types as prerequisites. Its conclusion that producer and
verifier belong to one user-visible release is also sound. It does not follow that all work belongs
in one PR.

Smallest correction: use two child implementation issues or stacked PRs:

1. strict manifest/planner, binary Docker adapter, cold creation, lifecycle tests;
2. offline verifier, command/output integration, three-shell completions, public docs and roadmap.

Do not expose or close the parent until both land. If the team strongly prefers one PR, use the same
two commits/review boundaries. This is important for reviewability, not a product blocker.

### [Optional] Keep destination and helper policy command-local in v1

The spec's required `--destination` is safer and simpler than adding a new configuration section
(`feature-spec.md:45-58`). Likewise, one source-controlled helper-image constant is sufficient.
Configuration for defaults, exclusions, retention, or multiple archive engines would be premature.

## Abstraction Recommendations

### [Blocking] Reject a local destination contained by an eligible bind source

The spec validates the destination but does not compare it with selected bind sources
(`feature-spec.md:53-67, 104-116`). With a local Docker authority, placing the staging/bundle
directory inside a bind source makes the helper tar observe the archive while it is being written.
That can recursively grow the archive or produce corrupt, unbounded output.

Smallest correction: during preflight, after canonical destination and bind identities are known,
reject any local staging/final bundle path equal to or nested beneath an eligible bind source. Make
this a usage error (`2`) before helper acquisition or service stop. Record that remote Docker
authorities use daemon-host bind paths and client-local destinations, so lexical equality alone must
not be treated as shared filesystem identity.

Also state whether the destination base must already be an owned, writable, non-symlink directory or
may be created. Requiring an existing real directory is the smallest fail-closed contract.

### [Important] Resolve the staging cleanup contradiction

The lifecycle says current-attempt staging paths are removed on failure
(`feature-spec.md:115-116`), then permits retaining staging after restart failure
(`feature-spec.md:118-120`). This leaves cleanup behavior and machine output indeterminate.

Smallest correction: choose one rule. Recommended: remove staging after pre-stop/stop/archive
failures once restart succeeds; retain the private, manifest-less staging directory only when restart
itself fails, and return its path plus `stagingDisposition: "retained-incomplete"`. Verification must
reject it because no published manifest exists.

### [Important] Pin the helper image contract

"Fixed helper image" is not enough to implement or audit
(`feature-spec.md:107, 138-139`). Name a source-controlled digest-pinned reference, say whether a
missing image is pulled, and require its local immutable ID to be resolved before stopping services.
Dry-run should report the requested reference but perform no image lookup/pull, as already required
by `feature-spec.md:53-54`.

## Interface Design

### [Blocking] Define create and verify terminal result schemas and supported formats

The manifest is described in detail, but the terminal result is only described as "exactly one"
structured value (`feature-spec.md:141-174`). Implementers cannot derive stable JSON, dry-run,
failure, restart-failure, or verification outputs from that. The repository globally advertises
JSON, YAML, CSV, table, and text, with JSON/YAML/CSV classified as machine formats
(`packages/rf-common/src/output.ts:9-23, 40-42, 78-90`;
`docs/features/output-formats.md:9-24`).

Smallest correction:

- Define versioned `rfapps-backup-result.v1` and `rfapps-backup-verify-result.v1` envelopes with
  `status`, `success`, `exitCode`, `dryRun`, requested/resolved/writer/previously-running scopes,
  destination/bundle/manifest paths when applicable, complete planned/skipped/artifact outcomes,
  bounded stable error codes, restart failures, warnings, and summary counts.
- Define human text/table rendering separately; plans/progress remain on stderr.
- Support JSON and YAML as one document. Either define an honest flat CSV row contract or reject CSV
  with exit `2`; do not silently drop nested evidence. State whether table is a human summary.
- Define strict restore-hint discriminated unions for bind and named-volume destinations rather than
  leaving `strategy` and `destination identity` to interpretation
  (`feature-spec.md:150-156`).
- Define whether undeclared files under `artifacts/` are ignored or reported. Reporting them with a
  stable code best matches the completeness goal.

### [Important] Make explicit targeting bypass the existing implicit-all behavior

The spec requires an explicit target/`--all` outside an interactive human terminal
(`feature-spec.md:45-58`). The shared resolver currently returns an empty list meaning all services
for non-TTY, JSON, or `--yes`, and its interactive predicate suppresses only JSON, not YAML/CSV
(`packages/rfapps-cli/src/lib/interactive-selection.ts:76-78, 161-180`;
`packages/rfapps-cli/src/lib/interactive-check.ts:14-25, 53-73`).

Smallest correction:

- Validate `--all` versus `-s`/`--services`/`-g` before calling the resolver.
- Make `--all` bypass the selector and explicitly materialize all Compose services.
- Before selection, reject no-target invocation when non-TTY, `--yes`, JSON, YAML, or CSV is active.
  Treat table/text as human formats, consistent with `isMachineFormat()`.
- Test `--all` expansion, `--all` conflicts, YAML/CSV no-target rejection, and interactive
  cancellation. Do not change shared selection semantics for unrelated commands merely to support
  backup.

### [Important] Clarify remote bind classification and read-only policy

The spec correctly makes directory binds and stable named volumes eligible and records explicit
skips (`feature-spec.md:81-98`), but it does not say how a remote daemon's bind is proved to be a
directory. Client-side `stat()` is incorrect for `DOCKER_HOST`/contexts. It also risks conflating a
read-only consumer with nonessential data.

Smallest correction: classify bind source kind/existence through the selected Docker authority
(for example, a no-archive helper probe) before stopping services; never inspect a remote bind path
on the client. A read-only mount remains eligible unless it matches a stable unsupported/system
reason. Use all consumers for provenance and only writable consumers for quiescence. Publish the
exact stable skip/failure code table.

## Testability

The six test groups in `feature-spec.md:176-193` are generally contract-focused and avoid repeating
generic Docker retry, formatting, selection, and hashing coverage.

### [Important] Add the few missing distinct safety tests

Add focused cases for:

- destination-inside-bind refusal before mutation;
- both lock namespaces and lock-free dry-run/verify;
- post-stop observation refusing a still-running writer;
- targeted `compose start` restoring exactly the captured set after success and archive failure;
- remote bind classification through Docker authority rather than local `stat`;
- the two versioned terminal result envelopes and CSV support/refusal.

These prove new boundaries and are not redundant with generic Docker or filesystem tests.

### [Important] Completion parity alone does not prove path completion

`feature-spec.md:189-190` requests one parity test, while acceptance additionally requires path
completion (`feature-spec.md:232-233`). Commander option parity cannot prove that `--destination`
completes directories or that `backup verify <manifest>` completes files.

Smallest correction: retain one table-driven Bash/Zsh/Fish option-parity test and one nested-context
disjointness test, then add one three-shell value-completion assertion covering destination
directory completion and the verify manifest operand. Do not create per-shell copies.

## Build vs. Depend

- Use Node 22 streams, `crypto`, `zlib`, filesystem handles, and child processes. Do not add a tar
  dependency merely to run the helper's tar command.
- Do not reuse bounded UTF-8 `execDocker()` for archive bytes
  (`feature-spec.md:126-137`). Add one narrow binary stream-to-file adapter while reusing existing
  environment, timeout, signal, bounded-stderr, and retry policy.
- Do not add application-specific database libraries or archive extraction code; both are explicit
  non-goals (`feature-spec.md:25-35`).

## Documentation and Roadmap

### [Important] Correct the required documentation set

`feature-spec.md:195-208` includes the core operator pages but omits two current public surfaces:
the root command list in `README.md:59-78` and the global output promise in
`docs/features/output-formats.md:9-24`. Both must change. `packages/rfapps-cli/CLAUDE.md` should also
record the new command/action/coordinator/streaming boundary because it is the maintained package
architecture guide.

Conversely, `docs/roadmap-archive.md` should not be mandatory merely because #160 ships. The active
rfapps follow-on track still includes #152, #161, and #162 (`ROADMAP.md:85-116`). Update
`ROADMAP.md` using live issue totals at merge time and remove #160 from both active tables; archive
the track only when its enclosing narrative actually closes.

Minimum required delivery set:

- `README.md`, `packages/rfapps-cli/README.md`, and `packages/rfapps-cli/CLAUDE.md`;
- new authoritative `docs/features/rfapps-backup.md`;
- `docs/guides/backup-restore.md`, which currently says rfapps has no native backup;
- `docs/README.md`, `docs/features/quick-reference.md`, `docs/features/shell-completion.md`;
- `docs/features/json-output.md`, `docs/features/output-formats.md`, and
  `docs/features/error-handling.md`;
- `ROADMAP.md`, with `docs/roadmap-archive.md` only if the track is truly archived.

Architecture diagrams and broad troubleshooting additions are optional; duplicating the full
operator contract there would add maintenance cost without improving this delivery.

## Resolution Verification

Re-checked against the revised `feature-spec.md` and `shared.md`. All four blocking findings are
resolved. Seven important findings are resolved; two remain narrowly open.

| Original finding                                                      | Status                  | Exact evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Blocking — both concurrency locks and lock-free exceptions**        | **Resolved**            | Creation holds the root state lock, then acquires the project/Docker-authority lifecycle lock; dry-run and verification acquire neither (`feature-spec.md:121-123`). The focused test contract covers both locks and lock-free dry-run/verify (`feature-spec.md:241-250`). The same invariant is frozen in shared context (`shared.md:68-70`).                                                                                                                                                                                                                                                                                                                                                                              |
| **Blocking — exact writer/quiesce/restart contract**                  | **Resolved**            | All consumers are recorded, writers are exactly `read_only === false`, and equal/ancestor/descendant writable overlaps contribute to quiescence (`feature-spec.md:91-100`). The coordinator captures container IDs, re-observes writers after stop, refuses archive with a running writer, restores exact captured IDs without the existing `up --remove-orphans` helper, and retains primary plus recovery failures (`feature-spec.md:124-143`). The consistency label states the precise assurance boundary (`feature-spec.md:145-149`).                                                                                                                                                                                  |
| **Blocking — destination contained by a bind source**                 | **Resolved**            | Local destination and reserved bundle paths are rejected when equal to or below an eligible bind source; the base must already be an owned, writable, real, symlink-free directory, while remote and client paths remain separate authority namespaces (`feature-spec.md:107-110`). Planner tests explicitly cover the refusal (`feature-spec.md:238-240`).                                                                                                                                                                                                                                                                                                                                                                 |
| **Blocking — terminal result schemas and format support**             | **Resolved**            | JSON/YAML are one versioned document, table/text are human, and CSV is a usage error (`feature-spec.md:60-62`). The two schema names and required common/create/verify fields are fixed (`feature-spec.md:208-219`); undeclared artifacts and bounded strict manifest rules are defined (`feature-spec.md:193-200`); restore hints are discriminated bind/volume unions (`feature-spec.md:202-206`).                                                                                                                                                                                                                                                                                                                        |
| **Important — focused coordinator, no generic backup framework**      | **Resolved**            | Shared context freezes Commander/action/dependency-injected-library separation (`shared.md:43-47`). The non-goals exclude database hooks, restore, scheduling, retention, remote storage, encryption, signatures, additional mount kinds, and MCP (`feature-spec.md:25-37`), while the archive boundary stays backup-specific (`feature-spec.md:151-174`).                                                                                                                                                                                                                                                                                                                                                                  |
| **Important — separate release atomicity from review size**           | **Resolved**            | Producer and verifier remain one user-visible release, but the implementation is divided into dependency-bounded batches and commits for reviewability (`feature-spec.md:276-283`). This satisfies the review's stated one-PR fallback without inventing blocking child dependencies.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Important — staging cleanup contradiction**                         | **Resolved**            | Ordinary failures remove the private manifest-less bundle after recovery; recovery failure alone retains it with `stagingDisposition: "retained-incomplete"` and an exact result path (`feature-spec.md:131-143`). The result schema carries all staging dispositions (`feature-spec.md:214-217`).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Important — pinned helper image contract**                          | **Resolved**            | The source-controlled digest-pinned Alpine reference, pre-stop acquisition, immutable daemon-local ID execution, sandbox, and direct tar boundary are explicit (`feature-spec.md:167-174`). Dry-run performs no image pull (`feature-spec.md:55-56`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Important — explicit targeting must bypass implicit-all selection** | **Still open**          | The revision correctly requires an explicit target for non-interactive and machine modes, makes `--all` mutually exclusive, and requires machine mutation authorization (`feature-spec.md:52-62`). It still does not say that human TTY plus global `--yes` with no target is a usage error. The reused selector suppresses interaction for `--yes` and returns its empty-array implicit-all sentinel, so this path can still violate explicit all-services intent. Add one sentence that `--yes` never authorizes scope: with no selector target it requires `--all`; also state that `--all` bypasses the selector and is materialized before planning. Add that case to CLI targeting tests (`feature-spec.md:248-250`). |
| **Important — remote bind classification and read-only policy**       | **Still open (narrow)** | Authority-side bind probing, all-consumer provenance, writable-only writer classification, overlap handling, and explicit system/tmpfs skips are now defined (`feature-spec.md:91-105`), and Docker-adapter tests include remote probing (`feature-spec.md:246-247`). The remaining gap is that the promised “stable reason codes” are not enumerated. Add the exact skip/fail code union for tmpfs, read-only system file, socket/device, protected root, anonymous volume, unknown type, missing source/volume, non-directory bind, ambiguous path, and nested source.                                                                                                                                                    |
| **Important — missing distinct safety tests**                         | **Resolved**            | The revised critical suites cover destination containment, both locks, post-stop observation, exact-ID recovery after partial stop/archive failure/interruption, remote bind probing, versioned envelopes, and CSV refusal (`feature-spec.md:238-250`) while retaining the explicit prohibition on duplicating generic coverage (`feature-spec.md:255-256`).                                                                                                                                                                                                                                                                                                                                                                |
| **Important — completion path behavior beyond option parity**         | **Resolved**            | The test contract now requires both one table-driven three-shell Commander/nested-context parity test and one three-shell destination/manifest path-value assertion (`feature-spec.md:251-253`); acceptance requires matching top-level, nested, and path completion (`feature-spec.md:301-302`).                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Important — required documentation and roadmap set**                | **Resolved**            | The delivery now includes root/package/docs navigation, package architecture guidance, output-formats, operator, JSON/error/completion/quick-reference documentation, and live `ROADMAP.md`; `docs/roadmap-archive.md` is conditional on actual track archival (`feature-spec.md:258-274`).                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The two remaining items are important but localized. They do not reopen the four safety/public-
contract blockers once the target gate and stable reason-code union are added.

### Final Re-check

Both previously open important items are now **resolved**:

- **Explicit targeting versus implicit all:** `feature-spec.md:52-56` now makes a human TTY with
  global `--yes` require an explicit target or `--all` and explicitly forbids inheriting the shared
  resolver's implicit-all sentinel. Mutual exclusion remains fixed at `feature-spec.md:61`.
- **Stable mount classification codes:** `feature-spec.md:114-120` now enumerates the complete v1
  skip and preflight-failure code unions, including tmpfs/system/socket/device skips and anonymous,
  unsupported, missing, non-directory, nested, ambiguous, destination-containment, and probe
  failures.

Final status: all blocking and important completeness findings are resolved.
