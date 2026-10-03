# Documentation Research: 199-lidarr-artist-bulk-management

Issue #199 extends the existing Lidarr sealed plan/apply contract with two operator-visible plan
producers: `artist-profiles` and `artist-tags`. Documentation work must describe the new v2 plan
schema and profile/tag safety semantics without weakening v1 monitoring compatibility, the private
generated-client boundary, or the local-only execution-lane contract.

## Architecture Docs

- **Required — `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`:** Canonical operator and
  security guide for sealed artifacts, apply dry-runs, approval, live-state validation, claims,
  durable history, deferred work, and resume. It currently documents only
  `rfmedia.lidarr-plan.v1` and `artist-monitoring`, and explicitly says profile/tag management is
  separate future work; update it for strict v2 writes, preserved v1 reads/apply/resume, both new
  producers, selectors, profile/tag risk levels, replacement authorization, verification, and
  uncertain-outcome recovery.
- **Required — `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`:** Source of truth for
  generated/manual ownership, bounded transport, security invariants, required generated contracts,
  offline drift checks, refresh review, and rollback. Amend the stable facade/required-contract
  discussion for targeted artist reads, profile/tag resource lists, and the narrow artist-editor
  operations; do not document or expose generated modules as a public API.
- **Required — `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`:** Defines lane
  concurrency, retry ownership, output metadata, and future-adoption rules. The settled design keeps
  these plan/apply operations in `local-only`; update stale wording that all mutations are future
  work while retaining the rule that mutation requests are not automatically retried in place.
- **Required — `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`:** Settled product,
  architecture, schema, apply, output, compatibility, and completion contract. This is the primary
  issue-specific source of truth.
- **Required — `docs/plans/199-lidarr-artist-bulk-management/research-recommendations.md`:**
  Consolidated decisions and task ordering, including v2/v1 compatibility, exact reference
  resolution, one-artist execution, output limits, docs/completion parity, and release evidence.
- **Required — `docs/plans/199-lidarr-artist-bulk-management/research-integration.md`:** Maps the new
  facade, selectors, operations, plan engine, actions, commands, completion templates, CI gates, and
  documentation touchpoints onto the current repository.
- **Required — `docs/plans/199-lidarr-artist-bulk-management/research-patterns.md`:** Catalogs the
  existing monitoring plan/apply and client patterns that the feature should extend rather than
  replace.
- **Nice-to-have — `docs/plans/lidarr-generated-client/analysis-docs.md`:** Prior documentation audit
  explaining generated-client documentation scope, completion non-changes, PR evidence, and
  ROADMAP/changelog treatment. Its line references are historical, so use the policy rather than
  copying old locations.
- **Nice-to-have — `packages/rfmedia-cli/docs/plans/lidarr-integration-foundation.md`:** Historical
  foundation design. Useful for rationale and load-bearing comments, but superseded for current
  generated-client and plan/apply behavior by the feature guides above.

## API Docs

- **Required — `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`:** Machine-readable immutable
  provenance for the pinned Lidarr schema, generator identity, required operations, hashes, and
  normalization assertions. Any new required operation must be represented by the generator
  contract checks, not by hand-written endpoint strings.
- **Required — `packages/rfmedia-cli/openapi/lidarr-v1.json`:** Committed official OpenAPI snapshot
  used for offline generation. Inspect the artist editor, artist-by-ID, quality-profile,
  metadata-profile, and tag operations and their generated names/shapes; never edit this snapshot
  to implement the feature.
- **Required — `packages/rfmedia-cli/openapi-ts.config.mjs`:** Fixed generator input/output and
  bundled Fetch configuration.
- **Required — `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` and
  `packages/rfmedia-cli/scripts/generate-lidarr-client.test.mjs`:** Enforce manifest/config identity,
  required generated contracts, deterministic staging, compilation, and drift behavior. Extend
  required-operation assertions when the new facade depends on additional generated operations.
- **Required — `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.mjs` and
  `packages/rfmedia-cli/scripts/refresh-lidarr-openapi.test.mjs`:** Explicit network refresh,
  provenance validation, confined staging, and last-known-good recovery. Normal feature work remains
  offline; a snapshot refresh is not implied by issue #199.
