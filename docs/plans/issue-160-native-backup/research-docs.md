# Documentation Research: issue-160-native-backup

Issue #160 needs a first-class operator contract, not only a new row in the command reference.
The repository currently documents manual application backups, an rfapps-state-database export,
and image-only rollback as three different recovery mechanisms; native file/volume backup and
offline verification must be added without conflating those boundaries. The most urgent correction
is `docs/guides/backup-restore.md`, which explicitly and repeatedly says that rfapps has no backup
capability.

## Architecture Docs

- **Required — `docs/architecture/data-flow.md`:** Add separate create and offline-verify flows.
  Creation crosses Commander → action → backup coordinator → resolved Compose/Docker storage →
  private artifacts and manifest. `rfapps backup verify` must instead read only the supplied bundle
  and must not load Compose, contact Docker, inject secrets, prompt, or acquire a mutation lock.
  Preserve the existing statement that managed-update restore is image-only; backup creation does
  not make `rfapps rollback` data-aware.
- **Required — `packages/rfapps-cli/CLAUDE.md`:** This is the package's maintained developer
  architecture guide. Add the command/action/library/type files, backup and verify boundaries,
  binary-streaming and manifest-validation rules, result/exit-code conventions, completion parity,
  and focused test locations. Its current “Adding a New Command,” structured-error, stderr/stdout,
  action aggregation, and command/action separation sections are mandatory implementation guidance.
- **Optional — `docs/architecture/overview.md`:** Its general command/action/library layering
  already fits the feature. Add a short backup artifact boundary or diagram only if the new workflow
  is intended to be part of the high-level architecture; do not duplicate the detailed feature
  guide here.
- **Optional — `docs/reference/architecture-diagram.md`:** This is primarily service, network, and
  profile topology. It does not need a backup flow unless maintainers want storage/DR represented in
  the system diagrams.
- **Keep accurate — `docs/features/deployment-rollback.md`,
  `docs/features/plan-apply-workflow.md`, and the managed-update sections of
  `docs/architecture/data-flow.md`:** Their claims that rollback/recovery changes images but never
  restores volumes, databases, application data, or migrations remain true. Add a cross-link to the
  native backup guide if useful, but do not rewrite backup creation as automatic rollback.

## API and CLI Docs

- **Required — new `docs/features/rfapps-backup-command.md`:** Make this the canonical feature
  contract. Document `rfapps backup` targeting, destination/default naming, sidecar and shared-mount
  behavior, bind versus named-volume eligibility, exclusions, consistency level, confirmation,
  `--dry-run`, interruption/cleanup, private permissions, no-overwrite behavior, manifest schema,
  restore hints, and exit codes. Give `rfapps backup verify <manifest>` its own section emphasizing
  that it is offline, read-only, Docker-independent, configuration-independent, and verifies bytes
  and manifest invariants without extracting or restoring.
- **Required — `packages/rfapps-cli/README.md`:** Add `backup` to the feature list and command
  reference, update the state-lock coverage text to distinguish creation from lock-free
  verification, document exact options/examples and structured results, and cross-link the feature
  guide. Explicitly distinguish native service-data backup from `rfapps state export`, the
  `rfapps drift import --backup` Compose `.bak`, and image-only `rfapps rollback`.
- **Required — `docs/features/quick-reference.md`:** Add concise create, scoped/group, dry-run, and
  offline-verify examples plus the consistency/restore limitation. This is the operator cheat sheet
  and currently has no backup section.
- **Required — `docs/features/shell-completion.md`:** Add `backup` to the documented top-level
  command list, describe the nested `verify` context, path completion for destination/manifest
  operands, and service/group/profile completion for creation. State that Bash, Zsh, and Fish must
  match Commander and that completion never runs verification or authorizes a backup.
- **Required — `docs/features/json-output.md`:** Add the versioned create and verify envelopes once
  their schema names are settled, with complete per-artifact accounting and examples for success,
  mismatch, missing artifact, skipped source, and partial/failed outcomes. Preserve clean stdout:
  progress and human warnings belong on stderr.
- **Required — `docs/features/output-formats.md`:** Record the actual format support for both
  creation and verification. Its current wording implies every command accepts JSON, YAML, CSV,
  table, and text; if nested backup results cannot truthfully flatten to CSV, document and enforce
  that exception as a usage error rather than silently degrading the contract.
- **Required — `docs/features/error-handling.md`:** Add backup/verification exit semantics and
  stable machine-readable failure codes. Generalize the top-level exit-code table: exit `3` is
  already a shared partial-success category, not only “mixed deploy result with
  `--allow-partial`.” Distinguish malformed/unsafe manifest usage from checksum/size/missing-file
  integrity failures and from Docker/filesystem operational failures.
