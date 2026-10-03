# Archaeologist Persona: Historical Music Management Research

## Executive Summary

This report excavates 30+ years of music management history (1990s-2020s) to identify forgotten, abandoned, or underappreciated approaches that deserve reconsideration for rfmedia-cli. The research reveals several patterns: (1) the most powerful features from classic tools were query languages and template-based organization systems that map directly to CLI paradigms; (2) radio broadcasting developed sophisticated scheduling algorithms decades ago that have never been adapted for personal music management; (3) the Unix philosophy of composable tools was well-applied to music management in the 2000s but lost momentum as GUI players dominated; and (4) DJ software independently invented "smart crate" concepts that parallel but extend smart playlist features in consumer software.

The strongest revival candidates are: foobar2000's title formatting language for file operations, radio-style rotation/separation rules for playlist generation, MPD's sticker database pattern for sidecar metadata, and MediaMonkey's event-driven auto-organize system. These represent proven approaches that modern TypeScript tooling (SQLite, streaming APIs, AST parsing) could implement more elegantly than the original tools.

**Confidence Level**: High for feature descriptions and historical facts (primary documentation sources). Medium for claims about "what was lost" (requires interpretation). Low for speculation about revival feasibility (depends on implementation specifics).

---

## Classic Music Management (1990s-2010s)

### Winamp Media Library (1998-2013)

Winamp's Media Library, introduced in version 2.x and refined through version 5.x, established several patterns that remain influential.

**Smart Views with Query Editor**: Winamp's Smart Views allowed rule-based filtering using a query language. Users could construct queries like `?playcount = 0` or `genre HAS "Hardrock" AND rating >= "4"` directly in the search bar (prefixed with `?`). The system had three modes: a Basic Editor (visual rule builder), an Advanced Editor (raw query strings), and a Query Builder for complex compositions. This three-tier approach to query complexity is worth noting -- rfmedia-cli's smart filters currently offer only one tier.

**Play History Tracking**: Winamp tracked both play counts and last-played timestamps as first-class metadata, incrementing automatically during playback. This data fed directly into Smart Views, enabling queries like "songs rated 4+ that haven't been played in 30 days." The integration between playback tracking and filtering was seamless in a way that few modern tools replicate for CLI workflows.

**What Was Lost**: Winamp's approach of treating the query language as a first-class user-facing feature (type queries directly in search bars) rather than hiding it behind GUI builders was unusually power-user friendly. Modern tools tend to either expose raw SQL (too complex) or provide only visual builders (too limited).

Sources:

- [Winamp Media Library Help](https://help.winamp.com/hc/en-us/articles/8105304048660-The-Winamp-Media-Library)
- [Winamp Media Library Preferences](https://help.winamp.com/hc/en-us/articles/8120108636564-Media-Library-Preferences)
- [Winamp Heritage](https://winampheritage.com/overview)

### foobar2000 Title Formatting and Query System (2002-present)

foobar2000 represents perhaps the most sophisticated approach to music library management ever built into a media player, with two systems of particular relevance to rfmedia-cli.

**Title Formatting Language**: A complete expression language for transforming metadata into strings. Scripts consist of literal text, field references (`%artist%`, `%album%`), function calls (`$if()`, `$replace()`, `$num()`), variables, and conditional logic. Key capabilities include:

- **Field access**: `$meta(album)` for tag fields, `%filename%` for file properties
- **String manipulation**: Functions to remove prefixes ("A", "The"), extract substrings, pad numbers
- **Conditional logic**: `$if(%rating%,$repeat(*,%rating%),no rating)` -- display stars based on rating or fallback text
- **Mathematical operations**: Arithmetic on numeric fields for computed values
- **Variables**: Store intermediate results for reuse within a single expression

This language was used everywhere: file renaming, column display, autoplaylist sorting, and plugin configuration. A single syntax served multiple purposes.

**Query Syntax for Autoplaylists**: A separate but complementary query language with operators like:

- `IS` / `HAS` -- exact match and substring search
- `GREATER` / `LESS` / `EQUAL` -- numeric comparisons (e.g., `rating GREATER 3`)
- `MISSING` / `PRESENT` -- test for field existence
- `BEFORE` / `AFTER` -- temporal comparisons (e.g., `%last_modified% AFTER 2008`)
- `SORT BY` / `SORT ASCENDING BY` / `SORT DESCENDING BY` -- result ordering
- Boolean operators with mandatory brackets for grouping

Autoplaylists were dynamic views that automatically updated when the underlying library changed. The distinction between static playlists (user-curated) and autoplaylists (query-driven) was a core architectural concept.

**File Operations Component**: The `foo_fileops` component used title formatting patterns for file renaming and organization. Patterns like `%artist%\%album%\$num(%tracknumber%,2) - %title%` could reorganize entire libraries. A preview mode showed the before/after state before executing. Presets could be saved and accessed from context menus.

**Masstagger**: Batch tag editing across hundreds of files simultaneously, with pattern-based transformations. Users could paste data (one line per track) for bulk operations.

**What Was Lost**: foobar2000's title formatting language is arguably the most powerful metadata transformation system ever built for music management, yet it remains Windows-only and largely unknown outside audiophile communities. The concept of a single expression language that handles both display formatting AND file organization is extremely elegant and directly applicable to a CLI tool.

Sources:

- [foobar2000 Title Formatting Reference (Hydrogenaudio)](https://wiki.hydrogenaudio.org/index.php?title=Foobar2000:Title_Formatting_Reference)
- [foobar2000 Query Syntax (Hydrogenaudio)](https://wiki.hydrogenaudio.org/index.php?title=Foobar2000:Query_syntax)
- [foobar2000 File Operations (Hydrogenaudio)](https://wiki.hydrogenaud.io/index.php?title=Foobar2000%3AFile_Operations_%28foo_fileops%29)
- [foobar2000 Autoplaylist (Hydrogenaudio)](https://wiki.hydrogenaudio.org/index.php?title=Foobar2000:Autoplaylist)
- [Titleformat Examples](https://wiki.hydrogenaudio.org/index.php?title=Foobar2000:Titleformat_Examples)

### MediaMonkey Auto-Organize and Scripting (2003-present)

MediaMonkey introduced an event-driven approach to library management that was ahead of its time.

**Auto-Organize as Background Process**: MediaMonkey's Auto-Organize ran continuously as a background process (Gold feature). Any time a file was added to the library or edited, Auto-Organize would automatically rename/move it according to configured rules. This is fundamentally different from batch operations -- it was reactive, event-driven file management.

**Destination Masks**: Template-based naming using tag variables. The system showed a preview of changes (New Path column) before executing. Users could define different rules for different subsets of the library (e.g., classical music organized by composer, pop music by artist).

**VBScript Automation**: MediaMonkey exposed its entire data model through COM automation. Scripts could:

- React to events (`OnTrackAdded`, playback events)
- Access the underlying SQLite database directly via SQL
- Create custom UI elements
- Automate complex multi-step workflows

The scripting system used VBScript but the architectural pattern -- exposing the database and event system to user scripts -- is the important insight. This is essentially what rfmedia-cli's plugin system could become with more event hooks.

**What Was Lost**: The concept of continuous, event-driven file organization (not just batch operations) is powerful and underexplored in CLI tools. The idea that adding a file to a watched directory automatically triggers tagging, renaming, and organization is a workflow that rfmedia-cli's watch mode could evolve toward.

Sources:

- [MediaMonkey Organizing Files and Folders](https://www.mediamonkey.com/sw/webhelp/frame/changingfilenames.htm)
- [MediaMonkey Wiki: Organizing Files](https://www.mediamonkey.com/wiki/WebHelp:Changing_Filenames/5.0)
- [MediaMonkey Introduction to Scripting](https://www.mediamonkey.com/wiki/Introduction_to_scripting)
- [MediaMonkey Scripting Tips](<https://www.mediamonkey.com/wiki/Scripting_Tips_&_Tricks_(MM4)>)

### iTunes Smart Playlists (2000-present)

iTunes smart playlists established the mainstream standard for rule-based music filtering that most users today understand.

**Nested Boolean Rules**: Starting around iTunes 9, Apple introduced nested conditional groups within smart playlists. Users could create a top-level AND group containing nested OR groups. For example:

```
Match ALL of the following:
  Play Count is 0
  Match ANY of the following:
    Genre is "Rock"
    Genre is "Alternative"
    Genre is "Indie"
  Rating is greater than 3 stars
```

This is directly comparable to rfmedia-cli's nested boolean smart filter logic.

**Criteria Fields**: iTunes exposed a rich set of fields for filtering: Album, Artist, BPM, Bit Rate, Comment, Compilation, Composer, Date Added, Date Modified, Genre, Grouping, Kind, Last Played, Last Skipped, Love/Dislike, Play Count, Purchased, Rating, Sample Rate, Size, Skip Count, Sort Album, Sort Artist, Sort Composer, Time, Track Number, Year.

**Playlist-of-Playlists**: A powerful workaround for complex boolean logic -- create multiple smart playlists with AND logic, then reference them from a master playlist with OR logic. This pattern of composing playlists from other playlists is a form of query composition.

**What Was Lost**: Apple Music progressively degraded smart playlist functionality. Smart playlists on iOS are static until the next sync with iTunes/Music. Properties like play count and last played don't sync reliably between devices, causing smart playlists to evaluate differently on different devices. The transition from iTunes to Apple Music lost some of the reliability and consistency that made smart playlists trustworthy.

The key lesson: smart playlists are only as good as the metadata pipeline feeding them. Inconsistent sync broke the trust model.

Sources:

- [Macworld: Nested Conditionals in iTunes 9](https://www.macworld.com/article/200183/nested_playlists.html)
- [Apple Support: Smart Playlists](https://support.apple.com/guide/itunes/create-delete-and-use-smart-playlists-itns3001/windows)
- [Apple Community: Smart Playlist Boolean Logic](https://discussions.apple.com/thread/7494007)

### ReplayGain and Loudness Normalization (2001-present)

**Historical Arc**: David Robinson proposed the ReplayGain standard in 2001 to solve the problem of inconsistent loudness across tracks. The original standard used psychoacoustic analysis with equal-loudness contours. In 2010, the EBU R128 / ITU BS.1770 standard provided more rigorous measurement algorithms using LUFS (Loudness Units Full Scale).

**ReplayGain 2.0**: The proposed update uses EBU R128 measurement but targets -18 LUFS (rather than EBU's broadcast -23 LUFS) for backward compatibility. Tools like `loudgain` implement this standard and can write tags to FLAC, Ogg, MP3, MP4, AAC, ALAC, Opus, WAV, AIFF, WavPack, and APE files.

**Track vs. Album Gain**: A critical distinction. Track gain normalizes every track to equal loudness. Album gain preserves the relative volume differences between tracks on the same album (important for albums mastered as cohesive works). Both values are stored as metadata tags.

**Relevance to rfmedia-cli**: When copying files between libraries (especially for portable/car use), loudness normalization becomes important. The tool could calculate and apply ReplayGain during the copy/conversion process rather than requiring a separate pass.

Sources:

- [ReplayGain Wikipedia](https://en.wikipedia.org/wiki/ReplayGain)
- [loudgain on GitHub](https://github.com/Moonbase59/loudgain)

---

## Forgotten CLI Tools and Scripts

### beets: The Gold Standard CLI Music Manager (2010-present)

beets is the most directly comparable tool to rfmedia-cli and represents the state of the art in CLI music management.

**Auto-Tagger Architecture**: beets' import process combines multiple identification strategies: tag matching, acoustic fingerprinting (via Chromaprint/AcoustID), and MusicBrainz database lookups. When files have missing or incorrect metadata, acoustic fingerprinting identifies songs from the audio itself.

**Plugin Ecosystem** (comprehensive list of relevant plugins):

- **Metadata Enrichment**: `acousticbrainz` (deprecated, replaced by `beets-xtractor`), `autobpm` (BPM calculation via Librosa), `keyfinder` (musical key detection), `lastgenre` (genre from Last.fm), `lastimport` (play counts from Last.fm), `lyrics` (auto-fetch lyrics), `mbsync` (MusicBrainz metadata updates), `replaygain` (loudness normalization)
- **Library Management**: `duplicates` (find duplicate tracks/albums), `bucket` (group files by field value ranges), `the` (handle "The" prefix in names), `zero` (nullify fields by pattern), `scrub` (clean extraneous metadata)
- **Smart Organization**: `smartplaylist` (generate playlists from beets queries), `random` (random selection), `importfeeds` (track imports via M3U/symlinks), `inline` (Python snippets for custom path formatting)
- **Integrity**: `badfiles` (check audio file integrity), `fetchart`/`embedart` (album art management)
- **Innovative**: `chroma` (acoustic fingerprinting), `ftintitle` (move featured artists to title field), `mpdstats` (MPD play statistics), `ipfs` (library sharing via IPFS)

**Query Language**: beets has its own query syntax that supports field matching, regex, path queries, and numeric comparisons. Queries power both the CLI interface and the smartplaylist plugin.

**What rfmedia-cli Can Learn**: beets' plugin architecture is worth studying. The pattern of plugins that hook into the import pipeline (pre-import, during import, post-import) with access to both the database and the file system is well-proven. The `bucket` plugin (grouping by value ranges) and `inline` plugin (Python snippets in path templates) are particularly clever.

Sources:

- [beets Documentation](https://beets.readthedocs.io/en/stable/plugins/index.html)
- [beets GitHub](https://github.com/beetbox/beets)
- [beets Walkthrough](https://beets.io/blog/walkthrough.html)

### MusicBrainz Picard Fingerprinting Evolution (2000-present)

**Three Generations of Fingerprinting**:

1. **TRM (2000-2008)**: "TRM Recognizes Music" -- MusicBrainz's first system, used in the original tagger
2. **MusicDNS/PUIDs (2006-2020)**: Portable Unique Identifiers, more robust than TRM
3. **AcoustID (2011-present)**: Current system, created by Lukas Lalinsky. Uses the `fpcalc` command-line utility to generate fingerprints. Fingerprints are submitted to a community database where similar prints are clustered and assigned AcoustIDs.

**Key Insight**: Each generation improved accuracy and community participation. The current AcoustID system is fully open-source and CLI-accessible via `fpcalc`. This means rfmedia-cli could integrate fingerprinting without depending on any proprietary API -- just shell out to `fpcalc` and query the AcoustID web service.

Sources:

- [MusicBrainz Picard AcoustID Documentation](https://picard-docs.musicbrainz.org/en/tutorials/acoustid.html)
- [MusicBrainz Fingerprinting Wiki](https://wiki.musicbrainz.org/Fingerprinting)

### MPD (Music Player Daemon) and the Sticker Database (2003-present)

MPD's architecture embodies the Unix philosophy: a headless daemon that manages music playback, controlled via a network protocol by separate client applications.

**Sticker Database**: MPD's "sticker" system is a SQLite-backed key-value store attached to songs. It stores dynamic metadata (ratings, play counts, last_played, date_added) separate from the audio files' embedded tags. This separation is architecturally significant:

- File tags remain pristine (no writes to audio files for dynamic data)
- Multiple MPD instances can share a sticker database
- Clients can store arbitrary key-value pairs per song
- Queries against sticker data can generate automated playlists

**Server-Client Separation**: MPD's fundamental insight is separating the music database/playback engine from the user interface. Multiple clients (ncmpc, cantata, mpc command-line tool) can connect simultaneously. Music continues playing regardless of which client (if any) is connected. This clean separation influenced later tools like Navidrome and Funkwhale.

**In-Memory Database**: MPD reads metadata and caches it entirely in memory at startup, with a flat-file database for persistence. No disk access needed for searches. This is relevant for rfmedia-cli's performance considerations with large libraries.

**What Was Lost**: The sticker database pattern -- sidecar metadata in SQLite, separate from file tags -- is elegant and underused. rfmedia-cli already has SQLite tracking; extending it with a sticker-like system for user-defined metadata (custom ratings, mood tags, energy levels) without modifying source files would be powerful.

Sources:

- [MPD Official Site](https://www.musicpd.org/)
- [MPD ArchWiki](https://wiki.archlinux.org/title/Music_Player_Daemon)
- [MPD Sticker Discussion](https://github.com/MusicPlayerDaemon/MPD/issues/1105)
- [mpdfav: Song Playcounts for MPD](https://github.com/vincent-petithory/mpdfav)

### cmus: Unix Philosophy Music Player (2004-present)

cmus is a lightweight console music player that demonstrates Unix-style composability applied to music.

**Seven Views**: Library (artist/album tree), Sorted Library (flat sorted list), Playlist, Queue, Directory Browser, Filters, and Settings. Each view serves a distinct purpose, and the filter system works across views.

**Filter Language**: cmus uses filter expressions to narrow library views. Filters are named, saved, and can be composed. The filter system operates on visible tracks without modifying the underlying library -- a non-destructive approach.

**Remote Control**: The `cmus-remote` command enables control via Unix sockets or TCP/IP. This means shell scripts can drive cmus, enabling automation workflows like:

```bash
cmus-remote -q /path/to/file.flac  # Add to queue
cmus-remote -C "filter genre=Rock"  # Apply filter
cmus-remote -n                       # Next track
```

**What Was Lost**: cmus's named filters and remote control pattern represent a clean Unix approach to music management that could inform rfmedia-cli's design. The idea of saving named filter presets that can be referenced from command-line invocations is straightforward but effective.

Sources:

- [cmus Official Site](https://cmus.github.io/)
- [cmus Man Page](https://linux.die.net/man/1/cmus)

### ID3 Tag CLI Tools: The Foundation (1999-present)

The evolution of command-line tag editors:

- **id3v2** (1999): The original CLI ID3 tag editor, created because "id3v1 tags are seriously deficient." Based on id3lib. Limited to ID3v2 tags.
- **eyeD3**: Python-based ID3 tagger with richer feature set.
- **mid3v2**: Mutagen-based replacement for id3v2 with ID3v2.4 support and fewer bugs. Part of the Mutagen ecosystem.
- **AtomicParsley**: Specialized for MP4/M4A metadata (Apple's tagging format).

**Mutagen Library**: The Python library underlying mid3v2 and beets. Supports reading/writing tags for MP3, FLAC, Ogg Vorbis, MP4, and many other formats. This is the de facto standard library for audio metadata in Python.

**Relevance**: rfmedia-cli uses TypeScript/Node.js, so the direct equivalent would be libraries like `music-metadata` (for reading) and format-specific writers. The historical lesson is that tag management tools evolved from simple read/write utilities to full expression-language-driven transformation systems (foobar2000's title formatting, beets' path templates).

Sources:

- [id3v2 on SourceForge](https://id3v2.sourceforge.net/)
- [Mutagen Command Line Tools](https://mutagen.readthedocs.io/en/latest/man/)
- [mid3v2 Documentation](https://mutagen.readthedocs.io/en/latest/man/mid3v2.html)

### Quod Libet: Python-Powered Query System (2004-present)

Quod Libet deserves special mention for its query language design.

**Three Query Tiers**:

1. **Simple text search**: Free-text matching across all fields
2. **Regular expression search**: Using `/pattern/` syntax instead of `"text"`
3. **Numeric queries**: Using `#` prefix for numeric comparisons on track, disc, rating, length, etc.

**Tied Tags**: Two tag names joined with `~` (e.g., `title~version`) for "nice" display that gracefully handles missing tags. `title~version` renders as "Title - Version" when version exists, or just "Title" when it doesn't.

**Human-Readable Tag References**: `<artist>` instead of `%a`, with `if not-null x else y` logic built in.

**Python Query Plugin** (3.10+): Allows Python expressions in queries with access to `time` and `random` modules. This is an early example of embedding a general-purpose language in a query system.

**What Was Lost**: Quod Libet's tied tags concept is elegant and directly applicable to rfmedia-cli's output formatting and file naming. The idea of a tag expression that gracefully degrades when fields are missing prevents ugly output like "Title - " when version is empty.

Sources:

- [Quod Libet Search Documentation](https://quodlibet.readthedocs.io/en/latest/guide/searching.html)
- [Quod Libet Wikipedia](<https://en.wikipedia.org/wiki/Quod_Libet_(software)>)

### XMMS and the Linux Audio Lineage (1997-2007)

XMMS (X Multimedia System), originally x11amp, was the Linux equivalent of Winamp. Created in 1997, its plugin architecture established patterns that influenced MPD, Audacious, and many other Linux audio tools.

**Plugin Categories**: Input (codecs), Output (devices), Effects (DSP), General (misc), and Visualization. This clean categorization of extension points influenced later tools' plugin architectures.

**Legacy**: XMMS died because of its dependency on GTK+ 1.x, not because its architecture was wrong. Audacious carries its lineage forward. The lesson: tool longevity depends on minimizing framework dependencies -- relevant for rfmedia-cli's choice of Node.js/TypeScript as its base.

Sources:

- [XMMS Wikipedia](https://en.wikipedia.org/wiki/XMMS)

### Amarok and Songbird: Ambitious Failures (2003-2013)

**Amarok** (2003-present): A KDE music player that attempted to be a music discovery platform, not just a player. It integrated with Wikipedia, lyrics services, and music recommendation APIs. After years of slower development, Amarok 3.0 was released in 2024 with Qt6/KF6 support and a new GStreamer engine, proving that community projects can be revived.

**Songbird** (2006-2013): Billed as "the first Web player," built on Mozilla XULRunner and GStreamer. It tried to merge web browsing with music management -- playing music from web pages alongside local files. Songbird shut down in 2013 and was forked as Nightingale.

**What Was Lost**: Songbird's vision of music management integrated with web content (discovering, previewing, and adding music from web sources) was premature. The idea of a CLI tool that can pull metadata from web sources, preview tracks on streaming services, and integrate external discovery APIs is more feasible today. Amarok's deep metadata enrichment (Wikipedia context, related artists) also deserves reconsideration as an automated metadata pipeline.

Sources:

- [Amarok Wikipedia](<https://en.wikipedia.org/wiki/Amarok_(software)>)
- [Songbird Wikipedia](<https://en.wikipedia.org/wiki/Songbird_(software)>)
- [Amarok 3.0 Slashdot](https://entertainment.slashdot.org/story/24/05/03/0020208/back-from-the-dead-amarok-30-music-player-released)

### EAC (Exact Audio Copy) and Archival Standards (1998-present)

**AccurateRip Verification**: EAC popularized the concept of comparing your CD rip against a community database of known-good rips. This crowdsourced verification model is relevant to rfmedia-cli's integrity checking -- could a community database of known-good checksums for albums improve verification confidence?

**CUE Sheets**: Text files documenting the exact structure of a ripped CD (track positions, gaps, ISRC codes, CD-Text). CUE sheets became the standard for lossless archival, preserving information that individual track files lose.

**Log Files**: EAC generates detailed rip logs documenting extraction quality, errors encountered, and AccurateRip results. This audit trail concept is relevant to rfmedia-cli's undo/rollback and history tracking features.

Sources:

- [Exact Audio Copy Wikipedia](https://en.wikipedia.org/wiki/Exact_Audio_Copy)
- [EAC Ripping Guide](https://eacguide.github.io/)

---

## DJ Software Innovations

### Smart Crates and Intelligent Playlists

DJ software independently developed sophisticated library organization systems that consumer music players lack.

**Serato Smart Crates**: Auto-updating crates based on configurable rules. Key features:

- Rules match against track metadata (genre, BPM range, date added, key, rating)
- Multiple rules combine with AND/OR logic
- **Live Update**: Optional real-time updating as library changes (toggle on/off)
- **Custom Crate Columns**: Each crate remembers its own sort order and visible columns
- Scan the entire library on launch, with refresh available on demand

**Rekordbox Intelligent Playlists**: Similar to Serato but with additional tools:

- Star ratings and custom tags
- Related track searches (find tracks similar to a selected track)
- Dedicated ID3 tag editing window
- Memory and hot cue banks (mix of cue points and loops)

**Traktor**: Notably lacks smart playlists entirely, relying on manual curation. This suggests that even in professional DJ tools, automated organization is not universally valued -- some professionals prefer manual control.

**Lexicon DJ (Cross-Platform Library Manager)**: A modern tool that manages and converts libraries between Rekordbox, Serato, Traktor, VirtualDJ, and Engine DJ. Key innovations:

- **Cross-platform migration**: Transfer playlists and metadata between DJ platforms, preserving cue points and tags
- **Automated cue point generation**: AI-driven placement of cue points
- **Custom tags that export to all platforms**: Tags created in Lexicon propagate to all DJ apps
- **Duplicate removal**: Intelligent deduplication across libraries
- **Batch reformatting**: Reformat thousands of tracks at once
- **400+ hotkey functions**: Emphasizing keyboard-driven workflow

**What DJ Software Teaches**: The concept of "crate columns" (per-collection view customization) and cross-platform library migration are directly applicable. rfmedia-cli manages copying between source and destination libraries; the DJ world's approach to preserving metadata across platform boundaries is relevant.

Sources:

- [Serato Smart Crates Support](https://support.serato.com/hc/en-us/articles/360001447715-Library-Smart-Crates)
- [Serato Crate Organization](https://the-drop.serato.com/culture/how-serato-djs-organize-their-crates/)
- [Lexicon DJ Features](https://www.lexicondj.com/features)
- [Crossfader: Automatic Music Management](https://wearecrossfader.co.uk/blog/automatic-music-management/)
- [Digital DJ Tips: Best DJ Software](https://www.digitaldjtips.com/best-software-for-djs/)

### BPM, Key, and Energy Analysis

DJ software pioneered automated audio analysis for organizational purposes:

- **BPM Detection**: Analyzing audio waveforms to determine tempo. Most DJ software does this automatically on import.
- **Musical Key Detection**: Identifying the key of a track (e.g., Am, C) for harmonic mixing. The Camelot Wheel system simplified this for DJs.
- **Energy Level / Intensity**: Some tools rate tracks on an energy scale for set building.
- **Waveform Analysis**: Visual representations that reveal song structure (intros, drops, breakdowns).

These analysis capabilities have been available via open-source tools (librosa, essentia, keyfinder) for years but are rarely integrated into personal music management CLIs. beets' `autobpm` and `keyfinder` plugins are exceptions.

---

## Radio Automation Systems

### Scheduling Algorithms and Rotation Theory

Radio broadcasting has been solving music library management at scale since the 1970s, with software solutions dating to 1979 (Selector by RCS). The approaches developed are remarkably sophisticated and largely unknown outside the broadcasting industry.

**Category System**: Songs are classified into lifecycle categories:

| Category              | Description                | Typical Size    | Rotation Frequency   |
| --------------------- | -------------------------- | --------------- | -------------------- |
| Power Current (A)     | Current hits, high appeal  | 5-10 songs      | Multiple times daily |
| Secondary Current (B) | Current, building momentum | 10-15 songs     | 1-2 times daily      |
| Tertiary Current (C)  | New releases, testing      | 15-20 songs     | Once daily or less   |
| Recurrent Power       | Recent hits, still strong  | 20-30 songs     | Several times weekly |
| Recurrent Secondary   | Older recent, declining    | 30-50 songs     | Weekly               |
| Gold/Library          | Established catalog        | 200-1000+ songs | Varies widely        |

The fundamental formula: `(daily category slots) / (number of songs in category) = plays per song per day`

**Separation Rules** (the most transferable concept):

1. **Artist Separation**: Minimum time between songs by the same artist (e.g., 60 minutes)
2. **Tempo Separation**: Maximum number of slow songs per hour, no back-to-back slow songs
3. **Genre Separation**: Prevent clustering of similar genres
4. **Gender Separation**: Manage male/female vocalist distribution
5. **Era Separation**: Prevent clustering of songs from the same decade
6. **Daypart Rules**: Different separation rules for different times of day (morning drive vs. evening)

**Format Clocks**: Templates defining the hour's content structure. A clock specifies positions for different categories, breaks, and features. Using 5 or 7 clock variants (rather than multiples of 24) naturally shuffles exposure across the week.

**Multi-Pass Scheduling**: Higher-priority categories schedule first, getting optimal placement. Lower-priority categories fill remaining slots with whatever separation rules they can satisfy. This avoids deadlock where too many rules prevent any valid schedule.

**The Key Insight for rfmedia-cli**: Radio scheduling's separation rules could transform smart playlist generation. Instead of just filtering (include/exclude), playlists could have sequencing rules: "no two tracks by the same artist within 5 positions," "alternate high and low energy tracks," "distribute genres evenly." This is a fundamentally different approach to playlist building that produces more varied, professional-sounding results.

Sources:

- [Music Scheduling System Wikipedia](https://en.wikipedia.org/wiki/Music_scheduling_system)
- [RadioILoveIt: Song Rotations](https://radioiloveit.com/radio-music-research-music-scheduling-software/music-scheduling-using-song-rotations-for-better-music-logs/)
- [RadioILoveIt: Song Categories](https://radioiloveit.com/radio-music-research-music-scheduling-software/radio-music-scheduling-tips-and-music-radio-programming-advice-on-song-categories-and-music-formats-and-format-clocks/)
- [Powergold: Song Categories Q&A](https://powergold.com/music-scheduling-qa-how-to-build-your-song-categories/)
- [MusicMaster Scheduling](https://musicmaster.com/)
- [Nextkast Music Scheduler](https://www.nextkast.com/onAir/music-scheduler/)

### Software Pioneers

- **Selector (RCS)**: First widely used music scheduler, 1979. Patented "goal-driven demand-based scheduling."
- **MusicMaster (A-Ware)**: Launched 1983. 40+ years of music scheduling refinement. Features dayparted rule groups, attribute coding (tempo, mood, energy, gender), and multi-pass scheduling.
- **PowerGold**: Released 1988. Focus on category management and rotation theory.
- **RadioDJ**: Free/open-source radio automation with sophisticated playlist algorithms ensuring genre, artist, and song type balance.

Sources:

- [MusicMaster Software](https://musicmaster.com/)
- [RadioDJ Overview](https://stationadmin.com/index.php/2025/08/28/radiodj-the-ultimate-free-radio-automation-software/)

---

## Revival Candidates

### Tier 1: High Value, Feasible with Current rfmedia-cli Architecture

**1. Separation Rules for Playlist Generation**

- **Origin**: Radio scheduling (1979-present)
- **Concept**: When generating M3U playlists or Plex playlists, apply sequencing rules beyond simple filtering. Rules like "minimum 3 tracks between same artist," "alternate tempo categories," "no more than 2 tracks from the same album consecutively."
- **Implementation**: Post-filter resequencing pass using constraint satisfaction. The filtered track list becomes the input; separation rules determine the final order.
- **Why It Works Now**: SQLite provides fast querying of track attributes. The constraint satisfaction problem for personal playlists (hundreds of tracks) is trivially solvable compared to radio scheduling (thousands of tracks with daypart constraints).
- **Complexity**: Medium. Requires a rule definition schema and a sequencing algorithm.
- **Priority**: High. Directly improves playlist quality with a novel feature no competing CLI tool offers.

**2. foobar2000-Style Expression Language for File Operations**

- **Origin**: foobar2000 title formatting (2002-present)
- **Concept**: A template expression language for file renaming, path construction, and output formatting. Supports conditionals (`$if()`), string manipulation (`$replace()`, `$trim()`), field references (`%artist%`, `%album%`), and graceful degradation for missing fields (Quod Libet's "tied tags" concept).
- **Implementation**: Parse expression templates into an AST, evaluate against track metadata. Use for `copy` destination paths, playlist descriptions, report formatting.
- **Why It Works Now**: TypeScript/Node.js has excellent parsing libraries (e.g., PEG.js, chevrotain). The expression language can be much simpler than foobar2000's (which grew organically over 20 years).
- **Complexity**: Medium-High. Requires designing a mini-language and parser, but the language can start small.
- **Priority**: High. Would unify file naming patterns across commands and make complex naming schemes possible.

**3. MPD-Style Sticker Database (Sidecar Metadata)**

- **Origin**: MPD stickers (2003-present)
- **Concept**: Store user-defined metadata (custom ratings, mood tags, energy levels, play counts, last synced date) in rfmedia-cli's SQLite database rather than modifying audio file tags. A key-value store per track that supplements embedded tags.
- **Implementation**: Extend the existing SQLite tracking database with a stickers table: `(file_path, sticker_name, sticker_value)`. Expose via CLI commands like `rfmedia sticker set --file <path> --key mood --value chill`.
- **Why It Works Now**: rfmedia-cli already has SQLite infrastructure. Sticker data can feed smart filters without ever modifying source files.
- **Complexity**: Low-Medium. Database schema extension and CLI commands.
- **Priority**: High. Enables metadata enrichment workflows without modifying source files.

### Tier 2: High Value, Requires New Infrastructure

**4. Event-Driven Auto-Organize (MediaMonkey Pattern)**

- **Origin**: MediaMonkey Auto-Organize (2003-present)
- **Concept**: Extend watch mode to automatically apply rules when files are added/modified. New file detected -> read metadata -> apply naming template -> move to correct location -> update database -> generate notifications.
- **Implementation**: Extend existing watch mode with a pipeline of configurable actions triggered by file system events.
- **Why It Works Now**: Node.js has mature file system watching (chokidar). The existing watch mode provides the foundation.
- **Complexity**: Medium. Pipeline definition and configuration schema.
- **Priority**: Medium. Powerful for automated workflows but requires careful error handling.

**5. Acoustic Fingerprint Integration for Deduplication**

- **Origin**: MusicBrainz/AcoustID (2000-present)
- **Concept**: Use audio fingerprinting to detect duplicates even across different formats, bitrates, and tag states. Shell out to `fpcalc` for fingerprint generation, compare fingerprints locally or against AcoustID database.
- **Implementation**: Add `fpcalc` as an optional dependency. Generate fingerprints during import/scan, store in SQLite, compare for deduplication (relates to open issue #38).
- **Why It Works Now**: AcoustID and `fpcalc` are mature, open-source, and CLI-accessible. SQLite can store and index fingerprint data efficiently.
- **Complexity**: Medium. External dependency management and fingerprint comparison logic.
- **Priority**: Medium. Directly addresses open issue #38 (Deduplication Detection).

**6. Radio-Style Track Categorization System**

- **Origin**: Radio scheduling category systems (1979-present)
- **Concept**: Assign tracks to rotation categories (Power, Regular, Deep Cut, etc.) based on play count, rating, age, and manual overrides. Categories feed into playlist generation with configurable rotation frequencies.
- **Implementation**: Category definitions in config, automatic assignment rules (e.g., "rating >= 4 AND play_count >= 10 = Power"), manual override via stickers.
- **Why It Works Now**: Combines naturally with the sticker database (#3) and separation rules (#1). The category assignments become another metadata dimension for smart filters.
- **Complexity**: Medium. Category engine with rule evaluation.
- **Priority**: Medium. Most valuable for users with large libraries who want curated rotation playlists.

### Tier 3: Interesting but Speculative

**7. Cross-Format Loudness Normalization During Copy**

- **Origin**: ReplayGain (2001-present), EBU R128 (2010)
- **Concept**: Calculate and apply ReplayGain tags during the copy/convert process. When converting FLAC to MP3 for a portable device, simultaneously calculate and embed ReplayGain data.
- **Complexity**: Medium. Requires audio analysis (could shell out to `loudgain` or use a Node.js audio analysis library).
- **Priority**: Low-Medium. Nice-to-have for conversion workflows.

**8. Playlist Composition (Playlist-of-Playlists)**

- **Origin**: iTunes smart playlists (2000-present)
- **Concept**: Reference other named filters/playlists in smart filter definitions. "Include all tracks matching filter 'favorites' OR filter 'recent-additions'."
- **Complexity**: Low. Extend smart filter evaluation to resolve named filter references.
- **Priority**: Low. Power user feature for complex filter hierarchies.

**9. AccurateRip-Style Community Verification**

- **Origin**: EAC/AccurateRip (1998-present)
- **Concept**: Compare file checksums against a community database of known-good rips to verify integrity beyond local-only checks.
- **Complexity**: High. Requires external service integration or community infrastructure.
- **Priority**: Low. Interesting but not practical for a CLI tool without existing infrastructure.

---

## Comparative Analysis

### Feature Coverage Across Historical Tools

| Feature                 | Winamp  | foobar2000      | iTunes       | MediaMonkey    | beets          | MPD              | cmus         | Serato            | Radio Sched.    | rfmedia-cli      |
| ----------------------- | ------- | --------------- | ------------ | -------------- | -------------- | ---------------- | ------------ | ----------------- | --------------- | ---------------- |
| Smart Filters/Playlists | Yes     | Yes (auto)      | Yes (nested) | Yes            | Yes (query)    | Via clients      | Yes (filter) | Yes (smart crate) | N/A             | Yes              |
| Expression Language     | Limited | Extensive       | No           | Mask-based     | Template       | No               | No           | No                | No              | No (candidate)   |
| File Organization       | No      | Yes (fileops)   | Limited      | Yes (auto)     | Yes (import)   | No               | No           | No                | N/A             | Yes (copy)       |
| Event-Driven Actions    | No      | No              | No           | Yes (auto-org) | Import hooks   | No               | No           | No                | N/A             | Watch mode       |
| Separation Rules        | No      | No              | No           | No             | No             | No               | No           | No                | Yes (core)      | No (candidate)   |
| Sidecar Metadata        | No      | Playback stats  | Play counts  | SQLite DB      | SQLite DB      | Sticker DB       | No           | Custom tags       | Song attributes | SQLite track     |
| Audio Fingerprinting    | No      | Via plugin      | No           | No             | Yes (chroma)   | No               | No           | No                | No              | No (candidate)   |
| Loudness Normalization  | Plugin  | ReplayGain      | Sound Check  | Yes            | ReplayGain     | No               | No           | Auto-gain         | No              | No (candidate)   |
| Cross-Platform Sync     | No      | No              | iCloud       | No             | No             | Network protocol | No           | Via Lexicon       | N/A             | Plex integration |
| Plugin/Extension System | Yes     | Yes (extensive) | No           | VBScript       | Python plugins | Client protocol  | No           | No                | No              | Yes (plugin)     |

### Key Gaps in rfmedia-cli vs. Historical Best-of-Breed

1. **No expression language for file naming** -- foobar2000 and beets both have this; rfmedia-cli relies on fixed naming patterns
2. **No sequencing/separation rules** -- Radio scheduling solved this decades ago; no music CLI tool has adopted it
3. **No audio-level analysis** -- BPM, key, loudness, fingerprinting are all absent
4. **Limited sidecar metadata** -- SQLite tracking exists but no arbitrary key-value store for user metadata
5. **No template-based output formatting** -- Quod Libet's tied tags and foobar2000's title formatting both address this

---

## Technology Evolution Impact

### What Changed That Makes Revival Feasible

| Historical Limitation                          | Modern Solution                     | Impact on Revival                                           |
| ---------------------------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| VBScript/COM for automation                    | TypeScript/Node.js with async/await | Event-driven workflows are natural in Node.js               |
| Proprietary databases (Access, custom formats) | SQLite (universal, embeddable)      | Sticker databases, category systems trivially implementable |
| Platform-specific UIs (Win32, GTK+)            | CLI + JSON/YAML output              | Cross-platform by default, composable with other tools      |
| Limited parsing tools                          | PEG.js, chevrotain, tree-sitter     | Expression languages can be built quickly                   |
| No audio analysis libraries                    | librosa, essentia, fpcalc           | Audio fingerprinting and analysis accessible from CLI       |
| Centralized metadata services                  | AcoustID (open), MusicBrainz (open) | Community metadata enrichment without vendor lock-in        |
| Batch processing only                          | Node.js streams, file watchers      | Event-driven and streaming workflows feasible               |

### What Killed Good Ideas Prematurely

1. **Platform lock-in**: foobar2000's title formatting is Windows-only. A cross-platform CLI implementation removes this barrier.
2. **GUI complexity**: MediaMonkey's auto-organize required a GUI to configure. A YAML/config-driven approach makes the same concept CLI-accessible.
3. **Commercial licensing**: Radio scheduling software costs thousands per year. The algorithms are well-documented and can be implemented in open-source tools.
4. **Framework dependencies**: XMMS died because of GTK+ 1.x. Songbird died because of XULRunner. CLI tools with minimal dependencies avoid this fate.
5. **Ecosystem fragmentation**: DJ tools each have their own library format. A CLI tool that reads/writes standard tags and uses SQLite for metadata avoids this trap.

---

## Key Insights

1. **The query language is the product**: Every successful music management tool that lasted more than a decade had a powerful query/filter language at its core. foobar2000's query syntax, beets' query language, Winamp's Smart Views, iTunes' smart playlists, Serato's smart crate rules -- they all converge on the same insight. rfmedia-cli's smart filter system is on the right track; the opportunity is to extend it with separation rules and expression templates.

2. **Separation rules are the missing link in personal music management**: Radio broadcasting solved the "playlist sounds repetitive" problem decades ago with artist separation, tempo alternation, and era distribution rules. No personal music management tool has adopted these techniques. This is the single most impactful feature gap identified in this research.

3. **Sidecar metadata beats embedded tags for dynamic data**: MPD stickers, MediaMonkey's SQLite database, and beets' database all demonstrate that play counts, ratings, mood tags, and other volatile metadata should NOT be stored in audio files. rfmedia-cli's existing SQLite infrastructure is the right foundation; extending it with an arbitrary key-value store per track would enable powerful new workflows.

4. **Event-driven beats batch for organization**: MediaMonkey's auto-organize and Serato's live-update smart crates both show that reactive, event-driven organization produces better results than periodic batch processing. rfmedia-cli's watch mode is the foundation; extending it with configurable action pipelines would be transformative.

5. **Expression languages enable user innovation**: foobar2000's title formatting language and Quod Libet's Python query plugin both show that giving users a mini-language (not just configuration options) unlocks use cases the developers never anticipated. The investment in a simple expression language pays dividends across multiple features.

6. **Deduplication needs audio fingerprinting**: Tag-based deduplication is unreliable (different tagging standards, reissues with different metadata). Audio fingerprinting (AcoustID/fpcalc) is the proven solution, available as a CLI tool, and directly addresses rfmedia-cli issue #38.

---

## Evidence Quality

| Finding                                         | Evidence Level      | Source Type                                 | Confidence |
| ----------------------------------------------- | ------------------- | ------------------------------------------- | ---------- |
| foobar2000 title formatting capabilities        | Primary             | Official documentation (Hydrogenaudio wiki) | High       |
| Radio scheduling separation rules               | Primary + Secondary | Industry documentation + Wikipedia          | High       |
| MPD sticker database architecture               | Primary             | Official documentation + GitHub             | High       |
| MediaMonkey auto-organize behavior              | Primary             | Official help documentation                 | High       |
| iTunes smart playlist nested rules              | Primary             | Apple support documentation                 | High       |
| Serato smart crate features                     | Primary             | Serato support documentation                | High       |
| beets plugin ecosystem                          | Primary             | Official documentation (ReadTheDocs)        | High       |
| "What was lost" assessments                     | Interpretive        | Multiple sources + analysis                 | Medium     |
| Revival feasibility estimates                   | Speculative         | Author analysis                             | Low-Medium |
| Radio algorithm transferability to personal use | Speculative         | Cross-domain inference                      | Medium     |

---

## Contradictions and Uncertainties

1. **Traktor's deliberate omission of smart playlists**: Traktor (by Native Instruments) intentionally lacks smart playlists, suggesting that professional DJs may prefer manual curation. This contradicts the assumption that automated organization is universally desired. It may indicate that automation is most valuable for large personal libraries, less so for performance-curated collections.

2. **AcousticBrainz shutdown**: The AcousticBrainz project (which provided genre, mood, BPM, and key data via API) was shut down, and beets deprecated its plugin. The replacement (`beets-xtractor`) requires local audio analysis instead of API calls. This suggests that centralized audio analysis services are not sustainable, and local analysis is the more durable approach.

3. **foobar2000's complexity vs. adoption**: foobar2000's title formatting is extremely powerful but has a steep learning curve. The balance between power and usability is a genuine tension. rfmedia-cli would need to provide sensible defaults with optional expression language overrides, not require expressions for basic operations.

4. **Radio scheduling at personal scale**: Radio scheduling rules were designed for 24/7 programming with audience retention metrics. Personal playlists have different constraints (no time slots, no commercial breaks, no format clocks). The separation rules concept transfers, but the category system may be overengineered for personal use unless the user has a very large library (10,000+ tracks).

5. **Sidecar metadata vs. portability**: MPD's sticker database is powerful but non-portable -- the metadata doesn't travel with the files. This creates a tension with rfmedia-cli's copy operations. Copying files to a new location loses sticker data unless the database is also synced. The mitigation is to optionally embed sticker-derived tags into copied files during the copy operation.

---

## Search Queries Executed

1. `winamp media library features history power user advanced playlist`
2. `foobar2000 advanced features title formatting components power user`
3. `MediaMonkey auto-organize rename music library features automation`
4. `iTunes smart playlist advanced features lost Apple Music history`
5. `music library management bash scripts unix philosophy command line tools`
6. `DJ software music organization crate management Traktor Serato Rekordbox features`
7. `radio automation music library management scheduling rotation algorithms`
8. `mpd music player daemon features library management advanced`
9. `amarok songbird music player features abandoned discontinued`
10. `music file organization naming convention history approaches collectors`
11. `beets music tagger command line python auto-tagging features library`
12. `foobar2000 autoplaylist query syntax masstagger replaygain features`
13. `iTunes smart playlist nested rules criteria boolean logic power user guide`
14. `radio station music scheduling separation rules artist tempo genre clock rotation`
15. `MusicBrainz Picard acoustic fingerprint auto-tagging history evolution`
16. `Serato smart crates rules automation DJ library organization`
17. `EAC exact audio copy cue sheet music archiving lossless ripping standards history`
18. `id3 tag management command line tools mid3v2 eyeD3 mutagen history`
19. `foobar2000 query syntax autoplaylist language operators fields examples`
20. `music scheduling system radio rotation categories power gold recurrent library`
21. `winamp smart views query editor media library filtering rules advanced`
22. `beets plugins fetchart chroma lyrics acousticbrainz list features`
23. `MusicMaster radio scheduling separation rules daypart tempo energy management`
24. `Lexicon DJ library management features cross-platform migration tagging`
25. `mpd sticker database ratings bookmarks custom metadata storage`
26. `cmus music player commands library management filters views unix`
27. `MediaMonkey scripting VBScript automation music library powerful features`
28. `foobar2000 file operations rename move organize pattern template`
29. `Roon music player library management features audio analysis signal path`
30. `music library deduplication detection duplicate finder fingerprint comparison approaches`
31. `ReplayGain history loudness normalization R128 EBU music album track`
32. `Quod Libet music player query language regex tag editing Python features`
33. `XMMS player Linux music history features plugins 2000s classic`

Additionally, deep-dived via web fetch into:

- beets plugin documentation (ReadTheDocs)
- RadioILoveIt song rotation article
- RadioILoveIt song categories article
