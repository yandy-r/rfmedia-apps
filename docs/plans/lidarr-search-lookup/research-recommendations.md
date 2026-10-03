# Recommendations: Lidarr Search and Lookup

## Executive Summary

Ship issue #222 as one read-only, Lidarr-backed capability with three thin command leaves. Reuse
the private generated client, hardened transport, `metadata-dependent` scheduler lane, SQLite
resilience cache, existing `{ command, result }` machine envelope, and shell-completion gates.
Do not add an external provider or dependency.

## Implementation Recommendations

1. **P0 — Preserve the generated-client boundary.** Add facade methods for the already generated
   `getApiV1Search`, `getApiV1ArtistLookup`, and `getApiV1AlbumLookup` operations. Only
   `lib/lidarr/client.ts` may import them; `transport.ts` remains the sole authenticated Fetch owner.
2. **P0 — Use one action and pure helper.** Implement one mode-parameterized action plus one pure
   helper for validation, cache identity, projection-independent dedupe/rank, and local paging.
3. **P0 — Make the scheduler the only preflight/retry owner.** Add a narrow execution-context
   resolver returning the resilient facade and its shared scheduler preflight. Run exactly one
   health gate, set resilience in-place retries to zero, and pass cancellation through every step.
4. **P0 — Cache complete projections by query.** Extend the existing SQLite cache; write the fully
   validated/deduplicated set, including valid empty sets, before paging. Serve it only after an
   eligible live failure and explicit `--allow-stale`.
5. **P0 — Validate untrusted input and responses atomically.** Reject unsafe queries/options before
   I/O; reject the entire response on malformed, ambiguous, unsafe, or oversized members. Never
   cache generated DTOs or partially salvaged results.
6. **P1 — Keep output deterministic and repo-native.** Preserve upstream order, first-win dedupe,
   rank before slicing, existing machine-envelope conventions, stderr-only human output, and
   stdout-only machine output.
7. **P1 — Fail closed on generated drift.** Add all three operations and endpoints to generator
   requirements, generated-contract tests, facade mocks, resilience maps, and architecture gates.
8. **P1 — Ship complete command ergonomics.** Update help, docs, Bash/Zsh/Fish templates, and exact
   cross-shell parity tests in the same change.

## Resolved Contracts

- Commands: `rfmedia lidarr search <term>`, `rfmedia lidarr lookup artist <term>`, and
  `rfmedia lidarr lookup album <term>`.
- IDs: `lidarr-search`, `lidarr-lookup-artist`, and `lidarr-lookup-album`.
- Options: `--limit` (default 50, range 1–200), `--offset` (default 0, safe non-negative integer),
  `--allow-stale`, `--lidarr-url`, and `--lidarr-api-key`.
- Query: trim once, normalize NFC, require 1–256 Unicode code points and at most 1,024 UTF-8 bytes,
  reject C0/C1 and bidi controls, and preserve internal whitespace and case for ordinary text.
- Exact IDs: recognize `lidarr:`, `lidarrid:`, and `mbid:` case-insensitively; require one UUID and
  canonicalize to `lidarr:<lowercase-uuid>`. Malformed prefixed input is `validation`; a valid
  unmatched ID is an empty success.
- Results: require `rank`, `kind`, `foreignId`, and `name`; emit positive `lidarrId` and bounded
  display fields only when present. Exclude paths, images/URLs, profiles, tags, tracks, releases,
  add options, and generated types.
- Ordering: validate at most 1,000 upstream entries; dedupe by `(kind, foreignId)`, keep first,
  assign one-based rank, then slice. Offset past end exits 0 with an empty page.
- Machine shape: `{ command, result }`, where `result` contains `query`, `results`, `total`,
  `limit`, `offset`, `returned`, `hasMore`, `provider`, optional `cacheStatus`, and `execution`.
  Do not introduce a top-level schema version inconsistent with current Lidarr commands.
