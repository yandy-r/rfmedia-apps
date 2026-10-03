# Innovation Synthesis: Novel Hypotheses for rfmedia-cli Lidarr Integration

## Methodology

This document generates novel ideas by deliberately combining findings across the eight research
personas and two synthesis analyses. Each innovation is born from the collision of at least two
distinct perspectives that, when combined, produce insights no single persona articulated. Ideas are
evaluated on three axes: novelty (not mentioned by any single persona), feasibility (could be
implemented in rfmedia-cli's TypeScript codebase), and differentiation (would set rfmedia-cli apart
from every existing tool).

---

## Innovation 1: Antifragile Metadata Architecture -- Turning Fragility into a Feature

### Source Collision

- **Contrarian**: Metadata server fragility is an existential risk. Five outages in five months.
  "Won't Fix" on self-hosted alternatives.
- **Systems Thinker**: The metadata server is the weakest link, but concrete mitigations exist
  (health checks, caching, degradation tiers).
- **Contradiction Mapping (C1)**: The Contrarian identifies the risk; the Systems Thinker identifies
  the mitigation. But neither proposes turning the problem into an advantage.

### The Novel Hypothesis

What if metadata server fragility is not a bug to work around, but a **forcing function** that
drives rfmedia-cli toward a fundamentally better architecture than any tool that assumes reliable
metadata?

Instead of treating Lidarr's metadata outages as a problem to mitigate, design rfmedia-cli as a
**metadata-resilient CLI** that operates across a degradation spectrum. When all services are
healthy, it provides rich, cross-referenced data. When services degrade, it falls back progressively
-- and critically, it **records what it could not do** so it can automatically retry when services
recover.

### Concrete Design: The Deferred Resolution Queue

```
┌─────────────────────────────────────────────────────────┐
│                  Metadata Resolution Tiers               │
├─────────────┬─────────────┬─────────────┬───────────────┤
│ Tier 0      │ Tier 1      │ Tier 2      │ Tier 3        │
│ Local Cache │ Lidarr Local│ Direct MB   │ Lidarr Meta   │
│ (SQLite)    │ API (CRUD)  │ API (1/sec) │ Server        │
│ Always OK   │ Reliable    │ Rate-limited│ Fragile       │
└─────────────┴─────────────┴─────────────┴───────────────┘
         ↑ Fallback direction (right to left)
```

When a user runs `rfmedia lidarr discover --artist "Radiohead"`, the CLI:

1. Queries Last.fm for similar artists (independent of Lidarr -- always works)
2. Cross-references against local cache of known Lidarr artists (Tier 0)
3. If cache is stale, fetches fresh list from Lidarr local API (Tier 1)
4. For new artist adds, attempts Lidarr's metadata-dependent `POST /api/v1/artist` (Tier 3)
5. If Tier 3 fails: **writes the intent to a local deferred resolution queue** (SQLite)
6. On next successful health check, automatically replays deferred operations

This is analogous to how Git works offline -- you commit locally and push when connectivity returns.
No existing Lidarr tool implements deferred resolution. They all fail hard when the metadata server
is down.

### Why This Is Novel

- The Contrarian identified the problem but recommended avoidance (narrow scope).
- The Systems Thinker proposed mitigation but not advantage (graceful degradation).
- Neither proposed **recording failed intents for automatic replay**.
- This transforms metadata fragility from a weakness into a differentiator: rfmedia-cli becomes the
  only Lidarr tool that never loses user intent.

### Implementation Feasibility

rfmedia-cli already has a SQLite database (`better-sqlite3`), a queue system
(`src/commands/queue.ts`), and operation tracking (`src/lib/history.ts`). The deferred resolution
queue extends existing infrastructure. The health check polling pattern is proven by rfapps-cli's
plan/apply workflow.

### Impact Score

- **Novelty**: High -- no existing Lidarr tool implements deferred intent resolution
- **Feasibility**: High -- builds on existing rfmedia-cli infrastructure (SQLite, queue, history)
- **Differentiation**: High -- transforms the ecosystem's biggest weakness into a unique strength

---

## Innovation 2: Headphones getSimilar Meets ListenBrainz Open Data -- The Federated Discovery Engine

### Source Collision

- **Archaeologist**: Headphones' `getSimilar` endpoint (2011-2017) was the gold standard for music
  discovery CLIs. Simple, ranked results by relevance count. Proven UX pattern.
- **Futurist**: ListenBrainz is building open, CC0-licensed artist/track/album similarity datasets.
  "Will become the default music discovery API."
- **Contrarian**: Last.fm's collaborative filtering creates popularity bias. Academic research
  documents systematic amplification of mainstream tastes.
- **Journalist**: Aurral (2026) uses MusicBrainz tag matching for similarity -- a completely
  different signal from listening-based collaborative filtering.

### The Novel Hypothesis

