# Security Research: Tiered Verification

## Executive Summary

Tiered verification does not add a network or authentication boundary, but it raises the authority
and assurance of `rfmedia verify`: default and deep modes will read whole media files, consume a
persisted inventory as evidence, and `--fix` can overwrite or delete library content. The design
must therefore keep two claims separate. SHA-256 can establish that current destination bytes match
the write-time fingerprint; it cannot authenticate a database that an attacker can also modify, and
source/destination equality cannot recover an original baseline when both ends of a hardlink have
mutated.

No CRITICAL vulnerability is inherent in the feature. Four WARNING-level controls should be
implementation gates: bind every path to the user-selected source/destination scope despite
symlinks and inventory data; verify stable opened file identities rather than mutable pathnames;
strictly validate and deterministically associate inventory baselines; and make repair atomic,
source-safe, and subject to post-repair verification. Cancellation and bounded concurrency are also
required because deep verification can multiply I/O across large libraries.

The feature needs no new runtime dependency. Node.js built-in filesystem, crypto, and stream APIs
are sufficient. However, `npm audit --omit=dev` on 2026-07-19 reports five production dependency
advisories, including high-severity availability issues in `music-metadata`, `picomatch`, and `ws`.
The affected parsing dependencies matter especially in filter mode, where verification reads audio
metadata before it verifies content. They should be upgraded and regression-tested independently of
the tier implementation.

## Findings by Severity

### CRITICAL

No critical vulnerability was identified in the proposed local-only feature. Tiered verification
does not need privileged execution, shell commands, remote credentials, or a new cryptographic
dependency. A future design that follows inventory paths outside the requested root while running
as a privileged user, treats an unauthenticated hash as adversary-resistant proof, or invokes a
shell hashing command would require a new critical-risk assessment.

### WARNING

