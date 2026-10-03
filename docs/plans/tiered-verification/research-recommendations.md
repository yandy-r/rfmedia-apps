# Recommendations: Tiered Verification

## Executive Summary

Implement issue #116 as an extension of the existing `rfmedia verify` command with one explicit
domain value, `quick | default | deep`, shared by album and filter actions:

| Tier    | Required evidence                                                                                     | Intended use                          |
| ------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Quick   | Expected-set checks plus source/destination size and normalized mtime for byte-identical artifacts    | Frequent, metadata-only checks        |
| Default | SHA-256 of the current final destination compared with its stored final-artifact hash                 | Routine integrity verification        |
| Deep    | Default verification plus direct source/destination byte comparison where byte identity is meaningful | Migration or suspected-storage audits |

The tiers should be monotonic: deep must not discard the stored-hash check, because equal current
source and destination bytes do not prove that either still matches the write-time artifact. This
matters especially for hardlinks. Converted audio is valid in default and deep through its stored
final-output hash; direct source comparison is `not-applicable`, not a mismatch. Quick cannot
truthfully compare converted source metadata with destination metadata using schema version 9, so
it must report missing metadata coverage for those artifacts.

Keep the implementation read-only unless `--fix` is present, never create or migrate a tracking
database merely to verify, never backfill or replace a baseline during verification, and never
silently downgrade a selected tier. Missing, null, invalid, or ambiguously matched fingerprints are
`unverifiable` or `error`, not verified and not corrupt.

No schema change is required to ship a truthful #116. Exact-destination inventory matches can be
verified now. Ranged destinations not represented by the current one-row inventory identity must
be reported as uncovered. A one-row-per-artifact ledger is the only justified child issue, and it
is a follow-up rather than a prerequisite unless maintainers require 100% default/deep coverage of
all historical ranged outputs as an acceptance criterion.

## Implementation Recommendations

1. Add `VerificationTier = "quick" | "default" | "deep"` to `VerifyOptions` and the command result.
   Plain `rfmedia verify` selects `default`; `--quick` and `--deep` select the other tiers and are
   mutually exclusive at Commander parsing time.
2. Preserve album/filter mode as the selection dimension and tier as the evidence dimension. All
   tiers must construct the same expected paths, duplicate suffixes, converted filenames, missing
   set, and extra set.
3. Add a small shared per-file verifier rather than rewriting the album and filter traversals. The
   actions retain mapping, progress, conflict resolution, and repair orchestration; the shared
   verifier returns a typed outcome and performs no logging, prompting, database access, mutation,
   or exit handling.
4. Implement the algorithms with Node.js built-ins:
   - Quick uses `stat()` only. For byte-identical artifacts compare size, then integer-millisecond
     mtime. Document this precision and classify a changed file during the check as unstable.
   - Default streams the destination once through SHA-256 and compares lowercase 64-hex output
     with the stored `inventory.content_hash`.
   - Deep first performs the default baseline check, then uses two file handles, reusable bounded
     buffers, short-read-safe loops, and abort checkpoints to compare exact bytes. Re-stat handles
     after reading and reject unstable results.

5. Resolve fingerprints conservatively. Prefer only a normalized exact `dest_path` match that also
   matches source identity and conversion variant, ordered deterministically by `copied_at DESC,
id DESC`. Do not select by basename, hash, filename, or merely the newest operation. Do not reuse
   a represented ranged destination's hash for another converted destination: repeated encoder
   output is not guaranteed byte-identical. A non-converted source-relative fallback may be added
   only if the implementation proves the expected artifacts share the same byte contract; the
   safer initial behavior is explicit uncovered coverage.
6. Open the configured or explicitly selected existing SQLite inventory read-only. Check existence
   first, and add a purpose-built read API rather than using an initializer that can create,
   migrate, change journaling, or otherwise write. An explicit `--tracking-database` option is
   recommended because default verification otherwise cannot reliably select the same custom store
   as copy/history workflows.
