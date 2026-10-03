# Safety Design Review: Issue #160 Native Backup

## Verdict

The proposed cold-backup/verify slice is appropriately narrow, but the current feature spec is not
implementation-ready. Four blocking corrections are needed before the acceptance criteria can be
claimed truthfully. The most serious issue is repository-specific: exact-source consumer matching
does not quiesce services that mount a parent or child of the selected bind source.

## Blocking Findings

### B1. Exact-source matching misses overlapping bind-mount writers

**Spec:** `Storage Discovery and Classification` says exact duplicate sources are deduplicated, a
selected source's full consumer set determines the quiesce set, and nested _selected_ sources fail
preflight (`feature-spec.md:86-98`). `Acceptance Criteria` requires every running writer of selected
storage to be stopped (`feature-spec.md:220-227`).

**Code/repository evidence:** `compose.yml` contains writable parent mounts such as `${DATA_DIR}` for
`slskd`, `unpackerr`, `sonarr`, `radarr`, and `lidarr`, while other services mount children including
`${DATA_DIR}/media`, `${DATA_DIR}/downloads`, `${DATA_DIR}/usenet`, and `${DATA_DIR}/photos`
(`compose.yml:714-717`, `751-754`, `811-814`, `872-875`, `970-972`, `986-991`, `1022-1025`,
`1062-1065`, `1106-1109`, `1239-1245`, `1516-1519`). The canonical projection exposes source
strings and `read_only`, but no overlap graph
(`packages/rfapps-cli/src/lib/docker-conflict-evidence.ts:63-78,356-381`).

Selecting a child while a running service has its parent mounted writable, or selecting a parent
while another service has a writable child mount, leaves a Compose-declared writer active. That is
not a cold backup.

**Smallest correction:** Define bind-source overlap as part of planning, across **all writable bind
mounts in the full resolved Compose model**, not only selected sources. For each selected bind root,
add consumers of equal, ancestor, and descendant writable roots to the quiesce set. Continue to fail
preflight when two selected archive roots overlap. Because client-side `realpath()` is invalid for a
remote daemon, specify a daemon-authoritative normalization/probe or fail closed when equivalence or
containment is ambiguous (including aliases). Add a planner test using the repository's
`${DATA_DIR}`/`${DATA_DIR}/media` shape.

### B2. “Restart exactly what was running” is not defined at container granularity

**Spec:** `Cold-Backup Lifecycle` captures service running state, stops services, and restarts
exactly those previously running, including from a `finally` boundary
(`feature-spec.md:100-120`). The acceptance criterion also covers failure paths
(`feature-spec.md:224-225`).

**Code evidence:** Runtime evidence is container-granular and includes container IDs
(`packages/rfapps-cli/src/lib/docker.ts:1322-1328,1520-1529`). In contrast,
`stopServices()` operates on Compose service names, and `startServices()` uses
`docker compose up -d --remove-orphans` (`packages/rfapps-cli/src/lib/docker.ts:711-752,758-786`).
`up` can start dependencies, recreate containers, or remove unrelated orphans; it also cannot
preserve a mixed scaled-service state where one replica was running and another was stopped.
Additionally, a failed or timed-out stop can have stopped only part of the set.

The existing Docker signal forwarding re-sends SIGINT/SIGTERM to the parent as soon as the last
child settles (`packages/rfapps-cli/src/lib/docker.ts:156-175,364-379`), which can terminate the
process before a coordinator continuation reaches its restart `finally`.

**Smallest correction:** Capture the IDs of every initially running Compose container. Once any stop
is attempted, always enter stabilization, re-observe actual state even if stop returned failure, and
idempotently start every initially-running ID that is now stopped. Start container IDs in
dependency-first service layers and report container-level recovery failures; do not use the current
`startServices()` boundary. Hold parent signals as coordinator state and re-raise only after recovery
and cleanup complete. Pin the execution environment/daemon identity for recovery rather than
re-reading mutable Compose files. Test partial-stop failure, mixed scaled replicas, dependency
ordering, SIGINT during archive, and restart failure aggregation.

### B3. Portable no-clobber and atomic directory publication are mutually underspecified

**Spec:** The bundle path is no-overwrite (`feature-spec.md:59-67`), the completed bundle directory
is atomically published (`feature-spec.md:114-116`), and existing paths are never overwritten
(`feature-spec.md:158-160`).

**Code evidence:** The available artifact precedent performs an existence check and then
`rename(tempPath, artifactPath)` (`packages/rfapps-cli/src/lib/plan-storage.ts:1206-1264`). That is a
check/rename race, and POSIX rename may replace an existing empty destination directory. Node's
portable rename API has no `RENAME_NOREPLACE` equivalent. Merely making staging a sibling guarantees
same-filesystem rename, not no-clobber publication.

