# Integration Analysis: issue-311-policy-plan

## Executive Summary

`rfmedia lidarr policy plan` is CLI composition over shipped boundaries. It adds no HTTP endpoint,
database table, migration, dependency, OpenAPI operation, generated-client code, or Lidarr mutation
call. The command runs `executeLidarrPolicyEvaluate`, passes its frozen proposals through a new pure
projector, and either returns a zero-artifact review (`--mode recommend`, the default) or invokes the
two existing plan producers (`--mode plan`). Apply remains a separate operator command.

The integration-critical rule is that evaluation evidence selects IDs and desired targets but does
not become artifact state. Each producer re-reads Lidarr and constructs the strict v3 artifact from
fresh state. Global projection/refusal validation occurs before the first producer call; after that,
sequential producer failures may yield an explicit partial result containing already-written
artifacts.

**Confidence**: High. The feature spec fixes these boundaries and the existing evaluator,
`sync-ratings`, producers, plan engine, and apply command implement the required seams.

## API Endpoints

There is no new network-facing API. The only new public API is the additive CLI leaf registered
under the existing Commander parent in
`packages/rfmedia-cli/src/commands/lidarr-policy.ts`, itself attached by
`packages/rfmedia-cli/src/commands/lidarr.ts`.

Indirect Lidarr reads remain owned by existing producers:

