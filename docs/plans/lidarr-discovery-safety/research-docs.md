# Documentation Research: lidarr-discovery-safety

## Architecture Docs

- **Required; update:** `packages/rfmedia-cli/docs/features/lidarr-discovery.md` is the canonical
  operator contract. It already guarantees read-only one-hop preview by default, zero Lidarr calls
  without `--add`, one sealed `artist-add` plan for one MBID-backed rank, and mutation only through
  later `lidarr apply`. Add the resolved policy defaults, option interactions, bounded traversal,
  visited identity, quarantine/eligibility states, scoring terminology, and text/JSON/YAML/CSV
  changes here.
- **Required; update if promotion changes:** `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
  defines artifact checksums, origin and live-state revalidation, interactive/default-no approval,
  `--yes`, dry-run, history, claims, exact-MBID artist-add reconciliation, and uncertain resume.
  Candidate approval must remain distinct from mutation approval. Its current artist-add contract
  is one entry with `maxBatch: 1`; multi-candidate promotion requires an explicit documented
  plan/apply extension.
- **Required for `--deep`:** `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md` defines
  scheduler-owned retry, cancellation, concurrency, and operation budgets for the `discovery`
  lane. Document invocation-wide traversal bounds if multiple breadth-first waves can exceed a
  per-batch scheduler budget.
- **Required baseline:** `docs/plans/lidarr-similar-artist-discovery/feature-spec.md`,
  `docs/plans/lidarr-similar-artist-discovery/analysis-architecture.md`,
  `docs/plans/lidarr-similar-artist-discovery/analysis-integration.md`, and
  `docs/plans/lidarr-similar-artist-discovery/analysis-patterns.md` define the shipped #203
  provider/action/command split and explicitly reserve thresholds, diversity, quarantine,
  multi-add, and deep traversal for #205.
- **Helpful map:** `docs/plans/lidarr-similar-artist-discovery/shared.md` is the shortest index of
  the discovery, scheduler, generated-client, completion, and plan/apply boundaries.
- **Helpful safety history:** `docs/prps/specs/lidarr-mutation-plan-apply.spec.md`,
  `docs/prps/plans/completed/lidarr-mutation-plan-apply.plan.md`, and
  `docs/prps/reports/lidarr-mutation-plan-apply-report.md` explain why preview, blast-radius caps,
  immutable reviewed intent, live revalidation, explicit approval, and durable resume are existing
  contracts rather than new #205 mechanisms.
- **Reference only:** `docs/features/plan-apply-workflow.md` documents analogous preview and
  approval principles for `rfapps`, but it is not the contract for Lidarr artifacts and should not
  be used to infer rfmedia flags or persistence behavior.

## API Docs

- **Required issue evidence:** `research/rfmedia-lidarr-integration/persona-findings/contrarian.md`
  recommends suggestion-first preview and identifies Last.fm popularity bias; it does not specify
  an implementable popularity metric.
- **Required issue evidence:** `research/rfmedia-lidarr-integration/persona-findings/systems-thinker.md`
  documents the user-gated recommendation loop, downstream add/search amplification, preview,
  manual approval, `--max-add`, and conservative no-search defaults.
- **Required issue evidence:** `research/rfmedia-lidarr-integration/persona-findings/analogist.md`
  motivates quarantine, score thresholds, staged approval, small batches, and discovery-specific
  execution budgets.
- **Required issue evidence:** `research/rfmedia-lidarr-integration/synthesis/contradiction-mapping.md`
  resolves discovery as Last.fm-first and Lidarr-optional, recommends configurable thresholds and
  preview-before-add, and keeps high-impact bulk work behind rate limits and cascade warnings.
- **Required provider baseline:** `docs/plans/lidarr-similar-artist-discovery/research-external.md`
  and `docs/plans/lidarr-similar-artist-discovery/research-technical.md` capture the official
  Last.fm `artist.getSimilar` contract, attribution/terms, raw similarity semantics, request
  limits, and the original decision to defer #205 policy.
- **Helpful boundary:** `packages/rfmedia-cli/docs/features/lidarr-generated-client.md` and
  `packages/rfmedia-cli/openapi/lidarr-v1.json` define the private Lidarr generated API surface.
  No generated-client documentation change is needed for pure discovery policy; update it only if
  #205 adds a new Lidarr operation.
- **API gap:** the shipped recommendation projection contains similarity, MBID, name, rank, and
  source URL, but no listeners, play counts, tags, or genre. True popularity dampening or
  catalogue diversity requires a new documented provider endpoint/input; graph/path diversity
  must be labelled as a proxy and must not overwrite raw Last.fm similarity.

## Development Guides

- **Required:** `AGENTS.md` and `packages/rfmedia-cli/AGENTS.md` contain repository and package
  contribution rules, command/action separation, strict TypeScript conventions, documentation
  requirements, and the required GitHub templates.
- **Required for tests:** `packages/rfmedia-cli/AGENTS.md` describes co-located Vitest tests,
  `vi.hoisted()` mock setup, `vi.clearAllMocks()` usage, isolation, and package validation
  commands. `packages/rfmedia-cli/docs/testing/troubleshooting.md` is supporting guidance for mock
  leakage and sequential async behavior.
- **Required for public flags:** `packages/rfmedia-cli/docs/features/shell-completion.doc.md`
  documents static, network-free Bash/Zsh/Fish completion. The feature does not require an
  installation-guide rewrite, but all new discover flags must be added together to
  `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` and locked by
  `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`.
- **Required for delivery:** `.github/pull_request_template.md` requires exact testing outcomes,
  related issue closure, risk/rollback, and checklist evidence.
- **Helpful release precedent:** `docs/plans/lidarr-similar-artist-discovery/analysis-tasks.md`
  identifies documentation, completion parity, architecture checks, generated-client drift
  checks, package tests, typecheck/build, formatting, and roadmap/archive closeout as one release
  phase.

## README Files

- **Required; update:** `packages/rfmedia-cli/README.md` contains the public
  `rfmedia lidarr discover` examples, Last.fm configuration, single-rank plan handoff, and the
  statement that all #205 behavior is unshipped. Replace that scope statement and document the
  final flags/defaults without implying direct or automatic mutation.
- **Required; update:** `docs/README.md` already links the discovery guide. Revise its one-line
  description only if the operator workflow materially changes; do not duplicate the feature
  guide.
- **Helpful only:** `README.md` is a repository-level overview and currently delegates rfmedia
  details to the package README. A new #205 command example does not belong here unless the
  top-level command summary changes.
- **Required release records:** `packages/rfmedia-cli/CHANGELOG.md` currently names thresholds and
  multi-add policy as unshipped #205 scope. Update the unreleased entry. After authoritative
  completion, remove #205 from both live locations in `ROADMAP.md` and add its issue, PR, date, and
  concise operator note to `docs/roadmap-archive.md`; retain #206 and #219 as separate open work.

## Must-Read Documents

1. `packages/rfmedia-cli/docs/features/lidarr-discovery.md`
2. `docs/plans/lidarr-similar-artist-discovery/feature-spec.md`
3. `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`
4. `docs/plans/lidarr-similar-artist-discovery/analysis-architecture.md`
5. `docs/plans/lidarr-similar-artist-discovery/analysis-integration.md`
6. `docs/plans/lidarr-similar-artist-discovery/analysis-patterns.md`
7. `research/rfmedia-lidarr-integration/persona-findings/contrarian.md`
8. `research/rfmedia-lidarr-integration/persona-findings/systems-thinker.md`
9. `research/rfmedia-lidarr-integration/persona-findings/analogist.md`
10. `research/rfmedia-lidarr-integration/synthesis/contradiction-mapping.md`
11. `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`
12. `packages/rfmedia-cli/README.md`
13. `ROADMAP.md`

## Documentation Gaps

- The issue says “preview by default,” but that behavior already ships. Specify whether #205 adds a
  candidate-policy preview, a pre-plan approval prompt, or only richer quarantine status; none may
  replace the separate `lidarr apply` approval.
- “Quarantine/approval flow” has no persistence contract. Current ranks are invocation-local and
  no discovery queue exists. Define ephemeral result states versus durable list/approve/reject
  commands, storage, identity, expiry, rediscovery suppression, and multi-operator behavior.
- `--max-add` lacks selection grammar and conflicts with the current one-rank, one-entry
  `artist-add` plan. Decide whether approval remains single-candidate, accepts an explicit rank
  list, widens one plan, or produces named independent plans.
- `--deep` has no finite depth/request/candidate defaults. Define breadth-first ordering,
  invocation-wide budgets, cancellation, and whether `--no-cascade` conflicts with `--deep` or
  simply forces depth one.
- “Configurable thresholds” lacks option names, config keys, precedence, numeric bounds, inclusive
  semantics, and ordering relative to dedupe, per-seed caps, reranking, and approval.
- Diversity boost and popularity dampening lack available evidence, formulas, tie-breaking,
  defaults, and honest labels. The current API cannot support literal popularity or genre claims.
- Candidate identity and loop prevention need a documented MBID-first key plus normalized-name
  fallback, seed pre-registration, and provenance for parent seed, depth, original provider rank,
  raw similarity, adjusted score, and rejection reason.
- Human and machine output schemas are undefined for filtered, quarantined, approved,
  already-visited, cap-excluded, and handoff-failed candidates. Preserve one JSON/YAML envelope,
  fixed CSV columns with a summary row, Last.fm attribution, and raw similarity.
- The issue's affected-file note names `src/commands/lidarr.ts`, but the shipped leaf grammar and
  renderer live in `packages/rfmedia-cli/src/commands/lidarr-discover.ts`. Documentation and
  completion updates must follow the shipped command factory.
- The final plan must explicitly preserve #204 provider federation/cache, #206 add defaults and
  post-add normalization, and #219 downstream cascade/indexer budgeting as separate scope.
