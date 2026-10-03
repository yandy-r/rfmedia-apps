# Negative Space Analysis: Unanswered Questions and Research Gaps

## Overview

Across 8 persona findings, a crucible analysis, and a contradiction mapping, this research produced
substantial coverage of the Lidarr API landscape, ecosystem history, and architectural tradeoffs.
However, significant gaps remain -- areas where the research raised questions but did not answer
them, where empirical data is absent, where theoretical models are incomplete, and where user needs
are assumed rather than validated. This document catalogs every identified gap, uncertainty, and
unanswered question, prioritized by impact on rfmedia-cli integration decisions.

---

## Priority 1: Decision-Blocking Gaps

These gaps, if left unresolved, could lead to fundamentally wrong architectural choices.

### EG-1: TsArr Node.js Runtime Compatibility (Empirical)

- **What we do not know**: Whether TsArr (v1.11.0) works on Node.js 22+ without modification. TsArr
  is built for Bun runtime. The Journalist and Futurist flagged this; the Historian did not address
  it. The contradiction mapping (C3) marked this "needs empirical testing."
- **Why it matters**: If TsArr requires Bun, rfmedia-cli must either: (a) add Bun as a runtime
  dependency (unacceptable -- Node.js 22+ is the established runtime), (b) fork and adapt TsArr for
  Node.js, or (c) generate its own TypeScript client from Lidarr's OpenAPI spec using
  `@hey-api/openapi-ts`. The correct path depends entirely on a test that no persona performed.
- **What would resolve it**: Install `tsarr` in the rfmedia-cli workspace, import the Lidarr client
  classes, and attempt basic API calls against a running Lidarr instance. Test: (a) does it compile
  under `tsconfig.json` with `moduleResolution: NodeNext`?, (b) does native `fetch` in Node.js 22+
  satisfy TsArr's HTTP layer?, (c) are there Bun-specific APIs used beyond fetch?
- **Source**: Journalist uncertainties section, Contradiction mapping C3
- **Priority**: Critical -- blocks the "build vs. buy" decision for the Lidarr API client layer

### EG-2: Lidarr Bulk Add Performance Under Load (Empirical)

- **What we do not know**: Actual behavior when adding 50-200+ artists via the API in rapid
  succession. Does Lidarr queue metadata lookups internally? Does the metadata server throttle
  per-client or globally? What is the failure mode -- 503 errors, silent drops, corrupted state? The
  only data point is a blog post mentioning "~50 minutes for 3000 artists" with no detail on failure
  rates.
- **Why it matters**: The recommended architecture (H6) includes a discovery layer that feeds
  artists into Lidarr. If adding 50 similar artists in one session causes a 503 cascade or corrupts
  the database, the discovery feature becomes unusable. The Systems-Thinker identified this as a
  second-order effect but provided no empirical data.
- **What would resolve it**: Controlled testing against a local Lidarr instance with a test library.
  Add artists in batches of 10, 50, 100 with varying delays (0s, 2s, 5s, 30s). Monitor: metadata
  server response times, Lidarr log errors, database consistency, Prowlarr indexer query counts.
- **Source**: Negative Space "Bulk Add Artist Performance Characteristics" knowledge gap,
  Systems-Thinker causal chain 1
- **Priority**: Critical -- determines whether rate limiting parameters are seconds, minutes, or
  entirely different

### EG-3: Plex-to-MusicBrainz ID Mapping Feasibility (Empirical)

- **What we do not know**: Whether Plex music library items reliably contain MusicBrainz IDs
  (foreignArtistId / foreignAlbumId) that can serve as canonical bridge identifiers to Lidarr. Plex
  uses its own metadata agents (Plex Music, Last.fm, Personal Media). The research assumes
  MusicBrainz IDs are the "lingua franca" (Archaeologist) and the "canonical bridge identifier"
  (Crucible analysis) but no persona verified this assumption against actual Plex API responses.