- CSV: use an explicit fixed flat projection with a summary row followed by candidate rows so empty
  results retain paging/provenance. Keep existing formula neutralization.
- Human output: a safely bounded query heading, ranked table, paging footer, provenance/degradation
  notice, and existing execution summary, all on stderr.

## Cache and Error Contract

- Key: canonical credential-free origin × category `lookup` ×
  `v1:<mode>:<SHA-256(NFC normalized term)>`; never persist cleartext query or API key.
- Values: fresh bounded domain projections only; revalidate cached payloads on read. Paging is not
  part of the key. Reuse TTL 900 seconds and stale ceiling 86,400 seconds; zero disables caching.
- Live Lidarr is always attempted first. Cache is not a hidden read-through source.
- Fallback requires `--allow-stale`, an exact row within the stale ceiling, and
  `metadata-provider-unavailable`, `lidarr-unreachable`, or `timeout`.
- Never fall back for validation, configuration, authentication/authorization, not-found,
  rate-limit, cancellation, or `invalid-response`. `200 []` never triggers fallback.
- Degraded success exits 0 and reports requested/used provider, `degraded=true`, fallback reason,
  fetched time, and age. Cache miss/corruption/DB failure preserves the original typed error.
- Preserve `429` and valid `Retry-After`; identify metadata outages only from health/circuit
  evidence or bounded Lidarr metadata-error signals. Do not classify arbitrary `500` responses as
  provider outages or expose raw bodies.

## Phasing and File Ownership

1. **Boundary:** facade methods, strict projectors/domain types, generator requirements, client and
   contract tests.
2. **Execution:** pure search helper, query-aware cache plumbing, shared preflight context, single
   action, resilience tests.
3. **Surface:** command factory/presenters, deterministic machine/CSV contracts, docs, completions,
   and end-to-end regression tests.

This is larger than the issue's original “3–5 files” estimate because existing fail-closed
architecture, cache, completion, and generated-contract surfaces must move together. Keep it one
PR, but do not split artist/album/all into separate implementations.

## Risk Assessment

- **Duplicate probes/retries:** shared breakers and preflight plus scheduler-only retry.
- **Credential leakage:** header-only auth after origin validation, redirect rejection, redaction,
  and negative tests for URLs, errors, cache, logs, and output.
- **Hostile provider data:** body limits, atomic strict projection, terminal sanitization, flat CSV.
- **Stale automation decisions:** explicit consent and structured provenance on every fallback.
- **Unbounded cache growth:** existing opportunistic stale pruning now; row/byte caps are follow-up.

## Quick Wins and Gates

- Reuse generated operations already in the pinned snapshot; no refresh or dependency is needed.
- Focused tests: client/projectors, pure helpers, action/preflight, resilience/cache, commands, and
  hostile output fixtures.
- Release gates: `npm run test:codegen:lidarr --workspace packages/rfmedia-cli`,
  `npm run codegen:lidarr:check --workspace packages/rfmedia-cli`,
  `npm run test:architecture --workspace packages/rfmedia-cli`,
  `npm run typecheck --workspace packages/rfmedia-cli`,
  `npm run test:coverage --workspace packages/rfmedia-cli`,
  `npm run build --workspace packages/rfmedia-cli`, `npm run format:check`, and `git diff --check`.
- Treat the existing production audit findings as a separate dependency-remediation issue; #222
  must add no dependency and must not parse provider data as YAML.

## Future-Issue Boundaries and Non-Recommendations

- #203 owns similar-artist discovery and any explicit add handoff; #204 owns federated providers,
  merging/ranking, and Plex seeds; #220 owns configurable/direct metadata providers and failover
  order; #223 owns album-library filtering and mutations.
- Do not add direct MusicBrainz/Last.fm/ListenBrainz calls, a provider abstraction, a new Fetch
  owner, server-pagination claims, sorting/re-ranking, interactive selection, mutations, plan/apply,
  search history, per-page cache rows, cleartext cache keys, config knobs, or a runtime package.
