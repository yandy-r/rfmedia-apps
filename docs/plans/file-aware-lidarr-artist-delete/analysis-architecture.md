<!-- markdownlint-disable MD026 -->

# Architecture Analysis:

<!-- markdownlint-enable MD026 -->

## Executive Summary

Issue #200 should be implemented as one additive `artist-delete` member of the existing strict
`rfmedia.lidarr-plan.v2` pipeline. Planning can reuse the complete artist snapshot, shared
IDs/filters/`--all` selector, deterministic cap enforcement, private artifact writer, and mutation
presenter; apply can reuse origin/checksum validation, whole-plan preflight, exclusive claims,
sequential per-target admission, bounded verification, history, and resume.

Deletion exposes two assumptions that must be changed deliberately rather than worked around:
the v2 operation definition currently requires every operation to have a deferred executor, and
the apply pipeline assumes every artist read yields a present `LidarrArtist`. `artist-delete` must
be explicitly non-deferable and must own present/absent semantics. Initial absence is stale, while
typed not-found after this plan may have dispatched is the only successful deletion postcondition.

## Architecture Context

The package follows a stable dependency direction:

```text
commands/lidarr.ts
  -> actions/lidarr/plan-artist-delete.ts
  -> lib/lidarr/plan-engine.ts + plan-operation-definitions.ts
  -> lib/lidarr/client.ts
  -> private generated SDK
  -> hardened origin-bound transport
```

Planning should perform one fresh `listArtists()` read plus only the profile/tag reads required to
resolve filters. `selectLidarrArtists()` already enforces exactly one selection mode, AND-combined
filters, unique known IDs, stable ID ordering, zero-match rejection, and whole-cohort `maxBatch`
enforcement. The new action must additionally require a non-empty path and complete non-negative
safe-integer `albumCount`, `trackFileCount`, and `sizeOnDisk`, then pass operation-specific sources
to `buildLidarrMutationPlanV2()`. Planning `--dry-run` must render the same in-memory plan but skip
the artifact write.

The v2 artifact is a closed, operation-discriminated contract. Adding deletion therefore crosses
the type unions, operation registry, canonical serializer, exact-key parser, checksum material,
entry correlation, risk facts, and summary validation. Each entry seals `artist:<id>`, the display
name, exact path/count/byte evidence, `{ exists: false }`, and an idempotency key. The plan-wide
operation seals `deleteFiles`; `addImportListExclusion` is not configurable and is always sent as
`false`.

Apply currently reads the complete artist list for whole-plan preflight, then calls `getArtist(id)`
immediately before each sequential mutation and during bounded reconciliation. Preserve that
shape, but make observed existence operation-aware:

1. Initial whole-plan absence is stale and blocks all mutation.
2. Present evidence must exactly match the seal before the first mutation and again just in time.
3. Dispatch uses one generated `DELETE /api/v1/artist/{id}` request with no automatic retry.
4. Post-dispatch typed not-found verifies success; every other read error remains an error.
5. Ambiguous dispatch or verification stops later admissions and requires explicit resume.

The current history row records only a terminal outcome/code/message, while dispatch-state detail
exists only in the transient apply result. Safe missing-target reconciliation on resume therefore
requires durable attempt evidence tied to plan ID, checksum, entry ID, and idempotency key before
or at the possible-dispatch boundary. Do not infer prior dispatch from absence or from a generic
`uncertain` result.

Plex remains outside Lidarr plan identity. After all deletion results/history are durable,
`resolveOptionalScanAdapter()` may trigger one full `scan.trigger()` only for a real delete-files
apply with at least one newly verified success and non-zero reviewed file impact. Scan status is
runtime output only; failure cannot roll back, reclassify, or replay a Lidarr deletion.

## Critical Files Reference

- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: closed v2 operation, entry, summary, observed
  state, apply result, history, and authorization-related contracts.
- `packages/rfmedia-cli/src/types/lidarr.ts`: `LidarrArtist.path` and `statistics` are optional;
  the plan action must fail closed rather than coerce missing evidence.
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`: complete deterministic artist cohort
  selection and cap enforcement; reuse rather than duplicate.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts` and
  `plan-artist-tags.ts`: closest patterns for filtered snapshot resolution and strict v2 plan
  creation.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts`: new planning owner for evidence
  validation and mutation-free plan construction.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: single owner for delete
  risk, entry construction, payload, drift comparison, execution, and explicit non-deferability.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: strict parsing/canonicalization/checksum,
  secure artifact/history storage, claims, and resume selection.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: only handwritten layer allowed to import
  `deleteApiV1ArtistById`; validates one ID/boolean and uses the void-response path.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: must forward `deleteArtist` while leaving it
  outside the in-place retry allowlist.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: cumulative authorization, whole-plan
  preflight, history-aware resume, result aggregation, and optional scan integration.
- `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts` and
  `apply-artist-entry-execution.ts`: just-in-time admission, dispatch certainty, operation-aware
  not-found verification, stop-admission, and persistence.
- `packages/rfmedia-cli/src/actions/lidarr/apply-deferred-replay*.ts`: deletion must never enter or
  be matched by this subsystem.
- `packages/rfmedia-cli/src/commands/lidarr.ts` and
  `commands/lidarr-mutation-presenter.ts`: CLI hierarchy, independent allow flags, confirmation,
  human/machine evidence, scan status, and pinned recovery command.
- `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts` and
  `src/types/media-server.ts`: existing optional adapter resolver and non-throwing full-scan result.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` and
  `templates.spec.ts`: exact command/flag parity contract.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: architecture gate enforcing
  private generated imports, one Lidarr fetch owner, and no handwritten API routes.