- **Why it matters**: The entire Plex-Lidarr bridge (Layer 3 of H6, identified as the "unique value
  proposition" by the crucible analysis) depends on mapping Plex artists/albums to Lidarr
  artists/albums. If Plex does not expose MusicBrainz IDs, the bridge must use fuzzy string matching
  on artist/album names, which is error-prone (the Contrarian documented matching failures in Lidarr
  itself with perfect MusicBrainz data).
- **What would resolve it**: Query the existing rfmedia-cli Plex client for artist/album metadata
  and inspect the response fields. Specifically check: (a) does Plex expose `guid` fields containing
  `mbid://` URIs?, (b) if using the Plex Music agent, are MusicBrainz IDs included?, (c) what
  percentage of a real library has MusicBrainz IDs vs. missing?
- **Source**: Archaeologist key insight 6, Crucible H6 Layer 3 design, Contrarian "matching
  failures"
- **Priority**: Critical -- the bridge strategy depends on this; rfmedia-cli already has
  `PlexArtist`, `PlexAlbum`, `PlexTrack` types in `/packages/rfmedia-cli/src/types/plex.ts`

### EG-4: Metadata Server Current Recovery Status (Empirical)

- **What we do not know**: The current operational status of api.lidarr.audio as of February 2026.
  The research documented outages from April-August 2025 and a rebuild with "no ETA." Is the
  metadata server now functional? Partially rebuilt? Still degraded? The Futurist noted "ongoing
  since May 2025; no estimated completion date as of late 2025" but did not check current status.
- **Why it matters**: The tiered architecture (H6) classifies operations as "local-only" vs.
  "metadata-dependent" based on the assumption that the metadata server is unreliable. If it has
  been stabilized, the conservative posture may be unnecessarily restrictive. If it remains broken,
  even more aggressive isolation is needed.
- **What would resolve it**: Check the Lidarr GitHub issues for recent metadata server status
  updates. Query `GET /api/v1/health` on a running Lidarr instance. Test
  `GET /api/v1/artist/lookup?term=Radiohead` to verify search functionality.
- **Source**: Futurist "Metadata Server Crisis and Rebuild," Contrarian metadata server analysis
- **Priority**: Critical -- calibrates the entire resilience engineering strategy

---

## Priority 2: High-Impact Knowledge Gaps

These gaps affect feature design and implementation strategy but have identified workarounds.

### EG-5: Lidarr API Pagination Behavior (Practical)

- **What we do not know**: The specific pagination mechanics for Lidarr API endpoints. Maximum page
  sizes, default limits, cursor-based vs. offset-based pagination, behavior when results exceed
  limits. The Negative Space persona called this "poorly documented." The Journalist documented that
  `/wanted/missing` supports `page`, `pageSize`, `sortKey`, `sortDirection`, `totalRecords` params
  but did not test edge cases. Existing bash scripts hit "Argument list too long" errors on large
  libraries.
- **Why it matters**: rfmedia-cli already solved Plex pagination (the recent PR fixing artist
  pagination loops proves this is non-trivial). Lidarr pagination must be equally robust for bulk
  operations on large libraries (75,000+ tracks reported).
- **What would resolve it**: Test endpoints systematically with varying `pageSize` values (100, 500,
  1000, 5000). Verify: (a) are there hard maximum page sizes?, (b) does `totalRecords` accurately
  reflect the total?, (c) do `GET /api/v1/artist` and `GET /api/v1/album` support pagination at all
  (some endpoints may return all results)?
- **Source**: Negative Space "Lidarr API Pagination Behavior" knowledge gap, Journalist
  wanted/missing documentation
- **Priority**: High -- affects all list/query commands

### EG-6: Artist Editor Bulk Update Request Format (Practical)

- **What we do not know**: The exact JSON body structure for `PUT /api/v1/artist/editor` (bulk
  update) and `DELETE /api/v1/artist/editor` (bulk delete). The Journalist noted: "The exact JSON
  body structure for PUT /api/v1/artist/editor needs extraction from the OpenAPI spec." The crucible
  analysis recommends using this endpoint for efficient batch operations but does not document the
  request format.
- **Why it matters**: This is the most efficient endpoint for bulk management (Layer 1 of H6). Using
  individual `PUT /api/v1/artist/{id}` requests for 500 artists would be 500 API calls; the editor
  endpoint could potentially do it in one.
- **What would resolve it**: Parse the Lidarr OpenAPI JSON spec (`openapi.json` from the develop
  branch) to extract the `ArtistEditorResource` schema. Alternatively, inspect TsArr's generated
  types for the editor model.
- **Source**: Journalist uncertainties section, Crucible H6 Layer 1 design
- **Priority**: High -- affects bulk operation efficiency

### EG-7: Last.fm API Rate Limits (Practical)

- **What we do not know**: The exact rate limits for Last.fm's API. The Systems-Thinker estimates
  "~5 req/sec" but notes this is "not clearly documented." The Archaeologist references Gazelle
  trackers' strict 5 req/10sec limits as a comparison but does not verify Last.fm's. No persona
  tested actual throttling behavior.
- **Why it matters**: The discovery layer (Layer 2 of H6) uses `artist.getSimilar` as the primary
  recommendation source. If the rate limit is lower than expected, discovery for a large seed
  library (e.g., iterating all 200 artists in Plex) could take much longer than anticipated.
- **What would resolve it**: Test empirically by sending rapid `artist.getSimilar` requests and
  monitoring for 429 responses or connection resets. Check Last.fm's terms of service for stated
  limits.
- **Source**: Systems-Thinker causal chain 3, Last.fm API documentation
- **Priority**: High -- affects discovery feature UX timing

### EG-8: ListenBrainz Similar Artists API Completeness (Practical)

- **What we do not know**: How comprehensive ListenBrainz's similar artists dataset actually is. The
  Futurist notes data is "nowhere near as comprehensive as Spotify" but does not quantify the gap.
  What percentage of artists in a typical Lidarr library would have similarity data in ListenBrainz?
  Is it 5%? 50%? 90%?
- **Why it matters**: If ListenBrainz covers only niche/mainstream artists, it cannot serve as a
  fallback for Last.fm. The recommended architecture treats ListenBrainz as the "long-term"
  replacement, but if coverage is insufficient, this future-proofing strategy may be premature.
- **What would resolve it**: Query the ListenBrainz Labs API (`/labs/api/similar-artists`) with a
  sample of 50 artists spanning genres (mainstream pop, underground metal, classical, jazz,
  electronic) and measure hit rate.
- **Source**: Futurist "ListenBrainz as the Open Alternative," Crucible H6 Layer 2
- **Priority**: High -- determines whether ListenBrainz is a viable fallback today

### EG-9: Lidarr Delete Endpoint File Behavior Across Docker Environments (Empirical)

- **What we do not know**: Whether `DELETE /api/v1/artist/{id}?deleteFiles=true` reliably deletes
  files when Lidarr runs in Docker with volume mounts. The Negative Space persona cited issue #2551
  documenting non-deletion but classified it as "may be environment-specific (Docker path mapping
  issues)." No persona verified the behavior.
