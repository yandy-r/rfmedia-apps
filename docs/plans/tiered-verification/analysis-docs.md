# Documentation Analysis: Tiered Verification

## Executive Summary

Tiered verification changes the documented default for `rfmedia verify` from existence-oriented
checking with optional size comparison to destination SHA-256 comparison against the stored
final-artifact fingerprint. Documentation is therefore part of the correctness boundary: a user must
be able to distinguish scope selection from evidence strength, understand when a successful result is
hash-only rather than a direct byte comparison, and recognize missing evidence as `unverifiable`
rather than corruption or success.

The release-blocking documentation set is deliberately small and has clear ownership:

- `packages/rfmedia-cli/docs/features/verify-command.doc.md` is the canonical command and result
  contract.
- `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md` owns repair authority, refusal, staging,
  and post-repair verification.
- `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md` owns creation and
  limitations of the stored baseline consumed by default and deep verification.
- `docs/features/file-integrity-verification.md` is the umbrella explanation that separates
  copy-time read-back verification from later `rfmedia verify` checks.
- `packages/rfmedia-cli/README.md` provides discoverable syntax, concise guarantees, examples, and
  machine-output guidance.
- `packages/rfmedia-cli/docs/features/performance-benchmarks.md` and the issue #116 benchmark artifact
  record the quick/default/deep comparison and whether the 10x quick target was achieved.
- `ROADMAP.md` records delivery only after the implementation PR is merged.

All public documents must use the accepted contract in
`docs/plans/tiered-verification/feature-spec.md`, not earlier research alternatives. In particular,
quick must be described as metadata-only with no database or content read; default as exact stored
final-output hash comparison; and deep as default plus direct byte comparison only where meaningful.
Converted output and same-inode hardlinks can pass deep with hash-only coverage, while absent,
invalid, ambiguous, or historically unrepresented evidence remains nonzero and `unverifiable`.

Required items below are release-blocking for #116. Nice-to-have items improve navigation or preserve
historical context but should not delay the feature when their underlying behavior is unchanged.

## Must-Read Documents

| Priority     | Path                                                                           | Why it must be read                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Required     | `docs/plans/tiered-verification/feature-spec.md`                               | Accepted source of truth for tiers, evidence, repair, results, compatibility, privacy, benchmarks, and completion criteria.          |
| Required     | `docs/plans/tiered-verification/research-recommendations.md`                   | Consolidates the delivery recommendation and identifies which earlier alternatives were rejected or deferred.                        |
| Required     | `docs/plans/tiered-verification/research-ux.md`                                | Defines user terminology, progress, human summaries, machine fields, examples, and honest coverage wording.                          |
| Required     | `docs/plans/tiered-verification/research-security.md`                          | Defines read-only database behavior, path trust, hash privacy, unstable-file handling, and safe repair constraints.                  |
| Required     | `docs/plans/tiered-verification/research-technical.md`                         | Maps accepted semantics to current command, action, integrity, database, completion, and benchmark code.                             |
| Required     | `docs/plans/tiered-verification/analysis-architecture.md`                      | Provides the finalized component boundaries, data contracts, non-touch files, and integration sequence documentation must reflect.   |
| Required     | `packages/rfmedia-cli/docs/features/verify-command.doc.md`                     | Current canonical verify guide; its existence/size-default narrative and result examples will otherwise contradict #116.             |
| Required     | `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`                    | Current repair guide describes direct recopy/count adjustment and must be aligned with evidence-proven staged repair and rechecking. |
| Required     | `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md` | Defines the issue #111 final-artifact fingerprint that default/deep consume and currently says read-time use is deferred to #116.    |
| Required     | `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`            | Defines schema-version-9 inventory and fingerprint semantics; verify adds a read-only consumer and configurable database path.       |
| Required     | `docs/features/file-integrity-verification.md`                                 | Public umbrella guide currently focuses on `rfmedia copy --verify` and explicitly defers read-time comparison to #116.               |
| Required     | `packages/rfmedia-cli/README.md`                                               | Main CLI reference contains the public option table, examples, JSON shape, fingerprint description, and completion instructions.     |
| Required     | `packages/rfmedia-cli/docs/features/performance-benchmarks.md`                 | Existing benchmark guide currently describes only existence and size verification and must define comparable tier workloads.         |
| Required     | `ROADMAP.md`                                                                   | Tracks #116 as pending in several places and must be updated with final issue/PR evidence only after merge.                          |
| Nice-to-have | `docs/plans/tiered-verification/research-business.md`                          | Exhaustive workflows and edge cases are useful when checking that public examples do not omit album/filter/range behavior.           |
| Nice-to-have | `docs/plans/tiered-verification/research-practices.md`                         | Records repository conventions for docs, completions, output, benchmarks, and compatibility.                                         |
| Nice-to-have | `docs/plans/tiered-verification/research-external.md`                          | Provides primary references for SHA-256, filesystem APIs, and tiered-integrity precedents; useful for rationale, not user syntax.    |
| Nice-to-have | `packages/rfmedia-cli/docs/features/tracking-system.md`                        | Background for operation identity, range expansion, and inventory selection; no broad rewrite is needed if behavior is unchanged.    |
| Nice-to-have | `packages/rfmedia-cli/docs/features/graceful-interruption.md`                  | Reference for cancellation wording and cleanup guarantees if the final implementation changes user-visible interruption behavior.    |
| Nice-to-have | `packages/rfmedia-cli/docs/features/shell-completion.doc.md`                   | Explains generation and stale-completion recovery; update only if its command-specific option inventory requires tier entries.       |

