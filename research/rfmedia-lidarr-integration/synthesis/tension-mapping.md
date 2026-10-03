# Tension Mapping: Lidarr API Integration for rfmedia-cli

## Overview

This document identifies the deepest tensions, unresolved debates, and irreconcilable value
conflicts across all eight persona findings, the crucible analysis, and the contradiction mapping
for the Lidarr API integration research. Where the contradiction mapping catalogs factual
disagreements and resolves them, this tension mapping goes deeper: it surfaces the structural forces
pulling in opposite directions that **cannot be resolved by choosing a side** -- only navigated
through explicit tradeoffs. There are 18 tensions organized across 5 categories. The three most
consequential are: the Lidarr team's automation philosophy versus rfmedia-cli's curation philosophy
(T2), the metadata server's simultaneous indispensability and unreliability (T7), and the
fundamental mismatch between album-centric acquisition and track-level consumption (T10).

---

## 1. Stakeholder Tensions

### T1: Lidarr Developers vs. External Tool Builders

**The tension:** Lidarr's core team designs the software for autonomous, unattended automation
("Lidarr's goal is automation" -- developer response on issue #404). rfmedia-cli is a CLI tool
designed for intentional, user-initiated operations. These philosophies are structurally
incompatible.

**Evidence of conflict:**

- Issues #5546 (self-hosted metadata), #5558 (configurable metadata source), #5554 (manual metadata
  entry), #5517 (flexible file renaming) were all closed "Won't Fix" and some locked, explicitly
  rejecting the extensibility that external tools need.
- The Contrarian documented that Lidarr's developers view manual/CLI-driven workflows as "outside
  the intended scope."
- The Negative-Space persona identified a "Won't Fix culture for extensibility requests" as a
  systemic adoption barrier.
- Yet the Archaeologist found that every successful Lidarr companion tool (Lidify, Soularr, Aurral,
  ArrTools, Huntarr) works around these limitations by treating the API as a data layer rather than
  respecting the application's intended workflow.

**Who wants what:**

| Stakeholder                                   | Goal                                                                                   | rfmedia-cli alignment                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Lidarr core team                              | Minimize support burden, maintain automated workflows, control metadata infrastructure | Low -- external tools generate edge-case bug reports                                |
| External tool builders (Lidify, Aurral, etc.) | Extensible API, reliable metadata, pluggable architecture                              | Medium -- same constraints, different approaches                                    |
| Self-hosting power users                      | Scriptable, composable operations with full control                                    | High -- rfmedia-cli's primary audience                                              |
| Casual self-hosters                           | Set-and-forget with occasional manual intervention                                     | Medium -- rfmedia-cli could serve both, but CLI inherently skews toward power users |

**Why it cannot be resolved:** rfmedia-cli cannot change Lidarr's development philosophy. The team
has made clear they will not add features that support external CLI-driven workflows. rfmedia-cli
must work within the existing API surface, accepting that some desired operations (configurable
metadata sources, track-level acquisition, matching threshold tuning) are permanently unavailable.

**Navigation strategy:** Treat Lidarr as a black-box API consumer, not a partner in a shared
architecture. Do not file feature requests upstream. Build resilience at the edges. Accept the API
as-is and work around its gaps independently.

---

### T2: Automation Philosophy vs. Curation Philosophy

**The tension:** Lidarr's entire design assumes automation is desirable: monitor an artist,
automatically find and download everything they release, automatically upgrade quality,
automatically rename files. rfmedia-cli's value proposition is the opposite: give users informed
control over their collection through intentional commands with previews, dry-runs, and selective
operations.

**Evidence of conflict:**

- The Systems-Thinker mapped amplifying feedback loops (quality upgrade cycle, import list snowball)
  that are features from Lidarr's perspective but risks from a CLI perspective.
- The Archaeologist found that docker-lidarr-extended's "related artist loop" problem required
  explicit loop-prevention configuration -- the automation wanted to keep going, the user wanted it
  to stop.
- The Negative-Space persona identified that "Users want discovery but fear library bloat" -- the
  desire for new music conflicts with the desire for a curated collection.
