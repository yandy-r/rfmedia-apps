# Context Analysis: issue-160-native-backup

## Executive Summary

Issue #160 is one atomic user-visible delivery: a cold, service-scoped filesystem backup producer
and an offline integrity verifier sharing a strict `rfapps-backup.v1` manifest. Creation must expand
the effective Compose storage graph, stop every detected running writable equal/overlapping
consumer in the resolved project, stream each eligible bind directory or named volume through a
sandboxed Docker helper, recover the exact container IDs that were previously running, and publish
`manifest.json` last. Verification is a separate bounded, no-follow, Docker-independent read path
that never extracts an archive.

The corrected `feature-spec.md` is authoritative. Earlier research suggestions for live backup,
optional backup configuration, partial-success creation, Compose-based restart, atomic directory
rename, or child issues are superseded. Both design reviews confirm that every blocking and
important finding is resolved.

## Architecture Context

- Preserve the established layers:
  `commands/backup.ts` registers and validates Commander syntax;
  `actions/backup.ts` owns configuration, selection, interaction, rendering, and exit state;
  backup-specific `lib/` code owns deterministic planning, coordination, artifact publication, and
  verification through injected dependencies; `types/backup.ts` owns versioned contracts.
- Creation flow:
  resolve canonical project/config/Docker authority and explicit scope → project the normalized
  Compose mount graph → classify/deduplicate sources and build the full writer graph → validate the
  existing destination → reserve a private final bundle → ensure and resolve the helper image →
  hold both lock namespaces and revalidate → capture running writer container IDs → stop writer
  services and re-observe → archive sources → recover exact captured IDs → publish the manifest
  last → emit one terminal result.
- Verification flow:
  open and strictly validate the supplied manifest → resolve only safe bundle-relative artifact
  paths → reject symlink/non-regular substitution → stream size and SHA-256 checks → report all
  declared and unexpected artifacts deterministically. It must not load rfapps config, Compose,
  Docker, secrets, selection, or locks.
- Use `getCanonicalComposeConfigEvidence()` as the authoritative fully interpolated Compose
  boundary. Do not parse raw YAML or colon-delimited mount strings.
- Model all consumers for provenance, but define writers only as consumers with
  `read_only === false`. Writable bind sources equal to, above, or below a selected bind source
  contribute to the quiesce set across the full resolved project.
- Capture recovery state at container granularity. Stop at the service boundary, then start only
  captured container IDs that are no longer running, in dependency-first service layers. Never use
  the existing `startServices()`/`docker compose up --remove-orphans` path for recovery.
- The bundle directory is exclusively reserved up front with mode `0700`; files are `0600`.
  Bundle validity is manifest-last, not atomic directory publication. Archives are closed and
  synced first; the temporary manifest is published with an atomic no-replace regular-file
  primitive, followed by bundle and destination directory sync.
- Creation is all-or-nothing. No valid manifest is published after any archive or recovery failure.
  An ordinary manifest-less attempt is removed after successful recovery; it is retained only when
  recovery fails and is identified as `retained-incomplete`.

## Critical Files Reference

- `docs/plans/issue-160-native-backup/feature-spec.md` — frozen v1 behavior and acceptance
  contract; takes precedence over all older research.
- `packages/rfapps-cli/src/cli.ts` — command registration, global output validation, process exit
  handling, and root state-lock classification.
- `packages/rfapps-cli/src/commands/state.ts` — nested parent/create/read-only subcommand precedent.
- `packages/rfapps-cli/src/commands/update.ts` — service/group option validation precedent.
- `packages/rfapps-cli/src/actions/update.ts` — dependency-injected action, machine-output,
  confirmation, and lifecycle-lock precedent.
- `packages/rfapps-cli/src/lib/managed-update.ts` — typed primary/recovery failure and coordinator
  patterns; do not copy its image-specific behavior blindly.
- `packages/rfapps-cli/src/lib/docker-conflict-evidence.ts` — strict canonical mount and effective
  named-volume projection.
- `packages/rfapps-cli/src/lib/docker.ts` — Docker/Compose authority, runtime observations,
  stop behavior, and the new binary-safe stream/probe/recovery adapter boundary.
- `packages/rfapps-cli/src/lib/interactive-selection.ts` and
  `packages/rfapps-cli/src/lib/services.ts` — selection, group/sidecar expansion, profiles, and
  deduplication; backup must override their implicit-all sentinel.
- `packages/rfapps-cli/src/lib/identity.ts` — canonical Compose identity and one-way Docker-authority
  fingerprint.
- `packages/rfapps-cli/src/lib/lifecycle-lock.ts` — project/Docker-authority mutation exclusion.
- `packages/rfapps-cli/src/lib/plan-storage.ts` — private/no-clobber files, no-follow reads, strict
  untrusted JSON, and fsync precedents; its UTF-8 whole-file hash is not reusable for archives.
- `packages/rfapps-cli/src/lib/state-rebuild-files.ts` — recovery ordering and durable sibling
  publication precedents; backup uses manifest-last reservation instead of directory rename.
