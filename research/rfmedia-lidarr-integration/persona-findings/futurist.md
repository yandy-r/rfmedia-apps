# Futurist Research: Lidarr API Integration for Music Management CLI

## Executive Summary

Lidarr faces an existential infrastructure challenge -- its centralized metadata server
(api.lidarr.audio) broke in May 2025 due to a MusicBrainz schema change and remains under rebuild
with no ETA, while the maintainers have explicitly refused to allow self-hosted metadata
alternatives. Simultaneously, Spotify's November 2024 API restrictions eliminated key music
discovery endpoints (Related Artists, Recommendations, Audio Features), pushing the ecosystem toward
open alternatives like ListenBrainz and Last.fm. For rfmedia-cli, these disruptions create both risk
(Lidarr API instability) and opportunity (bridging gaps that commercial APIs are abandoning and that
Lidarr itself cannot fill).

## Lidarr Roadmap

### Current Version Status: v2.x Complete, v1.0 Still Open

- **What's planned**: Lidarr has two open GitHub milestones. The "2.X" milestone is 100% complete
  (12/12 issues closed). The "v1.0" milestone is 68% complete (10 open, 22 closed) and described as
  "Bug fixes from all betas." The latest stable release is v3.1.0.4875 (November 2024), with the
  most recent pre-release being v3.1.2.4902 (January 2025).
- **Timeline**: No published roadmap or timeline exists for future feature development. The develop
  branch was last updated October 14, 2025.
- **Impact on CLI integration**: The versioning is confusing (milestones labeled v1.0 and 2.X while
  releases are at v3.1.x), suggesting the project's development pace is slower than other \*arr
  applications. This means the current API v1 is likely to remain stable for the foreseeable future,
  which is actually beneficial for CLI integration -- the API surface is unlikely to shift under us.