| ID      | Finding                                                                                                            | Impact / evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Required mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Trade-off                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-W01 | Path scope, symlink traversal, and pathname races can redirect reads or repairs.                                   | Current verification resolves source directories but constructs destinations with `path.join()`, checks them with pathname-based `pathExists()`/`stat()`, and later calls `remove()`, `copyOrLink()`, or `convertFile()` on those names. Inventory additionally stores absolute `dest_path` and JSONL loading casts file records without structural validation. A replaced directory component or hostile inventory row could make verification read, overwrite, trash, or remove content outside the requested destination.                                                                                                                | Canonicalize the requested source and destination roots once; reject non-directory roots and NUL/control characters. Treat inventory `relativePath` and `destPath` as claims, never authority: derive the expected destination from the command's mapping, require lexical and canonical containment, and require a destination-bound row match. Use `lstat()` to reject symlink artifacts and symlinked intermediate components for repair. Revalidate parent and target identity immediately before mutation; where available open with no-follow/exclusive semantics. Never let `--force` bypass scope checks.                                                                                       | Strict no-symlink policy may reject intentionally symlinked libraries. If symlink support is required, resolve it explicitly at the root and bind all later paths beneath that resolved root rather than following per-file links. |
| SEC-W02 | Metadata, hash, and deep comparison can report a pass for bytes that changed during the read.                      | A `stat(path)` followed by `createReadStream(path)` is a time-of-check/time-of-use boundary. Concurrent writers can modify or replace a file during hashing; paired source/destination reads can observe inconsistent generations. Current `calculateHash()` has no `AbortSignal` and current verify actions do not pass their signal into per-file checks. Hardlinks are particularly mutable: source and destination may be the same inode, so direct equality adds no evidence after shared-byte drift.                                                                                                                                  | Open each regular file once and operate on its `FileHandle`; record `dev`, `ino`, size, `mtimeNs`/`ctimeNs` before the read and `fstat()` again after it. Return a distinct unstable/error result if identity or relevant metadata changed, with at most one bounded retry. Deep comparison must compare filled buffer slices, confirm EOF on both handles, and run the stored destination-hash check first. Detect same-inode hardlinks and label direct comparison redundant/not applicable; baseline mismatch still fails deep.                                                                                                                                                                      | More syscalls and occasional retry increase runtime. Live/growing media must be reported unstable instead of being optimistically accepted.                                                                                        |
| SEC-W03 | Inventory contents and operation selection are not yet safe verification evidence.                                 | SQLite write boundaries validate new non-null hashes, but the schema has no `CHECK`, an existing database can be externally modified, and legacy JSONL records are only shallowly distinguished before `file` is cast. `findOperation()` selects the latest row matching optional fields; “most recent” without exact destination/artifact identity can associate a valid hash with the wrong ranged or duplicate output. Version-8 rows and older JSONL legitimately have no hash.                                                                                                                                                         | At the verification read boundary validate exact field types, finite safe sizes/timestamps, normalized source-relative paths, destination containment, and `/^[a-f0-9]{64}$/` for every non-null digest. Malformed evidence is `error`; missing/NULL evidence is `unverifiable`; neither is a mismatch or success. Select baselines deterministically by operation options plus normalized source, relative artifact identity, conversion, and exact derived destination. Detect duplicates/ambiguity and fail closed. Ordinary verify must open tracking read-only and must not migrate, backfill, or rebaseline.                                                                                      | Older and ranged operations will have partial coverage until artifact identity is expanded or an explicit migration/rebaseline workflow exists. Honest partial coverage is safer than silent downgrade.                            |
| SEC-W04 | Existing repair behavior can destroy the only useful copy and claim success without proving integrity.             | Current mismatch repair removes the destination before copy/conversion, supports rename as a successful copy, and updates counts from `copiedFiles` rather than re-running verification. A destination mismatch does not prove the current source matches the original baseline. With a mutated hardlink both names contain the same wrong bytes; with conversion, rerunning a nondeterministic encoder may produce a different valid file. An interruption after removal also leaves the artifact missing.                                                                                                                                 | Before repair, prove the source can reproduce the expected baseline: hash byte-identical source files against the stored destination hash; for conversion, regenerate into a private temporary file in the final directory and compare the completed output with the stored final-artifact hash. If it does not match, retain the existing destination and report that a known-good source or explicit rebaseline is required. Use exclusive temporary creation, flush/close, atomic rename under revalidated parent identity, and cleanup on every failure/abort. Re-run the selected tier after repair; only post-repair evidence changes counts. Rename must not resolve the original expected path. | Repair reads more data and some historical conversions may be unrepairable byte-for-byte. Preserving evidence is preferable to silently redefining integrity.                                                                      |
| SEC-W05 | Deep/default verification can exhaust disk, CPU, descriptors, or runtime and cancellation is currently incomplete. | The worker pool is capped at eight, but a deep check can open two files per task and read both source and destination, while default hashes every destination. Filter expected-set discovery also parses metadata. `processInParallel()` stops queued work after abort but waits for already-running processors, and current hashing does not receive the signal. A library with huge, sparse, remote, or device-like files can monopolize I/O.                                                                                                                                                                                             | Require regular files from `fstat()`; reject devices, FIFOs, sockets, and directories. Pass one `AbortSignal` through every hash/read loop and check it between manual reads. Close handles in `finally`; stop scheduling new work on abort; bound workers and buffer sizes; avoid a second independent pool. Add per-artifact and aggregate byte counters, and consider an optional byte/time budget for scheduled deep checks. Test interruption while hashing and comparing, including descriptor cleanup.                                                                                                                                                                                           | Lower concurrency and budgets reduce throughput. A budgeted run must report incomplete coverage and never present itself as a fully successful deep verification.                                                                  |
| SEC-W06 | Current dependency versions expose availability risks on verification inputs.                                      | `npm audit --omit=dev` reports five production vulnerabilities. The worktree resolves `music-metadata@11.10.6` (affected by the ASF infinite-loop advisory GHSA-v6c2-xwv6-8xf7), `file-type@21.3.0` beneath it (ASF loop and ZIP decompression-bomb advisories), direct `js-yaml@4.1.1` (quadratic merge-alias handling), direct/transitive `picomatch@4.0.3`/`2.3.1` (method injection and ReDoS advisories), and `ws@8.19.0` under the workspace's Ink dependency (memory disclosure/exhaustion advisories). Tier code itself does not require these packages, but filter-mode verification parses untrusted media metadata and patterns. | Upgrade to fixed releases through the lockfile, beginning with `music-metadata`/`file-type`, `js-yaml`, and direct `picomatch`; verify the workspace path that introduces `ws` and upgrade its parent safely. Run focused metadata/filter/config/glob tests plus the full production audit. Keep hashing and byte comparison on Node built-ins and do not add a third-party hasher/comparator. Where parsing remains reachable, retain cancellation and input-size/time bounds.                                                                                                                                                                                                                         | Dependency updates may contain behavior or engine changes and should not be hidden inside the tier feature if they materially expand review scope. Track separately if necessary, but document residual risk before release.       |