**Smallest correction:** Atomically reserve the final private bundle directory up front with
exclusive `mkdir` and an unpredictable suffix. Treat “no `manifest.json`” as the incomplete marker;
do not promise invisible/atomic directory publication. Write each artifact to an exclusive temporary
file, sync and close it, then publish within the reserved directory. Publish the final manifest with
an atomic **no-replace** primitive (for example, link an fsynced temporary regular file to the absent
final name), then sync the bundle and destination directory. State that cross-filesystem fallback is
not allowed. Revise the acceptance language to “a partial directory cannot be mistaken for a valid
bundle because the final manifest is absent.”

### B4. Retrying or timing out an archive stream cannot simply “match execDocker”

**Spec:** The archive adapter streams binary stdout and says timeout, cancellation, signal
forwarding, and SSH retry behavior match existing Docker adapters
(`feature-spec.md:126-139`).

**Code evidence:** `execDocker()` retries the whole command after SSH-like stderr and has a five
minute wall-clock default (`packages/rfapps-cli/src/lib/docker.ts:104-117,424-476`). A streaming
attempt may already have written compressed bytes when the SSH error arrives. Retrying into the same
pipeline corrupts the archive, while a fixed five-minute timeout makes large media/data backups
predictably fail. The current capture adapter also terminates on bounded stdout, which is why it
cannot be reused (`packages/rfapps-cli/src/lib/docker.ts:336-360`).

**Smallest correction:** Define each Docker attempt as a fresh helper, gzip, hash, counter, and
exclusive temporary file. On a retry, destroy the pipeline, remove the helper and temporary file,
reset all state, and restart from byte zero; never append or retain a prior digest. Require both the
Docker child and the complete sink pipeline to succeed. Replace the inherited five-minute wall
timeout with a documented configurable archive timeout or a bounded inactivity timeout suitable for
large streams. Hash and count the final compressed bytes that `verify` will later read. Add tests for
an SSH failure after emitted bytes, sink failure, child failure after stdout, timeout, and cleanup.

## Important Findings

### I1. The consistency and lock claims exceed the observable authority

`Design Goals` and `Acceptance Criteria` refer to “every running writer”
(`feature-spec.md:13-17,224-225`), but the design observes only services declared in one resolved
Compose project. Host processes, containers from other projects, and another client operating the
same remote daemon are outside that graph. The global state lock is local
(`packages/rfapps-cli/src/cli.ts:61-107,302-305`); the lifecycle lock key also contains a local
canonical project path and lives in a local state directory
(`packages/rfapps-cli/src/lib/lifecycle-lock.ts:116-135,206-218,405-417`). It is cooperative rfapps
exclusion, not a daemon-distributed lock.

Reword the guarantee to “all detected writable consumers in the resolved Compose project were
stopped under local cooperative rfapps locks.” Re-observe the quiesce set immediately after stop and
before each archive, and fail closed if any declared consumer is running. Record this scope
limitation in manifest consistency metadata/warnings. Do not imply that the lock excludes external
Docker or filesystem mutation.

### I2. Helper-image identity and sandboxing need an execution contract

`Cold-Backup Lifecycle` inspects an immutable local helper identity before stopping services, but
`Archive Adapter` does not require execution by that identity (`feature-spec.md:107-113,138-139`).
A tag can be retargeted between inspect and run. A helper also needs an explicit cleanup identity
after a client/SSH disconnect.

Require running the inspected daemon-local immutable image ID (or verified digest), not the mutable
tag. Specify a unique attempt/container name and label, `--network none`, read-only root filesystem,
capability drop, `no-new-privileges`, exactly one read-only source mount, and an explicit tar
entrypoint/argv. Validate or reject bind paths that cannot be represented safely in Docker's
comma-delimited `--mount` operand; an argv array alone does not make that mini-language safe. Cleanup
must target only the current attempt by captured ID/label and be idempotent.

### I3. Offline verification needs explicit resource bounds and open-file checks

`Verify a Backup` and `Manifest Contract` require a strict schema and symlink refusal
(`feature-spec.md:69-79,141-161`), but the spec does not set maximum manifest bytes, entry counts,
string lengths, warning counts, declared sizes, or uniqueness rules. An untrusted manifest can cause
memory exhaustion or unbounded filesystem work.