- **Required — `docs/guides/backup-restore.md`:** Replace the stale “Built-in Backup System” and
  “Modern Backup Approach” claims at lines 52–55 and 120–121 that rfapps has no backup
  functionality. Lead with the native workflow, then retain the useful manual database-native and
  restore procedures. Explain that a checksum-valid filesystem archive is not an application-aware
  database dump or a successful restore test. The legacy `manage.sh` section may remain explicitly
  historical, but it must no longer direct all users exclusively to manual backup.
- **Optional — `docs/features/file-integrity-verification.md`:** Reuse its language that SHA-256 is
  local byte-integrity evidence, not a digital signature or source-authenticity proof, and its
  bounded/stable-read expectations. Keep it rfmedia-specific; link or quote the principle rather
  than presenting `rfmedia verify` as the backup verifier.
- **Optional — `docs/guides/troubleshooting.md`:** Add a short diagnosis table for malformed
  manifests, unsafe relative paths, missing archives, size/hash mismatch, unsupported schema, and
  Docker/helper failures. Its existing database restore commands remain manual recovery guidance.

## Development Guides

- **Required — `ROADMAP.md`:** On delivery, update the open-issue totals, the “Current focus”
  sentence, the `Next Up` row for #160, and the rfapps medium-priority backlog table using live
  GitHub state. Follow its maintenance rule: update `Next Up` and the relevant backlog when work
  closes; move narrative to `docs/roadmap-archive.md` only when the full sprint/track closes.
- **Optional — `docs/roadmap-archive.md`:** Do not move the active “rfapps after staged deploy”
  narrative here merely because #160 ships. Add an operator note only if the enclosing track is
  being archived or the maintainers intentionally treat native backup as a shipped lifecycle
  milestone.
- **Required reading — `research/rfapps-new-features/persona-findings/negative-space.md`:** Issue
  #160 names this source. Sections 1.1 and 6.3 define the original gap: scoped volume backup,
  database consistency, verification, scheduling, and manifest tracking. Treat it as historical
  research, not the final v1 acceptance contract.
- **Required reading — `research/rfapps-new-features/persona-findings/archaeologist.md`:** Issue
  #160 also names this source. The ISPConfig discussion supplies the service-category and scheduled
  backup/restore analogy. It does not require scheduling in v1; scheduling was an informing pattern.
- **Optional context — `research/rfapps-new-features/report.md`,
  `research/rfapps-new-features/objective.md`, and
  `research/rfapps-new-features/synthesis/negative-space.md`:** These explain why backup was
  prioritized and why application migrations and restore testing remain hard. They are dated
  research snapshots. Do not rewrite their original findings as if the research had always included
  rfapps backup; optionally add a clearly dated outcome/link after delivery.
- **Optional — `docs/guides/getting-started.md`:** Add “create and verify an initial backup” to
  post-install operations only if the command is safe and sufficiently bounded for a default-stack
  recommendation. Avoid implying that a first filesystem archive replaces database-native or
  off-site backups.

## README Files

- **Required — `README.md`:** Add `rfapps backup` to the management-command list and link the
  canonical feature/backup guide. Keep the nearby managed-update recovery caveat image-only and add
  one sentence distinguishing proactive data backup from rollback.
- **Required — `docs/README.md`:** Add the feature guide to the feature index, add `rfapps backup`
  to the command table and quick examples, and update the backup-and-restore guide description.
  Its current update-recovery caveat remains correct.
- **Required — `packages/rfapps-cli/README.md`:** This is the full public CLI reference and needs
  the detailed contract described above, including output, locking, exit, consistency, and restore
  boundaries.
- **No change needed — `packages/rf-common/README.md` and
  `packages/rfmedia-cli/README.md`:** They do not enumerate rfapps operations or define Docker
  backup behavior. Change them only if shared output primitives or rfmedia integration is added,
  neither of which issue #160 requires.

## Must-Read Documents

Required before implementation:

1. `docs/guides/backup-restore.md` — current data inventory, service-specific dump/restore
   procedures, safety advice, and the exact stale no-backup claims.
2. `packages/rfapps-cli/README.md` — public command, lock, output, state export, rollback, and exit
   conventions.
3. `packages/rfapps-cli/CLAUDE.md` — command/action/library layering, output discipline, typed
   errors, aggregation, testing, and documentation requirements.
4. `docs/features/shell-completion.md` and
   `packages/rfapps-cli/src/actions/completion.ts` — user contract plus the hand-maintained Bash,
   Zsh, and Fish templates. The source comments and command lists show that all three surfaces must
   be changed together and that generated scripts are written to stdout.
5. `docs/features/json-output.md`, `docs/features/output-formats.md`, and
   `docs/features/error-handling.md` — machine-output, stdout/stderr, supported-format, failure
   envelope, and exit-code promises.
6. `research/rfapps-new-features/persona-findings/negative-space.md` and
   `research/rfapps-new-features/persona-findings/archaeologist.md` — the two issue-named research
   sources.
