# Documentation Research: Lidarr Cascade Analysis

## Architecture Docs

- **Required — `docs/plans/lidarr-cascade-analysis/feature-spec.md`:** Settled issue #219 contract:
  strict `rfmedia.lidarr-plan.v3`, pure analysis over canonical plan facts and sealed static policy,
  advisory budgets, unchanged v1/v2 behavior, and no new network, credential, command, or flag.
- **Required — `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`:** Canonical operator
  contract for checksums, origin/live-state checks, dry-run, approval, claims, history, resume, and
  every shipped mutation family. Add v3 plan-time analysis and legacy `NOT RECORDED` behavior
  without implying that apply recomputes current capacity.
- **Required — `packages/rfmedia-cli/src/types/lidarr-plan.ts`:** Versioned plan and operation/entry
  correlations. Its comments and types are the contract to extend with correlated v3 families while
  preserving the existing v1/v2 unions exactly.
- **Required — `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`:** Executable architecture for
  plan construction, canonical serialization, SHA-256 integrity, strict parsing, semantic
  validation, atomic artifact storage, history, and claims. The v3 analyzer must feed this boundary.
- **Required — `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`:** Shared human and
  machine projection boundary used by mutation previews and apply. It must render the same sealed
  analysis for preview, saved plans, apply dry-run, and apply.
- **Required — `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`:** Defines the
  private generated-client, facade/projector, and single authenticated transport boundaries.
  Issue #219 adds no API call, so these boundaries must remain unchanged.
- **Optional context — `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md`:** Distinguishes
  scheduler operation budgets from the new configured per-plan query/acquisition allowances. Do
  not merge these concepts or add scheduler enforcement.
- **Optional overview — `docs/architecture/overview.md` and `docs/architecture/data-flow.md`:**
  Repository-wide command/action separation, strict TypeScript, stderr-versus-stdout rules,
  configuration loading, and machine-output flow. They need updates only if the general architecture
  changes, which the feature spec does not require.

## API Docs

- **Required evidence — `packages/rfmedia-cli/openapi/lidarr-v1.json` and
  `packages/rfmedia-cli/openapi/lidarr-v1.manifest.json`:** Committed Lidarr API contract and
  provenance. Existing artist/album reads supply planner facts; no refresh or generated operation is
  needed for this pure estimator.
- **Required boundary — `packages/rfmedia-cli/src/lib/lidarr/client.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/types.ts`, and
  `packages/rfmedia-cli/src/lib/lidarr/transport.ts`:** Comments document facade projection,
  credential confinement, bounded responses, origin binding, cancellation, and the sole Fetch
  owner. Cascade analysis must not cross this boundary.
- **Required issue research — `research/rfmedia-lidarr-integration/persona-findings/systems-thinker.md`:**
  Origin of the non-linear `artists × albums × indexer queries` concern and cross-arr impact.
- **Required issue research — `research/rfmedia-lidarr-integration/synthesis/innovation.md`:**
  Proposes pre-execution cascade output and budget estimation. Its live Prowlarr usage, elapsed-time,
  and daily-quota examples are exploratory and are superseded by the feature spec's static,
  conditional, explicitly modelled allowances.
- **Required issue research — `research/rfmedia-lidarr-integration/synthesis/crucible-analysis.md`,
  `research/rfmedia-lidarr-integration/synthesis/contradiction-mapping.md`, and
  `research/rfmedia-lidarr-integration/report.md`:** Trace the bulk-value versus systemic-risk
  rationale. Their `50 × 20 × N` figures are motivation, not verified defaults or guarantees.
- **Optional gap evidence — `research/rfmedia-lidarr-integration/synthesis/negative-space.md`:**
  Records the absence of empirical bulk-add/query measurements; supports preserving `unknown`
  instead of inventing precise provider capacity.
- **Optional future context — `packages/rfmedia-cli/docs/features/lidarr-discovery.md`:** Tracks
  #219 as downstream impact analysis but does not own the estimator or alter discovery traversal.

## Development Guides

- **Required — `AGENTS.md`, `CLAUDE.md`, and `packages/rfmedia-cli/AGENTS.md`:** Repository/package
  rules for strict TypeScript, ESM `.js` imports, command/action separation, JSDoc, co-located
  Vitest tests, markdown, architecture checks, and GitHub templates.
- **Required — `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts`,
  `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.test.ts`, and
  `packages/rfmedia-cli/src/lib/lidarr/plan-artist-add-operations.test.ts`:** Executable guides for
  strict plans, tamper rejection, operation-specific facts, and legacy compatibility.