- The Contrarian raised academic research on popularity bias in recommendation systems, showing that
  automated discovery converges on homogeneous mainstream music rather than genuinely expanding
  horizons.

**The deeper conflict:** Lidarr assumes more music is always better. rfmedia-cli's users may believe
the opposite -- that a curated, high-quality collection is more valuable than a comprehensive one.
These are fundamentally different value systems that produce different design decisions at every
level.

**Navigation strategy:** Default to curation (preview, dry-run, unmonitored). Make automation opt-in
with explicit flags (`--auto-add`, `--search`, `--monitor-all`). Every command that triggers
Lidarr's automation should require the user to explicitly choose it.

---

### T3: MusicBrainz Foundation vs. Lidarr's Usage Pattern

**The tension:** MusicBrainz is a nonprofit with limited infrastructure, enforcing strict rate
limits (1 req/sec). Lidarr's metadata server exists specifically because direct MusicBrainz API
usage by thousands of Lidarr instances would overwhelm MusicBrainz's servers. But the metadata
server itself is volunteer-maintained with no SLA, creating a fragile proxy layer. Adding another
consumer (rfmedia-cli, if it queries MusicBrainz directly for discovery) adds more load to an
already constrained resource.

**Evidence of conflict:**

- The Systems-Thinker documented that bulk operations through rfmedia-cli contribute to metadata
  server load that affects ALL Lidarr instances globally.
- The Futurist noted MusicBrainz's 2025 Summer of Code focused on search engine optimization,
  suggesting infrastructure is under strain.
- The Contrarian documented that community requests for configurable metadata endpoints were
  rejected partly to prevent strain on MusicBrainz.

**Navigation strategy:** Respect rate limits aggressively. Cache everything. Use Last.fm for
discovery (separate infrastructure from MusicBrainz). When querying MusicBrainz directly, implement
proper User-Agent headers and stay well within the 1 req/sec limit. Never trigger bulk metadata
refreshes through Lidarr that would cascade into metadata server load.

---

### T4: Plex Users vs. Lidarr Users -- Overlapping but Distinct Populations

**The tension:** The Plex-Lidarr bridge (identified by all eight personas as the highest-value
feature) assumes users run both Plex and Lidarr. But these populations do not perfectly overlap.
Some Plex music users do not use Lidarr (they manage their library manually or through Beets). Some
Lidarr users do not use Plex (they use Navidrome, Jellyfin, or Funkwhale). The bridge feature serves
only the intersection.

**Evidence of conflict:**

- The Futurist documented Naviseerr's plan to replace both Lidarr and Plex with Navidrome-based
  playback, suggesting the intersection may shrink.
- The Historian noted that "self-hosted music still sucks" analyses describe fragmented tooling
  where users pick different combinations.
- The Negative-Space persona found that no Overseerr equivalent exists for music, meaning the
  "request" workflow that unifies users around Plex for video does not exist for music.

**Navigation strategy:** Design each layer of the integration to work independently. Layer 1 (bulk
Lidarr management) serves Lidarr users regardless of media server. Layer 2 (discovery) serves anyone
interested in music recommendations. Layer 3 (bridge) requires both Plex and Lidarr but degrades to
showing data from whichever system is available.

---

## 2. Value Tensions

### T5: Reliability vs. Feature Richness

**The tension:** This is the master tension that subsumes many others. The Contrarian makes a
compelling case that Lidarr integration should be minimal and reliable. Five other personas make
compelling cases that rich integration creates unique value. Both are right. The question is not
"which is correct" but "where does the boundary sit."

**Evidence of conflict:**

- The Contrarian's evidence: 5 metadata server outages in 5 months, file corruption from automation,
  "Won't Fix" for reliability improvements, album-centric mismatch.
- The Historian/Journalist/Archaeologist/Negative-Space/Systems-Thinker's evidence: unserved
  Plex-Lidarr bridge, bulk operations are the most requested feature, CLI tooling gap is clear,
  discovery demand is proven by Lidify/Aurral adoption.

