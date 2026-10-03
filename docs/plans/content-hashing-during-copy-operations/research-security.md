# Security Research: Content Hashing During Copy Operations

## Executive Summary

The SHA-256 implementation merged in PR #233 has a sound dependency and SQL-injection posture:
hashing uses Node.js built-in `node:crypto` and streams, and inventory writes use fixed prepared
statements with positional bindings. SHA-256 is appropriate for a stable content fingerprint and
future integrity comparison. No new runtime hashing dependency or authentication surface is needed.

The security boundary is local filesystem integrity, not remote adversarial input. rfmedia-cli runs
with the invoking user's authority and accepts source, destination, and database paths. A malicious
or concurrently changing path can redirect writes through symlinks or replace a file between copy,
hash, and database persistence. The current hash proves which bytes were processed by the hash
stream; it does not prove that the same bytes remain durably stored at `dest_path`. That distinction
must be explicit so downstream verification does not treat an unverified fingerprint as proof of a
successful read-back.

Three findings should block declaring issue #111 complete until they are either fixed or explicitly
accepted with tests: normal-error partial files are not cleaned consistently, destination/source
identity is vulnerable to time-of-check/time-of-use races, and `initializeDatabase()` executes
schema SQL before rejecting a database whose schema version is newer than the CLI supports. The
remaining findings concern resource exhaustion, format validation, metadata leakage, and recovery
semantics.

## Findings by Severity

### CRITICAL

No critical vulnerability was found in the current issue #111 implementation. The CLI does not
cross a network authentication boundary, execute hash input as code, interpolate inventory input
into SQL, or introduce a new dependency. A future implementation that uses a shell command for
hashing, trusts a hash as read-back verification, or writes through an attacker-controlled
privileged destination would need a new critical-risk assessment.

### WARNING

| ID      | Finding                                                                           | Impact / evidence                                                                                                                                                                                                                                                                                                                                                                 | Required mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Trade-off                                                                                                                                                                                     |
| ------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-W01 | Destination and source identity are not bound across copy, hash, and persistence. | `copyOrLinkWithHash()` calls `stat(source)`, later opens source/destination by pathname, and actions later insert `dest_path`. Another process can replace a source or a destination component with a symlink, rename the destination, or swap the file after hashing but before SQLite insert. The stored hash/metadata may then describe different objects.                     | Canonicalize and validate the intended destination root; reject traversal outside it. For regular copies, create an owner-only temporary file in the final directory with exclusive creation, stream/hash through one opened handle, `fstat` the source before and after, flush/close, then atomically rename. Re-`lstat` the final path before persistence and reject symlinks or identity changes. For hardlinks, capture and compare inode/device identity after link creation. | More filesystem calls and platform-specific edge handling; atomic rename may replace current overwrite behavior and must preserve timestamps/permissions deliberately.                        |
| SEC-W02 | A streamed copy hash is not destination read-back verification.                   | The `Transform` hashes source chunks before `createWriteStream(dest)` persists them. A successful pipeline means writes completed, but the hash does not detect post-write replacement, storage corruption, or a malicious destination filesystem. Hardlink hashing currently reads `source`, not the destination name. Downstream code could overstate the guarantee.            | Define `content_hash` as the expected SHA-256 fingerprint captured at write time. Do not label it “verified.” Issue #116 should read the destination and compare it with the stored value, recording separate verification time/status. Where immediate `--verify` is used, keep its read-back behavior separate.                                                                                                                                                                  | Avoids an unconditional second read and preserves the performance target, but durable integrity is established only when verification runs.                                                   |
| SEC-W03 | Partial destination cleanup is inconsistent on normal failures.                   | `copyOrLinkWithHash()` wraps a failed pipeline but does not remove `dest`. `copyDirectoryWithConversion()` cleans its target, while `copyDirectoryWithProgress()` relies mainly on process-level signal cleanup. A final read/write/hash failure can leave a partial file; a later conflict-skip path may accept and hash that file.                                              | Make the copy primitive own a unique temporary destination and remove it in `finally` on every failed attempt. If a direct final path remains necessary, call `cleanupPartialFile(dest)` before rethrowing and test final-attempt failures. Never record inventory or completion after cleanup failure; report the residual path explicitly.                                                                                                                                       | Temporary files and atomic rename add directory entries and may change observable progress; direct cleanup can remove a pre-existing destination unless overwrite state is tracked precisely. |
| SEC-W04 | Newer unsupported databases are mutated before version rejection.                 | `initializeDatabase()` sets WAL/pragmas and executes all of `schema.sql` before `runMigrations()` checks `currentVersion > CURRENT_SCHEMA_VERSION`. Opening a future-version database can create tables/indexes or run compatible schema statements before the CLI throws. This violates the intended fail-closed compatibility boundary.                                         | For an existing database, open it and read `metadata.schema_version` before executing schema or migration SQL. If it is newer, close immediately without schema mutation. Only initialize schema when the database is new/unversioned; then apply pragmas and migrations in a deliberate order. Add a test that snapshots `sqlite_schema` and metadata for version 10 and proves they remain unchanged after rejection.                                                            | Initialization becomes slightly more complex and must handle legacy databases with no metadata table; early inspection should treat malformed metadata as an error, not a new database.       |
| SEC-W05 | Hashing can amplify local denial-of-service and I/O pressure.                     | Converted/filter/sync paths reread completed destinations, regular copy workers hash concurrently, and hardlinks turn a metadata-only operation into a full-file read. Large files, many sources, or high worker counts can saturate CPU, disk, network mounts, and SQLite. Existing streams bound memory, but the historical benchmark does not establish a stable <5% overhead. | Keep hashing inside existing worker limits; cap validated workers; propagate `AbortSignal` into all hash reads; avoid a separate hash pool; prefer streaming during regular copies; benchmark representative file sizes, hardlinks, conversion, slow/network storage, and memory. Document expected hardlink cost. Optionally expose operational rate limits later, without allowing successful tracked rows to omit hashes.                                                       | Lower concurrency increases completion time. Hashing hardlinks cannot be both complete and metadata-only; deferring it would weaken the invariant required by downstream features.            |
| SEC-W06 | Filesystem write and SQLite persistence are not atomic.                           | A process crash or SQLite error after a successful rename leaves a destination without an inventory hash; a database commit before later completion tracking may leave partial operation state. Retrying can encounter an existing path and apply skip/conflict behavior rather than reconcile it.                                                                                | Preserve ordering: finalize destination, calculate/capture hash, write inventory, then mark file/source complete. On retry, if the expected inventory row is missing, hash and validate the existing destination before accepting it. Use the existing SQLite batch transaction for rows, and test crash-boundary states. Do not silently persist `NULL` after a hash/DB failure.                                                                                                  | Cross-resource atomicity remains impossible without a journal. Full write-ahead reconciliation would add complexity; deterministic retry rules are the proportional solution.                 |