- **Why it matters**: If delete operations silently fail to remove files, a CLI
  `rfmedia lidarr cleanup` command could mislead users into thinking space was reclaimed when it was
  not. This is particularly important for the compose.yml-based Docker deployment that rfmedia-apps
  uses.
- **What would resolve it**: Test `DELETE` with `deleteFiles=true` against a test artist in the
  actual rfmedia-apps Docker deployment. Verify that files are removed from the host filesystem
  through the Docker volume mount.
- **Source**: Negative Space "Delete Endpoint File Behavior" knowledge gap
- **Priority**: High -- affects cleanup/delete feature safety

### EG-10: Album Type Filtering via API (Practical)

- **What we do not know**: Whether the Lidarr API exposes album type information (Album, Single, EP,
  Compilation, DJ Mix, etc.) in the `GET /api/v1/album` response, and whether the
  `PUT /api/v1/album/monitor` endpoint can be used to selectively unmonitor by type. The Negative
  Space persona identifies "Bulk Unmonitor by Album Type" as the most requested feature and notes
  the community bash script uses `/album/monitor`, but no persona documented the album type field
  name in the API response.
- **Why it matters**: This is the Phase 1 killer feature (most requested, 6+ years of open issues).
  If album type is not in the response payload, the CLI would need to filter by some other
  mechanism.
- **What would resolve it**: Inspect the `AlbumResource` schema in the OpenAPI spec for fields like
  `albumType`, `releaseType`, or equivalent. Verify against actual API responses from a running
  instance.
- **Source**: Negative Space "Bulk Unmonitor by Album Type," Systems-Thinker "Metadata Profile
  Misconfiguration" cascade
- **Priority**: High -- blocks the highest-demand feature

---

## Priority 3: Theoretical and Framework Gaps

These gaps represent missing models or conceptual frameworks that would improve design quality.

### TG-1: Plex-Lidarr Data Model Mapping (Theoretical)

- **What is missing**: A formal mapping between Plex's music data model (Library -> Artist -> Album
  -> Track, with ratings, play counts, sonic analysis data, and metadata agent GUIDs) and Lidarr's
  data model (RootFolder -> Artist -> Album -> AlbumRelease -> Track, with quality profiles,
  metadata profiles, monitoring state, and MusicBrainz foreign IDs). No persona produced this
  mapping.
- **Why it matters**: Every bridge feature (gap analysis, rating sync, discovery seeding) requires
  translating between these two models. Without a formal mapping, each feature will implement its
  own ad-hoc translation, leading to inconsistencies.
- **What would improve it**: Create a data model diagram showing: (a) entity relationships in both
  systems, (b) common fields that can be directly mapped, (c) fields unique to each system, (d) the
  MusicBrainz ID as the canonical join key (if available -- see EG-3). Reference the Archaeologist's
  analysis of Beets' cross-service identifier mapping challenge.