### ADVISORY

| ID      | Finding                                                                                               | Impact / evidence                                                                                                                                                                                                                                                                                                       | Required mitigation                                                                                                                                                                                                                                                                                                                              | Trade-off                                                                                                                                                    |
| ------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SEC-A01 | Full paths and hashes can leak private library information.                                           | Current debug logging prints complete source/destination paths, and `verifyFileIntegrity()` prints both complete SHA-256 values on mismatch. Hashes are stable fingerprints that can correlate known media across systems; paths disclose artist/title and storage layout. Errors and JSON are also automation-visible. | Do not print stored or calculated full digests in normal, JSON, or debug output. Emit classification/reason codes and, only if useful, a short non-authoritative prefix. Keep machine output on stdout and logs on stderr. Sanitize control characters and bound path/error text; document that detailed logs may contain media paths.           | Reduced forensic detail; operators can explicitly calculate hashes outside the command when required.                                                        |
| SEC-A02 | SHA-256 provides integrity against accidental change, not authenticity.                               | An actor who can alter both a destination and the writable tracking database/JSONL can replace the file and its fingerprint. No secret key or trusted manifest anchors the baseline.                                                                                                                                    | State the threat model in docs and output: the stored hash is a local write-time fingerprint. Protect source, destination, database, WAL, SHM, and legacy inventory with least-privilege filesystem permissions and backups. If hostile-writer detection becomes a requirement, design signed or keyed manifests with separately protected keys. | Signing introduces key lifecycle and recovery complexity that is not justified for issue #116.                                                               |
| SEC-A03 | Quick-tier timestamps can be ambiguous or attacker-controlled.                                        | `mtime` can be preserved or reset, filesystem precision varies, and hardlinks share metadata. Existing inventory `mtime`/`size` describe the source, not necessarily a converted destination. A broad tolerance can hide meaningful changes.                                                                            | Define quick as freshness evidence only. Compare size plus a documented precision/tolerance using destination metadata captured at finalization; use nanosecond values where supported and never compare converted output with source size. If no destination metadata baseline exists, return `unverifiable`.                                   | Quick will not cover older or converted artifacts without a new baseline field. That limitation must remain visible.                                         |
| SEC-A04 | Stable machine results require deterministic ordering and bounded evidence.                           | Parallel verification can complete in nondeterministic order. Raw OS errors may vary, contain control characters, or be very large. Inconsistent ordering complicates policy checks and audit diffs.                                                                                                                    | Define a versionable JSON result, stable enums, exact coverage totals, and sort file results by normalized relative path using a fixed comparator. Keep volatile timings separate. Bound/sanitize OS messages and never let progress/spinners contaminate machine stdout.                                                                        | Sorting retains per-file results in memory; for very large libraries, use bounded streaming plus a documented ordering contract or an optional detail limit. |
| SEC-A05 | SQLite read-only verification can still accidentally mutate state if it reuses normal initialization. | `initializeDatabase()` enables WAL, runs schema SQL, and migrations after a read-only preflight. This is appropriate for normal commands but violates the business rule that verification must not backfill or migrate. WAL/SHM creation also changes the tracking store.                                               | Add a verification-specific read-only opener with `fileMustExist`, `query_only`, schema-version validation, and no schema execution, migration, WAL change, or database creation. Close it in `finally`. Missing/newer/malformed stores become typed coverage/errors.                                                                            | A database needing migration cannot supply current-tier evidence until the user runs an explicit migration-capable command.                                  |

## Authentication and Authorization

- There is no remote authentication in this feature. Operating-system permissions of the invoking
  process are the authorization boundary for sources, destinations, tracking stores, and trash.
- `--fix`, `--force`, `--trash`, and `--conflict-strategy` authorize only documented operations on
  the expected artifact inside the selected destination. They do not authorize following symlinks,
  trusting inventory paths, accepting a new baseline, or writing outside the destination root.
- Recommend an unprivileged media account scoped to intended library roots. Running verification as
  root magnifies race and path-confusion impact and should not be required.