- **Required — `packages/rfmedia-cli/src/actions/lidarr/plan.test.ts`,
  `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts`, and
  `packages/rfmedia-cli/src/commands/lidarr.test.ts`:** Preview/apply/presenter integration,
  machine-output, dry-run, approval, and error behavior.
- **Required — `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`:** Despite its legacy
  name, enforces private generated imports, the single Lidarr Fetch owner, and absence of handwritten
  `/api/v1/` paths. The new module must stay pure under this gate.
- **Required delivery — `.github/pull_request_template.md`:** Record exact validation outcomes,
  `Closes #219`, risk/rollback, docs changes, generated-client drift evidence, and legacy-plan
  compatibility.
- **Optional — `packages/rfmedia-cli/docs/testing/troubleshooting.md`:** Vitest isolation and mock
  debugging guidance if focused estimator or integration tests fail.
- **Optional completion audit — `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`:**
  No CLI surface changes are planned; use parity evidence to document that Bash/Zsh/Fish templates
  require no change.

## README Files

- **Required; update — `packages/rfmedia-cli/README.md`:** Public rfmedia reference. Document
  `lidarr.cascadeAnalysis` policy, exact/modelled/unknown semantics, separate configured per-plan
  allowances, advisory findings, v3 sealing, legacy `NOT RECORDED`, and human/machine examples.
- **Optional index — `docs/README.md`:** Add or revise a link only if the plan/apply guide needs
  better discovery; do not duplicate detailed semantics.
- **Optional root overview — `README.md`:** The root delegates rfmedia details to the package
  README; no update is needed unless the top-level product summary changes.
- **Required example — `rfmedia.example.yaml`:** Not a README, but the shipped configuration
  reference. Add bounded, secret-free example budgets and assumptions, explicitly labelled as
  operator choices rather than universal defaults.

## Must-Read Documents

1. **Required — `docs/plans/lidarr-cascade-analysis/feature-spec.md`**
2. **Required — `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`**
3. **Required — `packages/rfmedia-cli/src/types/lidarr-plan.ts`**
4. **Required — `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`**
5. **Required — `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`**
6. **Required — `packages/rfmedia-cli/docs/features/lidarr-generated-client.md`**
7. **Required — `research/rfmedia-lidarr-integration/synthesis/innovation.md`**
8. **Required — `research/rfmedia-lidarr-integration/persona-findings/systems-thinker.md`**
9. **Required — `packages/rfmedia-cli/README.md` and `rfmedia.example.yaml`**
10. **Required — `ROADMAP.md`, `docs/roadmap-archive.md`, and
    `packages/rfmedia-cli/CHANGELOG.md`**

## Documentation Gaps

- **Required:** No operator document defines v3 cascade metrics, horizon/certainty/basis codes,
  sealed assumptions, budget statuses, stable warning/recommendation codes, or why zero differs from
  unknown. Add these to the plan/apply guide and summarize them in the package README.
- **Required:** Existing plan/apply docs describe v1/v2 artifacts and currently defer cascade
  estimation to #219. Update them for v3 while preserving byte-for-byte legacy checksum,
  validation, apply, history, and resume semantics.
- **Required:** Current docs do not distinguish configured per-plan allowances from live Prowlarr
  quota or scheduler `operationBudget`. State that findings are conditional/advisory and never
  block, truncate, reorder, authorize, or recalculate apply.
- **Required:** Human and JSON/YAML/CSV schemas do not yet expose the same plan-time analysis.
  Document ordering, `UNKNOWN`/`NOT CONFIGURED`/`NOT RECORDED`, clean stdout, stable codes, and CSV
  columns without color-only meaning.
- **Required:** The exploratory research suggests live Prowlarr usage and precise query/time
  estimates, but the repository has no Prowlarr client or stable remaining-quota contract.
  Documentation must explicitly reject those claims for v1 analysis and avoid credentials,
  provider responses, indexer names, downloads, byte estimates, or elapsed-time guarantees.
- **Required completion:** `ROADMAP.md` lists #219 in the current critical path and Layer 2 table.
  Only after implementation, review, green CI, merge, and authoritative issue audit should it move
  to `docs/roadmap-archive.md` with real PR/date evidence and corrected live totals.
- **Required completion:** Add an `[Unreleased]` entry to
  `packages/rfmedia-cli/CHANGELOG.md`; do not claim a release. The final PR must use
  `.github/pull_request_template.md` and record exact tests, architecture/codegen gates, completion
  parity, v1/v2 compatibility, and rollback.
- **Optional:** `docs/README.md` does not make Lidarr plan/apply material prominent. Prefer one
  canonical link over duplicating the feature guide.