- **Source**: Archaeologist "Beets' Cross-Service Identifier Mapping," Crucible H6 Layer 3
- **Priority**: High -- foundational for bridge design

### TG-2: Quality Profile Optimization Strategy (Theoretical)

- **What is missing**: A framework for how Plex listening data (ratings, play counts, skip counts)
  should map to Lidarr quality profile decisions. The crucible analysis proposes "upgrade
  highly-rated artists to FLAC" but does not define: what rating threshold? What play count minimum?
  Should recently added artists get a grace period before quality decisions? Should genre affect
  quality strategy (e.g., electronic music benefits more from lossless than spoken word)?
- **Why it matters**: The Plex-Lidarr bridge's "rating-informed quality" feature requires a decision
  model. Without one, the feature would be an opinionated hardcode or an overwhelming configuration
  matrix.
- **What would improve it**: Define 3-4 preset strategies (e.g., "Conservative" = only upgrade
  5-star artists with 10+ plays; "Quality First" = upgrade all artists with any play; "Space Saver"
  = downgrade artists with no plays after 90 days). Allow user selection with `--strategy` flag.
  Reference Recyclarr's approach of opinionated presets for Sonarr/Radarr quality profiles.
- **Source**: Negative Space "Quality Profile Management at Scale," Crucible H6 Layer 3, Journalist
  Recyclarr gap
- **Priority**: Medium -- affects feature design but not architecture

### TG-3: Discovery Feedback Loop Prevention Model (Theoretical)

- **What is missing**: A formal model for how discovery cascades should be bounded. The
  Archaeologist documented lidarr-extended's three configuration knobs
  (`numberOfRelatedArtistsToAddPerArtist`, `preventRelatedArtistsLoop`, `autoArtistAdderMonitored`)
  but no persona analyzed: (a) what "loop prevention" means mathematically (is it a simple
  visited-set, or depth-limited BFS?), (b) how the discovery graph should be traversed for
  multi-seed scenarios, (c) what the optimal max-per-seed is for balancing discovery breadth vs.
  library bloat.
- **Why it matters**: The Systems-Thinker identified the "Similar Artist Discovery Loop" as an
  amplifying feedback loop. Without a formal model, the implementation will be ad-hoc and
  potentially either too aggressive (library bloat) or too conservative (useless recommendations).
- **What would improve it**: Define discovery as a graph traversal problem: seed artists are roots,
  similar artists are edges, and the traversal has configurable depth (default 1), breadth (default
  10), and a visited set (already-in-library + already-recommended). Document the algorithm
  explicitly.
- **Source**: Archaeologist revival candidate 3, Systems-Thinker feedback loop 5
- **Priority**: Medium -- affects discovery feature design

### TG-4: Error Classification Taxonomy for Lidarr API (Theoretical)

- **What is missing**: A systematic classification of Lidarr API error types. The research
  documented specific errors (500 from metadata server, 503 with "x-all-rate-limited" header,
  "no-upstream-available", file not deleted) but no persona created a taxonomy distinguishing: (a)
  transient errors (retry will help), (b) metadata-server errors (retry may help after delay), (c)
  client errors (request is wrong), (d) structural errors (operation impossible). HTTP status codes
  alone are insufficient because a 500 can mean either "Lidarr bug" or "metadata server down."
- **Why it matters**: The tiered architecture (H6) requires different error handling per tier.
  Without a taxonomy, the CLI will either retry everything (wasting time on permanent failures) or
  fail-fast on everything (abandoning transient issues).
- **What would improve it**: Extract error patterns from the GitHub issues documented by the
  Contrarian and Journalist. Map each to a retry strategy: immediate retry, exponential backoff,
  user notification, or abort. Pay special attention to distinguishing "Lidarr is down" from
  "metadata server is down" (the irreconcilable contradiction IC1 from the mapping document).
- **Source**: Contrarian documented failures, Journalist API gotchas, Contradiction mapping IC1
- **Priority**: Medium -- affects error handling implementation

### TG-5: Interface Abstraction Design for Backend Swappability (Theoretical)

- **What is missing**: The Futurist and crucible analysis both recommend interface-based design
  (`MusicManager` interface with `LidarrManager` implementation) for backend swappability, but no
  persona defined what that interface should look like. What are the core operations? What return
  types? How does the interface handle Lidarr-specific concepts (quality profiles, metadata
  profiles) that may not exist in alternatives?
- **Why it matters**: If the interface is too Lidarr-specific, swapping to Naviseerr or direct
  MusicBrainz would require rewriting the interface. If too generic, Lidarr-specific features (bulk
  editor, monitoring state) would be lost behind a leaky abstraction.