## Architecture Docs

### Documentation ownership

| Priority     | Document                                                                       | Owns                                                                                                                                    | Cross-links to                                                                                                         |
| ------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Required     | `docs/plans/tiered-verification/feature-spec.md`                               | Accepted planning contract and success criteria.                                                                                        | All implementation and public documentation; it is not itself the long-term user guide.                                |
| Required     | `docs/plans/tiered-verification/analysis-architecture.md`                      | Command/action/library boundaries, evidence data flow, typed outcomes, read-only database seam, and validation order.                   | `packages/rfmedia-cli/docs/features/verify-command.doc.md` for user-facing behavior.                                   |
| Required     | `packages/rfmedia-cli/docs/features/verify-command.doc.md`                     | Effective tier selection, flags, scope invariance, per-tier guarantees, applicability, result fields, output examples, and exit status. | Repair guide, hash-producer guide, tracking database guide, benchmark evidence, and umbrella integrity guide.          |
| Required     | `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`                    | Existing repair authorization plus proof, refusal, staging, atomic replacement, recheck, dry-run, and unresolved outcomes.              | Canonical tier/status terminology in `packages/rfmedia-cli/docs/features/verify-command.doc.md`.                       |
| Required     | `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md` | How a lowercase SHA-256 of final destination bytes is recorded for copy, conversion, and hardlink operations; nullable legacy rows.     | Verify guide as the consumer; it must not imply the fingerprint is authenticity evidence or a read-back check.         |
| Required     | `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`            | Inventory storage, schema compatibility, database-path configuration, and the distinction between mutable producers and read-only use.  | Verify guide for missing/newer/unsupported database behavior; no schema-v10 promise.                                   |
| Required     | `docs/features/file-integrity-verification.md`                                 | The integrity lifecycle: copy-time source/destination read-back versus later metadata/hash/direct verification.                         | Both command guides so `copy --verify` and `rfmedia verify --quick/--deep` are not conflated.                          |
| Required     | `packages/rfmedia-cli/docs/features/performance-benchmarks.md`                 | Reproduction commands, fixture shape, measurement units, controlled variables, cache/filesystem caveats, and recorded artifact link.    | A new issue #116 benchmark result under `docs/plans/tiered-verification/`.                                             |
| Nice-to-have | `docs/features/output-formats.md`                                              | Generic JSON/YAML/CSV/table/text behavior.                                                                                              | Verify-specific schema remains in the verify guide unless generic formatting changes.                                  |
| Nice-to-have | `docs/features/json-output.md`                                                 | Primarily the `rfapps` JSON contract and legacy `--json` usage.                                                                         | No #116 edit is needed unless shared global-output semantics change.                                                   |
| Nice-to-have | `packages/rfmedia-cli/docs/features/shell-completion.doc.md`                   | Installation and regeneration of generated completion scripts.                                                                          | The actual required option contract lives in the Bash, Zsh, and Fish templates plus parity tests, not this prose page. |

