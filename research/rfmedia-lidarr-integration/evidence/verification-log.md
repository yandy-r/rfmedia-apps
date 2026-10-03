# Evidence Verification Log

## High-Confidence Findings

### Finding 1: Lidarr API has zero discovery endpoints

- **Claimed by**: Contrarian, Journalist, Negative Space
- **Primary sources**: [Lidarr OpenAPI Spec](https://raw.githubusercontent.com/lidarr/Lidarr/develop/src/Lidarr.Api.V1/openapi.json)
- **Verification status**: Confirmed
- **Confidence**: High
- **Notes**: Direct OpenAPI spec analysis confirms no `/api/v1/artist/similar`, no recommendations, no discovery endpoints exist

### Finding 2: Metadata server experienced 5+ major outages (April-August 2025)

- **Claimed by**: Contrarian, Systems Thinker, Futurist, Historian
- **Primary sources**: [#5498](https://github.com/Lidarr/Lidarr/issues/5498), [#5579](https://github.com/Lidarr/Lidarr/issues/5579), [#5516](https://github.com/Lidarr/Lidarr/issues/5516), [#5530](https://github.com/lidarr/Lidarr/issues/5530)
- **Verification status**: Confirmed
- **Confidence**: High
- **Notes**: Multiple independent GitHub issues with developer acknowledgment confirm repeated outages. 8+ day outage documented in #5498 (April 2025). MusicBrainz schema change broke server in May 2025

### Finding 3: Self-hosted metadata alternatives rejected ("Won't Fix")

- **Claimed by**: Contrarian, Futurist, Negative Space
- **Primary sources**: [#5546](https://github.com/Lidarr/Lidarr/issues/5546), [#5558](https://github.com/Lidarr/Lidarr/issues/5558)
- **Verification status**: Confirmed
- **Confidence**: High
- **Notes**: Both issues closed as "Won't Fix" and locked. Developer stated "no plans to allow users to use custom metadata"

### Finding 4: TsArr TypeScript SDK exists (v1.11.0)

- **Claimed by**: Historian, Journalist
- **Primary sources**: [GitHub - robbeverhelst/TsArr](https://github.com/robbeverhelst/TsArr), [npm - tsarr](https://www.npmjs.com/package/tsarr)
- **Verification status**: Confirmed
- **Confidence**: High
- **Notes**: Active repository with 154 commits, 16 releases. Auto-generated from OpenAPI specs using `@hey-api/openapi-ts`. Uses Bun runtime -- Node.js compatibility not yet tested

### Finding 5: No TypeScript CLI tool exists for Lidarr

- **Claimed by**: Negative Space, Journalist
- **Primary sources**: npm search, GitHub search, [awesome-arr](https://ravencentric.cc/awesome-arr/)
- **Verification status**: Confirmed
- **Confidence**: High
- **Notes**: Comprehensive ecosystem survey found Go (golift/starr), Python (pyarr), and Rust (lidarr crate) clients, but zero TypeScript CLI tools

### Finding 6: Plex-Lidarr bridge is completely unserved

- **Claimed by**: All 8 personas independently
- **Primary sources**: Ecosystem survey across npm, GitHub, awesome-arr, community tools
- **Verification status**: Confirmed
- **Confidence**: High
- **Notes**: Only existing Plex-Lidarr connections are file-based scanning tools (Autoscan, PlexScanarr). No data-level bridge exists. Universal convergence across all research perspectives

### Finding 7: Last.fm is the most reliable open recommendation source

- **Claimed by**: Historian, Archaeologist, Futurist, Journalist
- **Primary sources**: [Last.fm API](https://www.last.fm/api/show/artist.getSimilar), [Lidify migration](https://github.com/TheWicklowWolf/Lidify)
- **Verification status**: Confirmed
- **Confidence**: High
- **Notes**: Lidify switched from Spotify to Last.fm-only after Nov 2024 Spotify API restrictions. Last.fm API has remained stable for 15+ years

### Finding 8: Spotify API restrictions are permanent (Nov 2024)

- **Claimed by**: Futurist, Journalist, Archaeologist
- **Primary sources**: [Spotify API Restrictions](https://voclr.it/news/why-spotify-has-restricted-its-api-access-what-changed-and-why-it-matters-in-2026/), [Spotify Developer Community](https://community.spotify.com/t5/Spotify-for-Developers/spotify-api-Get-Recommendations-alternative/td-p/6540653)
- **Verification status**: Confirmed
- **Confidence**: High
- **Notes**: Related Artists, Recommendations, Audio Features, Audio Analysis endpoints restricted for new apps. Permanent change confirmed by Spotify

### Finding 9: Recyclarr does NOT support Lidarr

- **Claimed by**: Journalist, Negative Space
- **Primary sources**: [Recyclarr Documentation](https://recyclarr.dev/)
- **Verification status**: Confirmed
- **Confidence**: High
- **Notes**: Explicit exclusion -- Sonarr and Radarr only. Leaves CLI-based quality profile management as an open gap

### Finding 10: Lidarr API v1 is stable and unlikely to change

- **Claimed by**: Futurist, Journalist, Historian
- **Primary sources**: [Lidarr GitHub](https://github.com/Lidarr/Lidarr), [Lidarr Releases](https://github.com/lidarr/Lidarr/releases), [Lidarr Milestones](https://github.com/lidarr/lidarr/milestones)
- **Verification status**: Confirmed
- **Confidence**: Medium-High
- **Notes**: No API v2 visible in repository. Develop branch last updated October 2025. Slow development pace indicates stable API surface

## Medium-Confidence Findings

### Finding 11: Track/trackfile endpoints exist in Lidarr API

- **Claimed by**: Journalist (confirmed), Contrarian (initially denied)
- **Supporting evidence**: OpenAPI specification documents `GET /api/v1/track`, `GET /api/v1/trackfile`, `PUT /api/v1/trackfile/{id}`, `DELETE /api/v1/trackfile/bulk`
- **Conflicting evidence**: Contrarian stated "no `/api/v1/track` endpoint" but was referring to independent track query capability
- **Confidence**: High for endpoint existence; Medium for utility
- **Notes**: Contradiction resolved -- endpoints exist but require parent artist/album context. Cannot query tracks independently

### Finding 12: TsArr may work with Node.js

- **Claimed by**: Inferred from TsArr using `@hey-api/openapi-ts` and native `fetch`
- **Supporting evidence**: Node.js 18+ supports native `fetch`; TsArr may not have Bun-specific dependencies beyond fetch
- **Conflicting evidence**: TsArr documentation states Bun as runtime; no Node.js testing documented
- **Confidence**: Medium
- **Notes**: Requires empirical testing before implementation. Fallback: generate own client from OpenAPI spec

### Finding 13: Bulk add requires 120-second delays

- **Claimed by**: Journalist
- **Supporting evidence**: [Community Gist](https://gist.github.com/jackskhakis/711b54352a5ee9d1ae9778f2060ce444)
- **Conflicting evidence**: No official documentation of rate limits
- **Confidence**: Medium
- **Notes**: Community observation, not officially documented. Actual required delay may vary based on metadata server load

### Finding 14: ListenBrainz data completeness

- **Claimed by**: Futurist
- **Supporting evidence**: MetaBrainz Foundation backing, CC0 licensing, growing dataset
- **Conflicting evidence**: Futurist acknowledges data is "nowhere near as comprehensive as Spotify"
- **Confidence**: Medium
- **Notes**: Coverage depth untested. Viable as long-term secondary source, not yet primary

## Speculative Findings

### Finding 15: Naviseerr may replace Lidarr long-term

- **Claimed by**: Futurist
- **Evidence type**: Speculative
- **Plausibility**: Low (20-30% within 2 years)
- **Value if true**: rfmedia-cli's layered architecture allows backend swapping
- **Validation needed**: Monitor Naviseerr development progress over 12-18 months

### Finding 16: AI-enhanced music metadata management in 2-3 years

- **Claimed by**: Futurist
- **Evidence type**: Speculative
- **Plausibility**: Low-moderate for self-hosted
- **Value if true**: Future extension point for rfmedia-cli
- **Validation needed**: Track open-source AI music tools development

## Critical Contradictions

### Contradiction 1: Metadata server risk assessment

- **Position A**: Dealbreaker -- avoid deep integration (Contrarian)
- **Position B**: Manageable with engineering mitigations (Systems Thinker, Historian)
- **Evidence for A**: 5 outages in 5 months, "Won't Fix" closures, no fallback mechanism
- **Evidence for B**: Existing tools (Lidify, Aurral) successfully handle fragility; local CRUD operations are genuinely reliable
- **Resolution**: Both correct at different levels. Adopt tiered architecture: local operations (reliable) separated from metadata-dependent operations (fragile). The crucible analysis H6 embodies this resolution
- **Impact**: Determines entire integration architecture -- resolved in favor of layered approach

### Contradiction 2: Track-level API capability

- **Position A**: No track endpoints exist (Contrarian)
- **Position B**: Track/trackfile endpoints documented in OpenAPI spec (Journalist)
- **Evidence quality**: Journalist wins decisively -- direct OpenAPI spec analysis
- **Resolution**: Endpoints exist but require parent context. Conceptual limitation (album-centric acquisition) remains valid
- **Impact**: Bridge feasibility is higher than Contrarian suggested; track metadata operations are viable when parent context is known
