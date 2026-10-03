# Systems Thinking Research: Lidarr API Integration for Music Management CLI

## Executive Summary

Lidarr operates as a critical node in a deeply interconnected self-hosted media ecosystem, where a CLI integration must account for cascading dependencies across MusicBrainz metadata, download clients, indexers, and Plex. The most significant systemic insight is that Lidarr's metadata server (api.lidarr.audio) represents a single point of failure -- a MusicBrainz schema change in May 2025 broke all search and import operations with no user-side workaround, revealing fundamental architectural fragility. A CLI tool that integrates with Lidarr should build resilience at the edges: rate-limiting its own operations, providing dry-run modes for bulk actions, and implementing graceful degradation when upstream services are unavailable.

## System Map

```
                                    +------------------+
                                    |   MusicBrainz    |
                                    |   (PostgreSQL +  |
                                    |    Solr + AMQP)  |
                                    +--------+---------+
                                             |
                          Weekly DB dumps + real-time AMQP updates
                                             |
                                    +--------v---------+
                 +------------------+ api.lidarr.audio  +------------------+
                 |                  | (Metadata Server)  |                  |
                 |                  | Python + Redis     |                  |
                 |                  +--------+----------+                  |
                 |                           |                             |
            Fanart.tv                   MusicBrainz                   TheAudioDB
          (Artist images)            (Artist/Album/Track           (Fallback art)
                                      metadata + search)
                                             |
                                             v
+----------+    +-----------+    +-----------+-----------+    +-------------+
| Last.fm  |    | Spotify   |    |                       |    |  Prowlarr   |
| (Similar |    | (Import   |    |       LIDARR          |    |  (Indexer   |
|  artists)|    |  Lists)   |    |   (SQLite/Postgres)   |    |   Manager)  |
+----+-----+    +-----+-----+    | Artist -> Album ->    |    +------+------+
     |                |          | Track data model      |           |
     |                |          +-+---+---+---+--------+           |
     v                v            |   |   |   |                    v
+----+-----+    +-----+-----+     |   |   |   |            +------+------+
| Lidify / |    | Import    |     |   |   |   |            |  Indexers   |
| Sonobarr |    | Lists     |     |   |   |   |            | (Newznab/   |
| Aurral   |    | (24h sync)|     |   |   |   |            |  Torznab)   |
+----------+    +-----------+     |   |   |   |            +------+------+
                                  |   |   |   |                   |
              +-------------------+   |   |   +--------+          |
              v                       v   v            v          v
     +--------+-------+    +---------+--+---+   +------+------+--+--+
     | Webhook/Connect |    | Download       |   | File System      |
     | Notifications   |    | Clients        |   | (Hard links /    |
     | (On Grab/Import |    | (SABnzbd /     |   |  Copy to media   |
     |  /Upgrade)      |    |  qBittorrent)  |   |  folder)         |
     +--------+--------+    +-------+--------+   +--------+--------+
              |                     |                      |
              v                     v                      v
     +--------+--------+    +------+--------+     +--------+--------+
     | Plex Autoscan / |    | Seeding /     |     |  Plex Media     |
     | PlexScanarr     |    | Ratio Mgmt    |     |  Server         |
     +--------+--------+    +---------------+     +--------+--------+
              |                                            |
              +--------------------------------------------+
              |             Targeted folder scan            |
              +--------------------------------------------+
                                   |
                                   v
                          +--------+--------+
                          |  rfmedia-cli    |
                          | (Current: Plex  |
                          |  playlists,     |
                          |  copy/filter,   |
                          |  metadata)      |
                          +-----------------+
```

## Feedback Loops

### 1. Quality Upgrade Cycle (Amplifying)

