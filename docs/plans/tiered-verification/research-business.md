# Business Research: Tiered Verification

## Executive Summary

GitHub issue #116 should turn `rfmedia verify` from a mostly existence-oriented audit into an
operator-selectable integrity workflow with three explicit speed/confidence profiles:

- **Quick** checks the expected file set and inexpensive metadata.
- **Default** reads each destination and compares its SHA-256 digest with the stored write-time
  fingerprint delivered by issue #111 and PR #248.
- **Deep** performs the default baseline check and, where source and destination are intended to be
  byte-identical, additionally compares their current bytes.

The tiers should be cumulative in confidence where the artifact model permits it. A deep run must
not omit the stored-hash check, because direct source/destination comparison alone can miss a
hardlink whose shared bytes changed after copy. Conversely, converted outputs cannot pass a direct
source/destination byte comparison because different bytes are intentional. They can still receive
strong read-back verification against the stored hash, but the output must say that the additional
deep comparison was not applicable.

The main business risk is overstating coverage. Schema version 9 stores a nullable fingerprint for
one inventory row keyed by source-relative identity. Ranged album/filter/sync workflows can create
several destination artifacts while retaining only one of them in inventory. Historical rows may
have `NULL` hashes, tracking can be disabled, and legacy JSONL inventory may omit `contentHash`.
Those cases are **unverifiable at the requested tier**, not corrupt and not verified. Issue #116
must either expand artifact identity or report partial coverage; silently falling back to existence
checks would break the command's advertised guarantee.

Repair must remain conservative. A mismatch against the original fingerprint does not prove the
current source is a valid repair source. Before replacing a destination, rfmedia must establish that
the source can reproduce the expected artifact, apply the existing conflict/trash authorization,
and verify the repaired artifact again. If the source, a hardlink, or a nondeterministic conversion
has drifted away from the stored baseline, `--fix` must not silently redefine the baseline.

This work is the next item in the ROADMAP copy-integrity chain after #111. The exit criterion is not
merely adding `--quick` and `--deep`; it is making the selected confidence level, coverage gaps,
repair results, text/JSON output, exit behavior, documentation, completions, and performance claims
testable and honest across both album and filter verification modes.

## User Stories

1. As an operator running frequent health checks, I want `rfmedia verify --quick` to find missing,
   extra, or metadata-drifted artifacts without reading every byte, so daily checks finish quickly.
2. As an operator performing a routine integrity audit, I want plain `rfmedia verify` to compare
   current destination bytes with the fingerprint recorded when the artifact was finalized, so
   silent destination corruption is detected even when file size is unchanged.
3. As an operator after a disk migration or suspicious storage event, I want
   `rfmedia verify --deep` to perform every applicable baseline check and directly compare
   byte-identical source/destination pairs, so I receive the strongest meaningful evidence.
4. As a user of conversion, I want the final transcoded artifact checked against its own stored
   fingerprint, so legitimate source/output byte differences are not reported as corruption.
5. As a user of hardlinks, I want shared-inode drift distinguished from an independently damaged
   copy, so `--fix` does not pretend it can restore original bytes from an equally changed source.
6. As a user with a schema-v8 migration or older JSONL inventory, I want missing fingerprints
   reported as unknown coverage, so `NULL` is never misclassified as either a match or corruption.
7. As an automation author, I want stable JSON fields and exit codes that identify the selected
   tier, discrepancies, verification errors, and unverifiable artifacts, so scripts can make safe
   decisions without parsing prose.
8. As an interactive user, I want text summaries to show both integrity results and coverage, so a
   superficially clean but partially unverifiable library is not presented as fully verified.
9. As a user invoking `--fix`, I want the existing overwrite/rename/skip/ask and trash semantics to
   remain in force and the repaired file to be rechecked, so a successful fix means verified
   post-repair state rather than a successful copy call.
10. As a user with several sources, ranges, ratings, duplicate filenames, or preserved album
    structure, I want tier choice to change only the evidence gathered for each expected artifact,
    not which artifacts rfmedia expects.

## Business Rules with Edge Cases

### Tier Selection and Compatibility

1. Plain `rfmedia verify` selects the **default** tier. `--quick` selects quick and `--deep` selects
   deep.