### Information flow

```text
copy/convert/hardlink
  -> packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md
  -> packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md
  -> stored final-artifact evidence
  -> packages/rfmedia-cli/docs/features/verify-command.doc.md
       -> quick: metadata only
       -> default: stored hash vs destination
       -> deep: default plus applicable direct comparison
       -> packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md
  -> docs/features/file-integrity-verification.md
       -> umbrella lifecycle and guarantee comparison
```

This hierarchy avoids copying a full tier matrix into every page. The verify guide should contain
the normative matrix; the README and umbrella guide should summarize it and link to the canonical
page. The hash and database guides should explain evidence provenance and limitations, not redefine
verification outcomes.

### Terminology contract

All required documents should consistently use these terms:

- **Mode** means album or filter selection/layout; **tier** means quick, default, or deep evidence.
- **Baseline** or **stored final-artifact fingerprint** means issue #111's destination SHA-256. It is
  local historical integrity evidence, not a signature or authenticity guarantee.
- **Direct comparison** means bounded byte-for-byte comparison of independent byte-identical source
  and destination artifacts. It is not applicable to conversions and is redundant for same-inode
  hardlinks.
- **Coverage** describes which evidence was available and applicable. `not-applicable` can accompany
  success; `unverifiable` cannot.
- **Mismatch** means available evidence disagreed. Missing, null, invalid, or ambiguous evidence is
  `unverifiable`, not a mismatch.
- **Repair** means restoring the destination to the stored baseline and re-running the selected tier.
  Verification never creates or silently refreshes a baseline.

## Reading List

### Required before implementation

1. `docs/plans/tiered-verification/feature-spec.md` — freeze accepted user and technical behavior.
2. `docs/plans/tiered-verification/research-recommendations.md` — understand selected decisions and
   deferred destination-ledger work.
3. `docs/plans/tiered-verification/analysis-architecture.md` — understand ownership, types, data
   flow, file scope, and validation order.
4. `docs/plans/tiered-verification/research-security.md` — preserve the read-only and safe-repair
   threat model.
5. `docs/plans/tiered-verification/research-ux.md` — freeze human/machine terminology before output
   fields and examples are written.
6. `packages/rfmedia-cli/docs/features/verify-command.doc.md` and
   `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md` — identify every existing promise
   that must remain compatible or be deliberately revised.
7. `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md` and
   `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md` — verify the producer/storage
   contract before documenting the consumer.

### Required before release

1. `packages/rfmedia-cli/README.md` — confirm flags, examples, tier table, output fields, completion
   notes, and compatibility text match the shipped CLI.
2. `packages/rfmedia-cli/docs/features/verify-command.doc.md` — compare every tier/status/coverage
   statement against focused tests and final field names.
3. `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md` — compare every mutation/refusal
   statement against repair tests and dry-run behavior.
4. `docs/features/file-integrity-verification.md` — confirm the copy-time/read-time distinction and
   links to both canonical command guides.
5. `packages/rfmedia-cli/docs/features/performance-benchmarks.md` and the new result artifact under
   `docs/plans/tiered-verification/` — reproduce the documented commands and record the 10x result
   without turning it into a flaky CI assertion.
