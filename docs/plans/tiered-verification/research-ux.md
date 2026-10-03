# UX Research: Tiered Verification

## Executive Summary

Issue #116 should present verification as one orthogonal confidence choice, independent of the
existing album/filter selection:

| Invocation               | User promise                                      | Cost model                 |
| ------------------------ | ------------------------------------------------- | -------------------------- |
| `rfmedia verify --quick` | Detect likely drift from destination metadata     | Metadata I/O; file-count   |
| `rfmedia verify`         | Validate destination bytes against stored SHA-256 | One destination read       |
| `rfmedia verify --deep`  | Use every applicable integrity check              | One or two full file reads |

`--quick` and `--deep` must be mutually exclusive and omission must visibly mean `default
(SHA-256)`. Do not add `--default`: it creates a third spelling for the normal path without adding
useful intent. Help, startup output, summaries, and machine output should all name the effective
tier so users never have to infer what was checked.

The largest UX risk is overclaiming confidence. Legacy inventory rows may have no hash; converted
destinations legitimately differ from their sources; hardlinks may make both paths the same inode.
These are not successful deep comparisons. Report them as first-class coverage states such as
`missing-baseline` or `hash-only`, show the effect on the final guarantee, and give a safe next
action. Never silently fall back from default/deep to quick and still report `COMPLETE`.

The current command already has useful conventions to preserve: album/filter modes, `--workers`,
`--progress`/`--no-progress`, `--fix`, conflict strategies, global machine formats, stderr-oriented
human logging, and a final verification/fix summary. Tiering should refine those patterns rather
than introduce another command family.

## User Workflows

### 1. Choose scope and confidence

```text
$ rfmedia verify /music/Artist /backup --range 001-005
Verification tier: default (SHA-256)
Scope: 5 album copies, 642 files, 18.4 GiB
Baseline: destination content hashes from inventory
```

The first stable lines should answer three questions before expensive work begins:

1. What will be checked?
2. Which tier is active?
3. What evidence will that tier use?

For an interactive terminal, display the selected tier even when no flag is passed. For machine
formats, suppress prose and include the same facts as fields.

### 2. Scan, validate, and verify

Use distinct phases rather than a single ambiguous spinner:

```text
Scanning inventory        642/642 files
Checking SHA-256          417/642 files | 11.8/18.4 GiB | 286 MiB/s | ETA 24s
```

Quick verification should progress by files. Default and deep verification should progress by
bytes as the primary denominator, with file count as useful context. ETA should remain `--` until a
stable sample exists, then use the repository's smoothed-rate convention. Progress belongs on
stderr and must be automatically disabled for non-TTY and machine output unless the established
global policy says otherwise.

### 3. Summarize guarantee and coverage

```text
=== Verification Summary ===
Tier: DEFAULT (SHA-256)
Status: INCOMPLETE
Verified: 636/642 files (18.1/18.4 GiB)
Mismatched: 2
Missing: 1
Missing baseline: 3
Elapsed: 1m 08s (277 MiB/s)

Next: run with --fix to restore mismatched or missing destinations.
Legacy hashes are absent for 3 files; use --quick for a metadata-only check or repair/re-copy them
to create trusted destination hashes.
```

The status should be determined by remaining problems after any fix pass. `missing-baseline`,
`unstable`, read failures, missing files, and mismatches must prevent a complete default/deep result.
Extra files should also affect status if the command describes the destination as matching the
expected set; the current text summary reports extras but its completion calculation and command
exit condition do not consistently include them.

## Alternative Workflows

### Quick scheduled check

```bash
rfmedia verify /music/Artist /backup --range 001-005 --quick --no-progress
```

Quick is suited to frequent checks and should say `metadata only` wherever its result is shown.
Avoid words such as `integrity proven`. Equal size and modification time can miss corruption.

If destination metadata was not stored at copy time, quick cannot validly compare converted output
to source metadata. Report `missing-metadata-baseline` or `not-applicable`, not `verified`. A schema
or inventory change that stores destination size/mtime is preferable to a heuristic comparison.

### Deep post-migration check

```bash
rfmedia verify /music /new-storage --file sources.txt --deep --progress
```

Deep should be a monotonic superset of default: check the stored destination hash first, then
perform byte comparison where source and destination are expected to be byte-identical. Its summary
must expose actual coverage:

```text
Deep coverage: 581 byte-compared, 49 hash-only conversions, 12 hash-only hardlinks
```