2. `--quick` and `--deep` are mutually exclusive. Supplying both is a usage error before any scan,
   database open, repair, or filesystem mutation.
3. Tier selection applies consistently to album mode, flat filter mode, filter album mode,
   multi-source CLI input, and file-based input.
4. `--verify-size` and `--no-verify-size` are legacy verification controls. They must not silently
   weaken default or deep integrity guarantees. The product should either deprecate them with a
   clear compatibility mapping or define them as additional/disabled metadata prechecks; ambiguous
   precedence is unacceptable.
5. A tier changes how an expected artifact is validated, not source selection, rating/metadata
   filtering, duplicate-name resolution, range precedence, conversion filename mapping, or extra
   file detection.
6. A normal verification run is read-only. It must not backfill hashes, migrate schemas, update
   timestamps, or adopt new baselines. `--fix` authorizes only the documented repairs, not an
   implicit acceptance of changed content.

### Common Expected-Set Rules

1. All tiers first determine the same expected artifact set and report missing and extra files.
2. Directories remain outside the per-file verified count, matching current command behavior.
3. A file counts as `verified` only when every check required and applicable for the selected tier
   passes.
4. A failure to read source, destination, inventory, or metadata is a verification error, not a
   mismatch. Errors retain actionable path and operating-system code where available.
5. Extra files are discrepancies independent of tier. Keeping an extra file by explicit conflict
   resolution does not make it an expected or verified artifact.
6. Duplicate basenames in flat filter mode must retain the same deterministic destination mapping
   used at copy time. Tiered verification must not compare a source against the wrong `-002`,
   `-003`, or later destination.
7. Paths found in inventory must be reconciled with the destination argument. A stale or unrelated
   `dest_path` must not cause rfmedia to read or repair a file outside the requested destination.

### Quick Tier

1. Quick verification is metadata-only after expected-set discovery; it must not read full file
   content or calculate a digest.
2. For a byte-identical artifact with a trustworthy source/baseline, quick compares file size and
   modification time using one documented timestamp precision/tolerance policy.
3. Modification time alone is never sufficient. A matching timestamp with a different size is a
   metadata mismatch.
4. Equal size and modification time are evidence only for quick-tier freshness; they must never be
   described as content integrity.
5. Converted outputs are an edge case: current inventory records source `size` and `mtime`, while
   the destination intentionally has different bytes and usually a different size. Quick must not
   compare converted destination size with stored source size. It needs destination metadata
   captured as a baseline, or it must report metadata coverage as unavailable for that artifact.
6. Timestamp granularity differs by filesystem. Sub-precision differences caused by a known copy
   round-trip should follow the documented tolerance; a broad tolerance that hides meaningful drift
   is not acceptable.
7. Hardlinks can pass quick because source and destination share metadata even after both drift.
   Output and documentation must present this as quick freshness only, not proof against post-copy
   changes.
8. The issue's “10x+ faster” claim is a benchmark target, not an assumption. Filter-mode rating and
   metadata tag scans may dominate total runtime, so performance must be measured per comparable
   workload and must include end-to-end source selection.

### Default Tier

1. Default verification calculates the SHA-256 of the current final destination and compares it
   with the stored `inventory.content_hash` expected at write/finalization time.
2. The stored hash is a baseline, not proof of authenticity. An actor able to alter both the file
   and tracking database remains outside this guarantee.
3. A 64-character lowercase SHA-256 mismatch is a content mismatch even when size and timestamps
   match.
4. A missing inventory row, `NULL`/omitted hash, tracking-disabled copy, unsupported producer, or
   unavailable tracking backend is `unverifiable`, not `hash-mismatch` and not `verified`.
5. Verification must not fabricate a digest from current bytes and call it the original baseline.
   Optional backfill or rebaseline behavior requires separate, explicit authorization and is not
   part of ordinary `verify`.
6. Database and legacy JSONL hashes represent the same SHA-256 business contract. The active
   backend must be selected predictably; rfmedia must not create or prefer a hidden database when
   the originating workflow used legacy tracking.
7. Converted outputs are fully eligible for default verification because the stored digest is of
   the final converted artifact.
