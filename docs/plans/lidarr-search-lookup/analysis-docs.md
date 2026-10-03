# Documentation Analysis: Lidarr Search and Lookup

## Executive Summary

Issue #222 adds an operator-visible read-only command suite, so documentation must cover both
day-one use and the load-bearing generated-client, execution-lane, cache, and output contracts.
Create one canonical feature guide at
`packages/rfmedia-cli/docs/features/lidarr-search-lookup.md`, add a concise discovery section to the
package README, and update generated-client/execution-lane architecture guides where the new
operations become current behavior. After implementation and merge evidence exist, mark #222
shipped in `ROADMAP.md`, add it to `docs/roadmap-archive.md`, and record it under the package
changelog's `[Unreleased]` section.

The feature specification is authoritative where research proposals differ: positional terms,
three paths (`search`, `lookup artist`, `lookup album`), modes `search | artist | album`, the
existing `{ command, result }` machine envelope, and live-first explicit stale fallback. The shell
completion templates and parity tests must change, but the generic completion guide need not:
completion remains static and network-free, with no new installation or runtime behavior.

## Must-Read Documents

| Document                                                        | Required reading                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `docs/plans/lidarr-search-lookup/feature-spec.md`               | Settled command, input, result, cache, security, and scope contracts.          |
| `docs/plans/lidarr-search-lookup/research-recommendations.md`   | Consolidated implementation, phasing, and release-gate decisions.              |
| `docs/plans/lidarr-search-lookup/research-technical.md`         | Current layer map, generated operations, scheduling, caching, and tests.       |
| `docs/plans/lidarr-search-lookup/research-ux.md`                | Human tables, empty/degraded states, accessibility, and stream discipline.     |
| `docs/plans/lidarr-search-lookup/research-security.md`          | Credential, query privacy, hostile output, and fallback requirements.          |
| `packages/rfmedia-cli/docs/features/lidarr-generated-client.md` | Generated/manual ownership, transport invariants, drift, and refresh workflow. |
| `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`  | Gated-lane admission, preflight, retry, cancellation, and metadata output.     |
| `docs/plans/lidarr-metadata-resilience/design.md`               | Existing circuit/cache/fallback rationale and SQLite key model.                |
| `packages/rfmedia-cli/README.md`                                | Operator discovery surface and maintainer validation commands.                 |
| `ROADMAP.md` and `docs/roadmap-archive.md`                      | Living/open status versus shipped historical record.                           |

## Architecture Docs

- **Create `packages/rfmedia-cli/docs/features/lidarr-search-lookup.md`:** Document all three command
  paths and IDs; shared options and defaults; trim/NFC/control/byte/code-point validation; exact
  MBID prefixes; strict candidate fields; upstream-order dedupe/rank/paging; empty-result behavior;
  human and JSON/YAML/CSV examples; live versus stale provenance; eligible fallback errors; exit
  codes; cancellation; and the explicit no-mutation/no-direct-provider boundary.
- **Update `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`:** Add the three required
  operations/endpoints, new facade methods, lookup-specific strict projections, optional local
  numeric IDs, and the rule that combined response `id` is not durable. Retain private generated
  modules, sole transport ownership, offline codegen, and immutable provenance; no snapshot refresh
  or third-party-notice change is required.
- **Update `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`:** Replace “future
  metadata-backed actions” with the shipped search/lookup use, show exactly one scheduler preflight,
  scheduler-only retries, cancellation propagation, execution metadata, and the interaction with
  query-cache fallback. Align the text with the final shared execution-context implementation so it
  does not imply duplicate per-attempt health gates.
- **Do not rewrite `docs/plans/lidarr-metadata-resilience/design.md`:** It is historical design
  evidence. The new feature guide should explain query-keyed cache behavior and link the design for
  deeper rationale.
- **Update `packages/rfmedia-cli/README.md`:** Add a “Lidarr Search and Lookup” section before
  mutation plan/apply with short examples for combined and typed lookup, option/default summary,
  output/fallback notes, no-mutation statement, and a link to the canonical feature guide.
- **Update `packages/rfmedia-cli/CHANGELOG.md`:** Under `[Unreleased]` → `Added`, summarize the three
  commands, deterministic paging/provenance, and explicit stale-cache recovery without claiming a
  release.
- **Update roadmap records only after completion:** Strike and date #222 in both active ROADMAP
  locations, link the closing PR, then add #222/PR to the archive track and one operator note.

## Reading List

1. Read `feature-spec.md`, then `research-recommendations.md`; use them to resolve conflicts in the
   other research files.
2. Read the generated-client guide before changing facade or codegen documentation.
3. Read the execution-lanes guide and resilience design together before documenting retries,
   preflight, circuits, or stale behavior.
4. Read current `commands/lidarr.ts` tests and completion parity tests as executable documentation
   for command IDs, envelopes, stderr/stdout discipline, and all-shell parity.
5. Read the package README's existing Lidarr plan/apply, execution-lane, and client-generation
   sections to place the new operator guide without duplicating internals.
6. Read both ROADMAP #222 entries and the archive's existing Lidarr rows before recording shipped
   status; do not invent a PR number or completion date.
7. Read `.github/pull_request_template.md` before handoff and include exact documentation and test
   evidence under its required sections.

## Documentation Gaps

- No operator guide currently explains remote search versus installed-library reads, combined
  versus typed lookup, exact MBID syntax, or the guarantee that these commands perform no mutation.
- No current document defines the stable lookup candidate, paging, provenance, empty-result, and
  summary-row CSV contracts; examples must use the settled `{ command, result }` envelope.
- The generated-client guide does not yet fail closed on or explain the three lookup operations and
  their generated-independent projections.
- The execution-lane guide still labels `metadata-dependent` as future use and can be read as
  allowing both scheduler preflight and resilient per-call health gates; document the final single
  ownership model.
- Current resilience documentation covers whole-list cache rows, not privacy-preserving
  origin/mode/query/version keys, cached empty arrays, cached-payload revalidation, or live-first
  fallback eligibility.
- `packages/rfmedia-cli/README.md` exposes Lidarr mutation and maintainer internals but lacks a
  discovery entry for read-only search/lookup.
- `ROADMAP.md` lists #222 in both the sprint and Layer 1 table; update both only after merge, then
  preserve issue/PR history in `docs/roadmap-archive.md`.
- Bash, Zsh, and Fish templates plus parity tests require the new hierarchy and flags. Do not
  update `packages/rfmedia-cli/docs/features/shell-completion.doc.md` unless implementation changes
  generic completion behavior or intentionally turns that guide into a complete command inventory;
  completions remain static and must never query Lidarr.
- `docs/README.md` does not index the package-level Lidarr guides. Adding the new feature guide and
  existing generated-client/execution-lane links is useful discoverability work if documentation
  indexing is included in the implementation scope.
