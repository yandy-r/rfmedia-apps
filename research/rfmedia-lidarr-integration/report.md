# Strategic Research Report: Lidarr API Integration for rfmedia-cli

**Research Date**: February 2026 **Output Directory**: `research/rfmedia-lidarr-integration/`
**Research Method**: Asymmetric Research Squad (8 Personas + Crucible Analysis + Synthesis)

---

## Executive Synthesis

The Lidarr API integration for rfmedia-cli presents a high-value opportunity constrained by
well-documented infrastructure fragility. Across eight independent research perspectives --
historical, contrarian, analogical, futurist, journalistic, systems-thinking, archaeological, and
negative-space analysis -- a single strategic conclusion emerged with zero dissent: **rfmedia-cli
should adopt a layered architecture that uses Lidarr for reliable local CRUD operations, bypasses
Lidarr entirely for music discovery (using Last.fm and ListenBrainz directly), and builds the
Plex-Lidarr bridge that no other tool provides.** This recommendation was validated through an
Analysis of Competing Hypotheses (ACH) evaluation where the layered approach (H6) scored 21
consistent evidence items and zero inconsistencies against 31 total evidence items -- the strongest
result in the analysis.

The research surfaced three critical architectural realities that must drive implementation. First,
Lidarr's metadata server (api.lidarr.audio) experienced five major outages in five months
(April-August 2025), its maintainers explicitly rejected requests for self-hosted alternatives
(issues #5546 and #5558, closed "Won't Fix" and locked), and it remains the single point of failure
for all search, lookup, and artist-addition operations. Second, Lidarr has zero native discovery
endpoints -- no similar artists, no recommendations, no discovery API of any kind -- meaning the
feature most users want (artist discovery) must be built independently of Lidarr, using Last.fm's
`artist.getSimilar` API (proven by Lidify's 514-star adoption) and ListenBrainz's CC0-licensed
similarity datasets (emerging as the Spotify API replacement after November 2024's permanent API
restrictions). Third, the Plex-Lidarr bridge -- identified independently by all eight research
personas as the highest-value opportunity -- is completely unserved in the ecosystem, and
rfmedia-cli is uniquely positioned to fill it given its existing Plex integration.

The most surprising discovery is that music automation's failures are fundamentally governance
problems, not technology problems. Every major gap -- metadata server outages (volunteer-maintained,
no SLA), "Won't Fix" feature rejections (small team maintaining five applications), missing
discovery endpoints (design philosophy: "Lidarr's goal is automation"), no Overseerr for music
(maintainers: "no plans") -- traces back to institutional capacity constraints, not technical
impossibility. This governance gap is structural and permanent: it creates the market rfmedia-cli
would enter and ensures that market will not be filled by Lidarr itself. The technology is ready --
Lidarr's API v1 has been stable since 2017, the TsArr TypeScript SDK (v1.11.0, February 2026)
provides auto-generated type-safe bindings, and no TypeScript CLI tool for Lidarr exists anywhere in
the ecosystem. The timing window is narrow but real: two years earlier, no TypeScript SDK existed;
two years from now, someone else will likely have built a CLI.

The recommended implementation follows three phases mapped to the layered architecture: Phase 1
(Bulk Management) delivers the most-requested features (bulk unmonitor by album type, mass profile
changes, tag management) using only reliable local API operations; Phase 2 (Discovery) implements
federated similar-artist discovery using Last.fm and ListenBrainz independently of Lidarr, with
optional add-to-Lidarr as a separate step; Phase 3 (Plex-Lidarr Bridge) creates the bidirectional
reconciliation engine that is rfmedia-cli's strategic moat -- gap analysis, rating-informed quality
decisions, and consumption-driven library policies that no other tool can provide.

**Key Findings**:

1. **The layered architecture (H6) is the decisively correct approach** -- zero disconfirming
   evidence across 31 items, validated by formal ACH analysis eliminating five alternatives
2. **Lidarr's metadata server is an irreconcilable single point of failure** -- five outages in five
   months, self-hosted alternatives explicitly rejected, no engineering mitigation possible from
   external tools
3. **The Plex-Lidarr bridge is the highest-value, completely unserved opportunity** -- universal
   convergence across all eight research personas, rfmedia-cli uniquely positioned with existing
   Plex integration
4. **Discovery must be built independently of Lidarr** -- zero discovery endpoints in the API,
   Last.fm proven as primary source, ListenBrainz emerging as open long-term alternative
5. **Bulk operations are the most immediately impactful feature** -- six years of open GitHub issues
   (#2036, #5409), only existing solutions are fragile bash scripts

**Most Surprising Discovery**: Music automation's problems are governance gaps (volunteer teams, no
institutional backing, "Won't Fix" culture), not technology gaps -- and these governance gaps are
structural, permanent, and define rfmedia-cli's market opportunity.

**Highest-Impact Insight**: rfmedia-cli is not just a bridge between two tools; it is a
**granularity translation layer** between track-level consumption (Plex) and album-level acquisition
(Lidarr) -- the same unsolved problem Beets' community identified over a decade ago, now solvable
because rfmedia-cli has both halves of the equation.

---

## Multi-Perspective Analysis

### Theme 1: The Metadata Infrastructure Problem

#### Overview

The single most consequential architectural fact for Lidarr integration is that Lidarr's metadata
server (api.lidarr.audio) is simultaneously indispensable for high-value operations and unreliable
as infrastructure. This tension was identified by four personas independently, debated across the
contradiction and tension mappings, and ultimately shaped the entire recommended architecture. The
distinction between "local-only" operations (reliable, hitting Lidarr's SQLite/Postgres directly)
and "metadata-dependent" operations (fragile, passing through api.lidarr.audio to MusicBrainz) is
not an optimization -- it is the foundational partition of the integration surface.

#### Historical Context

Lidarr's metadata architecture was born from a structural constraint: MusicBrainz enforces strict
rate limits (1 req/sec), and thousands of Lidarr instances querying MusicBrainz directly would
overwhelm the nonprofit's servers. The LidarrAPI.Metadata server (Python, established June 2017) was
built as a caching proxy -- PostgreSQL for MusicBrainz data replication, Solr for search, Redis for
caching, RabbitMQ for messaging. Unlike Sonarr and Radarr, which use well-funded third-party
metadata services (TheTVDB, TheMovieDB), Lidarr built its own proxy with just 7 contributors. This
architectural decision was rational in 2017 but created a fragility that compounds over time.

Headphones (2012-2017), Lidarr's predecessor, accessed MusicBrainz directly and hit rate limits.
Lidarr's proxy "solved" this by centralizing access, but the solution introduced a worse failure
mode: when Headphones hit rate limits, one user was affected; when api.lidarr.audio goes down, all
users globally are affected. The older, "inferior" architecture was actually more resilient.

#### Current State

Between April and August 2025, five major outages were documented:

| Issue                                                 | Date         | Duration | Cause                                                             |
| ----------------------------------------------------- | ------------ | -------- | ----------------------------------------------------------------- |
| [#5498](https://github.com/Lidarr/Lidarr/issues/5498) | April 2025   | 8+ days  | 500 Internal Server Errors                                        |
| [#5516](https://github.com/Lidarr/Lidarr/issues/5516) | May 2025     | Unknown  | Search API breakage                                               |
| [#5530](https://github.com/lidarr/Lidarr/issues/5530) | June 2025    | Unknown  | Search returning zero results                                     |
| MusicBrainz schema change                             | May 21, 2025 | Weeks    | Schema change broke metadata server; repair scripts failed        |
| [#5579](https://github.com/Lidarr/Lidarr/issues/5579) | August 2025  | Days     | v2.13.3 wiped MediaCover cache; 503 errors prevented repopulation |

The development team explicitly rejected self-hosted metadata alternatives. Issue #5546 (self-hosted
metadata) and #5558 (configurable metadata source) were both closed as "Won't Fix" and locked. A
developer stated: "no plans to allow users to use custom metadata." The metadata server rebuild has
been ongoing since May 2025 with no ETA; developers noted they have "very limited personal time."

The Lidarr API operations partition cleanly along the metadata dependency line:

**Reliable (local-only)**: `GET /api/v1/artist`, `GET /api/v1/album`, `PUT /api/v1/album/monitor`,
`PUT /api/v1/artist/editor`, `DELETE /api/v1/artist/editor`, `GET/POST /api/v1/tag`,
`GET /api/v1/wanted/missing`, `GET /api/v1/health`

**Fragile (metadata-dependent)**: `GET /api/v1/artist/lookup`, `GET /api/v1/album/lookup`,
`POST /api/v1/artist` (adding new artists), `POST /api/v1/command` (RefreshArtist, AlbumSearch,
MissingAlbumSearch)

#### Future Outlook

The Futurist assigns 60-70% probability to the scenario where the metadata server "remains a single
point of failure" with periodic outages continuing. No architectural change is planned. The
community alternative (davedean/lidmeta) exists but is unofficial and unsupported. The structural
problem is institutional, not technical: MusicBrainz data is freely available, but Lidarr's team has
decided to maintain centralized control over metadata access.

#### Critical Perspective

The Contrarian frames the metadata server as an existential risk: "Building a dependency on Lidarr
means inheriting its architectural fragility without gaining the discovery features that justify the
integration." The dependency chain is four links deep: rfmedia-cli -> local Lidarr API ->
api.lidarr.audio -> MusicBrainz. Each link is a failure point. However, the Systems Thinker provides
a concrete mitigation: separate operations by metadata dependency, check health before
metadata-dependent operations, cache results locally, and implement graceful degradation.

**Resolution**: Both the Contrarian and Systems Thinker are correct at different levels. The
Contrarian correctly identifies the risk; the Systems Thinker correctly identifies the mitigation.
The practical synthesis: build Layer 1 (bulk management) exclusively on local-only operations that
never touch the metadata server, build Layer 2 (discovery) to bypass Lidarr's metadata server
entirely by querying Last.fm/ListenBrainz directly, and treat metadata-dependent operations (artist
addition, search) as explicitly optional with deferred retry capabilities.

#### Evidence Quality

- **Confidence**: High
- **Sources**: 5 primary GitHub issues with developer acknowledgment, developer statements on closed
  issues, MetaBrainz community forum posts
- **Contradictions**: The Historian frames outages as "cyclical" within a "stable ecosystem," while
  the Contrarian treats them as an existential risk. The Systems Thinker's tiered mitigation
  strategy resolves the tension without requiring either side to be wrong.

---

### Theme 2: The Discovery Paradox -- Lidarr's Missing Feature Is rfmedia-cli's Biggest Opportunity

#### Overview

Artist discovery is the most demanded feature in the Lidarr ecosystem, yet Lidarr's API has zero
discovery endpoints. This paradox -- where the primary motivation for integration does not exist in
the integration target's API -- was identified by every persona and resolved through the insight
that discovery should be built as an independent layer that optionally feeds results into Lidarr,
not as a Lidarr API wrapper.

#### Historical Context

Music discovery has been external to collection managers in every generation of tooling:

- **Headphones era (2012-2016)**: `getSimilar` endpoint delegated to Last.fm under the hood
- **Beets era (2012-present)**: Community debated discovery as core vs. plugin; concluded it should
  be plugin
- **Lidarr era (2017-present)**: Zero native discovery; third-party tools fill the gap every 18-24
  months

The Archaeologist identified a "discovery tool half-life" of approximately 18-24 months:
docker-lidarr-extended (~3 years to archive), Lidify Spotify phase (~18 months to API lockdown),
with Aurral (January 2026) being the latest entrant. This churn is driven by external API changes
(Spotify November 2024 lockdown), maintainer burnout, and shifting technology choices. The pattern
suggests that tightly-coupled discovery implementations will face the same 18-24 month lifecycle
unless architected for source swappability.

Spotify's November 2024 API restrictions are particularly consequential: Related Artists,
Recommendations, Audio Features, and Audio Analysis endpoints were permanently restricted for new
third-party applications. Lidify switched to Last.fm-only. This is the fourth instance of the
"proprietary API death" pattern (Rdio 2015, What.CD 2016, Tidal 2023, Spotify 2024), validating the
Archaeologist's principle: "open APIs are not just ethically preferable; they are the only
sustainable integration targets for community software."

#### Current State

Three external discovery approaches exist in the ecosystem:

1. **Last.fm collaborative filtering**: Lidify (514 stars), Tubifarry (`~` prefix in search),
   Sonobarr. Mature, proven, free API with simple API key authentication. Decades of listening data.
2. **MusicBrainz tag matching**: Aurral (359 stars in first month, undergoing rebuild).
   Genre/style-based rather than listening-based. Respects MusicBrainz 1 req/sec rate limit.
3. **Lidarr import lists**: Built-in support for Spotify playlists, Last.fm user libraries, Last.fm
   tag-based. Runs on 24-hour sync schedule, not on-demand.

None of these approaches offers a CLI interface. All are either web UIs (Lidify, Aurral) or Lidarr
plugins (Tubifarry). The CLI discovery gap is confirmed and clear.

The Contrarian raises a valid concern about popularity bias: academic research (Abdollahpouri et
al., 2019; Kowald et al., 2022) documents that collaborative filtering algorithms disproportionately
recommend widely-known artists, creating filter bubbles. This applies to both Last.fm and
ListenBrainz (which also uses collaborative filtering). The mitigation is UX-level:
preview-before-add, configurable similarity thresholds, diversity boosting for obscure artists, and
transparency about recommendation sources.

#### Future Outlook

ListenBrainz (MetaBrainz Foundation) is building open, CC0-licensed replacements for deprecated
Spotify endpoints: artist similarity (available now), user recommendations, custom playlist
generation, and planned track/album similarity datasets. Data is "nowhere near as comprehensive as
Spotify" currently, but the institutional backing (MetaBrainz Foundation) and open licensing make it
the safest long-term bet. The recommended strategy: implement Last.fm first (proven, comprehensive,
available today), abstract the discovery source behind an interface, add ListenBrainz when its
coverage improves.

#### Evidence Quality

- **Confidence**: High for the gap; Medium for optimal source strategy
- **Sources**: OpenAPI spec analysis (no discovery endpoints confirmed), Lidify/Aurral GitHub
  repositories, Spotify API restriction documentation, Last.fm API documentation
- **Contradictions**: The Contrarian argues discovery is "a thin justification for a full
  integration dependency" since it bypasses Lidarr. Five other personas argue the end-to-end
  workflow (discover via Last.fm -> add via Lidarr) is valuable and proven. Resolution: discovery is
  valuable AND independent of Lidarr. The Contrarian is right that discovery does not justify deep
  Lidarr coupling; the other personas are right that the complete workflow creates unique value.

---

### Theme 3: The Plex-Lidarr Bridge as Strategic Moat

#### Overview

All eight research personas independently identified the Plex-Lidarr bridge as the highest-value
opportunity for rfmedia-cli. This universal convergence from deliberately adversarial analytical
perspectives is the strongest signal in the entire research corpus. When the Contrarian -- whose
purpose is to find reasons NOT to integrate -- still identifies the bridge as valuable, the
opportunity is exceptionally well-validated.

#### The Unserved Gap

No tool currently bridges Plex's consumption intelligence (ratings, play counts, playlists, Sonic
Analysis data) with Lidarr's collection management capabilities (monitoring, quality profiles,
acquisition automation). The only existing Plex-Lidarr connections are file-based scanning tools
(Plex Autoscan, PlexScanarr) that trigger library scans after Lidarr imports files. There is zero
data-level integration.

The Beets community identified the underlying hard problem over a decade ago: "cross-service
matching (Spotify ID to MusicBrainz ID to local files) is the hard engineering problem." This is the
same challenge the Plex-Lidarr bridge faces: mapping Plex metadata agent identifiers to MusicBrainz
IDs to Lidarr foreign artist IDs. rfmedia-cli is the first tool positioned to solve this because it
already has Plex integration (playlists, copy/filter, metadata reading) and would gain Lidarr
integration.

#### Bridge Capabilities

The bridge enables four categories of cross-system intelligence:

| Feature                  | Plex Data Source          | Lidarr Data Source  | Value                                                  |
| ------------------------ | ------------------------- | ------------------- | ------------------------------------------------------ |
| Gap analysis             | Artists in Plex library   | Artists in Lidarr   | "Artists in Plex not tracked by Lidarr"                |
| Reverse gap              | N/A                       | Artists in Lidarr   | "Lidarr artists with no files on disk"                 |
| Rating-informed quality  | Star ratings, play counts | Quality profiles    | "Upgrade highly-rated artists to FLAC"                 |
| Discovery seeding        | Top-played artists        | Library for dedup   | "Find artists similar to your most-played"             |
| Stale monitoring cleanup | Play counts = 0           | Monitored status    | "Unmonitor artists you never listen to"                |
| Duplicate detection      | Artist names, file paths  | Artist names, MBIDs | "Resolve case-sensitivity and 'The' prefix mismatches" |

The bridge operates at the artist level as the common denominator (both Plex and Lidarr model
artists), with drill-down to album/track level on demand. MusicBrainz IDs serve as the canonical
join key, though the feasibility of Plex exposing MusicBrainz IDs requires empirical validation
(Priority 1 research gap EG-3).

#### The Granularity Translation Insight

The deepest insight from the pattern recognition analysis: rfmedia-cli is not just a bridge between
two tools; it is a **granularity translation layer** between two incompatible models of music.
Lidarr operates at the album level (because Usenet/torrent distribution is album-level). Plex
operates at the track level (because consumption is track-level). This mismatch is the fundamental
reason "self-hosted music still sucks" -- and it cannot be solved by either tool alone.

rfmedia-cli's existing copy/filter functionality already performs this translation for Plex:
selecting individual tracks from albums for playlists and exports. Adding Lidarr integration
completes the loop: Plex (track-level consumption intelligence) -> rfmedia-cli (granularity
translation) -> Lidarr (album-level acquisition actions). When surfacing the bridge to users, the
CLI should make the expansion ratio explicit: "You rated 3 tracks by Artist X highly. Lidarr would
monitor all albums by Artist X (estimated 15 albums, ~180 tracks). Proceed?"

#### Evidence Quality

- **Confidence**: High for the gap; Medium for implementation feasibility (depends on empirical
  validation of Plex MusicBrainz ID availability)
- **Sources**: Ecosystem survey across npm, GitHub, awesome-arr (confirming no bridge tool exists),
  Beets discourse discussion (identifying the cross-service mapping problem), all 8 persona findings
- **Contradictions**: None. This is the only finding with universal agreement across all
  perspectives.

---

### Theme 4: Bulk Operations -- The Boring Features Users Actually Need

#### Overview

A striking pattern emerged from cross-referencing user demand (documented in GitHub issues) with
developer output (new tools being built): users most want better management of what they already
have (bulk unmonitor, mass profile changes, gap analysis), while developers build tools for getting
new things (discovery, alternative download sources, new acquisition paths). This inversion means
the most impactful features for rfmedia-cli's Phase 1 are the "boring" ones that developer
enthusiasm systematically ignores.

#### The Demand Signal

Bulk unmonitor by album type is documented across six years of GitHub issues:

- Issue #2036 (open since 2019): Monitor settings per release type
- Issue #5409 (2025): Independent monitoring controls by album type (closed as duplicate of #2036)
- Issue #3894: Mass editor hiding current "monitor new albums" value
- Issue #2302 (open since 2019): Mass editor cannot change metadata profiles

The only existing solution is a community bash script (GitHub Gist) that hits the `/album/monitor`
endpoint via curl and jq. It breaks on large libraries with "Argument list too long" errors and has
Unicode character handling issues. A proper CLI with batching, pagination, progress reporting, and
error handling would directly address the most common pain point.

#### API Surface for Bulk Operations

Lidarr's API provides efficient bulk endpoints:

| Operation                            | Endpoint                       | Metadata Dependency | Risk Level |
| ------------------------------------ | ------------------------------ | :-----------------: | :--------: |
| Bulk monitor/unmonitor albums        | `PUT /api/v1/album/monitor`    |    None (local)     |    Low     |
| Bulk update artists (tags, profiles) | `PUT /api/v1/artist/editor`    |    None (local)     |    Low     |
| Bulk delete artists                  | `DELETE /api/v1/artist/editor` |    None (local)     |   Medium   |
| Individual artist update             | `PUT /api/v1/artist/{id}`      |    None (local)     |    Low     |
| Tag CRUD                             | `GET/POST /api/v1/tag`         |    None (local)     |    Low     |
| View wanted/missing                  | `GET /api/v1/wanted/missing`   |    None (local)     |    Low     |

All bulk management operations are local-only, meaning they work against Lidarr's database without
touching the fragile metadata server. This makes them ideal for Phase 1: high demand, high
reliability, low risk.

#### Cascade Risks

The Systems Thinker warns that bulk operations can cascade non-linearly. Adding 50 artists triggers
50 metadata lookups, which discover ~1,000 albums, which generate ~1,000 indexer queries,
potentially exhausting Prowlarr's daily rate limit budget -- starving Sonarr and Radarr in the
process. However, this cascade only applies to operations that trigger metadata lookups and search
(adding artists with `searchForNewArtist: true`). Bulk monitor/unmonitor, tag management, and
profile changes are purely local and cannot cascade.

The critical design decision: default to safe operations (`searchForNewArtist: false`,
`monitored: false` for adds), implement `--dry-run` for all destructive operations, and provide
cascade analysis before executing high-risk batch operations.

#### Evidence Quality

- **Confidence**: High
- **Sources**: 6+ years of GitHub issues, community bash scripts, OpenAPI spec for endpoint
  verification
- **Contradictions**: The Systems Thinker identifies bulk operations as both the highest-value
  feature AND the highest-risk feature (self-contradiction). Resolution: this tension is productive
  -- implement bulk ops with progressive disclosure, dry-run defaults, and rate limiting. Low-risk
  bulk ops (unmonitor, tag, profile) should be prioritized over high-risk ones (bulk add with
  search).

---

### Theme 5: The TypeScript Ecosystem Opportunity

#### Overview

rfmedia-cli's TypeScript foundation positions it at a rare convergence of three trends: TypeScript
ecosystem maturity (most-used language on GitHub since August 2025), a clear TypeScript tooling gap
for Lidarr (no TypeScript CLI exists; only the TsArr library SDK from September 2025), and the
availability of auto-generated TypeScript API clients from OpenAPI specs. This window of
differentiation is narrow but real.

#### The Tooling Landscape

| Language   | API Client                                                           | CLI Tool                                    | Status                           |
| ---------- | -------------------------------------------------------------------- | ------------------------------------------- | -------------------------------- |
| Python     | pyarr (inactive since July 2023), lidarr-py (auto-generated, active) | None                                        | Clients exist but no CLI         |
| Go         | golift/starr (active, comprehensive)                                 | None                                        | Client exists but no CLI         |
| Ruby       | None active                                                          | lidarr-cli (abandoned, 0 stars, 44 commits) | Dead                             |
| TypeScript | TsArr v1.11.0 (auto-generated, active)                               | **None**                                    | Library exists; CLI gap is clear |
| Rust       | lidarr crate                                                         | None                                        | Minimal adoption                 |

The only prior TypeScript media automation tool found in the research was lumus (2016, abandoned) --
a solo project that tried to replace SickBeard, CouchPotato, and Headphones simultaneously.

#### TsArr Compatibility Question

TsArr uses Bun as its runtime and `@hey-api/openapi-ts` for code generation. Whether it works on
Node.js 22+ (rfmedia-cli's runtime) without modification is the single most impactful empirical
unknown. Since Node.js 18+ supports native `fetch`, and TsArr's HTTP layer uses fetch, compatibility
is plausible but unverified. The fallback is straightforward: generate a custom client from Lidarr's
OpenAPI spec using the same `@hey-api/openapi-ts` generator, targeting Node.js directly. This is a
low-effort investigation that should be resolved before implementation begins.

#### The Sustainability Argument for Auto-Generation

The research documented a clear lifecycle pattern: hand-maintained API wrappers (pyarr, lidarr-cli
Ruby, ArrTools) consistently fall behind and get abandoned as solo maintainers burn out.
Auto-generated SDKs (devopsarr organization, TsArr) survive because regeneration from the OpenAPI
spec is a one-command operation. rfmedia-cli should either use TsArr directly (if Node.js
compatible) or generate its own client, never hand-maintaining API bindings.

#### Evidence Quality

- **Confidence**: High for the gap; Medium for TsArr compatibility (requires empirical testing)
- **Sources**: npm search, GitHub ecosystem survey, awesome-arr, TsArr repository analysis
- **Contradictions**: None on the gap. TsArr runtime compatibility is an unresolved unknown, not a
  contradiction.

---

## Evidence Portfolio

### High-Confidence Findings

#### F1: Lidarr API has zero discovery endpoints

- **Claimed by**: Contrarian, Journalist, Negative Space (3 personas)
- **Evidence type**: Primary (direct OpenAPI spec analysis)
- **Sources**:
  [Lidarr OpenAPI Spec](https://raw.githubusercontent.com/lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json)
- **Confidence**: High
- **Significance**: Discovery must be built independently of Lidarr. This is the foundational
  architectural constraint for Layer 2.

#### F2: Metadata server experienced 5+ major outages (April-August 2025)

- **Claimed by**: Contrarian, Systems Thinker, Futurist, Historian (4 personas)
- **Evidence type**: Primary (GitHub issues with developer acknowledgment)
- **Sources**: [#5498](https://github.com/Lidarr/Lidarr/issues/5498),
  [#5579](https://github.com/Lidarr/Lidarr/issues/5579),
  [#5516](https://github.com/Lidarr/Lidarr/issues/5516),
  [#5530](https://github.com/lidarr/Lidarr/issues/5530)
- **Confidence**: High
- **Significance**: All metadata-dependent operations must be treated as best-effort, not
  guaranteed.

#### F3: Self-hosted metadata rejected ("Won't Fix")

- **Claimed by**: Contrarian, Futurist, Negative Space (3 personas)
- **Evidence type**: Primary (developer statements)
- **Sources**: [#5546](https://github.com/Lidarr/Lidarr/issues/5546),
  [#5558](https://github.com/Lidarr/Lidarr/issues/5558)
- **Confidence**: High
- **Significance**: The metadata SPOF is permanent -- no mitigation will come from Lidarr.

#### F4: Plex-Lidarr bridge is completely unserved

- **Claimed by**: All 8 personas
- **Evidence type**: Primary (ecosystem survey)
- **Confidence**: High
- **Significance**: This is rfmedia-cli's unique strategic opportunity -- no competitor can
  replicate it without both Plex and Lidarr integration.

#### F5: Last.fm is the most reliable open recommendation source

- **Claimed by**: Historian, Archaeologist, Futurist, Journalist (4 personas)
- **Evidence type**: Primary (API documentation, Lidify migration evidence)
- **Sources**: [Last.fm API](https://www.last.fm/api/show/artist.getSimilar),
  [Lidify](https://github.com/TheWicklowWolf/Lidify)
- **Confidence**: High
- **Significance**: Last.fm should be the primary discovery source; ListenBrainz the long-term
  secondary.

#### F6: No TypeScript CLI tool for Lidarr exists

- **Claimed by**: Negative Space, Journalist (2 personas)
- **Evidence type**: Primary (npm, GitHub, awesome-arr ecosystem survey)
- **Confidence**: High
- **Significance**: rfmedia-cli would be genuinely novel in the ecosystem.

#### F7: Lidarr API v1 is stable

- **Claimed by**: Futurist, Journalist, Historian (3 personas)
- **Evidence type**: Primary (release history, codebase analysis)
- **Confidence**: Medium-High
- **Significance**: Safe to build against API v1 for the next 1-2 years.

### Medium-Confidence Findings

#### F8: Track/trackfile endpoints exist but require parent context

- **Supporting evidence**: OpenAPI spec documents `GET /api/v1/track`, `GET /api/v1/trackfile`,
  `PUT /api/v1/trackfile/{id}`, `DELETE /api/v1/trackfile/bulk` (Journalist)
- **Conflicting evidence**: Contrarian stated "no track endpoint" -- resolved as a conflation of
  endpoint existence with independent query capability
- **Confidence**: High for existence; Medium for utility in bridge context
- **Significance**: The Plex-Lidarr bridge can operate at track level when parent artist/album
  context is known from Plex data.

#### F9: TsArr may work with Node.js

- **Supporting evidence**: Uses `@hey-api/openapi-ts` and native `fetch` (both Node.js compatible)
- **Conflicting evidence**: Documentation states Bun as runtime; no Node.js testing documented
- **Confidence**: Medium (requires empirical testing)
- **Significance**: Determines build-vs-buy decision for API client layer.

#### F10: ListenBrainz data completeness is limited

- **Supporting evidence**: MetaBrainz Foundation backing, CC0 licensing, growing dataset
- **Conflicting evidence**: Futurist acknowledges data is "nowhere near as comprehensive as Spotify"
- **Confidence**: Medium
- **Significance**: Viable as secondary/long-term source, not yet primary.

### Speculative Findings

#### F11: Naviseerr may replace Lidarr long-term

- **Claimed by**: Futurist
- **Plausibility**: Low (20-30% within 2 years)
- **Value if true**: rfmedia-cli's layered architecture allows backend swapping; Layers 2 and 3 are
  Lidarr-independent
- **Validation needed**: Monitor Naviseerr development progress over 12-18 months

#### F12: AI-enhanced music metadata management in 2-3 years

- **Claimed by**: Futurist
- **Plausibility**: Low-moderate for self-hosted
- **Value if true**: Future extension point for rfmedia-cli auto-tagging and smart matching
- **Validation needed**: Track open-source AI music tools development

### Critical Contradictions

#### C1: Metadata Server -- Dealbreaker vs. Manageable Risk

- **Position A**: Existential risk, avoid deep integration (Contrarian)
- **Position B**: Engineering problem with concrete mitigations (Systems Thinker, Historian)
- **Resolution**: Both correct at different levels. Adopt tiered architecture: local operations
  (reliable) separated from metadata-dependent operations (fragile). The ACH analysis H6 embodies
  this resolution.

#### C2: Integration Scope -- Narrow vs. Comprehensive

- **Position A**: Only local CRUD, avoid metadata-dependent operations (Contrarian)
- **Position B**: Comprehensive integration with discovery, bridge, and bulk management (5 other
  personas)
- **Resolution**: Tiered architecture satisfies both. Layer 1 is narrow and reliable (Contrarian
  satisfied). Layers 2 and 3 add comprehensive value with independent resilience (other personas
  satisfied).

---

## Strategic Implications

### Second-Order Effects

1. **Bulk Add Artists -> Download Queue Flooding -> Indexer Rate Limit Exhaustion**
   - CLI adds 50 artists -> each triggers metadata refresh -> Lidarr discovers ~1,000 albums ->
     searches indexers for each -> Prowlarr's query limits exhausted -> Sonarr/Radarr searches also
     fail (Prowlarr limits are per-indexer, not per-app)
   - **Timeline**: Immediate (hours after bulk add)
   - **Stakeholders impacted**: All \*arr stack users, not just Lidarr
   - **Mitigation**: Default `searchForNewArtist: false`, `--max-add N` flag, cascade analysis in
     plan/apply workflow

2. **Metadata Server Overload from CLI Usage -> Global Impact on All Lidarr Users**
   - Heavy API usage from bulk operations contributes to load on the shared metadata server -> 503
     errors affect ALL Lidarr instances globally, not just the CLI user
   - **Timeline**: Correlated with operation scale
   - **Mitigation**: Rate-limit metadata-dependent operations, check health before bulk operations,
     implement deferred retry queue

3. **"Won't Fix" Culture -> Permanent Market for External Tools**
   - Small volunteer team maintaining 5 applications -> systematic rejection of extensibility
     requests -> every rejected feature becomes an opportunity for external tools -> rfmedia-cli's
     value proposition is load-bearing on this governance gap
   - **Timeline**: Structural, ongoing
   - **Implication**: rfmedia-cli's market opportunity is stable unless Lidarr's governance model
     fundamentally changes

### Stakeholder Impacts

#### Self-Hosting Power Users (Primary Audience)

- **Opportunities**: CLI-native bulk operations, scriptable discovery, automated gap analysis
- **Threats**: Learning curve for CLI interaction; metadata server fragility affecting add
  operations
- **Recommended actions**: Start with Phase 1 bulk operations (immediate pain relief), iterate based
  on feedback

#### Lidarr Development Team

- **How they're affected**: New API consumer that could increase metadata server load and generate
  bug reports
- **Opportunities**: External tool filling gaps they cannot address due to resource constraints
- **Threats**: Bulk operations from CLI tools amplifying metadata server load
- **Recommended actions**: rfmedia-cli should rate-limit metadata-dependent operations and never
  file upstream feature requests (treat Lidarr as black-box API consumer)

#### Plex Users Without Lidarr

- **Opportunities**: Layer 2 (discovery) works without Lidarr; existing rfmedia-cli Plex features
  remain useful
- **Threats**: None -- layered architecture ensures Lidarr integration is optional

### Leverage Points

1. **Metadata Profile Selection at Add Time** (High Leverage): Defaulting to "Standard" (Albums
   only) in the CLI prevents the Singles/EPs flood that causes disk space and download queue issues.
   This single configuration choice cascades through the entire pipeline.

2. **Search-on-Add Toggle** (High Leverage): The `searchForNewArtist`/`searchForNewAlbum` flag
   determines whether Lidarr immediately floods indexers. Defaulting to `false` gives users control
   over the download pipeline.

3. **Tag-Based Organization** (Medium Leverage): Using Lidarr's tag system to mark CLI-added artists
   enables future bulk management and audit. Pattern proven by import list best practices.

4. **Plex-Lidarr Bridge** (Highest Leverage for differentiation): Cross-referencing Plex data with
   Lidarr data creates workflows no other tool can provide.

### System Dynamics

#### Quality Upgrade Cycle (Amplifying)

- **Components**: Monitored artist -> RSS/indexer check -> higher quality found -> download upgrade
  -> repeat
- **Effect**: More monitoring generates exponentially more indexer queries and download activity
- **Intervention**: Quality profile cutoff settings ("Upgrade Until") cap the maximum quality

#### Similar Artist Discovery Loop (Amplifying, User-Gated)

- **Components**: Library artists -> Last.fm similar -> add selected -> expanded seed pool -> more
  recommendations
- **Effect**: Library grows non-linearly without bounds
- **Intervention**: Loop prevention (max per seed, no cascade, visited set), user approval gate,
  `--max-add N`

---

## Research Gaps

### Critical Unknowns

1. **TsArr Node.js Compatibility** (EG-1): Whether TsArr works on Node.js 22+ without modification.
   Determines build-vs-buy for API client.
   - **Resolution method**: Install `tsarr` in rfmedia-cli workspace, test basic API calls
   - **Priority**: Critical -- blocks implementation start

2. **Plex MusicBrainz ID Availability** (EG-3): Whether Plex music library items reliably contain
   MusicBrainz IDs for bridge mapping.
   - **Resolution method**: Query existing rfmedia-cli Plex client for artist metadata, inspect GUID
     fields
   - **Priority**: Critical -- determines bridge feasibility

3. **Metadata Server Current Status** (EG-4): Current operational status of api.lidarr.audio as of
   February 2026.
   - **Resolution method**: Check recent GitHub issues, test `GET /api/v1/health` and
     `GET /api/v1/artist/lookup`
   - **Priority**: Critical -- calibrates resilience strategy

4. **Album Type Field in API Response** (EG-10): Whether Lidarr's API exposes album type (Album,
   Single, EP, etc.) in `GET /api/v1/album` responses.
   - **Resolution method**: Inspect `AlbumResource` schema in OpenAPI spec
   - **Priority**: Critical -- blocks the highest-demand Phase 1 feature

### Empirical Gaps

- **Bulk add performance under load** (EG-2): No data on what happens when adding 50-200+ artists
  via API in rapid succession. Only one data point exists (blog post: "~50 min for 3000 artists").
- **API pagination mechanics** (EG-5): Maximum page sizes, default limits, behavior when results
  exceed limits. rfmedia-cli already solved Plex pagination (recent PR #192); Lidarr pagination must
  be equally robust.
- **Artist editor request format** (EG-6): Exact JSON body structure for `PUT /api/v1/artist/editor`
  (bulk update).
- **Last.fm rate limits** (EG-7): Estimated at ~5 req/sec but not officially documented or tested.
- **Delete endpoint file behavior in Docker** (EG-9): Whether `deleteFiles=true` reliably removes
  files through Docker volume mounts.

### Theoretical Gaps

- **Plex-Lidarr data model mapping** (TG-1): No formal mapping between Plex and Lidarr entity models
  exists.
- **Discovery feedback loop prevention model** (TG-3): No formalization of how discovery cascades
  should be bounded (depth-limited BFS, visited set size, optimal max-per-seed).
- **Backend abstraction interface design** (TG-5): The recommended `MusicCollectionManager`
  interface needs to balance Lidarr-specific features with swappability.

### User Research Gaps

- **Plex + Lidarr user overlap** (UG-1): How many rfmedia-cli users also run Lidarr? The
  rfmedia-apps compose.yml includes Lidarr in the arr-stack profile, suggesting the overlap is high
  for this specific user base.
- **CLI discovery UX preferences** (UG-2): Whether CLI-based music discovery is desirable vs. web UI
  (Lidify, Aurral).

### Recommended Resolution Sequence

1. **Immediate (before implementation)**: EG-1, EG-3, EG-4, EG-10 -- four empirical tests
   completable in a single focused session
2. **Pre-Phase 1**: EG-5, EG-6, TG-4 -- required for robust bulk management
3. **Pre-Phase 2**: EG-7, EG-8, TG-3 -- required for discovery feature
4. **Pre-Phase 3**: EG-2, EG-9, TG-1, UG-1 -- required for bridge implementation

---

## Temporal Analysis

### Historical Patterns (2011-2025)

- **The Ecosystem Fork Chain**: NzbDrone (2011) -> Sonarr (2014) -> Radarr (2016) -> Lidarr (2017).
  Time between forks shortened (3y, 2y, 1y) but quality/stability decreased as media complexity
  increased. Music is fundamentally harder than video.
- **The "Discovery Is Always External" Cycle**: Every generation of music automation has discovery
  external to the collection manager. Headphones delegated to Last.fm; Lidarr has zero discovery
  endpoints. rfmedia-cli building discovery as Layer 2 (independent of Lidarr) is the third time the
  community has arrived at this conclusion.
- **The "Rdio Pattern" of Proprietary API Death**: Rdio (2015), What.CD (2016), Tidal (2023),
  Spotify (2024). After each death, the ecosystem converges on open alternatives. Open APIs are the
  only historically validated survival strategy.
- **Composable Beats Monolithic**: docker-lidarr-extended (monolithic Docker container) was archived
  July 2023. arr-scripts (composable shell scripts) survived. The pattern also echoes the broader
  monolith-to-microservices-to-service-mesh progression.

### Current Dynamics (2025-2026)

- **Momentum**: The \*arr ecosystem's growth vector is companion tools and integrations, not new
  forks. TypeScript tooling is emerging (TsArr September 2025).
- **Inflection points**: Spotify API lockdown (November 2024) permanently shifted the discovery
  ecosystem toward open APIs. Lidarr metadata server crisis (May 2025) exposed fundamental
  infrastructure fragility.
- **Emerging trends**: Configuration-as-code for \*arr stack (Buildarr, praxrr), auto-generated SDKs
  from OpenAPI specs, convergence projects (Naviseerr).
- **Fading trends**: Streaming service API integrations for download automation (Tidal, Deezer),
  hand-maintained API wrappers (pyarr, lidarr-cli).

### Future Trajectories (2026-2028)

- **Consensus**: Lidarr's API v1 will remain stable for the next 1-2 years. Self-hosted music will
  remain harder than video. Last.fm will remain the primary open recommendation source.
- **Contrarian**: ListenBrainz may overtake Last.fm as the default discovery API due to open
  licensing and MetaBrainz institutional backing. Naviseerr-style convergence tools may fragment the
  ecosystem.
- **Wild cards**: AI-enhanced self-hosted music management (local models for auto-tagging, smart
  matching, natural language queries). Probability low-moderate within 2 years.

---

## Cross-Domain Insights

### The Service Mesh Analogy

The monolith-to-microservices-to-service-mesh progression in web architecture maps precisely onto
music automation's evolution: Phase 1 (Headphones as monolith, 2012-2016), Phase 2 (fragmented tools
as microservices, 2017-2025), Phase 3 (coordination layer as service mesh, emerging). rfmedia-cli is
building the "service mesh" for the self-hosted music stack -- the coordination layer that makes
existing tools interoperate intelligently. Naviseerr attempts Phase 3 through re-monolithification
(combining everything into one app); rfmedia-cli attempts it through orchestration (coordinating
existing apps via APIs). History suggests the orchestration approach is more sustainable.

### The Git Offline Workflow Analogy

Git enables productive work when the remote is unreachable: commit locally, push when connectivity
returns. rfmedia-cli's recommended "deferred resolution queue" (Innovation 1) applies this pattern
to Lidarr: when the metadata server is down, record the user's intent (add artist, search, refresh)
in a local SQLite queue and automatically replay when the service recovers. No existing Lidarr tool
implements this pattern.

### The Infrastructure-as-Code Pattern

rfapps-cli already implements a plan/apply workflow for Docker service deployments. Applying the
same Terraform/Pulumi-inspired pattern to Lidarr bulk operations (Innovation 3) would bring
infrastructure-as-code discipline to music library management -- preview the cascade before
executing, serialize plans as reviewable JSON artifacts, apply later when conditions are right.

### Universal Pattern: Open APIs as the Only Sustainable Integration Target

Four proprietary API deaths in music automation history (Rdio 2015, What.CD 2016, Tidal 2023,
Spotify 2024) versus zero deaths for open APIs (MusicBrainz stable since 2000, Last.fm stable for
15+ years, ListenBrainz emerging with CC0 licensing). This is not coincidence -- it is a repeating
structural truth. Building on open APIs is a hard constraint, not a soft preference.

---

## Novel Hypotheses

### Hypothesis 1: Antifragile Metadata Architecture (Deferred Resolution Queue)

- **Combines**: Contrarian's risk identification + Systems Thinker's mitigation framework + Git's
  offline workflow model
- **Rationale**: Instead of treating metadata server outages as errors to handle, design rfmedia-cli
  to never lose user intent. When metadata-dependent operations fail, write the intent to a local
  SQLite queue and auto-replay when services recover.
- **Testable prediction**: Users will rate rfmedia-cli higher in satisfaction during metadata server
  outages than any existing Lidarr tool
- **Potential impact**: Transforms the ecosystem's biggest weakness into rfmedia-cli's strongest
  differentiator
- **Implementation**: Extends existing rfmedia-cli infrastructure (SQLite database, queue system,
  operation history)

### Hypothesis 2: Federated Discovery Engine with Anti-Popularity-Bias Correction

- **Combines**: Archaeologist's Headphones `getSimilar` pattern + Futurist's ListenBrainz data +
  Contrarian's academic research on popularity bias + existing Plex integration
- **Rationale**: Combine Last.fm collaborative filtering, ListenBrainz open data, MusicBrainz tag
  relationships, AND Plex personal listening history into a weighted composite score with
  configurable diversity boosting for obscure artists
- **Testable prediction**: Multi-source recommendations will have higher "conversion rate" (added
  artist -> actually listened to) than single-source
- **Potential impact**: No existing tool combines more than two similarity signals; four-source
  discovery with anti-bias correction is unprecedented

### Hypothesis 3: Plan/Apply Workflow for Lidarr Bulk Operations

- **Combines**: rfapps-cli's existing plan/apply pattern + Systems Thinker's cascade analysis +
  Contrarian's risk concerns
- **Rationale**: Every mutation gets a "plan" phase computing the full cascade before any API call.
  Plans are serializable JSON artifacts that can be reviewed, shared, and partially applied.
- **Testable prediction**: Users will execute 3x more bulk operations when they can preview the
  cascade first
- **Potential impact**: Brings infrastructure-as-code discipline to music library management;
  cross-service Prowlarr budget estimation is unprecedented

### Hypothesis 4: Listening Intelligence Bridge (Consumption-Driven Library Policies)

- **Combines**: Negative Space's bridge gap identification + Futurist's Plex Sonic Analysis data +
  Systems Thinker's feedback loops + Archaeologist's Beets cross-service mapping challenge
- **Rationale**: Declarative YAML policies that translate Plex consumption signals (play counts,
  ratings) into Lidarr management actions (quality upgrades, unmonitoring, discovery seeding)
- **Testable prediction**: Users with consumption-driven policies will achieve higher satisfaction
  with their library at lower storage cost
- **Potential impact**: This is the "killer feature" that no competitor can replicate without both
  Plex and Lidarr integration

---

## Methodological Notes

### Research Execution

- **Personas deployed**: 8 (Historian, Contrarian, Analogist, Futurist, Journalist, Systems Thinker,
  Archaeologist, Negative Space Explorer)
- **Total search queries**: ~230 across all personas
- **Analysis phases**: 3 (Phase 1: Persona Research, Phase 2: Crucible Analysis + Contradiction
  Mapping, Phase 3: Tension Mapping + Pattern Recognition + Negative Space + Innovation Synthesis)
- **Total artifacts created**: 16 (1 objective, 8 persona findings, 6 synthesis documents, 1
  evidence verification log)

### Evidence Quality Distribution

- **Primary sources**: ~70% (GitHub repositories, issue trackers, OpenAPI specifications, API
  documentation, developer statements)
- **Secondary sources**: ~25% (comparison articles, blog posts, community forums, tool READMEs)
- **Speculative claims**: ~5% (future predictions, Naviseerr viability, AI timeline)
- **Contradictions identified**: 14 (per contradiction mapping)
- **Contradictions resolved**: 12 (2 identified as irreconcilable: metadata server SPOF,
  album-centric acquisition model)

### Confidence Assessment

- **Overall confidence**: High for current state analysis and architectural recommendations; Medium
  for future predictions and discovery source strategy; Low for AI timeline and Naviseerr viability
- **Strongest areas**: Lidarr API surface (directly verified from OpenAPI spec), metadata server
  fragility (multiple primary sources with developer acknowledgment), ecosystem tooling gap
  (comprehensive survey across npm, GitHub, awesome-arr)
- **Weakest areas**: ListenBrainz coverage depth (untested), TsArr Node.js compatibility (untested),
  Plex MusicBrainz ID availability (untested), bulk add performance under load (single data point)
- **Key uncertainties**: Metadata server current operational status, Plex MBID availability, TsArr
  runtime compatibility

### Limitations

- **No empirical testing**: All findings are based on documentation review, GitHub issue analysis,
  and third-party tool inspection. No first-hand API interaction data was gathered.
- **No user research**: User needs are inferred from GitHub issues and tool adoption metrics, not
  validated through surveys or interviews.
- **No codebase impact analysis**: How the integration fits into rfmedia-cli's existing architecture
  (Plex client patterns, config system, command/action separation) was not examined.
- **English-language bias**: Searches may have missed tools from non-English-speaking communities.
- **Survivorship bias**: Research can only study tools that left GitHub/npm traces, not personal
  scripts that were never shared.

---

## Recommendations

### For Implementation (rfmedia-cli Development)

1. **Resolve critical empirical gaps before coding**
   - Test TsArr Node.js compatibility (EG-1)
   - Verify Plex MusicBrainz ID availability (EG-3)
   - Check metadata server current status (EG-4)
   - Confirm album type field in API response (EG-10)
   - **Rationale**: These four tests, completable in one session, resolve the most impactful
     unknowns
   - **Risk**: Starting implementation without these tests could lead to architectural rework

2. **Phase 1: Bulk Management (Layer 1) -- Start Here**
   - `rfmedia lidarr status` -- library overview
   - `rfmedia lidarr list` -- list artists with filtering
   - `rfmedia lidarr unmonitor --type singles,eps` -- bulk unmonitor by album type
   - `rfmedia lidarr tag --add "cli-managed"` -- tag management
   - `rfmedia lidarr profile --set "FLAC" --tag "premium"` -- bulk quality profile changes
   - **Rationale**: Highest immediate demand, lowest risk (local-only operations), fills the
     most-requested gap
   - Implement plan/apply workflow with `--dry-run` default for destructive operations
   - Use auto-generated API client (TsArr or custom from OpenAPI spec)

3. **Phase 2: Discovery (Layer 2) -- Independent of Lidarr**
   - `rfmedia lidarr discover --artist "Radiohead"` -- multi-source similar artist discovery
   - `rfmedia lidarr discover --from-plex-playlist "Favorites"` -- Plex-seeded discovery
   - `rfmedia lidarr add --artist "New Artist" --unmonitored` -- add with safe defaults
   - **Rationale**: Fills the CLI discovery gap; Last.fm is proven and reliable
   - Default to preview mode, not auto-add
   - Implement loop prevention from day one (max per seed, visited set, no cascade)
   - Abstract discovery source behind interface for future ListenBrainz addition

4. **Phase 3: Plex-Lidarr Bridge (Layer 3) -- Strategic Moat**
   - `rfmedia lidarr reconcile` -- bidirectional gap analysis
   - `rfmedia lidarr policy evaluate` -- consumption-driven library policies
   - `rfmedia lidarr timeline` -- temporal library intelligence
   - **Rationale**: Completely unserved gap; unique to rfmedia-cli; highest differentiation
   - Bridge at artist level using MusicBrainz IDs as canonical join key
   - All bridge operations are read + suggest by default; writes require explicit `--apply`

5. **Architectural principles**
   - Never hand-maintain API bindings; use auto-generated client
   - Abstract Lidarr behind a `MusicCollectionManager` interface for future backend swappability
   - Implement deferred resolution queue for metadata-dependent operations that fail
   - Respect rate limits aggressively; cache everything; default to safe operations

### For Further Research

1. **Empirical validation sprint**: Set up a test Lidarr instance with 50 artists, exercise key API
   operations, document actual behavior (pagination, bulk add performance, error responses, delete
   file behavior). This would resolve EG-1 through EG-6 and EG-9 through EG-10 in a single focused
   effort.

2. **Codebase impact analysis**: Examine rfmedia-cli's existing patterns (Plex client, config system
   `.rfmedia.yaml`, command/action separation, output formatters, plugin system) to define the
   integration's architectural home before implementation begins.

3. **User signal gathering**: GitHub issue asking "Would you use Lidarr integration? What operations
   matter most?" to validate demand assumptions.

4. **ListenBrainz coverage assessment**: Query the ListenBrainz Labs API with 50 artists spanning
   genres to measure hit rate and determine viability as a primary discovery source.

---

## Conclusion

The Lidarr API integration for rfmedia-cli is a strategically sound endeavor with a clearly defined
architecture, well-understood risks, and a unique value proposition. The research decisively
recommends a **layered architecture** (H6) that partitions the integration into three independently
valuable layers: bulk management (reliable, local-only), discovery (independent, open APIs), and the
Plex-Lidarr bridge (unique, differentiating). This architecture was validated through formal ACH
analysis against five competing hypotheses, scoring zero disconfirming evidence and the highest
consistency across 31 evidence items.

The most important insight is not about any single API endpoint or library -- it is about
positioning. rfmedia-cli would be the first tool to bridge track-level music consumption (Plex) with
album-level music acquisition (Lidarr), solving a problem the Beets community identified over a
decade ago. This bridge is the strategic moat: it requires both integrations, no competitor has
both, and the underlying Plex-Lidarr gap is structural (different data models, different
granularity) rather than incidental (someone just hasn't gotten around to building it). The
governance gap that creates the market for external Lidarr tools is equally structural -- small
volunteer teams maintaining five applications will continue to reject extensibility requests,
ensuring rfmedia-cli's opportunity persists.

The path forward is empirical before it is architectural: four critical tests (TsArr compatibility,
Plex MBID availability, metadata server status, album type field) can be completed in a single
session and resolve the unknowns that would otherwise block implementation. After that, Phase 1
(bulk management) delivers immediate value with minimal risk, Phase 2 (discovery) fills the CLI gap
that no existing tool addresses, and Phase 3 (the bridge) creates the feature that makes rfmedia-cli
uniquely and permanently valuable.

**Bottom Line**: Lidarr integration should be built as a layered, resilient architecture where
Lidarr handles what it does reliably (local CRUD), open APIs handle what Lidarr cannot do
(discovery), and rfmedia-cli creates what no tool has ever built: a consumption-informed bridge
between Plex and Lidarr that translates between how users listen to music and how the \*arr
ecosystem acquires it.

---

## Appendices

### A. Research Artifacts

| Artifact                 | Path                                  | Purpose                                                       |
| ------------------------ | ------------------------------------- | ------------------------------------------------------------- |
| Research Objective       | `objective.md`                        | Core research questions and success criteria                  |
| Historian Findings       | `persona-findings/historian.md`       | Timeline, temporal patterns, failed attempts                  |
| Contrarian Findings      | `persona-findings/contrarian.md`      | Disconfirming evidence, expert critiques, documented failures |
| Futurist Findings        | `persona-findings/futurist.md`        | Roadmap, emerging features, future scenarios                  |
| Journalist Findings      | `persona-findings/journalist.md`      | Current API state, key players, trends                        |
| Systems Thinker Findings | `persona-findings/systems-thinker.md` | System map, feedback loops, causal chains                     |
| Archaeologist Findings   | `persona-findings/archaeologist.md`   | Old solutions, discontinued tools, revival candidates         |
| Negative Space Findings  | `persona-findings/negative-space.md`  | Missing features, adoption barriers, unsolved problems        |
| Crucible Analysis        | `synthesis/crucible-analysis.md`      | ACH evaluation of 6 competing hypotheses                      |
| Contradiction Mapping    | `synthesis/contradiction-mapping.md`  | 14 contradictions across personas                             |
| Tension Mapping          | `synthesis/tension-mapping.md`        | 18 structural tensions across 5 categories                    |
| Pattern Recognition      | `synthesis/pattern-recognition.md`    | Cross-cutting patterns and historical echoes                  |
| Negative Space Synthesis | `synthesis/negative-space.md`         | 30 prioritized research gaps                                  |
| Innovation Synthesis     | `synthesis/innovation.md`             | 8 novel hypotheses from cross-persona collision               |
| Evidence Verification    | `evidence/verification-log.md`        | Verification status for key findings                          |

### B. Persona Summaries

- **Historian**: Provided the 15-year timeline of music automation (NzbDrone to TsArr), identified 5
  temporal patterns (fork chain, metadata bottleneck, discovery gap-filling, API wrapper lifecycle,
  Python-to-TypeScript migration), and documented 6 failed approaches. Key contribution: "composable
  beats monolithic" lesson from docker-lidarr-extended's failure.

- **Contrarian**: Identified 5 strong contradictions to common beliefs about Lidarr integration,
  documented 5 failure modes (metadata outages, OPUS corruption, hardlink corruption, duplicate
  creation, compilation handling), and raised academic research on recommendation bias. Key
  contribution: the insight that "similar artists" -- the primary integration motivator -- does not
  exist in Lidarr's API.

- **Futurist**: Mapped Lidarr's roadmap (or lack thereof), documented Spotify API restrictions and
  ListenBrainz emergence, assessed 5 future scenarios with probability estimates, and identified
  Plex Sonic Analysis as untapped metadata. Key contribution: the prediction that ListenBrainz will
  become the default discovery API.

- **Journalist**: Produced the most comprehensive API documentation: 80+ endpoints cataloged across
  15 endpoint categories, with authentication details, command parameters, and known gotchas. Key
  contribution: factual reference for all API operations, correcting the Contrarian's claim about
  missing track endpoints.

- **Systems Thinker**: Created the system architecture map, identified 5 feedback loops, mapped 3
  causal chains for CLI operations, and analyzed 5 stakeholder groups. Key contribution: the cascade
  analysis showing how bulk operations affect the entire \*arr stack through Prowlarr rate limits.

- **Archaeologist**: Documented 8 old solutions (Headphones, Beets, pylast, musicbrainzngs,
  Pianobar, Gazelle, FlexGet, Whipper), 6 discontinued Lidarr integrations (lidarr-cli Ruby, pyarr,
  aiopyarr, docker-lidarr-extended, ArrTools, lumus), and 7 revival candidates. Key contribution:
  the loop prevention pattern from docker-lidarr-extended and the cross-service identifier mapping
  challenge from Beets.

- **Negative Space Explorer**: Identified 23 distinct gaps with source citations, examined 30+
  GitHub issues, audited 15+ community tools, and documented 5 features nobody is building. Key
  contribution: confirming that the TypeScript CLI gap and Plex-Lidarr bridge gap are both real and
  unserved.

### C. Key Sources

#### Primary Sources -- Lidarr

- [Lidarr GitHub Repository](https://github.com/Lidarr/Lidarr) -- Source code, issues, releases
- [Lidarr OpenAPI Specification](https://raw.githubusercontent.com/lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json)
  -- Complete API definition
- [LidarrAPI.Metadata Repository](https://github.com/Lidarr/LidarrAPI.Metadata) -- Metadata server
  architecture
- [Servarr Wiki - Lidarr](https://wiki.servarr.com/lidarr) -- Settings, FAQ, troubleshooting

#### Primary Sources -- GitHub Issues (Key)

- [#5498](https://github.com/Lidarr/Lidarr/issues/5498) -- Metadata server 8+ day outage
- [#5579](https://github.com/Lidarr/Lidarr/issues/5579) -- MediaCover cache wipe and 503s
- [#5546](https://github.com/Lidarr/Lidarr/issues/5546) -- Self-hosted metadata rejected
- [#5558](https://github.com/Lidarr/Lidarr/issues/5558) -- Custom metadata source rejected
- [#5409](https://github.com/Lidarr/Lidarr/issues/5409) -- Independent monitoring by album type
- [#2036](https://github.com/lidarr/Lidarr/issues/2034) -- Monitor settings per release type (open
  since 2019)
- [#404](https://github.com/lidarr/Lidarr/issues/404) -- Manual usage (developer: "Lidarr's goal is
  automation")
- [#791](https://github.com/Radarr/Radarr/issues/791) -- Original Lidarr proposal (rejected in 27
  minutes)

#### Primary Sources -- Ecosystem Tools

- [TsArr](https://github.com/robbeverhelst/TsArr) -- TypeScript SDK for Servarr APIs
- [Lidify](https://github.com/TheWicklowWolf/Lidify) -- Last.fm-based artist discovery
- [Aurral](https://github.com/lklynet/aurral) -- MusicBrainz tag-based discovery
- [golift/starr](https://github.com/golift/starr) -- Go API client for all \*arr apps
- [Soularr](https://github.com/mrusse/soularr) -- Lidarr-Soulseek bridge
- [Tubifarry](https://github.com/TypNull/Tubifarry) -- Lidarr plugin with similar artists
- [docker-lidarr-extended](https://github.com/RandomNinjaAtk/docker-lidarr-extended) -- Archived
  Lidarr automation container
- [Beets](https://github.com/beetbox/beets) -- CLI music library manager

#### Primary Sources -- APIs

- [Last.fm API - artist.getSimilar](https://www.last.fm/api/show/artist.getSimilar) -- Primary
  discovery source
- [ListenBrainz Labs API](https://labs.api.listenbrainz.org/) -- Emerging open discovery source
- [MusicBrainz API](https://musicbrainz.org/doc/MusicBrainz_API) -- Canonical music metadata
- [Spotify API Restrictions](https://voclr.it/news/why-spotify-has-restricted-its-api-access-what-changed-and-why-it-matters-in-2026/)
  -- November 2024 lockdown

#### Secondary Sources

- [Self-Hosted Music Still Sucks in 2025](https://www.joekarlsson.com/2025/06/self-hosted-music-still-sucks-in-2025/)
  -- Joe Karlsson's critique
- [MetaBrainz Community - Lidarr Metadata](https://community.metabrainz.org/t/for-those-using-lidarr-and-musicbrainz-metadata/768255)
  -- Metadata server status
- [TRaSH Guides - Prowlarr Limited API](https://trash-guides.info/Prowlarr/prowlarr-setup-limited-api/)
  -- Rate limit configuration
- [awesome-arr](https://ravencentric.cc/awesome-arr/) -- Comprehensive ecosystem listing
- [Popularity Bias in Music Recommendation (Kowald et al.)](https://arxiv.org/abs/2208.09517) --
  Academic research on recommendation bias

---

_This research was conducted using the Asymmetric Research Squad methodology, deploying 7
specialized research personas followed by crucible analysis (ACH), contradiction mapping, tension
mapping, pattern recognition, negative space analysis, and innovation synthesis._