### ADVISORY

| ID      | Finding                                                         | Impact / evidence                                                                                                                                                                                                                                                                                                     | Required mitigation                                                                                                                                                                                                                                                                           | Trade-off                                                                                                                      |
| ------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| SEC-A01 | Hash format is trusted at the database boundary.                | `recordInventoryFile()` and `recordInventoryFiles()` accept any string or `NULL`; SQLite has no algorithm/format constraint. Current internal producers return lowercase SHA-256, but future imports, MCP tools, or refactors could persist malformed values.                                                         | Add an application validator for non-null values matching `/^[a-f0-9]{64}$/` at inventory write boundaries and tests for uppercase, wrong length, and non-hex input. Keep the column nullable for migrated rows.                                                                              | Adds minor validation cost and may reject third-party legacy values; that is preferable to silently mixing algorithms/formats. |
| SEC-A02 | Debug logs can disclose private paths and content fingerprints. | Copy and database code logs full source/destination/database paths. `verifyFileIntegrity()` logs full source and destination SHA-256 values on mismatch. Hashes are not credentials, but they can fingerprint private or copyrighted media and correlate files across systems; paths reveal library layout and names. | Do not routinely log full persisted hashes. On mismatch, log a short prefix or opaque mismatch ID unless an explicit sensitive-debug mode is documented. Bound/sanitize error paths and prevent control characters from forging log lines. Document that debug logs contain filesystem paths. | Reduced forensic detail; operators can recalculate a hash directly when full evidence is necessary.                            |
| SEC-A03 | Source metadata can be inconsistent with streamed bytes.        | `copyOrLinkWithHash()` captures `mtime` and `size` before opening/reading. A concurrently modified source can yield a hash for one stream but stale size/mtime in inventory, affecting later incremental decisions.                                                                                                   | Open source first, `fstat` its handle, stream from that handle, then `fstat` again. Reject or retry if size/mtime/inode changes during the read. Use the stable handle metadata in the row.                                                                                                   | Growing/live files may fail and require retry instead of being copied opportunistically.                                       |
| SEC-A04 | Hash rows do not identify algorithm/version.                    | `content_hash` implicitly means SHA-256. A later algorithm change could make rows ambiguous or encourage unsafe reinterpretation.                                                                                                                                                                                     | Treat the column contract as permanently SHA-256 for version 9. If another algorithm is ever required, add `content_hash_algorithm` in a new migration or a versioned digest representation; never infer by string length alone.                                                              | A future migration is required for algorithm agility, but the current schema stays simple and compatible.                      |
| SEC-A05 | SHA-256 supplies integrity, not authenticity.                   | An attacker able to replace both destination content and the writable SQLite database can update the hash. No key or trusted manifest anchors the value.                                                                                                                                                              | Describe the threat model accurately. Use file/database permissions and backups; if authenticity against a writer-level attacker becomes a requirement, introduce signed or keyed manifests with protected keys in a separate design.                                                         | Signing/key management is substantial and is not justified for this local tracking feature.                                    |