Combine Headphones' proven CLI UX pattern (`getSimilar` returning ranked, scored results) with a
**multi-signal federated discovery engine** that merges Last.fm collaborative filtering,
ListenBrainz open listening data, MusicBrainz tag/relationship graphs, AND Plex personal listening
history into a single ranked recommendation set. No existing tool combines all four signals.

### Concrete Design: Weighted Multi-Source Similarity

```typescript
interface DiscoverySource {
  name: "lastfm" | "listenbrainz" | "musicbrainz" | "plex-history";
  weight: number; // 0.0 - 1.0, user-configurable
  signal: "collaborative" | "tag-based" | "relationship" | "personal";
}

interface SimilarArtist {
  name: string;
  mbid: string;
  sources: Map<DiscoverySource["name"], number>; // per-source score
  compositeScore: number; // weighted aggregate
  inLibrary: { lidarr: boolean; plex: boolean };
  popularityTier: "mainstream" | "mid-tier" | "obscure"; // anti-bias signal
}
```

The key innovation is the **anti-popularity-bias correction**. The Contrarian's academic research
(Abdollahpouri et al., Kowald et al.) documents that collaborative filtering over-recommends popular
artists. The correction works by:

1. Computing a raw composite score from all four sources
2. Applying a configurable **diversity boost** that increases scores for artists with fewer total
   listeners (available from ListenBrainz listener counts or Last.fm play counts)
3. Flagging mainstream vs. obscure artists in the output so users can make informed decisions

```
$ rfmedia lidarr discover --artist "Radiohead" --diversity high

Similar artists for Radiohead (diversity: high):

 #  Artist              Score  Sources          Tier       Status
 1  Thom Yorke          0.94   LFM+LB+MB+Plex  mid-tier   In Lidarr
 2  Portishead          0.87   LFM+LB+MB       mid-tier   In Plex only
 3  Boards of Canada    0.83   LFM+MB           mid-tier   Not in library
 4  Belong              0.79   LB+MB            obscure    Not in library  ← diversity boost
 5  Lanterns on the Lake 0.76  MB+Plex          obscure    Not in library  ← diversity boost
 ...

Add to Lidarr? [select artists by number, 'all', or 'none']:
```

### Why This Is Novel

- No existing tool combines more than two similarity signals.
- Lidify uses Last.fm only. Aurral uses MusicBrainz tags only. Sonobarr uses Last.fm only.
- The anti-popularity-bias correction is informed by academic research the Contrarian cited but no
  tool has implemented.
- The Plex personal history signal is unique to rfmedia-cli because no other Lidarr tool has Plex
  integration.
- The composite scoring with per-source transparency lets users understand WHY an artist was
  recommended.

### Implementation Feasibility

- Last.fm API: `artist.getSimilar` -- free, API key only, well-documented
- ListenBrainz API: `/labs/api/similar-artists` -- free, no auth, CC0 data
- MusicBrainz API: `/ws/2/artist?inc=artist-rels+tags` -- free, User-Agent only, 1 req/sec
- Plex API: rfmedia-cli already has `src/lib/plex.ts` and `src/lib/plex-cache.ts`
- Each source is independent -- one failing does not block others (antifragile pattern from
  Innovation 1)

### Impact Score

- **Novelty**: Very high -- four-source federated discovery with anti-bias correction is
  unprecedented
- **Feasibility**: High -- each source has a simple, well-documented API; rfmedia-cli already has
  Plex
- **Differentiation**: Very high -- no existing tool even attempts multi-source weighted discovery

---

## Innovation 3: Plan/Apply Workflow for Lidarr Bulk Operations

### Source Collision

- **rfapps-cli architecture (codebase)**: Already implements a plan/apply workflow for Docker
  service deployments -- preview changes before executing them. This is a core pattern of the
  rfmedia-apps monorepo.
- **Systems Thinker**: Bulk operations have non-linear systemic impact. "Adding 50 artists is not
  50x the impact of adding one." Prowlarr rate limit exhaustion affects the entire arr stack.
- **Contrarian**: File corruption risks from metadata operations. Every automated operation should
  be treated as potentially destructive.
- **Negative Space**: Bulk unmonitor by album type is the most requested feature (6+ years of open
  GitHub issues). Users resort to fragile bash scripts.

### The Novel Hypothesis

Apply rfapps-cli's **plan/apply workflow** -- the infrastructure-as-code pattern from
Terraform/Pulumi -- to Lidarr bulk music operations. Every mutation gets a "plan" phase that
computes and displays the full cascade before any API call is made.

### Concrete Design: The Lidarr Plan Engine