## Cross-Cutting Concerns

- **Compatibility:** Extend v2 additively; preserve v1 and existing v2 canonical bytes, checksums,
  fixtures, output rows, and behavior. Every new switch must be exhaustive.
- **Destructive authority:** `--yes` only bypasses the prompt. Real apply always requires
  `--allow-artist-delete`; delete-files plans additionally require `--allow-file-delete`, including
  resume. Apply dry-run reports/checks intent without mutating.
- **Certainty and durability:** Claims must still be owned at dispatch/history boundaries.
  Possibly dispatched work is never automatically retried or deferred, and runtime failure detail
  is insufficient unless its dispatch evidence is durable.
- **API isolation:** Generated code owns paths/query serialization; transport owns credentials,
  redirects, timeout, cancellation, bounded bodies, and typed errors. No generated import may
  escape the facade.
- **Filesystem isolation:** Paths and statistics are Lidarr-reported review evidence only. Add no
  walk, stat, realpath, unlink, trash, recursive delete, glob, or shell deletion.
- **Privacy and output:** Plans necessarily contain artist names and paths, so retain private,
  atomic, no-overwrite artifact handling and terminal-safe bounded presentation. Never serialize
  credentials or raw response bodies.
- **CLI parity:** Human, JSON/YAML, and CSV output must expose exact evidence and keep-files versus
  delete-files mode. Recovery commands must retain both required allow flags, plan ID, and checksum.
- **Testing:** Protect the boundaries with focused client request tests, strict plan/checksum
  fixtures, initial-versus-post-dispatch absence tests, drift tests for every evidence field,
  no-retry/no-defer assertions, scan gating, command authorization, and three-shell parity.

## Parallelization Opportunities

- **Facade lane:** `client.ts`, `resilience.ts`, client mocks, and focused client/resilience tests
  can proceed independently after the `deleteArtist(id, deleteFiles, signal?)` signature is fixed.
- **Contract lane:** `lidarr-plan.ts`, operation definitions, plan engine, and plan-engine tests
  should have one owner because their closed unions and canonical switches are tightly coupled.
- **Planning lane:** the new plan action and tests can proceed once source/entry type names are
  agreed; it can reuse selection without touching apply.
- **Apply lane:** preflight, durable attempt evidence, reconciliation, authorization, and
  no-deferred behavior form one safety-critical lane and should not be split across competing
  owners.
- **Presentation lane:** command wiring, presenter, completions, docs, and roadmap can run after
  result/option shapes stabilize. Completion files may be handled together as one parity task.
- **Scan integration:** adapter resolution and scan-result presentation can be developed against
  the settled apply result, but final wiring depends on verified-success classification.

The critical dependency order is contracts/facade first, then planning and apply in parallel,
followed by presentation/scan integration and full compatibility validation.

## Implementation Constraints

- Follow the final feature spec where earlier research differs: artist-only scope; initial absence
  is stale; import-list exclusion is explicitly `false`; missing evidence blocks both modes; Plex
  uses at most one full scan.
- Do not create a second plan schema/executor or general deletion framework. Album deletion remains
  issue #223.
- Refactor the operation definition's mandatory deferred fields into an explicit capability or
  otherwise exclude deletion structurally; never register a fake delete replay executor.
- Make typed not-found verification conditional on `artist-delete`. Existing mutations correctly
  treat not-found as failure, so a global reversal would be a regression.
- Resume may classify an absent artist as satisfied only when durable evidence proves this exact
  plan could have dispatched it. An initial apply or unproven resume absence remains stale.
- Send exactly one single-ID generated request per admitted artist with
  `deleteFiles` and `addImportListExclusion: false` explicit, `parseAs: "stream"`, and zero mutation
  retries. Never use `/artist/editor`.
- Preserve sequential sealed order and stop admission on drift, lost claim, failed/inconclusive
  verification, or cancellation after possible dispatch.
- Planning dry-run writes no plan; apply dry-run acquires no claim and writes no history, deferred
  row, Lidarr state, file state, exclusion, or Plex scan.
- Treat zero counts/bytes as valid; reject negative, fractional, unsafe, missing, or malformed
  evidence. Name drift is warning-only; path/count/byte drift blocks.
- Keep NodeNext ESM `.js` import conventions, use no new dependency, and do not hand-edit generated
  files.