## Authentication/Authorization

- rfmedia-cli performs no network authentication for this feature. Authorization is the invoking
  process's operating-system permission to read sources, write destinations, and open the tracking
  database.
- Do not elevate privileges or invoke external hashing utilities. Running as root widens symlink,
  overwrite, and path-selection impact; documentation should recommend a dedicated unprivileged
  media user with access only to intended library roots.
- `--tracking-database` is an authority-bearing path. Resolve the parent directory deliberately,
  reject directories/special files where a regular SQLite file is expected, and avoid following a
  database symlink in higher-assurance deployments.
- Plugin hooks execute inside copy actions and share process authority. A plugin can modify source
  or destination state between hooks and hashing; plugin trust is therefore part of the local
  threat model. Run identity checks after mutation-capable hooks, not only before them.
- `--force` authorizes overwrite conflict behavior, not traversal outside the chosen destination
  root, following hostile symlinks, disabling hashing, or accepting malformed inventory.

## Data Protection

- SHA-256 values are stable identifiers. They are normally less sensitive than media contents but
  can reveal equality between libraries and support dictionary matching for known files. Store them
  only in the existing local tracking database and avoid normal output/logging.
- The database also contains absolute source/destination paths and media metadata. Create database
  directories/files with owner-only permissions where practical; do not broaden permissions during
  migration.
- Parameter binding in `db.ts` correctly prevents `sourcePath`, `relativePath`, `destPath`, metadata,
  and `contentHash` from becoming executable SQL. Keep statement structure static. The dynamic
  `UPDATE` column list elsewhere in `db.ts` is built only from fixed internal field names and is not
  part of this feature's input surface.
- Do not include full hashes or paths in PR artifacts, analytics, crash reporting, or machine output
  unless the user explicitly requests an inventory export and understands the disclosure.
- WAL mode can retain recently written hashes and paths in `tracking.db-wal`. Backup, deletion, and
  permission guidance must treat the database, WAL, and shared-memory files as one sensitive unit.

## Dependency Security

| Dependency / boundary        | Current posture                                                                                     | Recommendation                                                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Node.js `node:crypto`        | Built-in SHA-256 implementation; no package install or external executable                          | Retain `createHash("sha256")`; do not add a third-party hasher or shell command                                                  |
| Node.js streams              | `pipeline()` provides backpressure and rejects stream failures; memory is bounded by stream buffers | Retain streaming, propagate aborts, and use opened file handles/atomic temporary files to strengthen identity                    |
| `better-sqlite3`             | Existing native dependency; inventory writes use prepared statements and batch transactions         | Keep parameterized APIs, pin through the workspace lockfile, and exercise migration/transaction tests on supported Node versions |
| `fs-extra` / filesystem APIs | Existing copy path; some helpers operate by pathname and follow normal filesystem semantics         | Avoid adding dependencies; strengthen with built-in exclusive open, `lstat`/`fstat`, temporary-file, and rename primitives       |
| FFmpeg conversion            | Existing external process boundary; converted output is hashed only after success                   | Hash the closed final output. Do not treat source hash or encoder input as the destination fingerprint                           |

No new dependency is warranted by issue #111. A dependency audit should still run as part of the
repository's ordinary CI, but this feature should not expand supply-chain exposure.

## Input Validation

- Validate every non-null hash at the database write boundary as exactly 64 lowercase hexadecimal
  characters. Return a typed/clear operation failure rather than coercing malformed input to `NULL`.
- Canonicalize the configured destination root once, then ensure every constructed destination is
  contained beneath it using path-component-aware comparison. String prefix checks are
  insufficient (`/media/music2` is not beneath `/media/music`).
- Reject NUL and control characters in user-provided paths before logging. Do not attempt to make
  arbitrary user paths safe by shell escaping; no shell is needed.
- Treat source directory entries, metadata-derived names, plugin mutations, and existing destination
  symlinks as untrusted filesystem state even when the CLI user supplied the top-level root.
- Verify the database target is a regular file or an absent path whose canonical parent is trusted.
  Read and validate schema metadata before executing any schema SQL on an existing database.
- Bound worker counts and retain stream backpressure. Hash strings are fixed-size, but source files
  and file counts are not.

