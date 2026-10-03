# Lidarr Cascade Analysis: Analysis Context

## Executive Summary

Issue #219 is an artifact-enrichment change, not a live cross-stack integration. Every new Lidarr
mutation plan must become a strict `rfmedia.lidarr-plan.v3` artifact whose deterministic,
credential-free cascade analysis is derived once from canonical plan facts and a resolved bounded
policy, then included in checksum material. Existing v1/v2 artifacts remain unchanged and
applicable; apply displays their analysis as `not-recorded`.

The safest implementation introduces one pure `O(entries)` analyzer and one shared v3 sealing
boundary, then migrates all nine producers together. Budget findings remain advisory: they must
not affect authorization, scope, ordering, scheduler admission, drift checks, execution, retry,
resume, history, exit status, or optional Plex scanning.

## Architecture Context

The current write path is:

```text
validated config and existing Lidarr reads
  -> action-owned selection
  -> family-specific canonical entries/review/summary/risk
  -> fixed-order canonicalization and SHA-256 checksum
  -> preview or atomic no-overwrite artifact write
```

The v3 path inserts a single analysis boundary:

```text
validated lidarr.cascadeAnalysis config
  -> frozen policy with explicit null omissions
  -> existing canonical plan facts
  -> pure analyzeLidarrCascade()
  -> v3 semantic validation and fixed-order canonicalization
  -> checksum, preview/write, shared presentation
```

Four construction paths currently exist:

1. `buildLidarrMutationPlanV2()` for artist monitoring, profile assignment, tag mutation, and
   artist deletion.
2. `buildLidarrArtistAddPlanV2()` for expected-absent MusicBrainz targets.
3. `buildLidarrAlbumMutationPlanV2()` for album edit and album deletion.
4. `buildLidarrTrackFilterPlanV2()` for one album's reviewed file deletions.

Album monitoring is the important exception: its action still calls the v1
`buildLidarrMutationPlan()`. It must move to v3 while the v1 builder remains unchanged for legacy
fixtures and readers.

`plan-engine.ts` is the artifact trust boundary. Actions retain ownership of existing live reads,
selection, and resource resolution; operation definitions retain `hasChange`, canonical entry,
risk, summary, drift, and execution semantics; commands retain presentation. The analyzer belongs
between these boundaries and must receive no client, credential, transport, database, or ambient
configuration.

## Critical Files Reference

