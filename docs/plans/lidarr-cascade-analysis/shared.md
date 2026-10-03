# Shared Context: Lidarr Cascade Analysis

## Overview

Issue #219 adds deterministic cascade analysis to each newly written Lidarr mutation plan. The
analysis is checksum-sealed with canonical plan facts and a bounded plan-time policy snapshot.
Existing v1/v2 artifacts remain compatible, and the resulting warnings stay advisory throughout
apply.

## Feature Summary

Issue #219 adds deterministic cascade analysis and configured per-plan budget estimates to every
Lidarr mutation plan. New writers emit strict `rfmedia.lidarr-plan.v3` artifacts containing sealed
analysis, while existing v1/v2 artifacts remain byte-compatible, readable, and applicable with a
`not-recorded` presentation state.

The estimator is pure and credential-free. It consumes canonical plan facts and a bounded,
resolved snapshot of `lidarr.cascadeAnalysis`; it performs no Lidarr, Prowlarr, indexer, download
client, database, or other network I/O. Findings are advisory and must not alter authorization,
scope, scheduling, drift checks, execution, retry, resume, history, or exit status.

## Architecture Overview

The existing mutation-plan pipeline is:

```text
validated config and existing Lidarr reads
  -> action-specific selection
  -> family builder and canonical plan facts
  -> strict canonicalization and checksum
  -> preview or atomic artifact write
  -> read/validate/apply
  -> shared human or machine presentation
```

The v3 pipeline inserts one analysis boundary after canonical facts are available and before
checksum sealing:

```text
validated loaded config
  -> resolved bounded cascade policy
  -> existing canonical plan facts
  -> pure cascade analyzer
  -> v3 canonicalizer and semantic validator
  -> checksum-sealed artifact
  -> unchanged apply lanes and shared presenter
```

`packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` remains the artifact boundary.
`packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts` is the only new domain module. It owns
policy resolution, checked arithmetic, the exhaustive operation matrix, budget assessments, and
stable warning/recommendation codes. Actions continue to own live reads and selection; commands
continue to own presentation.

## Relevant Files

### Contracts and configuration

- `packages/rfmedia-cli/src/types/lidarr-plan.ts` — immutable v1/v2 plan contracts; add cascade
  contracts and correlated v3 plan families without changing legacy shapes.
- `packages/rfmedia-cli/src/types/config.ts` — add the optional `lidarr.cascadeAnalysis`
  configuration shape.
- `packages/rfmedia-cli/src/lib/config.ts` — validate exact nested keys and positive safe integers
  capped at `1_000_000`, with precise config paths.
- `packages/rfmedia-cli/src/lib/loaded-config.ts` — existing source of validated Lidarr
  configuration; no new global state is needed.
- `rfmedia.example.yaml` — document operator-chosen budgets and assumptions.

### Planning and artifacts

- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` — shared builders, canonical serializers,
  semantic validation, checksum dispatch, artifact I/O, history, and claims.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts` — canonical artist mutation
  behavior and `hasChange` semantics.
- `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts` — album edit/delete family
  builder and validation.
- `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts` — track-file deletion
  family builder and validation.
- `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts` — new pure estimator and policy module.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts` — v3 canonical/checksum/tamper and
  legacy compatibility contract tests.

### Producers and apply

- `packages/rfmedia-cli/src/actions/lidarr/plan.ts` — artist monitoring plan producer.
- `packages/rfmedia-cli/src/actions/lidarr/plan-albums.ts` — legacy album-monitoring producer that
  must migrate from the v1 builder to v3.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts` — profile assignment producer.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.ts` — tag mutation producer.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts` — artist deletion producer.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts` — expected-absent artist-add
  producer; current plans seal `searchForMissingAlbums: false`.
- `packages/rfmedia-cli/src/actions/lidarr/plan-album-edit.ts` — album edit producer.
- `packages/rfmedia-cli/src/actions/lidarr/plan-album-delete.ts` — album delete producer.
- `packages/rfmedia-cli/src/actions/lidarr/plan-track-filter.ts` — track-file filtering producer.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts` — authoritative read/admission/orchestration
  boundary; consume sealed analysis without recomputing policy.

### Presentation and completions

- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts` — shared human and CSV
  projection for plan/apply.
- `packages/rfmedia-cli/src/commands/lidarr.ts` — JSON/YAML command envelopes and stderr/stdout
  routing.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts` — Bash completion template.