Add bounds and require unique mount IDs and archive paths. Open the manifest itself and each archive
with `O_NOFOLLOW`, compare pre-open `lstat` with opened `fstat` device/inode, require a regular file,
and stream from that held handle. Apply the symlink-component rule to the supplied manifest path as
well as bundle-relative artifacts. The existing safe-reader precedent demonstrates bounded input
and identity comparison (`packages/rfapps-cli/src/lib/plan-storage.ts:1276-1306`).

### I4. Failure cleanup and retained staging contradict each other

Step 10 says current-attempt staging paths are removed on failure, while the following paragraph
allows staging retention after restart failure (`feature-spec.md:116-120`). Choose one deterministic
policy. The smallest safe contract is: remove staging after ordinary preflight/archive failure once
services are restored; retain a private, explicitly incomplete directory only when recovery itself
fails, omit `manifest.json`, and include its exact path in the terminal failure result. Never rely on
an undeclared partial directory as the only recovery mapping.

## Optional Improvements

- Quiesce only writable overlapping consumers; read-only consumers can remain running. The current
  “full consumer set” wording causes avoidable downtime (`feature-spec.md:88-90`).
- Give each manifest entry separate archive-start/archive-complete timestamps. Bundle-level
  timestamps alone do not show the sequential consistency window.
- State whether unexpected files under `artifacts/` are ignored or reported. Verification of
  declared bytes remains valid either way, but deterministic operator evidence benefits from an
  explicit rule.

## Required Spec Edits Summary

1. Replace exact-only consumer discovery with a full-project writable overlap graph.
2. Define container-ID recovery, partial-stop reconciliation, dependency ordering, and deferred
   signal re-raise.
3. Replace atomic directory publication with exclusive directory reservation plus atomic
   no-replace manifest publication and directory fsync.
4. Define restart-from-zero streaming retries and a large-backup-appropriate timeout.
5. Narrow consistency/lock claims to observed Compose consumers under cooperative local locking.
6. Bound verifier inputs and fully specify helper identity, sandboxing, and cleanup.

## Resolution Verification

Rechecked against the updated `feature-spec.md` and `shared.md`. All blocking and important findings
are resolved at the design-contract level:

- **B1 — Resolved.** Planning now evaluates writable equal, ancestor, and descendant bind mounts
  across the full resolved project, fails closed on ambiguous/unrepresentable paths, and includes a
  repository-shaped overlap test (`feature-spec.md:91-110,238-240,291-293`;
  `shared.md:3-8,49-55`).
- **B2 — Resolved.** The lifecycle captures exact running container IDs, re-observes after every stop
  attempt, recovers missing IDs in dependency-first layers, avoids Compose `up`, preserves partial
  stop/recovery failures, and defers signal re-raise until stabilization completes
  (`feature-spec.md:124-143,241-243,291-293`; `shared.md:57-60`).
- **B3 — Resolved.** The final private directory is exclusively reserved up front; validity is
  manifest-last; the manifest uses atomic no-replace publication followed by bundle/destination
  directory sync; cross-filesystem publication is rejected
  (`feature-spec.md:118-119,131-136,193-200,294-296`; `shared.md:62-66`).
- **B4 — Resolved.** Every retry owns fresh helper/compression/hash/count/file state, restarts from
  byte zero after any producer or sink failure, and uses a large-stream inactivity timeout rather
  than the existing five-minute wall timeout (`feature-spec.md:151-174,246-247`;
  `shared.md:72-74`).
- **I1 — Resolved.** The guarantee is explicitly limited to detected writable consumers in one
  resolved Compose project under local cooperative locks; external clients, projects, and host
  writers are non-goals and recorded consistency limitations
  (`feature-spec.md:15-17,31-35,121-125,145-149`; `shared.md:68-70`).
- **I2 — Resolved.** The helper is digest-pinned, resolved and executed by immutable daemon-local ID,
  sandboxed, uniquely identifiable, read-only, shell-free, and protected against unsafe Docker
  mount operands (`feature-spec.md:167-174,246-247`; `shared.md:6-8,72-74`).
- **I3 — Resolved.** The verifier now has explicit manifest/entry/warning/string bounds, unique IDs
  and paths, no-follow plus path/handle identity checks, regular-file enforcement, and a defined
  unexpected-artifact policy (`feature-spec.md:193-200,244-245`;
  `shared.md:76-78`).
- **I4 — Resolved.** Ordinary failures remove the manifest-less directory after successful recovery;
  only recovery failure retains it, with a typed disposition and exact path in the terminal result
  (`feature-spec.md:134-143,214-219`; `shared.md:62-66,80-82`).

No blocking or important safety-design finding remains open. Implementation must still prove these
contracts with the critical tests enumerated in `feature-spec.md:234-253`.