- **What would improve it**: Survey the overlap between Lidarr, Beets, and MusicBrainz APIs to
  identify a core set of operations (list artists, add artist, remove artist, set
  monitoring/priority, search). Lidarr-specific operations (quality profiles, metadata profiles)
  should be exposed through optional extension interfaces, not the core contract. Reference
  rfapps-cli's existing patterns for service abstraction.
- **Source**: Futurist scenario 3, Crucible H6 design
- **Priority**: Medium -- affects long-term maintainability

---

## Priority 4: Implementation Knowledge Gaps

These gaps affect coding decisions but can be resolved during development.

### PG-1: Lidarr API Error Response Body Format (Practical)

- **What we do not know**: The structure of error response bodies from the Lidarr API. Do 4xx/5xx
  responses include a JSON body with error messages? Is there a standard
  `{ message: string, errorCode: string }` format? Or are some errors plain text? The OpenAPI spec
  may document this, but no persona extracted error schemas.
- **What would resolve it**: Inspect the OpenAPI spec for error response schemas. Trigger known
  error conditions (invalid API key, nonexistent artist ID, malformed request body) and capture
  response bodies.
- **Priority**: Medium

### PG-2: Webhook Event Payload Schemas (Practical)

- **What we do not know**: The complete set of Lidarr webhook events and their payload structures.
  The Negative Space persona noted "comprehensive webhook payload documentation is sparse." The
  Systems-Thinker mentioned webhooks fire on Grab, Download, and Upgrade events but did not document
  payloads.
- **What would resolve it**: Configure a test webhook pointing to a request bin service. Trigger
  events (add artist, download album, upgrade quality) and capture payloads. Cross-reference with
  the custom scripts wiki page.
- **Priority**: Low -- webhooks are not part of H6's initial phases

### PG-3: Custom Format API Completeness in TsArr (Practical)

- **What we do not know**: Whether TsArr's generated types cover Lidarr's custom format endpoints (a
  newer v3.1.x feature). The Journalist listed custom formats as a newer feature and noted "may have
  incomplete SDK support in older libraries."
- **What would resolve it**: Check TsArr's generated types for `CustomFormatResource` and related
  endpoints.
- **Priority**: Low -- custom formats are a Phase 2+ feature

### PG-4: Import List Creation via API (Practical)

- **What we do not know**: The exact schema for creating Spotify/Last.fm import lists
  programmatically via `POST /api/v1/importlist`. The Journalist noted this is "complex and not
  well-documented outside the Terraform provider." If rfmedia-cli wanted to set up import lists as
  part of an `init` workflow, this schema is needed.
- **What would resolve it**: Extract the import list schema from the OpenAPI spec. Reference the
  Terraform Lidarr provider's source code for tested request formats.
- **Priority**: Low -- import list creation is not in H6's design

### PG-5: Lidarr Command Endpoint Polling Behavior (Practical)

- **What we do not know**: How to poll for command completion after `POST /api/v1/command`. The
  Systems-Thinker recommended "poll command status via GET /api/v1/command/{id} to provide progress
  feedback" but did not document: (a) what status values are returned, (b) how long commands
  typically take, (c) whether there is a completion callback or only polling.
- **What would resolve it**: Trigger a `RefreshArtist` command and poll `/api/v1/command/{id}` at
  1-second intervals. Document status transitions (queued -> started -> completed / failed).
- **Priority**: Medium -- affects UX for any command that triggers server-side work

### PG-6: MusicBrainz API TypeScript Client Quality (Practical)

- **What we do not know**: Whether the `musicbrainz-api` npm package (mentioned by Futurist and
  Historian) is production-quality for rfmedia-cli's needs. What is its maintenance status? Does it
  support rate limiting natively? Does it handle the `artist-rels` include parameter needed for
  relationship traversal?
- **What would resolve it**: Inspect the package on npm for recent releases, download counts,
  TypeScript type quality. Test basic operations: artist lookup by MBID, `artist.getSimilar` via
  MusicBrainz relations.
- **Priority**: Medium -- affects Layer 2 discovery implementation

---

## Priority 5: User Research Gaps

These gaps represent assumptions about user needs that have not been validated.

### UG-1: Plex + Lidarr User Overlap (User Research)

- **What we do not know**: How many rfmedia-cli users also run Lidarr. rfmedia-cli is currently a
  file-management and Plex-integration tool. Adding Lidarr integration assumes users operate both
  systems. If the overlap is small, the integration may serve a niche within a niche.
