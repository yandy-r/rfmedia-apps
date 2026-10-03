# Spec: Lidarr Import Validation and Track Filtering

## Problem Statement

Lidarr acquires music as complete albums, but operators need to detect unreliable album matches
before import and retain only selected tracks after acquisition. Today those decisions require
manual UI inspection or unverified filesystem changes, which can import the wrong release or remove
the wrong files without a reviewable record.

## Requirements

### Functional

| #   | Requirement                                                                                                                                                                                               | Priority | Notes                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Validate a local album folder through Lidarr's read-only manual-import probe and report every candidate file, selected artist/album/release/track mapping, parsed MusicBrainz identifiers, and rejection. | Must     | The CLI must expose Lidarr's own matching result rather than recreate its private matching algorithm.                            |
| F2  | Accept an optional positive Lidarr artist ID to constrain validation and support Lidarr's existing-file and replacement probe controls without ever submitting an import.                                 | Must     | Validation remains read-only and metadata-dependent.                                                                             |
| F3  | Classify validation findings deterministically as ready, ambiguous, rejected, or unmatched, preserving per-file evidence and a summary suitable for text, JSON, and CSV output.                           | Must     | Ambiguous or malformed responses must not be promoted to a match.                                                                |
| F4  | Support an opt-in failure threshold for automation while remaining diagnostic by default.                                                                                                                 | Should   | Match the established `--fail-on` report convention.                                                                             |
| F5  | Build a track-filter plan for one exact Lidarr album using one or both retention inputs: explicit track IDs and a local embedded-rating threshold.                                                        | Must     | At least one retention input is required; the filter never performs discovery without parent album context.                      |
| F6  | Treat explicit keep-track IDs as authoritative. When a rating threshold is also supplied, the keep set is the union of explicit IDs and tracks meeting the threshold.                                     | Must     | Explicit operator intent always wins.                                                                                            |
| F7  | Retain tracks whose files are missing, unrated, unreadable, outside the album, or cannot be mapped unambiguously, and emit warnings explaining why they were not deletion candidates.                     | Must     | Rating-based filtering fails closed.                                                                                             |
| F8  | Produce a sealed, reviewable plan containing exact album, track, and trackfile identities plus before-state evidence; default operation is preview/report only.                                           | Must     | Empty criteria, unknown IDs, cross-album IDs, duplicate IDs, and an empty resulting keep set must fail before a plan is written. |
| F9  | Apply only a valid sealed plan through Lidarr's trackfile bulk-delete endpoint, enforce an explicit maximum batch, and verify every planned trackfile is absent on a fresh read.                          | Must     | No direct filesystem deletion and no claim of trash/recovery support.                                                            |
| F10 | Preserve cancellation, retry classification, origin binding, stale-plan protection, deferred-operation rules, JSON stdout cleanliness, and the existing Lidarr error taxonomy.                            | Must     | Trackfile deletion is destructive and must not be silently deferred or replayed against changed state.                           |
| F11 | Update Bash, Zsh, and Fish completion templates and parity coverage for every new command, argument, option, enum, and value completion.                                                                  | Must     | The command surface necessarily changes.                                                                                         |
| F12 | Update user documentation and `ROADMAP.md` to mark issue #216 complete and close the remaining Layer 1 Lidarr milestone.                                                                                  | Must     | Include examples and safety limitations.                                                                                         |

### Non-Functional

| #   | Requirement                       | Target                                                                                                                                                 | Rationale                                                                                  |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| NF1 | Bounded destructive scope         | Default maximum of 100 trackfile deletions per plan, overridable only with an explicit positive `--max-batch`                                          | Prevent accidental album- or library-wide cleanup.                                         |
| NF2 | Deterministic output              | Stable ordering by file path for validation and by disc/track/track ID for filtering                                                                   | Makes plans, reports, tests, and review diffs reproducible.                                |
| NF3 | Private generated-client boundary | No action, command, or public type imports generated SDK modules or writes `/api/v1/` paths                                                            | Preserves the established handwritten facade and architecture checks.                      |
| NF4 | Focused regression coverage       | Test only matching classification, fail-closed retention, plan sealing/application verification, command contract, and completion parity               | Protects safety-critical behavior without duplicating generated-client or framework tests. |
| NF5 | Read efficiency                   | One manual-import probe per validation and one bounded album track/trackfile read per filter planning pass; each local rating file parsed at most once | Avoids unnecessary metadata calls and repeated disk scans.                                 |

