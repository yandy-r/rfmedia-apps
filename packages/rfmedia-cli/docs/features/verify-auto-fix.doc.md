# Verify Auto-Fix

`rfmedia verify --fix` applies authorized repairs and then reports the selected tier's final
verification state. A successful copy, conversion, rename, or removal is not enough by itself:
expected artifacts are counted as repaired only after verification evidence passes.

Repair does not create, refresh, or backfill fingerprints. Stored SHA-256 values are local
integrity baselines, not authenticity or provenance evidence.

## Options and Authorization

| Option                          | Effect                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `--fix`                         | Enables the repair phase after verification                                                  |
| `--force`                       | Selects overwrite for expected-file conflicts and removal for extra files without prompting  |
| `--trash`                       | Moves authorized extra files to system trash instead of deleting them permanently            |
| `--conflict-strategy=ask`       | Prompts for each conflict; this is the CLI default                                           |
| `--conflict-strategy=skip`      | Leaves expected-file conflicts and extras unchanged                                          |
| `--conflict-strategy=overwrite` | Replaces repairable expected artifacts and removes extras                                    |
| `--conflict-strategy=rename`    | Does not overwrite the expected path; an unresolved expected artifact remains incomplete     |
| `--dry-run`                     | Runs verification and reports discrepancies but performs no fix phase or filesystem mutation |

`--fix` does not broaden authority. Existing force, trash, interactive, JSON, and conflict-strategy
rules still decide whether a destructive action is allowed.

Examples:

```bash
# Prompt before conflict actions
rfmedia verify /music/Artist /backup --range=001-005 --fix

# Unattended overwrite/removal, with extras recoverable from trash
rfmedia verify /music/Artist /backup --range=001-005 --fix --force --trash

# Preview final discrepancies without changing the destination
rfmedia verify /music/Artist /backup --range=001-005 --fix --dry-run

# Repair using stored final-artifact evidence and an explicit database
rfmedia verify /music/Artist /backup --range=001-005 --fix \
  --tracking-database=/state/rfmedia.db --conflict-strategy=overwrite
```

## Repair Contract

Content replacement follows this sequence:

1. Retain the original destination while evaluating the repair.
2. Resolve the exact source, destination, and conversion-bound fingerprint when the selected tier
   requires stored content evidence.
3. Materialize a new copy or conversion into a unique staging file in the destination directory.
4. Verify the staged artifact with the selected tier.
5. Confirm that the destination directory, staged file, and original destination have not changed
   unexpectedly.
6. Atomically rename the verified staged file into the expected destination path.
7. Re-run selected-tier verification against the final path.
8. Recheck the complete requested destination set and derive final counters from that state.

If materialization or staged verification fails, the staged file is removed and the original
destination remains unchanged. A race detected before commit also aborts replacement. Missing
destinations have no original to preserve, but an unverified staged artifact is still never
committed.

Extra-file removal is separate from content replacement. It follows the selected confirmation,
force, and trash policy and is reflected in the final destination recheck.

## Proof Required by Tier

| Tier    | Proof before replacement can count as successful                                                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quick   | The staged direct copy satisfies the current source size and integer-millisecond modification-time comparison. Converted quick coverage is unavailable and the repair cannot be proven at this tier.                                                          |
| Default | The staged final artifact's SHA-256 matches the exact stored final-artifact fingerprint. For direct copies this proves the current source materialization reproduces the baseline; converted output must reproduce the stored converted-artifact fingerprint. |
| Deep    | Default proof passes first, followed by applicable staged source/destination byte comparison. Conversion and same-inode exclusions remain explicit `not-applicable` coverage states.                                                                          |

For content tiers, a missing, `NULL`, invalid, or ambiguous fingerprint cannot authorize a content
replacement. Verification refuses the repair rather than accepting the current source or
destination as a baseline. A direct-copy source that no longer reproduces the stored fingerprint
is also refused. Recover from a known-good source or backup, or run a separately designed trusted
producing/rebaseline workflow.

The source proof prevents this unsafe sequence: identify a corrupt destination, overwrite it from
an independently changed source, and call the new bytes verified merely because both paths now
agree.

## Behavior by Outcome

| Initial outcome     | Repair behavior                                                                      |
| ------------------- | ------------------------------------------------------------------------------------ |
| `missing`           | Materialize at the expected path, stage, verify, commit, and recheck                 |
| `size-mismatch`     | Overwrite only when authorized; use staged replacement and recheck                   |
| `metadata-mismatch` | Overwrite only when authorized; use staged replacement and recheck                   |
| `hash-mismatch`     | Require evidence-proven source material, authorized overwrite, staging, and recheck  |
| `content-mismatch`  | Require evidence-proven source material, authorized overwrite, staging, and recheck  |
| `unverifiable`      | Refuse content repair until required evidence is available                           |
| `unstable`          | Do not claim repair success from unstable evidence; quiesce writers and rerun        |
| `not-applicable`    | No content repair is required for this coverage note when all required checks passed |
| Extra file          | Remove only when authorized; optionally move to trash                                |