| File                                                                  | Responsibility and required change                                                                                                                        |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/plans/lidarr-cascade-analysis/feature-spec.md`                  | Authoritative v3 contract, estimation matrix, resolved decisions, and success criteria.                                                                   |
| `docs/plans/lidarr-cascade-analysis/shared.md`                        | Consolidated architecture, integration, testing, and non-goal context.                                                                                    |
| `packages/rfmedia-cli/src/types/lidarr-plan.ts`                       | Preserve exact v1/v2 types; add cascade contracts, the v3 discriminator, correlated v3 family types, and apply/generation result exposure.                |
| `packages/rfmedia-cli/src/types/config.ts`                            | Add optional `lidarr.cascadeAnalysis` budgets and assumptions.                                                                                            |
| `packages/rfmedia-cli/src/lib/config.ts`                              | Validate exact nested keys and positive safe integers no greater than `1_000_000`, with precise property paths.                                           |
| `packages/rfmedia-cli/src/lib/loaded-config.ts`                       | Existing source of validated Lidarr policy; no new global state is needed.                                                                                |
| `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts`             | New pure module for policy resolution, checked arithmetic, the exhaustive operation matrix, assessments, codes, and semantic recomputation.               |
| `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`                  | Add v3 builders/sealing, canonicalization, validation, checksum/read/write dispatch, and widen the shared stored-plan union without changing v1/v2 bytes. |
| `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`   | Source of artist-family canonical `hasChange` evidence; do not duplicate its execution rules.                                                             |
| `packages/rfmedia-cli/src/lib/lidarr/plan-album-operations.ts`        | Album edit/delete canonical builder and change semantics; route its facts through shared v3 sealing.                                                      |
| `packages/rfmedia-cli/src/lib/lidarr/plan-track-filter-operations.ts` | Track-filter canonical builder and exact file/byte evidence; route through shared v3 sealing.                                                             |
| `packages/rfmedia-cli/src/actions/lidarr/plan*.ts`                    | Nine producers must resolve policy and emit v3 together; `plan-albums.ts` requires explicit migration from v1.                                            |
| `packages/rfmedia-cli/src/actions/lidarr/apply.ts`                    | Return sealed plan-time analysis for presentation while preserving all admission and execution gates.                                                     |
| `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`      | Central human and CSV projection; replace local narrow unions with the widened shared contract where possible.                                            |
| `packages/rfmedia-cli/src/commands/lidarr.ts`                         | Preserve stderr/stdout isolation and the existing JSON/YAML envelopes.                                                                                    |
| `packages/rfmedia-cli/src/lib/lidarr/plan-validation.ts`              | Reuse fail-closed exact-key, bounded-value, sensitive-key, cycle, and prototype-key primitives.                                                           |
| `packages/rfmedia-cli/src/lib/shell-completions/templates.spec.ts`    | Parity gate only; no Bash/Zsh/Fish template change is expected because no CLI surface changes.                                                            |

## Patterns to Follow

- Add v3 beside v1/v2. Do not add optional analysis to v2 or alter legacy canonical projections,
  validators, checksums, readers, history, or apply behavior.
- Preserve type correlation with discriminated unions or a distributive v3 mapping; avoid broad
  optional fields that decouple operation, selection, entry, and summary families.
- Build canonical facts first, analyze once, construct nested objects field by field in fixed
  order, validate, checksum, freeze, then preview or atomically write the same object.
- Analyze changed entries only, using each family's existing `hasChange` evidence. Preserve `0` as
  known zero and use `null` only for an unknown quantity or unconfigured limit.
- Use one exhaustive operation-kind switch with a `never` guard so future operation additions
  cannot silently omit cascade semantics.
- Use checked safe-integer addition and multiplication. Overflow is a planning failure before
  artifact write; never clamp or coerce.
- Persist stable basis, warning, and recommendation codes in deterministic allowlist order.
  Presenter-owned prose must not become checksum material.
- Recompute expected v3 analysis during untrusted artifact validation from canonical facts plus
  sealed policy. A recomputed checksum must not legitimize semantically inconsistent analysis.
- Resolve policy once at plan time and seal explicit omissions. Apply consumes sealed evidence and
  never consults current cascade configuration.

## Cross-Cutting Concerns

### Compatibility and trust

- `assertLidarrMutationPlan()`, checksum dispatch, artifact serialization, and read/write dispatch
  currently branch only on v1/v2 and all require an explicit v3 branch.
- Exact-key v2 validation intentionally rejects extra fields; this is why v3 is required.
- Apply and the presenter contain hand-maintained local widened unions. Audit every type guard,
  resume/history helper, generation result, and operation-kind switch for v3 family coverage.
- SHA-256 provides integrity, not author authentication. Semantic recomputation is required to
  prevent internally inconsistent but re-checksummed artifacts.

### Estimation semantics

- All current operations cause exact zero immediate explicit searches and indexer queries.
- Conditional candidate rules must follow the feature-spec matrix. Artist-level projections use
  only explicit sealed `albumsPerArtist`; conditional query projections require explicit sealed
  `indexerQueriesPerCandidate`.
- Missing assumptions yield `unknown`; missing budgets yield `not-configured`; equality is
  `within`; only a known projection strictly greater than its allowance is `exceeded`.
- Profile/tag/album-policy changes remain unknown without release or automation evidence. Do not
  infer downloads, bytes, elapsed time, provider fan-out, or remaining quota.

### Configuration and terminology

- The resolved public shape is `lidarr.cascadeAnalysis`, with separate `budgets` and
  `assumptions`. Its four numeric values are positive safe integers capped at `1_000_000`.
- Keep these configured per-plan allowances separate from scheduler lane `operationBudget`.
- Earlier `research-practices.md` alternatives (`cascadeBudgets`, optional v2 analysis, allowing
  zero, hard-coded coefficients) are superseded by `shared.md` and `feature-spec.md`.

### Presentation and execution

- Human plan/apply diagnostics remain on stderr; JSON/YAML/CSV stdout remains one clean document.
- Render the cascade block before entry rows and label apply output as plan-time evidence.
- Use explicit non-color state words: `WITHIN`, `EXCEEDED`, `UNKNOWN`, `NOT CONFIGURED`, and
  `NOT RECORDED`.
- JSON/YAML retain structured analysis. CSV should use one bounded aggregate projection with
  stable code arrays, not repeated per-entry data or free-form prose.
- Exceeded or incomplete findings must not change confirmation, destructive authorization,
  mutation scope/order, drift/resource checks, claims, scheduler behavior, retry/resume/history,
  optional scanning, or exit status.

### Verification and delivery

- Concentrate the full operation matrix in the pure analyzer suite; test artifact strictness,
  config validation, producer coverage, presentation parity, and advisory apply behavior at their
  own boundaries rather than duplicating the matrix.
- Prove preview and written-artifact analysis are identical for each distinct builder path and all
  nine producers emit v3.
- Preserve representative frozen v1/v2 checksum/read/apply fixtures.
- Run generated-client architecture/codegen gates even though no endpoint changes, and run the
  Bash/Zsh/Fish completion parity test while recording that templates are unchanged.

## Parallelization Opportunities

Parallel work is safe only after the v3 and analysis contracts stabilize:

1. **Foundation, sequential:** define config, cascade, v3 family, stored-plan, generation-result,
   and apply-result contracts.
2. **Analyzer/config, parallel:** implement the pure analyzer and its table-driven suite while
   adding strict nested config validation/tests.
3. **Artifact engine, sequential dependency:** add shared v3 sealing, canonicalization, semantic
   validation, checksum/read/write dispatch, and legacy compatibility tests.
4. **Producer migration, parallel by non-overlapping family:** ordinary artist producers;
   artist-add; album monitoring plus album edit/delete; and track-filter.
5. **Presentation/apply, parallel with producer migration:** widen apply/presenter unions, expose
   sealed analysis, add human/JSON/YAML/CSV projection, and prove advisory invariants.
6. **Documentation and verification, after integration:** public docs/example/changelog,
   completion audit, full gates, review, CI, and authoritative roadmap closeout.

Avoid partial adoption: all producer branches must converge before the change is considered
integrated, even if their file edits are implemented concurrently.

## Implementation Constraints

- Create only the local analyzer/test module; add no dependency, endpoint, generated Lidarr
  operation, OpenAPI refresh, Prowlarr/download-client client, credential, database table,
  telemetry, or background process.
- Add no command, flag, option, or completion candidate. Cascade policy is durable config only.
- Do not infer default modeling assumptions from exploratory `artists × albums × queries`
  examples; omission must remain explicit.
- Keep output constant-size and analysis `O(entries)` with no I/O.
- Do not mutate legacy artifacts or synthesize persisted analysis for them.
- Keep v3 arrays, strings, numeric fields, enums, and nested keys bounded and exact.
- Preserve current atomic, private, no-overwrite artifact storage and existing typed errors.
- Preserve the generated-client/private-facade/single-authenticated-fetch-owner boundary.
- Update ROADMAP totals and shipped history only after authoritative review, green CI, squash
  merge, and issue/PR evidence are available.

## Key Recommendations

1. Make `cascade-analysis.ts` the sole owner of policy resolution, arithmetic, operation semantics,
   assessments, stable codes, and semantic recomputation.
2. Add a shared v3 sealing helper that accepts canonical family facts so four builders do not
   duplicate analysis/checksum logic.
3. Use v3-only strict validation and checksum dispatch while leaving every v1/v2 code path
   byte-for-byte unchanged.
4. Migrate all nine producers in one integration change, with an explicit regression for the
   legacy v1 album-monitoring producer.
5. Return the validated sealed analysis in apply results; never re-read current policy or
   recompute capacity during apply.
6. Keep the public wording precise: configured per-plan allowance, conditional model, advisory
   warning, and plan-time evidence—not live quota, guaranteed download work, or enforcement.
7. Use focused contract tests: one exhaustive estimator matrix, one v3 artifact/tamper suite, one
   parameterized config matrix, distinct builder/producer coverage, presentation parity, and one
   advisory-apply invariant.