8. The schema-v9 inventory key can represent only one destination for a source-relative file.
   When a range created multiple outputs, only the represented `dest_path` may be hash-verified.
   Other expected outputs remain uncovered unless artifact identity is expanded.
9. If several historical operations match the same options, the chosen baseline must be
   deterministic and destination-bound. “Most recent operation” alone is unsafe when operation
   identity does not include the destination.

### Deep Tier

1. Deep verification includes the default stored-baseline hash comparison. It then directly
   compares current source and destination bytes for artifacts contractually expected to be
   byte-identical.
2. Direct comparison must read until both streams end; equal prefixes with different lengths do not
   pass. An early byte mismatch may stop that pair without weakening the result.
3. Deep comparison is not applicable to intentionally converted audio. Such an artifact can be
   `hash-verified` at the strongest meaningful level, but output must show that direct comparison
   was not applicable rather than claiming a source/destination byte match.
4. Non-audio companion files copied without conversion remain eligible for direct comparison even
   within a converted album.
5. A hardlink whose source and destination currently share bytes can pass direct comparison but
   still fail the stored baseline. The overall deep result is a mismatch; direct equality must not
   override baseline drift.
6. A missing/unknown stored baseline prevents a complete deep result even if source and destination
   currently compare equal. Current equality does not prove either file matches the bytes created
   by the original copy.
7. Source mutation during comparison must not produce a pass. If stable comparison cannot be
   established, the artifact is an error/unverifiable result and should be retried in a later run.

### Result Classification and Coverage

The domain needs distinct result categories rather than overloading `size-mismatch`:

| Classification      | Meaning                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `verified`          | Every required and applicable check for the requested tier passed                        |
| `missing`           | Expected destination artifact does not exist                                             |
| `extra`             | Destination artifact is not in the expected set                                          |
| `metadata-mismatch` | Quick size or modification-time evidence differs                                         |
| `hash-mismatch`     | Current destination SHA-256 differs from stored final-artifact baseline                  |
| `content-mismatch`  | Deep source/destination bytes differ where equality is expected                          |
| `unverifiable`      | Required baseline/evidence does not exist for the requested tier                         |
| `not-applicable`    | A stronger check is meaningless by design, such as deep source comparison for conversion |
| `error`             | Required evidence could not be read or evaluated                                         |

`not-applicable` is not itself corruption. It must, however, be visible in coverage so “deep” is
not interpreted as direct comparison of converted source and output. `unverifiable` means the
requested guarantee was not established and must not increase the verified count.

### Legacy and Tracking Edge Cases

1. Schema-version-8 rows migrated to version 9 retain `content_hash = NULL`; no automatic backfill
   is allowed during verification.
2. Older JSONL records with a missing or null `contentHash` follow the same unknown-baseline rule.
3. Invalid non-null hashes should already be rejected at writable database boundaries. If an
   existing store contains one, verification treats it as invalid evidence/error, never as a
   mismatch against user data.
4. A database newer than supported must be opened read-only or rejected without mutation. A
   read-only verify must not change schema, journal mode, or database files.
5. Content fingerprints were explicitly not produced for every rfmedia path (including certain
   Plex, playlist, watch, repair, and video workflows). Files from those producers cannot be
   default/deep baseline-verified until they have an authorized baseline.
6. Plain existence/metadata results may still be useful when hashes are unknown, but the command
   must not silently downgrade the selected tier. It reports partial coverage and the requested
   tier remains unfulfilled for those artifacts.

### Repair Semantics

1. Tiered verification first diagnoses, then repairs only when `--fix` is present and dry-run is
   not active.
2. Existing `--force`, `--trash`, and `--conflict-strategy` authorization remains applicable.
   Tier selection does not broaden deletion or overwrite authority.
3. Missing files can be recopied or reconverted using the existing destination mapping, then must
   be verified at the selected tier before being counted fixed.
4. A metadata, hash, or content mismatch may be repaired from source only when rfmedia can establish
   that the source can reproduce the expected artifact. For a byte-identical copy, the current
   source hash can be compared with the stored baseline before overwrite.