| Endpoint                      | Facade method                          | Existing owner                                             | Purpose                                                                         |
| ----------------------------- | -------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /api/v1/artist`          | `LidarrClientApi.listArtists`          | `src/actions/lidarr/plan.ts` and `plan-artist-profiles.ts` | Confirm exact IDs and capture fresh artist state.                               |
| `GET /api/v1/qualityprofile`  | `LidarrClientApi.listQualityProfiles`  | `src/actions/lidarr/plan-artist-profiles.ts`               | Resolve the proposal's numeric target profile.                                  |
| `GET /api/v1/metadataprofile` | `LidarrClientApi.listMetadataProfiles` | `src/actions/lidarr/plan-artist-profiles.ts`               | Existing producer completeness; policy-plan does not request a metadata target. |

The facade and operation ownership stay in
`packages/rfmedia-cli/src/lib/lidarr/client.ts`; the hardened same-origin, bounded-response,
credential-injecting transport stays in `src/lib/lidarr/transport.ts`. The new action must not import
`src/lib/lidarr/generated/**`, edit `openapi/lidarr-v1.json`, run code generation, or construct URL,
header, or request-body data.

No mutation endpoint is reachable from this feature. In particular, `PUT /api/v1/artist/editor`
and `PUT /api/v1/artist/{id}` belong to the separate apply lifecycle. `--mode plan` writes local
artifacts only.

Connection options flow unchanged: the command forwards raw `--lidarr-url` and
`--lidarr-api-key` values to the evaluator and producer actions. Resolution and config fallback are
centralized by `resolveRequiredLidarrOrigin` and `resolveRequiredLidarrClient` in
`src/lib/lidarr/index.ts`. That module canonicalizes the URL to an HTTP(S) origin and rejects
credentials, paths, queries, and fragments in the base URL. Failure rendering in
`src/commands/lidarr-policy.ts` must continue passing the Plex token and Lidarr API key as sensitive
values so standard redaction covers both review and seal failures.

**Confidence**: High. All endpoint and credential work is already encapsulated behind the facade
and action APIs.

## Database

No schema, migration, query, claim, plan-history, or policy-result persistence is added. The new
types and projector are in-memory only, and sealed plans remain JSON files rather than database
rows. Files that must remain unchanged include:

- `packages/rfmedia-cli/src/lib/schema.sql`
- `packages/rfmedia-cli/src/lib/migrations.ts`
- `packages/rfmedia-cli/src/lib/bridge/cache.ts`
- plan claim/history modules under `packages/rfmedia-cli/src/lib/lidarr/`

One inherited nuance must be documented accurately: `executeLidarrPolicyEvaluate` calls
`executeLidarrReconcile` in `src/actions/lidarr/reconcile.ts`. Live reconciliation already performs
an observational replacement of `bridge_identity_snapshots` through
`replaceBridgeIdentitySnapshot` in `src/lib/bridge/cache.ts`. `policy plan` adds no database access
and must not change that behavior. “Zero-write recommend mode” therefore means no plan artifact,
Plex mutation, Lidarr mutation, claim, or history write beyond this pre-existing reconciliation
snapshot refresh.

The wrapper must not open a database itself. Its dependency-injected tests should mock the evaluate
action and both producers, keeping projector and orchestration coverage independent of SQLite.

**Confidence**: High. The evaluator source explicitly names the observational snapshot replacement
as its only inherited write.

## External Services

The feature coordinates two already-configured services and introduces none:

- **Plex** is read only through `executeLidarrPolicyEvaluate`. Signal collection remains in
  `src/actions/lidarr/policy-gather.ts` and provider access remains behind
  `src/lib/adapters/action-helpers.ts`. The plan wrapper must not import Plex wire modules or call
  `fetch`.
- **Lidarr** is read during evaluation and re-read by the plan producers. The wrapper never calls
  a Lidarr client method directly. Plan mode is still non-mutating from Lidarr's perspective.

Cancellation should be forwarded from the command through evaluation and every producer where the
existing action option supports it. Provider errors during evaluation retain the evaluator's
degraded-slot/refusal semantics; producer errors during sealing retain typed Lidarr errors and the
partial-outcome boundary.

No new SDK or runtime package is justified. Reuse Commander 14, the private generated Lidarr
client, `@rfmedia/common` formatters, and Node primitives already wrapped by the plan engine.

**Confidence**: High. The feature adds orchestration, not a provider capability.

## Integration Points

1. **CLI registration and lazy loading.** Extend
   `packages/rfmedia-cli/src/commands/lidarr-policy.ts` with a `plan` child while preserving the
   parent factory and the no-import-from-`./lidarr.ts` rule. Extend its narrowed lazy action
   interface and export the action from `src/actions/lidarr/index.ts`. Validation stays inside the
   `.action()` `try` block so bad mode/rule values reach the standard redacted failure envelope
   before adapters, clients, schedulers, or the tracking database are constructed.

2. **Evaluation and projection.** `src/actions/lidarr/policy-plan.ts` calls
   `executeLidarrPolicyEvaluate` exactly once. The new pure bridge at
   `src/lib/bridge/policy-plan.ts` accounts for every selected proposal using
   `handoff.producer`, `subject.artistId`, and typed `after` values. It never executes or parses
   `handoff.argv` as authority. Any refusal blocks all producer dispatch in plan mode.

3. **Producer dispatch and scheduler ownership.** Route `artist-profile-assignment` cohorts to
   `executeLidarrArtistProfilePlan` in `src/actions/lidarr/plan-artist-profiles.ts`, passing the
   numeric quality-profile ID as a string. Route `artist-monitoring` cohorts to
   `executeLidarrPlan` in `src/actions/lidarr/plan.ts`, passing the boolean target. Bind each
   producer's `maxBatch` to its cohort size and dispatch sequentially in `POLICY_PRODUCER_IDS`
   order. The wrapper acquires no `resolveLidarrScheduler().runSingle` slot: evaluation and each
   producer already own `local-only` tasks, and nesting can deadlock at concurrency one.

4. **Artifact boundary.** Both producers call `buildLidarrMutationPlanV3` and
   `writeLidarrPlanArtifact` in `src/lib/lidarr/plan-engine.ts`. Keep producer-default paths,
   strict exact-key validation, canonical SHA-256 checksum, private no-overwrite storage, and plan
   version unchanged. Policy evidence and decision keys live only in the policy-plan result, which
   correlates them to the returned `{ planPath, plan }` outcome.

5. **Output boundary.** Extend `src/commands/lidarr-policy-presenter.ts` for review, refusal,
   sealed, and partial human output; reuse `renderMutationPlan` from
   `src/commands/lidarr-mutation-presenter.ts` where compatible. Human output remains stderr.
   JSON/YAML/CSV remain one prose-free envelope on stdout through `src/lib/formatters/index.ts`.
   Root output options are inherited and must not be redeclared.

6. **Apply boundary.** `policy plan` never imports or calls `src/actions/lidarr/apply.ts`. It may
   print a separate next command handled by the existing `lidarr apply` registration in
   `src/commands/lidarr.ts`; that command receives both `--expected-plan-id` and
   `--expected-plan-checksum` from the generated artifact. No `--yes`, `--apply`, mutation body,
   claim, or rollback behavior enters this feature.

7. **Completion parity.** Add `plan`, its options, and `recommend|plan` values to
   `src/lib/shell-completions/bash.ts`, `zsh.ts`, and `fish.ts`, then update
   `src/lib/shell-completions/templates.spec.ts`. These are static integrations; Commander
   registration does not update them automatically.

**Confidence**: High. These paths are the existing seams used by `policy evaluate`, plan/apply,
and the closest composition precedent, `src/actions/lidarr/sync-ratings.ts`.