7. Use a result model that separates verdict from evidence coverage. At minimum include stable
   statuses/reasons for `missing`, `extra`, `metadata-mismatch`, `hash-mismatch`,
   `content-mismatch`, `unverifiable`, `not-applicable`, `unstable`, and `error`. Preserve existing
   aggregate fields additively, add tier and new counters, and never emit full hashes by default.
8. Define `verified` as satisfying every required and applicable check for the requested tier.
   `not-applicable` is visible coverage but not failure; `unverifiable`, instability, mismatches,
   missing files, errors, and unresolved extras make the result incomplete and nonzero.
9. Preserve `--fix`, dry-run, force, trash, and conflict-strategy authorization, but make repairs
   evidence-aware:
   - Reverify the repaired artifact at the selected tier before counting it fixed.
   - Before replacing a hash-mismatched byte-identical destination, hash the current source and
     require it to match the stored baseline.
   - If neither source nor destination matches the baseline, or both hardlink paths share changed
     bytes, refuse repair and explain that known-good content or explicit rebaseline is required.
   - Do not implicitly change the baseline after a copy or conversion.
   - Defer automatic repair of an existing converted hash mismatch unless repair first generates a
     staged output, validates it against the baseline, and only then performs an authorized replace.

10. Update Bash, Zsh, and Fish completion templates and their parity tests in the same change. Add
    `--quick`, `--deep`, and `--tracking-database` if adopted, with cost/confidence descriptions.
11. Update command help, README, verify/fix/integrity documentation, and `ROADMAP.md`. The roadmap
    should identify #111/PRs #233 and #248 as the prerequisite fingerprint producer and mark #116
    shipped through the implementation PR once its number is known.

## Technology Choices/Phasing/Quick Wins

### Phase 1: Contract and pure primitives

- Add tier, outcome, reason, and coverage types.
- Add abort-aware streaming SHA-256 and bounded direct comparison helpers with focused tests.
- Add exact-destination, read-only fingerprint lookup and tests; do not change schema version 9.
- Reject conflicting flags and establish additive machine-output fields.

This phase creates independently testable foundations before either complex action is changed.

### Phase 2: Action integration

- Integrate the same verifier into album and filter verification without changing their mapping.
- Aggregate outcomes from a single shared model.
- Preserve file-based input, multiple sources, ranges, flat duplicate naming, preserved structure,
  album-filter mode, conversion filename mapping, extras, progress, and cancellation.
- Keep per-file success quiet; show tier, coverage, grouped problems, elapsed time, and throughput.

### Phase 3: Safe repair and compatibility

- Expand fix classification to the new mismatch types, establish trusted-source checks, and
  reverify every successful repair.
- Keep `--verify-size` for one compatibility window as an additive metadata precheck, but remove it
  from primary guidance. It must not select or weaken default/deep. Reject contradictory uses such
  as `--no-verify-size --quick` if they cannot be given one unambiguous meaning.
- Ensure machine formats remain free from human progress and warnings.

### Phase 4: Evidence and closeout

- Extend the existing verify benchmark with identical quick/default/deep datasets, representative
  byte volumes, worker counts, warm-cache disclosure, throughput, and bounded-memory evidence.
- Treat the issue's 10x claim as a measured target comparing metadata-only quick with content-reading
  default/deep on the same media-sized workload. Do not encode a flaky wall-clock CI assertion or
  claim success from tiny existence-only fixtures.
- Run typecheck, focused tests, the full rfmedia test suite, build, completion tests, benchmark
  evidence, and documentation lint before PR review.

### Quick Wins

- Commander option conflicts and explicit default-tier help are low-risk, user-visible improvements.
- Reusing the existing `calculateHash()` contract avoids a dependency and algorithm decision.
- Exact `dest_path` lookup uses the existing index and requires no DDL.
- A shared outcome type immediately removes the current ambiguity where extras use `present` and
  read failures can be collapsed into size mismatches.