```
$ rfmedia lidarr unmonitor --type singles,eps --dry-run

Lidarr Plan: Unmonitor Singles and EPs
──────────────────────────────────────

Scope: 847 artists in library
Albums affected: 2,341 singles, 412 EPs (2,753 total)
Already unmonitored: 1,102
Net change: 1,651 albums to unmonitor

Cascade analysis:
  ├── 47 albums currently in download queue will remain queued (unmonitor does not cancel)
  ├── 312 albums have files on disk (files unchanged by unmonitor)
  └── 0 Prowlarr indexer queries will be triggered (unmonitor is write-only)

Risk assessment: LOW (local-only operation, no metadata server dependency)

Apply this plan? [y/N]:
```

For higher-risk operations:

```
$ rfmedia lidarr add --from-file artists.csv --plan

Lidarr Plan: Add 73 Artists from artists.csv
─────────────────────────────────────────────

New artists to add: 73 (12 already in library, skipped)
Quality profile: FLAC (default)
Metadata profile: Standard (Albums only)
Monitoring: none (safe default)
Search on add: no (safe default)

Estimated cascade (if search were enabled):
  ├── ~1,460 albums would be monitored (avg 20 albums/artist)
  ├── ~1,460 indexer queries via Prowlarr (est. 24 minutes at 2s/query)
  ├── ~73 metadata server lookups (est. 2.4 minutes at 2s/lookup)
  └── Prowlarr daily query budget: 32% consumed (458/1440 remaining)

Metadata server status: HEALTHY (last check: 2s ago)
Deferred queue: empty

Save plan to: .rfmedia-plan-2026-02-11.json
Apply with: rfmedia lidarr apply --plan .rfmedia-plan-2026-02-11.json
```

The plan is a serializable JSON artifact that can be:

1. Reviewed before execution
2. Shared with other household members for approval
3. Applied later when metadata server is healthy
4. Partially applied (select specific artists from the plan)
5. Diffed against previous plans to see what changed

### Why This Is Novel

- No Lidarr tool provides pre-execution cascade analysis.
- No arr ecosystem tool estimates Prowlarr budget consumption before triggering operations.
- The serializable plan artifact is unprecedented -- it brings GitOps/IaC patterns to music library
  management.
- rfapps-cli already implements this pattern for Docker services, so the conceptual framework and UX
  conventions exist within the monorepo.

### Key Innovation Within the Innovation: Prowlarr Budget Estimation

The Systems Thinker identified that bulk Lidarr operations can exhaust Prowlarr's rolling 24-hour
indexer query budget, starving Sonarr and Radarr. The plan engine would:

1. Query Prowlarr's API for current daily query usage (if rfapps-cli integration is available)
2. Estimate queries the planned Lidarr operations would generate
3. Show remaining budget as a percentage
4. Warn if the operation would exceed 50% of remaining budget

This cross-service awareness (Lidarr operation affecting Prowlarr capacity affecting Sonarr/Radarr)
is a systems-thinking insight that no single-purpose tool can provide. rfmedia-cli, as part of the
rfmedia-apps monorepo alongside rfapps-cli's Docker orchestration, is uniquely positioned to
implement this.

### Implementation Feasibility

- rfapps-cli's plan/apply pattern provides the architectural template
- Lidarr's bulk editor API (`PUT /api/v1/artist/editor`, `PUT /api/v1/album/monitor`) supports batch
  operations needed for plan execution
- The cascade estimation uses simple arithmetic (artists x avg albums x queries)
- SQLite stores plans as serializable JSON (existing infrastructure)

### Impact Score

- **Novelty**: Very high -- IaC patterns have never been applied to music library management
- **Feasibility**: High -- architectural pattern exists in sibling package, APIs support batch
  operations
- **Differentiation**: Very high -- transforms "scary bulk operation" into "reviewable, auditable
  change"

---

## Innovation 4: The Listening Intelligence Bridge -- Plex Consumption Driving Lidarr Acquisition

### Source Collision

- **Negative Space**: "No tool exists that reads Plex music library data (ratings, play counts,
  recently added, playlists) and translates that intelligence into Lidarr actions." The bridge does
  not exist.
- **Futurist**: Plex Sonic Analysis uses neural networks to extract ~50 parameters from music files.
  This data exists in Plex but Lidarr knows nothing about it.
- **Systems Thinker**: The quality upgrade cycle is an amplifying feedback loop. More monitoring
  generates more searches, consuming more resources.
- **Archaeologist**: Beets community discussed storing multiple service IDs per track (Spotify,
  Discogs, MusicBrainz) for cross-service matching. The "track X on service A is actually the same
  track as track Y on service B" problem remains unsolved.

### The Novel Hypothesis

Build a **Listening Intelligence Engine** that creates a closed feedback loop between Plex
consumption and Lidarr acquisition. This is not just a gap analysis tool (what is in Plex but not
Lidarr, or vice versa). It is a **policy engine** that makes automated decisions based on listening
behavior:

1. Artists you listen to heavily get upgraded quality profiles
2. Artists you never listen to get unmonitored or flagged for removal
3. Discovery seeds come from your actual listening patterns, not just your library
4. Quality budget (disk space, download bandwidth) is allocated proportionally to listening
   engagement

### Concrete Design: Consumption-Weighted Library Policies

```yaml
# .rfmedia.yaml - Listening Intelligence Policies
lidarr:
  policies:
    quality-upgrade:
      trigger: "plex_play_count > 50 AND plex_rating >= 4"
      action: "set_quality_profile('FLAC Lossless')"
      description: "Upgrade heavily-played, highly-rated artists to lossless"

    neglect-detection:
      trigger: "plex_play_count == 0 AND added_days_ago > 180"
      action: "unmonitor AND tag('review-for-removal')"
      description: "Flag artists never played after 6 months"

    discovery-seeds:
      source: "plex_top_artists(limit=20, period='90d')"
      action: "discover_similar(source='lastfm+listenbrainz', max_per_seed=5)"
      description: "Discover artists similar to your most-played this quarter"

    storage-budget:
      max_total_gb: 500
      allocation: "proportional_to_play_count"
      description: "Allocate quality tiers based on listening engagement"
```

```
$ rfmedia lidarr policy evaluate --dry-run

Listening Intelligence Policy Evaluation
─────────────────────────────────────────

Source: Plex library "Music" (12,847 tracks, 1,203 artists)
Target: Lidarr instance (987 artists monitored)

Policy: quality-upgrade
  Eligible: 47 artists with >50 plays AND rating >= 4
  Action: Upgrade to FLAC Lossless quality profile
  Currently: 12 already FLAC, 35 would change
  Estimated disk delta: +28 GB (upgrade MP3 -> FLAC for 35 artists)

Policy: neglect-detection
  Eligible: 213 artists with 0 plays, added > 180 days ago
  Action: Unmonitor + tag "review-for-removal"
  Currently: 89 already unmonitored, 124 would change
  Estimated savings: 156 GB (if eventually deleted)

Policy: discovery-seeds
  Top 20 artists this quarter: [Radiohead, Portishead, Boards of Canada, ...]
  Would discover: ~100 similar artists (5 per seed)
  After dedup + existing library filter: ~62 new artists
  Action: Add as unmonitored, tagged "discovered-2026-Q1"

Apply policies? [select policy numbers, 'all', or 'none']:
```

### Why This Is Novel

- **No tool connects Plex listening data to Lidarr management decisions.** The Negative Space
  persona confirmed this gap exhaustively.
- **The policy engine pattern** (declarative rules in YAML applied by the CLI) does not exist in any
  music management tool. It is borrowed from infrastructure-as-code (Terraform policies, OPA) and
  applied to music libraries.
- **Storage budget allocation based on listening engagement** is a completely novel concept. Current
  tools treat all artists equally. This approach says "artists you actually listen to deserve higher
  quality."
- **Discovery seeding from personal listening history** uses a signal (Plex play data) that no
  discovery tool has access to. Lidify seeds from your Lidarr library (what you own). This seeds
  from what you actually listen to (behavior, not possession).

### Implementation Feasibility

- Plex play count and rating data: accessible via existing `src/lib/plex.ts`
- Lidarr quality profile changes: `PUT /api/v1/artist/{id}` or bulk `PUT /api/v1/artist/editor`
  (local-only, Tier 1)
- Policy evaluation: extends rfmedia-cli's existing smart filter evaluation engine
  (`src/lib/filter-evaluator.ts`)
- YAML policy configuration: extends existing `.rfmedia.yaml` config pattern

### Impact Score

- **Novelty**: Very high -- policy-driven library management based on listening behavior is
  unprecedented
- **Feasibility**: High -- all required data sources and APIs are already accessible
- **Differentiation**: Maximum -- this is the "killer feature" that no other tool can provide
  because no other tool has both Plex and Lidarr integration

---

## Innovation 5: Beets Plugin Architecture Meets TsArr Auto-Generation -- The Hybrid Extension Model

### Source Collision

- **Archaeologist**: Beets' plugin architecture is "the gold standard for extensible music CLIs."
  Modular, composable, community-extensible.
- **Futurist**: TsArr auto-generates TypeScript clients from Lidarr's OpenAPI spec. devopsarr
  maintains auto-generated SDKs for all arr apps.
- **Historian**: Hand-maintained API wrappers (pyarr, lidarr-cli Ruby, ArrTools) consistently fall
  behind and get abandoned. Auto-generation is the sustainable path.
- **rfmedia-cli codebase**: Already has a plugin system (`src/lib/plugin-loader.ts`,
  `src/lib/plugin-manager.ts`, `src/lib/plugin-runner.ts`) and a command plugin architecture
  (`src/commands/plugin.ts`).

### The Novel Hypothesis

