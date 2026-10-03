# Integration Analysis: Tiered Verification

## Executive Summary

Tiered verification extends the existing `rfmedia verify` CLI path; it does not add a server,
network protocol, HTTP endpoint, or remote API. `packages/rfmedia-cli/src/commands/verify.ts` remains
the public entry point, while `packages/rfmedia-cli/src/actions/verify-album.ts` and
`packages/rfmedia-cli/src/actions/verify-filter.ts` retain authority for expected-artifact mapping,
missing/extra detection, repair orchestration, and human summaries.

The new integration seam is a framework-free per-file policy in
`packages/rfmedia-cli/src/lib/tiered-verification.ts`. Both actions pass it the already-derived
source path, expected destination path, selected tier, conversion identity, optional stored
fingerprint, and `AbortSignal`. It returns a typed outcome; it does not discover paths, open the
database, log, prompt, mutate, format output, or set `process.exitCode`. This prevents tier behavior
from drifting across album, flat-filter, preserve-structure, and filter-album layouts.

Default and deep verification consume the SHA-256 final-artifact baseline introduced by issue #111
and stored in schema version 9. The database boundary must be purpose-built and read-only: resolve an
existing tracking database, validate its schema and returned values, join `inventory` to
`operations`, preload candidates for the selected sources, close in `finally`, and never call the
current write-capable initializer. Quick verification must not open SQLite at all.

The accepted feature specification is authoritative where research alternatives differ:

- no tier flag means `default`; `--quick` and `--deep` conflict;
- deep includes the stored-hash check, then direct comparison only when byte identity is meaningful;
- converted deep can pass its stored final-output hash while direct comparison is visibly
  `not-applicable`;
- same-inode hardlinks rely on stored historical hash evidence, not pairwise equality;
- missing, invalid, ambiguous, or unrepresented baselines are explicit incomplete coverage;
- schema version 9 remains unchanged, so historical ranged destinations that cannot be bound to an
  exact destination artifact remain `unverifiable` rather than borrowing another row's digest;
- ordinary verify and `--fix` never create, migrate, backfill, or replace a baseline.

## API Endpoints

### HTTP and network APIs

HTTP endpoints are **not applicable**. `rfmedia-cli` is a local command-line application, and
GitHub issue #116 requires no REST, GraphQL, WebSocket, registry, Plex, or other network
integration. No route, controller, request schema, authentication token, port, or network retry
policy should be added.

The existing MCP implementation under `packages/rfmedia-cli/src/mcp/` does not expose standalone
`verify`, and this feature does not add an MCP tool. No changes are required to
`packages/rfmedia-cli/src/mcp/server.ts`, `packages/rfmedia-cli/src/mcp/schema.ts`,
`packages/rfmedia-cli/src/mcp/tools-read.ts`, or `packages/rfmedia-cli/src/mcp/tools-mutate.ts`.
A future remote verification tool would require a separate authorization and path-disclosure review.

### CLI contract

The user-facing endpoint is the Commander command registered by
`packages/rfmedia-cli/src/cli.ts` from `packages/rfmedia-cli/src/commands/verify.ts`:

```text
rfmedia verify [existing album/filter options] [--quick | --deep] [--tracking-database <path>]
```

The command integration must:

1. declare `--quick` and `--deep` with Commander `Option.conflicts()` so the conflict is rejected
   before source traversal, database access, or repair;
2. map no tier flag to `tier: "default"` and add the discriminant to `VerifyOptions` in
   `packages/rfmedia-cli/src/types/options.ts`;
3. accept `--tracking-database <path>` using the same spelling as copy, delete, history, and stats;
4. preserve album/filter selection as a separate `mode` dimension;
5. lazy-load the existing action matching `mode.type`;
6. project the returned domain result into human or machine output; and
7. set exit state through one shared unresolved-result predicate that includes missing files,
   extras, every mismatch class, unavailable evidence, instability, failures, and failed rechecks.

`--verify-size` remains an additive compatibility precheck for this release. It must not select a
tier or weaken default/deep guarantees. The existing `--progress`, `--no-progress`, `--workers`,
`--fix`, `--force`, `--trash`, `--conflict-strategy`, `--convert`, range, file-input, and filter
options retain their meanings.

### Internal TypeScript APIs

The narrow internal contracts should be:

```ts
export type VerificationTier = "quick" | "default" | "deep";

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

`verifyFileByTier()` belongs in `packages/rfmedia-cli/src/lib/tiered-verification.ts`.
`calculateHash()` already exists in `packages/rfmedia-cli/src/lib/integrity.ts` and should gain
abort-aware file reading without changing its SHA-256 output contract. `compareFileBytes()` belongs
beside it because that module is already the byte-reading integrity boundary. The two database
functions belong in `packages/rfmedia-cli/src/lib/db.ts` because SQL and connection lifecycle must
not leak into either action.

### Machine-output contract

The current command-local `VerifyJsonOutput` in `packages/rfmedia-cli/src/commands/verify.ts`
contains command, mode, paths, existing counters, failures, and optional fix counts. Extend it
additively with the effective tier, final status, differentiated counters, evidence coverage, and
file issue details. Preserve existing field names (`verified`, `missing`, `sizeMismatch`, `extra`,
`expectedTotal`, `failed`, and `fixResults`) where their meanings remain valid.

The single domain result must feed JSON, YAML, and CSV through
`packages/rfmedia-cli/src/lib/formatters/index.ts` and human text through the actions. Progress and
diagnostic prose stay on stderr and remain suppressed for machine output. Stable reason enums belong
in `packages/rfmedia-cli/src/types/results.ts`; full expected or calculated hashes do not belong in
routine text, debug, or machine results.

## Database

### Authoritative schema

The authoritative DDL is `packages/rfmedia-cli/src/lib/schema.sql`, and the current version is
`CURRENT_SCHEMA_VERSION = 9` in `packages/rfmedia-cli/src/lib/migrations.ts`. Issue #116 requires no
DDL, index, or migration change.

Three existing tables participate:

| Table        | Exact columns used                                                                                                      | Integration role                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata`   | `key`, `value`                                                                                                          | Validate the single `key = 'schema_version'` value without mutation; content tiers require schema v9 semantics.                                           |
| `operations` | `id`, `command`, `mode`, `input_file`, `options_hash`, `rating_key`, `range_key`, `convert_key`, `status`, `created_at` | Supplies producer and conversion identity when joined through `inventory.operation_id`. `convert_key` prevents crossing converted/non-converted variants. |
| `inventory`  | `id`, `operation_id`, `source_path`, `relative_path`, `mtime`, `size`, `dest_path`, `content_hash`, `copied_at`         | Supplies source identity, exact destination identity, nullable final-destination SHA-256, and deterministic ordering data.                                |

The relevant exact constraints and indexes are:

- `inventory.operation_id` references `operations.id` with `ON DELETE CASCADE`;
- `UNIQUE(operation_id, source_path, relative_path)` means one inventory identity does not represent
  every ranged destination independently;
- `idx_inventory_source` indexes `inventory(source_path)`;
- `idx_inventory_dest` indexes `inventory(dest_path)`; and
- `inventory.content_hash` is nullable because version-8 migrations and legacy rows have no
  historical fingerprint.

`inventory.mtime` and `inventory.size` describe source metadata, while `inventory.dest_path` and
`inventory.content_hash` describe the final destination artifact. Therefore:

- default/deep may use `content_hash` for converted outputs;
- quick must not compare converted destination size/mtime against these source fields; and
- schema-v9 cannot provide a stored final-destination metadata baseline for converted quick checks,
  so that evidence is unavailable rather than guessed.

`completed_album_copies` records suffix completion, but it does not store destination-file hashes
or metadata and cannot serve as an integrity baseline. It may continue to inform existing traversal
or range behavior only. History tables likewise record operations, not trusted artifact digests.

### Read-only connection and path resolution

Do not reuse `initializeDatabase()` from `packages/rfmedia-cli/src/lib/db.ts`: it creates parent
directories, opens writable, changes journal/synchronous pragmas, executes the schema, and runs
migrations. Add a verification-specific opener using `better-sqlite3` with
`{ readonly: true, fileMustExist: true }`, set `query_only`, validate schema metadata, and close the
connection in `finally`.

Database path precedence should be:

1. explicit `VerifyOptions.trackingDatabase` from `--tracking-database`;
2. `resolveUndoDatabasePath(getLoadedConfig())` from
   `packages/rfmedia-cli/src/lib/config.ts`, which currently prefers `undo.database`, then
   `tracking.database`; and