- **Why it matters**: The entire integration effort is premised on users having both Plex and
  Lidarr. If most rfmedia-cli users do not run Lidarr, the layered architecture should prioritize
  discovery features (usable without Lidarr) over management features (require Lidarr).
- **What would resolve it**: Survey existing users, check compose.yml service definitions (the
  rfmedia-apps compose.yml does include Lidarr in the arr-stack profile), or analyze GitHub issue
  requests for Lidarr-related features.
- **Source**: Implicit in all personas, never explicitly addressed
- **Priority**: High -- validates the entire integration thesis

### UG-2: User Preference for Discovery UX (User Research)

- **What we do not know**: How users want to interact with similar artist discovery in a CLI
  context. Interactive selection (checkboxes, numbered lists)? Batch mode with JSON output?
  Preview-then-apply workflow? The Archaeologist described Headphones' command structure, and the
  crucible analysis proposed `rfmedia lidarr discover --artist "Radiohead"`, but no persona
  validated whether CLI-based discovery is actually desirable vs. a web UI (Lidify, Aurral).
- **Why it matters**: If users prefer web UIs for discovery (visual browsing, album art, audio
  previews), a CLI implementation may see low adoption regardless of technical quality.
- **What would resolve it**: Study how users interact with existing CLI music tools (beets,
  musicbrainz-cli). Review feedback on Lidify/Aurral to understand whether the web UI is the draw or
  just the discovery capability.
- **Source**: Futurist "UX Shift: From CLI to GUI" trend
- **Priority**: Medium -- affects Phase 2 design

### UG-3: Bulk Operation Frequency and Scale (User Research)

- **What we do not know**: How often users need bulk operations and at what scale. The Negative
  Space persona documents demand (6+ years of GitHub issues) but not frequency. Is this a one-time
  library cleanup? A monthly maintenance task? A daily automation? The answer affects whether the
  CLI should optimize for interactive use (progress bars, confirmation prompts) or scripted use
  (JSON output, exit codes, --yes flag).
- **Why it matters**: Determines whether bulk operations should be interactive-first or
  scriptable-first.
- **What would resolve it**: Analyze the community bash scripts (Gists documented by Journalist) for
  usage patterns. Check cron-related discussions in Lidarr forums.
- **Source**: Negative Space bulk operations analysis, Systems-Thinker stakeholder analysis
- **Priority**: Medium -- affects CLI interaction design

### UG-4: Acceptable Latency for Discovery Operations (User Research)

- **What we do not know**: How long users are willing to wait for similar artist discovery results.
  The Systems-Thinker noted Aurral's discovery takes "10-20 seconds" due to MusicBrainz rate
  limiting. Is this acceptable for a CLI tool? Users expect CLI tools to be fast. If discovery
  requires 30+ seconds of API calls (Last.fm rate limiting, cross-referencing with Lidarr library),
  users may abandon the feature.
- **Why it matters**: If acceptable latency is under 5 seconds, the discovery feature needs
  aggressive caching and parallel requests. If 30 seconds is fine, simpler sequential implementation
  suffices.
- **What would resolve it**: Benchmark Last.fm `artist.getSimilar` response times. Measure time to
  cross-reference 20 results against a Lidarr library of 200 artists. Evaluate whether a
  spinner/progress indicator changes perceived latency tolerance.
- **Source**: Systems-Thinker causal chain 3
- **Priority**: Medium

### UG-5: Desired Granularity for Gap Analysis (User Research)

- **What we do not know**: What level of detail users want from a Plex-Lidarr gap analysis.
  Artist-level ("These 15 artists are in Plex but not Lidarr")? Album-level ("These 30 albums exist
  on disk but are not tracked by Lidarr")? Track-level ("These files in Plex have no matching Lidarr
  entry")?
- **Why it matters**: Artist-level is simple but coarse. Track-level requires the track endpoint and
  complex matching logic. The right granularity determines implementation complexity.
- **What would resolve it**: Start with artist-level (simplest, covers the majority use case) and
  iterate based on feedback.
- **Source**: Negative Space "No Lidarr-to-Plex Gap Analysis Tool"
- **Priority**: Low -- iterative approach mitigates this gap

---

## Priority 6: Temporal and Environmental Gaps

These gaps relate to things that may have changed since the research was conducted.

### TEG-1: Lidarr v2 Plugin System Current State (Temporal)

- **What we do not know**: The current state of Lidarr's plugin system. Tubifarry demonstrates C#
  plugins work, but the Archaeologist noted "the Lidarr v2 plugin system may change the landscape
  significantly (not covered in this archaeological review)." Is the plugin API stable? Are there
  breaking changes planned? Could rfmedia-cli theoretically register as a Lidarr plugin rather than
  an external API consumer?
- **Why it matters**: If Lidarr's plugin system matures, some features (similar artist discovery,
  bulk operations) might be better implemented as plugins than as external CLI commands.