## Improvement Ideas

Defer these unless implementation evidence makes one necessary for #116:

- A destination-artifact ledger with one fingerprint and destination metadata baseline per ranged
  output.
- An explicit `baseline create/adopt` workflow with auditable trust semantics for legacy content.
- Deterministic subset, byte-budget, resumable, or time-budget deep verification for very large
  libraries.
- Versioned converter provenance and reproducibility policy for safe converted-output regeneration.
- First-differing-byte offsets in verbose/debug or machine issue detail.
- Persistent verification history, authenticated inventories, signing, or adversarial tamper
  detection. SHA-256 here detects accidental drift; it does not authenticate a mutable database.
- Extending tiered verification to sync JSONL, Plex, playlist, watch, video, or other producers not
  currently represented by the standalone verify command.

## Risk Assessment

| Risk                                                        | Severity | Mitigation                                                                                                       |
| ----------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| False success when a hash is absent or ambiguously selected | Critical | Exact destination-bound lookup; explicit unverifiable coverage; nonzero incomplete result                        |
| Deep equality misses jointly changed hardlinks              | High     | Retain the stored-hash check; detect same device/inode and report direct comparison as redundant/not applicable  |
| Destructive repair from a changed source                    | Critical | Require source-to-baseline proof before overwrite; reverify; never implicit rebaseline                           |
| Converted output falsely compared with source               | High     | Default/deep use final-output hash; direct comparison is not applicable; quick reports missing metadata coverage |
| Verification mutates or creates the database                | High     | Existing-file check plus purpose-built read-only connection and query path                                       |
| Ranged output receives another artifact's fingerprint       | High     | Exact destination identity; report uncovered outputs; defer ledger expansion                                     |
| Concurrent file mutation produces a false pass              | High     | Open handles, before/after stats, unstable outcome, cancellation-aware reads                                     |
| Unbounded memory or I/O contention                          | Medium   | Fixed buffers, existing worker limiter, storage-oriented benchmark matrix                                        |
| Existing scripts break on default behavior/output           | Medium   | Additive fields, documented nonzero coverage semantics, temporary `--verify-size` compatibility                  |
| Machine output leaks hashes or is contaminated by progress  | Medium   | Omit full digests; central formatting; send progress/prose only to human channels                                |
| Scope expands into tracking redesign or every producer      | Medium   | Keep schema and command surface bounded; create a child issue only for artifact identity if required             |

## Alternatives

| Alternative                                                     | Decision             | Reason                                                                                                                           |
| --------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Deep performs only source/destination comparison                | Reject               | It can pass two jointly changed paths and makes deep weaker than default for hardlinks                                           |
| Missing hash silently falls back to source/destination hashing  | Reject               | It changes the selected guarantee and cannot validate converted output historically                                              |
| Verification auto-backfills current destination hashes          | Reject               | It converts an observation into a trusted baseline and can bless corruption                                                      |
| Reuse any source-relative hash for all ranged outputs           | Reject initially     | It is safe only for proven byte-identical artifacts and unsafe for potentially nondeterministic conversions                      |
| Add destination metadata/schema columns now                     | Defer                | Quick can truthfully report converted metadata coverage unavailable; schema work is not needed for core tiers                    |
| Add one inventory row per ranged artifact in #116               | Defer or child issue | Valuable for complete coverage, but a migration and producer redesign exceeds the tier consumer feature                          |
| New verification package/dependencies                           | Reject               | Node 22 crypto, streams, file handles, AbortSignal, Vitest, and existing worker control are sufficient                           |
| Rewrite album/filter traversal into one engine                  | Reject               | Mapping and repair behavior are mode-specific; a shared per-file verifier gives the needed consistency with less regression risk |
| Treat converted deep as failure                                 | Reject               | Stored final-output hash is the strongest meaningful check; expose direct comparison as not applicable instead                   |
| Allow automatic repair of converted hash mismatches immediately | Defer                | Safe replacement needs staged generation and baseline verification; existing remove-then-convert behavior is too risky           |