5. If both source and destination differ from the baseline, or a hardlink shares the changed bytes,
   original content is unavailable. `--fix` must skip/fail safely and explain that a known-good
   source or explicit rebaseline is required.
6. Converted repair regenerates the final output and verifies that output against the stored final
   hash. If the converter is nondeterministic and cannot reproduce the original bytes, rfmedia must
   not silently replace the expected hash merely because conversion succeeded.
7. Extra-file removal retains confirmation/trash behavior and does not affect integrity baselines.
8. Rename is not a successful integrity repair for the originally expected destination unless the
   expected-set model is deliberately updated. The original expected path remains missing after a
   rename-only resolution.
9. A repaired artifact's inventory data may be refreshed only when it still represents the same
   authorized baseline/artifact identity. Creating a new baseline is a separate state transition
   that ordinary `--fix` should not perform implicitly.
10. Result counts and exit status reflect post-repair verification, not arithmetic deductions such
    as “one copy call succeeded, therefore one mismatch was fixed.” Failed reverification remains
    unresolved.

### Text, JSON, and Exit Behavior

1. Text output identifies the selected tier before work begins and summarizes verified,
   discrepant, unverifiable, not-applicable, and error counts.
2. JSON includes a stable tier identifier and coverage totals. It must distinguish mismatch types
   and include file-level issue details or another stable way to identify affected paths.
3. Expected/stored hashes are sensitive library fingerprints and are unnecessary for routine
   automation; neither text nor JSON should print full digests by default.
4. Existing fields (`verified`, `missing`, `sizeMismatch`, `extra`, `expectedTotal`, `failed`, and
   `fixResults`) should remain compatible where their meanings still hold. New mismatch categories
   must not be collapsed into `failed` or inaccurately added to `sizeMismatch`.
5. A fully successful run exits zero only when every expected artifact reached the requested
   guarantee, all requested repairs reverified, and no verification errors remain. The project must
   decide whether explicitly kept extras preserve historical zero-exit behavior; whatever policy is
   chosen must be consistent between status text, JSON, docs, and tests.
6. Usage/configuration errors remain distinct from discovered integrity problems according to the
   repository's global exit-code contract.
7. Machine-format runs remain free of progress/spinner/prose contamination.

## Primary and Error Recovery Workflows

### Primary Quick Workflow

1. Parse inputs, determine album/filter mode, resolve source entries/ranges, and select quick tier.
2. Build the expected destination set using current selection and naming rules.
3. Check destination presence, extra files, and available size/mtime evidence without reading file
   content.
4. Classify matches, metadata mismatches, and metadata-unavailable converted/legacy artifacts.
5. If authorized, repair safe discrepancies and repeat the applicable quick checks.
6. Emit tier and coverage-aware text/JSON summary and exit according to unresolved state.

### Primary Default Workflow

1. Parse the same expected set and resolve the originating tracking backend and destination-bound
   inventory baseline.
2. For each expected artifact, distinguish missing inventory, unknown hash, stale destination path,
   and usable fingerprint before reading content.
3. Hash each current destination with bounded parallelism and compare it with the stored SHA-256.
4. Classify verified, mismatch, unverifiable, not represented by current artifact identity, and
   read error outcomes.
5. If authorized, repair only from a source proven suitable, then hash the final artifact again.
6. Emit both integrity and coverage results; do not claim complete verification when any required
   baseline was unavailable.

### Primary Deep Workflow

1. Perform the default workflow for every artifact with a stored baseline.
2. For each byte-identical artifact, compare current source and destination bytes directly.
3. For converted artifacts, retain the default hash result and record direct comparison as not
   applicable.
4. Combine evidence conservatively: any baseline mismatch, byte mismatch, or error prevents a pass.
5. Apply authorized repair and repeat both stored-baseline and applicable direct comparison checks.
6. Report which fraction was directly compared versus hash-only because of artifact semantics.

### Unknown Baseline Recovery

1. Detect missing inventory, `NULL` hash, unsupported producer, or unrepresented ranged artifact.
2. Continue auditing other files; do not stop the entire library at the first unknown.
3. Report the artifact as unverifiable with a concise reason and suggested next action.
4. Do not write a hash during ordinary verify or `--fix` merely to make the warning disappear.
5. If the product later introduces `rebaseline`, require explicit user intent and clearly separate
   “accept current bytes” from “proved original bytes intact.”

