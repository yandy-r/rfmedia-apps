# Analysis of Competing Hypotheses: Lidarr API Integration for rfmedia-cli

## Methodology

This analysis follows the ACH (Analysis of Competing Hypotheses) framework developed by Richards J. Heuer Jr. for CIA intelligence analysis. The process:

1. Generate mutually exclusive hypotheses about the best integration approach
2. Catalog all significant evidence from 8 research personas
3. Evaluate each piece of evidence against every hypothesis, focusing on disconfirming evidence
4. Eliminate hypotheses with the most disconfirming evidence
5. Rank surviving hypotheses by consistency with the full evidence base

Evidence is drawn from: Historian, Contrarian, Analogist, Systems Thinker, Journalist, Archaeologist, Futurist, and Negative Space personas.

---

## Hypotheses

### H1: Full CRUD Lidarr Client

rfmedia-cli should use TsArr SDK or generate its own client from Lidarr's OpenAPI spec for comprehensive CRUD operations across all Lidarr endpoints (artists, albums, tracks, quality profiles, metadata profiles, commands, queue, history, etc.).

### H2: Read-Only Lidarr + Direct Discovery APIs

rfmedia-cli should only integrate with Lidarr for read operations (list artists, albums, status) and use Last.fm/MusicBrainz/ListenBrainz directly for discovery and recommendations, bypassing Lidarr for all write-heavy workflows.

### H3: Thin Bulk Operations Client

rfmedia-cli should build a focused Lidarr client covering only bulk operations (monitor/unmonitor, bulk edit, delete, tag management, quality profile switching) since those are the biggest unmet pain points. No discovery features through Lidarr.

### H4: No Lidarr Integration -- Plex-to-Metadata Bridge

rfmedia-cli should NOT integrate with Lidarr directly and instead focus on bridging Plex with metadata providers (MusicBrainz, Last.fm, ListenBrainz) for discovery, gap analysis, and library intelligence. Lidarr is too fragile and architecturally misaligned.

### H5: Comprehensive Integration Replacing Companion Tools

rfmedia-cli should build a comprehensive Lidarr integration that consolidates the functionality of Lidify (discovery), LidaTube (YouTube downloads), ArrTools (CSV bulk ops), and Soularr (Soulseek bridge) into a single CLI, effectively replacing the need for 5+ separate Docker containers.

### H6: Layered Architecture with Plex-Lidarr Bridge Focus

rfmedia-cli should build a layered integration: (Layer 1) thin Lidarr client for bulk management operations, (Layer 2) direct Last.fm/ListenBrainz integration for discovery, (Layer 3) Plex-Lidarr bridge for cross-system intelligence. Discovery results optionally feed into Lidarr add operations. Each layer is independently useful.

---

## Evidence Catalog

All significant evidence items extracted from persona findings, tagged with source persona and confidence level.

### E1: Lidarr API has ZERO discovery endpoints

No `/api/v1/artist/similar`, no recommendations, no discovery. Verified directly from OpenAPI specification.

- **Source**: Contrarian (High confidence), Journalist (High), Negative Space (High)
- **Type**: Primary (OpenAPI spec analysis)

### E2: Metadata server (api.lidarr.audio) experienced 5+ major outages in 5 months (April-August 2025)

Including an 8+ day outage, MusicBrainz schema change breaking all search, and persistent 503 errors wiping artwork for 75,000-track libraries.

- **Source**: Contrarian (High), Systems Thinker (High), Futurist (High), Historian (High)
- **Type**: Primary (GitHub issues with developer acknowledgment)

### E3: Self-hosted metadata alternatives explicitly rejected ("Won't Fix", issue locked)

Lidarr team closed issues #5546 and #5558 requesting configurable or self-hosted metadata. No plans to mitigate the single point of failure.

- **Source**: Contrarian (High), Futurist (High), Negative Space (High)
- **Type**: Primary (developer statements on GitHub)

### E4: TsArr TypeScript SDK exists (v1.11.0, Feb 2026), auto-generated from OpenAPI

First production-quality TypeScript client for all Servarr APIs. 16 releases, 154 commits. Uses Bun runtime.

- **Source**: Historian (High), Journalist (High)
- **Type**: Primary (GitHub repository)

### E5: No TypeScript CLI tool exists for Lidarr management

Confirmed by searching npm, GitHub, and awesome-arr. Go and Python have clients; TypeScript has only the library-level TsArr.

- **Source**: Negative Space (High), Journalist (High)
- **Type**: Primary (ecosystem survey)