- **What would resolve it**: Review Tubifarry's source code for the plugin API surface. Check
  Lidarr's codebase for plugin interface definitions.
- **Priority**: Low -- rfmedia-cli is a CLI tool, not a Lidarr plugin

### TEG-2: Aurral's Architecture After Rebuild (Temporal)

- **What we do not know**: Aurral is "undergoing significant rebuild" (Journalist). Its
  architecture, API patterns, and discovery approach may have changed since the research was
  conducted. The project had 359 stars in its first month, suggesting rapid evolution.
- **Why it matters**: Aurral's MusicBrainz tag-based discovery approach could be a design reference.
  If the rebuild changes the approach significantly, our design references may be stale.
- **What would resolve it**: Check Aurral's repository for recent commits and architecture
  documentation.
- **Priority**: Low -- affects design reference, not architecture

### TEG-3: Spotify Import List Future Restrictions (Temporal)

- **What we do not know**: Whether Spotify will further restrict the API endpoints that Lidarr's
  built-in import lists use. The Futurist noted Spotify locked down Related Artists,
  Recommendations, and Audio Features for new apps in November 2024, but Lidarr's existing Spotify
  import lists "continue to work." Will grandfathering persist?
- **Why it matters**: If Spotify import lists break, users will need alternative ways to add artists
  to Lidarr -- strengthening the case for rfmedia-cli's discovery features.
- **What would resolve it**: Monitor Spotify developer announcements. This is not resolvable through
  testing.
- **Priority**: Low -- rfmedia-cli does not depend on Spotify

### TEG-4: Last.fm API Long-Term Viability (Temporal)

- **What we do not know**: Whether Last.fm's API will remain free, unrestricted, and maintained
  long-term. Last.fm was acquired by CBS Interactive (2007), then Sirius XM (through Pandora, 2020).
  Corporate ownership changes could lead to API restrictions similar to Spotify's.
- **Why it matters**: Last.fm is the recommended primary discovery source. If it is restricted, the
  discovery layer needs ListenBrainz or MusicBrainz as the primary source.
- **What would resolve it**: Design the discovery layer with source abstraction from day one
  (already recommended by the crucible analysis). This mitigates the risk regardless of outcome.
- **Priority**: Low -- mitigated by architectural decision

---

## Cross-Cutting Observations

### The Biggest Single Gap: No Empirical Validation

The most striking absence across all 8 persona findings is that **no persona performed empirical
testing against a running Lidarr instance**. Every finding is based on documentation review, GitHub
issue analysis, and third-party tool inspection. The research is comprehensive in secondary analysis
but has zero first-hand API interaction data. This means:

- Rate limit numbers are estimates, not measurements
- Pagination behavior is inferred from OpenAPI docs, not tested
- Error handling patterns are derived from other people's bug reports, not experienced
- Performance characteristics are extrapolated from a single blog post, not benchmarked

**Recommendation**: Before implementation begins, conduct a focused empirical validation sprint: set
up a test Lidarr instance with a small library (50 artists), exercise the key API operations
documented by the Journalist, and document actual behavior. This would resolve EG-1 through EG-6 and
EG-9 through EG-10 in a single focused effort.

### The Second Biggest Gap: User Research is Entirely Absent

All 8 personas analyzed the technology. None analyzed the user. User needs are inferred from GitHub
issues (complaints = unmet needs) and tool adoption (stars = demand). But there is no data on:

- Who currently uses rfmedia-cli and how
- What percentage of the self-hosted music community runs both Plex and Lidarr
- Whether CLI-based music discovery is desirable or merely technically possible
- What the actual pain distribution is (are most users bothered by bulk operations, discovery, or
  something else entirely?)

**Recommendation**: Before designing Phase 2 (Discovery) and Phase 3 (Bridge), gather minimal user
signal. This could be as simple as a GitHub issue asking "Would you use Lidarr integration? What
operations matter most?" or analyzing existing rfmedia-cli issue tracker for Lidarr-related
requests.

### The Third Biggest Gap: rfmedia-cli Codebase Impact Not Analyzed

No persona examined how the Lidarr integration would fit into rfmedia-cli's existing codebase
architecture. Specific unanswered questions:

- How does the existing Plex client (`/packages/rfmedia-cli/src/lib/plex.ts`) implement pagination,
  caching, and error handling? The Lidarr client should follow the same patterns.
