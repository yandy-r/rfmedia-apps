# Integration Research: Metadata Drift Reconciliation

## Overview

Issue #125 can use the existing inventory database, provider-neutral media-server adapter, and
rating tag reader/writer, but those integrations do not currently provide symmetric metadata
coverage. The safest initial contract is a broad scan of observable fields with capability-limited
repair: ratings are the only field currently writable across all three sources, while other drift
must remain visible as structured, unsupported residuals rather than being silently ignored.

Scanning should be non-mutating and use a read-only SQLite snapshot plus live, bounded server
queries. Applying a saved or displayed decision must re-read every affected resource, fail closed
on ambiguity or unsupported repairs by default, and avoid pretending that filesystem, SQLite, and
Plex changes form one atomic transaction.

## Relevant Files

- `packages/rfmedia-cli/src/lib/schema.sql`: SQLite schema, including `inventory`,
  `plex_queries`, and `plex_query_results`.
- `packages/rfmedia-cli/src/lib/migrations.ts`: sequential schema migrations and current schema
  version 11.
- `packages/rfmedia-cli/src/lib/db.ts`: database-path resolution, mutable initialization,
  read-only snapshot opening, and inventory persistence.
- `packages/rfmedia-cli/src/lib/inventory.ts`: converts copied files into inventory records; the
  production path currently persists only a subset of the schema's metadata columns.
- `packages/rfmedia-cli/src/lib/metadata.ts`: reads extended audio metadata with `music-metadata`.
- `packages/rfmedia-cli/src/lib/ratings.ts`: normalizes native MP3 and Vorbis ratings.
- `packages/rfmedia-cli/src/lib/tag-writer.ts`: rating-only MP3 and FLAC mutation.
- `packages/rfmedia-cli/src/lib/audio.ts`: audio discovery; currently follows symbolic links.
- `packages/rfmedia-cli/src/types/media-server.ts`: provider-neutral query and metadata capability
  contracts.
- `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`: public Plex adapter composition.
- `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`: paginated Plex library calls.
- `packages/rfmedia-cli/src/lib/adapters/plex/metadata.ts`: Plex rating mutation.
- `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`: Plex-to-provider-neutral metadata
  projection.
- `packages/rfmedia-cli/src/lib/adapters/plex/client.ts`: authenticated, origin-bound, response-
  bounded Plex transport.
- `packages/rfmedia-cli/src/lib/adapters/index.ts`: adapter construction and credential precedence.
- `packages/rfmedia-cli/src/actions/plex-sync.ts`: closest existing rating synchronization flow.
- `packages/rfmedia-cli/src/lib/config.ts`: config search, validation, allowed library roots, and
  tracking database configuration.
- `packages/rfmedia-cli/src/lib/parallel.ts`: bounded concurrency with cooperative cancellation.
- `packages/rfmedia-cli/src/lib/signal-handler.ts`: process-global `AbortSignal`.

## API Endpoints and Adapter Calls

### Provider-Neutral Contract

The reconciliation action should depend on `MediaServerAdapter`, not Plex internals.
`MediaServerQueryCapability.tracks()` returns `MediaTrack[]`, and
`MediaServerMetadataCapability.updateTrackRating()` is the only generic track mutation currently
available.

Important contract gaps are:

- `MediaQueryOptions` has no `AbortSignal`.
- `updateTrackRating(trackId, rating)` has no signal or precondition argument.
- There is no generic writer for artist, genre, year, BPM, title, album, mood, or style.
- Track identity is an opaque adapter ID, but `inventory` does not store it.
- `MediaTrack.filePath` is the only current cross-source join candidate.

Use `resolveRequiredMediaServerAdapter()` so reconciliation receives the same provider-neutral
adapter and credential rules as other commands. Do not import the private Plex modules from the
action.

### Plex Calls Behind the Adapter

| Purpose              | Plex request                                                                                        | Integration note                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| List libraries       | `GET /library/sections`                                                                             | Resolves a configured library name to a server-local section.                                              |
| List tracks          | `GET /library/sections/{sectionId}/all` with `type=10`                                              | Uses offset/size pagination and optional filter pushdown.                                                  |
| List album tracks    | `GET /library/metadata/{albumId}/children`                                                          | Not needed for a full-library reconciliation scan.                                                         |
| Read server identity | `GET /`                                                                                             | Available through the optional identity capability, but track queries are not yet scoped by it in storage. |
| Write a rating       | `PUT /:/rate` with `identifier=com.plexapp.plugins.library`, `key={ratingKey}`, and native `rating` | Non-replayable mutation; adapter invalidates its query cache after success.                                |