- `packages/rfapps-cli/src/lib/errors.ts`,
  `packages/rfapps-cli/src/lib/error-formatters.ts`, and
  `packages/rfapps-cli/src/lib/exit-codes.ts` — typed/sanitized errors and stable exit categories.
- `packages/rfapps-cli/src/actions/completion.ts` and
  `packages/rfapps-cli/src/actions/completion.spec.ts` — hand-maintained Bash/Zsh/Fish surfaces,
  Commander parity, nested context, and path-value completion.
- `packages/rfapps-cli/src/types/index.ts` and `packages/rfapps-cli/src/lib/index.ts` — public
  exports for new contracts and intentionally reusable primitives.
- `compose.yml` — repository-shaped overlap cases (`${DATA_DIR}` and child paths), system/socket/
  device mounts, and the stable named `model-cache` volume.
- `packages/rfapps-cli/CLAUDE.md` — package-level ESM, command/action, output, error, test, and
  documentation rules.

Expected new implementation boundaries are `commands/backup.ts`, `actions/backup.ts`,
`types/backup.ts`, and focused backup-specific planner/coordinator/manifest/verifier modules under
`lib/`. Avoid both a single monolith and a generic backup/plugin framework.

## Patterns to Follow

- **Explicit scope:** Reuse the existing resolver for service/group/sidecar/profile behavior, then
  materialize the complete service list. `--all` bypasses selection and is mutually exclusive with
  service/group selectors. Never persist an empty list as ambiguous “all.”
- **Plan, approve, mutate:** Build one deterministic, complete storage/quiesce plan first. Dry-run
  returns it with zero writes, image pulls, helper creation, stops, locks, or confirmation. A real
  human run asks once; machine creation requires `--yes`.
- **Two locks:** Non-dry-run creation holds the root state lock through CLI pre-action handling and
  the project/Docker-authority lifecycle lock inside coordination, followed by revalidation.
  Dry-run and verification acquire neither.
- **Complete accounting:** Archive an exact duplicate source once while retaining every consumer.
  Every eligible or intentionally skipped source appears in the plan, terminal result, and
  manifest as applicable; unsupported writable persistence fails preflight.
- **Recovery in `finally`:** Once any stop is attempted, stabilization re-observes state and tries
  exact-ID recovery even after partial stop, timeout, archive error, or cancellation. Preserve the
  primary failure and every per-container recovery failure.
- **Fresh stream attempts:** Each retry owns a new helper, gzip/hash/count pipeline, and exclusive
  temporary file. Producer, sink, SSH, timeout, or cleanup failure restarts from byte zero and never
  reuses digest or archive bytes.
- **Strict versioning:** Use exact runtime-validated `rfapps-backup.v1`,
  `rfapps-backup-result.v1`, and `rfapps-backup-verify-result.v1` discriminators with stable unions,
  exact keys, deterministic ordering, and bounded sanitized errors/warnings.
- **Output discipline:** JSON/YAML emit exactly one terminal document; text/table render the same
  typed facts; progress and plans go to stderr. CSV is rejected as usage error because the evidence
  is nested.
- **Strict ESM and built-ins:** Use `node:` imports, repository `.js` import extensions, Node 22
  streams/crypto/zlib/fs/child-process primitives, and argv arrays. Do not add a tar dependency or
  invoke `sh -c`.

## Cross-Cutting Concerns

- **Remote authority:** Bind kind, existence, directory shape, and safe representability are probed
  through the selected Docker authority, never client-local `stat()`. Client-local destinations
  and remote daemon bind paths are separate namespaces and are not compared lexically.
- **Overlap safety:** Selected parent/child bind archive roots fail preflight. All writable
  full-project parent/child consumers still join quiescence. Ambiguous aliases or
  daemon-unrepresentable paths fail closed.
- **Destination safety:** `--destination` is required and must name an existing, owned, writable,
  real directory with no symlinked component. For local Docker only, the destination and reserved
  bundle must not equal or sit below an eligible bind source.
- **Archive sandbox:** Use the fixed digest-pinned Alpine reference from the feature spec, resolve
  its immutable daemon-local image ID before stopping services, and run by that ID with a unique
  attempt identity, no network, read-only root, dropped capabilities, no-new-privileges, one
  read-only source mount, and direct tar argv. Validate Docker's comma-delimited `--mount` encoding.
- **Signal and timeout behavior:** Use a bounded inactivity timeout suitable for large streams.
  SIGINT/SIGTERM request cancellation, but helper cleanup and exact-ID recovery finish before the
  signal is re-raised.
- **Manifest threat model:** Cap the manifest at 4 MiB, mount/artifact entries at 10,000, warnings
  at 1,000, and strings at 4,096 bytes; require unique IDs and archive paths. Reject absolute,
  traversal, escaping, symlinked, or non-regular paths and undeclared regular files in
  `artifacts/`. Open with no-follow semantics and compare path/handle identity.
- **Privacy:** Manifests expose host paths, volume identities, and service topology. Never emit raw
  Docker endpoints, resolved environment values, secrets, unbounded stderr, or unsafe parser
  payloads. SHA-256 proves bytes, not authenticity.
