# Integration Research: Lidarr Cascade Analysis

## Integration conclusion

Issue #219 is an internal plan-enrichment change, not a new service integration. The cascade
estimator should run after each planner has canonical operation/entry/summary facts and after the
bounded `lidarr.cascadeAnalysis` policy is resolved, but before checksum sealing. Apply must read
and display that sealed value without consulting current policy. This adds no endpoint, database
schema, credential, dependency, command, flag, or completion change.

## Lidarr API boundary

The existing handwritten facade in
`packages/rfmedia-cli/src/lib/lidarr/client.ts` remains the only command-facing Lidarr boundary.
The generated OpenAPI client stays private under
`packages/rfmedia-cli/src/lib/lidarr/generated/`, and the hardened connection/transport setup
remains in `packages/rfmedia-cli/src/lib/lidarr/index.ts` and
`packages/rfmedia-cli/src/lib/lidarr/transport.ts`.

Current planners already obtain the live facts required to construct their plans:

| Existing facade read                                                                 | Underlying Lidarr endpoint                      | Current planning use                                |
| ------------------------------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------- |
| `listArtists()` / `getArtist()`                                                      | `GET /api/v1/artist`, `GET /api/v1/artist/{id}` | monitoring, profile, tag, delete, album ownership   |
| `listAlbums()`                                                                       | `GET /api/v1/album`                             | album monitoring/edit/delete and track-filter scope |
| `listTracks()` / `listTrackFiles()`                                                  | `GET /api/v1/track`, `GET /api/v1/trackfile`    | file-impact evidence                                |
| `listQualityProfiles()`, `listMetadataProfiles()`, `listTags()`, `listRootFolders()` | existing profile, tag, and root-folder reads    | resolve stable referenced resources                 |
| `lookupArtists()` / `getArtistByForeignId()`                                         | existing artist lookup/read paths               | artist-add evidence and expected absence            |

No new call is justified. The analysis consumes the resulting canonical plan facts; it does not
need `GET /api/v1/wanted/missing`, queue state, command/search endpoints, indexer tests, or download
history. In particular, every current mutation operation directly enqueues zero searches, and
artist-add already seals `searchForMissingAlbums: false`. Conditional acquisition pressure is a
model over changed entries and explicit assumptions, not live Lidarr telemetry.

## External services and credentials

- Continue using the existing Lidarr origin and `X-Api-Key` resolution only for the planner's
  existing live reads and apply's existing drift/mutation calls.
- Do not pass a URL, API key, client, transport, or resilience context into the estimator. Its
  input must be credential-free plan facts plus numeric policy.
- Add no Prowlarr client or credential. Prowlarr statistics/status do not provide a stable,
  typed remaining-quota contract suitable for deterministic checksum material.
- Do not contact indexers, download clients, Last.fm, Plex, or any other arr service for analysis.
  Existing optional Plex scanning after destructive apply is unrelated and must remain unchanged.
- Artifacts should contain aggregate metrics, assumptions, configured per-plan limits, stable
  codes, and derived assessments only; never provider names, topology, API responses, or secrets.

## Database and persistence relevance

No database migration or new table is needed. Cascade analysis belongs in the JSON plan artifact,
where it is reviewable and checksum-sealed.

Existing SQLite-backed resilience metadata, cache, circuit-breaker, and deferred-queue behavior
must remain unchanged. Apply history in `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` is
keyed by plan ID/checksum and records per-entry outcomes; it does not need duplicate cascade
columns. `packages/rfmedia-cli/src/actions/lidarr/apply.ts` may still initialize its existing
database only for normal apply execution. Analysis itself is synchronous, `O(entries)`, and has no
I/O.

## Internal module boundaries

The clean dependency direction is:

```text
validated loaded config
  -> resolved credential-free cascade policy
  -> existing plan producer and canonical facts
  -> pure cascade analyzer
  -> v3 canonicalizer, semantic validator, checksum, artifact
  -> shared plan/apply presenter
```

- `packages/rfmedia-cli/src/types/config.ts` owns the optional configuration shape.
- `packages/rfmedia-cli/src/lib/config.ts` owns structural and numeric validation.
- `packages/rfmedia-cli/src/lib/loaded-config.ts` remains the process-level source for the already
  validated `lidarr` section.