The Plex transport already enforces same-origin requests, rejects redirects, applies request
timeouts, sends the token in a header, caps successful bodies at 8 MiB and error bodies at 4 KiB,
and parses bounded UTF-8 JSON. Pagination rejects a "has more" response that returns no items.
Reconciliation still needs a total item/page cap and a sane maximum page size so a very large or
malformed library cannot grow an unbounded in-memory snapshot.

The public query and metadata capabilities do not pass caller cancellation into the transport.
For true in-flight cancellation, extend the provider-neutral option contracts and Plex
implementation. Without that extension, cancellation is only best effort between requests and
between mutations.

### Server Snapshot Projection

The Plex mapper currently exposes:

- Opaque `ratingKey` as `MediaTrack.id`
- Title, artist, album, normalized rating, play count, duration, year, moods, and file path
- Only the first `Media.Part.file` when a track has multiple parts

Track genre and style are present in broader provider-neutral metadata types but are not mapped by
the Plex track mapper. BPM is not available from the current Plex track response. Reconciliation
must describe these as unavailable at the server source rather than as empty values.

### Field Capability Matrix

| Field      | File scan                    | SQLite inventory                     | Server snapshot           | File write    | DB write          | Server write | Initial apply support                        |
| ---------- | ---------------------------- | ------------------------------------ | ------------------------- | ------------- | ----------------- | ------------ | -------------------------------------------- |
| Rating     | Yes                          | Yes                                  | Yes                       | MP3/FLAC only | New helper needed | Yes          | Cross-source, subject to target capabilities |
| Artist     | Yes                          | Column exists, usually unpopulated   | Yes                       | No            | New helper needed | No           | Scan/residual only                           |
| Year       | Yes                          | Column exists, usually unpopulated   | Yes                       | No            | New helper needed | No           | Scan/residual only                           |
| Genre      | Yes, possibly multiple       | One text column, usually unpopulated | Not projected for tracks  | No            | New helper needed | No           | File/DB scan only                            |
| BPM        | Yes                          | Column exists, usually unpopulated   | No                        | No            | New helper needed | No           | File/DB scan only                            |
| Title      | Yes                          | No column                            | Yes                       | No            | No                | No           | File/server scan only                        |
| Album      | Yes                          | No column                            | Yes                       | No            | No                | No           | File/server scan only                        |
| Mood/style | Not read by current file API | No columns                           | Partial server projection | No            | No                | No           | Server observation only                      |

The theoretical three-source intersection is rating, artist, and year. In practice, rating is the
only reliable intersection because production inventory writers generally leave artist and year
null, and the only cross-system writers are rating writers.

### Recommended Supported-Field Contract

Implement full observation with supported-field repair:

1. Scan every field that at least two sources can meaningfully compare.
2. Preserve four distinct states: present value, explicit unset (only where the source supports
   it), unavailable capability, and read/parse failure.
3. Compute actionability separately for every field and target.
4. Repair ratings and explicit stale-database operations in the first version.
5. Return all other drift as structured residuals.
6. Fail closed before any mutation when the selected scope contains unsupported repairs, unless
   the user explicitly narrows the fields (for example, rating only) or opts into partial apply.

A finding should carry at least:

- Stable finding ID and entity identity
- Field name and comparison status
- Per-source observations with availability and read status
- Selected winner and intended targets
- Before and intended after values
- Actionability per target
- `reasonCode`, such as `file-format-not-writable`, `server-capability-missing`,
  `database-value-absent`, `path-unmatched`, `parse-failed`, or `changed-since-scan`
- Final status: `unchanged`, `resolved`, `unsupported`, `failed`, `stale`, or `ambiguous`

Summary output should distinguish scanned, drifted, actionable, applied, resolved, unsupported,
failed, and remaining counts. A partial apply with unresolved residuals must not be reported as
complete success.

Broad artist/genre/year/BPM/title/album repair is a separate expansion: it requires generic
field-level adapter mutations, Plex implementations and semantics, safe multi-tag file writers,
inventory population/backfill, and database columns for any newly authoritative DB fields.

## Database Schema

### Inventory State

The current schema version is 11. The relevant `inventory` columns are:

- Identity/provenance: `id`, `operation_id`, `source_path`, `relative_path`, `dest_path`
- File fingerprint: `mtime`, `size`, `content_hash`, `copied_at`
- Metadata: `rating`, `genre`, `year`, `bpm`, `artist`