Combine Beets' proven plugin architecture philosophy with TsArr's auto-generated type-safe API
bindings to create a **hybrid extension model** where:

1. The core Lidarr client is auto-generated from OpenAPI specs (sustainable, always current)
2. Higher-level operations (discovery, bridge, policies) are implemented as plugins (extensible,
   community-driven)
3. The plugin contract is typed against the auto-generated API types (type-safe, discoverable)

### Concrete Design: Plugin-Ready Lidarr Client

```typescript
// Auto-generated base layer (from OpenAPI spec, never hand-maintained)
// This is regenerated whenever Lidarr releases a new API version
import type { ArtistResource, AlbumResource } from "./generated/lidarr-api.js";

// Plugin contract using auto-generated types
interface LidarrPlugin {
  name: string;
  version: string;
  hooks: {
    // Pre/post hooks for any Lidarr operation
    "pre:artist:add"?: (artist: ArtistResource) => ArtistResource | null; // null = skip
    "post:artist:add"?: (artist: ArtistResource) => void;
    "pre:bulk:unmonitor"?: (albumIds: number[]) => number[]; // filter list
    "post:discover"?: (results: SimilarArtist[]) => SimilarArtist[]; // rerank/filter
  };
  commands?: PluginCommand[]; // Register new subcommands
}
```

Example community plugins this architecture enables:

- **lidarr-genre-tagger**: Auto-tags Lidarr artists with genres from MusicBrainz/Last.fm after
  addition
- **lidarr-dedup**: Pre-add hook that checks for duplicate artists using fuzzy name matching
- **lidarr-classical**: Custom discovery engine for classical music that uses MusicBrainz
  work/recording relationships instead of artist similarity (addressing the Contrarian's point that
  classical music is poorly served)
- **lidarr-budget**: Post-add hook that checks disk space budget before allowing monitored additions
- **lidarr-export**: Export commands for Lidarr library to various formats (CSV, M3U, JSON, OPML)

### Why This Is Novel

- No arr ecosystem tool combines auto-generated API bindings with a plugin architecture.
- Beets has plugins but hand-maintains its MusicBrainz integration. TsArr has auto-generation but no
  extensibility. This hybrid gets both.
- rfmedia-cli already has a plugin system -- this extends it to the Lidarr integration layer rather
  than building Lidarr as a monolithic feature.
- The typed plugin contract means community contributors get compile-time guarantees against the
  Lidarr API, dramatically lowering the barrier to contribution.

### Implementation Feasibility

- rfmedia-cli plugin infrastructure exists (`plugin-loader.ts`, `plugin-manager.ts`,
  `plugin-runner.ts`)