Converted files cannot be compared byte-for-byte with their source, and a hardlink comparison is
not independent evidence because both paths may reference the same inode. Both can still receive
the default stored-hash guarantee. A run with hash-only items may be successful if the documented
deep contract explicitly means "deepest applicable check," but it must not say every file was
byte-compared.

### Machine-readable automation

```bash
rfmedia --output json verify /music /backup --range 001-005 --deep
```

Keep stdout parseable and stable. Suggested additive shape:

```json
{
  "command": "verify",
  "mode": "album",
  "tier": "deep",
  "status": "incomplete",
  "result": {
    "expectedTotal": 642,
    "verified": 636,
    "missing": 1,
    "mismatched": 2,
    "missingBaseline": 3,
    "unstable": 0,
    "coverage": {
      "byteCompared": 581,
      "hashOnlyConverted": 49,
      "hashOnlyHardlink": 12
    },
    "bytesChecked": 19756849562,
    "elapsedMs": 68122,
    "failed": []
  }
}
```

Use stable enum values and numeric primitives; do not make automation parse colored labels or
localized prose. YAML/table/CSV should derive from the same result model. Per-file issue objects
should include a reason code and safe remediation hint. Do not emit full expected/actual hashes by
default; a short prefix is enough for debug output and avoids turning ordinary reports into a
fingerprint catalog.

## Error Workflow

Errors should state the failed guarantee, the affected scope, and one safe next action. For example:

```text
Cannot complete default verification: 37 destination files have no stored SHA-256 baseline.
No files were treated as verified by fallback.

Next options:
  --quick  Run a lower-confidence metadata check now.
  --fix    Restore/re-create affected destinations from source, then record trusted hashes.
```

Do not suggest hashing the current destination and accepting it as trusted: that converts unknown
content into a baseline without verification. `--fix` should restore or reproduce the destination
from a trusted source, calculate the final destination hash, update inventory only after success,
and re-run the selected verification for repaired files. For conversions this means using the
original conversion path/settings. For hardlinks with no historical hash, the tool can establish a
new baseline only if the user explicitly accepts the current source as authoritative; it cannot
prove what the bytes were before the run.

`--dry-run --fix` should print the repair plan and keep the status incomplete. Interactive fixes
should preview counts and destructive actions; non-interactive/machine use should require the
existing force/conflict-strategy rules. The fix summary should distinguish `found`, `repaired`,
`baseline-created`, `skipped`, `failed`, and `remaining`, then set the exit code from `remaining`.

## CLI UX Best Practices

### Flag model and validation

- Define `--quick` as "Compare destination metadata only (fast, lower confidence)."
- Define `--deep` as "Run SHA-256 and byte comparison where applicable (slowest)."
- Show `default: SHA-256` in the command description or an epilog because the default is not a
  boolean option visible in usage.