7. `ROADMAP.md` — live-roadmap closeout rules and the two active #160 entries.

Required code-comment and invariant reading:

- `packages/rfapps-cli/src/lib/plan-storage.ts` — private `0700`/`0600` artifact conventions,
  exclusive/no-overwrite writes, safe paths, and runtime validation of untrusted versioned JSON.
- `packages/rfapps-cli/src/lib/state-rebuild-files.ts` — comments explaining sibling atomic rename,
  mandatory backup ordering, journal-safe SQLite backup, forensic raw-copy limitations, and why
  recovery artifacts are sensitive.
- `packages/rfapps-cli/src/lib/docker.ts` — the current Docker executor's UTF-8 result contract,
  bounded stdout/stderr, timeout, SSH retry, detached-process signal forwarding, and environment
  wrapper behavior. These comments make clear that large binary archives need a streaming boundary,
  not ordinary captured stdout.
- `packages/rfapps-cli/src/cli.ts` — `resolveStateLockOperation()`, global `--dry-run` veto,
  pre-action output validation, registration pattern, and final lock release.
- `packages/rfapps-cli/src/lib/exit-codes.ts` and
  `packages/rfapps-cli/src/lib/error-formatters.ts` — shared `0`/`1`/`2`/`3` categories and typed
  error registration.

Optional pattern reading:

- `docs/features/rfapps-state-rebuild.md` — useful distinctions between a restorable SQLite export,
  forensic raw copy, mandatory backup, and verification; native service backup is not a replacement
  for `state export`.
- `docs/features/deployment-rollback.md` and `docs/features/deployment-history.md` — protect the
  image-only recovery terminology.
- `docs/features/file-integrity-verification.md` — checksum limitations, bounded reads, unstable
  file detection, and cancellation semantics.

## Documentation Gaps

- No canonical document defines `rfapps backup`, its exact syntax, the default destination, whether
  bare invocation means all services, or the manifest/result schema names.
- The sibling research artifacts disagree on consistency: some recommend stopping every consumer
  and recording `services-stopped`, while others recommend a live filesystem archive labeled
  `filesystem-live`. Documentation cannot claim database consistency or atomic group snapshots
  until implementation chooses and tests one contract.
- “Restore hints” are underspecified. The issue asks for hints, not an automated restore command.
  Docs must say whether hints are structured metadata or shell snippets, which paths/names they may
  expose, and that users must stop consumers and validate application-specific prerequisites before
  restoring.
- Offline verification needs an explicit threat model: strict schema/version checks, bundle-relative
  regular-file paths, traversal and symlink refusal, bounded counts/sizes/strings, exact byte count
  and SHA-256, stable reads, deterministic reporting, and no extraction. A valid hash proves only
  that the archive matches the manifest.
- Eligibility policy is undocumented for read-only binds, shared bind sources, named versus
  anonymous volumes, `tmpfs`, sockets, devices, system files, missing sources, and remote Docker
  authorities. `compose.yml` contains examples of all the dangerous categories, so silent omission
  is unacceptable.
- Output contracts are unresolved: exact schema versions, per-entry failure codes, whether skipped
  entries make a backup partial, whether verification reports all failures, and whether CSV is
  supported.
- Security and privacy need first-class documentation. Backup artifacts can contain databases,
  credentials, host paths, and topology; owner-only permissions, no-clobber behavior, sanitized
  diagnostics, relative archive names, and manifest sensitivity are not optional footnotes.
- The word “backup” already means three narrower things in current docs: `state export` copies
  rfapps' SQLite database, `drift import --backup` saves `compose.yml`, and state rebuild writes a
  pre-rewrite database backup. New docs must qualify each use to prevent operators from assuming
  that any one of them protects service data.
- Historical research claims that no Docker Compose CLI provides backup/DR are valid evidence about
  the research period, but become misleading as current product documentation after delivery. Keep
  the findings intact and, if they remain prominently linked, add a dated outcome pointer instead
  of rewriting history.
- Database-aware dumps, tested restore, scheduling, retention, off-site transport, encryption,
  signing, and network reconstruction are not part of the issue's initial file/volume workflow.
  Every public document must identify them as separate capabilities rather than imply full disaster
  recovery from checksummed archives alone.

## Child-Issue Assessment

No blocking child issue is required for the documented v1 vertical slice. Scoped file/named-volume
creation, a versioned manifest, offline `backup verify`, all three shell completions, machine-output
and exit contracts, and the operator docs share one public format and should ship atomically; a
creation-only release would publish a backup format without its required integrity consumer.

Use non-blocking follow-up issues for database/application-native quiesce or dump hooks, automated
restore plus restore testing, scheduling/retention/off-site storage/encryption/signing, and
additional mount/platform support. If maintainers split implementation into child PRs for review
size, that is project management rather than a documentation dependency: the parent should remain
open until creation, offline verification, completions, stale-doc corrections, and roadmap closeout
all land.