- **Confidence**: Medium -- based on GitHub milestone data and release history.
- **Sources**:
  [Lidarr Milestones](https://github.com/lidarr/lidarr/milestones?direction=desc&sort=completeness&state=open),
  [Lidarr Releases](https://github.com/lidarr/Lidarr/releases)

### Metadata Server Crisis and Rebuild

- **What's planned**: The Lidarr metadata server (api.lidarr.audio) broke on May 21, 2025, when
  MusicBrainz pushed a schema change. The repair scripts failed. The team is performing a complete
  rebuild of the metadata server. There is no ETA -- developers noted they have "very limited
  personal time."
- **Timeline**: Ongoing since May 2025; no estimated completion date as of late 2025.
- **Impact on CLI integration**: This is the single most important risk factor. Lidarr's search,
  artist lookup, and import features depend entirely on this metadata server. A CLI tool that wraps
  Lidarr's API inherits this fragility. Design should account for graceful degradation when metadata
  is unavailable and consider direct MusicBrainz API integration as a fallback.
- **Confidence**: High -- directly confirmed by Lidarr developers on GitHub and MetaBrainz community
  forums.
- **Sources**: [GitHub Issue #5498](https://github.com/Lidarr/Lidarr/issues/5498),
  [MetaBrainz Forum](https://community.metabrainz.org/t/for-those-using-lidarr-and-musicbrainz-metadata/768255)

### Self-Hosted Metadata: Explicitly Rejected

- **What's planned**: Community requests for self-hosted metadata (Issue #5546) and configurable
  metadata server endpoints (Issue #5558) were both closed as "Won't Fix." Maintainer stated: "no
  plans to allow users to use custom metadata." The metadata code is open source but not intended
  for community hosting.
- **Timeline**: Closed decisively in mid-2025.
- **Impact on CLI integration**: This architectural decision means Lidarr will remain dependent on
  the centralized api.lidarr.audio server. For a CLI integration, this reinforces the need for
  independent metadata capabilities -- perhaps querying MusicBrainz or ListenBrainz directly for
  artist/album lookups rather than relying solely on Lidarr's search.
- **Confidence**: High -- direct developer statements on GitHub.
- **Sources**: [Issue #5546](https://github.com/Lidarr/Lidarr/issues/5546),
  [Issue #5558](https://github.com/Lidarr/Lidarr/issues/5558)

### API v1 Stability and Sonarr Alignment

- **What's planned**: Lidarr currently uses API v1 (`/api/v1/`). Sonarr has moved to v4 with an API
  still labeled v3 but with significant endpoint changes (command endpoints restructured, import
  workflows now two-step). There are no public indications that Lidarr plans to align with Sonarr's
  newer API patterns.
- **Timeline**: Indefinite -- no API v2 work is visible in the repository.
- **Impact on CLI integration**: The API v1 surface is stable and unlikely to change soon. Build
  confidently against it, but design the CLI's Lidarr client layer with abstraction so that if/when
  API v2 arrives, the business logic remains unaffected.
- **Confidence**: Medium -- inferred from codebase activity and ecosystem patterns rather than
  explicit statements.
- **Sources**: [Lidarr GitHub](https://github.com/Lidarr/Lidarr),
  [Sonarr v4 API Changes](https://forums.sonarr.tv/t/need-some-help-with-changes-in-v4-api-commands/33092)

## Emerging \*arr Ecosystem Features

### Configuration-as-Code: Buildarr and praxrr

- **Description**: The \*arr ecosystem is evolving toward declarative configuration management.
  Buildarr uses YAML to define desired state for all \*arr applications and runs idempotently, only
  making changes when needed. praxrr provides a visual GUI alternative to Recyclarr's CLI-based
  TRaSH Guides synchronization. The trend is moving from "manually configure each app" toward
  "define once, apply everywhere."
- **Relevance**: This pattern is directly analogous to what rfmedia-cli could provide for Lidarr --
  a CLI-driven way to declare desired library state (artists, albums, quality profiles) and converge
  toward it. The plan/apply pattern already used in rfapps-cli for Docker services maps naturally
  onto this.
- **Confidence**: High -- multiple active projects demonstrating this pattern.
- **Sources**: [Buildarr](https://buildarr.github.io/),
  [praxrr vs Recyclarr](https://corelab.tech/praxrr-vs-trash/)

### Unified API Client Libraries

- **Description**: Python libraries like pyarr and aiopyarr provide unified API clients across
  Sonarr, Radarr, Lidarr, and Readarr, normalizing the differences between each app's API. ArrTools
  provides cross-arr utility scripts. The pattern of "one client, many backends" is solidifying.
- **Relevance**: For rfmedia-cli in TypeScript, building a Lidarr API client that follows the shared
  patterns of the \*arr ecosystem (similar authentication, pagination, command/queue patterns) would
  allow future extension to other \*arr apps if desired.
- **Confidence**: Medium -- libraries exist but are community-maintained, not officially supported.
- **Sources**: [pyarr](https://pypi.org/project/pyarr/),
  [aiopyarr](https://github.com/tkdrob/aiopyarr), [ArrTools](https://github.com/sirk123au/ArrTools)

### Naviseerr: The Convergence Play

- **Description**: Naviseerr is a new project that combines Overseerr (request management),
  Navidrome (streaming), Lidarr (collection management), and Soulseek/Slskd (P2P downloads) into a
  single application. It currently downloads Lidarr's "Wanted" list via Slskd. Version 2.0 plans to
  replace Lidarr entirely with an internal media manager and integrate Navidrome playback tracking
  for personalized recommendations.
- **Relevance**: Naviseerr represents a potential future where Lidarr is bypassed entirely for music
  management. If this project gains traction, CLI tooling might need to support multiple backends.
  However, it is very early stage (matching still inconsistent, developers "still learning"
  frontend).
- **Confidence**: Low -- early alpha project, single developer, may not reach maturity.
- **Sources**: [Naviseerr GitHub](https://github.com/Schaka/naviseerr)

### TheWicklowWolf Music Stack

- **Description**: A curated set of containerized tools that complement Lidarr: Lidify (artist
  discovery via Last.fm), LidaTube (YouTube album downloads), Syncify (Spotify playlist singles via
  yt-dlp), PlaylistDir (auto-generated playlists from directory structure), and SpotTube (direct
  Spotify content). Each tool serves a specific gap in Lidarr's capabilities.
- **Relevance**: This "tool per gap" pattern shows what the community needs from Lidarr that it
  doesn't provide natively. A CLI tool could consolidate several of these functions: similar artist
  discovery, singles management, playlist generation. The fact that these are separate Docker
  containers suggests the community wants these features integrated rather than fragmented.
- **Confidence**: High -- active projects with Docker images and documentation.
- **Sources**: [Full Music Stack](https://thewicklowwolf.github.io/music-stack/),
  [Lidify](https://github.com/TheWicklowWolf/Lidify)

### UX Shift: From CLI to GUI

- **Description**: The broader \*arr ecosystem is trending toward visual interfaces. praxrr replaces
  Recyclarr's YAML with a web dashboard. The self-hosting community is described as "moving away
  from maintaining complex config files and toward 'Set and Forget' dashboards."
- **Relevance**: This does not invalidate CLI tools -- power users and automation pipelines still
  need programmatic interfaces. But it suggests that rfmedia-cli's value proposition should
  emphasize automation, scriptability, and machine-readable output (JSON/YAML/CSV) rather than
  trying to compete with web UIs for casual interaction.
- **Confidence**: Medium -- trend is real but CLI tools remain essential for automation.
- **Sources**: [praxrr vs Recyclarr](https://corelab.tech/praxrr-vs-trash/)

## Music Discovery Future

### Spotify API Restrictions: A Seismic Shift

- **What's emerging**: On November 27, 2024, Spotify restricted access to Related Artists,
  Recommendations, Audio Features, Audio Analysis, and preview URLs for new third-party
  applications. This directly broke tools like Lidify (which previously used Spotify for artist
  discovery) and eliminated the most popular APIs for music recommendation.
- **Potential impact**: The entire music discovery tool ecosystem must now rely on Last.fm and
  ListenBrainz instead. Lidify has already switched to Last.fm-only. Any CLI tool planning to offer
  "similar artists" functionality must use Last.fm or ListenBrainz -- not Spotify.
- **Timeline**: Already in effect. Permanent.
- **Confidence**: High -- confirmed by Spotify, documented by multiple sources.
- **Sources**:
  [Spotify API Restrictions](https://voclr.it/news/why-spotify-has-restricted-its-api-access-what-changed-and-why-it-matters-in-2026/),
  [Spotify Developer Community](https://community.spotify.com/t5/Spotify-for-Developers/spotify-api-Get-Recommendations-alternative/td-p/6540653)

### ListenBrainz as the Open Alternative

- **What's emerging**: ListenBrainz (by the MetaBrainz Foundation, the same organization behind
  MusicBrainz) is building open replacements for deprecated Spotify endpoints. Currently available:
  artist similarity, user recommendations, custom playlist generation (LB Radio), popularity
  metrics, and fresh release discovery. Planned: track similarity and album similarity datasets. All
  data is Creative Commons CC0 licensed and available via API for free, permanently.
- **Potential impact**: ListenBrainz could become the primary discovery engine for self-hosted music
  tools. Its open licensing means rfmedia-cli could integrate it without legal or access concerns.
  However, data is "nowhere near as comprehensive as Spotify."
- **Timeline**: Artist similarity available now; track/album similarity in development (no specific
  date).
- **Confidence**: Medium -- API exists and is functional, but dataset completeness is limited.
- **Sources**: [MetaBrainz Blog](https://blog.metabrainz.org/2024/11/),
  [ListenBrainz](https://listenbrainz.org/)

### Last.fm: The Resilient Default

- **What's emerging**: With Spotify's API restrictions, Last.fm has become the de facto standard for
  music recommendation in the self-hosted ecosystem. Lidify uses it exclusively. Last.fm's similar
  artists data is based on decades of user listening data (scrobbles) and remains freely accessible.
- **Potential impact**: Last.fm API integration should be considered a first-class feature for any
  music discovery CLI. Its longevity and open access make it the lowest-risk choice for similar
  artists functionality.
- **Timeline**: Available now; stable for the foreseeable future.
- **Confidence**: High -- proven, stable, widely adopted.
- **Sources**: [Lidify GitHub](https://github.com/TheWicklowWolf/Lidify)

### MusicBrainz Evolution

- **What's emerging**: MusicBrainz's 2025 Summer of Code projects focus on search engine
  optimization (removing redundant XML storage, improving Solr efficiency), Cover Art/Event Art
  metadata integrity, and API template improvements. The existing JavaScript/TypeScript MusicBrainz
  API client (musicbrainz-api) provides programmatic access to the database.
- **Potential impact**: Improved search performance benefits Lidarr and any tool that queries
  MusicBrainz. The TypeScript client is directly usable by rfmedia-cli for independent metadata
  lookups.
- **Timeline**: 2025 Summer of Code projects; incremental improvements.
- **Confidence**: Medium -- projects are planned but completion depends on volunteer effort.
- **Sources**:
  [MusicBrainz SoC 2025](https://wiki.musicbrainz.org/Development/Summer_of_Code/2025/MusicBrainz),
  [musicbrainz-api](https://github.com/Borewit/musicbrainz-api)

### Plex Sonic Analysis and AI

- **What's emerging**: Plex's Sonic Analysis uses a neural network to extract approximately 50
  parameters from music files, enabling sonically similar artist/album/track discovery, Track Radio,
  and AI-generated mixes. Sonic Sage integrates ChatGPT for natural language playlist creation.
  These are premium features requiring Plex Pass.
- **Potential impact**: Plex already has sophisticated music analysis that Lidarr lacks entirely. A
  CLI tool that bridges Plex's sonic data with Lidarr's collection management could create unique
  value -- for example, finding sonically similar artists in Plex and adding them to Lidarr, or
  using Plex's analysis to inform quality/priority decisions.
- **Timeline**: Available now; continued investment by Plex team.
- **Confidence**: High -- shipping product with active development.
- **Sources**: [Plex Sonic Analysis](https://support.plex.tv/articles/sonic-analysis-music/),
  [Plexamp Sonic Sage](https://www.prnewswire.com/news-releases/plexamp-adds-sonic-sage-chatgpt-based-feature-for-creating-incredible-playlists-301814850.html)

### AI-Powered Metadata Management

- **What's emerging**: AI systems are being used to tag, sort, and organize music "faster and more
  accurately" than manual processes, processing acoustic and emotional features to apply descriptive
  tags at depth impossible for humans. Tools like Algonaut Atlas 2 use AI to organize sample
  libraries by analyzing and categorizing content automatically.
- **Potential impact**: Future music management CLIs could leverage local AI models (running on the
  same Docker host) to enhance metadata quality, auto-tag untagged files, or resolve MusicBrainz
  matching ambiguities. This is speculative for self-hosted tools but clearly the direction
  commercial tools are heading.
- **Timeline**: 2-3 years for practical self-hosted implementations.
- **Confidence**: Low -- commercial products exist but self-hosted open-source equivalents are
  nascent.
- **Sources**: [AI Metadata Management](https://www.reprtoir.com/blog/ai-metadata-management),
  [Billboard AI Music Companies](https://www.billboard.com/lists/top-ai-music-companies-2026-future-music/)

## CLI Tool Evolution

### TypeScript 7 Native Compilation

- **What's emerging**: Microsoft is rewriting the TypeScript compiler in Go (TypeScript 7),
  delivering major speed improvements. Node.js now supports TypeScript natively without requiring
  tsc. TypeScript surpassed both Python and JavaScript to become the most-used language on GitHub in
  August 2025.
- **Potential impact**: rfmedia-cli benefits from the broader TypeScript ecosystem's growth. Faster
  compilation improves development experience. Native Node.js TypeScript support could simplify the
  build pipeline in the future.
- **Timeline**: TypeScript 7 is already available in preview; native Node.js TypeScript support is
  shipping.
- **Confidence**: High -- confirmed by Microsoft and Node.js teams.
- **Sources**: [Effective TypeScript](https://effectivetypescript.com/2025/12/19/ts-2025/),
  [Visual Studio Magazine](https://visualstudiomagazine.com/articles/2025/12/02/microsoft-gets-real-on-native-typescript-remake.aspx)

### Modern CLI Framework Patterns

- **What's emerging**: New CLI frameworks like Optique emphasize compose-based parsing with full
  type inference, discriminated unions for mutually exclusive options, cross-runtime support
  (Node.js, Deno, Bun), and built-in shell completion. The pattern is "express constraints in ways
  TypeScript understands" -- catching mistakes at compile time.
- **Potential impact**: rfmedia-cli already uses Commander.js and follows the command/action
  separation pattern. New frameworks like Optique suggest the ecosystem is converging on patterns
  rfmedia-cli already implements (discriminated unions, strict typing). No urgent migration needed,
  but worth watching for ergonomic improvements.
- **Timeline**: Available now.
- **Confidence**: Medium -- emerging tools, not yet mainstream.
- **Sources**:
  [Building CLI apps with TypeScript in 2026](https://hackers.pub/@hongminhee/2026/typescript-cli-2026)

### Beets: The Python Predecessor

- **What's emerging**: Beets (Python-based music library manager) continues active development with
  v2.5.1 (February 2026). Recent changes include architectural improvements to the plugin system
  with simplified metadata source registration and automated distance calculation. Beets represents
  the gold standard for CLI music management.
- **Potential impact**: Beets' plugin architecture is a model worth studying. rfmedia-cli could
  potentially interoperate with Beets (importing/exporting data) or adopt similar patterns for
  extensibility. Beets' approach to MusicBrainz matching, auto-tagging, and library queries is
  well-proven.
- **Timeline**: Ongoing.
- **Confidence**: High -- actively maintained, well-documented, widely used.
- **Sources**: [Beets GitHub](https://github.com/beetbox/beets),
  [Beets PyPI](https://pypi.org/project/beets/)

## Future Scenarios

### Scenario 1: Lidarr Stabilizes with Rebuilt Metadata Server (Optimistic)

- **Description**: The Lidarr team successfully rebuilds the metadata server, possibly with improved
  caching and resilience. Development pace picks up with the v1.0 milestone completion. API v1
  remains stable. Lidarr solidifies as the standard music collection manager in the \*arr ecosystem.
- **Probability**: Moderate (50-60%). The team has demonstrated ability to recover from past
  outages, but limited developer time is a real constraint.
- **Implications**: rfmedia-cli Lidarr integration becomes straightforward and reliable. Focus on
  wrapping API v1 endpoints with good error handling and retry logic. The CLI adds value through
  automation, bulk operations, and bridging with Plex.

### Scenario 2: Lidarr Metadata Continues to Be Fragile (Realistic)

- **Description**: The metadata server is rebuilt but remains a single point of failure. Periodic
  outages continue. The community increasingly builds workarounds. Tools like Naviseerr and Lidify
  provide alternative paths for specific workflows.
- **Probability**: High (60-70%). This reflects the current trajectory.
- **Implications**: rfmedia-cli should implement direct MusicBrainz and ListenBrainz API integration
  as fallbacks. Design the CLI to be resilient when Lidarr's metadata service is unavailable.
  Consider caching artist/album metadata locally.

### Scenario 3: Lidarr Is Gradually Replaced by Converged Tools (Long-term)

- **Description**: Projects like Naviseerr mature and offer integrated music management without
  Lidarr's dependency on a centralized metadata server. Navidrome gains automation capabilities. The
  community fragments across multiple smaller tools rather than one dominant application.
- **Probability**: Low-moderate (20-30%) within 2 years; higher over 5 years.
- **Implications**: rfmedia-cli should abstract its backend layer so it can work with multiple music
  management systems. An interface-based design (e.g., `MusicManager` interface with `LidarrManager`
  implementation) allows swapping backends without rewriting business logic.

### Scenario 4: AI-Enhanced Self-Hosted Music Management

- **Description**: Local AI models (running as Docker containers alongside the media stack) provide
  music analysis, auto-tagging, smart recommendations, and natural language library queries. Plex's
  Sonic Analysis approach is replicated in open-source tools. ListenBrainz's recommendation engine
  matures.
- **Probability**: Low-moderate (25-35%) within 2 years.
- **Implications**: rfmedia-cli could integrate with local AI services via their APIs, offering
  commands like `rfmedia recommend --based-on-artist "Artist Name"` or
  `rfmedia auto-tag --unmatched`. This is a future extension point, not a near-term priority.

### Scenario 5: Streaming/Ownership Rebalance

- **Description**: Growing dissatisfaction with streaming services (price increases, content
  removal, AI concerns) accelerates the move to self-hosted music. The self-hosted music stack
  becomes as mature as the video stack (Sonarr/Radarr/Plex). Music-specific request management (like
  Overseerr for movies) becomes standard.
- **Probability**: Moderate (40-50%) as a trend over 2-3 years.
- **Implications**: Growing user base for tools like rfmedia-cli. More emphasis on onboarding
  experience, documentation, and "set and forget" workflows. The CLI should support both power-user
  automation and simpler "add this artist and get everything" workflows.

## Expert Predictions

### The Metadata Server Problem Is Structural

- **Prediction**: Lidarr's refusal to support self-hosted metadata, combined with the reliance on
  volunteer-maintained infrastructure, creates a fundamental fragility that will either be resolved
  through a governance change or by the community routing around the problem entirely.
- **Evidence**: Two separate GitHub issues (#5546, #5558) requesting self-hosted metadata were
  rejected. The May 2025 outage had no workaround. Alternative metadata servers exist
  (davedean/lidmeta) but are not officially supported.
- **Source**: [Issue #5546](https://github.com/Lidarr/Lidarr/issues/5546),
  [Issue #5558](https://github.com/Lidarr/Lidarr/issues/5558),
  [lidmeta](https://github.com/davedean/lidmeta)

### ListenBrainz Will Become the Default Music Discovery API

- **Prediction**: With Spotify's API restrictions permanent and Last.fm aging, ListenBrainz's open,
  CC0-licensed datasets will become the default for self-hosted music discovery tools. Their planned
  track and album similarity datasets will fill the remaining gaps.
- **Evidence**: ListenBrainz explicitly positioned itself as a Spotify API replacement. All data is
  free and open. The MetaBrainz Foundation provides long-term institutional backing.
- **Source**: [MetaBrainz Blog](https://blog.metabrainz.org/2024/11/),
  [ListenBrainz](https://listenbrainz.org/)

### The "Tool Per Gap" Pattern Will Consolidate

- **Prediction**: The current proliferation of single-purpose tools (Lidify, LidaTube, Syncify,
  PlaylistDir, SpotTube) will consolidate into fewer, more capable tools -- either Naviseerr-style
  convergence projects or CLI tools that provide multiple capabilities through subcommands.
- **Evidence**: TheWicklowWolf's music stack requires 5+ separate Docker containers for a complete
  workflow. Users consistently express desire for simpler setups.
- **Source**: [Full Music Stack](https://thewicklowwolf.github.io/music-stack/),
  [Naviseerr](https://github.com/Schaka/naviseerr)

### Self-Hosted Music Will Remain Harder Than Video

- **Prediction**: Music management is fundamentally more complex than video (singles vs. albums,
  metadata complexity, no equivalent of TVDB/TMDB simplicity, tracks vs. releases vs. recordings in
  MusicBrainz). Self-hosted music will continue to lag behind the video \*arr stack in maturity.
- **Evidence**: "Self-Hosted Music Still Sucks in 2025" was a widely discussed critique. Lidarr's
  album-centric workflow conflicts with how users actually consume music (playlists, singles).
  MusicBrainz data model complexity exceeds TVDB/TMDB.
- **Source**:
  [Self-Hosted Music Still Sucks](https://www.joekarlsson.com/2025/06/self-hosted-music-still-sucks-in-2025/)

## Key Insights

1. **Build for resilience, not just integration**: Lidarr's metadata server fragility is the top
   risk. rfmedia-cli should implement fallback paths (direct MusicBrainz queries, local caching)
   rather than depending solely on Lidarr's search/lookup capabilities. Treat Lidarr as a collection
   manager, not a metadata authority.

2. **Last.fm and ListenBrainz are the future of music discovery APIs**: With Spotify's API locked
   down, similar artist discovery must use Last.fm (stable, available now) and/or ListenBrainz
   (open, growing, CC0 licensed). rfmedia-cli should integrate both -- Last.fm for immediate
   functionality, ListenBrainz for long-term alignment with the open-source ecosystem.

3. **The consolidation opportunity is real**: The community uses 5+ separate Docker containers
   (Lidify, LidaTube, Syncify, etc.) to fill gaps in Lidarr's capabilities. A CLI tool that
   consolidates artist discovery, bulk management, and Plex bridging into a single interface
   addresses a genuine pain point.

4. **Plex-Lidarr bridging is an underserved niche**: Plex's Sonic Analysis generates rich music
   metadata that Lidarr knows nothing about, and Lidarr manages collections that Plex cannot modify.
   A CLI that bridges these two systems (e.g., "find sonically similar artists in Plex, check which
   ones aren't in Lidarr, add them") creates unique value that no existing tool provides.

5. **Design for backend abstraction**: The music management landscape is fragmenting (Lidarr,
   Naviseerr, direct MusicBrainz, Beets). Using interface-based design for the music manager backend
   allows rfmedia-cli to support multiple systems without rewriting core logic.

6. **API v1 stability is a feature**: Lidarr's slow development pace means the API is unlikely to
   break. Build confidently against v1, but abstract the client layer for future-proofing.

7. **TypeScript ecosystem momentum validates the technology choice**: TypeScript becoming the
   most-used language on GitHub, native Node.js support, and improved tooling all reinforce that
   building rfmedia-cli in TypeScript is strategically sound.

## Evidence Quality

- **Overall Confidence**: Medium
- **Strong evidence areas**: Lidarr metadata server issues (direct developer statements), Spotify
  API restrictions (documented by Spotify), \*arr ecosystem tool landscape (active GitHub projects
  with recent commits), Plex Sonic Analysis (shipping product)
- **Weak evidence areas**: Lidarr roadmap (no public roadmap exists), AI music curation timeline
  (speculative), Naviseerr viability (early alpha), ListenBrainz dataset completeness (acknowledged
  as limited by developers)
- **Key uncertainty**: Whether Lidarr's metadata server rebuild will succeed and maintain stability
  long-term. This is the single most impactful unknown for the integration.

## Temporal Freshness Assessment

- Most findings are based on 2024-2026 sources (within freshness window for fast-moving topics)
- Lidarr metadata outage data is from May-June 2025 (current and relevant)
- Spotify API restriction data is from November 2024 (permanent change, fully relevant)
- ListenBrainz replacement API data is from November 2024 (may have evolved since)
- TypeScript ecosystem data is from late 2025/early 2026 (current)

## Search Queries Executed

1. "Lidarr roadmap future features 2025 2026 development plans"
2. "Lidarr GitHub issues feature requests planned API changes"
3. "arr ecosystem future development roadmap Prowlarr Recyclarr 2025 2026"
4. "music management automation AI future self-hosted 2025 2026"
5. "Lidarr API v2 development self-hosted metadata server changes"
6. "MusicBrainz API future improvements 2025 2026 metadata"
7. "TypeScript CLI tools future patterns 2025 2026 frameworks emerging"
8. "naviseerr Lidarr alternative music management self-hosted"
9. "Lidarr v2 Sonarr v4 API alignment arr ecosystem unified API"
10. "self-hosted music streaming ownership future Plex Navidrome 2026"
11. "Spotify similar artists API music discovery recommendation engine open source"
12. "Lidarr Plex integration bridge sync ratings library management"
13. "Lidify music discovery Lidarr Spotify LastFM similar artists tool"
14. "Buildarr arr ecosystem configuration management as code future"
15. "Lidarr metadata server reliability outage problems 2025"
16. "ListenBrainz music recommendation open source AI future"
17. "Sonarr v4 API changes new endpoints what changed implications for arr ecosystem"
18. "music stack self hosted Docker 2026 automation workflow Lidarr Navidrome"
19. "Lidarr GitHub recent commits develop branch 2025 2026 new features"
20. "ListenBrainz Spotify API replacement endpoints similar artists music recommendation 2025"
21. "Lidarr metadata server rebuild status 2025 2026 update"
22. "beets music tagger CLI Python future development 2025 2026"
23. "AI music curation recommendation personal library 2026 open source tools"
24. "Plex Sonic Analysis music AI features Plexamp future development"
25. "Docker compose AI orchestration self-hosted media 2026 trends"

## Sources

- [Lidarr GitHub Repository](https://github.com/Lidarr/Lidarr)
- [Lidarr Milestones](https://github.com/lidarr/lidarr/milestones)
- [Lidarr Releases](https://github.com/lidarr/Lidarr/releases)
- [Lidarr Issue #5498 - Metadata Server Outage](https://github.com/Lidarr/Lidarr/issues/5498)
- [Lidarr Issue #5546 - Self-Hosted Metadata](https://github.com/Lidarr/Lidarr/issues/5546)
- [Lidarr Issue #5558 - Custom Metadata Source](https://github.com/Lidarr/Lidarr/issues/5558)
- [LidarrAPI.Metadata Repository](https://github.com/Lidarr/LidarrAPI.Metadata)
- [MetaBrainz Community - Lidarr Metadata](https://community.metabrainz.org/t/for-those-using-lidarr-and-musicbrainz-metadata/768255)
- [MetaBrainz Blog - November 2024](https://blog.metabrainz.org/2024/11/)
- [ListenBrainz](https://listenbrainz.org/)
- [MusicBrainz Summer of Code 2025](https://wiki.musicbrainz.org/Development/Summer_of_Code/2025/MusicBrainz)
- [musicbrainz-api TypeScript Client](https://github.com/Borewit/musicbrainz-api)
- [Spotify API Restrictions - Voclr](https://voclr.it/news/why-spotify-has-restricted-its-api-access-what-changed-and-why-it-matters-in-2026/)
- [Spotify Developer Community](https://community.spotify.com/t5/Spotify-for-Developers/spotify-api-Get-Recommendations-alternative/td-p/6540653)
- [Naviseerr](https://github.com/Schaka/naviseerr)
- [Lidify](https://github.com/TheWicklowWolf/Lidify)
- [TheWicklowWolf Full Music Stack](https://thewicklowwolf.github.io/music-stack/)
- [Buildarr](https://buildarr.github.io/)
- [praxrr vs Recyclarr](https://corelab.tech/praxrr-vs-trash/)
- [pyarr](https://pypi.org/project/pyarr/)
- [lidmeta - Alternative Metadata Server](https://github.com/davedean/lidmeta)
- [Mesharr - Multi-Instance Sync](https://github.com/LimeDrive/mesharr)
- [Overseerr-Lidarr Integration](https://github.com/spwats/Overseerr-Lidarr-Integration)
- [Beets](https://github.com/beetbox/beets)
- [Plex Sonic Analysis](https://support.plex.tv/articles/sonic-analysis-music/)
- [Plexamp Sonic Sage](https://www.prnewswire.com/news-releases/plexamp-adds-sonic-sage-chatgpt-based-feature-for-creating-incredible-playlists-301814850.html)
- [Navidrome vs Jellyfin vs Plexamp Comparison](https://www.lowerhomeserver.vip/blog/use-cases/navidrome-jellyfin-plexamp-music-comparison)
- [Self-Hosted Music Still Sucks in 2025](https://www.joekarlsson.com/2025/06/self-hosted-music-still-sucks-in-2025/)
- [Sonarr v4 API Changes](https://forums.sonarr.tv/t/need-some-help-with-changes-in-v4-api-commands/33092)
- [Effective TypeScript 2025](https://effectivetypescript.com/2025/12/19/ts-2025/)
- [Building CLI Apps with TypeScript in 2026](https://hackers.pub/@hongminhee/2026/typescript-cli-2026)
- [Docker AI Agent](https://www.docker.com/solutions/docker-ai/)
- [Billboard AI Music Companies 2026](https://www.billboard.com/lists/top-ai-music-companies-2026-future-music/)
- [Servarr Status Page](https://status.radarr.video/)