- Reject `--quick --deep` during parsing with: `options '--quick' and '--deep' cannot be used
together; choose one verification tier.` Commander supports declared option conflicts in the
  project's CLI framework; parser-level rejection keeps help and errors consistent with other
  usage failures ([Commander.js documentation](https://github.com/tj/commander.js/)).
- Keep album/filter mode separate in types and output. `mode=album|filter` answers _what_ is
  selected; `tier=quick|default|deep` answers _how confidently_ it is verified.
- Decide the fate of legacy `--verify-size` explicitly. Recommended migration: accept it for one
  compatibility window as a deprecated alias for the metadata tier, reject combinations with
  `--deep`, emit a warning only in human output, and remove it from primary examples. Do not let it
  create a hidden fourth tier.
- Update Bash, Zsh, and Fish templates and their snapshot/spec tests together. Completion
  descriptions must include confidence/cost. If the completion system can filter conflicting
  options, omit `--deep` after `--quick` and vice versa; otherwise parser enforcement remains
  authoritative.

### Terminology

Use these labels consistently:

- **Verified**: the active tier's promised evidence was obtained and matched.
- **Mismatch**: evidence was obtained and did not match.
- **Missing baseline**: required stored evidence does not exist or is invalid.
- **Not applicable / hash-only**: a deeper pairwise check is not meaningful for this operation.
- **Unstable**: the file changed while it was being read; no verdict was reached.
- **Failed**: an operational error prevented a verdict.

Do not fold missing baseline or read errors into mismatch. Users take different recovery actions for
corruption, absent historical evidence, and inaccessible files.

### Output and exit behavior

- Preserve exit `0` only for a complete result at the requested tier after fixes.
- Preserve nonzero for mismatches, missing files, missing baselines, instability, failures, and
  unresolved extras. A richer exit-code taxonomy is optional; stable result reason codes are more
  important for machine output.
- Print a final summary even after partial failure or cancellation when safe, with `Status:
CANCELLED` and completed/remaining counts.
- Keep per-file success quiet by default. Print grouped problem samples and use `--verbose` for the
  complete list, preventing large libraries from flooding terminals and CI logs.
- Include effective workers, total bytes, elapsed time, and throughput in verbose output so users
  can tune storage-heavy verification.

## Error States

| State                       | User-facing message                                     | Safe next action                                            | Result/exit                    |
| --------------------------- | ------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------ |
| `tier-conflict`             | `--quick and --deep cannot be used together`            | Choose one or omit both for default                         | Usage error                    |
| `missing-baseline`          | Stored SHA-256 is absent for N legacy files             | Use quick now; re-copy/repair to establish trusted hashes   | Incomplete, nonzero            |
| `invalid-baseline`          | Stored hash has an unsupported algorithm/shape          | Repair inventory or recreate affected outputs               | Failed, nonzero                |
| `metadata-baseline-missing` | Quick comparison has no destination size/mtime baseline | Use default if a hash exists; otherwise repair/re-copy      | Incomplete, nonzero            |
| `content-mismatch`          | Destination SHA-256 differs from stored baseline        | Run `--fix`, preferably preview first                       | Incomplete, nonzero            |
| `byte-mismatch`             | Source and destination differ at byte offset N          | Run `--fix`; debug output may include offset                | Incomplete, nonzero            |
| `converted-hash-only`       | Byte comparison is not applicable to converted output   | Treat stored-hash result as deepest applicable coverage     | Explicit coverage, not failure |
| `hardlink-hash-only`        | Source and destination are the same inode               | Use stored hash as independent historical evidence          | Explicit coverage, not failure |
| `unstable`                  | File changed during verification                        | Stop writers and retry; optionally retry once automatically | Incomplete, nonzero            |
| `missing-source`            | Trusted source is unavailable                           | Restore/mount source before deep or fix                     | Failed, nonzero                |
| `missing-destination`       | Expected destination is absent                          | Run `--fix` to recreate it                                  | Incomplete, nonzero            |
| `permission-denied`         | Path cannot be stat/read                                | Show path and permission hint, continue other files         | Failed, nonzero                |
| `fix-needs-confirmation`    | Non-interactive repair needs an explicit strategy       | Add `--force` or `--conflict-strategy`                      | No mutation, nonzero           |
| `conversion-config-missing` | Output cannot be reproduced with known settings         | Restore recorded settings or re-run the original copy flow  | Fix failed, nonzero            |
| `cancelled`                 | Verification stopped; N of M completed                  | Re-run; do not call partial coverage complete               | Cancelled, nonzero             |

## Performance UX

The issue's "10x faster" goal is meaningful only with a stated dataset and comparator. User-facing
performance should communicate the mechanism rather than promise a universal ratio:

- Quick: `metadata-only; reads no file contents`.
- Default: `reads each destination once`.
- Deep: `reads destination for hash and source/destination for applicable byte comparison`.

Before work begins, estimate files and bytes when the scan can do so cheaply. If estimating would
double remote filesystem traversal, start with an indeterminate scan and only show ETA after the
scope is known. Separate scan time from verification time in verbose output.

Content tiers are storage-bound. Keep `--workers`, but describe it as concurrent files rather than
implying more is always faster. A high CPU-derived default may reduce throughput on HDD, NAS, or
FUSE storage. Progress should use aggregate bytes and a smoothed rate across workers. Quick mode
should show files/second because bytes are not read.

For deep verification, show why coverage may be lower than expected before a long run:

```text
Deep plan: 581 byte comparisons; 61 stored-hash-only files (49 converted, 12 hardlinked)
Estimated read: 31.7 GiB
```

This prevents the user waiting an hour only to learn that a requested guarantee was not applicable.
Future large-library UX could add deterministic subsets or time/byte budgets, following restic's
`--read-data-subset` model, but that is outside issue #116.

## Comparative Examples

| Tool/pattern                                                                                                                         | Useful lesson for rfmedia                                                                                      | What not to copy blindly                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [Borg `check`](https://borgbackup.readthedocs.io/en/stable/usage/check.html)                                                         | Separates cheaper consistency work from explicit, slow data verification; names the cost of the stronger check | Borg validates repository chunks, not source/destination media pairs                                     |
| [restic repository checking](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#checking-integrity-and-consistency) | Makes full data reads opt-in and supports deterministic subsets for recurring coverage                         | Sampling would not satisfy issue #116's full default/deep promises                                       |
| [GNU `cmp`](https://ftp.gnu.org/old-gnu/Manuals/diffutils-2.8.1/html_node/Invoking-cmp.html)                                         | Byte comparison can stop at the first difference and report an offset useful in verbose diagnostics            | A pairwise match is not historical integrity proof for hardlinks or jointly modified files               |
| Commander option conflicts                                                                                                           | Reject impossible flag combinations at parse time and generate conventional usage feedback                     | Do not rely only on downstream action validation after scanning has begun                                |
| Current `rfmedia verify`                                                                                                             | Preserve album/filter syntax, machine formats, workers, fix/conflict rules, and final summaries                | Current optional size check and completion/status treatment are too ambiguous for three confidence tiers |

## Recommendations

### Must

- Model one effective tier: `quick | default | deep`; reject `--quick --deep`.
- Name the tier and its evidence in startup, summary, help, and machine output.
- Never silently downgrade default/deep when hashes or metadata baselines are missing.
- Add first-class results for missing baseline, mismatch, not-applicable/hash-only, unstable, and
  failed; make the final status and exit code reflect unresolved items.
- Define deep as default stored-hash verification plus byte comparison only where meaningful; expose
  conversion and hardlink coverage explicitly.
- Make `--fix` restore/reproduce from a trusted source, update the inventory only after successful
  materialization, and reverify at the requested tier. Do not trust-on-first-use the existing
  destination silently.
- Keep progress off stdout for machine formats; use file progress for quick and byte progress/ETA
  for default/deep.
- Update Bash, Zsh, and Fish completion templates and completion tests with accurate descriptions.
- Test every tier across ordinary copies, conversions, hardlinks, legacy null hashes, missing files,
  corruption, concurrent modification, cancellation, fix success/failure, and machine output.

### Should

- Show an up-front scope/coverage plan and a final elapsed/throughput summary.
- Group human-readable problems by reason and show only a bounded sample unless verbose.
- Preserve `--verify-size` temporarily as a documented deprecated alias/compatibility route, with a
  clear removal plan rather than an undocumented fourth tier.
- Include stable reason codes and coverage counts in JSON/YAML/table/CSV derived from one result
  model.
- Reuse existing `--workers`, `--progress`, `--no-progress`, `--dry-run`, conflict strategies, and
  cancellation conventions.
- Update `ROADMAP.md`, README/verify docs, examples, and `--help` together so the default change is
  visible to existing users.

### Could

- Add a preflight confirmation for very large deep reads when running interactively.
- Add deterministic subset/time/byte-budget deep checks in a later issue.
- Add a dedicated, explicit baseline migration command if legacy inventory volume makes re-copy
  impractical; its trust model must be clearer than hiding baseline creation in `verify`.
- Report first differing byte offset in verbose/debug and machine issue details.

## Open Questions

1. What destination metadata is authoritative for quick mode? Current inventory size/mtime describe
   the source, which is not equivalent for conversions.
2. Is deep officially "deepest applicable check" (allowing successful hash-only conversions and
   hardlinks), or must any non-byte-compared file make the run partial/incomplete?
3. Should `--verify-size` become a deprecated alias for quick, remain a modifier temporarily, or be
   removed as a breaking change?
4. Does `--fix` have authority to establish new baselines for legacy hardlinks when no historical
   hash exists, or should that require a separate explicit migration command?
5. How is the correct inventory row selected when the same destination appears in multiple
   operations, and which operation/config records the reproducible conversion settings?
6. Should extra files make all tiers incomplete? This research recommends yes because the current
   command promises that destination copies match the expected set.
7. Should `unstable` files receive one automatic retry before being reported, and should that retry
   count appear in machine output?
8. What exact dataset, filesystem, cache state, worker count, and previous behavior define the
   acceptance benchmark for "quick is 10x+ faster"?
9. Are additive machine-output fields sufficient for compatibility, or does the result schema need
   an explicit version before new status categories are introduced?
