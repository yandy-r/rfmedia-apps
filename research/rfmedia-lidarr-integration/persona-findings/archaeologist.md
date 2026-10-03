# Archaeological Research: Lidarr API Integration for Music Management CLI

## Executive Summary

The history of music collection automation spans roughly 15 years, from the SickBeard/CouchPotato/Headphones era (2011-2017) through the emergence of the \*arr ecosystem (2017-present). The most valuable insights from the past are: (1) Headphones' API design, particularly its `getSimilar` endpoint and MusicBrainz-centric artist discovery, provides a proven pattern for music discovery CLI features; (2) Beets' plugin architecture demonstrates how modular, composable music management tools succeed long-term; and (3) several abandoned CLI wrapper projects (lidarr-cli in Ruby, pyarr, ArrTools) reveal both the demand for CLI-based Lidarr interaction and the pitfalls that cause such projects to stall. The lidarr-extended project's "related artists" feature with loop-prevention logic is directly applicable to the rfmedia-cli integration design.

## Old Solutions (5-15 Years Ago)

### Headphones (2011-present, mostly legacy)

- **How it worked**: Python-based automated music downloader that integrated with SABnzbd, NZBget, and torrent clients. Used MusicBrainz as its primary metadata source with Last.fm for artist discovery. Operated via a web UI and a comprehensive REST API with commands like `addArtist`, `delArtist`, `getSimilar`, `findArtist`, `queueAlbum`, and `forceSearch`. The API endpoint format was `http://host:port/api?apikey=$key&cmd=$command`.
- **Advantages**: Simple, predictable API with clear command naming. The `getSimilar` endpoint provided similar artist recommendations ranked by relevance. Artist monitoring with pause/resume functionality was intuitive. MusicBrainz integration meant accurate metadata from the start.
- **Modern relevance**: High. The Headphones API command structure (`addArtist`, `delArtist`, `pauseArtist`, `resumeArtist`, `getSimilar`, `queueAlbum`) maps almost directly to what rfmedia-cli would need for Lidarr integration. The separation of "add" vs "queue" (monitoring vs actively searching) is a pattern Lidarr inherited. Headphones' approach of using MusicBrainz IDs as the canonical identifier for artists is the same approach Lidarr uses (foreignArtistId).
- **Source**: [GitHub - rembo10/headphones](https://github.com/rembo10/headphones), [Headphones API Documentation](https://github.com/rembo10/headphones/blob/master/API.md)
- **Confidence**: High (primary source documentation, 3.8k stars, 2,931 commits, still receiving updates as of 2025)

### Beets (2012-present, actively maintained)

- **How it worked**: Command-line music library manager and MusicBrainz auto-tagger written in Python. Designed around a plugin architecture where the core handles library management and plugins extend functionality. Key plugins for discovery include: LastGenre (genre fetching from Last.fm tags), LastImport (play count collection), Spotify (release search and playlist sync), MBSync (updated MusicBrainz metadata), Chroma (acoustic fingerprinting), and the Discogs/Deezer metadata plugins.
- **Advantages**: Extremely modular plugin system. Unix philosophy of composability. Strong MusicBrainz integration. The community discussed but never fully implemented music discovery features, leaving a gap that rfmedia-cli could fill. The Beets community explicitly debated whether discovery should be a core feature or plugin, with the consensus being that cross-service matching (Spotify ID <-> MusicBrainz ID <-> local files) is the hard engineering problem.
- **Modern relevance**: High. Beets' plugin architecture is the gold standard for extensible music CLIs. Its approach of storing multiple service identifiers per track (Spotify ID, Discogs ID, MusicBrainz ID) as separate database fields is directly applicable to bridging Plex and Lidarr metadata. The Beets community's unsolved challenge of "track X on service A is actually the same track as track Y on service B" is exactly the Plex-Lidarr bridge problem.
- **Source**: [Beets official site](https://beets.io/), [Beets plugins documentation](https://beets.readthedocs.io/en/stable/plugins/), [Beets discovery discussion](https://discourse.beets.io/t/improve-music-discovery-aspect-of-beets/1911)
- **Confidence**: High (primary source documentation, active project)

### The SickBeard/CouchPotato/Headphones Automation Stack (2011-2016)

- **How it worked**: A trio of Python applications that automated media downloading via Usenet (SABnzbd) and torrents. SickBeard handled TV, CouchPotato handled movies, and Headphones handled music. All three followed the same pattern: monitor RSS feeds, match against a wanted list, download, post-process (rename, tag, organize), and notify. They shared architectural patterns: web UI, REST API, SQLite database, plugin-style download client support.
- **Advantages**: Proven architecture for media automation. Each app focused on one media type with deep domain knowledge. The pattern of "add to wanted list -> automated search -> download -> post-process -> organize" became the template for the entire \*arr ecosystem. Community guides for setting up the full stack were comprehensive.
- **Modern relevance**: Medium. The architectural patterns live on in the \*arr ecosystem. The key lesson is that music automation requires different handling than TV/movies because of the artist -> album -> track hierarchy vs the show -> season -> episode hierarchy. Headphones' approach of "add artist, then selectively monitor albums" maps directly to Lidarr's model.
- **Source**: [Kodi Forum - Complete setup guide](https://forum.kodi.tv/showthread.php?tid=120406), [Headphones: SickBeard for Music](http://www.totalhtpc.com/headphones-sickbeard-for-music/), [HowToForge - Perfect Media Server](https://www.howtoforge.com/the-perfect-media-server-ubuntu-11.10-sabnzbd-sickbeard-couch-potato-headphones-serviio)
- **Confidence**: High (multiple corroborating sources, historical documentation)

### pylast - Python Last.fm Interface (2008-present)

- **How it worked**: A Python library providing a clean interface to Last.fm's API, including the `artist.getSimilar()` endpoint for finding similar artists. Originally hosted on Google Code, later migrated to GitHub. Provided access to artist metadata, similar artists, top tracks, top albums, and user scrobbling data.
- **Advantages**: Simple, Pythonic API design. Access to Last.fm's massive collaborative filtering dataset for similar artist discovery. Still actively maintained. The `get_similar()` method returns artists ranked by similarity score, which is directly useful for music recommendation workflows.
- **Modern relevance**: High. Last.fm's similar artist data is one of the most reliable recommendation sources available. A modern TypeScript CLI tool could use Last.fm's similar artist API to discover artists, then add them to Lidarr. The DiscoveryLastFM project (see below) proves this workflow works.
- **Source**: [GitHub - pylast/pylast](https://github.com/pylast/pylast), [Google Code Archive - pylast](https://code.google.com/archive/p/pylast)
- **Confidence**: High (primary source, actively maintained)

### musicbrainzngs - Python MusicBrainz API (2011-present)

- **How it worked**: Python bindings for the MusicBrainz Web Service (NGS schema). Evolved through three generations: python-musicbrainz2 (original, MusicBrainz XML API), python-musicbrainz3 (never finished NGS port), and python-musicbrainzngs (working NGS bindings by Alastair Porter). Provides access to artist, release, recording, and work entities with full relationship traversal.
- **Advantages**: Authoritative source for music metadata. Artist relationships (including "similar to" and "influenced by" relationships) are available through the `artist-rels` include parameter. Bulk operations possible through browse endpoints (paginated, 25 results per page). The canonical source of the foreignArtistId values that Lidarr uses.
- **Modern relevance**: Medium-High. MusicBrainz IDs are the lingua franca between Headphones, Lidarr, Beets, and most music automation tools. Understanding MusicBrainz's relationship types (artist-to-artist, recording-to-recording) could enable sophisticated music discovery features. The ListenBrainz Labs API extends this with `similar-artists` and `similar-recordings` endpoints based on collaborative filtering.
- **Source**: [musicbrainzngs on PyPI](https://pypi.org/project/musicbrainzngs/), [GitHub - python-musicbrainzngs](https://github.com/alastair/python-musicbrainzngs), [MusicBrainz API docs](https://musicbrainz.org/doc/MusicBrainz_API)
- **Confidence**: High (primary source documentation)

### Pianobar - Console Pandora Client (2010-present)

- **How it worked**: A free/open-source console-based Pandora client written in C. Allowed users to play stations, rate songs, manage stations, and view song history from the terminal. Used Pandora's recommendation engine (the Music Genome Project) under the hood.
- **Advantages**: Demonstrated that music recommendation could work well in a CLI context. The thumbs-up/thumbs-down rating model influenced how users thought about music curation. Station management from the terminal was intuitive.
- **Modern relevance**: Low-Medium. Pandora's recommendation model was proprietary and can't be replicated. However, the UX pattern of "listen -> rate -> get better recommendations" in a CLI context is applicable. The concept of "stations" (curated streams based on seed artists) could inspire Lidarr artist discovery workflows.
- **Source**: [GitHub - PromyLOPh/pianobar](https://github.com/PromyLOPh/pianobar)
- **Confidence**: Medium (tool is real but relevance to Lidarr integration is indirect)

### Gazelle Tracker Framework and Tools (2007-2016)

- **How it worked**: A PHP web framework for private music torrent trackers, most famously used by What.CD (shut down November 2016 after French police raid). Provided a JSON API for searching, browsing, and managing music torrents with detailed metadata. Community tools like gazelle-origin would fetch and save YAML origin metadata for beets integration. GazelleUI provided a wrapper for the tracker API.
- **Advantages**: Extremely rich music metadata model. The tracker community developed deep expertise in music categorization (formats, bitrates, log scores, media types). The gazelle-origin tool's approach of bridging tracker metadata with beets was an early example of cross-tool metadata pipelines. The API had strict rate limiting (5 requests per 10 seconds) which taught developers to build respectful API clients.
- **Modern relevance**: Low-Medium. What.CD is gone, but the metadata patterns survive in modern trackers. The gazelle-origin to beets pipeline is an early precedent for the kind of Plex-to-Lidarr metadata bridge rfmedia-cli could provide. The rate limiting lessons are directly applicable to Lidarr API integration.
- **Source**: [GitHub - WhatCD/Gazelle](https://github.com/WhatCD/Gazelle), [Gazelle JSON API Documentation](https://github.com/WhatCD/Gazelle/wiki/JSON-API-Documentation), [GitHub - gazelle-origin](https://github.com/x1ppy/gazelle-origin)
- **Confidence**: Medium (historical sources, primary documentation from archived projects)

### FlexGet - Multipurpose Media Automation (2008-present)

- **How it worked**: A Python-based multipurpose automation tool supporting torrents, NZBs, podcasts, and more. Used YAML configuration files to define tasks with input/filter/output plugin chains. Could monitor RSS feeds, apply regex filters, and route downloads to clients. Had some Sonarr integration but limited music-specific features.
- **Advantages**: Highly configurable through YAML task definitions. The input -> filter -> output pipeline pattern is elegant and composable. Could theoretically automate music downloads through RSS monitoring, though it lacked music-specific intelligence (no MusicBrainz integration, no artist monitoring).
- **Modern relevance**: Low. FlexGet's approach is too generic for music management. The \*arr ecosystem provides purpose-built solutions. However, FlexGet's YAML-based task configuration pattern could inspire configuration design for rfmedia-cli automation features.
- **Source**: [FlexGet official site](https://flexget.com/), [FlexGet Plugins](https://flexget.com/Plugins)
- **Confidence**: Medium (primary documentation available, but music-specific capabilities poorly documented)

### Whipper/Morituri - Accurate CD Ripping CLI (2011-present)

- **How it worked**: Morituri (later forked as Whipper) was a Python CLI CD-DA ripper for Unix systems focused on accuracy over speed. Used AccurateRip database for verification and MusicBrainz for metadata tagging. Modeled after Windows EAC (Exact Audio Copy). Whipper continued development after Morituri was abandoned.
- **Advantages**: Demonstrated that CLI music tools could prioritize quality and accuracy. MusicBrainz integration for automatic tagging was a model pattern. The fork story (Morituri abandoned -> Whipper revival) shows how music CLI tools can be revived and improved.
- **Modern relevance**: Low for direct Lidarr integration, but the MusicBrainz integration patterns and the "accuracy over convenience" philosophy are applicable to metadata management.
- **Source**: [GitHub - whipper-team/whipper](https://github.com/whipper-team/whipper)
- **Confidence**: Medium (primary source)

## Obsolete Approaches

### IRC/XDCC Music Automation (2005-2015)

- **Description**: Before Usenet and torrent automation matured, music traders used IRC channels with XDCC bots. Scripts would monitor channel announcements, parse release information, and automatically request downloads. Tools like iroffer and various custom Perl/Python scripts automated this process.
- **Why discontinued**: IRC-based music trading was fragile, required constant channel monitoring, and lacked the metadata richness of later approaches. Usenet with NZB indexers and then private torrent trackers offered more reliable, better-organized alternatives. The shutdown of major IRC networks and channels accelerated the decline.
- **Hidden advantages**: The pattern of "monitor announcements -> filter by criteria -> automatically acquire" was the direct ancestor of how Headphones and Lidarr work. IRC's real-time nature meant new releases were available faster than RSS-based approaches.
- **Source**: Historical knowledge; [FileShareTalk Forums](<https://filesharingtalk.com/threads/445425-NZB-downloading-automation-(Sickbeard-CouchPotato-Headphones)>)
- **Confidence**: Medium (secondary sources, historical knowledge)

### Manual Bash/Python Scripting for Music Collection (2008-2016)

- **Description**: Before purpose-built tools, users wrote custom bash and Python scripts to manage music collections. Common patterns included: cron jobs checking RSS feeds, scripts calling SABnzbd/NZBGet APIs, custom file renaming/organizing scripts, and MusicBrainz Picard command-line batch processing for tagging.
- **Why discontinued**: Maintenance burden was too high. Each user's scripts were unique, making community support difficult. Purpose-built tools (Headphones, then Lidarr) automated the same workflows with less effort and better error handling.
- **Hidden advantages**: Maximum flexibility. Users could implement exactly the workflow they wanted. Some patterns (like using MusicBrainz Picard's `FROM_FILE` batch processing) were more powerful than what GUI-first tools offered. The approach forced users to understand the full pipeline.
- **Source**: [Managing a Music Database from the Command Line](https://medium.com/@vapurrmaid/managing-a-music-database-from-the-command-line-3a5b85f414e9), [MusicBrainz Picard Command Processing](https://picard-docs.musicbrainz.org/en/usage/command_processing.html)
- **Confidence**: Medium (secondary sources, pattern reconstruction)

### Rdio API-Based Music Tools (2010-2015)

- **Description**: Rdio offered a comprehensive API that developers used to build music recommendation and playlist management tools. Rdio added personalized recommendations in September 2013. Various community tools leveraged the API for playlist sync, library management, and discovery.
- **Why discontinued**: Rdio filed for Chapter 11 bankruptcy on November 16, 2015, and sold assets to Pandora for $75 million. The service shut down December 22, 2015, immediately breaking all API-dependent tools. This was a cautionary tale about building on proprietary music service APIs.
- **Hidden advantages**: Rdio's API was reportedly developer-friendly and well-documented. The recommendation engine was effective. The lesson: don't build critical workflows on APIs that can disappear overnight. Use open standards (MusicBrainz, Last.fm) or self-hosted tools (Lidarr) as the source of truth.
- **Source**: [Rdio - Wikipedia](https://en.wikipedia.org/wiki/Rdio)
- **Confidence**: High (well-documented historical event)

### Spotify Recommendations API (2014-2024, partially deprecated)

- **Description**: Spotify's Web API provided `Get Recommendations` and `Get Artist's Related Artists` endpoints that developers used extensively for music discovery automation. The recommendations endpoint accepted seed artists, tracks, or genres and returned personalized suggestions. CLI tools and scripts built on these endpoints provided powerful discovery workflows.
- **Why discontinued/degraded**: In November 2024, the Recommendations endpoint stopped working reliably. Spotify has been progressively restricting developer API access. The `Get Artist's Related Artists` endpoint returns up to 20 related artists but access is increasingly gated. The Lidify project had to drop Spotify support and switch exclusively to Last.fm.
- **Hidden advantages**: The recommendation quality was excellent due to Spotify's vast listening data. The API design (seed-based recommendations with tunable parameters) was elegant and could inspire CLI interaction patterns. The fallback from Spotify to Last.fm in tools like Lidify demonstrates the importance of multi-source recommendation strategies.
- **Source**: [Spotify Web API Reference](https://developer.spotify.com/documentation/web-api/reference/get-recommendations), [Spotify Community - API alternatives](https://community.spotify.com/t5/Spotify-for-Developers/spotify-api-Get-Recommendations-alternative/td-p/6540653)
- **Confidence**: High (primary source, confirmed by multiple tools switching away)

## Discontinued Lidarr Integrations

### bmatheny/lidarr-cli (Ruby, 2022-?)

- **What it did**: A Ruby gem and CLI tool providing direct access to Lidarr's API. Supported album operations (monitor, unmonitor, retrieve by artist/album/foreign ID, search), artist operations (get individual, list all, search), tag management, and wanted album viewing (missing or cutoff). Used YAML configuration files from multiple locations (`/etc/lidarr-cli.yml`, `~/.config/lidarr/cli.yml`). Supported multiple output formats (plain text, JSON, YAML).
- **Why abandoned**: 44 total commits, 0 stars, 1 fork, no published releases. The README listed "good tests" and architectural improvements as future work but these appear never completed. Limited community adoption. Ruby is a less common choice for DevOps/homelab tooling compared to Python or Go.
- **Revival potential**: Medium. The command structure and configuration approach are sound. The multi-format output (text/JSON/YAML) is exactly what rfmedia-cli would need. The album monitor/unmonitor commands map directly to desired features. However, rewriting in TypeScript for rfmedia-cli is preferable to wrapping a Ruby gem.
- **Source**: [GitHub - bmatheny/lidarr-cli](https://github.com/bmatheny/lidarr-cli)
- **Confidence**: Medium (primary source, limited documentation)

### totaldebug/pyarr (Python, 2020-2023)

- **What it did**: A synchronous Python library providing unified access to Sonarr, Radarr, Readarr, and Lidarr APIs. Returned results in JSON format. Supported type checking. Provided a single library for all \*arr API interactions, reducing the need for separate clients per service.
- **Why abandoned**: Last release (v5.2.0) was July 28, 2023. Maintenance classified as "inactive" by package health analyzers. 98 stars but only 23 forks. The project may have lost momentum as auto-generated SDKs (like devopsarr/lidarr-py) provided alternative approaches with less maintenance burden.
- **Revival potential**: Low for direct use (Python, not TypeScript). Medium for design inspiration. Its unified approach to all \*arr APIs is noteworthy - rfmedia-cli could potentially support Sonarr/Radarr queries in the future using the same patterns. The JSON-centric design that reduces brittleness when APIs evolve is a good pattern to follow.
- **Source**: [GitHub - totaldebug/pyarr](https://github.com/totaldebug/pyarr), [PyPI - pyarr](https://pypi.org/project/pyarr/)
- **Confidence**: High (primary sources, confirmed inactive status)

### tkdrob/aiopyarr (Python, async)

- **What it did**: An async Python API client for Lidarr, Radarr, Readarr, and Sonarr. Provided an alternative to the synchronous pyarr library for applications needing non-blocking API calls.
- **Why abandoned**: Appears to have limited adoption compared to pyarr. The async approach added complexity without clear benefits for CLI tools (where blocking calls are typically fine).
- **Revival potential**: Low. The async pattern is interesting for server applications but unnecessary for CLI tools like rfmedia-cli. However, if rfmedia-cli ever needed to make parallel Lidarr API calls (e.g., checking status of multiple artists simultaneously), the async pattern could be revisited.
- **Source**: [GitHub - tkdrob/aiopyarr](https://github.com/tkdrob/aiopyarr)
- **Confidence**: Low (limited information available)

### RandomNinjaAtk/docker-lidarr-extended (Bash/Shell, 2020-2023, ARCHIVED)

- **What it did**: A Docker container packaging Lidarr with automation scripts. Key features: automatic downloading from Deezer/Tidal, related artist discovery (auto-add from Tidal and Deezer), top artist charts, queue management, music video downloading, Beets integration for tagging, and ReplayGain calculation. The related artist feature included `numberOfRelatedArtistsToAddPerArtist` (1-20) and `preventRelatedArtistsLoop` settings.
- **Why abandoned**: Archived July 12, 2023. Functionality migrated to [RandomNinjaAtk/arr-scripts](https://github.com/RandomNinjaAtk/arr-scripts). The Docker container approach was replaced with a more modular script-based approach that could be injected into any Lidarr container.
- **Revival potential**: High. The related artist discovery logic with loop prevention is directly applicable to rfmedia-cli. The pattern of "discover related artists -> add to Lidarr in unmonitored state -> let user review" is exactly the workflow rfmedia-cli should implement. The configuration options (max related artists per artist, loop prevention, monitored vs unmonitored) provide a proven UX model.
- **Source**: [GitHub - docker-lidarr-extended (archived)](https://github.com/RandomNinjaAtk/docker-lidarr-extended), [arr-scripts Lidarr config](https://github.com/RandomNinjaAtk/arr-scripts/blob/main/lidarr/extended.conf)
- **Confidence**: High (primary source, well-documented configuration)

### sirk123au/ArrTools (Python, 2018-?)

- **What it did**: A Python script collection for Radarr, Sonarr, and Lidarr. Lidarr-specific features: `lidarr_add_from_list.py` (bulk artist imports from CSV with automatic MusicBrainz ID retrieval), `backup_lidarr_2csv.py` (database backup to CSV). Also included a standalone GUI (`arr_gui.py`) for import/export operations. CSV format for artist imports: `artist, foreignArtistId`.
- **Why abandoned**: 170 stars, 157 commits, but no published releases. Python scripts without packaging. The bulk CSV import pattern is useful but limited compared to API-driven approaches.
- **Revival potential**: Medium. The CSV import/export pattern is pragmatic for bulk operations. The `lidarr_add_from_list.py` pattern of accepting CSV input with automatic MusicBrainz ID resolution could inspire an rfmedia-cli `lidarr import` command. The backup-to-CSV functionality is useful for disaster recovery and migration.
- **Source**: [GitHub - sirk123au/ArrTools](https://github.com/sirk123au/ArrTools)
- **Confidence**: Medium (primary source, limited maintenance data)

### ziacik/lumus (TypeScript, 2016-?)

- **What it did**: An all-in-one alternative to SickBeard, CouchPotato, and Headphones. Searched for movies, shows, and music and automatically added them to Transmission when they appeared on torrents. Integrated with Kodi. Written in TypeScript/JavaScript (notable for being an early TypeScript media automation tool).
- **Why abandoned**: Appears to have been a solo developer project that didn't gain traction. The "all-in-one" approach meant competing with three separate mature tools simultaneously.
- **Revival potential**: Low for direct use, but notable as a precedent for TypeScript-based media automation. Proves that TypeScript is viable for this domain.
- **Source**: [GitHub - ziacik/lumus](https://github.com/ziacik/lumus)
- **Confidence**: Low (limited information)

## Revival Candidates

### 1. Headphones' `getSimilar` Pattern for Lidarr Discovery

- **Original form**: Headphones API provided `getSimilar` which returned similar artists ranked by relevance count using Last.fm data. Users could then selectively add discovered artists.
- **Why worth reviving**: Lidarr's native import lists from Last.fm are limited (top 20 albums/artists, 24-hour sync interval). A CLI tool could provide on-demand similar artist discovery with more control: specify the seed artist, set similarity thresholds, preview results before adding, and batch-add selected artists.
- **Modern modifications**: Use multiple similarity sources (Last.fm via their API, ListenBrainz similar-artists endpoint, and MusicBrainz artist relationships). Present results as a ranked list with confidence scores. Allow filtering by genre, country, or activity status. Integrate with Lidarr's quality profiles and root folders when adding.
- **Source**: [Headphones API](https://github.com/rembo10/headphones/blob/master/API.md), [ListenBrainz Labs API](https://labs.api.listenbrainz.org/)
- **Confidence**: High

### 2. DiscoveryLastFM's Multi-Step Workflow for Automated Discovery

- **Original form**: A Python tool that (1) retrieves Last.fm listening history, (2) discovers similar artists via Last.fm, (3) filters through MusicBrainz to exclude non-studio releases, (4) adds to Lidarr or Headphones with quality profiles, (5) maintains a persistent cache to prevent duplicates, (6) uses exponential backoff for API resilience.
- **Why worth reviving**: This is the most complete automated music discovery pipeline found in the research. The workflow is proven and the dual-platform support (Headphones and Lidarr) demonstrates good architectural separation.
- **Modern modifications**: Rewrite in TypeScript for rfmedia-cli. Add Plex integration as an additional data source (use Plex play counts and ratings as signals alongside Last.fm history). Make each step composable so users can run discovery, preview, and import as separate commands. Add dry-run mode.
- **Source**: [GitHub - MrRobotoGit/DiscoveryLastFM](https://github.com/MrRobotoGit/DiscoveryLastFM)
- **Confidence**: High

### 3. Lidarr-Extended's Related Artist Loop Prevention for Bulk Discovery

- **Original form**: Shell scripts that auto-added related artists from Tidal/Deezer with configurable limits: `numberOfRelatedArtistsToAddPerArtist` (1-20), `preventRelatedArtistsLoop` (prevents cascading additions), and `autoArtistAdderMonitored` (add as monitored or unmonitored).
- **Why worth reviving**: Related artist discovery can cause runaway growth. The loop prevention logic is essential for any production implementation. The "add as unmonitored" pattern lets users review before committing resources.
- **Modern modifications**: Implement as `rfmedia lidarr discover-related` command with `--max-per-artist`, `--no-cascade`, `--unmonitored` flags. Add a `--preview` mode that shows what would be added without making changes. Support tag-based organization (e.g., tag all auto-discovered artists with "discovered").
- **Source**: [docker-lidarr-extended config](https://github.com/RandomNinjaAtk/arr-scripts/blob/main/lidarr/extended.conf)
- **Confidence**: High

### 4. ArrTools' CSV Import/Export Pattern for Bulk Operations

- **Original form**: Python scripts for bulk importing artists from CSV files with automatic MusicBrainz ID resolution, and exporting Lidarr data to CSV for backup.
- **Why worth reviving**: Bulk operations are underserved in the Lidarr ecosystem. Import from CSV, export to CSV, and bulk modify operations enable workflows that the Lidarr web UI can't handle efficiently (e.g., importing 500 artists from a curated list, bulk unmonitoring all artists in a genre).
- **Modern modifications**: `rfmedia lidarr import --file artists.csv` with progress bars and error reporting. `rfmedia lidarr export --format csv|json|yaml`. Bulk operations: `rfmedia lidarr bulk-unmonitor --tag "discovered" --older-than 30d`.
- **Source**: [GitHub - sirk123au/ArrTools](https://github.com/sirk123au/ArrTools)
- **Confidence**: Medium-High

### 5. Beets' Cross-Service Identifier Mapping for Plex-Lidarr Bridge

- **Original form**: Beets community proposed storing identifiers from multiple services (Spotify ID, Discogs ID, MusicBrainz ID) as separate database fields to enable cross-service playlist sync and metadata matching.
- **Why worth reviving**: The rfmedia-cli objective explicitly calls for bridging Plex and Lidarr. Plex identifies music by file paths and Plex metadata agent IDs. Lidarr identifies music by MusicBrainz foreign IDs. Mapping between these identifiers is the key technical challenge for features like "find albums in Plex that Lidarr doesn't know about" or "sync Plex ratings to Lidarr quality decisions."
- **Modern modifications**: Build a local mapping cache that associates Plex library items with Lidarr artists/albums via MusicBrainz IDs. Use MusicBrainz as the canonical bridge identifier. `rfmedia lidarr sync-plex --direction plex-to-lidarr` and `rfmedia lidarr gaps --show-plex-only --show-lidarr-only`.
- **Source**: [Beets discovery discussion](https://discourse.beets.io/t/improve-music-discovery-aspect-of-beets/1911)
- **Confidence**: Medium (conceptual, not proven implementation)

### 6. Lidify's Recommendation-to-Addition Pipeline

- **Original form**: A Docker-based web app that reads Lidarr's artist library, queries Last.fm (previously Spotify) for similar artists, presents recommendations, and adds selected artists to Lidarr with one click. Recently switched from Spotify to Last.fm exclusively due to Spotify API restrictions.
- **Why worth reviving**: Lidify proves the workflow is valuable (514 stars). However, it requires running a separate web service. A CLI implementation would be lighter-weight and more composable. The forced switch from Spotify to Last.fm is a cautionary tale about API dependency.
- **Modern modifications**: Implement as `rfmedia lidarr recommend` command. Support Last.fm as primary recommendation source with MusicBrainz as fallback. Add `--seed-artist "Artist Name"` for targeted discovery. Include quality profile and root folder selection. Support batch mode for non-interactive use.
- **Source**: [GitHub - TheWicklowWolf/Lidify](https://github.com/TheWicklowWolf/Lidify)
- **Confidence**: High

### 7. devopsarr/lidarr-py's Auto-Generated SDK Pattern

- **Original form**: A Python SDK for Lidarr automatically generated from the Lidarr OpenAPI specification using OpenAPI Generator. Provides comprehensive coverage of all Lidarr API endpoints without manual coding.
- **Why worth reviving**: Auto-generating a TypeScript client from Lidarr's API specification would eliminate the maintenance burden of keeping API bindings up to date. As Lidarr's API evolves, regenerating the client would be a one-command operation. The devopsarr organization generates SDKs for all \*arr applications using the same approach.
- **Modern modifications**: Use the OpenAPI Generator's TypeScript-fetch or TypeScript-axios template to generate a TypeScript client for rfmedia-cli. Wrap the generated client with rfmedia-cli's command/action separation pattern. Use the generated types for strict type safety.
- **Source**: [GitHub - devopsarr/lidarr-py](https://github.com/devopsarr/lidarr-py), [OpenAPI Generator](https://openapi-generator.tech/)
- **Confidence**: High (proven approach, actively maintained generator)

## Key Insights

1. **The "add as unmonitored" pattern is essential for discovery features.** Every successful music discovery tool (Headphones, lidarr-extended, Lidify, DiscoveryLastFM) includes the ability to add artists without immediately triggering downloads. This lets users review discoveries before committing disk space and bandwidth. rfmedia-cli must support `--unmonitored` for any add/import operation.

2. **Last.fm is the most reliable open recommendation source, but multi-source strategies win.** Spotify's API restrictions killed integrations in Lidify and other tools. Last.fm has remained stable for 15+ years. But the best approach combines Last.fm similar artists, ListenBrainz collaborative filtering, and MusicBrainz relationship data. rfmedia-cli should abstract the recommendation source so it can be swapped or combined.

3. **Loop prevention is a solved problem with known parameters.** The lidarr-extended project identified and solved the "related artist cascade" problem with three configuration knobs: max artists per seed, cascade prevention flag, and monitored/unmonitored state. rfmedia-cli should implement these from day one rather than rediscovering the problem.

4. **Auto-generated API clients reduce maintenance burden dramatically.** The devopsarr organization proves that generating SDKs from Lidarr's OpenAPI spec works. Manual API wrappers (pyarr, lidarr-cli) tend to fall behind the API and get abandoned. rfmedia-cli should consider auto-generating the Lidarr client layer.

5. **CSV import/export enables workflows that APIs alone cannot.** Users with large collections need bulk operations that aren't practical through a web UI or one-at-a-time CLI commands. The ArrTools pattern of CSV-based bulk import with automatic ID resolution fills a real gap. rfmedia-cli should support tabular data formats for bulk operations.

6. **The Plex-Lidarr bridge is an unsolved problem with high value.** Despite 15 years of music automation tools, no tool effectively bridges a media server's library view (Plex) with a collection manager's database (Lidarr). Beets discussed it but didn't implement it. This is rfmedia-cli's unique opportunity: it already has Plex integration, so adding Lidarr integration creates a bridge that doesn't exist elsewhere.

7. **Music automation is harder than TV/movie automation.** The artist -> album -> track hierarchy, combined with compilations, live albums, singles, EPs, remasters, and deluxe editions, makes music significantly more complex than the show -> season -> episode or movie models. Every successful tool handles this by letting users selectively monitor at the album level, not just the artist level. rfmedia-cli should expose album-level control.

8. **TypeScript media automation tools are rare but viable.** Most historical tools are Python (Headphones, Beets, ArrTools, DiscoveryLastFM, Soularr) or Ruby (lidarr-cli, musicbrainz-cli). The lumus project proved TypeScript works for media automation. rfmedia-cli's TypeScript foundation is a differentiator, not a limitation.

## Evidence Quality

- **Confidence rating**: High overall. Primary sources (GitHub repositories, official documentation, API docs) were available for all major findings. Multiple corroborating sources confirmed key patterns and design decisions. Historical timeline is well-established.

- **Gaps identified**:
  - Limited information on why specific projects were truly abandoned (maintainer burnout? scope creep? better alternatives?)
  - No quantitative data on how many users these tools served
  - The Lidarr v2 plugin system may change the landscape significantly (not covered in this archaeological review, more relevant to the futurist persona)
  - IRC/XDCC era music automation tools are poorly documented as they predate GitHub

- **Potential biases**:
  - GitHub-centric research may miss tools distributed through other channels (forums, personal blogs)
  - English-language bias in searches may miss tools from non-English-speaking communities
  - Survivorship bias: we can only study tools that left traces, not the countless personal scripts that were never shared

## Search Queries Executed

1. "Headphones music automation API before Lidarr Python CLI"
2. "music management CLI tools 2010 2015 command line automation"
3. "Beets music CLI plugins discovery similar artists recommendations"
4. "MusicBrainz CLI tools automation bulk operations"
5. "Lidarr CLI wrapper abandoned GitHub projects"
6. "Last.fm similar artists CLI tool scrobbling automation Python"
7. "music collection automation scripting bash Python before Sonarr Radarr arr ecosystem"
8. "Headphones vs Lidarr comparison API features migration"
9. "Python music automation library history pyMusicBrainz pylast musicbrainzngs"
10. "Sonarr Radarr CLI tools scripts that could apply to Lidarr arr ecosystem"
11. "Headphones music downloader API endpoints Python automation history"
12. "lidarr-extended RandomNinjaAtk music automation features similar artists"
13. "beets plugin similar recommend discover music automation"
14. "pylast Python Last.fm similar artists API history library"
15. "FlexGet music automation plugin history before Lidarr"
16. "Sickbeard CouchPotato Headphones era music automation 2012 2015"
17. "devopsarr lidarr-py Python SDK Lidarr API wrapper"
18. "Rdio Pandora music recommendation CLI tools history obsolete"
19. "pianobar Pandora CLI terminal history open source"
20. "pyarr Python arr API library Sonarr Radarr Lidarr history"
21. "whipper abcde morituri CD ripper CLI music automation history"
22. "Lidarr origin history fork Sonarr Radarr when created first release"
23. "abandoned music CLI projects GitHub music manager music library 2015 2018"
24. "Spotify similar artists API CLI tool recommendation engine history"
25. "arr-tools lidarr bulk add artists unmonitor delete automation scripts"
26. "Soularr Slskd Soulseek music automation CLI alternative Lidarr"
27. "Lidarr import list Spotify Last.fm similar artists automation discovery"
28. "Gazelle music tracker API CLI automation tools history"
29. "MusicBrainz API similar artists related recordings bulk operations"

## Sources Index

### Primary Sources (GitHub Repositories)

- [Headphones](https://github.com/rembo10/headphones) - Original music automation tool (2011-present)
- [Headphones API Documentation](https://github.com/rembo10/headphones/blob/master/API.md)
- [Beets](https://github.com/beetbox/beets) - Music library manager (2012-present)
- [lidarr-cli (Ruby)](https://github.com/bmatheny/lidarr-cli) - Abandoned Lidarr CLI wrapper
- [pyarr](https://github.com/totaldebug/pyarr) - Inactive Python \*arr API library
- [devopsarr/lidarr-py](https://github.com/devopsarr/lidarr-py) - Auto-generated Python Lidarr SDK
- [ArrTools](https://github.com/sirk123au/ArrTools) - Python \*arr utility scripts
- [docker-lidarr-extended (archived)](https://github.com/RandomNinjaAtk/docker-lidarr-extended) - Extended Lidarr automation
- [arr-scripts](https://github.com/RandomNinjaAtk/arr-scripts) - Successor to lidarr-extended
- [DiscoveryLastFM](https://github.com/MrRobotoGit/DiscoveryLastFM) - Last.fm-based music discovery
- [Lidify](https://github.com/TheWicklowWolf/Lidify) - Lidarr recommendation tool
- [pylast](https://github.com/pylast/pylast) - Python Last.fm interface
- [python-musicbrainzngs](https://github.com/alastair/python-musicbrainzngs) - Python MusicBrainz bindings
- [musicbrainz-cli](https://github.com/GreyCat/musicbrainz-cli) - Ruby MusicBrainz CLI (2011)
- [pianobar](https://github.com/PromyLOPh/pianobar) - Console Pandora client
- [Gazelle](https://github.com/WhatCD/Gazelle) - Music tracker framework
- [whipper](https://github.com/whipper-team/whipper) - Accurate CD ripping CLI
- [Soularr](https://github.com/mrusse/soularr) - Lidarr-Soulseek bridge
- [Tubifarry](https://github.com/TypNull/Tubifarry) - Lidarr plugin for YouTube/Soulseek
- [lumus](https://github.com/ziacik/lumus) - TypeScript media automation (SickBeard/CouchPotato/Headphones alternative)
- [kitesi/music](https://github.com/kitesi/music) - Go music CLI with Last.fm integration
- [aiopyarr](https://github.com/tkdrob/aiopyarr) - Async Python \*arr client
- [awesome-arr](https://github.com/Ravencentric/awesome-arr) - Curated \*arr ecosystem list

### Documentation Sources

- [Beets Plugins Documentation](https://beets.readthedocs.io/en/stable/plugins/)
- [Beets Discovery Discussion](https://discourse.beets.io/t/improve-music-discovery-aspect-of-beets/1911)
- [MusicBrainz API Documentation](https://musicbrainz.org/doc/MusicBrainz_API)
- [ListenBrainz Labs API](https://labs.api.listenbrainz.org/)
- [Servarr Wiki](https://wiki.servarr.com/)
- [Spotify Web API Reference](https://developer.spotify.com/documentation/web-api/reference/get-recommendations)
- [MusicBrainz Picard Command Processing](https://picard-docs.musicbrainz.org/en/usage/command_processing.html)
- [FlexGet Plugins](https://flexget.com/Plugins)

### Comparison and Analysis Sources

- [Lidarr vs Headphones (ShareConnector)](https://shareconnector.net/lidarr-vs-headphones/)
- [Lidarr vs Headphones (RyanBytes)](https://ryanbytes.com/headphones-vs-lidarr/)
- [Lidarr vs Headphones (SaaSHub)](https://www.saashub.com/compare-lidarr-vs-headphones)
- [Radarr Issue #791 - Lidarr fork proposal](https://github.com/Radarr/Radarr/issues/791)
- [Rdio Wikipedia](https://en.wikipedia.org/wiki/Rdio)

### Historical Context Sources

- [Kodi Forum - Complete SABnzbd/SickBeard/CouchPotato/Headphones Guide](https://forum.kodi.tv/showthread.php?tid=120406)
- [Headphones: SickBeard for Music](http://www.totalhtpc.com/headphones-sickbeard-for-music/)
- [HowToForge - Perfect Media Server 2011](https://www.howtoforge.com/the-perfect-media-server-ubuntu-11.10-sabnzbd-sickbeard-couch-potato-headphones-serviio)
- [Self-Hosted Music Still Sucks in 2025](https://www.joekarlsson.com/2025/06/self-hosted-music-still-sucks-in-2025/)