- A custom tracking database or legacy inventory path is authority-bearing input. Verification must
  require a regular readable file, reject symlinked stores in strict mode, and never create missing
  parents/files merely because a verification tier needs a baseline.
- Plugins share process authority. If verification hooks are later added, any mutation-capable hook
  invalidates prior identity checks; stability and scope checks must occur after the hook.

## Data Protection

- Treat fingerprints, absolute paths, media metadata, SQLite WAL/SHM files, and legacy JSONL as one
  local sensitive dataset. Preserve restrictive permissions and avoid copying it into PR artifacts,
  telemetry, or ordinary command output.
- Use prepared statements with positional bindings for all inventory queries. Existing `db.ts`
  follows this pattern; dynamic SQL fragments are assembled from fixed internal field names. Never
  interpolate a source path, destination, relative path, hash, tier, or CLI option into SQL.
- Validate data after SQLite/JSON parsing. Static TypeScript casts do not validate an externally
  editable database or JSONL record at runtime.
- Full hashes are unnecessary for routine diagnosis. Report `hash-mismatch`, `missing-baseline`, or
  `invalid-baseline`, not expected/actual digest values.
- Do not persist verification results or refresh `copied_at` during ordinary verification. If an
  audit-history feature is added later, store only bounded classifications and normalized paths
  under an explicit retention policy.

## Dependency Security

| Dependency / boundary               | Current posture                                                                                                | Recommendation                                                                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js `node:crypto` and file APIs | Built-in SHA-256, streams, `FileHandle`, `AbortSignal`; no external executable required                        | Use exclusively for default/deep reads. Pin the supported Node major in CI and test Linux/macOS filesystem differences.                                                         |
| `better-sqlite3`                    | Existing native dependency; current repository queries use prepared statements                                 | Add a read-only verification opener and fixed prepared queries. Validate all returned fields and close on abort/error.                                                          |
| `music-metadata` / `file-type`      | Current resolved versions have availability advisories; filter mode parses media during expected-set discovery | Upgrade to fixed versions and add malformed ASF/large-input timeout regression coverage. Do not parse metadata in quick/default/deep more than expected-set selection requires. |
| `js-yaml`                           | `4.1.1` is affected by quadratic merge-alias parsing                                                           | Upgrade to a fixed release and retain document-size/structure validation for config and paths YAML.                                                                             |
| `picomatch`                         | Direct `4.0.3` and transitive `2.3.1` are reported vulnerable                                                  | Upgrade direct and parent dependencies; bound user patterns and test adversarial extglobs.                                                                                      |
| `ws`                                | `8.19.0` is present transitively elsewhere in the workspace and has current advisories                         | Upgrade the owning dependency. Confirm whether it is reachable from shipped rfmedia code, but keep the production lockfile clean.                                               |

No new hashing, comparison, worker-pool, or database library is justified for issue #116.

## Input Validation

- Parse the tier as one enum: `quick`, `default`, or `deep`. Reject `--quick --deep` before opening
  the database, scanning paths, or performing any repair.
- Validate source/destination roots as existing directories and reject same-path or nested layouts
  that would make destination extras part of source discovery. Normalize Unicode only for display;
  filesystem identity must use platform-appropriate canonical paths and open-handle identity.
- Reject absolute inventory `relativePath` values, `..` segments, NUL/control characters, empty
  basenames, special files, unsafe numeric values, and any derived path outside the selected root.
- Validate hashes on read even though new database writes validate them. Lowercase 64-character hex
  is the only accepted SHA-256 representation; no algorithm inference from arbitrary length.
- Cap JSONL line length, total records, and error evidence. A malformed line relevant to a requested
  source is an error, not silently skipped evidence.
- Treat duplicate destination mappings and duplicate baselines as ambiguity. Do not choose one by
  traversal order, database row order, or timestamp alone.

## Infrastructure Security

- Network filesystems, FUSE mounts, removable media, and cloud-synchronized directories may not
  provide local atomic-rename, inode, timestamp, or cache-coherency guarantees. Document that a
  stable local filesystem gives the strongest result; surface unsupported semantics as
  unverifiable/error rather than weakening the tier.
- Sparse files and reflinks can have large logical sizes with low physical usage. Verification
  budgets and progress must use logical bytes read and must not preallocate buffers based on file
  size.
- Deep verification can compete with media streaming and storage maintenance. Respect the existing
  worker cap, expose bytes checked, and support scheduling/budget guidance; do not silently increase
  concurrency based only on CPU count.
