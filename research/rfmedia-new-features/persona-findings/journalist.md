# The Journalist: Current State of Music Library Management (February 2026)

## Executive Summary

The music library management landscape in early 2026 is defined by a tension between mature but fragmented tools and rising user expectations shaped by streaming services. The self-hosted music ecosystem has made significant strides -- Navidrome released a plugin system rewrite (v0.60.0, February 2026), beets crossed the 2.6.x milestone with Python 3.13 support, and Plex underwent a turbulent year of pricing changes and music feature removals/re-additions. Meanwhile, AI-powered music analysis is transitioning from experimental to mainstream, with acoustic fingerprinting, mood-based smart filtering, and natural language playlist generation becoming table stakes. The critical gap remains: no single CLI tool unifies metadata management, format conversion with tag preservation, acoustic analysis, and multi-server synchronization -- precisely the space rfmedia-cli occupies.

---

## Current State of Music Library Management

### The CLI Tool Landscape

**Beets** remains the dominant CLI music library manager, reaching v2.6.1 (February 2, 2026). Key recent developments include:

- Python 3.13 support and Python 3.10+ requirement (v2.6.0, February 1, 2025)
- New `ImportSource` plugin to track original import paths
- Replacement of `python-musicbrainzngs` dependency with a custom lightweight MusicBrainz client
- Deprecated AcousticBrainz plugin (service shut down), with `beets-xtractor` recommended as alternative
- Multi-valued tag support for `artists` and `albumartists` fields (introduced in 2.0.0)
- New plugins: `autobpm` (BPM calculation via Librosa), `listenbrainz` (listening history import), `substitute`, `advancedrewrite`
- Convert plugin now generates M3U8 playlists alongside converted files and has a config option to disable writing metadata to converted files