- **Required — `packages/rfmedia-cli/src/lib/lidarr/client.ts`:** The only handwritten owner of
  generated operation imports, wire-to-domain projection, and allowlisted editor request bodies.
  Its comments and tests are executable API documentation for credential confinement, response
  bounds, 2xx handling, and generated-envelope non-escape.
- **Required — `packages/rfmedia-cli/src/lib/lidarr/transport.ts`:** Sole authenticated production
  Fetch owner. Its comments document origin binding, header-only authentication, redirect
  rejection, cancellation, and bounded response reading.
- **Required — `packages/rfmedia-cli/src/lib/lidarr/index.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/resilient-client.ts`:** Public stable resolver/facade and
  resilience delegation seams; every new facade method must be forwarded without exposing generated
  types.
- **Required — `packages/rfmedia-cli/src/types/lidarr.ts` and
  `packages/rfmedia-cli/src/types/lidarr-plan.ts`:** Stable domain and versioned artifact contracts.
  JSDoc must distinguish v1 and v2 precisely and avoid calling the checksum a signature.
- **Nice-to-have — `packages/rfmedia-cli/THIRD_PARTY_NOTICES.md`:** Attribution and publication
  context for the OpenAPI snapshot and generator. No update is expected unless provenance or
  packaged third-party material changes.

## Development Guides

- **Required — `AGENTS.md`, `CLAUDE.md`, and `packages/rfmedia-cli/AGENTS.md`:** Repository and
  package conventions: Node 22, ESM `.js` imports, command/action separation, lazy actions, Vitest,
  markdown formatting, GitHub templates, and graph maintenance.
- **Required — `packages/rfmedia-cli/src/commands/lidarr.test.ts`:** Command hierarchy, option
  forwarding, machine envelopes, interactive preflight, default-no approval, and apply error
  behavior. Extend it for both new plan leaves, mutually exclusive selectors/modes, verbose preview,
  and `--allow-tag-replacement`.
- **Required — `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`:** Existing executable plan/apply guide for
  fresh planning, no-op entries, checksum/origin validation, dry-run, claims, history, deferred
  intent, resume, cancellation, and concurrency.
- **Required — `packages/rfmedia-cli/src/lib/lidarr/plan.test.ts`:** Strict artifact parsing,
  canonical checksum, safe file I/O, and bounded history behavior; the central v1 compatibility and
  v2 strictness test surface.
- **Required — `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` and
  `packages/rfmedia-cli/scripts/check-direct-plex-imports.test.mjs`:** Despite the legacy filename,
  this is the architecture gate for the single Lidarr Fetch owner, private generated imports, no
  handwritten `/api/v1/` paths, and no generated re-exports. Extend it for mutation-call ownership
  and editor-field confinement.
- **Required — `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`:** Static command surface for all three
  shells. Add both plan leaves and every selector/change/safety option together.
- **Required — `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`:** Cross-shell
  completion parity and regression gate. Add exact assertions for the new hierarchy and flags.
- **Required — `packages/rfmedia-cli/docs/features/shell-completion.doc.md`:** Installation and
  behavior guide. Its command examples/list are already incomplete for the current Lidarr namespace;
  update only if the implementation treats it as the canonical enumerated command inventory, and
  ensure it does not imply dynamic Lidarr resource lookup.
- **Required — `.github/workflows/rfmedia-cli.yml`:** Package CI and generated-client drift gates.
  Document exact local commands/results in the PR; do not claim green CI from local execution.
- **Required — `.github/pull_request_template.md`:** Final PR body source of truth. Preserve Summary,
  Changes, Testing, Related Issues (`Closes #199`), Breaking Changes, Risk and Rollback, and
  Checklist; list exact pass/fail validation commands.
- **Nice-to-have — `docs/templates/github/pull-request.md`:** Offline agent-friendly mirror of the PR
  template. GitHub's template remains authoritative.
- **Nice-to-have — `.github/ISSUE_TEMPLATE/enhancement.yml`:** Source form for future follow-up
  enhancements; issue #199 itself is already settled, so no issue-template edit is needed.

## README Files

