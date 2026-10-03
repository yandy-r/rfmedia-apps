# Contradiction Mapping: Lidarr API Integration Research

## Overview

Seven persona analyses of Lidarr API integration for rfmedia-cli produced 14 distinct contradictions across factual claims, strategic recommendations, interpretive framing, and temporal assessments. The most consequential contradictions concern: (1) whether the metadata server fragility is a dealbreaker or a manageable engineering problem, (2) whether TsArr is a ready-to-use solution or requires significant adaptation, (3) whether Lidarr should be treated as a CRUD-only local tool or a comprehensive integration target, and (4) whether the track-level API gap is a fundamental blocker or an irrelevant concern for rfmedia-cli's use cases.

---

## Contradiction Severity Matrix

| #   | Contradiction                                                        | Personas in Tension                                                      | Severity     | Resolution Confidence |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------ | --------------------- |
| C1  | Metadata server: dealbreaker vs. manageable risk                     | Contrarian vs. Historian, Systems-Thinker, Journalist                    | **Critical** | Medium                |
| C2  | Track-level API: fundamental gap vs. non-issue                       | Contrarian vs. Journalist, Negative-Space                                | **High**     | High                  |
| C3  | TsArr: ready-to-use vs. requires adaptation                          | Historian vs. Journalist, Futurist                                       | **High**     | Medium                |
| C4  | Lidarr scope: narrow CRUD-only vs. comprehensive integration         | Contrarian vs. Historian, Systems-Thinker, Archaeologist                 | **Critical** | Medium                |
| C5  | API endpoint count: "50-100" vs. "80+" vs. partial coverage          | Historian vs. Journalist vs. Archaeologist                               | **Low**      | High                  |
| C6  | Discovery feature: biggest opportunity vs. wrong reason to integrate | Contrarian vs. Historian, Journalist, Negative-Space, Archaeologist      | **Critical** | High                  |
| C7  | Beets: complement vs. alternative to Lidarr integration              | Contrarian vs. Historian, Archaeologist                                  | **Medium**   | Medium                |
| C8  | API stability assessment: stable vs. fragile                         | Historian, Systems-Thinker vs. Contrarian, Futurist                      | **High**     | High                  |
| C9  | Development pace: beneficial stability vs. concerning stagnation     | Futurist vs. Historian                                                   | **Medium**   | Medium                |
| C10 | pyarr status: "established and maintained" vs. "inactive"            | Journalist vs. Archaeologist                                             | **Low**      | High                  |
| C11 | Recommendation source priority: Last.fm-first vs. ListenBrainz-first | Archaeologist, Journalist vs. Futurist                                   | **Medium**   | Medium                |
| C12 | Bulk operations: high-value feature vs. systemic risk                | Systems-Thinker, Negative-Space vs. Systems-Thinker (self-contradicting) | **High**     | High                  |
| C13 | Naviseerr: design reference vs. potential Lidarr replacement         | Historian vs. Futurist                                                   | **Low**      | Low                   |
| C14 | Monolithic vs. composable architecture for CLI                       | Historian vs. Negative-Space, Futurist                                   | **Medium**   | High                  |

---

## Detailed Contradiction Analysis

### C1: Metadata Server Fragility -- Dealbreaker vs. Manageable Risk

**What contradicts what:**