### Mismatch Recovery

1. Preserve the original expected fingerprint and inspect current source suitability.
2. If current source matches the expected baseline for a byte-identical artifact, apply normal
   conflict policy, replace the destination, and reverify.
3. If current source and destination both differ, stop automatic repair and direct the user to a
   known-good source/backup or explicit rebaseline workflow.
4. If a conversion cannot reproduce its stored final bytes, report the limitation rather than
   accepting a new fingerprint silently.
5. For hardlinks, identify shared drift and avoid a no-op “repair” that links the same changed inode.

### Interruption and Partial Failure Recovery

1. Cancellation stops scheduling new file checks and aborts active full-file reads where possible.
2. Read-only verification leaves no database or filesystem cleanup burden.
3. Repair uses the established interruption/partial-file rules and never marks completion before
   the replacement has been reverified.
4. A partial run reports completed evidence and interruption state without presenting the entire
   expected set as verified.

## Domain Model and State Transitions

### Core Domain Concepts

| Concept              | Business meaning                                                                  |
| -------------------- | --------------------------------------------------------------------------------- |
| Verification tier    | Requested evidence level: quick, default, or deep                                 |
| Expected artifact    | Destination file implied by source selection, mode, range, and conversion mapping |
| Artifact baseline    | Write/finalization-time evidence, principally destination SHA-256                 |
| Metadata evidence    | Size and modification-time facts used only for quick freshness checks             |
| Artifact coverage    | Whether the requested evidence exists and is applicable                           |
| Verification outcome | Verified, discrepancy, unverifiable, not applicable, or error                     |
| Repair candidate     | Discrepancy for which an authorized, known-good recovery source may exist         |
| Rebaseline           | Explicit acceptance of current bytes as a new expected state; not normal verify   |

### Artifact State Transitions

```text
expected
  -> missing
  -> present + evidence unavailable -> unverifiable
  -> present + check not meaningful -> not-applicable for that check
  -> present + evidence agrees -> verified at requested/applicable level
  -> present + evidence differs -> metadata/hash/content mismatch
  -> present + evidence read fails -> error

mismatch or missing
  -> repair not authorized -> unresolved
  -> repair source not proven -> blocked-safe (original baseline retained)
  -> repair materialized -> pending reverification
  -> reverification passes -> repaired-and-verified
  -> reverification fails -> unresolved repair failure

unknown baseline
  -> ordinary verify/fix -> remains unknown
  -> explicit future rebaseline -> new baseline accepted (not proof of original integrity)
```

The requested tier and achieved evidence level are separate fields. This is necessary for cases
such as a deep run on converted output (requested deep, achieved stored-hash verification, direct
comparison not applicable) or a default run on a legacy `NULL` row (requested default, achieved
existence only, baseline unavailable).

## Existing Codebase Integration

- `packages/rfmedia-cli/src/commands/verify.ts` owns tier flags, mutual exclusion, legacy
  `--verify-size` compatibility, machine-output envelope, and exit decisions. Its current JSON
  reports aggregate counts but omits the collected `issues`, so automation cannot identify a
  mismatched file without a schema extension.
- `packages/rfmedia-cli/src/actions/verify-album.ts` establishes album/range expected paths,
  existence/optional size checks, extra detection, aggregation, and album repair. Tier logic must
  preserve its per-path range precedence and converted filename mapping.
- `packages/rfmedia-cli/src/actions/verify-filter.ts` establishes rating and metadata selection,
  flat/preserved/album destination layouts, duplicate filename handling, and filter repair. Rating
  reads can dominate quick performance and must be included in end-to-end benchmarks.
- `packages/rfmedia-cli/src/lib/verify.ts` currently provides expected filename mapping, extra-file
  discovery, and size comparison. Its semantics are source/destination oriented and do not yet
  model tier, coverage, baseline evidence, or differentiated mismatches.
- `packages/rfmedia-cli/src/types/options.ts` has `VerifyOptions.verifySize` but no verification
  tier or tracking backend selection. `packages/rfmedia-cli/src/types/results.ts` has only
  `present`, `missing`, and `size-mismatch`, which is insufficient for hash/content/unknown states.