Rows are unique only within `(operation_id, source_path, relative_path)`. The same physical
destination may therefore have multiple rows from different operations. Reconciliation must not
pick an arbitrary row; duplicates should be grouped by canonical destination and treated as
ambiguous unless their facts agree and a deterministic supersession rule is documented.

Production inventory creation currently records mtime, size, rating, destination, and content
hash, but generally does not populate genre, year, BPM, or artist. Null in these columns is
therefore absent evidence, not a destructive instruction to clear a tag under `db-wins`.

`db.ts` has batch insertion, inventory listing, and strict read-only fingerprint candidate
validation, but no production update/delete API for reconciliation. Add narrow, validated helpers
that:

- Select only the required columns.
- Update by row ID plus a captured identity/version guard.
- Delete explicitly classified stale rows.
- Return affected-row counts and reject zero/multiple matches.
- Use short transactions for related database-only changes.

Avoid `INSERT OR REPLACE` for reconciliation updates because SQLite implements replacement as a row
replacement, which can change identity and trigger delete/insert effects.

### Saved Plex Query Rows

`plex_queries` stores query time, library name, media type, filters, counts, status, and optional
name. `plex_query_results` stores server-local `rating_key`, title, artist, album, native Plex
`user_rating`, year, path, and counts.

These rows are query history, not a safe provider-neutral authority:

- They do not identify provider, server origin, Plex machine/instance ID, or stable library ID.
- `rating_key` is only meaningful within its server.
- Rating is stored in native 0-10 Plex units rather than the normalized adapter scale.
- Individual result rows do not have independent capture times.

Use a fresh, live adapter snapshot for the initial implementation. If issue #125 requires durable
server snapshots across executions, add a new schema rather than overloading these tables. Such a
table needs provider, normalized origin or instance ID, library ID, entity kind and ID, normalized
field projection, capture time, and snapshot version, with atomic snapshot replacement.

### Read-Only Scan and Mutable Apply

`initializeDatabase()` is unsuitable for a strictly non-mutating scan: it creates directories,
opens writable SQLite, enables WAL, executes the schema, and may migrate. `openDatabaseReadOnly()`
is the correct existing pattern. It:

- Requires an existing regular, non-symlink file.
- Rejects live `-wal`, `-shm`, and rollback-journal sidecars.
- Caps the database at 256 MiB.
- Opens with `O_RDONLY | O_NOFOLLOW`.
- Verifies device, inode, size, and mtime before and after reading.
- Deserializes the snapshot into query-only SQLite.
- Requires the exact current schema version.

Those guarantees also create operational constraints: scanning an active WAL database, an older
schema, or a database over 256 MiB fails closed and needs an actionable diagnostic.

For apply:

1. Close the read-only scan snapshot.
2. Open the mutable database using the normal initializer.
3. Re-read the candidate row and filesystem/server observations.
4. Reject changes since scan.
5. Perform external or file mutation without holding a SQLite transaction.
6. Commit the corresponding DB update in a short transaction.
7. Re-read the changed target and report any residual drift.

There is no cross-resource atomic transaction. A failed DB update after a successful file or
server mutation must be reported as partial progress; an idempotent rerun should discover and
finish the remaining work.

### Migration Recommendation

Avoid a schema migration for the initial live-snapshot, rating-focused repair. Existing inventory
columns are sufficient for stored ratings and stale-row management. A migration becomes necessary
only if the feature persists reconciliation plans/runs or provider-scoped server snapshots, or
makes title/album/other absent columns authoritative from the database.

## External Services

### Plex Identity and Matching

Inventory does not store a Plex rating key, and the provider-neutral adapter exposes no stable
file GUID. Existing synchronization joins on exact path text. That works only when Plex and
rfmedia see the same path namespace.

`plex.libraries` and `plex.allowedLibraryRoots` identify libraries or permitted local extraction
roots; they are not server-to-local path translation rules. Do not fall back to basename matching.
Case, Unicode normalization, path separators, mount prefixes, and a track with multiple media
parts can all make an apparent match ambiguous.

The initial join policy should be:

- Canonical exact path under an explicitly allowed root when both systems share a namespace.
- Optional explicit, validated prefix mapping if the feature introduces path translation.
- `unmatched-server` or `ambiguous` findings otherwise.
- Scope every server-local ID by adapter instance and library if it is ever persisted.

### Cache Freshness

The Plex adapter maintains a query cache. A new adapter starts empty, and a successful rating write
invalidates query cache entries, but the public query API has no explicit cache-bypass option.
Scanning and post-apply verification should use a guaranteed fresh adapter/query path or add a
provider-neutral refresh option; a cached result must not be accepted as proof that reconciliation
succeeded.