- **Consistency:** Record exactly
  `consistency: "detected-compose-writers-stopped"` plus bounded limitations. This excludes claims
  about host writers, external Docker clients, other Compose projects, alias paths the daemon
  cannot prove, multi-filesystem atomicity, or application/database consistency.
- **Public surface:** Update all three completion templates and their parity/path tests. Update the
  root/package/docs indexes, package architecture guide, canonical `docs/features/rfapps-backup.md`,
  backup/restore guide, quick reference, shell completion, JSON/output/error docs, and live
  `ROADMAP.md`.

## Parallelization Opportunities

Use dependency-bounded workstreams with non-overlapping file ownership:

1. **Contracts and validator:** Define `types/backup.ts`, exact manifest/result unions, bounds,
   deterministic validation, and verifier-focused tests. This freezes interfaces for all other
   streams.
2. **Docker authority adapter:** Implement authority-side source probes, immutable helper
   acquisition, binary stdout streaming, sandbox argv, inactivity/cancellation, cleanup, and exact
   container-ID recovery with focused adapter tests. This can proceed beside schema work once its
   injected interface is agreed.
3. **Pure planner:** Build classification, source deduplication, full-project overlap/writer graph,
   ordering, skip/failure codes, restore hints, and destination-containment checks against injected
   canonical evidence.
4. **Artifact coordinator:** After contracts plus planner/adapter interfaces stabilize, implement
   reservation, two-lock revalidation, stop/re-observe/archive/recovery sequencing, manifest-last
   publication, cleanup disposition, and compound results.
5. **CLI/action/output integration:** Register create and nested verify, enforce target/format/
   confirmation rules, connect output and exit mapping, root-lock classification, barrels, and
   spawned-CLI tests after result contracts stabilize.
6. **Completion and documentation:** Update Bash/Zsh/Fish and public docs after the Commander and
   result surfaces freeze. ROADMAP totals must be refreshed from live issue state at closeout.

Keep co-located tests with each stream. Merge in dependency order: contracts → planner/adapter →
coordinator → CLI/output → completion/docs. Creation and verification must still be released
together; these are review/implementation boundaries, not child-product releases.

## Implementation Constraints

- Required creation syntax is `rfapps backup [selection options] --destination <directory>`;
  verification is `rfapps backup verify <manifest>`.
- A no-target invocation selects interactively only on a human text/table TTY without `--yes`.
  Non-TTY, machine output, or `--yes` requires an explicit selector or `--all`.
- Stable skip codes:
  `NON_PERSISTENT_TMPFS`, `HOST_SYSTEM_PATH`, `SOCKET_SOURCE`, `DEVICE_SOURCE`, and
  `READ_ONLY_SYSTEM_FILE`.
- Stable preflight codes:
  `ANONYMOUS_VOLUME`, `UNSUPPORTED_MOUNT_TYPE`, `BIND_SOURCE_MISSING`,
  `BIND_SOURCE_NOT_DIRECTORY`, `NAMED_VOLUME_MISSING`, `NESTED_SELECTED_BIND`,
  `AMBIGUOUS_BIND_PATH`, `DESTINATION_INSIDE_SOURCE`, and `SOURCE_PROBE_FAILED`.
- Creation/verify exit mapping is `0` success, `1` operational or integrity failure, and `2`
  invalid/unsafe usage or cancelled approval. Creation never returns partial-success `3`.
- Helper reference is fixed to
  `docker.io/library/alpine:3.22.1@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1`.
- Restore hints are strict `bind-tar`/`volume-tar` data unions with destination identity and a
  stopped-writer precondition; never generate executable shell snippets.
- Do not modify `state.db`, add a v1 backup config block/default destination, expose MCP, implement
  extraction/restore, or add application-specific hooks, retention, scheduling, upload,
  encryption/signing, or new mount/platform support.
- Do not duplicate generic retry, formatting, selection, hashing, or filesystem tests. Prove only
  the distinct planner, coordinator/recovery, artifact/verifier, Docker-stream, CLI/output, lock,
  and three-shell completion boundaries listed in the corrected spec.
- `docs/roadmap-archive.md` changes only if the enclosing rfapps track is actually archived.

## Key Recommendations

1. Freeze the shared TypeScript contracts and injected planner/adapter interfaces before parallel
   implementation; they are the dependency seam for safe work distribution.
2. Keep planning pure and deterministic, with full-project overlap analysis separated from Docker
   mutation. Fail every ambiguous persistent-storage case before helper acquisition or service stop.
3. Treat exact recovery as the primary safety invariant: retain Docker authority and captured
   container IDs independently of later Compose parsing, and make recovery unavoidable after the
   first stop attempt.
4. Implement archive transport as a narrow binary-safe Docker boundary, not as an extension of
   bounded UTF-8 `execDocker()` semantics and not as a generic archive framework.
5. Make terminal results the single source for human and machine rendering, failure precedence,
   staging disposition, and exit status. Test the whole contract, including recovery failure.
6. Gate completion and documentation closeout on the finalized Commander/result surfaces, then
   verify Bash/Zsh/Fish parity, exact path completion, stale backup claims, and live roadmap state.