- `packages/rfmedia-cli/src/lib/schema.sql`, `src/lib/db.ts`, and `src/lib/inventory.ts` expose the
  schema-v9 `content_hash` and legacy `contentHash` contract. Database helpers can load inventory by
  operation/source, but operation matching is based on mode/options/input and does not bind a
  destination.
- The inventory uniqueness key `(operation_id, source_path, relative_path)` is a business coverage
  limitation for ranges. Album/filter writes can replace the represented destination, while sync
  explicitly records only the first ranged destination. Issue #116 must surface or resolve this
  before claiming all ranged artifacts received default/deep verification.
- Inventory `mtime` and `size` describe source metadata even when `dest_path` and `content_hash`
  describe a converted final artifact. They cannot be treated as destination metadata for quick
  converted verification.
- `docs/features/file-integrity-verification.md` describes copy-time `--verify`, which compares
  source/destination SHA-256 and skips converted output. Tiered standalone verification must be
  documented as a separate read-time workflow to avoid conflating the two commands.
- `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md` is the canonical
  baseline contract: final-artifact SHA-256, nullable legacy values, converted-output support,
  hardlink snapshot semantics, no hidden tracking, and no routine hash logging.
- Existing verify repair copies/converts files and updates counters without persisting new hash
  evidence or re-running verification. That is insufficient for a claim that a hash/content
  mismatch was fixed.
- Bash, fish, and zsh completion templates already enumerate verify options. Both new flags and any
  tier-related tracking option must be added consistently, with template snapshot/spec coverage.
- `packages/rfmedia-cli/benchmarks/verify.bench.ts` currently compares existence-only with
  existence-plus-size. It provides a suitable product benchmark category but must distinguish all
  three tiers and include representative byte-identical, converted, hash-unknown, and ranged
  coverage where applicable.
- `ROADMAP.md` already identifies #116 as the downstream read-time verification item after #111 and
  requires verify modes to be documented. Completion should update that row, the status narrative,
  the shipped-work table/counts as applicable, and the Sprint 2 exit criterion.

## Testable Success Criteria

1. `rfmedia verify --quick`, plain `rfmedia verify`, and `rfmedia verify --deep` select quick,
   default, and deep respectively in every album/filter input mode.
2. `--quick --deep` fails before scanning or mutation with a clear usage error.
3. All three tiers produce the same expected/missing/extra set for identical inputs.
4. Quick performs no full-content read and detects same-timestamp/different-size plus
   same-size/different-timestamp fixtures according to documented timestamp precision.
5. Quick never compares converted destination size with stored source size; converted metadata
   coverage is either based on destination metadata or explicitly unavailable.
6. Default passes a final destination whose SHA-256 matches the stored lowercase 64-hex baseline
   and detects a same-size, same-mtime byte mutation.
7. Default verifies converted output against the stored final-output hash without comparing it with
   source bytes.
8. Default reports missing inventory, `NULL` database hash, omitted/null JSONL hash,
   tracking-disabled output, and unsupported producer output as unverifiable, never verified or
   corrupt.
9. Deep performs the default baseline check plus direct byte comparison for byte-identical files;
   a stored-baseline mismatch fails even when a hardlinked source and destination currently match.
10. Deep reports direct comparison as not applicable for converted audio while retaining its
    default hash result; non-converted companion files are still directly compared.
11. Deep detects a differing byte, differing length after an equal prefix, read error, and source
    mutation/instability without producing a false pass.
12. A ranged fixture demonstrates truthful coverage for every expected destination. If the schema
    remains one-destination-per-source, unrepresented destinations are reported unverifiable;
    otherwise each ranged artifact is independently checked.
13. Baseline lookup cannot select an inventory row for a different requested destination merely
    because it is the newest matching operation.
14. `--fix` repairs a missing or damaged byte-identical destination only from a source that matches
    the expected baseline, then rechecks it at the requested tier before counting it fixed.
15. `--fix` refuses automatic repair when source and destination both differ from the baseline or a
    changed hardlink cannot reproduce original bytes.