### Server-Wins Limits

`server-wins` can supply a rating for matched tracks, plus observable artist/year/title/album
values. It cannot currently:

- Supply BPM.
- Reliably supply track genre/style through the mapper.
- Rewrite non-rating file tags.
- Populate unsupported database fields without new update helpers.

A missing server value is not automatically an explicit request to clear another source. Clear
semantics must be modeled separately and supported by the target writer.

## Internal Services

### File Metadata Parsing

`readExtendedMetadata()` parses a pathname with `music-metadata` and returns rating, format, title,
genres, year, BPM, artist(s), album, and album artist. On any parser error it logs and returns
null, currently collapsing "unreadable/parse failed" and "metadata absent." Reconciliation needs a
result type that preserves those states.

The parser path currently has no abort signal, file-size/tag-size bound, no-follow descriptor, or
pre/post identity check. Before accepting a result:

- Require a regular file under an allowed root.
- Refuse symlinks for write targets.
- Capture device, inode, size, and mtime before and after parsing.
- Apply a documented size/input bound or isolate hostile parsing.
- Report `changed-during-read`, `too-large`, and `parse-failed` separately from missing tags.

### Rating Semantics

The rating reader:

- Uses ID3 POPM for MP3, with known-email preference.
- Normalizes Vorbis `RATING` values from 0-1, 0-5, or 0-100.
- Treats POPM 0 as unrated.
- Does not read ratings from M4A/AAC because those are managed through the iTunes database.

The server adapter normalizes Plex's native integer 0-10 rating into the provider-neutral scale.
Comparison should use the adapter's native step semantics, not an arbitrary floating-point
tolerance, and must preserve the distinction between absent/unrated and an explicit zero if a
source supports that distinction.

### File Mutation

`writeRating()` supports MP3 and FLAC only. OGG/Opus, M4A/AAC, and other formats return unsupported.
It also clamps invalid or out-of-range input to zero, so reconciliation must validate the desired
rating before calling it; otherwise bad winner data could erase a rating.

MP3 writes operate synchronously by pathname. FLAC writes use a same-directory temporary file and
rename, but neither general path performs the full descriptor-based no-follow, stable-identity,
mode/ownership preservation, cancellation, size-limit, or fsync sequence required for a
security-sensitive apply. The hardened staged-conversion rating writer demonstrates useful
descriptor, size, child-process, timeout, and cancellation patterns, but it is not a drop-in
arbitrary-file writer.

For reconciliation, revalidate device/inode/size/mtime immediately before mutation, stage in the
same directory, preserve required metadata, atomically rename, and verify the result. If the safe
writer cannot support a format, return an unsupported residual.

### Discovery, Cancellation, and Concurrency

`findAudioFiles()` currently configures `fast-glob` with `followSymbolicLinks: true`; reconciliation
must not reuse that policy for write discovery. Use root-bounded, no-follow discovery with `lstat`
validation and reject paths that escape after canonicalization.

`processInParallel()` provides bounded concurrency, forwards an optional signal to the worker,
checks cancellation before queued work starts, and collects per-item failures. Use the global
signal from `signal-handler.ts` and check it:

- Before each scan phase and page request.
- Before and after each parse.
- Immediately before every mutation.
- Between post-write verification steps.

This remains cooperative until file parsers and adapter calls accept the signal. Keep scan and
apply concurrency separately configurable; filesystem/server writes should default to a more
conservative bound than reads.

## Configuration

### Search and Database Resolution

Config search is first-match-wins in this order:

1. Current-directory `.rfmedia.yaml`, `.rfmedia.yml`, `.rfmedia.json`
2. `~/.config/rfmedia/config.yaml`, `.yml`, `.json`
3. `~/.rfmedia/config.yaml`, `.yml`, `.json`
4. Home dotfiles `~/.rfmedia.yaml`, `.yml`, `.json`

The loader does not search parent directories. Template secrets are resolved during config load
and must never appear in reconciliation output or persisted plans.

Use the established database precedence: explicit command override, `undo.database`,
`tracking.database`, then the default tracking path. The default path prefers an existing legacy
database but creates new databases under XDG configuration.

### Adapter Credentials

Adapter construction enforces these material rules:

- Explicit `--plex-token` has highest precedence.
- JWT auth mode requires an enrolled credential and does not fall back.
- A static config token follows.
- An enrolled credential is used opportunistically when otherwise available.
- An explicit cross-origin `--plex-url` requires an explicit token.

Reconciliation should neither reproduce this logic nor display which raw token was selected.

### Library and Path Scope

