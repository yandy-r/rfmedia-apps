# File-Aware Lidarr Artist Deletion: Business Research

## Executive Summary

Issue #200 should add an artist-only bulk-deletion workflow to `rfmedia lidarr` that makes the
selected artists, Lidarr-library effect, and disk effect reviewable before any mutation. Album
deletion is out of scope because issue #223 owns album management and safe album deletion; no
additional child issue is needed.

The workflow must extend the existing sealed Lidarr plan/apply boundary rather than expose a
direct delete shortcut. Planning uses fresh Lidarr artist state, records stable artist IDs and
file-impact evidence, and supports a mutation-free dry run. Apply revalidates the sealed plan and
live state, requires independent destructive authorization, reports every target separately, and
offers a safe recovery path for partial or uncertain completion.

## User Stories

- As an operator, I can select artists explicitly by stable Lidarr IDs, by one or more supported
  artist filters, or by an explicit all-artists selector, so an omitted selector can never mean
  the whole library.
- As an operator, I can preview the complete matched cohort before a plan is saved, including each
  artist's ID, name, monitored state, path, track-file count, and exact byte count reported by
  Lidarr.
- As an operator, I can choose **keep files**, which removes the artist from Lidarr without asking
  Lidarr to remove media files.
- As an operator, I can choose **delete files**, which removes the artist from Lidarr and asks
  Lidarr to remove that artist's media files, only after the file impact is known and separately
  authorized.
- As an operator, I can explicitly choose whether Lidarr creates an import-list exclusion for each
  deleted artist, so deletion does not unexpectedly become either temporary or permanent.
- As a cautious operator, I can run planning or apply with `--dry-run` and receive the same
  selection, validation, drift, and disk-impact evidence without writing a plan, history, claims,
  exclusions, Lidarr mutations, filesystem changes, or Plex scan requests.
- As an operator, I can inspect a sealed artifact whose checksum binds the exact targets, delete
  mode, import-list-exclusion choice, and disk-impact evidence, then apply only that reviewed
  intent.
- As an automation user, I can use `--yes` in a non-interactive session to skip the confirmation
  prompt, but only when the required independent destructive authorization flag or flags are also
  present.
- As an operator, I receive a result for every target—succeeded, satisfied, failed, deferred, or
  uncertain—with evidence sufficient to resume safely after partial completion.
- As a Plex user, I can request a Plex library scan after verified file-deleting successes, without
  allowing a scan failure to misreport completed Lidarr deletions as failed.

## Business Rules

### Scope and selection

1. The first release deletes Lidarr **artists only**. It must not accept album IDs, expand into
   independently selected albums, or implement album deletion behavior from issue #223.
2. Planning requires exactly one explicit artist-selection mode:
   - unique positive Lidarr artist IDs;
   - one or more supported artist filters, combined with the current AND semantics; or
   - an explicit all-artists selector.
3. IDs, filters, and all-artists selection are mutually exclusive. Missing selection, unknown or
   duplicate IDs, zero matches, and a complete cohort above `--max-batch` fail before artifact
   creation. Selection is complete and deterministic; it is never silently truncated.
4. Stable artist ID is authoritative. Artist name and path are review labels and impact evidence,
   not target identifiers.

### Delete modes and import-list behavior

5. Exactly one mode is sealed for the whole plan:
   - **keep files** sends `deleteFiles=false`; Lidarr removes its artist record while media remains
     on disk;
   - **delete files** sends `deleteFiles=true`; Lidarr removes its artist record and is authorized
     to remove its managed artist files.
6. The two modes must be unmistakable in human prompts, machine output, the sealed artifact,
   history, and recovery commands. A default, empty value, or inferred mode must never authorize
   file deletion.
7. Import-list exclusion is an independent, explicit plan choice. The operator must choose whether
   `addImportListExclusion` is true or false; it must not be inferred from delete mode, monitoring
   state, an import-list match, or interactive/non-interactive execution.
8. The sealed exclusion choice applies identically to every artist in the plan. The preview warns
   that opting out may allow an import list to re-add the artist, while opting in suppresses that
   future re-addition until the exclusion is removed.

### File-impact evidence

9. Every entry records the fresh Lidarr evidence used for approval: artist ID, artist name,
   monitored state, configured artist path when present, `trackFileCount`, and `sizeOnDisk` as an
   exact non-negative integer byte count.
10. The plan summary totals artist count, track-file count, and bytes. Human output may add a
    formatted size, but it must retain the exact byte value; machine output and the artifact always
    carry the integer bytes.
11. Evidence is the impact Lidarr reports for the selected artist, not a promise of filesystem
    space reclaimed. Hard links, sparse files, deduplication, inaccessible mounts, and changes
    outside Lidarr can make actual reclaimed blocks differ.
12. A delete-files plan fails closed when an artist's path or statistics are absent, malformed, or
    otherwise cannot establish its file impact. Keep-files may proceed with zero or unavailable
    disk impact shown explicitly because it does not authorize file removal.
13. Apply rereads every target before the first mutation and compares identity, path,
    `trackFileCount`, and exact `sizeOnDisk` with the sealed evidence. Any addition, removal, path
    change, or statistics change is destructive drift and blocks the whole run before dispatch.