- **Contrarian** treats the metadata server as an existential risk: "Building a dependency on Lidarr means inheriting its architectural fragility without gaining the discovery features that justify the integration." Cites five separate outages in five months (April-August 2025), the "Won't Fix" closure of self-hosted metadata requests (#5558), and calls it "the single most important risk factor."
- **Futurist** assigns highest probability (60-70%) to the scenario where the metadata server "remains a single point of failure" with "periodic outages" continuing, and recommends building fallback paths.
- **Historian** acknowledges the outages but frames them as a cyclical pattern ("every *arr application faces metadata source challenges") within a broader stable ecosystem, and concludes "the *arr API convention is stable and predictable."
- **Systems-Thinker** takes a middle ground: the metadata server is "the weakest link in the chain" but proposes concrete mitigations (health checks, local caching, graceful degradation) as engineering solutions.
- **Journalist** documents the outages factually but still recommends integration, treating metadata fragility as a "gotcha" to work around rather than a reason to avoid Lidarr.

**Significance:** Critical. This is the most important architectural decision for the integration. If the Contrarian is right, the integration scope should be minimal (local-only operations). If the Systems-Thinker is right, the integration should be comprehensive but resilient.

**Which has better evidence:** The Contrarian has the strongest primary evidence (specific GitHub issue numbers, developer responses, "Won't Fix" closures). However, the Systems-Thinker's mitigation strategies are also well-supported by how existing tools (Lidify, Aurral) successfully handle this fragility in practice.

**Resolution:** The Contrarian and Systems-Thinker are both right but addressing different questions. The Contrarian correctly identifies the risk; the Systems-Thinker correctly identifies the mitigation. The practical resolution is to **adopt the Systems-Thinker's tier model**: separate operations into "local-only" (list, edit, delete, monitor) which are reliable, and "metadata-dependent" (search, lookup, add new artists) which require resilience engineering. The Contrarian's recommendation to "scope narrowly" should be interpreted as "scope narrowly for v1, expand as resilience is proven."

---

### C2: Track-Level API Gap -- Fundamental Blocker vs. Non-Issue

**What contradicts what:**

- **Contrarian** calls track-level operations "a fundamental gap" and argues "rfmedia-cli works with Plex at the track/file level. Lidarr operates at the artist/album level. Bridging this granularity mismatch will require significant custom logic." Notes there is "no `/api/v1/track` endpoint for independent track operations."
- **Journalist** documents `GET /api/v1/track` and `GET /api/v1/trackfile` endpoints with filtering by `artistId`, `albumId`, `albumReleaseId`, and `trackIds`. Also documents `PUT /api/v1/trackfile/{id}` for updating track file metadata and `DELETE /api/v1/trackfile/bulk` for bulk deletion.
- **Negative-Space** identifies the album-centric model as "high severity" but focuses on the acquisition mismatch (complete album downloads), not the API gap.

**Significance:** High. If the Contrarian is right that track endpoints do not exist, the Plex-Lidarr bridge becomes much harder. If the Journalist is right that they do exist, the bridge is more feasible.

**Which has better evidence:** The Journalist wins decisively here. The track and trackfile endpoints are documented in the official OpenAPI specification, which the Journalist directly cites. The Contrarian appears to have made a factual error, or was referring to a different claim -- that tracks cannot be independently queried without a parent artist/album context (which is a different limitation than "no track endpoint exists").

**What the contradiction reveals:** The Contrarian may have conflated two issues: (1) whether track endpoints exist (they do) and (2) whether tracks can be queried independently without knowing the artist (they cannot, per issue #732). The Journalist's factual reporting is more accurate, but the Contrarian's underlying point -- that Lidarr's data model is album-centric and does not support track-level discovery or independent track management -- remains valid at the conceptual level.

**Resolution:** Track/trackfile endpoints exist and support read/update/delete operations when you know the parent artist or album. The gap is in independent track discovery and track-level acquisition (you cannot tell Lidarr "get me just this one track"). For rfmedia-cli's use case of bridging Plex and Lidarr, the existing endpoints are sufficient because the CLI would already know the artist/album context from Plex data.

---

### C3: TsArr SDK -- Ready to Use vs. Requires Adaptation

**What contradicts what:**

- **Historian** presents TsArr positively as "the first actively maintained TypeScript SDK for Lidarr APIs" with "16 releases" and notes "the auto-generation approach from OpenAPI specs means it can stay current with API changes."
- **Journalist** identifies a practical concern: TsArr's "Runtime: Bun (with native fetch)" and lists as an uncertainty whether "it works with Node.js without modification."
- **Futurist** echoes this, noting rfmedia-cli uses Node.js, not Bun.

**Significance:** High. If TsArr works seamlessly with Node.js, it dramatically reduces integration effort. If it requires Bun, rfmedia-cli would need to either add Bun as a dependency, fork TsArr, or generate its own client.

**Which has better evidence:** The Journalist's concern is more grounded because it identifies a specific technical incompatibility. The Historian's assessment is accurate about TsArr's capabilities but does not address the runtime mismatch.

**What the contradiction reveals:** Both are presenting factual information but at different levels of detail. The Historian focused on ecosystem availability; the Journalist and Futurist focused on practical integration constraints.

**Resolution:** Needs empirical testing. TsArr uses `@hey-api/openapi-ts` for code generation and native `fetch` for HTTP calls. Since Node.js 18+ supports native `fetch`, TsArr may work without modification. However, if TsArr has Bun-specific dependencies beyond fetch, rfmedia-cli should consider generating its own client from Lidarr's OpenAPI spec using the same `@hey-api/openapi-ts` generator. The Archaeologist's recommendation to follow the auto-generated SDK pattern (devopsarr approach) provides the fallback strategy.

---

### C4: Integration Scope -- Narrow CRUD-Only vs. Comprehensive

**What contradicts what:**

- **Contrarian** recommends scoping narrowly: "Only integrate with Lidarr for operations that are genuinely local (list, edit, delete, monitor/unmonitor artists and albums). Do not depend on search or metadata refresh for critical CLI workflows." Suggests using Last.fm/MusicBrainz directly for everything else.
- **Historian** advocates for comprehensive integration, calling rfmedia-cli's opportunity "bridging the gap between Plex (consumption/playback) and Lidarr (acquisition/management)" and suggesting the CLI should "expose discrete operations (add artist, discover similar, check quality, sync with Plex)."
- **Systems-Thinker** maps out extensive causal chains showing how CLI operations cascade through the full system (Chain 1: CLI Add Artist -> Full Pipeline Execution), implying comprehensive integration is the design intent.
- **Archaeologist** recommends reviving patterns from Headphones, DiscoveryLastFM, and lidarr-extended that all involve deep Lidarr integration (adding artists, triggering searches, managing monitoring state).
- **Negative-Space** identifies 6+ missing features that each require comprehensive API integration.

**Significance:** Critical. This is the core strategic question: is rfmedia-cli a thin Lidarr wrapper for local operations, or a comprehensive bridge between Plex, Lidarr, and discovery APIs?

**Which has better evidence:** Both sides have strong evidence, but they are optimizing for different things. The Contrarian optimizes for reliability and minimal blast radius. The other five personas optimize for user value and ecosystem positioning.

**What the contradiction reveals:** This is a classic reliability-vs-functionality tradeoff. The Contrarian is right that deeper integration means more failure modes. The other personas are right that narrow integration diminishes the value proposition.

**Resolution:** Use a **tiered integration architecture**. Tier 1 (always reliable): local CRUD operations against Lidarr's database -- list, edit, delete, monitor/unmonitor. Tier 2 (resilient with fallbacks): discovery and search using Last.fm/MusicBrainz directly, with Lidarr's `POST /api/v1/artist` as the "add to library" step. Tier 3 (best-effort): operations depending on Lidarr's metadata server -- refresh, lookup, full search. Each tier has its own error handling strategy. This satisfies the Contrarian's reliability concerns while preserving the value proposition that five other personas identify.

---

### C5: API Endpoint Count

**What contradicts what:**

- **Historian** cites the Go starr library saying "50-100 API endpoints" per app and acknowledges this "has not been independently verified."
- **Journalist** documents "80+ endpoints" based on direct OpenAPI spec analysis.
- **Archaeologist** cites the starr library as covering "about 10%" of endpoints, implying a much larger total.

**Significance:** Low. The exact count does not materially affect integration decisions.

**Resolution:** The Journalist's "80+" from direct OpenAPI spec analysis is the most reliable figure. The starr library's "10%" claim likely refers to endpoints with full Go wrapper functions, not total available endpoints.

---

### C6: Discovery Feature -- Biggest Opportunity vs. Wrong Reason to Integrate

**What contradicts what:**

- **Historian** calls discovery "the killer feature" and notes tools like Lidify and Aurral "consistently achieving rapid adoption shows that artist/album discovery is the most demanded feature gap."
- **Journalist** agrees: "Similar artist discovery is the biggest integration opportunity."
- **Negative-Space** agrees: "Similar artist discovery as a CLI feature has no competition."
- **Archaeologist** agrees and provides detailed revival candidates (Headphones' getSimilar, DiscoveryLastFM, lidarr-extended).
- **Contrarian** sharply disagrees: "The 'similar artists' feature -- the primary motivator for this integration -- does not exist in Lidarr's API. Any implementation would need to call Last.fm, Spotify, or MusicBrainz APIs directly. Lidarr would only serve as the 'add to library' step, which is a thin justification for a full integration dependency." Also raises popularity bias concerns from academic research.

**Significance:** Critical. This determines whether discovery is a first-class feature or an afterthought.

**Which has better evidence:** Both sides are factually correct but framing differently. The Contrarian is right that Lidarr has zero discovery endpoints. The other personas are right that the workflow of "discover via Last.fm/MusicBrainz -> add via Lidarr" is valuable and proven. The disagreement is about whether Lidarr's role as "just the add step" is sufficient justification.

**What the contradiction reveals:** The Contrarian is using a narrow definition of "Lidarr integration" (does Lidarr's API provide discovery?) while other personas use a broader definition (does integrating with Lidarr enable a discovery workflow?). The broader definition is more useful because the end-to-end workflow is what users care about.

**Resolution:** Discovery is a high-value feature that rfmedia-cli should implement. The Contrarian is right that the discovery logic itself (Last.fm/ListenBrainz/MusicBrainz queries) is independent of Lidarr. The correct architecture is: discovery module (independent of Lidarr) produces recommendations -> Lidarr module (optional) handles the "add to library" step. The popularity bias concern from the Contrarian is worth addressing with configurable similarity thresholds and preview-before-add UX. The discovery feature does NOT depend on Lidarr integration -- it enhances it.

---

### C7: Beets -- Complement vs. Alternative to Lidarr

**What contradicts what:**

- **Contrarian** suggests "Beets or direct MusicBrainz/Last.fm integration may serve rfmedia-cli's needs better" than Lidarr, citing Lidarr's own developers acknowledging Beets' superiority for library management.
- **Historian** describes Beets as a "forgotten alternative" that is "worth revisiting" for its plugin architecture and MusicBrainz integration patterns, but positions it as complementary to Lidarr, not a replacement.
- **Archaeologist** treats Beets as a design reference for extensibility and cross-service identifier mapping, not as an integration target.
- **Futurist** mentions Beets as a "gold standard" CLI model, suggesting potential interoperability rather than replacement.

**Significance:** Medium. This affects whether rfmedia-cli should integrate with Beets, Lidarr, or both.

**Which has better evidence:** The Contrarian's citation of a Lidarr developer acknowledging Beets' superiority (issue #1022) is real but from the project's earlier history. The practical concern is that Beets and Lidarr serve different functions: Beets manages local library metadata, Lidarr manages acquisition and monitoring. They are not directly substitutable.

**Resolution:** Beets is a complement, not an alternative. Lidarr handles acquisition (download automation, monitoring, indexer integration); Beets handles post-acquisition organization (tagging, renaming, library management). rfmedia-cli should integrate with Lidarr for acquisition/monitoring and could optionally support Beets for post-processing, but they address different problems.

---

### C8: API Stability -- Stable Foundation vs. Fragile Surface

**What contradicts what:**

- **Historian** concludes "the \*arr API convention is stable and predictable" and notes "the fundamental API patterns (REST, JSON, API key auth, `/api/v1/` paths) have remained consistent since 2017."
- **Systems-Thinker** states "API stability is reasonable but metadata server stability is not. The fragility is in the metadata layer, not the API layer."
- **Contrarian** frames the API as unstable by documenting outages, race conditions, and behavioral quirks, leading with "Lidarr's API is a stable foundation for CLI tooling" as a claim to _disprove_.
- **Futurist** reports the develop branch was "last updated October 14, 2025" and calls the slow development pace a mixed signal.

**Significance:** High. This determines how much defensive engineering rfmedia-cli needs.

**Which has better evidence:** The Systems-Thinker provides the clearest resolution: the API interface (endpoint signatures, request/response formats, authentication) IS stable. The metadata layer BEHIND the API is fragile. These are two distinct things. The Contrarian conflates them.

**Resolution:** The API layer itself is stable and reliable for building against. The metadata service that some API calls depend on is fragile. The Systems-Thinker's distinction is the correct framing. Design the CLI client to trust the API contract but handle metadata service failures gracefully.

---

### C9: Development Pace -- Beneficial Stability vs. Concerning Stagnation

**What contradicts what:**

- **Futurist** interprets Lidarr's slow development as both a benefit ("API v1 is likely to remain stable for the foreseeable future") and a concern (confusing versioning, "v1.0 milestone" is 68% complete while releases are at v3.1.x, develop branch stale for months).
- **Historian** frames the maturation positively: "the fork chain has largely stabilized" and "the ecosystem's growth vector is now companion tools and integrations, not new forks."

**Significance:** Medium. Affects long-term maintenance planning for the integration.

**Resolution:** Both are correct from their respective time horizons. For the next 1-2 years (rfmedia-cli's initial development window), slow Lidarr development is beneficial because the API surface will not change. For the 3-5 year horizon, it raises questions about whether Lidarr will be maintained at all. The Futurist's recommendation to "abstract the backend layer" (interface-based design) is the correct mitigation for the long-term risk.

---

### C10: pyarr Status

**What contradicts what:**

- **Journalist** describes pyarr as "established and maintained" with "comprehensive Lidarr support" and "the most detailed method-level documentation available."
- **Archaeologist** reports pyarr's "last release (v5.2.0) was July 28, 2023" with maintenance classified as "inactive."

**Significance:** Low. rfmedia-cli uses TypeScript, not Python. This only matters as a reference for API patterns.

**Resolution:** The Archaeologist has better evidence. pyarr is factually inactive (no releases since 2023). The Journalist appears to have been describing its documentation quality (which remains useful as a reference) rather than its maintenance status.

---

### C11: Recommendation Source Priority

**What contradicts what:**

- **Archaeologist** and **Journalist** both position Last.fm as the primary recommendation source, with the Archaeologist calling it "the most reliable open recommendation source."
- **Futurist** predicts "ListenBrainz Will Become the Default Music Discovery API" and recommends integrating both but emphasizing ListenBrainz for "long-term alignment with the open-source ecosystem."
- **Contrarian** mentions Last.fm's collaborative filtering creates "popularity bias" and suggests ListenBrainz as a potential alternative with "potentially less popularity bias."

**Significance:** Medium. Affects which API to integrate first and how much effort to invest in each.

**Which has better evidence:** For current capability, the Archaeologist/Journalist are right -- Last.fm has a mature, proven API available today. For future trajectory, the Futurist makes a compelling case that ListenBrainz's open licensing and MetaBrainz Foundation backing provide better long-term alignment. The Futurist also acknowledges ListenBrainz data is "nowhere near as comprehensive as Spotify."

**Resolution:** Implement Last.fm first (proven, available, comprehensive), design with abstraction to add ListenBrainz later. The Contrarian's popularity bias concern is valid but applies to Last.fm and ListenBrainz alike (both use collaborative filtering). Address it through UX (preview before add, configurable thresholds) rather than source selection.

---

### C12: Bulk Operations -- High-Value Feature vs. Systemic Risk

**What contradicts what:**

- **Negative-Space** identifies bulk operations as "the most immediately impactful CLI feature" and documents specific user pain points (manual UI clicking, fragile bash scripts).
- **Systems-Thinker** also identifies bulk operations as valuable (leverage point #3: "Dry-Run Mode for All Destructive Operations") but simultaneously warns that "adding 50 artists is not 50x the impact of adding one -- it's potentially 50 x 20 albums x N indexer queries" and can exhaust Prowlarr rate limits for the entire \*arr stack.
- The Systems-Thinker is in tension with itself: bulk operations are both the highest-value feature and the highest-risk feature.

**Significance:** High. The CLI's bulk operation design must balance user value against systemic impact.

**Which has better evidence:** Both sides of this tension are well-documented. The Negative-Space cites specific GitHub issues showing user demand. The Systems-Thinker cites TRaSH Guides and Prowlarr rate limit documentation showing blast radius.

**Resolution:** This is a productive tension, not a contradiction. The resolution is engineering: implement bulk operations with progressive disclosure, dry-run modes, rate limiting, and clear cascade warnings. The Systems-Thinker's specific recommendations (default `searchForNewArtist: false`, `--max-add N` flag, metadata profile selection at add time) are the correct controls. The Negative-Space's identified features (bulk unmonitor by album type, mass editor profile changes) are lower-risk bulk operations that do not trigger the indexer/download cascade.

---

### C13: Naviseerr Assessment

**What contradicts what:**

- **Historian** classifies Naviseerr as "too new to evaluate" and notes "previous all-in-one approaches (docker-lidarr-extended) failed due to complexity."
- **Futurist** takes Naviseerr more seriously, noting "Version 2.0 plans to replace Lidarr entirely" and including it in Scenario 3 (Lidarr gradually replaced).

**Significance:** Low. Naviseerr is early alpha with a single developer.

**Resolution:** The Historian's skepticism based on historical patterns is better grounded. Naviseerr is worth monitoring but should not influence rfmedia-cli's architecture decisions today. The Futurist's recommendation to use interface-based backend abstraction is a reasonable hedge regardless of Naviseerr's trajectory.

---

### C14: Monolithic vs. Composable Architecture

**What contradicts what:**

- **Historian** explicitly argues "composable beats monolithic" based on docker-lidarr-extended's failure, recommending "discrete operations (add artist, discover similar, check quality, sync with Plex) rather than automated workflows."
- **Negative-Space** and **Futurist** both note the community is burdened by fragmented tools (5+ Docker containers for a complete workflow) and argue for consolidation -- "The current proliferation of single-purpose tools will consolidate into fewer, more capable tools."

**Significance:** Medium. This affects CLI command design philosophy.

**Resolution:** These are not actually contradictory -- they operate at different levels. The Historian argues for composable _commands_ within a single CLI tool (Unix philosophy: each command does one thing well). The Negative-Space/Futurist argue against having separate _applications_ for each function (one Docker container per gap). rfmedia-cli should consolidate multiple capabilities into a single CLI with composable subcommands. This satisfies both: fewer tools to deploy (Futurist/Negative-Space) with discrete, composable operations (Historian).

---

## Productive Tensions

These contradictions are not resolvable but generate useful design constraints when held in tension:

### PT1: Automation vs. Curation

- **Tension:** The Systems-Thinker documents amplifying feedback loops (import list snowball, quality upgrade cycle) that make full automation risky. The Negative-Space and Archaeologist document user demand for more automation (bulk operations, auto-discovery).
- **Design constraint:** Every automated operation should have a human checkpoint. Default to preview/dry-run mode. Make auto-add opt-in, not default.

### PT2: Reliability vs. Feature Richness

- **Tension:** The Contrarian argues for minimal, reliable integration. Five other personas argue for rich, comprehensive integration.
- **Design constraint:** Tier the feature set by reliability guarantees. Core operations must never fail due to external dependencies. Enhancement features can degrade gracefully.

### PT3: CLI Simplicity vs. System Complexity

- **Tension:** The user runs a simple command (`rfmedia lidarr add "Artist Name"`). Behind the scenes, the Systems-Thinker maps a cascade through metadata server, indexers, download clients, Plex scanning. The CLI must hide complexity while exposing control levers.
- **Design constraint:** Simple defaults, verbose flags for control. `--dry-run` shows the cascade before executing. Progress reporting surfaces pipeline state.

### PT4: Current Stability vs. Future Uncertainty

- **Tension:** The Historian says API v1 is stable. The Futurist warns about uncertain metadata server rebuild timeline and possible Lidarr replacement by converged tools.
- **Design constraint:** Build against API v1 confidently. Abstract the Lidarr client behind an interface. Keep the integration modular enough to swap backends.

---

## Irreconcilable Contradictions

### IC1: Metadata Server -- No External Workaround

The Contrarian and Futurist document that the Lidarr team explicitly rejected self-hosted metadata alternatives (issues #5546, #5558, both "Won't Fix" and locked). This means:

- Operations depending on search/lookup WILL fail when the metadata server is down.
- There is no community-supported workaround (lidmeta exists but is unofficial).
- This cannot be solved by CLI design alone -- it is a structural limitation of the Lidarr architecture.

**What this means for rfmedia-cli:** The CLI must clearly distinguish "this failed because Lidarr is down" from "this failed because Lidarr's metadata server is down." The second case is expected, not exceptional. User-facing documentation must set expectations that search-dependent operations are best-effort.

### IC2: Album-Centric Model vs. Track-Level Consumption

The Contrarian, Negative-Space, and the "Self-Hosted Music Still Sucks" analysis all document that Lidarr's album-centric model conflicts with how users actually consume music. This is a Lidarr architectural decision that cannot be changed by a CLI tool. The CLI can provide post-acquisition track-level filtering (using the trackfile endpoints the Journalist documented) but cannot change Lidarr's acquisition model from albums to tracks.

---

## Resolution Priorities

Ordered by impact on rfmedia-cli design decisions:

1. **C4 (Integration Scope):** Adopt the tiered architecture. This resolves C1 (metadata risk) and C8 (API stability) simultaneously. Three tiers: local-only (always reliable), discovery-enhanced (independent APIs), metadata-dependent (best-effort).

2. **C6 (Discovery Feature):** Implement discovery as an independent module that optionally pipes into Lidarr. This satisfies both the Contrarian (discovery does not depend on Lidarr) and the five pro-discovery personas (the end-to-end workflow is valuable).

3. **C2 (Track-Level API):** Accept the Journalist's factual finding (track endpoints exist) while heeding the Contrarian's conceptual point (track-level acquisition is not possible). Design the Plex-Lidarr bridge at the artist/album level, using track endpoints for granular metadata operations.

4. **C3 (TsArr Compatibility):** Test TsArr with Node.js before committing. Have a fallback plan (generate own client from OpenAPI spec). This is a low-effort investigation that eliminates a significant unknown.

5. **C12 (Bulk Operations):** Implement bulk operations with the Systems-Thinker's safeguards (dry-run, rate limiting, cascade warnings). Prioritize low-risk bulk operations first (unmonitor by album type, mass profile changes) over high-risk ones (bulk add with search).

6. **C11 (Recommendation Source):** Implement Last.fm first, abstract for future ListenBrainz support. Minimal additional effort, maximum flexibility.

---

## Evidence Quality Assessment

| Persona         | Primary Sources                 | Factual Accuracy                          | Strategic Value                   |
| --------------- | ------------------------------- | ----------------------------------------- | --------------------------------- |
| Historian       | 12 primary, 8 secondary         | High                                      | High (temporal patterns)          |
| Contrarian      | 20+ GitHub issues, OpenAPI spec | High (one track API error)                | High (risk identification)        |
| Systems-Thinker | OpenAPI spec, wiki, issues      | High                                      | High (cascade analysis)           |
| Journalist      | OpenAPI spec, SDKs, tools       | Highest (direct spec analysis)            | High (factual reference)          |
| Archaeologist   | 19+ GitHub repos, API docs      | High                                      | High (pattern revival)            |
| Futurist        | GitHub milestones, blog posts   | Medium (predictions inherently uncertain) | Medium-High (strategic)           |
| Negative-Space  | 30+ GitHub issues, 15+ tools    | High                                      | High (opportunity identification) |

The Journalist provides the most factually reliable API documentation. The Contrarian provides the most rigorous risk analysis. The Systems-Thinker provides the most actionable architectural guidance. The Archaeologist provides the most useful design patterns. The Historian provides the best strategic context. The Futurist provides necessary long-term hedging. The Negative-Space provides the clearest feature prioritization.

---

## Cross-Cutting Finding

The single most important insight from mapping these contradictions is that **the eight personas fundamentally agree on more than they disagree**. All eight agree on:

- The Plex-Lidarr bridge is an underserved gap with high value
- Lidarr has no native discovery endpoints
- The metadata server is fragile
- Auto-generated API clients are the sustainable approach
- TypeScript CLI tooling for Lidarr does not exist
- Bulk operations are underserved
- Music is fundamentally harder to automate than video

The contradictions are primarily about **degree and strategy** -- how much to integrate, how to handle known fragility, which features to prioritize -- not about the fundamental opportunity or the technical landscape. This convergence across eight deliberately different analytical perspectives significantly increases confidence in the core findings.