- OpenAPI code generation is a solved problem (`@hey-api/openapi-ts`, as TsArr demonstrates)
- Hook pattern is proven in rfmedia-cli's existing plugin runner with priority ordering
- Node.js 22 supports native `fetch` (eliminates TsArr's Bun dependency concern from C3)

### Impact Score

- **Novelty**: High -- hybrid auto-gen + plugin architecture is unique in the arr ecosystem
- **Feasibility**: High -- both halves (generation + plugin system) already exist, just need
  connection
- **Differentiation**: High -- creates a platform for community extensions, not just a tool

---

## Innovation 6: The Bidirectional Plex-Lidarr Reconciliation Engine

### Source Collision

- **Negative Space**: "No Lidarr-to-Plex Gap Analysis Tool" exists. Fundamental data reconciliation
  that every user faces.
- **Archaeologist**: Beets community's unsolved challenge: "track X on service A is actually the
  same track as track Y on service B." Cross-service identifier mapping via MusicBrainz IDs.
- **Contrarian**: Lidarr creates duplicate folders for case-insensitive artist name variations.
  Duplicate detection across systems is unsolved.
- **Systems Thinker**: Un-monitoring an artist leaves orphaned files on disk. Plex still has stale
  index entries. The monitoring/deletion disconnect creates split state.
- **Historian**: "No single tool bridges Plex's music library view with Lidarr's collection
  management."

### The Novel Hypothesis

Build a **bidirectional reconciliation engine** that continuously maintains a mapping between Plex's
view of the music library and Lidarr's view, identifying discrepancies in both directions and
proposing corrective actions. This goes beyond simple gap analysis into active reconciliation --
like a database sync tool for music metadata.

### Concrete Design: The Reconciliation Report

```
$ rfmedia lidarr reconcile

Plex-Lidarr Reconciliation Report
──────────────────────────────────

Library: "Music" (Plex) vs. Lidarr instance
Mapping strategy: MusicBrainz ID (primary), fuzzy name match (fallback)
Match confidence threshold: 85%

MATCHED: 934 artists (94.7% of Lidarr library)
  ├── Exact MBID match: 847
  ├── Fuzzy name match (>95%): 62
  └── Fuzzy name match (85-95%): 25 [review recommended]

PLEX-ONLY: 187 artists in Plex but NOT in Lidarr
  ├── Top by play count:
  │   1. "Khruangbin" (342 plays) -- likely should be in Lidarr
  │   2. "Hiatus Kaiyote" (211 plays) -- likely should be in Lidarr
  │   3. "Unknown Artist" (45 plays) -- poorly tagged files
  └── Action: rfmedia lidarr reconcile --add-to-lidarr --min-plays 50

LIDARR-ONLY: 53 artists in Lidarr but NOT in Plex
  ├── With files on disk: 12 (Plex may need rescan)
  ├── Without files (monitored, waiting): 31
  └── Without files (unmonitored): 10 [candidates for removal]
  └── Action: rfmedia lidarr reconcile --trigger-plex-scan --lidarr-only-with-files

DUPLICATES: 7 potential duplicate artists detected
  ├── "The National" (Lidarr) vs "National, The" (Plex) -- MBID confirms same
  ├── "COIL" (Lidarr) vs "Coil" (Plex) -- case mismatch, MBID confirms same
  └── Action: rfmedia lidarr reconcile --resolve-duplicates --interactive

QUALITY MISMATCH: 89 artists where Plex has higher quality than Lidarr profile
  ├── 43 artists: Plex has FLAC, Lidarr profile set to "Any"
  └── Action: rfmedia lidarr reconcile --upgrade-profiles

STALE STATE: 23 albums where Lidarr says "monitored" but files are missing
  └── Action: rfmedia lidarr reconcile --fix-stale-monitoring
```

### Why This Is Novel

- No existing tool performs bidirectional reconciliation between Plex and Lidarr.
- The duplicate detection using MBID as canonical resolver addresses the case-sensitivity and "The"
  prefix problems documented across multiple issues (#4014, #687, #268).
- The quality mismatch detection (Plex has better files than Lidarr expects) is a novel insight --
  it means users may have manually added high-quality files that Lidarr does not know about.
- The stale state detection (monitored but files missing, documented in Lidarr issue #2321) has no
  automated solution.
- The reconciliation report format is inspired by database diff tools (Liquibase, Flyway) applied to
  media libraries.

### Implementation Feasibility

- Plex artist/album listing: existing `src/lib/plex.ts`
- Lidarr artist/album listing: `GET /api/v1/artist`, `GET /api/v1/album` (local-only, reliable)
- MusicBrainz ID matching: Plex metadata agents store MBIDs; Lidarr stores `foreignArtistId`
- Fuzzy name matching: simple Levenshtein distance or string normalization
- SQLite for persistent mapping cache: existing infrastructure

### Impact Score

- **Novelty**: Very high -- bidirectional reconciliation with duplicate detection and stale state
  repair
- **Feasibility**: High -- both APIs are accessible, MBID is the shared key
- **Differentiation**: Maximum -- this is the "bridge" feature every persona identified as the
  highest-value gap

---

## Innovation 7: The Cascade Circuit Breaker -- Cross-Service Safety for the Arr Stack

### Source Collision

- **Systems Thinker**: Bulk operations cascade non-linearly. Adding 50 artists can exhaust Prowlarr
  rate limits for the entire arr stack, starving Sonarr and Radarr.
- **Contrarian**: File corruption is a real risk. OPUS corruption, hardlink corruption, metadata
  tagging side effects. Automation should be treated as potentially destructive.
- **Negative Space**: "Won't Fix" culture means Lidarr itself will not add safety guardrails.
  External tools must provide them.
- **rfapps-cli architecture**: Manages Docker services across the entire stack. Has system-wide
  visibility.

### The Novel Hypothesis

Implement a **circuit breaker pattern** (borrowed from distributed systems engineering) that
monitors cross-service health metrics and automatically throttles or pauses rfmedia-cli operations
when the broader arr stack is under stress. This goes beyond per-operation dry-run into real-time
system-wide safety.

### Concrete Design: The Stack Health Monitor

```typescript
interface StackHealthCheck {
  lidarr: {
    apiResponsive: boolean;
    metadataServerHealthy: boolean; // GET /api/v1/health
    queueDepth: number; // GET /api/v1/queue/status
    diskFreeGb: number; // GET /api/v1/diskspace
  };
  prowlarr?: {
    dailyQueryBudgetRemaining: number; // percentage
    indexerErrorRate: number; // recent failures
  };
  downloadClient?: {
    queueSize: number;
    diskFreeGb: number;
  };
  plex?: {
    libraryUpdateInProgress: boolean;
    scanQueueDepth: number;
  };
}

interface CircuitBreakerPolicy {
  // Pause all metadata-dependent operations
  metadataCircuitOpen: boolean; // when health check fails 3 times in 5 minutes

  // Throttle bulk adds
  maxConcurrentAdds: number; // reduced when Prowlarr budget < 30%

  // Pause all operations
  globalPause: boolean; // when disk free < 5%
}
```

```
$ rfmedia lidarr add --from-file artists.csv --batch-size 10

[Stack Health Check]
  Lidarr API: healthy
  Metadata server: healthy
  Prowlarr budget: 67% remaining (963/1440 queries)
  Download queue: 3 items (12 GB pending)
  Disk space: 234 GB free

Processing batch 1/8 (10 artists)...
  Added: 8/10 | Skipped: 2 (already in library)

[Stack Health Check - batch 2]
  Prowlarr budget: 54% remaining
  ⚠ Circuit breaker: throttling to 5 artists/batch (budget < 60%)

Processing batch 2/8 (5 artists)...

[Stack Health Check - batch 3]
  Metadata server: ERROR 503
  ⛔ Circuit breaker: pausing metadata-dependent operations
  Remaining 48 artists saved to deferred queue
  Will auto-resume when metadata server recovers

Partial result saved. Resume with: rfmedia lidarr apply --resume
```

### Why This Is Novel

- No arr ecosystem tool implements cross-service circuit breakers.
- Prowlarr budget awareness from a Lidarr tool is unprecedented -- existing tools operate in
  isolation.
- The automatic throttle-down and pause-with-resume pattern does not exist in any music management
  tool.
- This combines the Systems Thinker's cascade analysis with the Contrarian's risk analysis into a
  proactive safety system, rather than reactive error handling.
- rfmedia-cli's position within the rfmedia-apps monorepo (alongside rfapps-cli which manages these
  Docker services) gives it unique access to cross-service health data.

### Implementation Feasibility

- Lidarr health: `GET /api/v1/health`, `GET /api/v1/queue/status`, `GET /api/v1/diskspace`
- Prowlarr health: optional integration via Prowlarr API (similar REST pattern)
- Circuit breaker pattern: well-established in Node.js (libraries like `cockatiel`, `opossum`)
- Deferred queue: builds on Innovation 1's deferred resolution queue
- Cross-service config: `.rfapps.yaml` already contains connection details for the Docker stack

### Impact Score

- **Novelty**: Very high -- circuit breakers for media library operations are unprecedented
- **Feasibility**: Medium-high -- requires optional Prowlarr API integration, but core pattern is
  straightforward
- **Differentiation**: Very high -- positions rfmedia-cli as the only "stack-aware" music management
  tool

---

## Innovation 8: Temporal Library Intelligence -- The Music Collection Time Machine

### Source Collision

- **Historian**: Temporal patterns reveal cyclical metadata crises, discovery tool emergence every
  1-2 years, and API wrapper lifecycle patterns. History is the best predictor.
- **Systems Thinker**: The download-import-scan pipeline is a sequential chain with observable
  events at each stage. History recording enables audit and undo.
- **rfmedia-cli codebase**: Already has operation history (`src/lib/history.ts`,
  `src/commands/history.ts`) and undo capability (`src/commands/undo.ts`).
- **Negative Space**: No CLI-level library health audit tool exists.

### The Novel Hypothesis

Extend rfmedia-cli's existing history tracking into a **temporal intelligence system** that records
every Lidarr state change over time, enabling questions that no current tool can answer:

- "What did my library look like 3 months ago?"
- "Which artists were added in Q4 2025 but never played?"
- "How has my library grown over time? Is the growth rate sustainable for my storage?"
- "Which discovery sources (Last.fm, ListenBrainz, manual) have the best 'conversion rate' from add
  to actual listening?"

### Concrete Design: The Library Timeline

```
$ rfmedia lidarr timeline --period 90d

Library Timeline: Last 90 Days
───────────────────────────────

Growth:
  Artists: 987 → 1,042 (+55, +5.6%)
  Albums monitored: 4,231 → 4,890 (+659, +15.6%)
  Disk usage: 412 GB → 467 GB (+55 GB, +13.4%)
  Est. monthly growth: 18.3 GB/month
  Est. disk exhaustion: 2027-08-14 (at current rate)

Activity:
  Added: 67 artists (sources: discovery=42, manual=18, import-list=7)
  Removed: 12 artists (reasons: cleanup=8, duplicate=3, error=1)
  Quality upgrades: 156 albums (MP3→FLAC: 89, 128→320: 67)

Listening Impact (from Plex):
  Discovery-sourced artists:
    Added: 42 | Played at least once: 28 (66.7%) | Top-rated: 11 (26.2%)
  Manual-sourced artists:
    Added: 18 | Played at least once: 15 (83.3%) | Top-rated: 9 (50.0%)

Discovery ROI:
  Last.fm seeds: 31 artists added → 19 played (61.3% conversion)
  ListenBrainz seeds: 8 artists added → 7 played (87.5% conversion)
  Plex-history seeds: 3 artists added → 3 played (100% conversion)

Recommendations:
  ⚠ Growth rate exceeds storage budget. Consider:
    - Unmonitor 213 zero-play artists (save est. 156 GB)
    - Switch 45 low-play artists from FLAC to MP3 (save est. 89 GB)
  ✓ ListenBrainz and Plex-history discovery have highest conversion rates
    - Consider increasing weight for these sources in discovery settings
```

### Why This Is Novel

- No Lidarr tool records library state changes over time.
- **Discovery ROI tracking** (which source leads to artists you actually listen to) is completely
  unprecedented. This closes the feedback loop from "discover -> add -> listen -> evaluate source
  quality."
- **Storage growth projection** with estimated disk exhaustion date brings capacity planning to
  personal music libraries.
- **Listening impact analysis** by source helps users calibrate their discovery strategy based on
  actual outcomes, not assumptions.

### Implementation Feasibility

- rfmedia-cli already has history tracking (`src/lib/history.ts`) and SQLite (`src/lib/db.ts`)
- Lidarr state snapshots: periodic `GET /api/v1/artist` (local-only, reliable) stored in SQLite
- Plex play data: existing `src/lib/plex.ts` integration
- Growth projections: simple linear regression on timestamped snapshots

### Impact Score

- **Novelty**: Very high -- temporal library analysis with discovery ROI tracking is unprecedented
- **Feasibility**: High -- extends existing infrastructure (SQLite, history, Plex integration)
- **Differentiation**: Very high -- transforms rfmedia-cli from a tool into a library intelligence
  platform

---

## Innovation Priority Matrix

| #   | Innovation                            |  Novelty  | Feasibility | Differentiation | Combined |  Phase  |
| --- | ------------------------------------- | :-------: | :---------: | :-------------: | :------: | :-----: |
| 4   | Listening Intelligence Bridge         | Very High |    High     |     Maximum     |  **10**  | Phase 3 |
| 6   | Bidirectional Reconciliation          | Very High |    High     |     Maximum     |  **10**  | Phase 3 |
| 3   | Plan/Apply Workflow                   | Very High |    High     |    Very High    | **9.5**  | Phase 1 |
| 2   | Federated Discovery Engine            | Very High |    High     |    Very High    | **9.5**  | Phase 2 |
| 1   | Antifragile Metadata (Deferred Queue) |   High    |    High     |      High       |  **9**   | Phase 1 |
| 8   | Temporal Library Intelligence         | Very High |    High     |    Very High    |  **9**   | Phase 3 |
| 7   | Cascade Circuit Breaker               | Very High | Medium-High |    Very High    | **8.5**  | Phase 2 |
| 5   | Hybrid Extension Model                |   High    |    High     |      High       |  **8**   | Phase 2 |

### Recommended Implementation Order

**Phase 1 -- Foundation (Innovations 1, 3):** The deferred resolution queue (Innovation 1) and
plan/apply workflow (Innovation 3) are infrastructure that every subsequent innovation depends on.
They make rfmedia-cli resilient by design and give users confidence to perform operations they
currently avoid.

**Phase 2 -- Intelligence (Innovations 2, 5, 7):** The federated discovery engine (Innovation 2)
provides the recommendation capability that every persona identified as the highest-demand feature.
The hybrid extension model (Innovation 5) makes discovery extensible. The circuit breaker
(Innovation 7) makes operations safe at scale.

**Phase 3 -- Bridge (Innovations 4, 6, 8):** The listening intelligence policies (Innovation 4),
bidirectional reconciliation (Innovation 6), and temporal analysis (Innovation 8) are the features
that make rfmedia-cli uniquely valuable. They require both Plex and Lidarr integration working, so
they build on Phases 1 and 2. These are the strategic moat -- no competitor can replicate them
without both integrations.

---

## Cross-Cutting Architectural Theme

All eight innovations share a common architectural principle that emerges from combining the Systems
Thinker's cascade model with the Contrarian's risk analysis:

**"Record intent, not just outcome."**

Every action rfmedia-cli takes should be:

1. **Planned** before execution (Innovation 3)
2. **Recorded** with full context (Innovation 8)
3. **Recoverable** if it fails (Innovation 1)
4. **Throttled** by system health (Innovation 7)
5. **Evaluated** for effectiveness (Innovation 8, Discovery ROI)

This is the opposite of how existing Lidarr tools work. Lidify adds artists and forgets. Bash
scripts execute and discard. Import lists run on schedules with no audit trail. rfmedia-cli, by
recording intent at every step, becomes the first music management CLI that can answer "why is my
library in this state?" and "what should I do next?"

This principle -- borrowed from event sourcing in distributed systems and applied to personal music
library management -- is the deepest innovation in this synthesis. It transforms rfmedia-cli from a
tool that does things to a tool that understands things.