### Dry run, sealed apply, and authorization

14. Planning dry run performs fresh selection, cap enforcement, evidence collection, and complete
    preview in memory but writes no sealed artifact. Apply dry run validates schema, checksum,
    canonical Lidarr origin, authorization requirements, target drift, and recovery state without
    acquiring an apply claim or causing any external write.
15. Real deletion is available only through apply of a private, atomically created, no-overwrite
    sealed plan. The checksum binds canonical origin, normalized selection, ordered targets,
    impact evidence, delete mode, exclusion choice, risk facts, cap, and per-target idempotency
    keys.
16. Interactive apply shows the live revalidated cohort and defaults to no. General confirmation
    and destructive authorization are separate controls: `--yes` answers the prompt only and never
    grants destructive authority.
17. Artist-record deletion requires an explicit artist-deletion authorization. Delete-files mode
    additionally requires an independent file-deletion authorization. Both remain mandatory in
    interactive and non-interactive use and on resume.
18. Non-interactive stdin and JSON/YAML/CSV output require `--yes`; a missing authorization or
    missing `--yes` fails before mutation with a usage error. Expected plan ID and checksum pins
    remain available for automation.

### Execution, partial results, and recovery

19. Apply performs a whole-plan preflight, then admits targets one at a time in sealed order. It
    makes a fresh targeted read immediately before each delete, sends one delete request, does not
    blindly retry a possibly dispatched destructive request, and verifies the artist is absent
    before recording success.
20. A target already absent during the initial whole-plan preflight is stale, not an automatic
    success. On a resume, a durable prior success is skipped, and an absent target may be treated
    as satisfied only when the recorded attempt and sealed idempotency evidence establish that this
    plan could have dispatched it.
21. Results are durable and per target. A known pre-dispatch retryable failure may be deferred; a
    proven post-delete absence succeeds; a proven retained artist fails; and an inconclusive
    post-dispatch state is uncertain.
22. Failed or uncertain verification stops admission of later targets. The command exits non-zero
    for failed, deferred, uncertain, or otherwise partial completion and prints a copy-pasteable
    resume command pinned to plan ID and checksum and including the same authorization flags.
23. Resume rereads live state, skips durable successes, and retries only work proven not to have
    been dispatched. It never repeats an uncertain delete merely because the prior command exited.
24. Recovery must state the irreversible boundary: Lidarr metadata can be reconstructed or an
    artist re-added, but permanently deleted media files are not restored by plan history or
    resume.

### Plex scan

25. Plex scanning is opt-in for this workflow and is eligible only when delete-files mode produces
    at least one verified successful deletion with non-zero planned file impact. Keep-files,
    dry-run, preflight failure, and zero verified file deletions never trigger a scan.
26. At most one scan is requested after all deletion processing has reached a terminal state. It
    is never interleaved with target deletion and never runs before deletion verification.
27. The scan result is reported separately. A scan failure makes the overall command non-zero and
    supplies a retryable scan action, but it does not change durable per-artist deletion successes
    or cause any delete to be replayed.

### Success criteria

28. A plan preview identifies every target and displays per-target and aggregate disk impact with
    exact bytes; the sealed artifact contains the complete bounded cohort and both destructive
    choices.
29. Keep-files apply demonstrably sends no file-deletion authority. Delete-files apply cannot
    dispatch without its additional explicit authorization.
30. `--dry-run` has no mutation, history, claim, artifact, exclusion, filesystem, or Plex-scan side
    effects; `--yes` alone cannot authorize deletion.
31. Apply fails closed on origin mismatch, invalid schema/checksum, changed mode or exclusion
    choice, missing targets, or any sealed file-impact drift before the first mutation.
32. Every admitted target receives a durable terminal or recoverable outcome, partial completion
    exits non-zero, and resume never blindly repeats a possibly dispatched delete.
33. A requested Plex scan occurs only after verified qualifying deletions and is reported
    independently from deletion outcomes.

### Edge cases

- An artist renamed after planning retains the same stable target ID, but the new name is shown as
  a warning; a path or disk-statistics change is blocking drift.
- An artist with zero track files and zero bytes may be deleted in either mode, but the zero impact
  remains explicit and does not qualify for a Plex scan.
- An artist with missing statistics may use keep-files but cannot use delete-files until Lidarr
  provides auditable impact evidence.
- Shared or overlapping artist paths, a path outside expected roots, or duplicate normalized paths
  among selected artists are ambiguous file impact and block delete-files planning.
- An artist removed externally before initial apply is stale. An artist removed after this plan's
  dispatch is reconciled through history and targeted reads rather than automatically retried.
- Lidarr returning success before asynchronous deletion completes remains pending verification;
  exhausting bounded verification produces `uncertain`, not success.
- Cancellation before dispatch leaves that target retryable; cancellation after possible dispatch
  requires reconciliation and may be uncertain.
- Import-list exclusion creation is part of the target's intended delete request. A mismatch or
  inability to prove the requested exclusion outcome is reported per target and must not be hidden
  behind artist absence.
- A Plex configuration or scan failure never rolls back, reclassifies, or repeats an already
  verified Lidarr deletion.