Skip, keep, and rename decisions do not repair the original expected path. If the original
discrepancy or an extra file remains after the final recheck, the command stays incomplete and
exits nonzero.

## Conflicts and Non-Interactive Runs

Expected-file mismatches and extra files use the existing conflict-resolution workflow:

- `ask` prompts in an interactive terminal and supports apply-to-all choices.
- `overwrite` replaces an expected artifact or maps to removal for an extra file.
- `skip` leaves the path unchanged.
- `rename` avoids replacing the expected path, so it cannot make that original expectation pass.
- `--force` is the unattended shorthand for overwrite/removal.

Machine-output runs do not emit interactive prompts. Supply an explicit strategy or `--force` for
unattended mutation. Keeping an extra file is a successful conflict decision, but the extra file
remains an unresolved verification outcome.

## Dry Run

With global `--dry-run`, verification still selects expected artifacts and reports their current
outcomes, but the repair phase is skipped. It does not stage files, replace destinations, remove
extras, move files to trash, or write evidence.

Use dry-run output to choose a conflict strategy. Do not interpret it as proof that a later repair
will succeed: source contents, evidence, permissions, or destination state can change before the
real run.

## Final Recheck and Exit Status

After attempted fixes, album and filter workflows verify the requested destination set again with
the same tier. Final `verified`, mismatch, coverage, extra, issue, and failure counts come from
that recheck rather than arithmetic such as “copied means fixed.”

The command remains incomplete and exits with code `1` when any mismatch, missing artifact,
unverifiable or unstable outcome, extra file, operational failure, failed fix, refused fix, or
post-repair issue remains. It exits with code `0` only when all required and applicable checks pass
and no unresolved repair state remains. A `notApplicable` coverage note alone is not a failure.

## Machine Fields

When a repair phase runs, structured output adds `result.fixResults`:

```json
{
  "command": "verify",
  "mode": "album",
  "tier": "default",
  "status": "incomplete",
  "source": "/music/Artist",
  "destination": "/backup",
  "result": {
    "verified": 24,
    "missing": 0,
    "sizeMismatch": 0,
    "metadataMismatch": 0,
    "hashMismatch": 1,
    "contentMismatch": 0,
    "unverifiable": 0,
    "notApplicable": 0,
    "unstable": 0,
    "extra": 0,
    "expectedTotal": 25,
    "issues": [
      {
        "path": "Album-001/track.flac",
        "status": "hash-mismatch",
        "evidence": ["hash"]
      }
    ],
    "failed": [],
    "fixResults": {
      "copiedFiles": 2,
      "removedFiles": 1,
      "failedFixes": 1,
      "repairedFiles": 2,
      "reverifiedFiles": 2,
      "refusedFiles": 1,
      "remainingIssues": 1
    }
  }
}
```

| Field             | Meaning                                                                            |
| ----------------- | ---------------------------------------------------------------------------------- |
| `copiedFiles`     | Successful copy/conversion filesystem operations                                   |
| `removedFiles`    | Extra files successfully removed or moved to trash                                 |
| `failedFixes`     | Number of repair operations that failed in machine output                          |
| `repairedFiles`   | Expected artifacts that completed repair verification                              |
| `reverifiedFiles` | Repaired artifacts checked again at the selected tier                              |
| `refusedFiles`    | Candidates not changed because required proof or a safe resolution was unavailable |
| `remainingIssues` | Discrepancies still present after final re-verification                            |

The in-memory `FixResult.failedFixes` field contains detailed failure objects; structured command
output exposes its count. Per-file `issues` and `failed` remain available in the enclosing result.
No raw expected or actual digest is emitted.

## Failure Recovery

- **Fingerprint unavailable:** preserve the destination and reproduce evidence through the trusted
  copy workflow; verification never backfills it.
- **Source does not match the baseline:** keep the existing destination and locate a known-good
  source or backup.
- **File changed during reading:** stop concurrent writers and rerun verification.
- **Staging or commit failure:** inspect the reported path and permissions; the pre-existing
  destination is retained when replacement did not commit.
- **Extra intentionally retained:** expect incomplete status until it is removed from the verified
  destination scope.

## Implementation Map

| File                             | Responsibility                                                              |
| -------------------------------- | --------------------------------------------------------------------------- |
| `src/actions/verify-album.ts`    | Album issue authorization, staged repair, and full post-repair recheck      |
| `src/actions/verify-filter.ts`   | Filter-layout repair, staged replacement, and post-repair recheck           |
| `src/lib/filesystem.ts`          | Validated same-directory staging and atomic replacement                     |
| `src/lib/tiered-verification.ts` | Exact evidence lookup, tier verification, aggregation, unresolved predicate |
| `src/lib/integrity.ts`           | Abort-aware hash and byte-comparison proof                                  |
| `src/types/results.ts`           | Stable verification and repair result fields                                |

## Related Documentation

- [Verify Command](verify-command.doc.md)
- [Conflict Resolution](conflict-resolution.md)
- [Content Hashing During Copy Operations](content-hashing-during-copy-operations.md)
- [Centralized Tracking Database](centralized-tracking-db.doc.md)
