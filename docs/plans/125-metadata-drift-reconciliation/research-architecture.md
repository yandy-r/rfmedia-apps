# Architecture Research: Metadata Drift Detection and Reconciliation

## System Overview

Issue #125 belongs at a new top-level `rfmedia reconcile` namespace that compares three kinds of
evidence for a track: embedded file metadata, operation-scoped SQLite inventory, and a live media
server projection. The existing architecture already separates Commander definitions
(`src/commands`), framework-independent orchestration (`src/actions`), reusable policy and I/O
(`src/lib`), and provider-neutral server access (`MediaServerAdapter`); the reconciliation feature
should preserve those boundaries and keep comparison/classification pure.

The new namespace must not absorb either existing feature with a similar name:

- `rfmedia plex sync` is a two-plane, rating-only synchronizer. It joins local files to Plex tracks
  by exact file path and can push, pull, or resolve a file/Plex conflict. It neither reads nor
  updates tracking inventory, and mutation is currently enabled unless `--dry-run` is supplied.
- `rfmedia lidarr reconcile` is an artist-identity report across Plex and Lidarr. Live mode writes a
  complete identity snapshot, offline mode reads that snapshot, and neither mode reconciles file
  tags or copy inventory. Its categories and cache are about MusicBrainz identity, not metadata
  values.
- Top-level `rfmedia reconcile scan|apply` should own only per-file metadata drift across the file,
  SQLite, and the configured `MediaServerAdapter`. `scan` is observational; `apply` uses exactly one
  explicit authority strategy (`file-wins`, `db-wins`, or `server-wins`) and remains a preview
  unless the operator crosses an explicit execution/approval gate.

The currently shared, writable field across file and server boundaries is **rating**. File readers
also expose title, genres, year, BPM, artists, album, and album artist; the inventory stores rating,
one genre, year, BPM, and one artist; and generic server tracks expose title, rating, artist, album,
year, and tag arrays. However, `writeRating()` and
`MediaServerMetadataCapability.updateTrackRating()` are the only general mutation primitives.
Repairing arbitrary “tags” therefore requires a deliberate field-capability expansion; it cannot
truthfully be implemented only in the three new files suggested by the issue.

## Relevant Components