- Trash implementations and atomic rename behavior are platform-dependent. Scope checks happen
  before both permanent removal and trash; failure to trash must preserve the target and return a
  failed repair.

## Secure Coding Guidelines

1. Separate expected-artifact mapping, baseline lookup, evidence gathering, classification, output,
   and repair into typed stages. Only the repair stage may mutate.
2. Derive paths from trusted command scope; use inventory paths only to confirm exact equality with
   the derived artifact identity.
3. Open regular files first, compare open-handle identity and metadata before/after reads, and close
   in `finally` on success, error, and abort.
4. Make deep a strict superset of default: stored destination hash first, then exact source/dest
   comparison only where byte identity is part of the copy contract.
5. Never silently downgrade. Missing, malformed, ambiguous, or inapplicable evidence has an explicit
   coverage classification and prevents a full-success result at the requested tier.
6. Keep repair fail-safe: prove reproducibility, create a private temporary artifact, verify it,
   revalidate authority, atomically replace, and then verify the final path again.
7. Preserve the original on every pre-commit error. Never remove a mismatched destination before a
   verified replacement is ready.
8. Propagate `AbortSignal` to hashes, paired reads, metadata selection, and repairs. Treat aborted
   work as incomplete/error, not matched.
9. Keep SQL static and bound. Use a read-only connection for verification and do not invoke normal
   initialization/migration code.
10. Add adversarial tests for symlink swaps, `..` inventory paths, malformed hashes/JSONL, duplicate
    baselines, same-inode hardlinks, mutation during hash/compare, short reads, unequal EOF,
    cancellation, descriptor cleanup, conversion repair failure, and post-repair re-verification.

## Trade-off Recommendations

| Decision        | Recommended default                                                                            | Security trade-off                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Symlinks        | Resolve an explicitly selected root once; reject per-artifact symlinks, especially for `--fix` | May exclude symlink-organized libraries but prevents path redirection during destructive work.          |
| Baseline trust  | Local fingerprint, strict validation, destination-bound deterministic lookup                   | Detects accidental corruption, not an attacker who can rewrite both media and inventory.                |
| File stability  | Open-handle pre/post `fstat()` with one bounded retry                                          | Adds syscalls and can reject live files, but avoids false passes across generations.                    |
| Deep hardlinks  | Require stored-hash success; mark direct same-inode comparison redundant                       | Avoids pretending two names for one mutable inode are independent evidence.                             |
| Repair          | Verified temporary replacement plus atomic commit and final re-check                           | More I/O and temporary space, but preserves the only copy until a proven replacement exists.            |
| Cancellation    | Finish/close only in-flight read chunks, schedule no new work, report incomplete               | Aborted runs do not claim success; cleanup latency is bounded by a read chunk rather than a whole file. |
| Output detail   | Classifications and bounded paths, no full digests                                             | Less immediate forensic detail, substantially lower fingerprint leakage.                                |
| Historical rows | `unverifiable` without explicit rebaseline/migration                                           | Lower initial coverage, but no false assurance or unauthorized baseline creation.                       |

## Open Questions

1. What exact database operation/artifact key will bind a stored hash to every ranged destination?
   Schema version 9 currently permits one inventory row per operation/source/relative path, which
   does not represent several suffix copies independently.
2. Should verification add `--tracking-database` and an explicit legacy-inventory selector matching
   copy, or should backend selection come only from config? Precedence must be deterministic and
   must never create a fresh empty database that hides legacy evidence.
3. Is any per-artifact symlink support required for read-only verification, or can all tiers reject
   it? `--fix` should reject it regardless unless a separately reviewed safe-link policy exists.
4. Which timestamp representation and tolerance will quick mode use across ext4, APFS, NTFS, and
   network filesystems, and where will destination metadata be stored for converted artifacts?
5. Should one mutation-during-read retry be automatic, or should all unstable files require a later
   run? Automatic retry improves usability but can extend I/O under continuous writers.
6. What is the exit-code policy for `not-applicable` deep comparisons after the stored hash passes,
   and for explicitly kept extras? Text, JSON, documentation, and tests must agree.
7. Will dependency advisory remediation ship in this PR or a child issue? If deferred, the PR should
   record the audit result and avoid claiming resilience against hostile metadata inputs.