## Infrastructure Security

- Network filesystems, FUSE mounts, removable media, and failing storage can provide weaker rename,
  durability, inode, or caching semantics than a local filesystem. Do not claim the write-time hash
  proves durable storage on these targets.
- Atomic temporary-file rename must happen within the destination directory/filesystem. A temporary
  directory elsewhere can degrade rename to a cross-device copy and reintroduce partial writes.
- `synchronous=NORMAL` with WAL prioritizes throughput. The tail of recent database commits can be
  lost on OS/power failure even when application crashes are handled. Retry/reconciliation must
  tolerate a destination whose newest inventory row was lost.
- Hardlinks deliberately share mutation authority with the source inode. Later modification through
  either path changes both while the stored hash becomes stale. Document this behavior; read-time
  verification must not assume hardlinked destinations are immutable.
- Backups/restores should include the database and media state consistently when hashes are used as
  integrity evidence. A database-only restore can legitimately contain stale fingerprints.

## Secure Coding Guidelines

1. Keep SHA-256 fixed and use `node:crypto`; never spawn a hash command or enable a shell.
2. Hash and write through stable file handles. Prefer exclusive same-directory temporary files and
   atomic rename for regular copies.
3. Treat `content_hash` as an expected content fingerprint, not a verification result. Model later
   verification with separate status/timestamp fields.
4. Validate hash format at the shared database boundary, not only in individual actions.
5. Persist in the order `finalize file -> capture hash -> inventory transaction -> completion`.
6. Remove temporary/partial files on every error path, including exhausted retries and aborts.
7. Recreate `Hash`, stream, and file-handle state for every retry attempt.
8. Check existing schema version before executing schema SQL; fail closed on newer or malformed
   versions.
9. Keep all SQL values bound to fixed prepared statements. Never interpolate a hash or path.
10. Avoid full hash/path logging and sanitize control characters in error text.
11. Keep hash work inside bounded copy workers and propagate cancellation through all stream reads.
12. Add adversarial tests for symlink swaps, source mutation, destination replacement, partial
    writes, hash/SQLite failures, newer database schemas, malformed hashes, and debug-log leakage.

## Trade-offs

| Decision                     | Recommended default                                        | Security trade-off                                                                                          |
| ---------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Write-time vs read-back hash | Capture during write; verify later or with `--verify`      | Meets performance intent but cannot claim durable destination verification until reread                     |
| Atomic temporary writes      | Same-directory exclusive temp + rename                     | Adds filesystem operations and cleanup complexity while preventing visible partial destinations             |
| Symlink policy               | Reject symlink destination components for managed writes   | May exclude deliberate symlink-based library layouts; an explicit trusted-root opt-in can be designed later |
| Source mutation              | Fail/retry when handle metadata changes                    | Live/growing files take longer to ingest but avoid internally inconsistent metadata/hash rows               |
| Hash validation              | Reject malformed non-null hashes                           | Less permissive for unofficial imports, but prevents ambiguous integrity data                               |
| Hash logging                 | No full hash in routine/debug mismatch logs                | Slightly less convenient diagnosis; operators can calculate an explicit hash when needed                    |
| Hardlink hashing             | Read and hash after linking                                | Adds full read I/O to hardlink operations but preserves the content-fingerprint invariant                   |
| Database compatibility       | Inspect version before any schema execution                | More initialization branches, but future clients are protected from older-code mutation                     |
| Performance controls         | Bounded workers and streaming; no user-visible hash bypass | May reduce peak throughput, while ensuring every tracked success has a usable fingerprint                   |
| Authenticity                 | Local permissions, not signatures                          | Does not resist an attacker who can rewrite both files and DB; avoids unjustified key-management complexity |

## Open Questions

1. Are symlinked destination roots a supported deployment pattern? If yes, define a trusted-root
   resolution policy; otherwise fail closed on all symlink components.
2. Should normal overwrite use atomic rename, and must it preserve ownership, mode, extended
   attributes, ACLs, and timestamps beyond the current timestamp behavior?
3. Is `content_hash` formally the expected write-time fingerprint, or does product language require
   a destination read-back before persistence? The latter conflicts with the <5% target on fast
   storage and should be measured explicitly.
4. Should malformed hash input throw at `recordInventoryFile()` or be represented by a typed result?
   Throwing matches current synchronous database APIs and is the smallest safe choice.
5. What retry behavior is required when a valid destination exists but the inventory transaction
   was lost? Rehash-and-reconcile is safer and faster than blindly overwriting, but must validate
   destination containment and identity first.
6. Are network/FUSE destinations within the supported integrity guarantee? If so, durability and
   atomic-rename semantics need filesystem-specific test coverage and documentation.