**The crucible analysis resolved this formally:** H6 (layered architecture) scored 0 inconsistencies
against 21 consistencies. But the tension remains in implementation: every feature added to the
"comprehensive" layers is a feature that can fail when external services degrade.

**The unresolved question:** How much of Layer 2 (discovery) and Layer 3 (bridge) is truly
independently useful versus dependent on Lidarr being healthy? If the metadata server is down, can
the user still discover artists via Last.fm? (Yes.) Can they see the Plex-Lidarr gap analysis? (Yes,
from cached data.) Can they add the discovered artist to Lidarr? (No -- the add operation may fail.)
The value diminishes at the "last mile" of integration, which is exactly where Lidarr's fragility
lives.

**Navigation strategy:** The crucible's layered architecture is the correct structural answer. But
within each layer, bias toward operations that complete locally. Discovery should be useful without
Lidarr (showing results, caching them). The bridge should be useful without adding anything to
Lidarr (showing gaps, generating reports). The "apply" step that writes to Lidarr should be
explicitly optional and resilient to failure.

---

### T6: Simplicity vs. Power

**The tension:** The CLI should be simple enough for a casual user to run `rfmedia lidarr status`
and get useful output. It should also be powerful enough for a power user to run
`rfmedia lidarr unmonitor --type singles,eps --tag "needs-review" --older-than 90d --dry-run` and
get precise control. These goals produce different design pressures.

**Evidence of conflict:**

- The Futurist noted a UX shift in the ecosystem from CLI to GUI, with the community "moving away
  from maintaining complex config files and toward 'Set and Forget' dashboards."
- The Negative-Space persona found that the biggest gap is a bridge tool, not a management tool --
  suggesting simple, high-level operations matter more than granular control.
- The Archaeologist documented that successful tools (Headphones, Beets) had both simple defaults
  and deep configurability.

**Navigation strategy:** Simple defaults with progressive disclosure. Every command has a zero-flag
invocation that does something useful. Flags add precision. The `--dry-run` flag is the bridge
between simplicity and power -- it lets users see what a powerful command would do before
committing.

---

### T7: Metadata Server -- Indispensable but Unreliable

**The tension (irreconcilable):** The metadata server (api.lidarr.audio) is simultaneously the most
important external dependency and the most fragile. Operations that make Lidarr integration valuable
(search, lookup, adding new artists) require it. Operations that are reliable (list, edit, delete,
monitor) do not require it but provide less differentiated value. The features users want most
require the infrastructure that fails most.

**Evidence of conflict:**

- The Contrarian documented 5 outages in 5 months, with the team explicitly refusing to add fallback
  mechanisms.
- The Futurist assigned 60-70% probability to continued fragility.
- The Journalist documented that `GET /api/v1/artist/lookup` and `GET /api/v1/album/lookup` depend
  on the metadata server even when the local Lidarr instance is healthy.
- The Systems-Thinker mapped the full dependency chain: rfmedia-cli -> local Lidarr API ->
  api.lidarr.audio -> MusicBrainz. Four potential failure points for a single operation.

**Why it is irreconcilable:** The metadata server cannot be replaced (self-hosted alternatives
rejected), cannot be made reliable by external tools (it is upstream of the API), and cannot be
avoided for the operations that provide the most value. The lidmeta project exists but is unofficial
and unsupported.

**Navigation strategy:** Accept this as a structural constraint and design around it:

1. Clearly separate commands into "always works" (local operations) and "depends on external
   services" (search, add)
2. Cache aggressively -- once an artist is looked up, store the MusicBrainz ID and metadata locally
   so repeat operations do not need the metadata server
3. Error messages must distinguish "Lidarr is unreachable" from "Lidarr's upstream metadata is
   unavailable" -- the second is expected and not an emergency
4. For discovery (Layer 2), bypass the metadata server entirely by using Last.fm/ListenBrainz APIs
   directly

---

### T8: Ecosystem Coherence vs. Tool Independence

