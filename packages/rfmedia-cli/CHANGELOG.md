# Changelog

All notable changes to rfmedia-cli will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Replaced the temporary handwritten Lidarr endpoint bindings with a private generated client and
  deterministic offline regeneration and drift-checking workflow
- Extracted the shared Lidarr album scan and selection primitives (per-artist scan, deterministic
  filter/sort/page) into reusable `lib`/`actions` modules, a behavior-preserving refactor of the
  shipped album-monitoring code

### Fixed

- `verify --fix` no longer publishes a read-only repaired file under a restrictive umask. The
  validated staging file's private mode is now enforced with an `fchmod` on the stage handle
  instead of relying on the umask-masked `open` mode argument, so a non-converting repair lands at
  `0600` regardless of the ambient umask (previously `0400` under `umask 0277`).
- Invalid Lidarr preset lock-owner metadata machine output now emits
  `LIDARR_PRESET_LOCK_METADATA_INVALID` instead of `LIDARR_PRESET_JOURNAL_INVALID`.
- Copy configuration validation now validates and retains `conflictStrategy` for existing
  configured-value consumers and reports invalid values at `copy.conflictStrategy`.
- Plex configuration now validates and retains `pageSize`, `syncRatingsOnCopy`, and
  `syncOnCopyDefaults` instead of silently dropping them. Existing configured values begin taking
  effect after upgrade; `syncRatingsOnCopy: true` enables rating metadata writes, including through
  hardlinks that share the source inode.

### Added

- Three-plane metadata drift detection and capability-bounded reconciliation
  - New top-level `reconcile scan` and `reconcile apply` commands compare normalized ratings,
    primary artists, first genres, and release years across embedded file tags, the rfmedia SQLite
    inventory, and the current media-server track snapshot
  - Stable findings distinguish missing, conflicting, stale, ambiguous, unsupported, and in-sync
    evidence, with deterministic human, JSON, YAML, and fixed-column CSV output
  - Apply requires exactly one of `--file-wins`, `--db-wins`, or `--server-wins`, previews by
    default, and cannot mutate without `--execute` plus interactive approval or `--yes`
  - V1 execution repairs only normalized ratings and guarded inventory stat evidence; non-rating
    drift remains observation-only, and known rating/stat blockers prevent all writes unless
    `--allow-partial` explicitly authorizes independent work while retaining a partial, nonzero
    result
  - Execution revalidates current database evidence before each selected record; `db-wins` holds a
    short writable authority reservation across authority-derived external mutations, while other
    external-only records use a non-mutating generation guard
  - Local mutation is Linux MP3-only: replacement is descriptor-anchored and preserves ownership,
    mode, ACLs, and extended attributes or fails closed, while FLAC remains observable but
    unsupported by reconciliation
  - Bash, Zsh, and Fish completions expose the same command and option hierarchy

- Checksum-sealed Lidarr cascade analysis for every newly generated mutation plan
  - Version 3 artifacts record deterministic immediate effects, conditional exposure, explicit
    zero-versus-unknown evidence, and configured per-plan allowance assessments
  - Optional `lidarr.cascadeAnalysis` budgets and assumptions are advisory plan-time policy sealed
    into the artifact; findings do not change apply authorization or execution
  - Legacy v1/v2 artifacts retain their checksum and apply compatibility and report analysis as
    `not-recorded` instead of synthesizing historical evidence
  - The feature adds no network requests, credentials, dependencies, commands, flags, or shell
    completion changes

- Safe Lidarr artist-add defaults and post-add guardrails
  - `lidarr discover --add` now seals unmonitored artists with missing-album search disabled and
    resolves a structurally albums-only metadata profile by default, failing closed when no unique
    safe profile is available
  - Explicit `--monitored`, `--metadata-profile`, and `--unmonitor-types` overrides are captured in
    checksum-protected plans without changing the exact shape or checksum of existing v2 plans
  - `lidarr apply` normalizes only newly created artists, verifies album read-back, and persists
    resumable stages so uncertain creation is never replayed and incomplete normalization can be
    continued safely
  - Generated-client contracts cover the required metadata-profile and album-monitoring operations,
    while Bash, Zsh, and Fish completions expose the same static option surface

