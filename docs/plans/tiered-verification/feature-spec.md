# Feature Spec: Tiered Verification

## Executive Summary

GitHub issue #116 extends `rfmedia verify` with three explicit speed/confidence tiers while
preserving album/filter selection, repair, progress, and output workflows. `--quick` performs
metadata-only checks, the no-flag default compares destination SHA-256 with issue #111's stored
final-artifact fingerprint, and `--deep` retains that historical check plus direct byte comparison
where byte identity is meaningful. The implementation uses Node.js 22 built-ins, schema-version-9
inventory, and one shared per-file verifier. It does not add dependencies, silently downgrade
guarantees, create baselines during verification, or redesign traversal. Primary risks are
ambiguous evidence, jointly changed hardlinks, conversions, concurrent mutation, and destructive
repair from an untrusted source.

## External Dependencies

### APIs and Services

No network API or external service is required.

### Libraries and SDKs

| Library          | Version           | Purpose                                                     | Decision                                           |
| ---------------- | ----------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| Node.js          | 22+               | `node:crypto`, file streams/handles, buffers, `AbortSignal` | Reuse built-ins; no new runtime dependency         |
| `better-sqlite3` | Repository-pinned | Read stored inventory fingerprints                          | Add a verification-specific read-only opener/query |
| Commander        | Repository-pinned | Parse and reject conflicting tier flags                     | Reuse `Option.conflicts()`                         |
| Vitest           | Repository-pinned | Unit, integration, and benchmark evidence                   | Extend existing suites and `verify.bench.ts`       |

### External Documentation