`RFMEDIA_PLEX_LIBRARY_ROOTS` overrides `plex.allowedLibraryRoots`. These values constrain local
paths but do not translate Plex mount paths. Require an explicit library selection when multiple
libraries could match, and validate any new path mapping in both directions with segment-aware
containment.

### Output and Dry Run

Use the existing structured-output pipeline (`--json` and `--output` formats) and return typed data
from the action rather than writing ad hoc terminal output. Dry-run is the default behavioral
contract for reconciliation:

- It must not call `initializeDatabase()`.
- It must not invoke a tag or server writer.
- It must not create a plan/output file unless explicitly requested.
- It should include the exact capability and residual information needed to judge an apply.

Any new configuration fields must be explicitly retained by the config validator. The validator
constructs a new object rather than passing unknown keys through, so declaring a type alone is
insufficient.

## Architectural Patterns

- **Provider-neutral boundary**: Actions call `MediaServerAdapter`; Plex protocol details stay
  beneath `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`.
- **Fail-closed snapshots**: Security-sensitive database reads validate the file and exact schema
  before querying.
- **Capability-driven behavior**: Read and write support are explicit; reconciliation should
  preserve this at field and target granularity.
- **Actions return data**: CLI rendering owns JSON/YAML/CSV/table/text formatting.
- **Cooperative cancellation**: Long-running work uses a global signal and bounded parallel
  helpers, while leaf integrations must explicitly propagate the signal.
- **Explicit partial outcomes**: Existing adapter writes return success/failure results; a
  multi-resource apply should retain per-target outcomes rather than throw away partial state.

## Integration Risks and Edge Cases

| Risk                                              | Impact                                           | Required handling                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Null inventory fields are treated as authority    | `db-wins` erases valid tags                      | Model absent evidence separately; require an explicit clear value.                                                           |
| Duplicate inventory rows target one file          | Arbitrary winner or repeated writes              | Group by canonical destination; fail ambiguous unless values agree.                                                          |
| Stale row meaning is underspecified               | Valid history may be deleted                     | Distinguish missing destination, missing source, superseded duplicate, and inaccessible path. Delete only on explicit apply. |
| `db-wins` on a missing audio file                 | Metadata cannot recreate file bytes              | Report an unsupported stale-file repair; do not imply restoration.                                                           |
| Exact paths differ across host and Plex container | No safe three-way identity                       | Require exact/shared path or explicit mapping; never basename match.                                                         |
| Plex result has multiple media parts              | Mapper exposes only the first path               | Report ambiguity or extend the adapter projection before matching.                                                           |
| Scan uses writable DB initialization              | A dry-run changes disk/schema                    | Use `openDatabaseReadOnly()` and explain sidecar/version limits.                                                             |
| Resource changes between scan and apply           | Winner is stale; wrong content is modified       | Capture fingerprints and re-read every source immediately before write.                                                      |
| File path is a symlink or is swapped              | Out-of-root or unintended file mutation          | No-follow discovery/open, root containment, descriptor identity checks, atomic replacement.                                  |
| Parser sees a huge or malformed file              | Resource exhaustion or indefinite work           | Add byte/time bounds, cancellation, and distinct parse failure status.                                                       |
| Public adapter ignores cancellation               | Ctrl-C waits on HTTP work                        | Extend provider-neutral call options or document request-bound cancellation.                                                 |
| Cached server result verifies a write             | False success or residual drift hidden           | Bypass/invalidate cache and perform a fresh post-write read.                                                                 |
| One target succeeds and another fails             | Sources remain partially reconciled              | Never hold DB locks over I/O; return per-target state and support idempotent retry.                                          |
| Rating writer clamps invalid input to zero        | Invalid data clears a rating                     | Validate winner values before invoking the writer.                                                                           |
| Unsupported fields are omitted from apply output  | "Success" hides known drift                      | Emit structured residuals and fail closed unless partial apply is explicit.                                                  |
| Server-local IDs are persisted without scope      | IDs collide across Plex servers                  | Pair entity IDs with provider instance/origin and library identity.                                                          |
| Active WAL or old schema blocks read-only scan    | Legitimate installations cannot scan immediately | Return actionable diagnostics; do not weaken snapshot validation implicitly.                                                 |

## Relevant Documentation

- `packages/rfmedia-cli/docs/features/plex-configuration.md`
- `packages/rfmedia-cli/docs/features/media-server-adapter.md`
- `packages/rfmedia-cli/docs/features/half-star-ratings.doc.md`
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`
- [GitHub issue #125](https://github.com/yandy-r/rfmedia-apps/issues/125)