- The existing config system (`.rfmedia.yaml`) uses `{{ VAR_NAME }}` template syntax for secrets.
  How would Lidarr API key and URL be configured? In the same file? A separate section?
- The existing command/action separation pattern requires specific file organization. Where do
  `lidarr` commands go? A `commands/lidarr/` subdirectory? A single `commands/lidarr.ts` with
  subcommands?
- The existing output format system (`formatOutput`, `--output json|yaml|csv`) must support Lidarr
  data types. What formatters are needed?
- The plugin system (`plugin-loader.ts`, `plugin-runner.ts`) -- should Lidarr integration be a
  built-in feature or a plugin?

**Recommendation**: Conduct a focused codebase research sprint examining rfmedia-cli's existing
patterns (Plex client, config, commands, output) to define the integration's architectural home
before implementation begins.

---

## Summary Table

| ID    | Category      | Gap                                | Priority | Resolution Method                  |
| ----- | ------------- | ---------------------------------- | -------- | ---------------------------------- |
| EG-1  | Empirical     | TsArr Node.js compatibility        | Critical | Install and test                   |
| EG-2  | Empirical     | Bulk add performance               | Critical | Load testing                       |
| EG-3  | Empirical     | Plex MusicBrainz ID availability   | Critical | Query existing Plex data           |
| EG-4  | Empirical     | Metadata server current status     | Critical | Health check + search test         |
| EG-5  | Practical     | API pagination mechanics           | High     | Systematic endpoint testing        |
| EG-6  | Practical     | Artist editor request format       | High     | OpenAPI spec extraction            |
| EG-7  | Practical     | Last.fm rate limits                | High     | Empirical testing                  |
| EG-8  | Practical     | ListenBrainz coverage depth        | High     | Sample query testing               |
| EG-9  | Empirical     | Delete file behavior in Docker     | High     | Test in rfmedia-apps deployment    |
| EG-10 | Practical     | Album type field in API response   | High     | OpenAPI spec + live query          |
| TG-1  | Theoretical   | Plex-Lidarr data model mapping     | High     | Data model diagram                 |
| TG-2  | Theoretical   | Quality profile optimization model | Medium   | Define preset strategies           |
| TG-3  | Theoretical   | Discovery loop prevention model    | Medium   | Graph traversal formalization      |
| TG-4  | Theoretical   | Error classification taxonomy      | Medium   | Pattern extraction from issues     |
| TG-5  | Theoretical   | Backend abstraction interface      | Medium   | Cross-system API survey            |
| PG-1  | Practical     | Error response body format         | Medium   | OpenAPI spec + error testing       |
| PG-2  | Practical     | Webhook event payloads             | Low      | Webhook capture testing            |
| PG-3  | Practical     | Custom format TsArr support        | Low      | TsArr type inspection              |
| PG-4  | Practical     | Import list creation schema        | Low      | OpenAPI spec extraction            |
| PG-5  | Practical     | Command polling behavior           | Medium   | Live testing                       |
| PG-6  | Practical     | musicbrainz-api npm quality        | Medium   | Package inspection + testing       |
| UG-1  | User Research | Plex + Lidarr user overlap         | High     | User survey / compose.yml analysis |
| UG-2  | User Research | Discovery UX preferences           | Medium   | CLI music tool usage patterns      |
| UG-3  | User Research | Bulk operation frequency           | Medium   | Community script analysis          |
| UG-4  | User Research | Discovery latency tolerance        | Medium   | Benchmark + UX testing             |
| UG-5  | User Research | Gap analysis granularity           | Low      | Iterative delivery                 |
| TEG-1 | Temporal      | Lidarr plugin system state         | Low      | Source code review                 |
| TEG-2 | Temporal      | Aurral rebuild architecture        | Low      | Repository check                   |
| TEG-3 | Temporal      | Spotify import list future         | Low      | Unresolvable (monitor)             |
| TEG-4 | Temporal      | Last.fm long-term viability        | Low      | Mitigated by architecture          |

---

## Recommended Resolution Sequence

1. **Immediate (before any implementation)**: EG-1, EG-3, EG-4, EG-10 -- These four empirical tests
   can be completed in a single focused session and resolve the most critical unknowns.
2. **Pre-Phase 1**: EG-5, EG-6, TG-4, PG-1 -- Required for robust bulk management implementation.
3. **Pre-Phase 2**: EG-7, EG-8, TG-3, PG-6 -- Required for discovery feature implementation.
4. **Pre-Phase 3**: EG-2, EG-9, TG-1, TG-2, UG-1 -- Required for Plex-Lidarr bridge implementation.
5. **Ongoing**: UG-2 through UG-5 -- Gather user feedback throughout development.