- Last.fm similar-artist discovery safety and safe Lidarr add handoff
  - `lidarr discover --artist <name>` keeps an attributed, one-hop, read-only default with one
    Last.fm `artist.getSimilar` request, default autocorrection, a 1–100 limit, requested/resolved
    seed identity, raw similarity, visible rank, and optional MBID
  - Read-only discovery makes zero Lidarr calls, stores no provider cache, and supports text, JSON,
    YAML, and fixed summary-plus-recommendation CSV output, including attributed empty success
  - Explicit raw-similarity and per-seed caps, fixed depth-two `--deep` traversal, invocation-wide
    request/seed/result budgets, MBID-first loop prevention, graph-exposure ranking, and
    invocation-scoped quarantine keep recommendation growth finite and explainable
  - Optional comma-separated `--add <ranks>` plus `--max-add` and explicit Lidarr resources writes
    at most one bounded, checksum-protected multi-entry `artist-add` plan; invalid or ineligible
    selections write no partial plan and discovery never creates an artist directly
  - A later, separately approved `lidarr apply` fixes an unmonitored/no-new-items/no-search policy,
    records possible-dispatch evidence before each non-idempotent create, never retries or defers
    the mutation, stops admitting later entries after uncertainty, and reconciles outcomes by exact
    MusicBrainz ID
  - Strict `discovery.lastfm` configuration supports template-backed API keys and bounded timeout,
    and Bash, Zsh, and Fish expose the same static command surface
  - Provider federation, cache, and enrichment (#204) plus downstream cascade impact and
    acquisition/download budgets (#219) remain outside this release

- Lidarr library health audit
  - New read-only `lidarr audit` command evaluates eight registered checks (metadata dependency,
    operation safety, retry backlog, monitoring drift, library gaps, duplicate identity, Plex
    connectivity, and a reserved Plex alignment slot) and always reports every check with an
    explicit `pass` / `findings` / `skipped` status and a machine-readable skip reason
  - The frozen check registry is also the fetch plan, so `--check` narrows work as well as output:
    `--check retry-backlog` issues zero Lidarr HTTP requests and `--check duplicate-identity`
    issues two; an unknown id and a blank value (an unset CI variable) are both rejected before any
    client, database, or adapter is constructed, rather than silently auditing nothing
  - Findings carry a stable `code`, a purpose-built `info` / `warning` / `critical` severity, capped
    subject lists with a full affected count, and remediation that only ever names read commands or
    `lidarr plan …` artifacts — the audit never mutates Lidarr
  - `--deep` adds the per-artist album scan for album-level monitoring drift, gaps, and duplicate
    release identities; `--artist-ids` scopes that scan and requires `--deep`
  - Opt-in `--fail-on <none|info|warning|critical>` CI gate sets exit code 1 when findings reach the
    level or the report is degraded; the default run stays diagnostic and leaves the exit code
    untouched even with critical findings
  - JSON, YAML, and multi-row CSV output plus bash, zsh, and fish completions for every new flag
- Lidarr quality preset packs and configuration management
  - New `lidarr presets list`, `show`, `diff`, and `apply` commands with built-in balanced,
    lossless, and space-saver policies plus strict self-contained configured packs
  - Additive same-name ownership preserves unmanaged custom formats, quality profiles, and custom
    format scores while managing complete selected profile and naming policies
  - Fresh capability and schema validation, deterministic semantic diffs, bounded text and
    JSON/YAML/CSV output, explicit approval, and mutation-free dry-run and converged paths
  - Origin-scoped locking, durable owner-only journals, sequential no-retry writes, fresh
    read-back verification, and safe partial or uncertain recovery through a new convergence run
  - Strict YAML configuration and static Bash, Zsh, and Fish completion support for the complete
    preset command hierarchy

- Lidarr album management suite
  - New read-only `lidarr albums` command lists installed albums with album-type, monitored-state,
    and file filtering, an exactly-one selection scope (`--artist-ids`, `--album-ids`, or `--all`),
    a fixed deterministic sort with stable `--limit`/`--offset` windows, and multi-row CSV output
  - New `lidarr plan album-edit` command plans targeted release-policy (`anyReleaseOk`) changes as
    changes-only entries on the sealed plan/apply boundary
  - New `lidarr plan album-delete` command plans destructive album removal with a plan-time-sealed
    destruction mode (`--delete-files`, `--add-import-list-exclusion`), monitored albums excluded by
    default, bounded post-dispatch absence verification, and missing-target-as-satisfied idempotency
  - New `lidarr apply` authorization flags `--allow-album-deletion` and `--allow-file-deletion`
    enforce a two-key ceremony for album deletion, independent of the `--yes` approval

- Read-only Lidarr search and typed lookup
  - New `lidarr search <term>`, `lidarr lookup artist <term>`, and
    `lidarr lookup album <term>` commands
  - Deterministic ranked paging with stable identifiers, provider provenance, execution metadata,
    and explicit empty-result output
  - Opt-in `--allow-stale` recovery for eligible availability failures with degraded source and
    cache-age reporting

- Lidarr artist profile and tag management through sealed plan/apply workflows
  - New `lidarr plan artist-profiles` command assigns existing quality and metadata profiles
  - New `lidarr plan artist-tags` command supports explicit add, remove, set, and clear modes
  - Strict version 2 plan artifacts preserve version 1 monitoring plan read, apply, history, and
    resume compatibility
  - Exact-ID, explicit all-library, and AND-combined filtered selection with deterministic
    ID-or-exact-name resource references
  - Tag set and clear plans require both normal apply approval and `--allow-tag-replacement`
  - Apply sends one artist ID per editor request, ignores the editor response body, verifies with
    fresh targeted reads, never automatically retries a mutation, and stops with resumable
    uncertain state when verification is inconclusive

- YAML-based paths with source selection for `copy` and `sync` commands
  - New `--paths` option to specify destination, defaults, and sources in a YAML file
  - `defaults` section in YAML for common options (filter, count, range, outputFolder, convert)
  - Per-source overrides for all default options with precedence: per-source > YAML defaults > CLI > config
  - Automatic filter mode detection when filters are present in YAML
  - `--source-idx` option to select sources by 1-based index (e.g., `"1,3"` or `"2-5"`)
  - `--source-name` option to select sources by name using case-insensitive contains matching
  - `name` field in YAML sources for custom identifiers (falls back to `artist` then `basename(path)`)
  - Support for multiple sources sharing the same name for group selection
  - Shell completion updates for bash, zsh, and fish with new options
  - Comprehensive documentation in `docs/features/paths-yaml.md`
  - Examples in `packages/rfmedia-cli/examples/paths.yml`

- YAML configuration support as the default format for `rfmedia-cli`
  - Running `rfmedia init` now generates a `.rfmedia.yaml` file by default
  - YAML configuration takes precedence over JSON if both are present
  - Full backward compatibility with existing `.rfmedia.json` files
  - Support for comments and cleaner syntax for complex nested filters in YAML
  - Updated `init` command to include an example `filters` section in the generated template
  - Configuration search priority updated: YAML files are prioritized in each search location (CWD, ~/.config, ~/.rfmedia)

- Advanced Plex Integration with library matching and per-source scanning
  - `--plex-per-source` option to scan Plex after each source completes (not at end of batch)
  - `scanPerSource` config option for per-source scanning by default
  - `libraries` config option for path-to-library mappings (auto-detect library from destination)
  - Path-based scanning using Plex API (`/library/sections/{id}/refresh?path={path}`)
  - Automatically matches destination paths to Plex libraries for selective scanning
  - Reduces Plex server load by only scanning affected directories
  - New functions: `triggerSourceScan()`, `triggerPlexPathScan()`, `matchPathToLibraryName()`

- `--count` option for auto-detecting sequential range in album mode
  - Automatically detects the highest existing suffix in the destination and continues numbering
  - Mutually exclusive with `--range` (cannot use both together)
  - Works with both album mode (copy entire albums) and filter mode (rating-filtered tracks)
  - Supports multi-source operations with file-based input (`--file`)
  - Example: If `Album-001` through `Album-003` exist, `--count=5` creates `Album-004` through `Album-008`
  - Zero-pads suffixes to match existing format (e.g., `001`, `002`, etc.)

- Half-star rating support for `--min-stars` option (1.0-5.0 range)
  - Accepts float values like `--min-stars=3.5` for precise filtering
  - Updated CLI parsing in copy, verify, watch, and sync commands
  - Updated config validation to accept float values for `minStars`
  - Updated shell completions (bash, zsh, fish) with half-star suggestions (1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5)
  - Format-specific precision documented: MP3 POPM (~0.02 stars), FLAC (arbitrary precision)
  - Fully backward compatible with integer values (1-5)

## [0.1.0] - [Release Date TBD]

### Added

- Initial release of rfmedia-cli
- Album mode: Copy entire albums with numbered suffixes (`--range`)
- Filter mode: Copy tracks meeting rating thresholds (`--min-stars`, `--min-rating`)
- Verify command for validating copied files
- Watch mode for automatic processing of new content
- Sync command for incremental updates
- SQLite database tracking system
- Undo/history system with database backend
- Plex Media Server integration
- Audio format conversion support (ALAC, MP3, AAC, Opus)
- Shell completions for bash, zsh, and fish
- Metadata filtering (duration, bitrate, codec, play count)
- Disk space validation
- Progress bars with ETA

[Unreleased]: https://github.com/yandy-r/rfmedia-apps/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/yandy-r/rfmedia-apps/releases/tag/v0.1.0
