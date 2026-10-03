# Negative Space Research: Lidarr API Integration for Music Management CLI

## Executive Summary

The Lidarr ecosystem has significant gaps in CLI tooling, automation capabilities, and cross-system integration that create real opportunities for rfmedia-cli. The most critical absences are: (1) no TypeScript-native CLI tool exists for managing Lidarr artists/albums programmatically, (2) no bridge tool connects Plex music intelligence (ratings, play counts, playlists) with Lidarr collection management, and (3) bulk operations like mass unmonitoring by album type, conditional deletion, and quality profile switching remain relegated to fragile bash scripts and manual web UI clicking. The metadata API fragility (MusicBrainz dependency) and album-centric data model mismatch with track-level consumption patterns compound these gaps.

## Missing CLI Features

### No TypeScript/Node.js CLI for Lidarr Management

- **What's missing**: There is no dedicated TypeScript/Node.js CLI tool for managing Lidarr. While Go (golift/starr), Python (pyarr), and Rust (lidarr crate) have API client libraries, the JavaScript/TypeScript ecosystem has only the recently created TsArr SDK (v1.11.0, Feb 2026) which is auto-generated from Swagger specs but is a library, not a CLI tool. No npm package provides a command-line interface for Lidarr operations.
- **Why it matters**: The self-hosted community increasingly uses Node.js tooling (Overseerr, Jellyseerr, arr-tools). A TypeScript CLI would fill a gap that Python's pyarr partially addresses but without the type safety and integration potential with tools like rfmedia-cli.
- **User demand**: Medium - Developers tend to write ad-hoc scripts rather than seek dedicated CLI tools.
- **Technical difficulty**: Low-Medium - The Lidarr API is OpenAPI-documented and TsArr already provides typed client bindings.
- **Confidence**: High - Confirmed by searching npm, GitHub, and the awesome-arr list; no TypeScript CLI tool exists.
- **Sources**: [TsArr SDK](https://github.com/robbeverhelst/TsArr), [awesome-arr](https://ravencentric.cc/awesome-arr/), [npm search](https://www.npmjs.com/search?q=keywords:sonarr)

### Bulk Unmonitor by Album Type (Singles, EPs, Remixes)

- **What's missing**: Lidarr's UI allows monitoring "All Albums" or "None" but offers no granular control over album types (Singles, EPs, Compilations, Remixes). Users with large libraries must manually click through each artist to unmonitor unwanted album types. The only existing solution is a community bash script using curl and jq that hits the `/album/monitor` endpoint, which breaks on large libraries ("Argument list too long" error) and has Unicode character handling issues.
- **Why it matters**: Artists can have 50-100+ singles that all get monitored by default. This triggers unwanted downloads and wastes bandwidth/storage.
- **User demand**: High - GitHub issues #5409 and #2036 document this need explicitly, and the community bash script gist has active usage.
- **Technical difficulty**: Low - The API endpoint `/api/v1/album/monitor` accepts album IDs and a monitored boolean. A proper CLI tool just needs to batch requests correctly.
- **Confidence**: High - Multiple GitHub issues and community scripts confirm this gap.
- **Sources**: [GitHub #5409](https://github.com/Lidarr/Lidarr/issues/5409), [Unmonitor Gist](https://gist.github.com/jordandrako/e7082a6ad3d90b85df36017bb97a02f3), [GitHub #3894](https://github.com/Lidarr/Lidarr/issues/3894)

### Mass Editor Metadata Profile Changes

- **What's missing**: Lidarr's built-in mass editor cannot change metadata profiles for existing artists. The mass editor shows artists but hides the current "monitor new albums" value, making it impossible to audit monitoring state across the library. Users requested adding metadata profile editing to the mass editor (issue #2302), but this remains unresolved.
- **Why it matters**: When switching metadata strategies or cleaning up a library, users must edit artists one by one.
- **User demand**: Medium - Issue #2302 has been open since 2019.
- **Technical difficulty**: Low - The API supports `PUT /api/v1/artist/{id}` with full artist object updates including metadata profile.
- **Confidence**: High - Directly confirmed by GitHub issues.
- **Sources**: [GitHub #2302](https://github.com/Lidarr/Lidarr/issues/2302), [GitHub #3894](https://github.com/Lidarr/Lidarr/issues/3894)

### Conditional Deletion with File Awareness

- **What's missing**: The Lidarr API delete endpoints (`DELETE /api/v1/artist/{id}?deleteFiles=true`) have a documented bug where checking "delete track files" removes the entry from Lidarr but does not actually delete the files/folders on disk (issue #2551). No CLI tool provides safe, verified deletion with pre-flight checks showing what will be removed.
- **Why it matters**: Users performing library cleanup cannot trust the API to fully clean up, leading to orphaned files. A CLI tool could verify file existence, show disk usage, and confirm before deletion.
- **User demand**: Medium
- **Technical difficulty**: Medium - Requires combining Lidarr API calls with filesystem inspection.
- **Confidence**: Medium - Bug reported but may be environment-specific (Docker path mapping issues).
- **Sources**: [GitHub #2551](https://github.com/Lidarr/Lidarr/issues/2551), [Lidarr FAQ](https://wiki.servarr.com/lidarr/faq)

### Plex-to-Lidarr Artist Discovery Bridge

- **What's missing**: No tool exists that reads Plex music library data (ratings, play counts, recently added, playlists) and translates that intelligence into Lidarr actions (add similar artists, adjust quality profiles for highly-rated artists, unmonitor low-rated content). Plex has rich listening data; Lidarr has acquisition capabilities. The bridge between them does not exist.
- **Why it matters**: Users make listening decisions in Plex but manage collections in Lidarr, with no feedback loop between consumption and acquisition.
- **User demand**: High - This is implicit in every "self-hosted music still sucks" discussion. The rfmedia-cli tool is uniquely positioned to fill this gap given its existing Plex integration.
- **Technical difficulty**: Medium-High - Requires mapping Plex artist/album metadata to MusicBrainz IDs used by Lidarr, handling naming inconsistencies.
- **Confidence**: High - Confirmed by searching for Plex-Lidarr bridge tools; only Autoscan (library scan trigger) and basic Plex notifications exist.
- **Sources**: [Mesharr](https://github.com/LimeDrive/mesharr), [Overseerr-Lidarr fork](https://github.com/spwats/Overseerr-Lidarr-Integration), [thewicklowwolf music stack](https://thewicklowwolf.github.io/music-stack/)

### Similar Artist Discovery via CLI

- **What's missing**: Lidarr itself has no "similar artists" or "recommended artists" API endpoint. External tools like Lidify (Spotify/Last.fm-based recommendations) and Aurral (MusicBrainz tag-based) exist as web UIs but not as CLI tools. Critically, Lidify's Spotify integration broke in November 2024 due to Spotify API changes, and Aurral is a niche tool with limited adoption.
- **Why it matters**: Artist discovery is a core music management workflow. Being able to run `rfmedia lidarr similar --artist "Radiohead" --add` from the command line would be a unique capability.
- **User demand**: High - Lidify and Aurral's existence proves demand; their web-only nature leaves CLI users underserved.
- **Technical difficulty**: Medium - Requires integrating with Last.fm or MusicBrainz APIs for recommendations, then mapping results to Lidarr's add-artist workflow.
- **Confidence**: High - Confirmed Lidarr has no native discovery endpoint; confirmed external tools are web-only.
- **Sources**: [Lidify](https://github.com/TheWicklowWolf/Lidify), [Aurral](https://github.com/lklynet/aurral), [Lidify article](https://chns.tech/2024/07/21/lidify-discover-artist-based-on-your-library/)

## Adoption Barriers

### Metadata API Fragility and Centralized Dependency

- **Type**: Technical
- **Impact**: Every Lidarr user and every tool that integrates with Lidarr's search/lookup functionality. When the metadata API goes down, artist search, library imports, and new additions all fail.
- **Severity**: High
- **Addressable?**: Partially. The Lidarr team has explicitly rejected self-hosted metadata (issue #5546, closed "Won't Fix" and locked). A CLI tool can mitigate by caching artist/album data locally and falling back to direct MusicBrainz queries, but this adds complexity. Community member musicinfo.pro hosts an alternative API instance.
- **Details**: On May 21, 2025, a MusicBrainz schema change broke Lidarr's metadata server. The rebuild took weeks. During this period, all search-based operations failed. This is a single point of failure that affects any tool depending on Lidarr's lookup endpoints.
- **Confidence**: High - Extensively documented across multiple GitHub issues (#5498, #5516, #5520, #5530, #5546, #5555).
- **Sources**: [GitHub #5498](https://github.com/Lidarr/Lidarr/issues/5498), [GitHub #5546](https://github.com/Lidarr/Lidarr/issues/5546), [MetaBrainz community post](https://community.metabrainz.org/t/for-those-using-lidarr-and-musicbrainz-metadata/768255)

### Album-Centric Data Model Mismatch

- **Type**: Technical/Architectural
- **Impact**: Every user who consumes music at the track level rather than the album level, which is the majority of modern listeners.
- **Severity**: High
- **Addressable?**: Not by a CLI tool alone. This is a fundamental architectural decision in Lidarr. A CLI tool can work around it by providing track-level filtering after album acquisition, but cannot change Lidarr's album-first model.
- **Details**: Lidarr forces complete album downloads. The torrent/Usenet ecosystem distributes complete albums, creating a mismatch where users often want specific tracks but must acquire entire albums. A CLI tool could add value by automating the post-acquisition filtering (keep only highly-rated tracks, for example).
- **Confidence**: High - Extensively discussed in "Self-Hosted Music Still Sucks in 2025" analysis and multiple community forums.
- **Sources**: [Self-Hosted Music 2025](https://www.joekarlsson.com/2025/06/self-hosted-music-still-sucks-in-2025/), [SaaSHub Sonarr vs Lidarr](https://www.saashub.com/compare-sonarr-vs-lidarr)

### MusicBrainz Rate Limiting (1 query/second)

- **Type**: Technical
- **Impact**: Any bulk operation that triggers metadata lookups. Adding 3000 artists takes approximately 50 minutes due to MusicBrainz rate limiting.
- **Severity**: Medium
- **Addressable?**: Yes, through proper queuing and progress reporting in a CLI tool. This is where a well-designed CLI adds clear value over ad-hoc scripts.
- **Details**: The Lidarr metadata API implements rate limiting, and the underlying MusicBrainz API is rate-limited to 1 query/second. Bulk imports via import lists are capped at approximately 30-250 items depending on source. The Spotify import list has a hard limit of 250 IDs per request (issue #5653).
- **Confidence**: High - Rate limits are documented and confirmed by multiple sources.
- **Sources**: [GitHub #5653](https://github.com/lidarr/Lidarr/issues/5653), [GitHub #1178](https://github.com/lidarr/Lidarr/issues/1178), [LidarrAPI.Metadata rate limiting PR](https://github.com/lidarr/LidarrAPI.Metadata/pull/111/files)

### "Won't Fix" Culture for Extensibility Requests

- **Type**: Social/Governance
- **Impact**: Developers who want to extend Lidarr's capabilities or customize behavior. Feature requests for flexibility (self-hosted metadata, flexible file renaming, manual metadata entry) are repeatedly closed as "Won't Fix."
- **Severity**: Medium
- **Addressable?**: Yes, by building external tools that work around Lidarr's limitations via its API rather than requesting changes to Lidarr itself. This is exactly the rfmedia-cli opportunity.
- **Details**: Issues #5554 (manual metadata entry), #5517 (flexible file renaming), #5546 (self-hosted metadata), and #5558 (custom metadata source) were all closed as "Won't Fix." The development team is small (volunteers with full-time jobs) managing five applications, creating a bottleneck for feature development.
- **Confidence**: High - Directly observed in GitHub issue closures.
- **Sources**: [GitHub #5554](https://github.com/Lidarr/Lidarr/issues/5554), [GitHub #5517](https://github.com/Lidarr/Lidarr/issues/5517), [GitHub #5546](https://github.com/Lidarr/Lidarr/issues/5546)

### No Overseerr Equivalent for Music Requests

- **Type**: Ecosystem gap
- **Impact**: Plex household users who want to request music similar to how they request movies/TV shows through Overseerr.
- **Severity**: High
- **Addressable?**: Partially. A CLI tool serves power users but not household members who need a web UI. However, a CLI API could power a future web interface.
- **Details**: Overseerr explicitly has "no plans" for Lidarr support (issue #352, opened 2021). Community forks exist (spwats, digitalrobin, findthelorax) but none are production-ready. Jellyseerr/Seerr has an open PR (#1238) for Lidarr support with unresolved merge conflicts.
- **Confidence**: High - Confirmed by multiple GitHub issues and fork status checks.
- **Sources**: [Overseerr #352](https://github.com/sct/overseerr/issues/352), [Overseerr #3819](https://github.com/sct/overseerr/issues/3819), [Seerr PR #1238](https://github.com/seerr-team/seerr/pull/1238)

## Knowledge Gaps

### Lidarr API Pagination Behavior

- **What we don't know**: The Lidarr API pagination behavior for large result sets is poorly documented. The OpenAPI spec exists but practical details (maximum page sizes, default limits, behavior when results exceed limits, cursor-based vs offset-based pagination) are not covered in any community documentation or wiki.
- **Why it's unknown**: The Swagger docs are auto-generated and describe endpoint signatures but not behavioral characteristics. Most users interact through the web UI, not the API directly.
- **Impact of gap**: CLI tool developers must discover pagination behavior through trial and error. The existing bash scripts that hit the "Argument list too long" limit demonstrate this gap directly.
- **Confidence**: Medium - The OpenAPI spec exists at the Lidarr source, but practical usage documentation is absent.
- **Sources**: [Lidarr API Docs](https://lidarr.audio/docs/api/), [OpenAPI spec on GitHub](https://raw.githubusercontent.com/lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json)

### Bulk Add Artist Performance Characteristics

- **What we don't know**: What actually happens when you add 100+ artists via the API in rapid succession? Does Lidarr queue metadata lookups internally? Does it overwhelm the metadata API? Are there internal rate limits separate from MusicBrainz limits? What is the failure mode?
- **Why it's unknown**: Most users add artists through the UI one at a time or through import lists (which have their own caps). Programmatic bulk addition is uncommon, so real-world performance data is scarce.
- **Impact of gap**: A CLI tool that offers `rfmedia lidarr add --from-plex-playlist "Top Rated"` could trigger hundreds of artist additions, and the behavior is unpredictable.
- **Confidence**: Low - Only one data point exists (YouTube Music migration blog post mentioning ~50 min for 3000 artists).
- **Sources**: [YouTube Music to Lidarr migration](https://www.chuck-builds.com/migrating-youtube-music-to-lidarr-as-a-import-list/)

### Delete Endpoint File Behavior Across Environments

- **What we don't know**: Whether the `deleteFiles=true` parameter on DELETE endpoints reliably deletes files across different deployment environments (Docker with volume mounts, native installations, NFS-mounted paths, remote path mappings).
- **Why it's unknown**: Bug reports about file non-deletion (issue #2551) suggest environment-specific behavior, but systematic testing across deployment types has not been documented.
- **Impact of gap**: A CLI tool offering delete functionality must handle this uncertainty, potentially by verifying file removal post-delete.
- **Confidence**: Low - Single bug report, unclear if widely reproducible.
- **Sources**: [GitHub #2551](https://github.com/Lidarr/Lidarr/issues/2551)

### Album Matching Threshold Customization

- **What we don't know**: The exact matching algorithm and whether the 80% threshold (documented in FAQ) applies uniformly across API-triggered imports vs manual imports vs automated searches. Users requested options to tweak the matching engine (issue #779) but the request was not implemented.
- **Why it's unknown**: The matching algorithm is internal to Lidarr and not exposed via API. The 80% threshold is mentioned in FAQ but implementation details are opaque.
- **Impact of gap**: A CLI tool automating imports cannot predict which albums will fail matching or provide useful pre-flight warnings.
- **Confidence**: Medium - FAQ mentions 80% threshold; community reports inconsistent matching behavior.
- **Sources**: [GitHub #779](https://github.com/lidarr/Lidarr/issues/779), [Lidarr FAQ](https://wiki.servarr.com/lidarr/faq)

### Webhook/Event Completeness for External Automation

- **What we don't know**: The complete list of Lidarr webhook events and what data they carry. The AlbumDelete event is known to include a `deletedFiles` boolean, but comprehensive webhook payload documentation is sparse.
- **Why it's unknown**: Webhook documentation is split between the Servarr wiki and the actual API behavior, with gaps in both.
- **Impact of gap**: CLI tools that want to react to Lidarr events (e.g., post-import processing, notification to Plex) cannot reliably plan their integration strategy.
- **Confidence**: Medium - Some events documented, but completeness uncertain.
- **Sources**: [GitHub #4552](https://github.com/Lidarr/Lidarr/issues/4552), [Lidarr Custom Scripts Wiki](https://wiki.servarr.com/lidarr/custom-scripts)

## Unsolved Problems

### Reliable Plex Ratings to Lidarr Metadata Sync

- **Description**: Plex stores music ratings internally but does not expose them in a way that maps cleanly to Lidarr's data model. Tools like PlexMusicRatingsSync (patzm, rfgamaral) sync ratings to/from audio file ID3 tags, but no tool syncs Plex ratings INTO Lidarr to influence monitoring decisions, quality profiles, or search priority.
- **Why unsolved**: Plex uses a proprietary rating system. Lidarr has no concept of "user rating" for artists or albums in its data model. The mapping would require a custom bridge that reads Plex ratings via PlexAPI and translates them into Lidarr monitoring/quality decisions.
- **Potential approaches**: A CLI tool could read Plex ratings, identify top-rated artists/albums, and then upgrade their Lidarr quality profiles or ensure they are monitored. This is a policy engine, not a data sync.
- **Confidence**: High - Confirmed no such tool exists. Plex rating sync tools exist but they target audio file tags, not Lidarr.
- **Sources**: [plex-music-rating-sync](https://github.com/patzm/plex-music-rating-sync), [PlexMusicRatingsSync](https://github.com/rfgamaral/PlexMusicRatingsSync), [beets Plex import issue #4083](https://github.com/beetbox/beets/issues/4083)

### Duplicate Detection Across Plex and Lidarr

- **Description**: Lidarr creates duplicate folders for case-insensitive artist/album name variations ("Coil" vs "COIL"), duplicate releases from MusicBrainz errors, and duplicate tracks when singles are later included on albums. No tool cross-references Plex's actual filesystem view with Lidarr's database to identify and resolve these duplicates.
- **Why unsolved**: Duplicates originate from multiple sources (MusicBrainz data quality, filesystem case sensitivity, release type overlaps). Solving it requires correlating data across MusicBrainz IDs, filesystem paths, audio fingerprints, and Plex metadata.
- **Potential approaches**: A CLI tool could compare Lidarr's artist/album database against Plex's library, flag mismatches, and offer resolution options (merge, delete, re-tag).
- **Confidence**: High - Multiple GitHub issues confirm duplication problems with no automated solutions.
- **Sources**: [GitHub #4014](https://github.com/Lidarr/Lidarr/issues/4014), [GitHub #687](https://github.com/lidarr/Lidarr/issues/687), [GitHub #792](https://github.com/lidarr/Lidarr/issues/792), [docker-lidarr-extended #239](https://github.com/RandomNinjaAtk/docker-lidarr-extended/issues/239)

### Quality Profile Management at Scale

- **Description**: Changing quality profiles across hundreds of artists requires individual API calls. No tool provides batch quality profile operations with filtering (e.g., "upgrade all artists with >50 plays in Plex to FLAC quality profile"). The Configarr tool manages profile definitions but not per-artist profile assignment.
- **Why unsolved**: Quality profile changes are a cross-system decision (listening data from Plex + acquisition config in Lidarr). No single tool has both data sources.
- **Potential approaches**: `rfmedia lidarr quality-upgrade --min-plex-plays 50 --profile "FLAC"` would combine Plex analytics with Lidarr API updates.
- **Confidence**: Medium - Configarr and Terraform providers handle profile definitions but not per-artist assignment at scale.
- **Sources**: [Configarr experimental Lidarr support](https://configarr.de/docs/configuration/experimental-support/), [Terraform Lidarr provider](https://registry.terraform.io/providers/devopsarr/lidarr/latest/docs/data-sources/custom_formats)

### Handling Lidarr's Album Matching Accuracy Issues

- **Description**: Lidarr's matching engine uses an 80% threshold that cannot be tuned. Albums with same-named singles (issue #516), different track orderings (issue #4335), special characters in names (issue #1180), and featured artist stripping (issue #1580) all cause matching failures. No pre-flight validation tool exists to predict which imports will fail.
- **Why unsolved**: The matching algorithm is internal to Lidarr, and tuning it requires modifying Lidarr's source code. The threshold is not exposed as a setting or API parameter.
- **Potential approaches**: A CLI pre-validation tool could compare source audio metadata against MusicBrainz data before triggering Lidarr import, flagging likely matching failures.
- **Confidence**: High - Multiple long-standing GitHub issues confirm matching accuracy problems.
- **Sources**: [GitHub #779](https://github.com/lidarr/Lidarr/issues/779), [GitHub #516](https://github.com/lidarr/Lidarr/issues/516), [GitHub #4335](https://github.com/Lidarr/Lidarr/issues/4335), [GitHub #1580](https://github.com/lidarr/Lidarr/issues/1580)

## Feature Requests Nobody's Building

### Music Request System (Overseerr for Music)

- **Demand**: Issue #352 on Overseerr (opened 2021) is one of the most requested features. Issue #3819 explicitly asks for Lidarr integration. Multiple community forks attempted it, all stalled or have unresolved conflicts.
- **Why not built**: Overseerr's maintainers explicitly stated "no plans" for Lidarr. The community forks lack the maintainer bandwidth to reach production quality. The Seerr team has an open PR (#1238) but it has merge conflicts.
- **Opportunity**: A CLI-based request system (`rfmedia lidarr request "Artist Name"`) would not replace Overseerr's web UI but would serve power users and could be the API backend for a future web interface.
- **Confidence**: High
- **Sources**: [Overseerr #352](https://github.com/sct/overseerr/issues/352), [Overseerr #3819](https://github.com/sct/overseerr/issues/3819), [Seerr PR #1238](https://github.com/seerr-team/seerr/pull/1238)

### Self-Hosted Metadata Alternative

- **Demand**: Issue #5546 requested self-hosted metadata (modeled on Readarr's rreading-glasses). Closed "Won't Fix" and locked.
- **Why not built**: The Lidarr team maintains centralized control over metadata. The stated reason is preventing strain on MusicBrainz, but the entire MusicBrainz database is publicly downloadable. Community member musicinfo.pro provides an alternative hosted API.
- **Opportunity**: A CLI tool could optionally use a configurable metadata endpoint, routing lookups to the official API, a self-hosted instance, or direct MusicBrainz queries. This workaround does not require Lidarr changes.
- **Confidence**: High
- **Sources**: [GitHub #5546](https://github.com/Lidarr/Lidarr/issues/5546), [LidarrAPI.Metadata repo](https://github.com/Lidarr/LidarrAPI.Metadata)

### Flexible File Renaming Beyond Lidarr's Hardcoded Patterns

- **Demand**: Issue #5517 requested customizable naming formats. Closed "Won't Fix."
- **Why not built**: Lidarr enforces specific artist folder and file naming conventions. The team considers this an intentional design decision for consistency.
- **Opportunity**: A post-processing CLI tool could rename files after Lidarr imports them, following user-defined patterns. This is what beets excels at, and a CLI bridge between Lidarr and beets would address this.
- **Confidence**: High
- **Sources**: [GitHub #5517](https://github.com/Lidarr/Lidarr/issues/5517), [lidarr-beets](https://github.com/MxMarx/lidarr-beets)

### MusicBrainz Collection as Import List

- **Demand**: Issue #4976 requests using MusicBrainz collections as an import source for Lidarr. Open but not actively developed.
- **Why not built**: Import list sources require specific integration work in Lidarr's codebase. The small development team prioritizes stability over new import sources.
- **Opportunity**: A CLI tool could read a MusicBrainz collection via the MusicBrainz API and add matching artists to Lidarr, bypassing the need for native import list support.
- **Confidence**: Medium - Feature request exists but limited community engagement.
- **Sources**: [GitHub #4976](https://github.com/Lidarr/Lidarr/issues/4976)

### Independent Monitoring Controls by Album Type

- **Demand**: Issue #5409 requests per-album-type monitoring controls (monitor Albums but not Singles/EPs). Closed as duplicate of #2036 (open since 2019).
- **Why not built**: Marked as duplicate; original issue #2036 remains open for 6+ years with no implementation. Team bandwidth is the cited constraint.
- **Opportunity**: A CLI tool could implement this as a post-add operation: after adding an artist, automatically unmonitor all album types except the user's preferences. This is exactly what the community bash script does, but a proper CLI would handle it reliably at scale.
- **Confidence**: High - Six years of user demand with no resolution.
- **Sources**: [GitHub #5409](https://github.com/Lidarr/Lidarr/issues/5409), [GitHub #2036](https://github.com/lidarr/Lidarr/issues/2034)

## Conspicuous Absences

### No Lidarr Equivalent of TRaSH Guides Quality Profiles

- **Expected**: TRaSH Guides provides extensively documented, community-maintained quality profile configurations for Sonarr and Radarr that are widely considered best practice. While TRaSH Guides has a Lidarr section, it is minimal compared to Sonarr/Radarr coverage.
- **Why conspicuous**: Quality profile configuration is one of the most complex aspects of Lidarr setup. The lack of comprehensive community-maintained profiles means every user must figure out optimal settings independently.
- **Implications**: A CLI tool that ships with opinionated, well-documented quality profile presets would fill a significant gap.
- **Source**: [TRaSH Guides Lidarr](https://trash-guides.info/Lidarr/)

### No CLI-Level Library Health Audit Tool

- **Expected**: Sonarr and Radarr users have tools and scripts that audit library health (missing episodes, quality upgrades available, stalled downloads). No equivalent exists for Lidarr that reports: artists with no monitored albums, albums with matching failures, disk usage by quality profile, artists in Lidarr but not in Plex, artists in Plex but not in Lidarr.
- **Why conspicuous**: Library health auditing is a common operations task for self-hosted media management.
- **Implications**: `rfmedia lidarr audit` could be a high-value feature for library maintainers.

### No Lidarr-to-Plex Gap Analysis Tool

- **Expected**: A tool that compares what Lidarr knows about (artists/albums) with what Plex actually has in its library, identifying gaps in both directions (Lidarr has it but Plex doesn't see it; Plex has it but Lidarr doesn't know about it).
- **Why conspicuous**: This is a fundamental data reconciliation problem that every user with both tools faces.
- **Implications**: rfmedia-cli already reads Plex data. Adding Lidarr comparison would create a unique cross-system audit capability.

### No Event-Driven Automation Pipeline

- **Expected**: A CLI tool that can subscribe to Lidarr webhook events and trigger actions (post-import beets tagging, Plex library scan, notification to users, quality audit).
- **Why conspicuous**: Lidarr supports custom scripts and webhooks, but no reusable CLI framework exists for building automation pipelines. Users must write custom bash scripts for each workflow.
- **Implications**: An event handler in rfmedia-cli could process Lidarr webhooks and orchestrate multi-step post-import workflows.

## Key Insights

1. **The biggest opportunity is bridging Plex and Lidarr.** No tool currently uses Plex's consumption intelligence (ratings, play counts, listening history) to inform Lidarr's acquisition decisions. rfmedia-cli already has Plex integration, making it uniquely positioned to be this bridge.

2. **Bulk operations are the most immediately impactful CLI feature.** Users are manually clicking through web UIs to unmonitor album types, change quality profiles, and manage artists at scale. Every community workaround is a fragile bash script. A proper CLI with batching, progress reporting, and error handling would directly address the most common pain point.

3. **Lidarr's "Won't Fix" culture creates a clear market for external tools.** The development team is small, maintains five applications, and actively rejects extensibility requests. This means the only path to many requested features is building them outside of Lidarr, which is exactly what rfmedia-cli would do.

4. **The metadata API single point of failure is a critical risk.** Any tool deeply integrating with Lidarr must account for the metadata API going down (as it did for weeks in mid-2025). Caching, fallback strategies, and graceful degradation are essential design considerations.

5. **TypeScript tooling for the arr ecosystem is nascent.** Go (golift/starr) and Python (pyarr) dominate the client library space. TsArr is new (Feb 2026). There is no TypeScript CLI tool at all. rfmedia-cli building Lidarr integration would be genuinely novel in the ecosystem.

6. **The album-centric model cannot be fixed by a CLI tool, but the friction can be reduced.** Post-acquisition track filtering, smart unmonitoring, and Plex-informed quality decisions can make the album-centric workflow more palatable without requiring Lidarr architectural changes.

7. **Similar artist discovery as a CLI feature has no competition.** Lidify's Spotify integration is broken, Aurral is niche, and neither offers CLI access. A command like `rfmedia lidarr discover --similar-to "Artist"` using Last.fm or MusicBrainz would be unique.

## Evidence Quality

- **Direct evidence of gaps**: 23 distinct gaps identified with source citations
- **GitHub issues examined**: 30+ across Lidarr, Overseerr, and related projects
- **Community scripts/tools audited**: 15+ (bash scripts, Python tools, Go libraries, Docker containers)
- **Overall confidence rating**: High - Multiple independent sources confirm the major gaps
- **Temporal freshness**: Sources range from 2019 (long-standing issues) to February 2026 (current state)

## Search Queries Executed

1. "Lidarr missing features wish list 2025 2026"
2. "Lidarr API documentation gaps problems developers"
3. "Lidarr CLI tool automation script missing"
4. "Lidarr problems no solution unsolved issues"
5. "Lidarr feature request open issues GitHub unresolved 2025"
6. "why Lidarr hard to automate compared Sonarr Radarr music"
7. "Lidarr Plex sync bridge integration missing tool"
8. "Lidarr bulk operations not possible mass edit artists albums"
9. "music automation self-hosted unsolved problems gaps 2025"
10. "Lidarr what missing compared Sonarr Radarr features parity"
11. "Lidarr API rate limits performance bulk add hundreds artists"
12. "Lidarr duplicate artist album detection deduplication"
13. "Lidarr similar artists recommendation discovery API endpoint"
14. "Overseerr Lidarr music request integration status 2025"
15. "Plex music ratings sync external tool export import"
16. "arr ecosystem CLI tools Python TypeScript manage artists programmatic"
17. "Lidarr quality profile management API programmatic change difficult"
18. "Lidarr metadata matching accuracy wrong artist album mismatch problems"
19. "TypeScript npm Lidarr API client library wrapper package"
20. "Lidarr unmonitoring albums artists bulk API automation workflow"
21. "Lidarr metadata API self-hosted broken dependency MusicBrainz 2025"
22. "beets lidarr integration bridge gap between tools"
23. "Lidarr delete artist album API endpoint behavior cascade files"
24. "music library management CLI tool self-hosted gap nobody built"
25. "Lidarr OpenAPI swagger specification generate client SDK"
26. "Lidarr GitHub feature request won't fix rejected community frustration"
27. "Lidarr v2 development roadmap future plans API changes"
28. "starr library golang TypeScript Lidarr API wrapper incomplete methods"
29. "npm lidarr sonarr radarr api client typescript javascript"
30. "Lidarr custom format management API automate score profiles"
31. "Lidarr import list limitations Spotify Last.fm problems 2025"
32. "Lidarr music collection management pain points Reddit self-hosted 2024 2025"
33. "Lidarr wanted album track search not working properly release matching"
34. "Lidarr Sonarr Radarr mobile app Downloadarr Managarr music support"