- [Node.js 22 crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html): streaming SHA-256.
- [Node.js 22 file system](https://nodejs.org/docs/latest-v22.x/api/fs.html): stats, file handles,
  reads, streams, and abort behavior.
- [Node.js 22 streams](https://nodejs.org/docs/latest-v22.x/api/stream.html): abort-aware pipeline
  lifecycle.
- [Borg check](https://borgbackup.readthedocs.io/en/stable/usage/check.html): separates cheaper
  structure/metadata checks from explicit data verification.
- [restic integrity checks](https://restic.readthedocs.io/en/stable/045_working_with_repos.html#checking-integrity-and-consistency):
  distinguishes structural checks from full data reads.
- [NIST FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final): SHA-256 contract.

## Business Requirements

### User Stories

**Primary user: media-library operator**

- As an operator, I want `rfmedia verify --quick` to check expected files, size, and modification
  time without reading file contents so frequent checks are fast.
- As an operator, I want plain `rfmedia verify` to compare current destination bytes with the
  fingerprint recorded when the artifact was produced so silent corruption is detected.
- As an operator after migration or suspected storage failure, I want `rfmedia verify --deep` to
  perform every meaningful historical and direct comparison so I receive the strongest available
  evidence.
- As a conversion or hardlink user, I want the tool to describe applicable evidence accurately
  rather than reporting intentional differences or common-inode equality as independent proof.
- As a legacy-user, I want absent fingerprints reported as missing evidence rather than corruption
  or success.
- As an automation author, I want stable tier, outcome, coverage, repair, and failure fields without
  parsing human prose or seeing raw fingerprints.

### Business Rules

1. **Tier selection**: no tier flag selects `default`; `--quick` selects `quick`; `--deep` selects
   `deep`; `--quick --deep` is rejected before database or filesystem work.
2. **Common scope**: tier changes evidence only. All tiers derive the same expected/missing/extra
   artifacts for album/filter modes, ranges, conversions, duplicate names, multiple sources, and
   file input.
3. **Quick guarantee**: compare regular-file size and integer-millisecond `mtimeMs` without hashing
   or opening SQLite. Equal metadata is freshness evidence, not content-integrity proof.
4. **Default guarantee**: hash the final destination once and compare it with the exact stored
   final-artifact SHA-256. A missing/null/invalid/ambiguous baseline is explicit coverage failure,
   never a silent fallback.
5. **Deep guarantee**: perform default verification first, then direct bounded-memory byte
   comparison where byte identity is meaningful. Historical hash failure cannot be overridden by
   current path equality.
6. **Conversions**: default and deep verify the final converted-output hash. Deep direct comparison
   is `not-applicable`; quick metadata coverage is unavailable because schema v9 records source
   metadata, not converted destination metadata.
7. **Hardlinks**: stored-hash evidence remains authoritative for post-copy drift. Same-inode direct
   comparison is visible as redundant/not-applicable, not independent evidence.
8. **Baseline binding**: prefer a normalized exact destination match with source and conversion
   identity. Do not guess across operations or reuse a represented destination's fingerprint for
   another output unless the implementation can prove the same byte contract.
9. **Historical ranged coverage**: unrepresented schema-v9 ranged outputs are `unverifiable`.
   Complete destination-artifact identity is a follow-up, not a blocking child issue for truthful
   delivery of #116.
10. **Read-only default**: verification never creates/migrates a database, backfills hashes,
    refreshes timestamps, or accepts current bytes as a baseline.
11. **Repair authority**: `--fix`, dry-run, force, trash, and conflict strategies retain their
    existing authorization. Repair must prove the source can reproduce the stored baseline, stage
    safely where replacing content, and re-run the selected tier before counting success.
12. **Result truthfulness**: only artifacts satisfying every required and applicable check increase
    `verified`. Missing, mismatch, unverifiable, unstable, read error, failed repair, and unresolved
    extras make the result incomplete and nonzero.
13. **Compatibility**: preserve existing result fields additively. Keep `--verify-size` temporarily
    as an optional metadata precheck; it must not select or weaken a tier.
14. **Privacy**: routine human/machine/debug output never prints full expected or actual digests.

### Edge Cases

| Scenario                                        | Expected behavior                                              | Coverage/result                            |
| ----------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------ |
| Same-size, same-mtime content mutation          | Quick may pass; default/deep detect stored-hash mismatch       | Documented confidence trade-off            |
| Missing or `NULL` hash                          | Continue other files; do not backfill/fallback                 | `unverifiable`, nonzero                    |
| Converted output                                | Verify final destination hash; no source byte comparison       | Hash verified plus direct `not-applicable` |
| Changed hardlink                                | Stored hash detects drift even though source/destination match | Mismatch; refuse no-op repair              |
| Ranged destination not represented by inventory | Do not borrow an ambiguous baseline                            | `unverifiable`, nonzero                    |
| File changes during read                        | Do not return success; close resources                         | `unstable`, nonzero                        |
| Different size                                  | Quick reports size mismatch; deep may stop before reads        | Repairable discrepancy                     |
| Equal prefix then unequal EOF                   | Deep fails                                                     | Content mismatch                           |
| Missing tracking DB                             | Do not create it                                               | Coverage unavailable, nonzero              |
| Unsupported/newer DB                            | Reject read-only without mutation                              | Operational error, nonzero                 |
| Extra file explicitly kept                      | Still not part of expected set                                 | Unresolved extra, nonzero                  |
| Repair source differs from baseline             | Preserve existing destination/baseline                         | Safe repair refusal                        |

### Success Criteria

- [ ] All album and filter input/layout modes select and report quick/default/deep consistently.
- [ ] Quick performs no content read or database open and compares size plus documented mtime
      precision.
- [ ] Default detects same-size/same-mtime corruption against an exact stored final-artifact hash,
      including converted output.
- [ ] Deep is monotonic with default and byte-compares byte-identical files with bounded memory,
      correct short-read/EOF handling, cancellation, and stability checks.
- [ ] Missing/null/invalid/ambiguous baselines, unsupported converted metadata, and unrepresented
      ranged outputs are visible coverage states and cannot yield false success.
- [ ] Repair uses evidence-proven source content, preserves the original until a verified
      replacement is ready, and counts success only after tier re-verification.
- [ ] Text and machine output expose tier, differentiated outcomes, coverage, post-repair state,
      and consistent exit behavior without full hashes.
- [ ] Bash, Zsh, and Fish completion templates and parity tests include every new verify option.
- [ ] Documentation and `ROADMAP.md` accurately describe guarantees, limitations, repair, output,
      issue closure, and the relationship to #111/PRs #233 and #248.
- [ ] Reproducible benchmark evidence compares identical media-sized quick/default/deep workloads
      and records whether quick achieves the issue's 10x target; CI uses a smoke run, not a flaky
      timing assertion.
- [ ] Focused/full tests, typecheck, build, format/lint gates, graph update, formal review/fix, and
      green CI complete before squash merge and cleanup.

## Technical Specifications

### Architecture Overview

```text
commands/verify.ts
  -> resolve tier, scope, output, DB path
  -> actions/verify-album.ts OR actions/verify-filter.ts
       -> existing expected-artifact mapping / missing / extras / repair
       -> preload read-only fingerprint candidates when tier needs them
       -> lib/tiered-verification.ts
            -> quick: stat metadata
            -> default: destination SHA-256 vs exact baseline
            -> deep: default + applicable direct comparison
                 -> lib/integrity.ts bounded hash/compare primitives
       -> shared typed aggregation and unresolved-state predicate
  -> human or machine formatter -> consistent process exit status

db.ts read-only opener/query -> inventory JOIN operations -> exact destination-bound candidates
```

### Data Models

#### Verification option

```ts
export type VerificationTier = "quick" | "default" | "deep";

export interface VerifyOptions {
  // existing options remain
  tier: VerificationTier;
  trackingDatabase?: string;
}
```

#### Per-file outcome

```ts
export type FileVerifyStatus =
  | "present"
  | "missing"
  | "size-mismatch"
  | "metadata-mismatch"
  | "hash-mismatch"
  | "content-mismatch"
  | "unverifiable"
  | "not-applicable"
  | "unstable";

export type VerificationReason =
  | "mtime"
  | "fingerprint-missing"
  | "fingerprint-null"
  | "fingerprint-invalid"
  | "fingerprint-ambiguous"
  | "conversion-metadata-unavailable"
  | "conversion-byte-compare"
  | "same-inode-byte-compare"
  | "changed-during-read";
```

`VerifiedFile` gains additive `reason`, evidence, and optional size fields. Full digests are not
part of the public result.

#### Aggregate result

`VerifyCommandResult` retains `verified`, `missing`, `sizeMismatch`, `extra`, `expectedTotal`,
`issues`, `failed`, and repair fields. It adds `tier`, `metadataMismatch`, `hashMismatch`,
`contentMismatch`, `unverifiable`, `notApplicable`, and `unstable`. One shared helper determines
whether any unresolved state remains and drives summary, machine status, and exit code.

#### Fingerprint candidate

```ts
export interface DbInventoryFingerprint extends DbInventoryEntry {
  convert_key: string | null;
}
```

No schema version change is required. A fixed prepared query joins `inventory` to `operations`,
filters requested sources, and orders `copied_at DESC, inventory.id DESC`. In-memory resolution
requires normalized source/conversion identity and exact derived destination. Empty source input
returns an empty set without generating `IN ()`.

### Internal API Design

```ts
export interface VerifyFileInput {
  tier: VerificationTier;
  sourcePath: string;
  destinationPath: string;
  converted: boolean;
  fingerprint?: DbInventoryFingerprint;
  signal?: AbortSignal;
}

export async function verifyFileByTier(input: VerifyFileInput): Promise<VerifyFileOutcome>;

export async function calculateHash(path: string, signal?: AbortSignal): Promise<string>;

export async function compareFileBytes(
  sourcePath: string,
  destinationPath: string,
  signal?: AbortSignal,
): Promise<ByteCompareResult>;

export function openDatabaseReadOnly(path: string): DbConnection;

export function getInventoryFingerprintCandidates(
  db: DbConnection,
  sourcePaths: readonly string[],
): DbInventoryFingerprint[];
```

`verifyFileByTier` is framework-free: it does not log, prompt, repair, open SQLite, or set exit
state. Actions keep the existence check and mode-specific path mapping.

### System Integration

#### Files to create

- `packages/rfmedia-cli/src/lib/tiered-verification.ts`: tier policy, baseline resolution, typed
  per-file outcomes, and shared aggregation helpers.
- `packages/rfmedia-cli/src/lib/tiered-verification.test.ts`: focused tier/coverage tests.

#### Files to modify

- `packages/rfmedia-cli/src/commands/verify.ts`: flags/conflicts, tier, database path, additive
  machine output, and consistent unresolved exit predicate.
- `packages/rfmedia-cli/src/actions/verify-album.ts`: shared verifier integration, baseline preload,
  typed aggregation, safe repair/recheck.
- `packages/rfmedia-cli/src/actions/verify-filter.ts`: same policy for flat, structured, album,
  range, and duplicate-name flows.
- `packages/rfmedia-cli/src/types/{options,results,index}.ts`: public types and exports.
- `packages/rfmedia-cli/src/lib/{integrity,db}.ts` and tests: abort-aware reads, direct comparison,
  read-only database and exact candidate query.
- Relevant command/action tests: selection, aggregation, conversion/hardlink/range/repair/output.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` and `templates.spec.ts`.
- `packages/rfmedia-cli/benchmarks/{verify.bench,helpers}.ts` plus recorded benchmark evidence.
- `packages/rfmedia-cli/docs/features/{verify-command.doc,verify-auto-fix.doc,content-hashing-during-copy-operations}.md`,
  `docs/features/file-integrity-verification.md`, `packages/rfmedia-cli/README.md`, and `ROADMAP.md`.

#### Explicit non-goals

- No schema migration, artifact ledger, automatic baseline/backfill/rebaseline, verification
  history, signatures, configurable hash algorithm, worker threads, external comparator, generalized
  traversal rewrite, or extension to unrelated Plex/playlist/watch/video producers.
- No blocking child issue. A destination-artifact ledger is a non-blocking follow-up only if later
  work requires complete historical ranged/converted metadata coverage.
- Dependency audit findings predate this feature and are not remediated in this PR unless a touched
  dependency is required; tier implementation adds no dependency.

## UX Considerations

### User Workflows

1. The command identifies the effective tier and evidence model before expensive work.
2. Quick progress is file-based; default/deep progress is byte-based where supported and remains on
   human stderr, never machine stdout.
3. The final summary distinguishes verified, mismatch, missing, extra, unverifiable,
   not-applicable, unstable, failed, and repaired counts.
4. Human errors state the failed guarantee and one safe next step. Machine formats expose stable
   enum reasons and numeric counters.
5. A deep run on converted output may be complete when the stored final-output hash passes; the
   direct source comparison is visibly `not-applicable` rather than falsely claimed.
6. `--fix` previews/authorizes using existing conventions and reports post-repair verification, not
   merely successful filesystem calls.

### Error Recovery Workflow

1. Missing/invalid evidence remains read-only and suggests quick or re-running the trusted producing
   workflow; it never suggests accepting current destination bytes silently.
2. Content mismatch checks whether current source content can reproduce the baseline before
   replacement.
3. A verified staged replacement is committed and final-path verification repeats.
4. If source/baseline reproduction fails, the original remains and the user is directed to a
   known-good source/backup or separately designed rebaseline workflow.

### Performance UX

- Help names quick as metadata-only, default as one destination read, and deep as stored-hash plus
  applicable source/destination reads.
- Keep per-file success quiet; group problem samples and reserve full detail for verbose output.
- Report elapsed time/throughput in benchmark evidence; avoid a universal runtime promise based on
  one filesystem/cache state.

## Recommendations

### Implementation Approach

**Recommended strategy**: implement contract/primitives first, integrate album/filter through the
same verifier second, make repair evidence-aware third, and complete public-surface/evidence work
last. Keep action traversal and schema stable while making unavailable coverage explicit.

### Technology Decisions

| Decision         | Recommendation                                             | Rationale                                                            |
| ---------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| Deep semantics   | Stored hash plus applicable byte comparison                | Monotonic confidence; detects jointly changed hardlinks              |
| Converted deep   | Stored final-output hash, direct comparison not applicable | Source/output bytes intentionally differ                             |
| Quick conversion | Coverage unavailable                                       | Schema v9 lacks destination metadata baseline                        |
| Baseline lookup  | Exact destination + source/conversion identity             | Avoids cross-operation/range false evidence                          |
| Unknown baseline | `unverifiable`, nonzero                                    | Absence is neither match nor corruption                              |
| Repair           | Prove source, stage, verify, commit, reverify              | Preserves the only copy and the historical expectation               |
| Tracking DB      | Existing-file, read-only opener/query                      | Ordinary verify must not mutate/create evidence                      |
| Dependencies     | Node built-ins/current stack                               | Sufficient capability and smaller security surface                   |
| Child issues     | None blocking                                              | Truthful partial coverage ships core issue; ledger is follow-up only |

### Phasing

1. **Contract and primitives**: types, flag semantics, read-only baseline provider, hashing/direct
   comparison, stability/cancellation, pure tests.
2. **Action integration**: album and filter mapping, aggregation, output, conversions/hardlinks,
   safe repair and recheck.
3. **Public contract**: shell completions, help, machine fields, docs, roadmap.
4. **Evidence and release**: benchmarks, full validation, graph update, PR/review/fix/CI/merge/cleanup.

### Future Enhancements

- One-row-per-destination artifact ledger with destination metadata baselines.
- Explicit trusted baseline adoption/migration for legacy content.
- Deterministic subset/time/byte-budget deep verification.
- Converter provenance/reproducibility and persistent verification history.
- Authenticated/signed inventories for hostile-writer threat models.

## Risk Assessment

### Technical Risks

| Risk                                              | Likelihood | Impact | Mitigation                                                   |
| ------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------ |
| Missing/ambiguous evidence produces false success | Medium     | High   | Exact deterministic lookup; explicit incomplete coverage     |
| Deep pairwise equality misses changed hardlink    | Medium     | High   | Require stored-hash evidence; detect same inode              |
| File replaced/modified during read                | Medium     | High   | Open handles, pre/post stats, unstable outcome, cancellation |
| Repair destroys the useful copy                   | Medium     | High   | Verify staged replacement before authorized atomic commit    |
| Converted file compared with source               | Medium     | High   | Final-output hash; direct comparison not applicable          |
| Quick overclaims timestamp confidence             | Medium     | Medium | Size plus integer mtime; documentation; no integrity wording |
| Storage saturation/descriptors                    | Medium     | Medium | Existing worker bound, fixed buffers, cleanup, benchmarks    |
| Existing scripts break                            | Medium     | Medium | Additive result fields, stable reasons, documented default   |
| Ranged historical coverage incomplete             | High       | Medium | Explicit `unverifiable`; optional later artifact ledger      |

### Security Considerations

#### Critical — Hard Stops

| Finding                        | Risk                                               | Required mitigation                                                                              |
| ------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Path/symlink/TOCTOU confusion  | Reading or replacing outside requested destination | Derive paths from scope; regular-file/open-handle checks; containment revalidation before repair |
| Wrong or malformed fingerprint | False integrity claim                              | Runtime digest validation; deterministic exact identity; fail closed on ambiguity                |
| Destructive unverified repair  | Loss of the only recoverable artifact              | Prove source, stage replacement, verify, atomic commit, final recheck                            |

#### Warnings — Must Address

| Finding                               | Risk                               | Mitigation                                                     | Alternative                      |
| ------------------------------------- | ---------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| Resource exhaustion/cancellation gaps | Storage/descriptor exhaustion      | Fixed chunks, worker bound, abort propagation, `finally` close | Lower documented concurrency     |
| Verification DB mutation              | Evidence store changes during read | Purpose-built read-only open/query                             | Require prior explicit migration |
| Concurrent file mutation              | False pass                         | Before/after open-handle stats and unstable result             | Retry later                      |

#### Advisories — Best Practices

- Keep full hashes out of logs/results; classifications are sufficient.
- Document SHA-256 as local integrity evidence, not authenticated provenance.
- Sort/bound machine issue details for deterministic automation.
- Track existing dependency advisories separately; add no new dependency here.

## Task Breakdown Preview

### Phase 1: Foundation

**Focus**: Freeze semantics and implement testable evidence primitives.

- Add tier/outcome types and CLI conflict/default behavior.
- Add abort-aware hashing, byte comparison, stability checks, and real-file tests.
- Add existing-file read-only database access and exact candidate resolution tests.

**Parallelization**: integrity and database primitives can proceed independently after contract freeze.

### Phase 2: Integration

**Focus**: Apply the shared policy without changing expected-artifact selection.

- Integrate album verification and post-repair recheck.
- Integrate flat/structured/album filter verification and duplicate mapping.
- Centralize aggregation/unresolved predicate and additive output.

**Dependencies**: Phase 1.

### Phase 3: Public Surface

**Focus**: Make guarantees discoverable and automation-safe.

- Update Bash/Zsh/Fish completions and parity tests.
- Update help, README, verification/integrity/fix/hash docs, and ROADMAP.
- Extend benchmark fixtures/rows and record representative 10x evidence honestly.

### Phase 4: Delivery

**Focus**: prove and ship the complete lifecycle.

- Run focused/full validation and graph update.
- Open a template-compliant PR with `Closes #116`.
- Perform formal review, apply/finalize every actionable finding, and revalidate.
- Monitor CI to green, squash merge, verify issue closure, and clean branch/worktree state.

## Decisions Needed

The design workflow adopts these defaults so planning can proceed without a checkpoint:

1. Deep is cumulative: stored-hash verification plus applicable direct byte comparison.
2. Converted deep succeeds at the strongest applicable stored-hash guarantee while reporting direct
   comparison `not-applicable`; converted quick is coverage-unavailable.
3. Baseline selection is exact destination-bound; ambiguous/unrepresented ranged artifacts remain
   unverifiable rather than borrowing evidence.
4. Unknown evidence, instability, failures, and extras are nonzero incomplete results.
5. `--verify-size` remains temporarily additive and cannot weaken the selected tier.
6. Verification and repair never rebaseline implicitly.
7. No blocking child issue is required; destination-artifact identity is a future follow-up only if
   later coverage requirements justify it.

## Research References

- [research-external.md](./research-external.md): official APIs and proven tier patterns.
- [research-business.md](./research-business.md): workflows, business rules, and acceptance criteria.
- [research-technical.md](./research-technical.md): architecture, contracts, and file scope.
- [research-ux.md](./research-ux.md): CLI behavior, coverage language, progress, and output.
- [research-security.md](./research-security.md): severity-ranked trust, path, repair, and resource risks.
- [research-practices.md](./research-practices.md): reuse, module boundaries, test seams, and KISS guidance.
- [research-recommendations.md](./research-recommendations.md): consolidated decisions and task preview.

---

_Source: GitHub issue #116 and validated seven-role feature research_
_Generated: 2026-07-19_
_Status: ACCEPTED FOR PLANNING_