- **Description**: When Lidarr monitors an artist, it continuously checks RSS feeds and indexers for higher-quality versions of already-downloaded albums. If a FLAC version of an existing MP3 is found, Lidarr downloads the upgrade, imports it, and may delete the old version. This creates a positive feedback loop where monitoring more artists generates more upgrade searches, consuming more indexer API calls, bandwidth, and disk I/O.
- **Effect**: Amplifying -- more monitored content leads to exponentially more indexer queries and download activity.
- **Intervention point**: Quality profile cutoff settings ("Upgrade Until") cap the maximum quality, breaking the loop at a defined ceiling.
- **Confidence**: High
- **Sources**:
  - [Lidarr Settings - Servarr Wiki](https://wiki.servarr.com/lidarr/settings)
  - [Lidarr Quality Profile Issue #3059](https://github.com/Lidarr/Lidarr/issues/3059)

### 2. Import List Discovery Snowball (Amplifying)

- **Description**: Import lists (Spotify, Last.fm) automatically add artists to Lidarr. Each added artist triggers metadata refresh, album scanning, and potentially download searches. Adding a large playlist can snowball into hundreds of artists, each with dozens of albums, creating cascading download activity.
- **Effect**: Amplifying -- one playlist import can trigger thousands of downstream operations (metadata lookups, indexer queries, downloads).
- **Intervention point**: The 24-hour sync interval acts as a natural throttle. Disabling "Enable Automatic Add" converts the loop to manual approval.
- **Confidence**: High
- **Sources**:
  - [Lidarr Import List Settings](https://wiki.servarr.com/lidarr/settings)
  - [Lidarr FAQ](https://wiki.servarr.com/lidarr/faq)
  - [Migrating YouTube Music to Lidarr](https://www.chuck-builds.com/migrating-youtube-music-to-lidarr-as-a-import-list/)

### 3. Metadata Refresh Cycle (Stabilizing)

- **Description**: Lidarr periodically refreshes artist metadata from api.lidarr.audio, which proxies MusicBrainz. New albums detected during refresh may be automatically monitored (depending on "Monitor New Albums" setting). This keeps the library synchronized with upstream metadata but creates constant background load on the metadata server.
- **Effect**: Stabilizing -- keeps local data in sync with the canonical MusicBrainz source, but can become amplifying if "Monitor New Albums" is set to "All."
- **Intervention point**: "Monitor New Albums" setting (None / All / New) controls whether refresh triggers new monitoring.
- **Confidence**: High
- **Sources**:
  - [Lidarr Quick Start Guide](https://wiki.servarr.com/lidarr/quick-start-guide)
  - [Lidarr Option to prevent new albums auto-monitoring - Issue #2034](https://github.com/lidarr/Lidarr/issues/2034)

### 4. Download-Import-Scan Pipeline (Sequential Chain)

- **Description**: Download client completes -> Lidarr detects via polling -> file renamed/moved to media folder -> webhook fires -> Plex Autoscan triggers targeted folder scan -> Plex indexes new content. This is a sequential chain where failure at any stage stalls all downstream operations.
- **Effect**: Sequential dependency chain -- not a true feedback loop but a critical pipeline where latency and failures compound.
- **Intervention point**: Webhook notifications at each stage provide observability; targeted Plex scanning (rather than full library scan) optimizes throughput.
- **Confidence**: High
- **Sources**:
  - [Plex Autoscan GitHub](https://github.com/l3uddz/plex_autoscan)
  - [Autoscan Setup Guide](https://cloudboxes.io/wiki/how-to/apps/set-up-autoscan-with-sonarr-radarr-or-lidarr)

### 5. Similar Artist Discovery Loop (Amplifying, User-Gated)

- **Description**: Tools like Lidify, Sonobarr, and Aurral analyze your existing Lidarr library, query Last.fm/MusicBrainz for similar artists, present recommendations, and allow one-click addition back to Lidarr. Added artists then expand the seed pool for future recommendations, creating an ever-growing discovery cycle.
- **Effect**: Amplifying but user-gated -- requires manual approval (or explicit auto-add configuration) to close the loop.
- **Intervention point**: Human review queue (Mixarr, Sonobarr) prevents runaway growth. Dry-run mode in Lidify allows previewing before committing.
- **Confidence**: High
- **Sources**:
  - [Lidify GitHub](https://github.com/TheWicklowWolf/Lidify)
  - [Sonobarr GitHub](https://github.com/Dodelidoo-Labs/sonobarr)
  - [Aurral GitHub](https://github.com/lklynet/aurral)

## Second-Order Effects

### Bulk Add Artists -> Download Queue Flooding -> Indexer Rate Limit Exhaustion

- **Mechanism**: CLI adds 50 similar artists via Lidarr API -> each artist triggers metadata refresh (50 API calls to api.lidarr.audio) -> Lidarr discovers ~200 albums across all artists -> searches indexers for each album -> Prowlarr's query limits (configured per-day rolling window) get exhausted -> subsequent searches from Sonarr/Radarr also fail because Prowlarr rate limits are per-indexer, not per-app.
- **Third-order effect**: Indexer API exhaustion affects the entire \*arr stack, not just Lidarr. Movies and TV shows stop being searched too.
- **Confidence**: High
- **Sources**:
  - [TRaSH Guides - Prowlarr Setup Limited API](https://trash-guides.info/Prowlarr/prowlarr-setup-limited-api/)
  - [Prowlarr Query Limit Issues](https://github.com/Prowlarr/Prowlarr/issues/2023)
  - [Prowlarr Rate Limiting](https://github.com/Prowlarr/Prowlarr/issues/1545)

### Un-monitoring Artist -> Orphaned Files on Disk -> Plex Library Inconsistency

- **Mechanism**: CLI un-monitors an artist via `PUT /api/v1/artist/{id}` with `monitored: false` -> Lidarr stops searching for new albums but existing files remain on disk -> if user later deletes the artist via `DELETE /api/v1/artist/{id}`, Lidarr can optionally delete files -> Plex still has the content indexed until next scan -> users see stale entries or missing artwork.
- **Third-order effect**: Lidarr issue #2321 reveals that tracks deleted from disk are NOT automatically un-monitored at the album level, creating a split state where the database says "monitored" but files are gone.
- **Confidence**: Medium (the cascade behavior is confirmed but varies by configuration)
- **Sources**:
  - [Lidarr Issue #2321 - Tracks not unmonitored when deleted](https://github.com/Lidarr/Lidarr/issues/2321)
  - [Lidarr FAQ](https://wiki.servarr.com/lidarr/faq)

### Adding Many Artists -> Metadata Server Overload -> 503 Errors for All Users

- **Mechanism**: Lidarr's metadata server (api.lidarr.audio) is a shared service used by ALL Lidarr instances globally. Heavy usage from bulk operations contributes to load. When the metadata server returns 503 errors (as documented in issue #5579), ALL metadata operations fail -- not just for the user who caused the load, but for everyone.
- **Third-order effect**: Version 2.13.3 wiped the local MediaCover cache during an update, and the 503 errors from the metadata server prevented re-population. A user with 75,000 tracks lost all artwork and some album metadata for days.
- **Confidence**: High
- **Sources**:
  - [Lidarr Issue #5579 - MediaCover cache wipe and 503s](https://github.com/Lidarr/Lidarr/issues/5579)
  - [MusicBrainz Community - Lidarr metadata issues](https://community.metabrainz.org/t/for-those-using-lidarr-and-musicbrainz-metadata/768255)

### Metadata Profile Misconfiguration -> Singles/EPs Flood -> Disk Space Exhaustion

- **Mechanism**: When adding an artist via the API, if the metadata profile includes Singles, EPs, Compilations, DJ Mixes, etc. (instead of just "Album"), Lidarr will monitor ALL matching release types. A prolific artist with hundreds of singles creates massive download queues.
- **Third-order effect**: Disk space fills up -> download client can't write new files -> all \*arr applications' downloads stall, including Sonarr/Radarr.
- **Confidence**: Medium
- **Sources**:
  - [Lidarr Community Guide](https://wiki.servarr.com/lidarr/community-guide)
  - [Lidarr Feature Request - Independent Monitoring for Non-Album Categories - Issue #5409](https://github.com/Lidarr/Lidarr/issues/5409)
  - [Lidarr FAQ](https://wiki.servarr.com/lidarr/faq)

### API-Triggered Search -> Download Client Category Mismatch -> Silent Import Failure

- **Mechanism**: CLI triggers `POST /api/v1/command` with `AlbumSearch` -> Lidarr sends to download client with configured category -> if Docker volume paths differ between Lidarr container and download client container, Lidarr cannot find the completed download -> import silently fails -> user thinks nothing happened.
- **Third-order effect**: Files accumulate in the download client's completed folder, consuming disk space, while Lidarr shows the album as "missing."
- **Confidence**: High
- **Sources**:
  - [Lidarr Troubleshooting](https://wiki.servarr.com/lidarr/troubleshooting)
  - [Lidarr Docker Path Issues](https://github.com/Lidarr/Lidarr/issues/3476)

## Stakeholder Analysis

### Lidarr Development Team

- **Role**: Core maintainers of Lidarr application and metadata server (api.lidarr.audio)
- **Incentives**: Maintain a working music automation tool; minimize support burden; keep metadata server costs manageable
- **Impact**: CLI integration adds a new API consumer that could increase metadata server load and generate bug reports. Bulk operations are particularly concerning as they amplify server-side load.
- **Tensions**: The team maintains the metadata server on personal time with limited resources. The May 2025 MusicBrainz schema change took weeks to resolve. External tools that drive heavy API usage may strain already limited infrastructure.
- **Confidence**: High
- **Sources**:
  - [Lidarr Issue #5542](https://github.com/Lidarr/Lidarr/issues/5542)
  - [MusicBrainz Community Discussion](https://community.metabrainz.org/t/for-those-using-lidarr-and-musicbrainz-metadata/768255)

### MusicBrainz / MetaBrainz Foundation

- **Role**: Canonical source of music metadata (artists, albums, tracks, release groups, MBIDs)
- **Incentives**: Community-driven open database; encourage contributions; maintain data quality; enforce rate limits (1 req/sec) to prevent abuse
- **Impact**: CLI operations that trigger Lidarr metadata refreshes indirectly increase load on MusicBrainz through the Lidarr metadata server proxy. Schema changes (like May 2025) can break the entire downstream chain.
- **Tensions**: MusicBrainz is a nonprofit with limited resources. Heavy automated consumption by \*arr ecosystem is tolerated but not actively supported. Lidarr's metadata server exists specifically because direct MusicBrainz API usage would exceed rate limits.
- **Confidence**: High
- **Sources**:
  - [MusicBrainz API Rate Limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)
  - [MusicBrainz Schema Change May 2025](https://blog.metabrainz.org/2025/03/18/schema-change-release-may-19-2025/)

### Indexer Providers (Newznab/Torznab)

- **Role**: Provide search capabilities for finding music releases on Usenet and BitTorrent
- **Incentives**: Maintain service availability; enforce fair usage through API quotas; generate revenue through premium tiers
- **Impact**: CLI-triggered bulk searches directly consume indexer API quotas. Prowlarr's rolling 24-hour limit tracking means that bulk operations could exhaust quotas for the entire day.
- **Tensions**: Indexer providers want sustainable usage patterns. Bulk artist additions from a CLI tool could look like abuse, especially with interactive search operations that multiply queries.
- **Confidence**: Medium
- **Sources**:
  - [TRaSH Guides - Limited API Setup](https://trash-guides.info/Prowlarr/prowlarr-setup-limited-api/)
  - [Prowlarr Indexer Rate Limits](https://github.com/Prowlarr/Prowlarr/issues/910)

### Self-Hosting Users (Plex + Lidarr Overlap)

- **Role**: End users who manage their own media infrastructure; primary consumers of CLI tools
- **Incentives**: Curated, high-quality music library; minimal manual intervention; discovery of new music; efficient storage usage
- **Impact**: CLI tool bridges the gap between Plex (consumption/playback view) and Lidarr (acquisition/management view). Users currently must context-switch between these interfaces.
- **Tensions**: Automation vs. curation -- users want discovery but fear library bloat. Power users want bulk operations; casual users want guardrails. The "add everything" mentality of import lists conflicts with the desire for a curated collection.
- **Confidence**: High
- **Sources**:
  - [Self-Hosted Music in 2025](https://www.joekarlsson.com/2025/06/self-hosted-music-still-sucks-in-2025/)
  - [XDA - Why People Self-Host Media](https://www.xda-developers.com/understand-why-people-self-host-media/)

### Plex Media Server

- **Role**: Media server that indexes and serves music content to end users
- **Incentives**: Provide smooth playback experience; accurate metadata display; efficient library scanning
- **Impact**: Every Lidarr import triggers a Plex scan (targeted or full). Bulk operations can create scan backlogs. File deletions create stale index entries until rescan.
- **Tensions**: Plex's music metadata (from its own providers) may conflict with Lidarr's MusicBrainz-sourced metadata, causing display inconsistencies.
- **Confidence**: Medium
- **Sources**:
  - [Plex Autoscan](https://github.com/l3uddz/plex_autoscan)
  - [PlexScanarr](https://github.com/bjgeiser/PlexScanarr)

### Third-Party Discovery Tool Developers (Lidify, Sonobarr, Aurral, Mixarr)

- **Role**: Build complementary tools that extend Lidarr's discovery capabilities
- **Incentives**: Solve the "how do I find new music" problem; integrate cleanly with Lidarr API; provide user-friendly interfaces
- **Impact**: These tools demonstrate proven patterns for similar-artist discovery that rfmedia-cli could adopt or integrate with. They validate the approach of using Last.fm/MusicBrainz for recommendations.
- **Tensions**: Each tool reinvents the Lidarr API integration. No shared library or protocol exists for discovery -> Lidarr pipeline.
- **Confidence**: High
- **Sources**:
  - [Lidify](https://github.com/TheWicklowWolf/Lidify)
  - [Sonobarr](https://github.com/Dodelidoo-Labs/sonobarr)
  - [Aurral](https://github.com/lklynet/aurral)
  - [Mixarr Announcement](https://lemmy.world/post/41138312)

## Causal Chains

### Chain 1: CLI Add Artist -> Full Pipeline Execution

```
User runs CLI command
    |
    v
CLI sends POST /api/v1/artist (with rootFolderPath, qualityProfileId, metadataProfileId)
    |
    v
Lidarr queries api.lidarr.audio for artist metadata
    |-- BOTTLENECK: Shared metadata server, potential 503 errors
    |-- Rate: Depends on metadata server availability (no client-side retry)
    v
Lidarr creates Artist record in SQLite/Postgres
    |
    v
Lidarr fetches all albums for artist from metadata server
    |-- BOTTLENECK: Artists with 1000+ releases (common for prolific artists)
    |-- Metadata profile filters which release types are tracked
    v
Lidarr creates Album records, marks monitored per settings
    |
    v
If searchForNewArtist=true: Lidarr triggers ArtistSearch command
    |
    v
Lidarr queries Prowlarr/indexers for each monitored album
    |-- BOTTLENECK: Indexer rate limits (rolling 24h window)
    |-- Prowlarr adds 2-second delay between queries per indexer
    v
Matches sent to download client (SABnzbd/qBittorrent) with category tag
    |
    v
Download client downloads files
    |-- BOTTLENECK: Bandwidth, disk I/O, seeding requirements
    v
Lidarr polls download client, detects completion
    |
    v
Lidarr imports: renames, moves/hardlinks to media folder
    |-- BOTTLENECK: Docker path mapping must match between containers
    v
Lidarr fires webhook notification (On Import event)
    |
    v
Plex Autoscan/PlexScanarr receives webhook
    |
    v
Plex scans ONLY the specific album folder (not entire library)
    |
    v
Content available for playback in Plex
```

**Evidence**: Documented across Servarr Wiki, Lidarr troubleshooting guide, and Plex Autoscan README.

**Key Interventions for CLI**:

1. Before POST: Validate metadata server availability (GET /api/v1/health or ping api.lidarr.audio)
2. At POST: Use `addOptions.searchForNewArtist: false` by default, let user explicitly request search
3. After POST: Poll command status via GET /api/v1/command/{id} to provide progress feedback
4. Provide `--dry-run` that shows what WOULD happen without executing

### Chain 2: Bulk Un-monitor -> Cascading State Changes

```
User runs CLI bulk un-monitor command (e.g., "unmonitor all artists with tag X")
    |
    v
CLI sends PUT /api/v1/album/monitor with albumIds and monitored=false
    |-- OR: PUT /api/v1/artist/editor for bulk artist updates
    v
Lidarr updates monitoring flags in database
    |
    v
Lidarr stops searching for new releases for un-monitored content
    |-- SIDE EFFECT: Existing queued downloads continue (not cancelled)
    |-- SIDE EFFECT: Files already on disk remain untouched
    v
If user later wants to delete files:
    |
    v
CLI sends DELETE /api/v1/artist/{id}?deleteFiles=true
    |-- CAUTION: This is irreversible. Files are permanently deleted.
    |-- SIDE EFFECT: Plex still has stale index entries until next scan
    v
Plex full library scan (or manual) needed to remove stale entries
```

**Evidence**: Lidarr Issue #2321 confirms the monitoring/deletion disconnect. The bulk editor endpoints (`/artist/editor`, `/album/monitor`) are documented in the OpenAPI spec.

**Key Interventions for CLI**:

1. Always show a preview of affected artists/albums before executing
2. Separate un-monitoring from deletion as distinct operations
3. After deletion, optionally trigger Plex library scan via Plex API
4. Maintain a local audit log of changes for undo capability

### Chain 3: Similar Artist Discovery -> Controlled Growth

```
User requests similar artists for "Artist X"
    |
    v
CLI queries Last.fm API: artist.getSimilar (requires Last.fm API key)
    |-- CONSTRAINT: Last.fm rate limits (not clearly documented but ~5 req/sec)
    |-- ALTERNATIVE: MusicBrainz artist relations (1 req/sec strict limit)
    v
Last.fm returns list of similar artists with match scores
    |
    v
CLI cross-references with Lidarr: GET /api/v1/artist (existing library)
    |
    v
CLI presents: "Found 15 similar artists not in your library:"
    |-- Show: Name, similarity score, genre, top albums
    v
User selects which to add (interactive or batch)
    |
    v
CLI adds selected artists via POST /api/v1/artist
    |-- With configurable: quality profile, metadata profile, root folder
    |-- With configurable: monitor=none/existing/all
    |-- With configurable: searchForNewArtist=true/false
    v
[Enters Chain 1 for each added artist]
```

**Evidence**: Lidify, Sonobarr, and Aurral all implement this pattern with slight variations. Aurral notes MusicBrainz rate limiting causes 10-20 second discovery times.

**Key Interventions for CLI**:

1. Rate-limit outgoing requests to Last.fm/MusicBrainz
2. Cache discovery results locally to avoid repeated queries
3. Default to `searchForNewArtist: false` and `monitored: false` for bulk adds
4. Provide a `--max-add N` flag to prevent accidental bulk additions

## Leverage Points

1. **Metadata Profile Selection at Add Time** (High Leverage): The metadata profile determines which release types (Album, Single, EP, Compilation, etc.) Lidarr tracks for an artist. Defaulting to "Standard" (Albums only) in the CLI prevents the Singles/EPs flood that causes disk space and download queue issues. This single configuration choice cascades through the entire pipeline.

2. **Search-on-Add Toggle** (High Leverage): The `searchForNewArtist`/`searchForNewAlbum` flag in the add options determines whether Lidarr immediately floods indexers with queries. Defaulting to `false` and requiring explicit `--search` flag gives users control over when the download pipeline activates.

3. **Dry-Run Mode for All Destructive Operations** (Medium Leverage): Providing `--dry-run` for add, delete, and un-monitor operations lets users see the cascade effects before committing. This is especially critical for bulk operations where the blast radius can be large.

4. **Health Check Before Operations** (Medium Leverage): Checking `GET /api/v1/health` and pinging the metadata server before bulk operations prevents wasted effort when the infrastructure is degraded. The May 2025 outage shows this is a real scenario.

5. **Tag-Based Organization** (Medium Leverage): Using Lidarr's tag system (via `GET/POST /api/v1/tag`) to mark CLI-added artists enables future bulk management. Import lists already recommend this pattern: "add a descriptive tag to the import list configuration, otherwise you will not know what list added these items."

6. **Bridging Plex and Lidarr Data** (High Leverage for rfmedia-cli): rfmedia-cli already has Plex integration. Cross-referencing Plex's music library with Lidarr's artist database enables powerful workflows: "show me Plex artists not in Lidarr," "show me Lidarr artists with no files on disk," "sync Plex ratings to Lidarr tags."

7. **Respecting the Artist Editor API** (Medium Leverage): The bulk editor endpoint (`PUT /api/v1/artist/editor`) allows mass updates of quality profiles, metadata profiles, monitoring status, and tags in a single API call rather than individual PUT requests per artist. This is more efficient and creates less load.

8. **Webhook/Connect Awareness** (Low Leverage but Important): Understanding that Lidarr fires webhooks on Grab, Download, and Upgrade events means the CLI should be aware that its API calls trigger side effects beyond the immediate response. Adding an artist with search enabled will eventually trigger downstream webhooks.

## Key Insights

1. **The metadata server is the weakest link in the chain.** Lidarr's api.lidarr.audio is maintained by volunteers on personal time, proxies a MusicBrainz database that undergoes schema changes, and serves ALL Lidarr instances globally. When it goes down (as in May-June 2025), there is no workaround -- no local cache, no fallback, no alternative. A CLI tool should degrade gracefully: check availability before bulk operations, cache results locally, and provide clear error messages when the metadata server is unavailable.

2. **Bulk operations have non-linear systemic impact.** Adding 50 artists is not 50x the impact of adding one -- it's potentially 50 x 20 albums x N indexer queries x download bandwidth, with cascading effects on Prowlarr rate limits that affect the entire \*arr stack. The CLI must implement progressive disclosure: show what will happen, throttle execution, and provide abort mechanisms.

3. **The discovery pipeline is well-proven but fragmented.** Lidify, Sonobarr, Aurral, and Mixarr all solve the "similar artist discovery" problem using Last.fm or MusicBrainz, with slight architectural variations. rfmedia-cli can learn from these implementations without reinventing them. The key differentiator would be CLI-native workflow integration rather than another web UI.

4. **Lidarr's API is comprehensive but reflects its web UI heritage.** The OpenAPI spec reveals 60+ endpoints covering artists, albums, tracks, commands, queues, history, quality profiles, metadata profiles, tags, root folders, and more. The artist editor and album monitor endpoints enable efficient bulk operations that aren't easily accessible from the web UI -- this is where a CLI adds the most value.

5. **The Plex-Lidarr bridge is an underserved gap.** Existing tools treat Plex and Lidarr as separate systems connected by file scanning. No tool currently provides a unified view of "what Plex knows" vs "what Lidarr manages." rfmedia-cli's existing Plex integration positions it uniquely to bridge this gap.

6. **API stability is reasonable but metadata server stability is not.** The Lidarr API itself (v1) has been stable for years, with consistent endpoint patterns across the \*arr ecosystem. The fragility is in the metadata layer, not the API layer. TypeScript SDK options exist (TsArr) that auto-generate from OpenAPI specs, providing type safety.

7. **Monitoring state management is the most common user pain point.** GitHub issues repeatedly surface around: un-monitoring not cascading (#2321), lack of bulk un-monitor for singles/EPs (#519, #5409), inability to see current "monitor new albums" state in mass editor (#3894). A CLI that provides clear, scriptable monitoring management would address a significant user need.

## Evidence Quality

- **Overall Confidence**: High for system architecture and API capabilities; Medium for performance impacts and second-order effects (limited quantitative data); Low for metadata server rebuild timeline and future stability.
- **Primary Sources Used**: Lidarr OpenAPI specification (GitHub), Lidarr GitHub issues, Servarr Wiki, MusicBrainz official documentation, Go starr library (comprehensive API wrapper).
- **Secondary Sources Used**: Discovery tool repositories (Lidify, Sonobarr, Aurral), community guides (TRaSH Guides), blog posts.
- **Key Gap**: No official Lidarr architecture document exists. The system map above was reconstructed from multiple sources and may not capture all internal dependencies.
- **Contradiction**: The Servarr Wiki pages load dynamically and could not be fully scraped for detailed settings documentation. Information was supplemented from GitHub issues and community guides.

## Search Queries Executed

1. "Lidarr architecture system diagram dependencies MusicBrainz download clients"
2. "Lidarr MusicBrainz Last.fm API data flow metadata providers"
3. "Lidarr Plex integration pipeline media scanning"
4. "\*arr ecosystem architecture overview Sonarr Radarr Lidarr integration"
5. "Lidarr bulk add artists performance impact system resources"
6. "Lidarr download client integration flow SABnzbd qBittorrent import process"
7. "Lidarr API rate limits indexer queries throttling Prowlarr"
8. "self-hosted media automation ecosystem feedback loops quality upgrades"
9. "Lidarr unmonitor delete artist cascade effects database cleanup"
10. "Lidarr API v1 endpoints artist album search command"
11. "Lidarr metadata server proxy MusicBrainz Fanart.tv Spotify data aggregation architecture"
12. "MusicBrainz API rate limit 1 request per second Lidarr metadata caching"
13. "Lidarr similar artists recommendation discovery music automation"
14. "Lidarr Plex library scan webhook notification connect downstream"
15. "Lidarr connect notification webhook types on grab on import on upgrade on rename"
16. "Lidarr quality profile cutoff upgrade cycle disk space management music library"
17. "Lidarr artist editor bulk operations API mass update monitor tags quality profile"
18. "Lidarr metadata profile release types singles EPs compilations filtering configuration"
19. "Lidarr metadata server broken MusicBrainz schema change 2025 rebuild status"
20. "Lidarr import list Spotify Last.fm automatic add artist monitoring behavior"
21. "Lidarr SQLite database schema artist album track relationship data model"
22. "Sonarr Radarr Lidarr API v1 consistency shared codebase Servarr framework"
23. "Lidarr API authentication X-Api-Key header query parameter security"
24. "Lidarr command API post RefreshArtist AlbumSearch MissingAlbumSearch RssSync"
25. "\*arr API breaking changes versioning v1 v3 stability backward compatibility"

## Sources

### Primary Sources (Official Documentation & Code)

- [Lidarr OpenAPI Specification](https://raw.githubusercontent.com/lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json) - Complete API endpoint reference
- [Lidarr Metadata API Repository](https://github.com/Lidarr/LidarrAPI.Metadata) - Metadata server architecture
- [Servarr Wiki - Lidarr Settings](https://wiki.servarr.com/lidarr/settings) - Configuration reference
- [Servarr Wiki - Lidarr FAQ](https://wiki.servarr.com/lidarr/faq) - Common issues and behavior
- [Servarr Wiki - Lidarr Quick Start](https://wiki.servarr.com/lidarr/quick-start-guide) - Setup and configuration
- [Servarr Wiki - Lidarr Troubleshooting](https://wiki.servarr.com/lidarr/troubleshooting) - Known issues
- [MusicBrainz API Rate Limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting) - Rate limit documentation
- [MusicBrainz Schema Change May 2025](https://blog.metabrainz.org/2025/03/18/schema-change-release-may-19-2025/) - Schema change announcement
- [Go starr/lidarr Package](https://pkg.go.dev/github.com/craigjmidwinter/starr/lidarr) - Complete API method reference
- [pyarr Lidarr Models](https://docs.totaldebug.uk/pyarr/models/lidarr.html) - Python API data models

### GitHub Issues (System Behavior Evidence)

- [Issue #5579 - MediaCover cache wipe and 503s](https://github.com/Lidarr/Lidarr/issues/5579) - Metadata server fragility
- [Issue #5542 - MusicBrainz layout change](https://github.com/Lidarr/Lidarr/issues/5542) - Schema change impact
- [Issue #2321 - Tracks not unmonitored on delete](https://github.com/Lidarr/Lidarr/issues/2321) - Cascade behavior
- [Issue #5012 - searchForNewAlbum behavior](https://github.com/Lidarr/Lidarr/issues/5012) - Add options behavior
- [Issue #2034 - Prevent auto-monitoring](https://github.com/lidarr/Lidarr/issues/2034) - Monitoring controls
- [Issue #519 - Bulk monitor/unmonitor](https://github.com/lidarr/Lidarr/issues/519) - Missing bulk operations
- [Issue #5409 - Independent monitoring controls](https://github.com/Lidarr/Lidarr/issues/5409) - Release type monitoring
- [Issue #3059 - Quality cutoff upgrade cycle](https://github.com/Lidarr/Lidarr/issues/3059) - Quality upgrade behavior
- [Issue #3894 - Monitor new albums in mass editor](https://github.com/Lidarr/Lidarr/issues/3894) - Bulk editor limitations

### Discovery Tool Repositories

- [Lidify](https://github.com/TheWicklowWolf/Lidify) - Last.fm-based artist discovery
- [Sonobarr](https://github.com/Dodelidoo-Labs/sonobarr) - Last.fm discovery with monitoring policies
- [Aurral](https://github.com/lklynet/aurral) - MusicBrainz tag-based discovery
- [Mixarr](https://lemmy.world/post/41138312) - Multi-source discovery companion

### Ecosystem & Integration References

- [awesome-arr](https://github.com/Ravencentric/awesome-arr) - Comprehensive \*arr ecosystem list
- [TsArr TypeScript SDK](https://github.com/robbeverhelst/TsArr) - TypeScript client for Servarr APIs
- [TRaSH Guides - Prowlarr Limited API](https://trash-guides.info/Prowlarr/prowlarr-setup-limited-api/) - Rate limit configuration
- [Plex Autoscan](https://github.com/l3uddz/plex_autoscan) - Targeted Plex scanning
- [PlexScanarr](https://github.com/bjgeiser/PlexScanarr) - Webhook-based Plex scanning
- [Servarr Wiki](https://wiki.servarr.com/) - Consolidated \*arr documentation
- [Lidarr Community Guide](https://wiki.servarr.com/lidarr/community-guide) - Best practices
- [Buildarr](https://buildarr.github.io/) - \*arr stack configuration automation
- [MusicBrainz Community - Lidarr Metadata](https://community.metabrainz.org/t/for-those-using-lidarr-and-musicbrainz-metadata/768255) - Metadata server status
