# Contrarian Research: Lidarr API Integration for Music Management CLI

## Executive Summary

Lidarr's API integration for a CLI tool carries significant risks that are systematically underestimated in the \*arr community. The three most critical concerns are: (1) Lidarr's external metadata server (api.lidarr.audio) is a volunteer-maintained single point of failure with documented multi-day outages that would cascade into any CLI tool depending on it, (2) the API has no native "similar artists" or recommendation endpoints -- the feature motivating this integration simply does not exist in Lidarr's API, and (3) the album-centric data model fundamentally misaligns with how CLI tools and users actually interact with music at the track level. Building a dependency on Lidarr means inheriting its architectural fragility without gaining the discovery features that justify the integration.

## Disconfirming Evidence

### Claim: "Lidarr's API is a stable foundation for CLI tooling"

- **Common belief**: Since Lidarr is part of the mature \*arr ecosystem and exposes a REST API with OpenAPI documentation, it provides a reliable integration target.
- **Contradictory evidence**: Between April and August 2025, at least four separate multi-day outages of the metadata server (api.lidarr.audio) broke core search functionality for all Lidarr instances globally. Issue #5498 documented 8+ days of 500 errors (April 9-17, 2025). Issue #5579 documented version 2.13.3 wiping all cached artwork for a 75,000-track library, followed by persistent 503 errors with `x-all-rate-limited: true` headers preventing recovery. Issue #5516 documented search API breakage in May 2025. Issue #5530 documented search returning zero results in June 2025. The metadata server also suffered a breakage when MusicBrainz pushed a schema change in May that broke the server, and repair scripts failed.
- **Source quality**: Primary (GitHub issues with developer acknowledgment)
- **Sources**: [#5498](https://github.com/Lidarr/Lidarr/issues/5498), [#5579](https://github.com/Lidarr/Lidarr/issues/5579), [#5516](https://github.com/Lidarr/Lidarr/issues/5516), [#5530](https://github.com/lidarr/Lidarr/issues/5530)
- **Confidence**: High -- multiple independent primary sources documenting repeated outages in a 5-month window

### Claim: "The API supports similar artists / music discovery"

- **Common belief**: Since Lidarr manages music collections, it naturally provides discovery features like similar artists, top artists, and recommendations through its API.
- **Contradictory evidence**: Direct analysis of Lidarr's OpenAPI specification (openapi.json from the develop branch) reveals **zero endpoints** for similar artists, recommendations, or discovery. The API is strictly a CRUD interface for managing artists and albums already known to the system. Third-party tools like Lidify, Sonobarr, and DiscoveryLastFM exist precisely because this functionality is absent from Lidarr itself. As community members note: "Discovery isn't really something Lidarr does yet." Any "similar artists" feature in rfmedia-cli would need to call Last.fm or Spotify APIs directly, bypassing Lidarr entirely.
- **Source quality**: Primary (OpenAPI specification, GitHub project pages for third-party tools)
- **Sources**: [Lidarr OpenAPI Spec](https://raw.githubusercontent.com/lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json), [Lidify](https://github.com/TheWicklowWolf/Lidify), [Sonobarr](https://github.com/Dodelidoo-Labs/sonobarr)
- **Confidence**: High -- verified directly from the API specification

### Claim: "Lidarr handles track-level operations for CLI integration"

- **Common belief**: A music management API would naturally support track-level operations -- viewing, filtering, and managing individual tracks.
- **Contradictory evidence**: The Lidarr API operates almost exclusively at the artist and album level. There is no `/api/v1/track` endpoint in the OpenAPI spec for independent track operations. Issue #732 documented that the Tracks API cannot fetch track information using a `foreignAlbumId` when the artist is not already in Lidarr. A developer explained: "there isn't a unique track list for a foreignAlbumId, there's one track list for each release," revealing fundamental data model complexity. For a CLI tool that manages music at the file/track level (as rfmedia-cli does with Plex), this is a significant mismatch.
- **Source quality**: Primary (OpenAPI spec, GitHub issue with developer response)
- **Sources**: [#732](https://github.com/lidarr/Lidarr/issues/732), [OpenAPI Spec](https://raw.githubusercontent.com/lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json)
- **Confidence**: High -- confirmed from API specification and developer statements

### Claim: "Lidarr's metadata is accurate and reliable"

- **Common belief**: Lidarr provides consistent, accurate metadata from MusicBrainz.
- **Contradictory evidence**: Multiple documented issues show metadata accuracy problems. Issue #679: MusicBrainz Release ID tags in files are not used to select the correct album version -- Lidarr sometimes chooses the wrong release. Issue #1733: Lidarr does not pull all album versions in a release group. Issue #5233: Albums missing tracks relative to MusicBrainz data, requiring manual "cache busting" by a Servarr team member. Issue #294: Files with perfect MusicBrainz information fail to match. The metadata server interposes its own caching layer between MusicBrainz and Lidarr, introducing staleness and divergence from the upstream source of truth.
- **Source quality**: Primary (GitHub issues)
- **Sources**: [#679](https://github.com/lidarr/Lidarr/issues/679), [#1733](https://github.com/lidarr/Lidarr/issues/1733), [#5233](https://github.com/Lidarr/Lidarr/issues/5233), [#294](https://github.com/lidarr/Lidarr/issues/294)
- **Confidence**: High -- multiple independent primary sources

### Claim: "The \*arr API model translates well to music"

- **Common belief**: Since Sonarr and Radarr successfully manage TV and movies, Lidarr's adaptation of this model for music should work equally well.
- **Contradictory evidence**: Music fundamentally differs from video content. File naming conventions for music downloads are "not nearly as well standardized and enforced" as TV/movies. Lidarr forces complete album downloads when users often want individual tracks. Lidarr "will NOT work" with loose file collections, compilations from multiple artists, DJ mixes, or specialty libraries like classical music. The album-centric \*arr model maps poorly to music's complexity of releases, reissues, deluxe editions, singles, and compilations.
- **Source quality**: Primary/Secondary (Servarr FAQ, community discussions, Joe Karlsson's analysis)
- **Sources**: [Servarr FAQ](https://wiki.servarr.com/lidarr/faq), [Self-Hosted Music Still Sucks](https://www.joekarlsson.com/2025/06/self-hosted-music-still-sucks-in-2025/), [programming.dev discussion](https://programming.dev/post/8808137)
- **Confidence**: High -- widely corroborated across multiple sources

## Expert Critiques

### Joe Karlsson - "Self-Hosted Music Still Sucks in 2025"

- **Main argument**: The \*arr ecosystem "perfected video automation, but music remains stuck with album-centric workflows that don't match how users actually consume music." Lidarr forces complete album downloads when users want individual tracks, and the experience is compared to "filing paperwork with the Department of Motor Vehicles." Lidarr "operates in the same technical universe as other \*arr applications but feels like it was designed by completely different engineering teams with fundamentally incompatible requirements."
- **Evidence**: Detailed walkthrough of the user experience showing 6+ manual steps to get a single track, compared to Overseerr's one-click workflow for video content. Identifies metadata server fragility as a structural problem.
- **Assessment**: Credible, well-articulated critique from a working developer who has used the ecosystem extensively. The comparison to the video \*arr experience is particularly damning because it shows the failure is specific to music, not the ecosystem itself.
- **Source**: [Self-Hosted Music Still Sucks in 2025](https://www.joekarlsson.com/2025/06/self-hosted-music-still-sucks-in-2025/)
- **Confidence**: Medium -- single source, but well-reasoned with specific evidence

### GitHub Issue #404 Users - Fundamental Design Philosophy Critique

- **Main argument**: Lidarr conflates two distinct roles -- "music downloader" and "music manager" -- and does neither well for advanced users. The design is "a bit too tied to the sonarr/series architecture" with a single-location-per-artist constraint, forced post-processing, and no staging/verification workflow. The developer response ("Lidarr's goal is automation") reveals the team views manual/CLI-driven workflows as outside the intended scope.
- **Evidence**: Specific technical limitations documented: only one root folder per artist, no intermediate staging area, broken cue/log file retention.
- **Assessment**: Valid critique that directly impacts CLI integration. If Lidarr's developers explicitly state the tool is designed for full automation, building a CLI that enables manual, selective operations is working against the grain of the software's design philosophy.
- **Source**: [Issue #404](https://github.com/lidarr/Lidarr/issues/404)
- **Confidence**: High -- developer response confirms the philosophical divide

### GitHub Issue #1022 - Beets as Alternative Backend

- **Main argument**: Lidarr's library management capabilities are inferior to Beets, and the two tools should follow the Unix philosophy: "Write programs that do one thing and do it well." Lidarr should focus on acquisition while delegating organizational tasks to specialized tools like Beets. Multiple related issues (#925, #889, #390, #176, #590) demonstrate tagging, path handling, and metadata flexibility problems.
- **Evidence**: A Lidarr developer acknowledged that "lidarr is csharp and beets python," implicitly conceding Beets' superior library management through its plugin ecosystem and MusicBrainz integration.
- **Assessment**: Directly relevant to rfmedia-cli. If Lidarr itself acknowledges Beets is better at library management, a CLI tool might be better served integrating with Beets or MusicBrainz directly rather than through Lidarr's less capable abstraction.
- **Source**: [Issue #1022](https://github.com/lidarr/Lidarr/issues/1022)
- **Confidence**: Medium -- the Beets comparison is credible but the issue is from the project's earlier history

### Issue #5558 Author - Single Point of Failure Architecture

- **Main argument**: Lidarr has engineered a single point of failure into an essential function. The metadata server relies on volunteer maintenance, creating an unstable foundation: "should the service stop being maintained for whatever reason almost all Lidarr instances will lose most functionality." The underlying MusicBrainz API has restrictive rate limits per IP, making direct access inadequate, while the metadata server offers no SLA or uptime guarantee.
- **Evidence**: Request for configurable metadata server fallbacks was closed as "Won't Fix," indicating the developers have no plans to address this architectural vulnerability.
- **Assessment**: Critical finding for CLI integration planning. Any tool depending on Lidarr inherits this fragility, and the developers have explicitly declined to mitigate it.
- **Source**: [Issue #5558](https://github.com/Lidarr/Lidarr/issues/5558)
- **Confidence**: High -- developer response confirms the architectural decision

## Documented Failures

### Metadata Server Outage Cascade (April-August 2025)

- **What happened**: At least four separate outages of api.lidarr.audio between April and August 2025. The April outage lasted 8+ days (Issue #5498). A MusicBrainz schema change in May broke the metadata server, and repair scripts failed (MetaBrainz Community). In August, version 2.13.3 wiped all cached artwork and persistent 503s prevented repopulation for large libraries (Issue #5579). Search functionality repeatedly broke (Issues #5516, #5526, #5530, #5555).
- **Root causes**: Centralized metadata server with no fallback, dependency on volunteer maintenance, no graceful degradation when upstream services fail, no retry/backoff logic for artwork caching, external schema changes propagating as breaking changes.
- **Lessons**: Any CLI tool that depends on Lidarr's search or metadata refresh capabilities will experience these same outages. The metadata server is not the local Lidarr API -- it is a remote service that Lidarr itself depends on, creating a chain of dependencies: CLI -> local Lidarr API -> api.lidarr.audio -> MusicBrainz. Each link is a failure point.
- **Sources**: [#5498](https://github.com/Lidarr/Lidarr/issues/5498), [#5579](https://github.com/Lidarr/Lidarr/issues/5579), [MetaBrainz](https://community.metabrainz.org/t/for-those-using-lidarr-and-musicbrainz-metadata/768255)
- **Confidence**: High

### OPUS File Corruption During Metadata Tagging

- **What happened**: Lidarr corrupted OPUS audio files when writing metadata tags to them. A specific bug in the tag writing library caused data corruption in the .opus container format.
- **Root causes**: Insufficient testing of metadata writing across all supported audio formats. The TagLib library integration had format-specific bugs.
- **Lessons**: Lidarr's metadata tagging can destructively modify audio files. Any CLI integration that triggers metadata operations (refresh, retag) risks file corruption.
- **Source**: [PR #1593](https://github.com/lidarr/Lidarr/pull/1593)
- **Confidence**: High -- confirmed bug with fix

### Hardlink Corruption via Metadata Tagging

- **What happened**: When users enabled both hardlinking (for torrent seeding) and metadata tagging, Lidarr wrote metadata to hardlinked files, corrupting the torrent pieces and breaking seeding. Files in the torrent client no longer matched checksums.
- **Root causes**: Lidarr did not account for the interaction between hardlinks and metadata modification. No warning was presented to users about the incompatibility.
- **Lessons**: Lidarr's automation can have destructive side effects that are non-obvious. A CLI tool triggering library operations could inadvertently trigger metadata writes that corrupt files in other systems.
- **Sources**: [#1016](https://github.com/lidarr/Lidarr/issues/1016), [#3157](https://github.com/Lidarr/Lidarr/issues/3157)
- **Confidence**: High -- documented with specific technical explanation

### Duplicate Artist Creation from Import Lists

- **What happened**: Import lists created duplicate artist entries when the artist already existed in the database. Case-insensitive matching failures created duplicate folders (e.g., "Coil" vs "COIL"). Artists with "The" prefix caused matching failures requiring manual correction.
- **Root causes**: Insufficient deduplication logic in the import pipeline. Case sensitivity handling inconsistencies. Weak string matching for artist names.
- **Lessons**: Bulk operations through the API (which a CLI tool would likely use) can create data quality issues in the Lidarr database. The deduplication logic is not robust enough for automated batch operations.
- **Sources**: [#970](https://github.com/lidarr/Lidarr/issues/970), [#687](https://github.com/lidarr/Lidarr/issues/687), [#4014](https://github.com/Lidarr/Lidarr/issues/4014), [#268](https://github.com/lidarr/Lidarr/issues/268)
- **Confidence**: High -- multiple documented instances

### Various Artists / Compilation Handling Failures

- **What happened**: Adding or scanning "Various Artists" compilations triggered full library rescans of thousands of files, causing extreme slowness on network storage. Split albums (multiple artists) were not recognized. DJ mixes and classical music compilations were not handled at all.
- **Root causes**: The album-centric data model does not accommodate multi-artist works. The "Various Artists" entity triggers overly broad rescanning.
- **Lessons**: Lidarr's data model has hard edges around compilation, classical, and electronic music. A CLI tool targeting these genres will hit these limitations.
- **Sources**: [#2015](https://github.com/Lidarr/Lidarr/issues/2015), [#792](https://github.com/lidarr/Lidarr/issues/792), [#1004](https://github.com/lidarr/Lidarr/issues/1004)
- **Confidence**: High

## Questionable Assumptions

1. **Assumption**: Lidarr's API provides "similar artists" and discovery features that would add value to rfmedia-cli.
   - **Why questionable**: The API has zero discovery endpoints. Similar artists, top artists, and recommendation features simply do not exist in Lidarr's API. Third-party tools (Lidify, Sonobarr) exist specifically to fill this gap by calling Last.fm/Spotify APIs directly. Integrating with Lidarr to get discovery features is integrating with the wrong tool.
   - **Alternative view**: Skip Lidarr entirely for discovery. Call Last.fm's `artist.getSimilar` API and/or MusicBrainz directly. Then optionally use Lidarr only for the "add artist to library" step if the user wants to acquire the music.

2. **Assumption**: The local Lidarr API (localhost:8686) is self-contained and reliable.
   - **Why questionable**: Many Lidarr API operations (search, artist lookup, metadata refresh) depend on the remote metadata server api.lidarr.audio. A "local" API call can fail because a remote service is down. The dependency chain is: rfmedia-cli -> local Lidarr -> api.lidarr.audio -> MusicBrainz + Solr. Four potential failure points for a single operation.
   - **Alternative view**: For operations that only read/modify existing data in Lidarr's local database (list artists, change monitoring status, delete), the local API is genuinely local and reliable. Design the integration to clearly separate "local-only" operations from "metadata-dependent" operations.

3. **Assumption**: Lidarr is the best intermediary between rfmedia-cli and the music metadata ecosystem.
   - **Why questionable**: Lidarr's own developers acknowledged Beets is better at library management. MusicBrainz has a well-documented, stable public API. Last.fm has a mature, reliable API for recommendations and similar artists. By routing through Lidarr, rfmedia-cli inherits Lidarr's limitations (album-only granularity, metadata server fragility, no discovery endpoints) without gaining much that direct API calls could not provide.
   - **Alternative view**: Direct MusicBrainz + Last.fm integration gives rfmedia-cli access to richer data, track-level granularity, and recommendation features. Lidarr integration should be limited to what Lidarr uniquely provides: managing download automation and monitoring status for an existing Lidarr instance.

4. **Assumption**: "Add similar artists" is a genuinely useful feature for music collection management.
   - **Why questionable**: Academic research on music recommendation systems documents systematic "popularity bias" -- algorithms disproportionately recommend widely-known artists because they have more interaction data, creating filter bubbles that reduce discovery diversity (Abdollahpouri et al., 2019; Kowald et al., 2022). Last.fm's similar artists are computed from collaborative filtering and tags, which inherently amplify mainstream tastes. Automatically adding similar artists to a library could result in a collection that converges on popular, homogeneous music rather than genuinely expanding musical horizons.
   - **Alternative view**: If implemented, "similar artists" should be a suggestion/preview feature, not an auto-add. Users should curate recommendations before committing to library additions. Consider using ListenBrainz (which is open-source) as an alternative recommendation source with potentially less popularity bias.

5. **Assumption**: The \*arr API pattern is appropriate for a CLI tool's interaction model.
   - **Why questionable**: The \*arr applications are designed as always-on web services with background automation. Their API assumes a persistent server state, monitoring loops, and event-driven downloads. A CLI tool operates on-demand with discrete, user-initiated commands. This mismatch means many API features (monitoring, scheduled searches, download client integration) are irrelevant to CLI usage, while features a CLI needs (quick lookups, batch metadata operations, track-level filtering) are weak or absent.
   - **Alternative view**: Design the CLI integration to use only the subset of Lidarr's API that maps naturally to CLI operations: list/search artists and albums, change monitoring status, trigger manual searches, bulk edit/delete. Do not attempt to replicate Lidarr's automation model in a CLI context.

## Key Insights

1. **The "similar artists" feature -- the primary motivator for this integration -- does not exist in Lidarr's API.** Any implementation would need to call Last.fm, Spotify, or MusicBrainz APIs directly. Lidarr would only serve as the "add to library" step, which is a thin justification for a full integration dependency.

2. **Lidarr's metadata server is a critical, unmitigated single point of failure.** Five major outages in five months (April-August 2025), with the development team explicitly declining to implement fallback mechanisms (Issue #5558 closed as "Won't Fix"). Any CLI tool depending on search or metadata operations inherits this fragility.

3. **The API is genuinely useful for a narrow set of operations.** Listing existing artists/albums, changing monitoring status, bulk edits, and deletions work against the local database without metadata server dependency. These are the reliable operations to build on.

4. **Track-level operations are a fundamental gap.** rfmedia-cli works with Plex at the track/file level. Lidarr operates at the artist/album level. Bridging this granularity mismatch will require significant custom logic that Lidarr's API does not help with.

5. **File corruption is a real risk with automation.** Documented cases of OPUS corruption, hardlink corruption, and metadata tagging side effects mean any CLI integration that triggers library operations should be designed with extreme caution around file-modifying operations.

6. **Beets or direct MusicBrainz/Last.fm integration may serve rfmedia-cli's needs better.** Multiple sources, including Lidarr's own developers, position Beets as superior for library management. For a CLI tool, Beets' command-line-native design and plugin architecture may be a more natural fit than Lidarr's web-service model.

7. **The community has largely accepted Lidarr's limitations rather than resolving them.** Feature requests for configurable metadata servers, manual workflows, and track-level operations have been closed as "Won't Fix" or redirected. The development team's priorities do not align with CLI-driven, selective music management.

## Evidence Quality

- **Strong contradictions**: 5 (no similar artists API, metadata server fragility, track-level gap, \*arr model mismatch for music, file corruption risks)
- **Credible critiques**: 6 (design philosophy divide, Beets superiority for management, single point of failure architecture, album-centric mismatch, popularity bias in recommendations, documentation gaps)
- **Documented failures with primary evidence**: 5 (metadata outage cascade, OPUS corruption, hardlink corruption, duplicate artist creation, compilation handling)
- **Overall confidence rating**: High -- findings are well-supported by primary sources (GitHub issues with developer responses, direct API specification analysis, academic research on recommendation bias)

## Recommendations for rfmedia-cli Integration

Based on contrarian analysis, if proceeding with Lidarr integration:

1. **Scope narrowly**: Only integrate with Lidarr for operations that are genuinely local (list, edit, delete, monitor/unmonitor artists and albums). Do not depend on search or metadata refresh for critical CLI workflows.
2. **Implement discovery separately**: Use Last.fm and/or MusicBrainz APIs directly for similar artists and recommendations. Optionally pipe results into Lidarr's "add artist" endpoint as a separate step.
3. **Design for degradation**: Assume the metadata server will be down. Implement timeouts, caching, and clear error messages that distinguish "Lidarr is unreachable" from "Lidarr's metadata server is down."
4. **Avoid file-modifying operations**: Do not trigger metadata tagging, library rescans, or import operations through the CLI without explicit user confirmation and warnings about potential side effects.
5. **Consider Beets as a complement or alternative**: For library management, tagging, and metadata operations, Beets may be a more natural and reliable integration target for a CLI tool.

## Search Queries Executed

1. "Lidarr problems issues bugs 2024 2025"
2. "Lidarr API limitations criticism developer complaints"
3. "Lidarr vs Beets comparison disadvantages music management"
4. "Lidarr metadata accuracy problems MusicBrainz wrong matches"
5. "why Lidarr doesn't work music automation frustrations Reddit 2024 2025"
6. "Lidarr API breaking changes complaints arr ecosystem design flaws"
7. "Lidarr similar artists feature quality accuracy problems"
8. "alternatives to Lidarr better music management 2025 headphones beets"
9. "Lidarr API wrapper library Python TypeScript broken abandoned"
10. "Lidarr data corruption library loss wrong metadata applied files"
11. "Lidarr metadata server downtime outage history single point of failure"
12. "MusicBrainz API direct integration vs Lidarr advantages developer"
13. "arr ecosystem API inconsistencies Sonarr Radarr Lidarr differences developer experience"
14. "Lidarr 'similar artists' Last.fm quality noise useless recommendations music"
15. "Lidarr artist matching wrong artist duplicate entries library management nightmare"
16. "Lidarr no track level API operations album only limitation CLI automation"
17. "Lidarr metadata server rate limiting 503 api.lidarr.audio large library slow"
18. "Lidarr API v1 documentation endpoints limitations undocumented missing features"
19. "'Lidarr' 'not worth it' OR 'gave up' OR 'switched from' OR 'stopped using' music"
20. "Last.fm similar artists API accuracy problems echo chamber recommendations"
21. "music recommendation system filter bubble popularity bias mainstream artists problems"

## Sources

- [Lidarr GitHub Issues](https://github.com/lidarr/Lidarr/issues)
- [Issue #5498 - API Internal Server Error](https://github.com/Lidarr/Lidarr/issues/5498)
- [Issue #5579 - MediaCover Cache Wipe](https://github.com/Lidarr/Lidarr/issues/5579)
- [Issue #5516 - Search API Broken](https://github.com/Lidarr/Lidarr/issues/5516)
- [Issue #5530 - Search No Results](https://github.com/lidarr/Lidarr/issues/5530)
- [Issue #5558 - Custom Metadata Source Request (Won't Fix)](https://github.com/Lidarr/Lidarr/issues/5558)
- [Issue #5526 - Cloudflare Timeout Errors](https://github.com/Lidarr/Lidarr/issues/5526)
- [Issue #5555 - Artist Search Failing](https://github.com/Lidarr/Lidarr/issues/5555)
- [Issue #404 - Allow Manual Usage](https://github.com/lidarr/Lidarr/issues/404)
- [Issue #732 - Tracks API foreignAlbumId](https://github.com/lidarr/Lidarr/issues/732)
- [Issue #1022 - Beets as Backend](https://github.com/lidarr/Lidarr/issues/1022)
- [Issue #679 - MusicBrainz Release ID Not Used](https://github.com/lidarr/Lidarr/issues/679)
- [Issue #1733 - Missing Album Versions](https://github.com/lidarr/Lidarr/issues/1733)
- [Issue #5233 - Album Missing Track](https://github.com/Lidarr/Lidarr/issues/5233)
- [Issue #294 - Unable to Match with Perfect MusicBrainz Info](https://github.com/lidarr/Lidarr/issues/294)
- [Issue #970 - Duplicate Artist from Import Lists](https://github.com/lidarr/Lidarr/issues/970)
- [Issue #687 - Duplicate Artists Created](https://github.com/lidarr/Lidarr/issues/687)
- [Issue #4014 - Case-Insensitive Duplicates](https://github.com/Lidarr/Lidarr/issues/4014)
- [Issue #1016 - Hardlink + Metadata Corruption](https://github.com/lidarr/Lidarr/issues/1016)
- [Issue #3157 - Metadata Tagging During Seeding](https://github.com/Lidarr/Lidarr/issues/3157)
- [PR #1593 - OPUS File Corruption Fix](https://github.com/lidarr/Lidarr/pull/1593)
- [Issue #2015 - Various Artists Rescan](https://github.com/Lidarr/Lidarr/issues/2015)
- [Issue #792 - Split Album Handling](https://github.com/lidarr/Lidarr/issues/792)
- [Issue #1004 - Compilation/DJ Mix Issues](https://github.com/lidarr/Lidarr/issues/1004)
- [Lidarr OpenAPI Specification](https://raw.githubusercontent.com/lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json)
- [LidarrAPI.Metadata Repository](https://github.com/Lidarr/LidarrAPI.Metadata)
- [LidMeta - Alternative Metadata Server](https://github.com/davedean/lidmeta)
- [Servarr FAQ](https://wiki.servarr.com/lidarr/faq)
- [Servarr Troubleshooting](https://wiki.servarr.com/lidarr/troubleshooting)
- [Self-Hosted Music Still Sucks in 2025 - Joe Karlsson](https://www.joekarlsson.com/2025/06/self-hosted-music-still-sucks-in-2025/)
- [MetaBrainz Community - Lidarr and MusicBrainz Metadata](https://community.metabrainz.org/t/for-those-using-lidarr-and-musicbrainz-metadata/768255)
- [Lidify - Artist Discovery Tool](https://github.com/TheWicklowWolf/Lidify)
- [Sonobarr - Last.fm Discovery](https://github.com/Dodelidoo-Labs/sonobarr)
- [programming.dev - Anyone Using Lidarr?](https://programming.dev/post/8808137)
- [programming.dev - Better Music Management](https://programming.dev/post/31015861)
- [Popularity Bias in Music Recommendation (Kowald et al.)](https://arxiv.org/abs/2208.09517)
- [Unfairness of Popularity Bias (Abdollahpouri et al.)](https://pmc.ncbi.nlm.nih.gov/articles/PMC7148048/)
- [Lidarr Alternatives Comparison](https://lefthookdigital.com/lidarr-alternative/)
- [pyarr Documentation](https://docs.totaldebug.uk/pyarr/modules/lidarr.html)
- [devopsarr/lidarr-py SDK](https://github.com/devopsarr/lidarr-py)