**The tension:** The Historian's strongest finding is that "ecosystem coherence trumps individual
tool quality" -- Headphones was technically superior to Lidarr in many ways but lost because it was
not part of the *arr ecosystem. This implies rfmedia-cli should deeply integrate with the *arr
ecosystem. But the Contrarian's strongest finding is that deep integration inherits fragility. And
the Futurist warns that the ecosystem may fragment (Naviseerr, Beets alternatives).

**Evidence of conflict:**

- Headphones failed despite being functionally complete, because it was not part of the \*arr
  ecosystem (Historian).
- docker-lidarr-extended failed because it was too deeply integrated with multiple fragile external
  services (Historian, Archaeologist).
- rfmedia-cli already exists in the rfmedia-apps ecosystem (compose.yml, rfapps-cli), giving it
  natural ecosystem coherence without needing to be deeply coupled to Lidarr's internals.

**Navigation strategy:** rfmedia-cli gets ecosystem coherence through its position in the
rfmedia-apps monorepo and its existing Plex integration, not through depth of Lidarr coupling.
Integrate enough with Lidarr to be useful within the \*arr stack. Do not integrate so deeply that
Lidarr's problems become rfmedia-cli's problems.

---

## 3. Trade-off Tensions -- What Cannot Be Optimized Simultaneously

### T9: Bulk Operation Speed vs. Ecosystem Safety

**The tension:** Users want fast bulk operations (unmonitor 500 albums, change quality profiles for
200 artists). But every bulk operation that triggers Lidarr's automation cascade consumes shared
resources (metadata server capacity, Prowlarr indexer rate limits, download client bandwidth) that
affect the entire \*arr stack.

**Evidence of conflict:**

- Community scripts recommend 120-second delays between API calls to avoid overwhelming the metadata
  server (Journalist).
- Adding 50 artists generates 50 x 20 albums x N indexer queries, exhausting Prowlarr limits and
  blocking Sonarr/Radarr searches (Systems-Thinker).
- Users with 75,000-track libraries experienced 503 errors and artwork cache wipes during metadata
  server load (Contrarian).
- Bulk unmonitor by album type is the most requested feature with 6+ years of demand
  (Negative-Space).

**What cannot be optimized simultaneously:**

- Speed of bulk operations
- Safety of the broader \*arr ecosystem
- Predictability of outcomes

**You get to pick two.** Fast + safe means unpredictable (operations complete quickly but some may
silently fail under load). Fast + predictable means unsafe (blast through rate limits to get
consistent results). Safe + predictable means slow (respect all rate limits and verify each
operation).

**Navigation strategy:** Default to safe + predictable (slow). Provide a `--fast` flag that trades
safety for speed, with clear warnings. Distinguish between operations that are inherently safe at
any speed (local-only: monitor/unmonitor, tag, profile change) and operations that cascade (add
artist with search, trigger indexer queries). Only apply speed limitations to cascading operations.

---

### T10: Album-Centric Acquisition vs. Track-Level Consumption

**The tension (irreconcilable):** This was identified by the Contrarian, the Negative-Space persona,
and the "Self-Hosted Music Still Sucks" analysis as the fundamental architectural mismatch in
self-hosted music. Lidarr downloads complete albums. Users consume individual tracks. rfmedia-cli
works with Plex at the track level. The granularity mismatch cannot be bridged by a CLI tool because
it is embedded in the acquisition pipeline (Usenet/torrent releases are album-level).

**Evidence of conflict:**

- Lidarr "will NOT work" with loose file collections, compilations from multiple artists, DJ mixes,
  or specialty libraries (Servarr FAQ).
- The album-centric model means users acquire 12 tracks to get the 3 they want (Negative-Space).
- Lidarr forces complete album downloads; no track-level selection is possible (Contrarian).
- The Journalist confirmed track/trackfile endpoints exist for reading and deleting individual
  tracks/files, but not for acquiring individual tracks.