## Technical Approach

**Strategy**: Add a read-only validation report over Lidarr's manual-import probe and extend the
existing Lidarr plan/apply framework with an exact trackfile-filter mutation. Keep generated
transport details behind `LidarrClientApi`; reuse local rating parsing only when `--min-stars` is
requested.

**Architecture Decisions**:

- Authoritative preflight: use Lidarr's manual-import response because it exposes the actual matcher,
  parsed tags, selected resources, and rejections without importing.
- Parent-scoped filtering: require one album ID because Lidarr track discovery is reliable only when
  parent context is known.
- Fail-closed ratings: delete only successfully mapped files with successfully read ratings below
  the threshold; uncertain files remain.
- Sealed mutation: represent trackfile deletion in the existing plan/apply system because the
  endpoint has no trash flag and destructive intent must survive review without being recomputed.
- Exact verification: re-read the targeted trackfile IDs after dispatch and fail the apply entry if
  any remain.

**Key Components**:

- `LidarrClientApi`: typed projections for manual-import probing, album tracks/trackfiles, bulk
  trackfile deletion, and targeted verification.
- Import-validation action and report model: normalize Lidarr's per-file matching evidence into
  deterministic findings and summaries.
- Track-filter planner: map parent-scoped tracks to trackfiles, evaluate explicit and rating keep
  criteria, retain uncertain files, and seal exact deletion entries.
- Lidarr apply execution: dispatch and verify the non-deferable trackfile deletion entries.
- `lidarr` command presenters and shell templates: expose text/machine reports, plan controls, and
  parity-complete command discovery.

## Integration Points

| System/Service                    | Direction | Protocol                                            | Notes                                                                                        |
| --------------------------------- | --------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Local Lidarr instance             | Both      | REST through generated SDK behind `LidarrClientApi` | Manual-import probe and reads are non-mutating; bulk trackfile delete is apply-only.         |
| Local music filesystem            | Inbound   | Read-only filesystem and audio metadata parsing     | Used only for optional rating retention; paths come from validated Lidarr trackfile records. |
| Existing Lidarr plan/apply engine | Both      | Versioned JSON artifact                             | Origin-bound, integrity-checked, stale-aware, exact mutation intent.                         |
| CLI output layer                  | Outbound  | Text, JSON, CSV                                     | Machine output keeps stdout clean; diagnostics remain on stderr.                             |
| Shell completion generators       | Outbound  | Bash, Zsh, Fish templates                           | New commands and options must remain in parity.                                              |

## Risks & Unknowns

| Risk                                                                                    | Likelihood | Impact | Mitigation                                                                                                                                             |
| --------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lidarr manual-import payloads vary across versions or contain partial nested resources. | M          | H      | Strict bounded projection, explicit unmatched/ambiguous classifications, fixture coverage for malformed responses.                                     |
| Lidarr paths are not locally accessible because of containers or remote path mappings.  | H          | M      | Explicit-ID filtering remains available; rating mode retains inaccessible files and reports warnings.                                                  |
| Bulk trackfile deletion removes physical files without recovery.                        | H          | H      | Preview by default, sealed apply, exact scope, maximum batch, explicit confirmation, and post-delete verification; document that trash is unsupported. |
| Library state changes between planning and apply.                                       | M          | H      | Seal before-state evidence and reject stale or mismatched entries instead of recomputing selection.                                                    |
| Explicit keep IDs accidentally identify another album.                                  | L          | H      | Reject any requested ID not present in the exact parent-album track set.                                                                               |

## Open Questions

- [x] Retention contract: explicit keep-track IDs plus optional local `--min-stars`; explicit IDs
      always win.
- [x] Mutation contract: preview/sealed plan/apply through Lidarr; no direct filesystem deletion or
      trash claim.
- [x] Validation source: Lidarr's read-only manual-import probe over a local folder.

---

_Source: GitHub issue #216 and `research/rfmedia-lidarr-integration/`_
_Generated: 2026-07-25_
_Status: APPROVED — ready for prp-plan_