3. `getDefaultDatabasePath()` from `packages/rfmedia-cli/src/lib/db.ts`, which selects an existing
   `~/.config/rfmedia/tracking.db`, then existing `~/.rfmedia/tracking.db`, otherwise the XDG path.

For verification, the final resolved path must already exist. A missing path is unavailable
coverage, not permission to create the XDG default. Quick never resolves or opens the database.
Too-old, too-new, malformed, or migration-needed stores are reported without changing the file,
journal mode, WAL, SHM, schema, or metadata row.

### Candidate query and resolution

Add a fixed prepared query in `packages/rfmedia-cli/src/lib/db.ts` that joins the two evidence
tables:

```sql
SELECT inventory.*, operations.convert_key
FROM inventory
JOIN operations ON operations.id = inventory.operation_id
WHERE inventory.source_path IN (?, ...)
ORDER BY inventory.copied_at DESC, inventory.id DESC
```

Return `[]` before preparing SQL when `sourcePaths` is empty. Every source value is a positional
binding; no path, tier, or hash is interpolated. Preload once per source batch rather than executing
one synchronous `better-sqlite3` query per file inside the parallel I/O loop.

The in-memory resolver in `packages/rfmedia-cli/src/lib/tiered-verification.ts` must validate each
candidate at runtime and select only a deterministic normalized exact `dest_path` match that also
matches source identity, `relative_path`, and conversion identity. It must reject:

- missing or `NULL` `content_hash` as `unverifiable`;
- non-null hashes outside `/^[a-f0-9]{64}$/` as invalid evidence/error;
- absolute or escaping `relative_path` values;
- a stored destination outside the requested destination root;
- duplicate/ambiguous candidate identity; and
- a row for another range output, conversion variant, source, or merely matching basename.

The accepted specification deliberately does not reuse one represented ranged output's fingerprint
for another expected output. If schema v9 lacks an exact row for a historical suffix, that suffix is
`unverifiable`. A future one-row-per-destination artifact ledger may close this coverage gap, but it
is not a blocking schema change for truthful delivery of issue #116.

### Write ownership

Copy and sync producers continue to own baseline creation:

- `packages/rfmedia-cli/src/actions/copy-album.ts` hashes final destinations and records inventory;
- `packages/rfmedia-cli/src/actions/copy-filter.ts` uses `calculateHash(destPath)` before
  `recordInventoryFile()`; and
- `packages/rfmedia-cli/src/actions/sync.ts` hashes materialized destinations before inventory
  persistence.

The write boundary in `packages/rfmedia-cli/src/lib/db.ts` validates lowercase 64-character SHA-256
through `validateContentHash()` before `recordInventoryFile()` or `recordInventoryFiles()`.
Verification must validate again on read because SQLite can be externally modified, but it must not
call either writer. Ordinary verify and repair do not backfill `NULL`, update `copied_at`, or replace
a mismatching baseline.

## External Services

### Network services

There are no external network services in the tiered-verification path. The feature does not call
Plex, registries, Docker, Tailscale, Authentik, cloud storage APIs, or telemetry. It requires no new
credentials, OAuth flow, secret injection, network timeout, or service-health dependency.

### Local runtime dependencies

| Boundary          | Existing component                                                                        | Integration requirement                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cryptography      | Node.js 22 `node:crypto`                                                                  | Reuse SHA-256 in `packages/rfmedia-cli/src/lib/integrity.ts`; add no checksum package or shell executable.                                           |
| File I/O          | Node.js 22 `node:fs`, `node:fs/promises`, `node:stream/promises`, `Buffer`, `AbortSignal` | Stream hashes; compare through fixed reusable buffers; validate regular open handles before/after reads; close on match, mismatch, error, or abort.  |
| SQLite            | Repository-pinned `better-sqlite3`                                                        | Add the read-only opener/query; do not add an ORM or migration for this consumer.                                                                    |
| CLI parsing       | Repository-pinned Commander                                                               | Use parser-level option conflicts and existing lazy action dispatch.                                                                                 |
| Parallel work     | Existing `processInParallel()` in `packages/rfmedia-cli/src/lib/parallel.ts`              | Reuse one worker bound and pass its signal into content reads; do not create another pool.                                                           |
| Conversion repair | Existing ffmpeg boundary in `packages/rfmedia-cli/src/lib/convert.ts`                     | Only existing authorized `--fix` flows may invoke conversion; stage and validate reproduced output against the stored final hash before replacement. |
| Trash/conflicts   | Existing filesystem, prompt, and conflict helpers                                         | Preserve `--trash`, `--force`, and strategy authorization; tier selection grants no additional mutation authority.                                   |