- `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts` — Zsh completion template.
- `packages/rfmedia-cli/src/lib/shell-completions/fish.ts` — Fish completion template.
- `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts` — cross-shell parity guard.

### Documentation and delivery

- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` — canonical operator plan/apply
  contract.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md` — API boundary that must remain
  unchanged.
- `packages/rfmedia-cli/README.md` — public configuration and behavior reference.
- `packages/rfmedia-cli/CHANGELOG.md` — add an `[Unreleased]` entry.
- `ROADMAP.md` and `docs/roadmap-archive.md` — update only with authoritative delivery evidence.
- `.github/pull_request_template.md` — mandatory PR body baseline.

## Relevant Patterns

### Persisted contracts

- Preserve exact v1/v2 discriminators, key allowlists, canonical byte order, checksums, readers,
  apply behavior, history, and resume behavior.
- Add v3 alongside legacy families. Keep operation, selection, entry, and summary types correlated
  with discriminated unions rather than broad optional fields.
- Canonicalizers construct objects field by field in fixed order. Do not spread untrusted records
  into checksum material.
- Strict plan validation rejects missing/unknown keys, forbidden prototype keys, cycles, unsafe
  integers, sensitive keys, inconsistent summaries, and semantic tampering.
- Builders return frozen canonical values and artifacts are validated before atomic write.

### Estimation

- Analyze only changed entries using canonical `hasChange` evidence already owned by each family.
- Every currently shipped operation has exact zero immediate indexer queries.
- Use `0` for known zero and `null` only for unknown quantities.
- Only explicit assumptions may produce modelled conditional values.
- Omitted assumptions preserve dependent values as `unknown`; omitted budgets yield
  `not-configured`.
- Equality is `within`; only a known projection strictly greater than its allowance is `exceeded`.
- Counts use checked safe-integer addition and multiplication. Never clamp overflow.
- Warning and recommendation arrays use stable code unions, deterministic ordering, and
  deduplication. Human prose is derived in the presenter.

### Configuration

- Add an exact nested `lidarr.cascadeAnalysis` object with optional `budgets` and `assumptions`.
- Supported values are:
  - `budgets.indexerQueries`
  - `budgets.acquisitionCandidates`
  - `assumptions.albumsPerArtist`
  - `assumptions.indexerQueriesPerCandidate`
- Values must be positive safe integers no greater than `1_000_000`.
- Resolve the policy once at plan time. Seal explicit `null` omissions so apply is independent of
  later configuration changes.
- Do not add CLI flags or merge these allowances with scheduler lane `operationBudget`.

### Presentation

- Human plan/apply output remains on stderr; JSON/YAML/CSV stdout remains one clean machine
  document.
- Render the cascade block before entry rows and label apply output as plan-time evidence.
- State words must remain meaningful without color: `WITHIN`, `EXCEEDED`, `UNKNOWN`,
  `NOT CONFIGURED`, and `NOT RECORDED`.
- JSON/YAML retain the structured sealed analysis. CSV uses bounded aggregate columns and stable
  code arrays, not free-form prose or repeated per-entry aggregates.
- Legacy v1/v2 artifacts synthesize only the presentation state `not-recorded`; they do not receive
  a persisted analysis object.

## Integration Requirements

### Required producer coverage

All current plan writers must emit v3 together:

1. artist monitoring;
2. album monitoring;
3. artist profile assignment;
4. artist tag mutation;
5. artist delete;
6. artist add;
7. album edit;
8. album delete; and
9. track-file filter.

Existing v1/v2 builders remain available for legacy compatibility tests and reads. Add v3 entry
points or a shared v3 sealing helper rather than silently changing their output.

### API and external boundaries

- Add no generated Lidarr operation and do not refresh the OpenAPI snapshot.
- Add no Prowlarr or download-client client, endpoint, credential, provider name, telemetry, or
  quota claim.
- Add no database table or migration. Analysis belongs only in the plan artifact.
- Preserve the private generated client, command-facing facade, authenticated transport, and
  single-fetch-owner architecture checks.

### Apply invariants

Apply reads and validates sealed v3 analysis, but analysis must not:

- block or authorize execution;
- truncate, reorder, or expand mutation entries;
- change confirmation, destructive authorization, origin/live-state checks, resource drift,
  scheduler behavior, claims, history, retry, resume, or optional Plex scanning;
- cause new network calls; or
- derive values from current configuration.

The v3 validator must recompute the expected analysis from canonical plan facts plus sealed policy
and reject a semantically inconsistent artifact even if an attacker recomputes the checksum.

## Documentation Requirements

- Define v3 metrics, horizons, certainty/basis, sealed assumptions and allowances, budget states,
  stable codes, and the distinction between known zero and unknown.
- State clearly that estimates are conditional and advisory, not current Prowlarr quota,
  provider capacity, elapsed-time guarantees, or scheduler admission.
- Document human and JSON/YAML/CSV representations, including legacy `NOT RECORDED`.
- Update the example configuration without presenting its numbers as universal defaults.
- Add an unreleased changelog entry.
- After implementation, review, green CI, and squash merge, archive #219 in the roadmap using the
  actual PR/date and recompute live issue totals.

## Relevant Docs

- `docs/plans/lidarr-cascade-analysis/feature-spec.md` — authoritative v3 feature contract and
  operation-estimation matrix.
- `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md` — operator-facing plan/apply
  semantics.
- `packages/rfmedia-cli/docs/features/lidarr-generated-client.md` — API generation and private
  transport boundary; no change is expected.
- `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md` — distinguishes scheduler
  operation budgets from the new advisory per-plan allowances.
- `research/rfmedia-lidarr-integration/persona-findings/systems-thinker.md` — original cascade-risk
  motivation.
- `research/rfmedia-lidarr-integration/synthesis/innovation.md` — exploratory proposal, superseded
  where it suggests live Prowlarr or precise quota data.
- `research/rfmedia-lidarr-integration/synthesis/crucible-analysis.md` and
  `research/rfmedia-lidarr-integration/synthesis/contradiction-mapping.md` — system-risk and
  bulk-value tradeoffs.
- `research/rfmedia-lidarr-integration/report.md` — broader Lidarr integration synthesis.
- `ROADMAP.md` and `docs/roadmap-archive.md` — completion accounting updated only after
  authoritative delivery.
- `AGENTS.md`, `CLAUDE.md`, and `packages/rfmedia-cli/AGENTS.md` — repository and package
  implementation rules.

## Testing Requirements

Use focused contract tests rather than duplicating the full matrix across action suites:

- A table-driven pure estimator suite covering operation families, changed/no-op scope, exact zero,
  known/modelled/unknown values, omitted/equal/exceeded allowances, deterministic codes, and
  checked arithmetic overflow.
- V3 artifact tests covering deterministic canonical checksums, exact-key validation, semantic
  tampering after checksum recomputation, and unchanged v1/v2 fixtures/read/apply.
- A compact config valid/omitted case and parameterized invalid matrix for all numeric fields.
- Distinct producer-family coverage proving all nine writers emit v3 and preview/artifact analysis
  is identical.
- Presenter tests proving human and JSON/YAML/CSV expose the same sealed result, machine stdout
  stays clean, apply uses plan-time evidence, and legacy plans show `not-recorded`.
- An apply assertion proving advisory exceedance does not change mutation scope or authorization.
- Existing generated-client/architecture gates, TypeScript/lint/build tests, and the Bash/Zsh/Fish
  completion parity test.

## Constraints and Non-Goals

- No new command, flag, shell completion candidate, dependency, endpoint, database schema,
  credential, or background process.
- No live Prowlarr/indexer/download telemetry or remaining-quota calculation.
- No default assumptions inferred from exploratory `artists × albums × queries` examples.
- No estimates for elapsed time, bytes, downloads, provider-specific behavior, or actual search
  execution.
- No mutation of legacy artifact contracts.
- No conversion of advisory analysis into enforcement.

## Implementation Ordering

1. Stabilize v3, cascade, and configuration contracts.
2. Implement and test the pure analyzer and policy resolution.
3. Add v3 artifact canonicalization, semantic validation, checksum dispatch, and widened shared
   unions.
4. Migrate builder families and all nine producers in dependency-aware parallel batches.
5. Integrate shared plan/apply presentation and machine projections.
6. Update operator docs, examples, changelog, and roadmap evidence.
7. Run focused tests first, then repository gates, completion parity, graph update, review, CI,
   merge, and cleanup.