- A new `packages/rfmedia-cli/src/lib/lidarr/cascade-analysis.ts` should own policy resolution,
  checked arithmetic, the exhaustive operation switch, assessments, warnings, recommendations,
  and semantic recomputation.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts` should own v3 and cascade contracts while
  retaining the exact v1/v2 types.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` should add v3 builders, exact
  canonicalization/validation/checksum dispatch, and the widened stored-plan union.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts` should remain the single shared
  human and CSV presentation boundary.

All producer families must migrate together: ordinary artist monitoring/profile/tag/delete,
artist-add, album monitoring, album edit/delete, and track-file filter. Several have separate
builders and preview/no-write result shapes, so analysis must be attached to the in-memory plan
before the preview-versus-artifact branch.

## Configuration validation and resolution

Add optional `lidarr.cascadeAnalysis` beneath the existing Lidarr connection, resilience,
scheduler, and preset settings:

```yaml
lidarr:
  cascadeAnalysis:
    budgets:
      indexerQueries: 250
      acquisitionCandidates: 50
    assumptions:
      albumsPerArtist: 20
      indexerQueriesPerCandidate: 1
```

`packages/rfmedia-cli/src/lib/config.ts` should reject non-objects, unknown nested keys,
non-integers, zero/negative values, values above `1_000_000`, and unsafe integers with a precise
property path. Omission is valid: a missing budget becomes `not-configured`, while a missing
assumption makes only dependent conditional quantities `unknown`.

Resolve and freeze the policy once at plan time from `getLoadedLidarrConfig()`. Connection CLI
overrides remain limited to URL/API key; there should be no cascade CLI overrides. Seal resolved
numeric values and `null` omissions into v3 so later config edits cannot change review evidence.

## Machine and human output

Current commands send human presentation to stderr and use the shared formatter for one
JSON/YAML/CSV document on stdout. Preserve that split.

- JSON/YAML plan output already wraps `{ command: "lidarr-plan", result }`; the structured
  `result.plan.cascadeAnalysis` should flow through without a parallel schema.
- JSON/YAML apply output wraps `{ command: "lidarr-apply", result }`; add a stable plan-time
  analysis projection to the apply result so dry-run and real apply expose the sealed value.
- Extend `projectMutationPlanCsv()` and `projectMutationApplyCsv()` with bounded flat aggregate
  fields. Serialize stable warning/recommendation code arrays if needed; do not emit arbitrary
  prose or repeat aggregate analysis on every entry.
- Human plan preview should render a compact cascade block before entry rows. Apply should label it
  as plan-time evidence. Explicit state words (`WITHIN`, `EXCEEDED`, `UNKNOWN`,
  `NOT CONFIGURED`, `NOT RECORDED`) must carry meaning without color.
- Advisory findings must not set a failure exit code by themselves or leak diagnostics onto
  machine stdout.

## Apply and legacy behavior

`packages/rfmedia-cli/src/actions/lidarr/apply.ts` already reads and validates the artifact before
origin, authorization, live-state, history, claim, mutation, reconciliation, resume, and optional
scan work. Preserve that ordering and all existing safety behavior.

For v3, artifact reading must:

1. validate exact v3 structure and bounded values;
2. recompute the cascade result from canonical plan facts plus sealed policy and reject semantic
   mismatches;
3. verify the normal payload checksum; and
4. return the sealed analysis for presentation.

Apply and `apply --dry-run` must never recompute from current configuration or make analysis-only
network calls. An exceeded or unknown budget is evidence, not an admission gate: it must not
truncate/reorder entries, change confirmations, add authorization, bypass drift checks, affect
resume selection, or block execution.

V1 and v2 are immutable legacy contracts. Keep their exact key allowlists, canonical serializers,
checksum bytes, readers, apply dispatch, history behavior, and execution behavior unchanged. They
must not accept an optional v3 field or receive synthesized analysis. Present them as
`not-recorded` / `NOT RECORDED (legacy plan)` and continue the normal apply path.

## Integration verification

High-value contract tests should prove:

- no estimator test constructs a client or performs I/O;
- every distinct producer emits v3 and preview/artifact analysis is identical;
- JSON, YAML, CSV, and human preview/apply expose the same sealed assessments;
- machine stdout stays a single parseable document;
- apply uses artifact analysis after current config changes;
- advisory exceedance does not change mutation scope or authorization;
- representative frozen v1/v2 fixtures retain their old checksum and apply successfully with
  `not-recorded`;
- the existing Lidarr generated-client contract remains unchanged, demonstrating no endpoint
  addition.