Local/NAS/FUSE filesystems are environment boundaries rather than services. Timestamp precision,
inode identity, cache coherence, atomic rename, and trash behavior vary. A file that changes during
a read becomes `unstable`; unsupported semantics become explicit unavailable/error coverage rather
than a weaker successful result.

No new package is required. Production dependency advisories identified during research are
pre-existing and should be tracked or remediated separately unless a required touched dependency
forces them into this change; issue #116 should not hide an unrelated dependency-upgrade expansion.

## Integration Points

### Command, configuration, and public types

- Modify `packages/rfmedia-cli/src/commands/verify.ts` for `--quick`, `--deep`, optional
  `--tracking-database`, conflict/default resolution, machine projection, and the shared unresolved
  predicate.
- Extend `VerifyOptions` in `packages/rfmedia-cli/src/types/options.ts` with `tier` and
  `trackingDatabase` while retaining existing options.
- Extend `FileVerifyStatus`, `VerifiedFile`, `FixResult`, and `VerifyCommandResult` in
  `packages/rfmedia-cli/src/types/results.ts` additively with tier, evidence/reason, mismatch,
  `unverifiable`, `notApplicable`, and `unstable` fields/counters.
- Export the new public types through `packages/rfmedia-cli/src/types/index.ts`.
- Load configuration through the existing `packages/rfmedia-cli/src/cli.ts` pre-action hook and
  `packages/rfmedia-cli/src/lib/loaded-config.ts`; do not create a second config loader.

### Shared evidence policy and byte I/O

- Create `packages/rfmedia-cli/src/lib/tiered-verification.ts` and
  `packages/rfmedia-cli/src/lib/tiered-verification.test.ts` for tier dispatch, fingerprint
  resolution, typed per-file outcomes, aggregation initialization/transitions, repairability, and
  the final unresolved predicate.
- Modify `packages/rfmedia-cli/src/lib/integrity.ts` so `calculateHash()` accepts an optional
  `AbortSignal`, never logs full digests, and remains the single hash implementation.
- Add bounded, short-read-safe, unequal-EOF-safe `compareFileBytes()` and open-handle stability
  checks in `packages/rfmedia-cli/src/lib/integrity.ts`.
- Extend `packages/rfmedia-cli/src/lib/integrity.test.ts` with equal/different/empty/multi-chunk
  files, first/late differences, unequal length, hardlinks, concurrent mutation, cancellation, and
  descriptor cleanup.

### Database evidence provider

- Modify `packages/rfmedia-cli/src/lib/db.ts` with `openDatabaseReadOnly()` and
  `getInventoryFingerprintCandidates()` only; keep existing write APIs unchanged.
- Extend `packages/rfmedia-cli/src/types/db.ts` with a candidate DTO that adds
  `operations.convert_key` to `DbInventoryEntry`.
- Extend `packages/rfmedia-cli/src/lib/db.test.ts` with existing/missing database, schema version,
  exact destination/source/conversion binding, null/invalid hash, duplicates, ordering, empty input,
  quoted path, prepared-statement, and no-mutation evidence.
- Do not modify `packages/rfmedia-cli/src/lib/schema.sql` or
  `packages/rfmedia-cli/src/lib/migrations.ts`.

### Album and filter action integration

- In `packages/rfmedia-cli/src/actions/verify-album.ts`, keep range precedence, album discovery,
  conversion-aware filenames, extra detection, and conflict contexts. Replace the successful
  existence/optional-size branch in `verifyAlbumCopy()` with the shared verifier, preload baseline
  candidates only for default/deep, aggregate typed outcomes, and recheck repaired paths.
- In `packages/rfmedia-cli/src/actions/verify-filter.ts`, apply the identical evidence contract to
  flat, preserve-structure, and filter-album paths. Preserve rating/metadata selection and compute
  duplicate destination names deterministically before parallel I/O so completion order cannot bind
  a source to the wrong suffixed output.
- Continue using `packages/rfmedia-cli/src/lib/verify.ts` for
  `getExpectedDestFilename()`, `findExtraFiles()`, and the temporary `verifyFileSize()` compatibility
  precheck. Do not turn that source/destination utility into the database-aware tier coordinator.
