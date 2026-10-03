# Issue 308 Lock Owner Metadata Error Design

Issue #308 corrects a public machine-readable error taxonomy defect in Lidarr preset apply lock
acquisition. Invalid locally supplied owner metadata currently carries the journal-shaped
`LIDARR_PRESET_JOURNAL_INVALID` code even though no journal exists yet. The fix introduces one
precise lock-metadata code, preserves all existing lock contention, ownership-loss, and journal
semantics, and proves the two validation arms with one focused parameterized test.

## Context and Scope

`acquireLidarrPresetApplyLock()` validates three pieces of owner metadata before or during shared
lock acquisition: hostname, PID, and the ownership UUID. The hostname/PID validation and the UUID
validation are separate after the secure-store migration, but both still throw
`LIDARR_PRESET_JOURNAL_INVALID`.

The error is user-visible even though the persistence error type is not a package-barrel export.
`readLidarrFailureMetadata()` structurally reads `.code`, and `reportLidarrFailure()` forwards it
verbatim into the JSON, YAML, and CSV failure envelope for `lidarr presets apply`. Human output uses
the unchanged secret-free message.

GitHub issue #308 is open, has no parent, and has no child issues. Its implementation remains a
single cohesive change; creating child issues would split one atomic contract correction without
creating independently deliverable value.

## Decision

Add `LIDARR_PRESET_LOCK_METADATA_INVALID` to `LidarrPresetPersistenceErrorCode` and use it at both
owner-metadata validation sites:

- invalid or empty hostname;
- non-positive or unsafe PID;
- an injected ownership token that is not accepted by `SECURE_STORE_UUID_PATTERN`.

The name follows the existing `LOCK_METADATA_INVALID` taxonomy in both rfapps lifecycle and state
locks. The more general `LIDARR_PRESET_LOCK_INVALID` was considered and rejected because it could be
read as covering corrupt persisted lock records. Those records intentionally remain a contention
safety result (`LIDARR_PRESET_ALREADY_RUNNING`) and are outside this issue.

## Preserved Contracts

- A live or conservatively unreadable competing lock remains `LIDARR_PRESET_ALREADY_RUNNING`.
- Lost ownership after successful acquisition remains `LIDARR_PRESET_LOCK_LOST`.
- Origin and journal validation remain `LIDARR_PRESET_JOURNAL_INVALID`.
- Shared secure-store errors keep their existing total translation.
- The human-facing message remains `Preset lock owner metadata is invalid` and carries no rejected
  value or sensitive path.
- No command, option, argument, output schema, or successful-result shape changes.

## Critical Verification

Add one table-driven test to the existing `Lidarr preset origin lock` suite. Its three rows inject an
empty hostname, PID `0`, and a non-UUID ownership token, and each must reject with exactly
`LIDARR_PRESET_LOCK_METADATA_INVALID`. This is the minimum coverage that reaches both changed
branches and proves that an error thrown inside shared acquisition survives the lock translator
unchanged.

Do not add a command-layer test. Existing command coverage already proves that arbitrary string
codes are copied into the machine failure envelope, and preset command coverage already proves that
apply failures route through the shared reporter. Repeating those contracts for one new literal
would be filler.

Run the persistence suite as the changed contract, the preset action suite as the integration
boundary, the shared command-envelope test suite, and the Bash/Zsh/Fish completion parity suite.
Then run package typecheck, formatting, Markdown lint, the real pre-push hook, and registered CI.

## Documentation and Completion Parity

The code change intentionally changes automation-visible output, so the rfmedia changelog must name
the old and new codes under `Unreleased` / `Fixed`. The repository has no operator-facing catalog
of `LIDARR_PRESET_*` persistence codes; creating one for a single correction is unnecessary.

No shell completion template changes are required. Bash, Zsh, and Fish expose command and option
grammar only, none of which changes here. Completion parity must nevertheless be audited by running
`packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` and confirming the three
templates remain unchanged.

At closeout, update `ROADMAP.md` from live issue data and mark the #308 row in
`docs/internal/plex-jwt-deferrals.md` resolved with the final PR link. #307 remains open, so Sprint 2
narrative stays in the live roadmap rather than moving to the archive. The live pre-change inventory
is 81 open issues (38 rfapps, 43 rfmedia); after #308 closes it should be 80 (38 rfapps, 42 rfmedia),
subject to a fresh count immediately before the closeout edit.

## Risks and Rollback

The behavior change is intentionally limited to scripts that matched the wrong journal code for
invalid local lock-owner seams. The changelog makes that compatibility correction explicit. A
rollback is the inverse literal/type-union change plus removal of the focused assertion and release
note; it does not require data migration because no serialized artifact changes.

## Acceptance Criteria

1. Invalid hostname, PID, and ownership token each reject before successful lock publication with
   `LIDARR_PRESET_LOCK_METADATA_INVALID`.
2. `LIDARR_PRESET_JOURNAL_INVALID` no longer appears on either owner-metadata throw site and remains
   on genuine origin/journal validation paths.
3. Contention, ownership-loss, and corrupt-record behavior remain unchanged.
4. The rfmedia changelog names the machine-code correction.
5. Bash/Zsh/Fish completion templates are audited and their parity suite passes without template
   edits.
6. ROADMAP and the internal follow-up tracker reflect the final merged PR and live issue state.
7. The PR is independently reviewed, all validated findings are fixed, registered CI is green on
   the active head, the PR is squash-merged, #308 is closed, and only the dedicated branch/worktree
   is removed.