**What this means in practice:** rfmedia-cli can help users _manage_ music at the track level (via
Plex integration and Lidarr's trackfile endpoints) but cannot change how music is _acquired_. The
bridge between "I like this track in Plex" and "get me more music like this" necessarily goes
through album-level acquisition.

**Navigation strategy:** Accept the granularity mismatch explicitly. When bridging from Plex
(track-level) to Lidarr (album-level), surface the gap to the user: "You rated 3 tracks by Artist X
highly. Lidarr would monitor all albums by Artist X (estimated 15 albums, ~180 tracks). Proceed?"
Let the user make informed decisions about the expansion ratio.

---

### T11: Discovery Depth vs. Recommendation Quality

**The tension:** Automated discovery at scale produces quantity but not necessarily quality. The
Contrarian cited academic research showing popularity bias in collaborative filtering (Abdollahpouri
et al., 2019; Kowald et al., 2022). Last.fm's similar artists are computed from listening data that
inherently amplifies mainstream tastes. Deeper discovery (more hops, more sources, more artists)
produces more recommendations but with diminishing and potentially negative returns.

**Evidence of conflict:**

- Lidify and Aurral's rapid adoption (514 and 359 stars respectively) proves strong demand for any
  discovery (Historian, Journalist).
- Academic research documents that recommendation algorithms disproportionately suggest widely-known
  artists (Contrarian).
- lidarr-extended needed loop prevention specifically because unconstrained discovery produced
  library bloat (Archaeologist).
- ListenBrainz's data is "nowhere near as comprehensive as Spotify" (Futurist), meaning open
  alternatives may have even stronger mainstream bias due to smaller datasets.

**What cannot be optimized simultaneously:**

- Breadth of discovery (more recommendations)
- Quality/novelty of recommendations (avoiding mainstream convergence)
- Speed of results (more filtering takes longer)

**Navigation strategy:** Default to shallow, curated discovery. Show the top 10-15 similar artists,
not 100. Include similarity scores so users can see how "similar" means "popular and vaguely
related." Provide a `--deep` flag for users who want exhaustive results. Consider surfacing
MusicBrainz genre/tag data alongside Last.fm similarity scores so users can judge recommendations on
multiple dimensions.

---

### T12: Local Caching vs. Data Freshness

**The tension:** Caching artist/album metadata locally makes rfmedia-cli faster and resilient to
metadata server outages. But cached data can become stale (new albums released, artist metadata
updated in MusicBrainz, monitoring status changed via Lidarr web UI). Users may make decisions based
on outdated cache data.

**Evidence of conflict:**

- The Systems-Thinker recommended caching as a mitigation for metadata server fragility.
- The Contrarian documented that Lidarr's own caching layer "introduces staleness and divergence
  from the upstream source of truth."
- Lidarr version 2.13.3 wiped all cached artwork, demonstrating that cache invalidation is a real
  operational risk (Contrarian, Systems-Thinker).

**Navigation strategy:** Cache with explicit staleness indicators. Show "last updated: 3 days ago"
on cached data. Provide `--refresh` flag to force fresh data from Lidarr/metadata sources. Default
to using cache for read operations, fresh data for write operations (you should see current state
before modifying it).

---

## 4. Temporal Tensions -- What Works Now vs. What Is Needed for the Future

### T13: Last.fm (Proven, Aging) vs. ListenBrainz (Promising, Incomplete)

**The tension:** Last.fm has decades of listening data, a proven API, and simple authentication (API
key only). ListenBrainz is open-source, CC0 licensed, backed by the MetaBrainz Foundation, and
building artist/track/album similarity datasets -- but its data is "nowhere near as comprehensive as
Spotify" and its APIs are less mature.

**Evidence of conflict:**

- The Archaeologist and Journalist both position Last.fm as the primary recommendation source today.
- The Futurist predicts "ListenBrainz Will Become the Default Music Discovery API" based on open
  licensing and institutional backing.
- The Contrarian notes both use collaborative filtering with inherent popularity bias.

**The temporal dimension:** Last.fm works well today but is a closed, commercial service that could
restrict its API (as Spotify did in November 2024). ListenBrainz is open and permanent but less
useful today.

**Navigation strategy:** Implement Last.fm first for immediate value. Abstract the recommendation
source behind an interface so ListenBrainz can be added later. This was the contradiction mapping's
resolution (C11) and remains the correct temporal approach.

---

### T14: Current Lidarr Stability vs. Future Ecosystem Fragmentation

**The tension:** Lidarr's API v1 is stable today and unlikely to change. But the Futurist documented
multiple forces that could fragment the ecosystem: Naviseerr aiming to replace Lidarr, the metadata
server in permanent crisis, slow development pace, and the broader trend toward converged tools.
Investing deeply in Lidarr integration risks building on a platform that may not be the default in
3-5 years.

**Evidence of conflict:**

- The Historian: "the \*arr API convention is stable and predictable" since 2017.
- The Futurist: develop branch last updated October 14, 2025; confusing versioning with v1.0
  milestone 68% complete while releases at v3.1.x.
- The Futurist: Naviseerr v2.0 "plans to replace Lidarr entirely" (20-30% probability over 2 years).
- The Historian: "the fork chain has largely stabilized" -- growth is through companion tools, not
  new applications.

**Navigation strategy:** Build against Lidarr's API v1 confidently for the next 1-2 years. Abstract
the Lidarr client behind a `MusicCollectionManager` interface (as the Futurist recommends) so a
Naviseerr, Beets, or direct-MusicBrainz backend could be substituted later. Do not over-invest in
Lidarr-specific features that would not translate to an alternative backend.

---

### T15: TypeScript Ecosystem Growth vs. Lidarr's C#/.NET Foundation

**The tension:** TypeScript is the most-used language on GitHub as of August 2025, with native
Node.js support and growing tooling. Lidarr is built in C#/.NET with a community that skews toward
Python (pyarr, Headphones, Beets, Soularr, DiscoveryLastFM) and Go (golift/starr). rfmedia-cli is
building TypeScript tooling for an ecosystem where TypeScript is still the newcomer.

**Evidence of conflict:**

- The Archaeologist found that most historical music automation tools are Python or Ruby. The only
  TypeScript predecessor (lumus) was a solo project that did not gain traction.
- The Journalist confirmed TsArr (v1.11.0, Feb 2026) is the first production-quality TypeScript SDK
  for Servarr APIs.
- The Negative-Space persona confirmed no TypeScript CLI tool exists for Lidarr management.
- The Futurist notes TypeScript ecosystem momentum validates the technology choice.

**Navigation strategy:** The TypeScript gap is an opportunity, not a liability. rfmedia-cli would be
genuinely novel in the ecosystem. The key risk is that community examples, documentation, and
debugging resources are all in Python/Go/C#. Lean heavily on the OpenAPI spec (language-agnostic)
rather than on existing client libraries in other languages. Document TypeScript-specific patterns
thoroughly since rfmedia-cli may become the reference implementation for TypeScript Lidarr
integration.

---

## 5. Conceptual Tensions

### T16: Album-Centric Metadata vs. Track-Level Listening Intelligence

**The tension:** Lidarr's data model is album-centric (artist -> album -> track, where album is the
primary unit). Plex's music intelligence is track-centric (individual track ratings, play counts,
audio fingerprints, Sonic Analysis parameters). The Plex-Lidarr bridge must translate between these
incompatible models of what "matters" in a music collection.