16. Converted repair must reproduce and reverify the stored final-output hash; conversion success
    alone is not a successful fix and does not silently rewrite the baseline.
17. Existing conflict strategy, force, trash, dry-run, and extra-file behavior remains authorized
    exactly as documented; verification tier does not widen mutation scope.
18. Text output names the selected tier and shows achieved coverage, unresolved discrepancies,
    unverifiable/not-applicable totals, failures, and post-repair status.
19. JSON output contains a stable tier, coverage, differentiated mismatch counts/details, failures,
    and fix results while preserving compatible existing fields and omitting full hashes.
20. Exit codes are consistent with text/JSON status for clean, mismatch, unverifiable, error,
    successfully repaired, failed repair, and retained-extra cases.
21. Read-only verification against supported, legacy, too-old, and too-new databases does not
    mutate schema, journal state, or files.
22. Cancellation during hashing/direct comparison stops work, leaves ordinary verification
    read-only, and prevents a partially repaired artifact from being reported verified.
23. Bash, fish, and zsh completions offer the new flags with consistent descriptions, and template
    tests prevent drift.
24. Documentation explains tier guarantees, conversion and hardlink semantics, unknown hashes,
    repair/rebaseline distinction, JSON/exit behavior, and the difference from copy-time
    `copy --verify`.
25. ROADMAP marks #116 shipped only after implementation, docs, review/fix, and CI evidence exist.
26. Benchmarks record quick/default/deep end-to-end results on identical libraries. The issue's
    quick “10x+” target is either demonstrated with reproducible evidence or accurately documented
    as unmet for the tested workload; no narrower microbenchmark is used to claim whole-command
    speed.

## Open Questions

1. **Quick baseline:** Should schema/inventory gain final-destination `size` and `mtime`, or should
   quick report converted artifacts as metadata-unavailable? Comparing converted output with stored
   source metadata is not valid.
2. **Ranged identity:** Is one inventory row required per ranged destination as a prerequisite/child
   issue, or will #116 explicitly provide partial hash coverage for unrepresented artifacts?
3. **Operation selection:** What uniquely binds a verify invocation to its originating operation
   and destination when `options_hash` omits destination and several historical operations match?
4. **Backend selection:** Which CLI/config controls let standalone verify select a custom tracking
   database or legacy JSONL inventory without creating/migrating a hidden database?
5. **Unknown-hash policy:** Should unverifiable artifacts make the command nonzero by default, or
   should there be a separately named “integrity complete but coverage partial” exit outcome? A zero
   exit must not be described as fully default/deep verified.
6. **Deep conversion semantics:** Is “deep” defined as strongest applicable verification (stored
   final-output hash for conversions), or must requesting deep with any conversion produce a
   partial/unverifiable overall status?
7. **Legacy `--verify-size`:** Should it be deprecated, mapped to quick, or remain an optional
   precheck within default/deep? Its interaction with `--no-verify-size` needs one explicit rule.
8. **Repair versus rebaseline:** Should a separate future flag/command accept changed current bytes
   as a new baseline? Ordinary `verify --fix` should preserve the original expectation.
9. **Converted reproducibility:** If a converter version regenerates semantically equivalent but
   byte-different output, should repair stop and request explicit rebaseline, or is a versioned
   conversion baseline needed?
10. **Hardlink reporting:** Can current inventory reliably identify that an artifact was hardlinked?
    If not, should verification detect shared device/inode at read time solely to explain safe
    repair limitations?
11. **Extra files and exit status:** Current summaries and exit logic do not consistently treat
    extras as incomplete. Should #116 normalize this behavior or preserve it as a compatibility
    constraint?
12. **File-level JSON:** Should the existing `issues` array become part of public JSON output, and
    what compatibility/versioning policy applies to new mismatch and coverage fields?
13. **Performance target scope:** Does “10x+ faster” compare quick with default, deep, or the former
    flat verify behavior, and at what library/file-size/rating-filter workload?
14. **Child issue boundary:** If destination metadata, ranged artifact identity, rebaseline, or
    operation-to-destination binding is too large for #116, which pieces are hard prerequisites
    versus clearly reported follow-up limitations?