| Path                                                               | Current architectural role                                                                                                                                                                                      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/rfmedia-cli/src/cli.ts`                                  | Defines global output/config hooks and registers top-level commands. A new root `reconcileCommand` must be registered here.                                                                                     |
| `packages/rfmedia-cli/src/commands/plex.ts`                        | Contains the closest two-plane precedent: `plex sync push`, `pull`, and `both`, fixed machine envelopes, and required conflict preference.                                                                      |
| `packages/rfmedia-cli/src/actions/plex-sync.ts`                    | Exact-path file/Plex join, complete paginated track acquisition, rating comparison, dry-run branches, bounded parallel mutation, and partial-failure aggregation.                                               |
| `packages/rfmedia-cli/src/commands/lidarr-reconcile.ts`            | Existing machine/human presentation pattern for a command named reconcile; it is a Lidarr leaf and must remain semantically separate.                                                                           |
| `packages/rfmedia-cli/src/actions/lidarr/reconcile.ts`             | Existing live/read-only reconciliation lifecycle and database ownership pattern for identity snapshots, not file metadata.                                                                                      |
| `packages/rfmedia-cli/src/types/media-server.ts`                   | Provider-neutral track projection and capability contract. Tracks carry opaque IDs, paths, normalized ratings, core metadata, and optional tags; metadata mutation currently supports ratings only.             |
| `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts`          | Required adapter resolver for query/CRUD actions. Reconciliation should obtain the server here rather than importing Plex internals.                                                                            |
| `packages/rfmedia-cli/src/lib/adapters/plex-adapter.ts`            | Sole Plex capability composer and architecture-gate façade. Upper layers must not import `lib/adapters/plex/*` directly.                                                                                        |
| `packages/rfmedia-cli/src/lib/adapters/plex/query-library.ts`      | Implements paginated generic track queries. Use response-driven offset advancement rather than assuming a fixed page length.                                                                                    |
| `packages/rfmedia-cli/src/lib/adapters/plex/mappers.ts`            | Maps Plex wire tracks to generic tracks. The current track mapper includes title, rating, artist, album, year, moods, and file path, but does not project track genre/style arrays.                             |
| `packages/rfmedia-cli/src/lib/adapters/plex/metadata.ts`           | Implements the only server metadata write: one non-replayable rating PUT with normalized input and query-cache invalidation after success.                                                                      |
| `packages/rfmedia-cli/src/lib/metadata.ts`                         | Single-pass local reader for normalized rating plus title, genres, year, BPM, artist(s), album, and album artist. Parse failure returns `null` and logs a warning.                                              |
| `packages/rfmedia-cli/src/lib/ratings.ts`                          | Canonical rating extraction and scale normalization shared by local metadata readers.                                                                                                                           |
| `packages/rfmedia-cli/src/lib/tag-writer.ts`                       | In-place file rating writer. MP3 and FLAC are supported; OGG/Opus and M4A/AAC return explicit unsupported failures. No generic title/artist/album/genre writer exists.                                          |
| `packages/rfmedia-cli/src/lib/conversion-metadata.ts`              | Rich, bounded canonical tag snapshot and audit model used by the conversion transaction. It is useful field-policy evidence but is not a generic in-place reconciliation writer.                                |
| `packages/rfmedia-cli/src/lib/db.ts`                               | Actual database module (the issue’s proposed `src/lib/database.ts` does not exist). Provides writable initialization, hardened read-only snapshots, inventory CRUD, and exact fingerprint candidate queries.    |
| `packages/rfmedia-cli/src/lib/schema.sql`                          | Schema-v11 definition. `inventory` is operation-scoped and stores path/stat data, rating, first genre, year, BPM, artist, destination, hash, and copy time.                                                     |
| `packages/rfmedia-cli/src/types/db.ts`                             | Typed inventory rows and validation-facing projections.                                                                                                                                                         |
| `packages/rfmedia-cli/src/lib/inventory.ts`                        | Routes SQLite versus legacy JSONL inventory and detects new/removed files. `createFileInventoryEntry()` currently records only stats, rating, paths, hash, and time; its optional extended fields remain unset. |
| `packages/rfmedia-cli/src/types/inventory.ts`                      | Inventory and sync-diff contracts, including the one-row/one-destination representation.                                                                                                                        |
| `packages/rfmedia-cli/src/lib/formatters/index.ts`                 | Dispatches JSON/YAML/CSV to shared serializers; human output is owned by commands. CSV values are formula-neutralized.                                                                                          |
| `packages/rf-common/src/output.ts`                                 | Defines machine formats and suppresses human logging/progress while a machine format is active.                                                                                                                 |
| `packages/rfmedia-cli/src/actions/copy-plan.ts`                    | Strong apply-gate precedent: check first, do not mutate in dry-run, require approval for real non-interactive execution, and record partial/failure outcomes.                                                   |
| `packages/rfmedia-cli/src/lib/prompt.ts`                           | Confirmation prompts use stderr and default to “No,” preserving stdout for structured data.                                                                                                                     |
| `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`           | Static Bash command/option tree; a new top-level `reconcile` tree requires an explicit update.                                                                                                                  |
| `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`            | Static Zsh command/option tree requiring the same new namespace and choices.                                                                                                                                    |
| `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`           | Static Fish command/option tree requiring the same new namespace and choices.                                                                                                                                   |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` | Cross-shell parity and exact command-tree tests; it already distinguishes nested `lidarr reconcile`.                                                                                                            |

## Data Flow

### `rfmedia reconcile scan`

1. The command validates the scan scope, database path, media library, and output format, then lazy
   loads the action. It performs no filesystem, SQL, or network work itself.
2. The action resolves the required `MediaServerAdapter`, opens an **existing** tracking database
   through `openDatabaseReadOnly()`, and closes both lifecycle paths in `finally`. Scan must never
   call `initializeDatabase()`: that could create/migrate a database, change journal settings, or
   create state during an observational command.
3. The action queries all server tracks page by page with `adapter.query.tracks()` and
   `advancePaginationOffset()`. It retains the opaque server track ID for later apply, but uses the
   generic contract everywhere above the adapter.
4. It obtains candidate SQLite inventory rows through a focused query added to `lib/db.ts`.
   Inventory rows from different operations must remain distinguishable. Reconciliation must not
   silently select “newest” when multiple rows claim the same canonical artifact with conflicting
   values.
5. Local file candidates are derived from the selected scope and canonicalized to absolute paths.
   For each existing regular audio file, the action reads one bounded metadata snapshot. Plex’s
   existing `libraries[].path` mapping selects a scan library only; it is not a server-to-local path
   translation facility.
6. A pure `lib/reconciliation.ts` layer joins evidence by exact normalized file identity and
   classifies stable records:
   - `missing-tag`: a supported field is absent in one plane and present in another;
   - `conflicting-value`: two or three present, canonical values disagree;
   - `stale-db-entry`: the selected row points at missing source/destination evidence or cannot be
     joined to a current artifact;
   - `ambiguous`: duplicate operation rows, duplicate server paths, unsupported fields, or unsafe
     path evidence prevent a truthful decision;
   - `in-sync`: all participating values agree.
7. Findings are sorted deterministically by path, field, and code. The action returns data only.
   Human summaries/details go to stderr; JSON/YAML use a stable `{ command, result }` envelope on
   stdout; CSV uses an explicit fixed row schema rather than serializer-dependent nested columns.
   Drift findings are report data, not operational failures. Acquisition, validation, or per-file
   read failures remain explicit failures and may set a nonzero exit code after output.

### `rfmedia reconcile apply`

1. The command requires exactly one authority strategy and rejects conflicting strategy flags.
   Entering the `apply` leaf is necessary but not sufficient for mutation: default behavior is a
   full dry-run preview. Actual execution requires an explicit write/approval gate; non-interactive
   or machine output should require `--yes` rather than attempting a prompt.
2. The action reruns the complete scan immediately before planning mutations. It must not trust an
   earlier terminal report, cached in-memory result, mtime alone, or stale server page.
3. The pure engine converts each resolvable finding into intended target updates:
   - `file-wins`: retain file values; update the server and selected SQLite state;
   - `db-wins`: retain the uniquely selected database values; update file and server;
   - `server-wins`: retain server values; update file and selected SQLite state.
     Missing/ambiguous authority, unsupported target writers, duplicate candidates, and absent files
     are non-applicable findings, never guessed repairs.
4. Dry-run returns this exact mutation plan and counts without opening the database writable,
   writing tags, sending server updates, or recording history.
5. Real apply revalidates each item immediately before its first mutation. File writes use the
   dedicated tag-writer boundary; server writes use `adapter.metadata`; database writes use narrow,
   transaction-backed functions in `lib/db.ts`. Every target records applied/skipped/failed
   independently because file, SQLite, and HTTP changes cannot share one atomic transaction.
6. Database state is changed only for an exact, uniquely selected inventory identity. Historical
   operation rows must not be broadly deleted or rewritten as a side effect of “stale” detection.
   If issue #125 needs a canonical mutable metadata snapshot rather than historical inventory, that
   is a new table and schema migration, not a reinterpretation of `inventory`.
7. The action performs a post-apply comparison for touched records and reports remaining drift.
   Partial success is visible in machine output and produces a nonzero exit code; it must never be
   summarized as reconciled merely because one target write succeeded.

## Integration Points

### Command and naming boundary

Add a dedicated `commands/reconcile.ts` parent with `scan` and `apply` children, then register it in
`cli.ts`. Keep `commands/lidarr-reconcile.ts` registered only beneath `lidarr`; command identifiers
and machine envelopes should distinguish `reconcile-scan`, `reconcile-apply`, and
`lidarr-reconcile`. Bash, Zsh, Fish, and their parity test all have static command trees, so the new
root namespace and its strategy choices must be added without reclassifying the existing Lidarr
leaf.

`cli.ts` explicitly states that `--dry-run` is not global even though old completion templates
still advertise it in their global option strings. The new apply leaf must own its safety options
and must not infer dry-run from `command.parent.opts()`.

### Reconciliation model

Create a typed, provider-neutral field/value model rather than comparing raw
`music-metadata`, SQLite, or Plex objects. Canonicalization must define null versus missing,
whitespace/case rules, numeric tolerance, scalar versus multivalue tag equality, and server-native
rating precision. Preserve original provenance in findings, but never expose credentials or raw
provider responses.

A truthful field matrix is required before implementation:

| Field       | File read       | DB read          | Server read                         | File write        | DB write                  | Server write |
| ----------- | --------------- | ---------------- | ----------------------------------- | ----------------- | ------------------------- | ------------ |
| Rating      | Yes             | Yes              | Yes                                 | MP3/FLAC only     | New narrow updater needed | Yes          |
| Year        | Yes             | Yes              | Yes                                 | No general writer | New narrow updater needed | No           |
| Artist      | Yes             | Yes              | Yes                                 | No general writer | New narrow updater needed | No           |
| Genre       | Multiple values | First value only | Not projected for Plex tracks today | No general writer | New narrow updater needed | No           |
| Title/album | Yes             | Not stored       | Yes                                 | No general writer | Schema change needed      | No           |
| BPM         | Yes             | Yes              | Not exposed                         | No general writer | New narrow updater needed | Not exposed  |

The safe minimal apply slice is therefore rating reconciliation. Broader tag repair requires
extending `MediaServerMetadataCapability`, Plex private endpoint mapping, file tag writers, and
possibly schema/type contracts. Reporting read-only differences for additional fields is possible,
but output must mark them unsupported for apply.

### SQLite semantics

`inventory` is copy/sync history keyed by `(operation_id, source_path, relative_path)`, not a single
authoritative current-state table. Multiple operations can legitimately produce multiple rows for
the same file, and ranged copies retain only one represented destination. A drift query must expose
that ambiguity rather than collapsing it. Also, although inventory columns support extended
metadata, current `createFileInventoryEntry()` does not populate genre/year/BPM/artist, so many
existing and newly produced rows will contain `NULL`; missing DB values are expected evidence, not
proof that file tags are missing.

Read-only scan should reuse the hardened schema-v11 snapshot path (regular file, no symlink, size
cap, active-sidecar rejection, `query_only`). Apply may use writable initialization only after the
execution gate and should use a small transaction for DB targets. Any added column/table requires a
schema-version bump and forward migration; query-only support does not.

### Media server boundary

Resolve the adapter through `resolveRequiredMediaServerAdapter()`. Do not import the compatibility
`lib/plex.ts` client or any private `lib/adapters/plex/*` module from actions. Complete paging and
exact-path matching already exist in `actions/plex-sync.ts`; reuse their architectural pattern,
not their two-plane action contract.

The Plex adapter maps an absent media path to `""`, so empty paths are unmatched evidence. Duplicate
server paths must be ambiguous. The current query cache can contain ratings; successful rating
updates already invalidate that category. Apply must refetch or otherwise bypass stale cached
evidence during final revalidation.

### Safety, error handling, and output

Follow the plan/apply gates rather than the current opt-in `plex sync --dry-run` behavior:

- scan and default apply preview make no writes;
- actual apply requires explicit strategy plus execution approval;
- machine/non-TTY execution never prompts and requires explicit approval;
- unsupported mutations fail closed per finding;
- cancellation is threaded through paging and bounded parallel work;
- external/file failures are aggregated without hiding partial state;
- logs and prompts stay on stderr, while machine output is stdout-only;
- stable reason codes drive automation; prose is presentation only.

## Key Dependencies

- `commander` v14: nested `reconcile scan|apply` registration, mutually exclusive strategy
  validation, option-source inspection, and lazy action dispatch.
- `music-metadata` `^11.14.0`: normalized local tag reads. Reconciliation should use a bounded
  purpose-specific projection and avoid cover/native-tag payloads unless the field contract needs
  them.
- `better-sqlite3` `^12.6.2`: synchronous query/transaction primitive behind `lib/db.ts`; scan
  should use the existing immutable in-memory read-only snapshot.
- `node-id3` and `flac-metadata`: current file rating mutation implementations and their format
  limitations.
- `MediaServerAdapter`: sole provider-neutral server boundary; Plex credentials, transport, native
  scales, cache behavior, and wire types stay below it.
- `@rfmedia/common`: active output-format state, log suppression, JSON/YAML/CSV serializers, and
  stdout/stderr contract.
- `p-limit` through `lib/parallel.ts`: bounded per-file reads and applies. Preserve input-indexed
  results and sort final findings so concurrency does not destabilize machine output.

## Relevant Docs

- `packages/rfmedia-cli/docs/features/media-server-adapter.md`
- `packages/rfmedia-cli/docs/features/plex-metadata-sync.md`
- `packages/rfmedia-cli/docs/features/centralized-tracking-db.doc.md`
- `packages/rfmedia-cli/docs/features/tracking-system.md`
- `docs/features/output-formats.md`
- `docs/features/json-output.md`