**Evidence of conflict:**

- Lidarr's monitor/unmonitor operates at the album level. You cannot unmonitor a single track within
  an album (Systems-Thinker, Contrarian).
- Plex's Sonic Analysis extracts ~50 parameters per track, enabling track-level similarity that
  Lidarr has no equivalent for (Futurist).
- MusicBrainz's data model has its own complexity: recordings, releases, release groups, and works
  represent different aspects of what a "song" is (Historian).
- The Beets community identified cross-service identifier mapping (Spotify ID <-> MusicBrainz ID <->
  local files) as the unsolved hard problem (Archaeologist).

**The deeper conceptual conflict:** What is the fundamental unit of music? For acquisition (Lidarr,
Usenet, torrents), it is the album. For consumption (Plex, playlists, streaming), it is the track.
For metadata (MusicBrainz), it is the recording. For the user, it depends on context. rfmedia-cli
must bridge these different models of the same underlying reality.

**Navigation strategy:** Use the artist as the common denominator for the bridge. Both Plex and
Lidarr model artists. The gap analysis should operate at the artist level ("artists in Plex not in
Lidarr"). Drill down to album/track level only when the user requests detail. Aggregate Plex's
track-level data to the album level for comparison with Lidarr (e.g., "album X has 8/12 tracks rated
4+ stars in Plex").

---

### T17: Centralized Metadata Authority vs. Distributed Metadata Reality

**The tension:** The \*arr ecosystem is built on the assumption of a single authoritative metadata
source per media type (TheTVDB for TV, TheMovieDB for movies, MusicBrainz for music). But music
metadata is inherently distributed: MusicBrainz for canonical data, Last.fm for listening behavior,
Plex for local file metadata and ratings, audio file tags for embedded metadata, and Lidarr's own
database for monitoring state. No single source has complete authority.

**Evidence of conflict:**

- The Historian documented that Lidarr's metadata server is a "single point of failure" because it
  assumes centralized metadata authority. When it fails, there is no fallback.
- The Contrarian noted that Plex's metadata agents may conflict with Lidarr's MusicBrainz-sourced
  metadata, causing display inconsistencies.
- The Archaeologist documented that Beets' unsolved challenge is mapping "track X on service A is
  actually the same track as track Y on service B."
- The Futurist identified Plex Sonic Analysis as metadata that exists only in Plex and has no
  representation in Lidarr or MusicBrainz.

**The deeper conceptual conflict:** The centralized metadata model that works for TV/movies (one
episode = one entity in TheTVDB, case closed) does not work for music because the same song can be a
single, an album track, a live recording, a remix, a remaster, and a compilation entry -- each with
different metadata in different systems. MusicBrainz attempts to capture this complexity but Lidarr
simplifies it into an album-centric view, losing information in the translation.

**Navigation strategy:** Do not assume any single metadata source is authoritative. When bridging,
use MusicBrainz IDs as the canonical linking key (they are used by both Plex's MusicBrainz metadata
agent and Lidarr), but validate matches with additional signals (artist name fuzzy matching, album
name comparison, track count verification). Surface metadata conflicts to the user rather than
silently resolving them.

---

### T18: Composable Unix Philosophy vs. Consolidated User Experience

**The tension:** The Historian's strongest historical lesson is "composable beats monolithic"
(docker-lidarr-extended failed, arr-scripts succeeded). But the Negative-Space and Futurist personas
document user frustration with fragmented tooling (5+ Docker containers for a complete music
workflow) and predict consolidation. Users want fewer tools with more capabilities, not more tools
with narrow capabilities.

**Evidence of conflict:**

- docker-lidarr-extended failed because it bundled too many concerns into one container (Historian,
  Archaeologist).
- TheWicklowWolf's music stack requires 5+ separate Docker containers (Lidify, LidaTube, Syncify,
  PlaylistDir, SpotTube), which users find burdensome (Futurist, Negative-Space).
- The contradiction mapping resolved this as "composable commands within a single tool" (C14), but
  the tension remains at the implementation level.

**The deeper conceptual conflict:** Unix philosophy says "do one thing well." User experience says
"do not make me orchestrate six tools to accomplish one goal." The resolution ("composable
subcommands in a single CLI") is elegant in theory but creates scope pressure in practice -- each
new subcommand expands the maintenance surface and the potential for feature coupling.

**Navigation strategy:** rfmedia-cli already follows the command/action separation pattern. Each
Lidarr subcommand should be a discrete action that can be composed with pipes and scripts. But the
CLI as a whole consolidates the user-facing surface into one tool. The key discipline is:
subcommands share infrastructure (config, API clients, output formatting) but not state. The
`discover` command should not implicitly change state in the `monitor` command. Composability
through explicit data flow (discover outputs a list, add accepts a list) rather than implicit side
effects.

---

## Summary of Maximum Tension Points

The three tensions with the deepest structural impact on rfmedia-cli's Lidarr integration design:

### 1. T2: Automation vs. Curation (Stakeholder)

Lidarr wants to automate everything. rfmedia-cli's users want to curate intentionally. Every feature
must choose a default -- and the default should be curation (preview, dry-run, unmonitored), with
automation available as an opt-in.

### 2. T7: Metadata Server Indispensable but Unreliable (Value)

The most valuable operations require the least reliable infrastructure. This is not a bug to fix but
a structural reality to design around. The layered architecture from the crucible analysis is the
correct response, but the tension remains: Layer 1 (reliable, local) delivers less differentiated
value than Layers 2 and 3 (valuable but dependent on external services).

### 3. T10: Album-Centric Acquisition vs. Track-Level Consumption (Trade-off)

This is the foundational mismatch in self-hosted music that no tool has solved. rfmedia-cli cannot
solve it either -- the acquisition pipeline is album-level because that is how music is distributed
on Usenet and torrents. But rfmedia-cli can make the mismatch visible and give users informed
control over the expansion from "tracks I like" to "albums Lidarr will download."

---

## Tensions That Inform Implementation Priorities

| Tension                                    | Implication for Phase 1 (Bulk Ops)            | Implication for Phase 2 (Discovery)           | Implication for Phase 3 (Bridge)                            |
| ------------------------------------------ | --------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| T2: Automation vs. Curation                | Default to dry-run for all destructive ops    | Default to preview, not auto-add              | Show gaps as reports, not auto-actions                      |
| T5: Reliability vs. Features               | Phase 1 is all local-only operations          | Discovery uses Last.fm/LB, not Lidarr         | Bridge reads both systems; writes are optional              |
| T7: Metadata indispensable/unreliable      | Phase 1 avoids metadata-dependent ops         | Discovery bypasses metadata server entirely   | Bridge caches data locally for offline gap analysis         |
| T9: Speed vs. Safety                       | Batch limits with --max-batch flag            | Rate-limit discovery API calls                | Progressive loading of comparison data                      |
| T10: Album vs. Track                       | Bulk ops work at album level (Lidarr's model) | Discovery is artist-level                     | Bridge aggregates Plex tracks to album level for comparison |
| T11: Depth vs. Quality                     | N/A                                           | Default to top 10-15 results, --deep for more | N/A                                                         |
| T16: Album metadata vs. Track intelligence | N/A                                           | N/A                                           | Artist as common denominator; drill to album on demand      |
| T18: Composable vs. Consolidated           | Subcommands share API client, not state       | Discover outputs data that add can consume    | Gap analysis as report; actions as separate commands        |

---

## Open Questions That Tensions Cannot Resolve

These questions emerged from the tensions but require empirical testing or user research to answer:

1. **What is the acceptable failure rate for metadata-dependent operations?** If artist search fails
   10% of the time due to metadata server issues, is that acceptable for a CLI tool? The Contrarian
   says no; the Systems-Thinker says yes with proper error handling. The answer depends on user
   expectations, which are unknown.

2. **How many similar artists is "too many"?** The lidarr-extended default was 1-20 per seed artist.
   Lidify shows all results. Aurral curates by tag matching. The right number depends on whether
   users use the CLI for exploration (show me everything) or for decisive action (show me the best
   5).

3. **Will the MusicBrainz ID mapping between Plex and Lidarr work in practice?** The bridge depends
   on both systems having MusicBrainz IDs for the same artists. If Plex uses a different metadata
   agent, the mapping breaks. The percentage of users with compatible metadata configurations is
   unknown.

4. **Is there demand for a TypeScript CLI for Lidarr among the self-hosting community?** The
   Negative-Space persona confirmed the gap exists. But the community's preference for Python/Go
   tooling may mean the gap exists because nobody wants a TypeScript solution, not because nobody
   built one.

5. **How does the layered architecture perform under real usage?** The crucible analysis recommends
   three layers with different reliability guarantees. But in practice, users will not think in
   layers -- they will run a command and expect it to work. The mapping from "user intent" to "which
   layer is this" must be invisible.