## Task Breakdown Preview

1. **T1 — Freeze contract** (no dependencies): tier semantics, result statuses, exit policy,
   `--verify-size` compatibility, converted/hardlink coverage, and exact baseline selection.
2. **T2 — Integrity primitives** (depends on T1): abort-aware destination hashing, chunked direct
   comparison, stability checks, and focused filesystem tests.
3. **T3 — Read-only baseline provider** (depends on T1; parallel with T2): exact-destination query,
   database resolution, validation, ordering, and no-mutation tests.
4. **T4 — CLI/types/output** (depends on T1): flags, conflicts, default tier, tracking path, additive
   text/machine contract, and exit semantics.
5. **T5 — Album integration** (depends on T2-T4): all range/source modes, conversions, hardlinks,
   aggregation, repair gating, and reverification.
6. **T6 — Filter integration** (depends on T2-T4; parallel with T5): flat duplicate mapping,
   preserved structure, album mode, metadata selection, aggregation, repair, and reverification.
7. **T7 — Cross-mode fixtures and regressions** (depends on T5-T6): equal-size corruption, missing
   and null baseline, exact-destination ambiguity, ranged coverage, conversion, hardlink, errors,
   instability, cancellation, fixes, extras, and machine formats.
8. **T8 — Completions and documentation** (depends on T4; may overlap T5-T7): Bash/Zsh/Fish parity,
   help, README, feature docs, integrity doc, repair policy, and roadmap update.
9. **T9 — Performance and validation** (depends on T5-T8): benchmark matrix, bounded-memory probe,
   typecheck, focused/full tests, build, lint, graph update, and diff checks.
10. **T10 — PR lifecycle** (depends on T9): template-compliant PR closing #116, formal review,
    finding fixes and reverification, CI monitoring to green, squash merge, and local/remote
    branch/worktree cleanup.

If complete historical ranged-output coverage is required, create **T0-child — Destination artifact
identity and metadata baselines** before T3/T5/T6. Otherwise create it as a non-blocking follow-up
after #116 and keep uncovered destinations explicit in this release.

## Key Decisions Needed

Recommended defaults are supplied so planning can proceed without another design gate:

1. **Deep guarantee:** choose cumulative default-hash plus applicable direct comparison.
2. **Converted deep result:** choose verified-at-strongest-applicable with a visible
   `not-applicable` direct-comparison count, not an overall failure.
3. **Quick converted result:** choose metadata coverage unavailable until destination metadata is
   stored; do not compare unlike source/destination metadata.
4. **Baseline selection:** choose exact destination and conversion identity; do not guess across
   operations or ranged outputs.
5. **Unknown baseline:** choose explicit `unverifiable` and nonzero incomplete result; never
   downgrade or backfill.
6. **Repair/rebaseline:** choose repair only from evidence-proven source content and keep rebaseline
   outside `verify --fix`.
7. **Extras:** choose nonzero while unresolved so the destination set cannot be called complete.
8. **Child issue:** choose no blocking child for #116 unless 100% ranged historical coverage is a
   release requirement; otherwise file one follow-up for artifact identity/destination metadata.

## Open Questions

1. Does the repository want the artifact-ledger follow-up created now, or only after implementation
   quantifies uncovered ranged and converted artifacts?
2. Should `--tracking-database` be the only explicit backend selector for this command, or must
   standalone verify also consume legacy sync JSONL despite sync not being part of its present
   selection model?
3. What supported-filesystem evidence should define the quick mtime normalization beyond integer
   milliseconds? The initial implementation should document and test one conservative policy.
4. Should one automatic retry be allowed for an unstable file, or should all instability be
   reported immediately for a later clean rerun?
5. What exact representative dataset, filesystem, cache state, byte volume, and worker count will
   be recorded as the reproducible evidence for the 10x quick-tier target?