### E6: Lidarr API operates at artist/album level, NOT track level

No independent `/api/v1/track` endpoint for track-level operations. Data model fundamentally album-centric. rfmedia-cli works with Plex at the track/file level.

- **Source**: Contrarian (High), Negative Space (High)
- **Type**: Primary (OpenAPI spec, developer statements)

### E7: Bulk unmonitor by album type is the most requested unmet feature

6+ years of open GitHub issues (#2036, #5409). Only solution is fragile bash scripts that break on large libraries ("Argument list too long" errors).

- **Source**: Negative Space (High), Systems Thinker (High)
- **Type**: Primary (GitHub issues, community scripts)

### E8: Plex-Lidarr bridge is completely unserved

No tool reads Plex consumption data (ratings, play counts, playlists) and translates into Lidarr actions. Only connection is file-based scanning.

- **Source**: Historian (Medium), Systems Thinker (High), Negative Space (High), Archaeologist (Medium-High)
- **Type**: Primary/Secondary (ecosystem survey, community analysis)

### E9: Last.fm is the most reliable open recommendation source for similar artists

Decades of listening data, free API, simple API key auth (no OAuth), survived Spotify API restrictions. Lidify switched to Last.fm-only after Spotify locked down in Nov 2024.

- **Source**: Historian (High), Archaeologist (High), Futurist (High), Journalist (High)
- **Type**: Primary (API documentation, project migration evidence)

### E10: ListenBrainz emerging as long-term open alternative for discovery

CC0 licensed, backed by MetaBrainz Foundation, building artist/track/album similarity datasets. Data "nowhere near as comprehensive as Spotify" currently.

- **Source**: Futurist (Medium), Archaeologist (Medium-High)
- **Type**: Primary/Secondary (MetaBrainz blog, API documentation)

### E11: Bulk operations trigger non-linear systemic cascades

Adding 50 artists can generate 50 x 20 albums x N indexer queries, exhausting Prowlarr rate limits across the ENTIRE arr stack (Sonarr/Radarr affected too).

- **Source**: Systems Thinker (High)
- **Type**: Primary (documented rate limit mechanisms, GitHub issues)

### E12: docker-lidarr-extended's related artist loop prevention is proven design

`numberOfRelatedArtistsToAddPerArtist`, `preventRelatedArtistsLoop`, and `autoArtistAdderMonitored` are validated configuration patterns. Archived project but patterns survived in arr-scripts.

- **Source**: Archaeologist (High), Historian (High)
- **Type**: Primary (project documentation, configuration files)

### E13: Composable beats monolithic -- docker-lidarr-extended failed, arr-scripts succeeded

Monolithic Docker container was unmaintainable. Migration to composable shell scripts proved more sustainable.

- **Source**: Historian (High), Archaeologist (High)
- **Type**: Primary (project archives, migration evidence)

### E14: Lidarr API v1 is stable and unlikely to change

Slow development pace, no API v2 visible in repository. Confusing versioning (v1.0 milestone open while releases at v3.1.x). Stable target for integration.

- **Source**: Futurist (Medium), Journalist (High), Historian (Medium)
- **Type**: Primary/Secondary (release history, codebase analysis)

### E15: File corruption risks from Lidarr automation

Documented OPUS corruption (PR #1593), hardlink corruption during metadata tagging (#1016, #3157). Automation triggering metadata writes can be destructive.

- **Source**: Contrarian (High)
- **Type**: Primary (GitHub issues with confirmed bugs and fixes)

### E16: Hand-maintained API wrappers consistently fall behind and get abandoned

pyarr (inactive since July 2023), lidarr-cli Ruby (0 stars, abandoned), ArrTools (no releases). Auto-generated SDKs are more sustainable.

- **Source**: Historian (Medium), Archaeologist (High)
- **Type**: Primary (project activity analysis)

### E17: Lidarr's "Won't Fix" culture creates clear market for external tools

Issues #5554, #5517, #5546, #5558 all closed as "Won't Fix." Small volunteer team maintaining 5 applications. External tools are the only path to many features.

- **Source**: Negative Space (High), Contrarian (High)
- **Type**: Primary (GitHub issue closures)

### E18: TheWicklowWolf music stack requires 5+ Docker containers for complete workflow

Lidify + LidaTube + Syncify + PlaylistDir + SpotTube -- each filling a specific Lidarr gap. Community wants consolidation.

- **Source**: Futurist (High), Negative Space (High)
- **Type**: Primary (project documentation)

### E19: Lidarr's developer philosophy is full automation, not manual/CLI workflows

Developer response on issue #404: "Lidarr's goal is automation." Manual, selective operations work against the software's design intent.

- **Source**: Contrarian (High)
- **Type**: Primary (developer statement)

### E20: rfmedia-cli already has Plex integration (playlists, copy/filter, metadata)

Existing codebase provides Plex artist/album/track data. Adding Lidarr creates a bridge no other tool provides.

- **Source**: Systems Thinker (High), Negative Space (High)
- **Type**: Primary (codebase)

### E21: Recyclarr does not support Lidarr -- explicit gap in quality profile management

No TRaSH Guides automation for Lidarr quality profiles. Every user configures independently.

- **Source**: Journalist (High), Negative Space (High)
- **Type**: Primary (Recyclarr documentation)

### E22: Monitoring state management is the most common user pain point

Multiple GitHub issues: un-monitoring not cascading (#2321), no bulk un-monitor for singles/EPs (#519, #5409), mass editor hiding monitoring state (#3894).

- **Source**: Systems Thinker (High), Negative Space (High)
- **Type**: Primary (GitHub issues)

### E23: Community bulk-add scripts recommend 120-second delays between API calls

To avoid overwhelming metadata API. Practical evidence of integration friction.

- **Source**: Journalist (Medium)
- **Type**: Secondary (community scripts)

### E24: Beets CLI is the gold standard for extensible music management

Plugin architecture, MusicBrainz integration, cross-service ID mapping. Lidarr developers themselves acknowledged Beets is better at library management.

- **Source**: Historian (High), Archaeologist (High), Contrarian (Medium)
- **Type**: Primary/Secondary (developer statements, project analysis)

### E25: Headphones' `getSimilar` API pattern maps directly to desired rfmedia-cli features

addArtist, delArtist, getSimilar, queueAlbum -- proven command structure for music automation CLI.

- **Source**: Archaeologist (High)
- **Type**: Primary (API documentation)

### E26: Music metadata complexity is the root cause of most failures

Multiple releases per song (20+ in MusicBrainz), inconsistent tagging, no single authoritative database equivalent to TVDB/TMDB.

- **Source**: Historian (High), Contrarian (High), Futurist (High)
- **Type**: Primary/Secondary (ecosystem analysis)

### E27: Local-only Lidarr API operations are genuinely reliable

List artists, change monitoring status, delete, tag management -- all work against local database without metadata server dependency.

- **Source**: Contrarian (High), Systems Thinker (High)
- **Type**: Primary (API behavior analysis)

### E28: Spotify API restrictions are permanent (Nov 2024)

Related Artists, Recommendations, Audio Features endpoints locked down for new apps. Ecosystem-wide shift to Last.fm/ListenBrainz.

- **Source**: Futurist (High), Journalist (High), Archaeologist (High)
- **Type**: Primary (Spotify documentation, project migration evidence)

### E29: Naviseerr threatens to replace Lidarr long-term

Convergence project combining Overseerr + Navidrome + Lidarr + Slskd. v2.0 plans to replace Lidarr entirely. Early alpha, single developer.

- **Source**: Futurist (Low)
- **Type**: Secondary (project README, speculative)

### E30: Plex Sonic Analysis generates rich music metadata Lidarr knows nothing about

Neural network extracting ~50 parameters from music files for sonic similarity. Premium feature (Plex Pass). Could inform discovery.

- **Source**: Futurist (High)
- **Type**: Primary (Plex documentation)

### E31: DiscoveryLastFM provides proven multi-step workflow

Last.fm history -> similar artists -> MusicBrainz filtering -> Lidarr/Headphones add -> persistent cache -> exponential backoff. Complete pipeline.

- **Source**: Archaeologist (High)
- **Type**: Primary (project source code)

---

## Evidence vs. Hypotheses Matrix

Each cell evaluates whether the evidence is **Consistent (C)**, **Inconsistent (I)**, or **Neutral (N)** with respect to the hypothesis. The focus is on disconfirming (inconsistent) evidence.

| Evidence                              | H1: Full CRUD | H2: Read + Direct Discovery | H3: Thin Bulk Ops | H4: No Lidarr | H5: Comprehensive Replace | H6: Layered Bridge |
| ------------------------------------- | :-----------: | :-------------------------: | :---------------: | :-----------: | :-----------------------: | :----------------: |
| E1: No discovery endpoints            |       N       |            **C**            |       **C**       |     **C**     |           **I**           |       **C**        |
| E2: Metadata server outages           |     **I**     |              N              |         N         |     **C**     |           **I**           |         N          |
| E3: Self-hosted metadata rejected     |     **I**     |              N              |         N         |     **C**     |           **I**           |         N          |
| E4: TsArr SDK exists                  |     **C**     |              C              |         C         |       N       |             C             |       **C**        |
| E5: No TS CLI for Lidarr              |     **C**     |              C              |         C         |       N       |             C             |       **C**        |
| E6: Album-level only, no tracks       |     **I**     |              N              |         N         |     **C**     |           **I**           |         N          |
| E7: Bulk unmonitor most requested     |       N       |            **I**            |       **C**       |     **I**     |             C             |       **C**        |
| E8: Plex-Lidarr bridge unserved       |       N       |              N              |       **I**       |       C       |             C             |       **C**        |
| E9: Last.fm reliable for discovery    |       N       |            **C**            |         N         |       C       |             C             |       **C**        |
| E10: ListenBrainz emerging            |       N       |            **C**            |         N         |       C       |             C             |       **C**        |
| E11: Bulk ops cause cascades          |     **I**     |              N              |         C         |       N       |           **I**           |         C          |
| E12: Loop prevention proven           |       N       |              N              |         N         |       N       |             C             |       **C**        |
| E13: Composable beats monolithic      |     **I**     |              C              |         C         |       C       |           **I**           |       **C**        |
| E14: API v1 stable                    |     **C**     |              C              |       **C**       |       N       |             C             |       **C**        |
| E15: File corruption risks            |     **I**     |              N              |         N         |     **C**     |           **I**           |         N          |
| E16: Hand-maintained wrappers fail    |       N       |              N              |         N         |       N       |           **I**           |         N          |
| E17: "Won't Fix" culture              |       C       |              C              |       **C**       |       C       |             C             |       **C**        |
| E18: 5+ containers for workflow       |       N       |              N              |       **I**       |       N       |           **C**           |         C          |
| E19: Designed for automation not CLI  |     **I**     |              N              |         N         |     **C**     |           **I**           |         N          |
| E20: rfmedia-cli has Plex integration |       N       |              C              |         N         |     **C**     |             C             |       **C**        |
| E21: Recyclarr gap for Lidarr         |       C       |              N              |         C         |       N       |             C             |         C          |
| E22: Monitoring state pain point      |       C       |            **I**            |       **C**       |     **I**     |             C             |       **C**        |
| E23: 120-sec delays for bulk add      |     **I**     |              N              |         N         |       C       |           **I**           |         N          |
| E24: Beets is the gold standard       |       N       |              C              |         N         |       C       |             N             |         C          |
| E25: Headphones getSimilar pattern    |       N       |              C              |         N         |       N       |             C             |       **C**        |
| E26: Music metadata complexity        |     **I**     |              N              |         N         |       C       |           **I**           |         N          |
| E27: Local-only ops are reliable      |       C       |              C              |       **C**       |     **I**     |             C             |       **C**        |
| E28: Spotify API locked down          |       N       |            **C**            |         N         |       C       |             C             |       **C**        |
| E29: Naviseerr may replace Lidarr     |     **I**     |              N              |         N         |       C       |           **I**           |         N          |
| E30: Plex Sonic Analysis              |       N       |              C              |         N         |     **C**     |             N             |       **C**        |
| E31: DiscoveryLastFM proven workflow  |       N       |              C              |         N         |       N       |             C             |       **C**        |
| **Inconsistent count**                |    **10**     |            **2**            |       **2**       |     **4**     |          **10**           |       **0**        |
| **Consistent count**                  |     **5**     |           **12**            |      **10**       |    **15**     |          **14**           |       **21**       |

---

## Hypothesis Evaluation

### H1: Full CRUD Lidarr Client -- ELIMINATED

**Disconfirming evidence (10 items):**

1. **E2**: Metadata server outages mean search/lookup operations are unreliable. A full CRUD client that depends on these is inheriting fragility with no mitigation.
2. **E3**: The metadata SPOF is acknowledged and will not be fixed. Full CRUD doubles down on a known architectural weakness.
3. **E6**: Album-level granularity mismatches rfmedia-cli's track-level Plex operations. Full CRUD would expose this tension across every feature.
4. **E11**: Bulk operations through full CRUD cause non-linear cascading effects across the entire arr stack (indexer exhaustion affects Sonarr/Radarr too).
5. **E13**: Monolithic approaches (docker-lidarr-extended) have historically failed. Full CRUD encourages monolithic feature bundles.
6. **E15**: File corruption risks from metadata operations. More CRUD surface = more risk surface.
7. **E19**: Lidarr is designed for automation, not CLI interaction. Wrapping the full API fights the software's design philosophy.
8. **E23**: 120-second delays between bulk adds. Full CRUD would expose users to these friction points across many operations.
9. **E26**: Music metadata complexity means many CRUD operations will produce unexpected results (wrong releases, duplicate entries, matching failures).
10. **E29**: If Naviseerr replaces Lidarr, a deep CRUD investment becomes stranded.

**Assessment**: The weight of disconfirming evidence is overwhelming. Full CRUD integration couples rfmedia-cli too tightly to Lidarr's fragile infrastructure. The investment is disproportionate to the value gained, and the approach inherits every known weakness of the Lidarr ecosystem.

### H5: Comprehensive Integration Replacing Companion Tools -- ELIMINATED

**Disconfirming evidence (10 items):**

1. **E1**: Lidarr has no discovery endpoints. "Replacing Lidify" means building discovery outside Lidarr, contradicting the premise of comprehensive Lidarr integration.
2. **E2/E3**: Metadata fragility compounds across every feature that depends on search/lookup.
3. **E6**: Track-level mismatch becomes acute when trying to replace tools like LidaTube (track-level YouTube downloads).
4. **E11**: Cascading effects are amplified by comprehensive automation.
5. **E13**: This IS the monolithic approach that docker-lidarr-extended already tried and failed at. Composable beats monolithic is the strongest historical lesson.
6. **E15**: More automation surface = more file corruption risk.
7. **E16**: Hand-maintained comprehensive wrappers consistently fail. Auto-generated SDKs cover endpoints but do not solve the workflow fragility.
8. **E19**: Building comprehensive CLI integration against software designed for autonomous automation.
9. **E23**: Bulk operations across all replaced tools would hit rate limits everywhere.
10. **E26/E29**: Music complexity and Lidarr replacement risk compound across the broadest possible integration surface.

**Assessment**: This is docker-lidarr-extended reimagined in TypeScript. History has already run this experiment. The monolithic approach collapsed under the weight of external API dependencies (Tidal, Deezer, Spotify), fragile streaming integrations, and unsustainable maintenance burden. Replacing 5+ tools means inheriting 5+ tools' worth of edge cases, API dependencies, and maintenance overhead. The historical evidence against this approach is definitive.

### H4: No Lidarr Integration -- Plex-to-Metadata Bridge -- WEAKENED BUT SURVIVES

**Disconfirming evidence (4 items):**

1. **E7**: Bulk unmonitor is the most requested feature and requires Lidarr API access. Ignoring Lidarr entirely abandons the highest-demand use case.
2. **E22**: Monitoring state management is the most common user pain point. Cannot address it without Lidarr.
3. **E27**: Local-only Lidarr operations ARE reliable. Refusing to use them leaves value on the table without good reason.
4. **E8**: The Plex-Lidarr bridge opportunity -- the highest-value feature identified across all personas -- requires BOTH systems, not just Plex.

**Consistent evidence (15 items):** Strong case for avoiding Lidarr dependency. Metadata fragility, album-centric mismatch, file corruption risks, "Won't Fix" culture, and Plex's rich existing data all support this hypothesis.

**Assessment**: The contrarian case against Lidarr is strong, but this hypothesis overreacts to Lidarr's weaknesses. The disconfirming evidence reveals a fatal flaw: the most valuable features (bulk management, Plex-Lidarr bridge) require Lidarr API access. Abandoning Lidarr entirely means abandoning the bridge -- which every persona independently identified as the highest-value opportunity. **Survives as a fallback scenario but not recommended.**

### H2: Read-Only Lidarr + Direct Discovery APIs -- SURVIVES (Runner-Up)

**Disconfirming evidence (2 items):**

1. **E7**: Bulk unmonitor requires WRITE operations on Lidarr. Read-only access cannot address the most requested feature.
2. **E22**: Monitoring state management requires PUT/DELETE operations on artists and albums.

**Consistent evidence (12 items):** Strong case for direct discovery API integration. Last.fm reliability, ListenBrainz emergence, Spotify lockdown, and Plex's existing data all support bypassing Lidarr for discovery while using it for read operations.

**Assessment**: The read-only constraint is too restrictive. The two pieces of disconfirming evidence target the highest-demand features. However, the core insight -- that discovery should NOT go through Lidarr -- is valid and important. This hypothesis correctly identifies that Lidarr is not a discovery tool, but incorrectly concludes that write operations should be avoided entirely. **Survives as partial influence on the winning hypothesis.**

### H3: Thin Bulk Operations Client -- SURVIVES (Third Place)

**Disconfirming evidence (2 items):**

1. **E8**: Ignores the Plex-Lidarr bridge opportunity entirely. Bulk operations alone miss the unique value proposition rfmedia-cli could offer.
2. **E18**: Users need more than just bulk ops -- they need the consolidated workflow that 5+ Docker containers currently provide (at least the discovery component).

**Consistent evidence (10 items):** Strong case for focused bulk operations. Local-only operations are reliable, monitoring is the biggest pain point, "Won't Fix" culture creates clear market, API v1 is stable.

**Assessment**: Tactically correct but strategically incomplete. Solves the most immediate pain (bulk management) but misses the differentiated opportunity (Plex-Lidarr bridge, discovery). Would make rfmedia-cli useful but not uniquely valuable. **Survives as a "Phase 1" approach within the winning hypothesis.**

### H6: Layered Architecture with Plex-Lidarr Bridge Focus -- WINNER

**Disconfirming evidence: 0 items**

No evidence in the corpus contradicts this hypothesis. Every piece of evidence is either consistent or neutral.

**Consistent evidence (21 items):** The strongest consistency across all evidence, including:

- Layer 1 (bulk ops) addresses E7, E22, E27 (reliable local operations solving the biggest pain points)
- Layer 2 (direct discovery) addresses E1, E9, E10, E28 (discovery through open APIs, not Lidarr)
- Layer 3 (bridge) addresses E8, E20, E30 (unique Plex-Lidarr value proposition)
- Overall architecture addresses E12, E13 (composable, proven patterns), E14 (stable API target), E17 (external tool market), E4/E5 (TypeScript gap)

**Assessment**: This hypothesis synthesizes the strongest insights from every persona without triggering any disconfirming evidence. It is composable (not monolithic), focused on reliable operations (local-only for Lidarr writes), independent in its discovery layer (Last.fm/ListenBrainz, not Lidarr), and uniquely differentiated through the Plex-Lidarr bridge that no other tool provides.

---

## Final Rankings

| Rank | Hypothesis                                           | I-Count | C-Count | Verdict                                 |
| ---- | ---------------------------------------------------- | :-----: | :-----: | --------------------------------------- |
| 1    | **H6: Layered Architecture with Plex-Lidarr Bridge** |    0    |   21    | **RECOMMENDED**                         |
| 2    | H2: Read-Only + Direct Discovery                     |    2    |   12    | Valid insight, too restrictive          |
| 3    | H3: Thin Bulk Operations                             |    2    |   10    | Good Phase 1, incomplete strategy       |
| 4    | H4: No Lidarr Integration                            |    4    |   15    | Overreaction to valid concerns          |
| 5    | H1: Full CRUD Client                                 |   10    |    5    | **ELIMINATED**                          |
| 6    | H5: Comprehensive Replacement                        |   10    |   14    | **ELIMINATED** -- history warns clearly |

---

## Recommended Architecture: H6 Detailed Design

### Layer 1: Bulk Management Operations (via Lidarr API)

**Scope**: Operations that work against Lidarr's local database with NO metadata server dependency.

| Operation                            | API Endpoint                   | Risk Level |
| ------------------------------------ | ------------------------------ | :--------: |
| List all artists                     | `GET /api/v1/artist`           |    Low     |
| List albums for artist               | `GET /api/v1/album?artistId=N` |    Low     |
| Bulk monitor/unmonitor albums        | `PUT /api/v1/album/monitor`    |    Low     |
| Bulk update artists (tags, profiles) | `PUT /api/v1/artist/editor`    |    Low     |
| Bulk delete artists                  | `DELETE /api/v1/artist/editor` |   Medium   |
| Change quality/metadata profiles     | `PUT /api/v1/artist/{id}`      |    Low     |
| Tag management                       | `GET/POST /api/v1/tag`         |    Low     |
| View wanted/missing                  | `GET /api/v1/wanted/missing`   |    Low     |
| System health check                  | `GET /api/v1/health`           |    Low     |

**Excluded from Layer 1** (metadata server dependent, higher risk):

- Artist lookup/search (`GET /api/v1/artist/lookup`) -- metadata server dependent
- Adding new artists (`POST /api/v1/artist`) -- metadata server dependent
- Metadata refresh commands -- triggers metadata server calls
- Indexer search commands -- triggers cascading effects

**Key design decisions**:

- Default `--dry-run` for all destructive operations
- Batch size limits with `--max-batch N` to prevent cascade effects
- Tag all CLI-modified items with a configurable tag (e.g., "rfmedia-managed")
- Progress bars and error reporting for bulk operations
- Local audit log of all changes for undo capability

### Layer 2: Discovery via Direct APIs (NOT through Lidarr)

**Scope**: Artist/album discovery using open, reliable APIs directly.

| Source       | API                               | Authentication     |    Rate Limit    |        Status         |
| ------------ | --------------------------------- | ------------------ | :--------------: | :-------------------: |
| Last.fm      | `artist.getSimilar`               | API key (no OAuth) |    ~5 req/sec    |  Stable, recommended  |
| ListenBrainz | `/labs/api/similar-artists`       | None required      |     Unknown      |     Emerging, CC0     |
| MusicBrainz  | `/ws/2/artist` with `artist-rels` | User-Agent only    | 1 req/sec strict | Stable, comprehensive |

**Workflow** (based on proven DiscoveryLastFM and Lidify patterns):

1. `rfmedia lidarr discover --artist "Radiohead"` -- query Last.fm/ListenBrainz for similar artists
2. Cross-reference with Lidarr library (Layer 1 read: `GET /api/v1/artist`)
3. Cross-reference with Plex library (existing rfmedia-cli integration)
4. Present ranked results with similarity scores, filtering out already-owned
5. User selects which to add (interactive or `--batch`)
6. Optional: Add to Lidarr via `POST /api/v1/artist` (metadata server dependent -- warn user, implement retry with backoff)

**Key design decisions**:

- Discovery source is configurable (`--source lastfm|listenbrainz|musicbrainz|all`)
- Results cached locally to avoid repeated queries
- Loop prevention built in from day one (max per seed, no cascade, proven by lidarr-extended)
- Add-to-Lidarr is a separate, optional step with `--add` flag
- Default to `searchForNewArtist: false` and `monitored: false` when adding
- `--max-add N` flag to prevent accidental bulk additions

### Layer 3: Plex-Lidarr Bridge (Unique Value Proposition)

**Scope**: Cross-system intelligence that no other tool provides.

| Feature                 | Plex Data                      | Lidarr Data       | Value                                      |
| ----------------------- | ------------------------------ | ----------------- | ------------------------------------------ |
| Gap analysis            | Artists in Plex library        | Artists in Lidarr | "Artists in Plex not tracked by Lidarr"    |
| Reverse gap             | N/A                            | Artists in Lidarr | "Lidarr artists with no files on disk"     |
| Rating-informed quality | Plex star ratings, play counts | Quality profiles  | "Upgrade highly-rated artists to FLAC"     |
| Discovery seed          | Top-played Plex artists        | Last.fm similar   | "Find artists similar to your most-played" |
| Monitoring cleanup      | Play counts = 0                | Monitored status  | "Unmonitor artists you never listen to"    |

**Key design decisions**:

- Bridge via MusicBrainz IDs as canonical identifier (used by both Plex metadata agents and Lidarr)
- Local mapping cache for Plex item -> MusicBrainz ID -> Lidarr artist ID
- All bridge operations are read + suggest by default; writes require explicit `--apply` flag
- Handle naming inconsistencies with fuzzy matching + MusicBrainz ID verification

---

## Risk Assessment for Recommended Approach (H6)

### Mitigated Risks

| Risk                          | From Evidence | Mitigation                                                                                                         |
| ----------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Metadata server outages       | E2, E3        | Layer 1 avoids metadata-dependent operations; Layer 2 uses direct APIs; health check before metadata-dependent ops |
| Cascade effects from bulk ops | E11           | Batch size limits, dry-run defaults, rate limiting on adds                                                         |
| Monolithic fragility          | E13           | Each layer is independently useful; composable architecture                                                        |
| API churn                     | E14, E16      | API v1 is stable; use TsArr or generate from OpenAPI spec for type safety                                          |
| File corruption               | E15           | Exclude file-modifying operations (metadata retag, rename) from default behavior; require explicit flags           |
| Loop prevention for discovery | E12           | Built into Layer 2 from day one using proven lidarr-extended patterns                                              |

### Residual Risks

| Risk                            |        Probability        | Impact | Acceptance Rationale                                                                        |
| ------------------------------- | :-----------------------: | :----: | ------------------------------------------------------------------------------------------- |
| Lidarr replaced by Naviseerr    | Low (20-30% over 2 years) | Medium | Layered architecture allows swapping Layer 1 backend; Layers 2 and 3 are Lidarr-independent |
| Last.fm API changes/shutdowns   |         Very Low          | Medium | ListenBrainz as fallback; multi-source discovery strategy                                   |
| Plex-Lidarr ID mapping failures |          Medium           |  Low   | Fuzzy matching + user review; not fully automated                                           |
| TsArr Bun dependency            |          Medium           |  Low   | Can generate own client from OpenAPI spec if needed; or contribute Node.js compatibility    |

---

## Sensitivity Analysis

**What if the metadata server stabilizes permanently?**

H6 still wins. Layers 2 and 3 retain value regardless of metadata reliability. Layer 1 could optionally expand to include search/lookup operations if they become reliable. The layered architecture accommodates this expansion without redesign.

**What if Lidarr is abandoned?**

H6 degrades gracefully. Layers 2 and 3 are Lidarr-independent. Layer 1 would need a new backend (Naviseerr, direct MusicBrainz, or Beets), but the interface abstraction allows swapping. H4 (no Lidarr) would have been correct in this scenario, but H6's layered approach provides the same resilience without sacrificing current functionality.

**What if another TypeScript CLI tool for Lidarr emerges?**

H6's differentiation is the Plex-Lidarr bridge (Layer 3) and integrated discovery (Layer 2), not just Lidarr CRUD. A competitor building generic Lidarr CRUD would not compete with rfmedia-cli's unique cross-system value proposition.

**What if Last.fm degrades or shuts down?**

ListenBrainz serves as direct replacement with CC0 licensing. The multi-source discovery strategy (E9, E10) provides resilience. MusicBrainz artist relationships serve as tertiary fallback.

---

## Implementation Priority

Based on evidence strength and user demand:

### Phase 1: Bulk Management (Layer 1)

Highest immediate value. Addresses E7 (most requested feature) and E22 (biggest pain point). Uses only reliable local API operations (E27). TypeScript gap is clear (E5).

**Key commands**:

- `rfmedia lidarr status` -- library overview (artist count, monitored/unmonitored, disk usage)
- `rfmedia lidarr list` -- list artists with filtering (tag, quality profile, monitoring status)
- `rfmedia lidarr unmonitor --type singles,eps` -- bulk unmonitor by album type
- `rfmedia lidarr tag --add "cli-managed" --artist "Artist Name"` -- tag management
- `rfmedia lidarr profile --set "FLAC" --tag "premium"` -- bulk quality profile changes

### Phase 2: Discovery (Layer 2)

Second highest value. Addresses E1 (no native discovery), E9 (Last.fm proven), E28 (Spotify gone). No competition in CLI space (E5).

**Key commands**:

- `rfmedia lidarr discover --artist "Radiohead"` -- similar artist discovery
- `rfmedia lidarr discover --from-plex-playlist "Favorites"` -- Plex-seeded discovery
- `rfmedia lidarr add --artist "New Artist" --unmonitored` -- add with safe defaults

### Phase 3: Plex-Lidarr Bridge (Layer 3)

Highest differentiation value. Completely unserved gap (E8). Unique to rfmedia-cli (E20).

**Key commands**:

- `rfmedia lidarr gaps` -- Plex vs Lidarr gap analysis
- `rfmedia lidarr sync-ratings` -- Plex ratings -> Lidarr quality decisions
- `rfmedia lidarr cleanup --unplayed --older-than 90d` -- consumption-informed cleanup

---

## Conclusion

The ACH analysis decisively supports **H6 (Layered Architecture with Plex-Lidarr Bridge Focus)** as the recommended approach. It is the only hypothesis with zero disconfirming evidence and the highest consistency score (21 of 31 evidence items supporting it). The analysis eliminated two hypotheses (H1: Full CRUD, H5: Comprehensive Replacement) with 10 inconsistencies each, and identified the critical flaw in H4 (No Lidarr) -- that the highest-value feature (the bridge) requires both systems.

The key strategic insight across all 8 personas is convergent: **Lidarr is a reliable collection manager whose local API operations work well, but it is NOT a discovery tool, NOT a metadata authority, and NOT a bridge between consumption and acquisition.** rfmedia-cli should use Lidarr for what it does reliably (local CRUD), get discovery from purpose-built open APIs (Last.fm, ListenBrainz), and create the bridge between Plex and Lidarr that no other tool provides.

The layered architecture ensures that:

1. Each layer delivers independent value (no all-or-nothing dependency)
2. Lidarr's known fragilities are isolated to optional operations
3. The unique value proposition (Plex-Lidarr bridge) is the strategic moat
4. Composable design honors the strongest historical lesson from the ecosystem