- **Required — `packages/rfmedia-cli/README.md`:** User-facing package command reference and
  maintainer entrypoint. Its Lidarr section currently says monitoring is the first/only producer and
  execution-lane prose calls mutations future work. Add complete profile/tag plan examples,
  selector/reference semantics, dry-run/apply/resume, replacement authorization, and links to the
  canonical feature guide; keep detailed artifact internals in that guide.
- **Required — `README.md`:** Root discovery surface for `rfmedia`. It currently shows only copy,
  delete, and Plex examples and has no Lidarr feature links. Add a concise Lidarr plan/apply example
  or link if the project convention requires new operator-visible command discovery here.
- **Nice-to-have — `docs/README.md`:** Documentation index. It currently emphasizes rfapps and does
  not index the package-level Lidarr guides; adding Lidarr plan/apply, generated-client, and
  execution-lane links would make the canonical docs discoverable.

## Must-Read Documents

1. **Required — `docs/plans/199-lidarr-artist-bulk-management/feature-spec.md`**
2. **Required — `docs/plans/199-lidarr-artist-bulk-management/research-recommendations.md`**
3. **Required — `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`**
4. **Required — `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`**
5. **Required — `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`**
6. **Required — `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`**
7. **Required — `packages/rfmedia-cli/src/types/lidarr-plan.ts`**
8. **Required — `packages/rfmedia-cli/src/lib/lidarr/client.ts`**
9. **Required — `packages/rfmedia-cli/src/actions/lidarr/apply.ts`**
10. **Required — `packages/rfmedia-cli/src/commands/lidarr.ts`**
11. **Required — `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`**
12. **Required — `ROADMAP.md` and `packages/rfmedia-cli/CHANGELOG.md`**

## Documentation Gaps

- **Required:** The plan/apply guide and package README describe only v1 monitoring. They must
  document v2 writes while explicitly preserving v1 read/apply/history/resume compatibility.
- **Required:** No current operator guide describes artist profile/tag selectors, numeric versus
  `name:` references, ambiguity errors, AND/all-of filtering, cohort caps, or the distinction
  between zero-match failure and auditable all-no-op success.
- **Required:** No current guide explains profile risk, tag add/remove delta semantics, destructive
  set/clear semantics, full removal preview, or the additional `--allow-tag-replacement` gate.
- **Required:** Current docs do not state the issue #199 verification contract: one artist per
  editor request, accept any successful 2xx without trusting the body, then perform a fresh targeted
  read; unresolved post-dispatch state is uncertain and stops further admission.
- **Required:** Generated-client documentation lists the original read contracts but not the new
  targeted artist, profile, metadata-profile, tag, and editor contracts. Update the facade and
  maintainer review sections without turning generated files into public documentation.
- **Required:** Execution-lane prose is stale: it says mutations are future work and suggests future
  mutations adopt another lane, while the settled feature remains `local-only`. Align the guide,
  README, scheduler metadata, and tests.
- **Required:** Bash/Zsh/Fish completion templates currently expose only the monitoring plan leaf.
  Add the new leaves/options and update parity tests together. Completions must remain static and
  must not contact Lidarr for names or IDs.
- **Required:** `ROADMAP.md` is the living open-work list and currently contains #199 in both Sprint
  1 and Phase B. Mark it shipped and move historical detail to `docs/roadmap-archive.md` only after
  the implementation, docs, review, CI, merge, and real PR evidence exist.
- **Required:** `packages/rfmedia-cli/CHANGELOG.md` follows Keep a Changelog and records notable
  changes under `[Unreleased]`. Add the operator-visible commands and safety behavior there; do not
  claim a release. Repository workflows also establish that the Conventional Commit PR title
  becomes the squash-merge subject/changelog input.
- **Required:** The PR must use `.github/pull_request_template.md`, include `Closes #199`, exact
  validation results, risk/rollback, documentation changes, completion parity, generated drift,
  architecture gates, and v1 compatibility evidence.
- **Nice-to-have:** Root and documentation indexes do not make Lidarr operator guides easy to
  discover. Add concise links rather than duplicating the full package guide.
- **Nice-to-have:** `packages/rfmedia-cli/docs/features/shell-completion.doc.md` has a historically
  stale top-level command list. Either update it as an exhaustive inventory or reword it so future
  command additions do not repeatedly make the guide inaccurate.