- Reuse `packages/rfmedia-cli/src/lib/parallel.ts` for worker limits and propagate its signal through
  every hash, compare, and repair/recheck path.

### Repair integration

The existing fix paths in both actions currently copy/convert/remove and adjust aggregate counters
arithmetically. Tiered verification changes the definition of success:

1. classify the issue and retain the original baseline;
2. prove that the source can reproduce that baseline before replacing a mismatched artifact;
3. create a private staged replacement in the final directory for destructive replacement,
   especially conversion;
4. validate the staged bytes against the stored final hash;
5. revalidate destination containment/identity and apply existing conflict/trash authorization;
6. atomically commit where the filesystem supports it;
7. re-run the selected tier at the final path; and
8. update result counters from the recheck outcome, not from `copiedFiles` arithmetic.

If the source and destination both differ from the stored baseline, a changed hardlink references
the same wrong inode, conversion cannot reproduce the stored output, or a baseline is absent,
automatic repair must preserve the original and return an actionable unresolved result. Rename does
not repair the originally expected path. `--dry-run --fix` remains non-mutating and cannot produce a
verified post-repair state.

### Output, progress, and exit integration

- Human summaries in both actions must use the same status vocabulary and aggregate helper.
- `packages/rfmedia-cli/src/lib/formatters/index.ts` continues to serialize JSON/YAML/CSV through
  `@rfmedia/common`; it receives one complete structured result and no progress text.
- Quick progress is file-count based. Default/deep progress is byte based when totals are available,
  using existing TTY/machine suppression conventions from
  `packages/rfmedia-cli/src/lib/progress.ts` and
  `packages/rfmedia-cli/src/lib/progress-bar.ts`.
- `packages/rfmedia-cli/src/lib/logger.ts` remains the human logging boundary. Remove the full-hash
  mismatch logging currently present in `packages/rfmedia-cli/src/lib/integrity.ts`.
- One `hasUnresolvedVerificationProblems()` helper must drive human `COMPLETE/INCOMPLETE`, machine
  `status`, and `process.exitCode`. This also resolves the current inconsistency where extra files
  are reported but are not consistently included in completion/exit calculations.

### Shell completions and documentation

- Update `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts` with `--quick`, `--deep`, and
  `--tracking-database` if adopted.
- Extend `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` so all three shells stay
  in parity. Parser conflict validation remains authoritative even if a shell cannot dynamically
  hide the opposite tier.
- Update `packages/rfmedia-cli/docs/features/verify-command.doc.md`,
  `packages/rfmedia-cli/docs/features/verify-auto-fix.doc.md`,
  `packages/rfmedia-cli/docs/features/content-hashing-during-copy-operations.md`,
  `docs/features/file-integrity-verification.md`, `packages/rfmedia-cli/README.md`, and `ROADMAP.md`
  with tier guarantees, coverage gaps, repair/rebaseline distinction, machine fields, exit behavior,
  and issue #111/#116 linkage.

### Tests, benchmarks, and compatibility gates

- Extend `packages/rfmedia-cli/src/actions/verify-album.test.ts` and
  `packages/rfmedia-cli/src/actions/verify-filter.test.ts` with cross-mode outcome and post-repair
  coverage.
- Extend `packages/rfmedia-cli/src/cli.test.ts` with default selection, option conflicts, tracking
  path propagation, additive machine output, and exit status cases.
- Extend `packages/rfmedia-cli/benchmarks/verify.bench.ts` and
  `packages/rfmedia-cli/benchmarks/helpers.ts` with identical quick/default/deep fixtures, database
  baselines, representative media bytes, and worker variations. Record the environment and warm/cold
  cache assumptions; do not make the 10x target a flaky CI wall-clock assertion.
- Prove quick does not call content-read or database helpers. Prove default reads only destination
  content after baseline resolution. Prove deep uses bounded memory, handles short reads and unequal
  EOF, and never lets pairwise equality override a stored-hash failure.
- Preserve existing source selection, range precedence, conversion filename mapping, duplicate-name
  mapping, multiple-source/file input, conflict authorization, machine formats, and old aggregate
  fields. Completion is not established until focused/full tests, typecheck, build, formatting,
  documentation lint, benchmark evidence, review/fix, and CI all pass.