Sources: [Beets GitHub Releases](https://github.com/beetbox/beets/releases), [Beets PyPI](https://pypi.org/project/beets/), [Beets 2.0.0 Release](https://github.com/beetbox/beets/releases/tag/v2.0.0)

**Lidarr** continues active development (v2.1.7+), but its album-centric data model remains a fundamental limitation. Lidarr excels at automated music acquisition but struggles with track-level management. Many users combine Lidarr for downloads with beets for fine-tuning. Integration scripts exist (e.g., `lidarr-beets` on GitHub) to automatically run beets on Lidarr imports.

Sources: [Lidarr GitHub](https://github.com/Lidarr/Lidarr), [Lidarr vs Beets Discussion](https://programming.dev/post/31015861), [lidarr-beets Integration](https://github.com/MxMarx/lidarr-beets)

### Self-Hosted Music Servers

**Navidrome** (v0.60.3, February 10, 2026) is the fastest-growing self-hosted music server, with transformative recent features:

- **Plugin system rewrite** (v0.60.0): Multi-language WebAssembly-based plugins supporting Go, Rust, Python, and JavaScript with secure sandboxing and JSONForms configuration UI
- **Instant Mix**: Song-based playlist generation using Last.fm, Deezer, or plugin-based similarity matching
- **Pure-Go metadata extraction**: New `go-taglib` library reducing C++ TagLib dependency
- **Multi-library support** (v0.58.0): Separate music collections with permission controls
- **Multi-artist/contributor support** (v0.54.x): Albums and tracks with multiple artists, composers, conductors
- **Custom tags**: User-defined custom tags for enhanced metadata flexibility
- **R128 gain tags**: Scanner supports R128 loudness normalization tags
- **Scrobble history tracking** (v0.59.0): Built-in listening history
- **ListenBrainz integration** (v0.60.2): Artist URLs and similar songs
- Subsonic/OpenSubsonic API compatible

Sources: [Navidrome GitHub Releases](https://github.com/navidrome/navidrome/releases), [Navidrome Website](https://www.navidrome.org/), [Navidrome 0.53 Coverage](https://linuxiac.com/navidrome-0-53-rolls-out-with-enhanced-ui/)

**Funkwhale** continues as a community-focused, decentralized music platform emphasizing social features and ActivityPub federation but has less momentum than Navidrome for personal library use.

**Jellyfin** serves as a free, open-source Plex alternative but music remains a secondary concern -- its strength is in unified media management rather than dedicated music features.

Sources: [Awesome-Selfhosted Music Overview](https://github.com/basings/selfhosted-music-overview), [SaaS Hub Comparison](https://www.saashub.com/compare-jellyfin-vs-navidrome)

### Commercial Players

**Roon** (2.0+) continues to set the audiophile standard:

- MUSE DSP engine (solidified branding in 2026) with sample rate conversion, room correction, parametric EQ
- Smart Playlists with dynamic filtering
- Roon ARC with Apple CarPlay and Android Auto
- "Listen Later" personal queue feature
- Folder Browsing added in late 2024
- Subscription pricing: $12.99/month or $129.99/year

Sources: [Roon Website](https://roon.app/en/), [Roon MUSE DSP Guide](https://sonixplay.com/roon-muse-dsp-settings-guide), [What Hi-Fi Roon Guide](https://www.whathifi.com/advice/roon-everything-you-need-to-know)

**Audirvana** maintains its position for bit-perfect playback with direct audio path, DSD64/128 support, MQA decoding, and Qobuz integration. Praised for superior sound quality through OS audio mixer bypass.

Sources: [Audirvana Website](https://audirvana.com/), [Audirvana Studio Review](https://www.hifi.blog/audirvana-studio-review-audiophile-music-software-for-macos-and-windows/)

---

## Key Players and Tools

### Tier 1: Established Leaders

| Tool      | Type                  | Key Strength                              | Active Development      |
| --------- | --------------------- | ----------------------------------------- | ----------------------- |
| Beets     | CLI library manager   | Plugin ecosystem, MusicBrainz integration | Yes (v2.6.1, Feb 2026)  |
| Navidrome | Self-hosted server    | Lightweight, Subsonic API, plugins        | Yes (v0.60.3, Feb 2026) |
| Plexamp   | Music player          | Sonic analysis, AI playlists              | Yes (active)            |
| Roon      | Audiophile platform   | DSP, metadata richness                    | Yes (MUSE engine)       |
| Lidarr    | Automated acquisition | \*arr ecosystem integration               | Yes (v2.1.7+)           |

### Tier 2: Growing Contenders

| Tool            | Type                   | Key Strength                               |
| --------------- | ---------------------- | ------------------------------------------ |
| Symfonium       | Mobile player          | Multi-source, 256-band EQ, AutoEQ profiles |
| Jellyfin        | Media server           | Free, unified media, no vendor lock-in     |
| ListenBrainz    | Listening history      | Open-source Last.fm alternative            |
| Music Assistant | Smart home integration | Home Assistant integration                 |

### Tier 3: Specialized Tools

| Tool                 | Type                   | Key Strength                          |
| -------------------- | ---------------------- | ------------------------------------- |
| Essentia             | Audio analysis library | C++/Python/JS, real-time capable      |
| Chromaprint/AcoustID | Fingerprinting         | 30M+ fingerprints, MusicBrainz linked |
| Loudgain             | Loudness normalization | ReplayGain 2.0, EBU R128              |
| Mp3tag               | Metadata editor        | Universal tag editing                 |
| music-metadata (npm) | Node.js library        | TypeScript, ESM, streaming support    |

### Emerging Players

- **AudioMuse-AI**: AI-powered playlist generator for Subsonic servers
- **Deej-AI**: Deep learning-based automatic playlist creation
- **PersonalAIs**: Mood-aware AI recommendations (Google Summer of Code 2025)
- **MusicAutoTagger**: AcoustID-based automatic file identification and metadata completion

Sources: [Symfonium App](https://symfonium.app/), [Essentia](https://essentia.upf.edu/), [AcoustID](https://acoustid.org/), [music-metadata npm](https://www.npmjs.com/package/music-metadata), [Deej-AI GitHub](https://github.com/teticio/Deej-AI), [MusicAutoTagger GitHub](https://github.com/lux032/MusicAutoTagger)

---

## Latest Developments (2025-2026)

### Beets 2.x Series (2024-2026)

The beets 2.0.0 release (May 2024) was the most significant update in years:

- **Importer UI overhaul**: Completely redesigned user interface with customization through `ui_options`
- **Multi-valued tags**: `artists` and `albumartists` now support multiple values
- **New identifiers**: Imports ISRC, EAN, UPC, `release_group_title`, Discogs/Spotify/Deezer/Beatport external IDs
- **autobpm plugin**: Calculates BPM using Librosa audio analysis
- **listenbrainz plugin**: Imports listening history and playlists
- **Synced lyrics**: LRCLIB provider added; lyrics plugin supports synced lyrics preference
- **M3U8 generation**: Convert plugin generates playlists alongside converted files
- **Spotify sync**: `spotifysync` command for popularity, audio features, ISRCs
- **AcousticBrainz deprecated**: Service shutdown; `beets-xtractor` recommended

Source: [Beets 2.0.0 Release](https://github.com/beetbox/beets/releases/tag/v2.0.0)

### Plex Music Turbulence (2025)

2025 was a turbulent year for Plex music users:

1. **Music removed from main app** (Q1 2025): Plex deprecated music/photos in the primary mobile app, directing users to Plexamp
2. **User backlash**: Significant pushback from users who wanted everything in one place, especially on TV apps
3. **Music returned** (July 2025): Preview TV app brought music and photos back after community pressure
4. **Pricing increases** (April 2025): Lifetime Plex Pass increased to $249; yearly to $69.99; monthly to $6.99
5. **Sonic Sage**: ChatGPT-integrated natural language playlist creation within Plexamp
6. **TIDAL integration**: Seamless integration of TIDAL with personal music libraries

Sources: [Plex Blog - Future of Plex](https://www.plex.tv/blog/the-future-of-plex-focused-streamlined-and-ready-for-feedback/), [Plex Blog - 2025 Updates](https://www.plex.tv/blog/important-2025-plex-updates/), [Plex Music & Photos Return](https://blog.lon.tv/2025/07/20/plex-to-add-music-photos-back-to-new-tv-and-mobile-apps-sponsored-post/)

### Navidrome 0.60 (February 2026)

The Navidrome 0.60 release represents a major architectural leap:

- **WebAssembly plugin system**: Multi-language support (Go, Rust, Python, JavaScript) with sandboxed execution
- **Instant Mix**: Dynamic playlist generation using Last.fm/Deezer similarity data
- **ListenBrainz integration**: Deep integration with scrobbling, artist URLs, similar songs
- **go-taglib**: Pure-Go metadata extraction reduces build complexity
- **OpenSubsonic compliance**: readonly and validUntil properties for playlists

Source: [Navidrome GitHub Releases](https://github.com/navidrome/navidrome/releases)

### AI in Music Management (2025-2026)

AI has moved from experimental to operational in music management:

- **Cyanite.ai**: Commercial AI-powered music tagging -- tags moods, genres, instrumentation at granular levels (e.g., "mid-tempo indie rock with ambient textures and introspective mood")
- **Plexamp Sonic Sage**: ChatGPT integration for natural language playlist creation
- **Spotify Smart Filters** (September 2025): Premium users can filter library by mood, genre, activity
- **On-device recognition**: AI-powered recognition getting traction for privacy and offline use
- **Acoustic fingerprinting**: Captures 52.1% of music recognition market share in 2025
- **Cover/version detection**: Advanced ML models enable noise-resilient recognition and version detection

Sources: [Cyanite.ai](https://cyanite.ai/2025/11/15/the-power-of-automatic-tagging-with-ai/), [Spotify Smart Filters](https://techcrunch.com/2025/09/08/spotifys-new-smart-filters-let-you-screen-library-content-by-activity-genre-or-mood/), [Music Recognition Market](https://www.coherentmarketinsights.com/industry-reports/music-recognition-app-market)

---

## Emerging Trends

### 1. Track-Centric vs. Album-Centric Design

The industry is shifting away from album-first models. Users increasingly consume music as individual tracks, creating tension with tools like Lidarr that enforce album-level workflows. The criticism is sharp: "Lidarr approaches music with an album-first data model that's fundamentally misaligned with how humans actually consume music in 2025." Tools that support both album-level and track-level operations are gaining favor.

Source: [Self-Hosted Music Still Sucks](https://www.joekarlsson.com/2025/06/self-hosted-music-still-sucks-in-2025/)

### 2. Plugin/Extension Architectures

Both beets and Navidrome have invested heavily in extensibility:

- Beets: 80+ plugins covering metadata, analysis, integration, workflow
- Navidrome: New WASM-based plugin system supporting multiple languages
- This trend validates rfmedia-cli's own plugin system for custom processors

### 3. Multi-Source Metadata Enrichment

Modern tools pull metadata from multiple sources simultaneously:

- MusicBrainz (core metadata, fingerprinting via AcoustID)
- Discogs (physical release data, featured artists)
- Spotify (popularity, audio features, ISRCs)
- Last.fm (artist info, similar artists, scrobbling)
- Deezer (rankings, attributes)
- ListenBrainz (listening history, recommendations)

### 4. Smart Playlists with Complex Filtering

Smart playlist capabilities are becoming increasingly sophisticated:

- Apple Music: Genre, year, BPM, rating, skip count, date added rules with AND/OR logic
- Spotify (2025): Mood, genre, activity filters for Premium users
- Roon: Dynamic filtering with Smart Playlists
- Navidrome (v0.60.3): Explicit status support in smart playlists
- Plexamp: Sonic analysis-based radio and mood-based mixing

### 5. Loudness Normalization Standardization

ReplayGain 2.0 (based on EBU R128) is becoming the de facto standard:

- Target: -18 LUFS (ReplayGain 2.0) vs -23 LUFS (EBU R128 broadcast standard)
- Tools: Loudgain (FFmpeg-based), beets ReplayGain plugin, ffmpeg-normalize
- Navidrome v0.53+ supports R128 gain tags natively

Sources: [Loudgain GitHub](https://github.com/Moonbase59/loudgain), [ReplayGain Wikipedia](https://en.wikipedia.org/wiki/ReplayGain)

### 6. The Navidrome/Symfonium Stack

A "best of breed" self-hosted music stack is coalescing around Navidrome (server) + Symfonium (Android client). Symfonium offers:

- 256-band equalizer with 4,200+ AutoEQ headphone profiles
- Gapless playback, ReplayGain, volume boost
- Multi-source: Plex, Emby, Jellyfin, Subsonic, WebDAV, cloud providers
- Offline caching, synced lyrics, instant mixes
- Material You theming

Sources: [Symfonium App](https://symfonium.app/), [BIT-101 Blog](https://bit-101.com/blog/posts/2025-03-29/plex-navidrome-symfonium/)

---

## Contemporary Debates

### Plex vs. Alternatives

Plex's 2025 pricing increases and the music feature removal/re-addition cycle have accelerated user migration. Key discussion points:

- Plex Pass lifetime at $249 is pushing users to explore Jellyfin (free) and Navidrome (free)
- Plexamp remains the gold standard for music playback quality and discovery features
- Plex's sonic analysis and Sonic Sage are unique competitive advantages
- But Plex's reliance on internet connectivity for local media remains controversial

Sources: [XDA - Plex to Jellyfin](https://www.xda-developers.com/4-reasons-plex-is-pushing-me-further-and-further-towards-jellyfin/), [Hacker News Discussion](https://news.ycombinator.com/item?id=43711754)

### Lossless vs. Lossy (Resolved with Nuance)

The debate has largely settled into pragmatism:

- Archive in FLAC/ALAC for preservation
- Convert to Opus (at 128-192 kbps) for portable/streaming use -- Opus widely acknowledged as superior to MP3 at equivalent bitrates
- The critical issue is **tag preservation during conversion**, where metadata can be lost or mangled when transcoding between formats
- FLAC uses Vorbis comments; MP3 uses ID3v2; Opus uses Vorbis comments -- format-specific tag mapping is non-trivial

### Self-Hosted Music UX Gap

A recurring theme across discussions: self-hosted music management has a worse user experience than it should. The "Self-Hosted Music Still Sucks in 2025" article crystallizes frustrations:

- No equivalent to Overseerr for music requests
- Lidarr's album-centric model misaligned with track consumption
- Integration between acquisition (Lidarr), management (beets), and playback (Plex/Navidrome) requires significant manual configuration
- The dream of seamless individual track management "shouldn't require a computer science PhD in 2025"

Source: [Self-Hosted Music Still Sucks](https://www.joekarlsson.com/2025/06/self-hosted-music-still-sucks-in-2025/)

### Local-First vs. Cloud-Integrated

The self-hosted community strongly favors local-first approaches, but practical needs drive cloud integration:

- Songs disappearing from streaming libraries due to licensing creates urgency for local ownership
- ListenBrainz provides open-source cloud scrobbling without vendor lock-in
- MusicBrainz/AcoustID provide cloud-based identification without storing user data
- Symfonium supports offline caching as a bridge between local and cloud

---

## Recent Events Timeline

| Date         | Event                                                                         |
| ------------ | ----------------------------------------------------------------------------- |
| Feb 10, 2026 | Navidrome v0.60.3 released (smart playlist improvements, security fixes)      |
| Feb 7, 2026  | Navidrome v0.60.2 released (ListenBrainz integration expansion)               |
| Feb 3, 2026  | Navidrome v0.60.0 released (WASM plugin system, Instant Mix, go-taglib)       |
| Feb 2, 2026  | Beets v2.6.1 released (packaging dependency fix)                              |
| Feb 1, 2025  | Beets v2.6.0 released (Python 3.13, ImportSource plugin, MusicBrainz rewrite) |
| Nov 15, 2025 | Cyanite.ai publishes major article on AI-powered music auto-tagging           |
| Oct 2025     | TuneTagger launches custom metadata taxonomies for music tagging              |
| Sep 2025     | Spotify launches Smart Filters for Premium users (mood, genre, activity)      |
| Aug 2025     | ReplayGain comparison analysis (lame vs. ffmpeg) published                    |
| Jul 2025     | Plex announces music and photos returning to TV app after user backlash       |
| Jun 2025     | "Self-Hosted Music Still Sucks in 2025" article published, widely discussed   |
| Apr 2025     | Plex Pass price increases take effect; new mobile app launches                |
| Dec 2024     | Navidrome v0.59.0 (scrobble history, filesystem watcher)                      |
| Oct 2024     | Beets v2.5.0/2.5.1 (Discogs enhancements, LastGenre)                          |
| Sep 2024     | Navidrome v0.53.0 (Nuclear theme, R128 gain, TagLib 2.0.2)                    |
| Jul 2024     | Navidrome v0.58.0 (multi-library support)                                     |
| May 2024     | Beets v2.0.0 (major UI overhaul, multi-valued tags, autobpm)                  |

---

## Market and Industry Dynamics

### Open Source Ecosystem Health

The open-source music management ecosystem is healthy but fragmented:

- **Beets**: 12.9K+ GitHub stars, active community, 80+ plugins -- but Python-only ecosystem can be a barrier for Node.js/TypeScript projects
- **Navidrome**: Rapid growth, active development, WASM plugin system opens new integration possibilities
- **Lidarr**: Part of the well-funded \*arr ecosystem but music-specific limitations persist
- **MusicBrainz/AcoustID**: 30M+ fingerprints, foundational infrastructure for the entire ecosystem

### Metadata API Landscape

Available metadata APIs for integration in 2025-2026:

| API                  | Strengths                                | Limitations                    |
| -------------------- | ---------------------------------------- | ------------------------------ |
| MusicBrainz          | Comprehensive, open, community-driven    | Rate limited, can be slow      |
| Discogs              | Physical releases, featured artists      | Focused on physical media      |
| Last.fm              | Scrobbling, similar artists, artist info | Limited to Last.fm data        |
| Spotify              | Popularity, audio features, ISRCs        | Requires API key, rate limited |
| Deezer               | Rankings, attributes                     | Less comprehensive             |
| ListenBrainz         | Open listening history, recommendations  | Newer, smaller dataset         |
| AcoustID/Chromaprint | Fingerprinting, identification           | Lookup only, not enrichment    |

### TypeScript/Node.js Music Libraries

The npm ecosystem provides several relevant libraries:

- **music-metadata** (v11.10.6+): Full TypeScript, ESM, streaming, supports virtually all audio/tag formats
- **musicbrainz-api** (npm): JavaScript MusicBrainz API client
- **Essentia.js**: WebAssembly-based audio analysis in JavaScript/TypeScript
- **Chromaprint**: C library with bindings (no native JS, requires FFI or subprocess)

Sources: [music-metadata npm](https://www.npmjs.com/package/music-metadata), [musicbrainz-api npm](https://www.npmjs.com/package/musicbrainz-api), [Essentia.js](https://mtg.github.io/essentia.js/)

---

## Key Insights for rfmedia-cli

### 1. Tag Preservation During Conversion is a Critical Gap

rfmedia-cli's open issue #42 (Tag Preservation During Conversion) addresses one of the most persistent pain points in music library management. Format-specific tag mapping (ID3v2 for MP3, Vorbis comments for FLAC/Opus, iTunes atoms for M4A) is non-trivial, and users frequently lose metadata during conversion. This is a differentiating feature opportunity.

### 2. Smart Filter Sophistication Matches Market Direction

rfmedia-cli's smart filter system with nested boolean logic aligns perfectly with the industry trend toward sophisticated dynamic playlists. Spotify's 2025 Smart Filters launch and Roon's Smart Playlists confirm market demand. The key differentiator would be making these filters work across both local operations and Plex integration.

### 3. Deduplication Detection Has Market Validation

Issue #38 (Deduplication Detection) maps to a well-established market need. Audio fingerprint-based deduplication (as opposed to metadata-only matching) is the gold standard. Integration with Chromaprint/AcoustID would provide the most robust solution, though it requires native dependencies or subprocess calls.

### 4. Navidrome Integration Opportunity

Navidrome's v0.60 WASM plugin system and OpenSubsonic API compliance create a new integration opportunity. rfmedia-cli could potentially provide a pipeline from beets-like management to Navidrome-served libraries, filling the gap between acquisition/management and playback.

### 5. ListenBrainz as Open Scrobbling Alternative

ListenBrainz is emerging as the open-source standard for listening history. Integration would complement rfmedia-cli's existing Plex integration with a vendor-neutral listening data source for smart filtering based on play history.

### 6. AI-Powered Features Have Proven Demand

Plexamp's Sonic Sage (ChatGPT playlist generation) and Cyanite.ai's granular mood/genre tagging demonstrate that AI-powered music features have moved from novelty to expected functionality. However, the research objective's caution about "recency bias toward AI-powered features without proven user demand" is valid -- the most impactful AI features are those that enhance existing workflows (like acoustic fingerprinting for deduplication) rather than introduce entirely new paradigms.

### 7. The "Self-Hosted Music Sucks" Gap is an Opportunity

The widely-discussed frustration with self-hosted music workflow fragmentation validates rfmedia-cli's integrated approach. A tool that unifies metadata management, format conversion, Plex integration, smart filtering, and file organization addresses the exact workflow gaps that users are vocal about.

---

## Evidence Quality Assessment

| Finding                       | Confidence  | Source Quality                      | Recency         |
| ----------------------------- | ----------- | ----------------------------------- | --------------- |
| Beets 2.6.x release details   | High        | Primary (GitHub releases)           | February 2026   |
| Navidrome 0.60.x features     | High        | Primary (GitHub releases)           | February 2026   |
| Plex music changes 2025       | High        | Primary (Plex blog) + secondary     | April-July 2025 |
| AI music tagging capabilities | Medium-High | Mix of primary and industry reports | 2025            |
| Self-hosted music pain points | Medium-High | Blog post + community discussion    | June 2025       |
| Roon MUSE features            | Medium      | Secondary (review sites)            | 2025-2026       |
| Music deduplication tools     | Medium      | Mix of product pages and articles   | 2025            |
| ListenBrainz development      | Medium      | Primary (MusicBrainz wiki)          | 2025            |
| TypeScript music libraries    | High        | Primary (npm, GitHub)               | Current         |
| Market share/industry data    | Medium      | Industry reports                    | 2025            |

---

## Contradictions and Uncertainties

### Contradictions Identified

1. **Plex music strategy**: Plex simultaneously removed music from its main app (claiming Plexamp was the future) and then reversed course under user pressure. The long-term direction remains unclear -- is Plexamp standalone or integrated?

2. **Album vs. track workflows**: Beets and Lidarr both default to album-centric models, yet user discussion consistently demands track-level management. The tools haven't fully adapted to consumption patterns.

3. **AI value proposition**: Commercial AI tagging (Cyanite.ai) claims granular classification, but open-source alternatives lag significantly. The gap between what's technically possible and what's practically available to self-hosted users is large.

### Uncertainties

1. **AcousticBrainz shutdown impact**: With AcousticBrainz deprecated, the open-source ecosystem lacks a free, large-scale acoustic analysis database. The `beets-xtractor` alternative exists but relies on local Essentia computation rather than a centralized database.

2. **Navidrome plugin ecosystem maturity**: The WASM plugin system is brand new (February 2026). Whether a healthy plugin ecosystem develops depends on community adoption.

3. **Plex API stability**: Plex's recent API changes (JWT tokens, device key registration) and pricing changes create uncertainty about long-term platform reliability for third-party integrations.

4. **Chromaprint/AcoustID sustainability**: The AcoustID service has 30M+ fingerprints but its long-term funding model and API reliability are not well-documented in recent sources.

---

## Search Queries Executed

1. `best music library management tools 2025 2026 self-hosted CLI`
2. `beets music tagger latest features updates 2025 2026`
3. `Lidarr vs beets music CLI tools comparison 2025`
4. `Navidrome Funkwhale self-hosted music server features 2025 2026`
5. `Roon music management features audiophile 2025 2026`
6. `Plex music features updates 2025 2026 changes`
7. `music metadata tagging AI ML acoustic fingerprinting 2025`
8. `self-hosted music management reddit discussion 2025 2026`
9. `MusicBrainz Chromaprint AcoustID music identification library 2025 2026`
10. `music library organization best practices 2025 CLI automation file management`
11. `Plexamp features sonic analysis loudness leveling 2025`
12. `Essentia audio analysis library open source music features 2025`
13. `"self-hosted music" "still sucks" 2025 pain points problems`
14. `beets 2.0 release changelog features 2025 2026 github`
15. `music deduplication duplicate detection tools audio fingerprint 2025`
16. `Navidrome 0.53 0.54 release features 2025 2026`
17. `music tag preservation conversion metadata lossless lossy 2025`
18. `beets plugins most popular 2025 acousticbrainz chroma replaygain lyrics`
19. `"music-metadata" npm TypeScript audio tag library 2025 features`
20. `MusicBrainz API features 2025 2026 new endpoints improvements`
21. `Last.fm Discogs API music metadata integration 2025`
22. `music library management AI playlist generation recommendation 2025 open source`
23. `Jellyfin music features vs Plex vs Navidrome comparison 2025`
24. `music file format conversion FLAC MP3 Opus best tools 2025 ffmpeg`
25. `music ReplayGain R128 loudness normalization tools 2025 ffmpeg`
26. `Audirvana music player features audiophile 2025 DSD MQA`
27. `ListenBrainz features music listening history scrobbling 2025 open source`
28. `music watch mode file monitoring inotify CLI tool automation 2025`
29. `Symfonium music player app features 2025 subsonic client`
30. `music smart playlist dynamic filters BPM genre year mood rating 2025`
31. `Plex API music endpoints sonic analysis features integration 2025`
32. `Spotify smart filters library content activity genre mood 2025`

---

_Report compiled: February 10, 2026_
_Persona: The Journalist -- investigating the present moment in music library management_
_Total searches executed: 32_
_Primary sources consulted: GitHub releases, official project websites, API documentation_
_Secondary sources consulted: Tech blogs, forum discussions, industry reports_