6. `packages/rfmedia-cli/docs/features/shell-completion.doc.md` plus the generated Bash, Zsh, and Fish
   templates — confirm the documented regeneration path and actual option parity.
7. `ROADMAP.md` — update every #116 pending entry only after the final PR and merge links are known.

### Nice-to-have context

1. `docs/plans/tiered-verification/research-business.md` — audit uncommon range, conversion,
   hardlink, extra-file, and repair workflows.
2. `docs/plans/tiered-verification/research-practices.md` — audit repository-native testing,
   benchmark, completion, and documentation conventions.
3. `docs/plans/tiered-verification/research-external.md` — support concise rationale with primary
   Node.js, Borg, restic, and NIST references.
4. `packages/rfmedia-cli/docs/features/tracking-system.md` — understand range and operation identity
   without expanding #116 into a tracking redesign.
5. `packages/rfmedia-cli/docs/features/graceful-interruption.md` — align cancellation wording if any
   user-visible behavior changes.
6. `docs/README.md` — consider adding discoverability links to the canonical rfmedia integrity and
   verify guides.

## Documentation Gaps

| Priority     | Gap                                                                                   | Affected paths                                                                                                                                                                                                                                                                                                                                  | Required resolution                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required     | The documented default is existence-oriented, with size optional.                     | `packages/rfmedia-cli/docs/features/verify-command.doc.md`, `packages/rfmedia-cli/README.md`                                                                                                                                                                                                                                                    | State that omission of tier flags means default SHA-256 verification against exact stored final-output evidence. Keep `--verify-size` as an additive compatibility precheck, not a fourth tier or a weaker default.                                         |
| Required     | There is no complete tier-selection or guarantee matrix.                              | `packages/rfmedia-cli/docs/features/verify-command.doc.md`, `packages/rfmedia-cli/README.md`, `docs/features/file-integrity-verification.md`                                                                                                                                                                                                    | Document `--quick`, default, `--deep`, their mutual exclusion, `--tracking-database`, database/content-read behavior, and stable guarantees. Separate album/filter mode from tier.                                                                          |
| Required     | Converted, hardlink, legacy, ambiguous, and ranged coverage can be overclaimed.       | `packages/rfmedia-cli/docs/features/verify-command.doc.md`, `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md`, `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`                                                                                                                                 | Include a coverage table: converted deep is stored-hash verified with direct comparison `not-applicable`; same-inode comparison is redundant; null/invalid/ambiguous and unrepresented ranged evidence is `unverifiable`. Do not promise a schema redesign. |
| Required     | Machine and human result documentation lacks differentiated evidence outcomes.        | `packages/rfmedia-cli/docs/features/verify-command.doc.md`, `packages/rfmedia-cli/README.md`                                                                                                                                                                                                                                                    | Document additive tier, mismatch, coverage, instability, repair, and failure fields using final implementation names. Show deterministic examples without full hashes. State that unresolved missing/extra/mismatch/unverifiable/unstable/error is nonzero. |
| Required     | Current repair prose can imply direct overwrite and success-by-counter adjustment.    | `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`                                                                                                                                                                                                                                                                                     | Explain source reproducibility proof, private staging, verification before commit, preservation on pre-commit failure, final selected-tier recheck, no implicit rebaseline, and safe refusal for changed hardlinks or non-reproducible conversions.         |
| Required     | Hash-producer and database docs say read-time use is deferred or is not verification. | `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md`, `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`, `docs/features/file-integrity-verification.md`                                                                                                                                             | Preserve the distinction that write-time hashing is not read-back proof, then describe default/deep as the new read-time consumer. Add the purpose-built existing-file read-only path and missing/unsupported database behavior without implying migration. |
| Required     | Quick metadata precision and limitations are unspecified.                             | `packages/rfmedia-cli/docs/features/verify-command.doc.md`, `packages/rfmedia-cli/README.md`                                                                                                                                                                                                                                                    | State regular-file size plus integer-millisecond mtime comparison, no SQLite/content open, quick's freshness-not-integrity guarantee, and unavailable converted metadata under schema version 9.                                                            |
| Required     | Current benchmark docs compare existence-only and size-only verification.             | `packages/rfmedia-cli/docs/features/performance-benchmarks.md`, `packages/rfmedia-cli/benchmarks/verify.bench.ts`, new result artifact under `docs/plans/tiered-verification/`                                                                                                                                                                  | Define identical quick/default/deep expected sets, destination bytes, inventory state, worker count, filesystem/cache condition, and media-sized fixtures. Report files/s for quick and MiB/s for content tiers and explicitly record the 10x outcome.      |
| Required     | Completion parity is not represented in the user-facing feature checklist.            | `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`, `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`, `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`, `packages/rfmedia-cli/docs/features/shell-completion.doc.md`, `packages/rfmedia-cli/README.md` | Ensure all three generated templates expose `--quick`, `--deep`, and `--tracking-database`; document regeneration/reinstallation where appropriate. Treat template parity tests as the contract.                                                            |
| Required     | Older copy-integrity documents use “verification” without a read-time distinction.    | `docs/features/file-integrity-readme.md`, `docs/features/development-summary-file-integrity.md`, `docs/features/file-integrity-implementation.md`, `docs/features/file-integrity-quick-reference.md`                                                                                                                                            | Audit and either add a prominent historical/copy-time scope note with links to `packages/rfmedia-cli/docs/features/verify-command.doc.md`, or retire them through the repository's normal documentation policy. Do not silently leave conflicting guidance. |
| Required     | Roadmap status duplicates #116 as pending and has no final delivery evidence.         | `ROADMAP.md`                                                                                                                                                                                                                                                                                                                                    | After merge, update the Sprint 2 row, rfmedia backlog row, and status narrative together; retain the #111 / PR #233 / PR #248 history and add the actual #116 implementation PR.                                                                            |
| Required     | Privacy and trust boundaries are absent from ordinary usage documentation.            | `packages/rfmedia-cli/docs/features/verify-command.doc.md`, `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`                                                                                                                                                                                                                         | State that fingerprints are never printed in full, paths can still be sensitive, stored hashes are local integrity evidence rather than authenticity, and verification never accepts current bytes as a new baseline.                                       |
| Nice-to-have | Generic output documentation does not show a tiered verification example.             | `docs/features/output-formats.md`                                                                                                                                                                                                                                                                                                               | Add an example only if it materially improves automation guidance. Keep the normative verify schema in `packages/rfmedia-cli/docs/features/verify-command.doc.md`; `docs/features/json-output.md` remains rfapps-oriented.                                  |
| Nice-to-have | The root documentation index does not prominently surface rfmedia integrity guides.   | `docs/README.md`                                                                                                                                                                                                                                                                                                                                | Add links to the canonical umbrella and verify command guides if the index is intended to cover package-level rfmedia documentation.                                                                                                                        |
| Nice-to-have | Release history may not call out the behavioral default change.                       | `packages/rfmedia-cli/CHANGELOG.md` if present in the release workflow                                                                                                                                                                                                                                                                          | Add a concise release note when the repository's normal release process updates the changelog; do not invent a version during implementation.                                                                                                               |

`docs/features/shell-completion.md` is the rfapps completion guide and is not a #116 edit target.
Likewise, `docs/features/json-output.md` primarily documents rfapps command schemas. The #116 work
should not broaden into unrelated global-output or rfapps documentation changes unless implementation
actually changes those shared contracts.

The documentation pass is complete only when examples have been run against the shipped CLI, final
machine field names match tests, no page claims a stronger guarantee than the recorded evidence, the
benchmark artifact is reproducible, and every pending #116 roadmap entry is updated with real merge
evidence.
