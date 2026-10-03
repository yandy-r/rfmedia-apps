# Integration Research: lidarr-quality-presets

## Integration Summary

The committed Lidarr OpenAPI snapshot already contains all reads and writes required by the frozen
feature spec. Production code must still expose those operations through the handwritten
`LidarrClientApi` facade, project every generated response into bounded generated-independent
types, and add every facade method explicitly to the resilience wrapper. The feature needs no new
database table or migration: correctness state belongs in a hardened filesystem journal and an
origin-scoped filesystem lock, while the existing SQLite resilience cache and circuit state remain
best-effort infrastructure.

## API Endpoints

All generated operations below live in
`packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`; their wire models live in
`packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts`.

| Resource         | Read operations                                                                        | Write operations                                        | Contract implications                                                                                                                                                                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Custom formats   | `getApiV1Customformat`, `getApiV1CustomformatById`, `getApiV1CustomformatSchema`       | `postApiV1Customformat`, `putApiV1CustomformatById`     | Collection responses use `CustomFormatResource[]`; schema is generated as `unknown`. PUT path `id` is typed as `string`, so positive-integer-to-string conversion must stay inside the facade. V1 must not import or call either delete endpoint or bulk mutation endpoint. |
| Quality profiles | `getApiV1Qualityprofile`, `getApiV1QualityprofileById`, `getApiV1QualityprofileSchema` | `postApiV1Qualityprofile`, `putApiV1QualityprofileById` | Profiles contain recursive `items` and `formatItems`; every current custom-format ID must occur exactly once in a write body. PUT path `id` is also generated as `string`. No delete operation is in scope.                                                                 |
| Naming           | `getApiV1ConfigNaming`, `getApiV1ConfigNamingById`, `getApiV1ConfigNamingExamples`     | `putApiV1ConfigNamingById`                              | `getApiV1ConfigNaming` returns the singleton including its positive ID. Example output is generated as `unknown` and is advisory only. PUT path `id` is typed as `string`; verification is a fresh authoritative GET, not examples.                                         |
| Artist impact    | existing `getApiV1Artist` collection through `LidarrClientApi.listArtists()`           | none                                                    | Use the complete unpaged artist read only to count/report assignments to managed profile IDs. Never apply the mutation `maxBatch` limit to this read and never reassign artists.                                                                                            |

The generated resource types are intentionally permissive and nullable. New rich facade projectors
in `packages/rfmedia-cli/src/lib/lidarr/types.ts` must therefore bound collection sizes, recursive
quality nodes, schema fields, custom-format conditions, naming examples, strings, and numbers.
They must reject duplicate positive IDs and normalized names, malformed recursive groups, unknown
dynamic field shapes, non-finite scores, and control-bearing labels. New domain contracts should
live in `packages/rfmedia-cli/src/types/lidarr-presets.ts`; generated types must not escape the
facade.

## Facade and Transport Boundaries

- `packages/rfmedia-cli/src/lib/lidarr/client.ts` is the only handwritten module that should import
  the generated SDK. Extend `LidarrClientApi` with intention-revealing rich methods for schema,
  collection, create, update, singleton naming, and naming examples while preserving the existing
  narrow `listQualityProfiles(): LidarrProfile[]` used by artist assignment.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts` remains the sole authenticated Fetch owner. It
  confines requests to one canonical HTTP(S) origin, rejects embedded credentials and redirects,
  injects `X-Api-Key` only after request validation, composes caller cancellation with the timeout,
  caps success/error bodies, validates UTF-8/JSON, and maps failures to sanitized typed errors.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs` enforces the private-generated and
  single-Fetch-owner boundaries. New action, library, command, and type files must not import
  `lib/lidarr/generated/**` or call Fetch directly.
- `packages/rfmedia-cli/scripts/generate-lidarr-client.mjs` and its contract tests already validate
  the committed generated tree. Extend the required-operation manifest/test list for the newly
  consumed operations; do not refresh the snapshot merely to implement this feature.

The facade should accept domain request bodies, validate exact supported fields and positive IDs,
construct generated bodies privately, execute through the existing `#execute` projector boundary,
and return projected frozen domain objects. Create/update responses must also be projected, but the
action must still perform a fresh collection or by-ID read for authoritative verification.

## Configuration and Credentials

- `packages/rfmedia-cli/src/types/config.ts` currently defines `LidarrConfigOptions` with
  `baseUrl`, `apiKey`, `timeoutMs`, `resilience`, and `scheduler`. Add the generated-independent
  `profilePresets` section here.
- `packages/rfmedia-cli/src/lib/config.ts` reads at most 1 MiB, injects `{{ ENV_VAR }}` values before
  parsing, uses `js-yaml` with `CORE_SCHEMA`, and then validates typed sections. Add an exact-key,
  recursive `lidarr.profilePresets` validator with explicit object-depth, scalar-byte,
  pack/resource/condition, quality-tree, score, and expanded-output limits. The current outer
  Lidarr validator ignores unknown keys, so strictness must be implemented deliberately inside the
  new section without silently changing unrelated legacy config behavior.
- The configured-pack model is local and self-contained. It must not accept URLs, external file
  paths, executable hooks, inheritance, or built-in shadowing. Upgrade direct `js-yaml` as required
  by the frozen spec and retain the pre-parse file-size limit.
- `packages/rfmedia-cli/src/lib/loaded-config.ts` exposes the already validated Lidarr config.
  Offline `list`/`show` may read configured packs from it but must not resolve a client or contact
  Lidarr.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts` resolves CLI overrides over loaded config,
  canonicalizes the URL to an origin with no path/query/fragment/embedded credentials, and creates
  the static header-only API-key provider. `diff` and `apply` should reuse
  `resolveRequiredLidarrOrigin` and `resolveRequiredLidarrExecutionContext`; no credential belongs
  in pack digests, resource keys, lock names, journals, logs, output envelopes, or errors.
- `rfmedia.example.yaml` must demonstrate bounded local configured packs using template syntax only
  for actual secrets. Preset definitions themselves should remain non-secret and reviewable.

## Scheduler and Resilience Integration

`packages/rfmedia-cli/src/lib/lidarr/resilience.ts` is deny-by-default for in-place retries. Add the
new idempotent rich GET method names to `LIDARR_IN_PLACE_RETRY_ALLOWLIST`, but never add create or
update methods. Add every new facade method explicitly to the frozen wrapped object; omitting one
would bypass resilience or fail interface construction.

Use the existing process-wide scheduler from
`packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`:

- Fresh preflight, diff, drift-check, and read-back GETs are `local-only`, `idempotent: true`
  scheduled tasks. Do not request stale fallback; preset decisions must never use cached state.
- POST/PUT work should use the scheduler's serial `destructive` lane with `idempotent: false`. That
  lane has concurrency 1 and retry attempts 0 by default, and `shouldRetry` categorically rejects
  destructive or non-idempotent retries.
- The action must also sequence resources itself: custom formats, refreshed custom-format and
  quality-profile catalogs/schema, quality profiles, then naming. Scheduler concurrency is not a
  substitute for dependency ordering or the origin lock.
- A transport timeout or connection loss after dispatch is not safe to resend. Perform bounded
  fresh stabilization/read-back and classify the outcome satisfied or uncertain; an uncertain
  outcome stops later admissions.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts` may lazily open the existing tracking database
  to persist circuit failures or cache `listArtists`. Such persistence is best effort and a failure
  warns without replacing the live result/error. Preset correctness must not depend on that
  database, stale cache, or deferred-intent queue.

## Filesystem Persistence and Locking

The existing `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` provides the hardened I/O pattern
to reuse: XDG storage under `getDefaultPlanDir()` (overrideable by `RFMEDIA_PLAN_DIR`), owner-only
directories/files (`0700`/`0600`), no-follow opens, bounded reads, parent ownership/mode checks,
device/inode rechecks, temporary-file `fsync`, and atomic link/rename publication.

Do not call `acquireLidarrPlanClaim()` directly for presets. It validates a UUID and locks only one
plan ID, so two different preset applies to the same Lidarr origin could interleave. Add a
preset-specific persistence module, for example
`packages/rfmedia-cli/src/lib/lidarr/profile-preset-persistence.ts`, with:

- an exclusive lock path keyed by `sha256(canonicalOrigin)`, never by raw origin or API key;
- ownership-token/host/PID metadata, ownership revalidation before every write and journal update,
  same-host dead-PID recovery only, and idempotent owner-checked release;
- a bounded secret-free journal under a dedicated directory such as
  `<plan-dir>/lidarr-preset-journal/`;
- atomic full-file replacement after each state transition rather than uncoordinated JSONL append;
- pack source/ID/version/digest, canonical origin, selected before/desired semantic projections,
  ordered per-resource dispatch/verification/outcome state, timestamps, and completion state.

Real apply should acquire the origin lock before its final fresh preflight and hold it until the
terminal journal state is durable. Persist the initial intent before the first dispatch and a
pre-dispatch transition before each remote write. If persistence fails before dispatch, perform no
write. If the remote state verifies but the outcome cannot be persisted, return `uncertain` and
stop. `diff`, `list`, `show`, converged apply, rejected approval, and `apply --dry-run` must create
neither lock nor journal state. The lock coordinates only processes sharing this filesystem;
multi-host coordination remains explicitly unsupported.

Register lock release and admission cancellation with
`packages/rfmedia-cli/src/lib/signal-handler.ts`, following
`packages/rfmedia-cli/src/actions/lidarr/apply.ts`. Interruption must stop new admissions, classify
the in-flight resource with bounded read-back, attempt the terminal journal update, and release
only a still-owned lock.

## Database Schema and No-Database Implications

No new SQLite migration is warranted. `packages/rfmedia-cli/src/lib/schema.sql` currently owns
three Lidarr resilience tables: `lidarr_deferred_intents`, `lidarr_metadata_cache`, and
`lidarr_circuit_state`. None models a global desired-state apply or its filesystem lock, and using
the deferred queue would conflict with the spec's explicit fresh forward-convergence recovery and
no automatic resend after uncertain dispatch.

Consequently:

- do not add preset tables, foreign keys, migrations, or database-path CLI flags;
- do not enqueue preset POST/PUT calls into `lidarr_deferred_intents`;
- treat existing resilience DB writes as non-authoritative, best-effort side effects;
- treat the filesystem journal as the sole durable preset-apply record needed for recovery and
  operator evidence;
- start every rerun from fresh live state rather than replaying a database row or trusting a prior
  diff.

## Internal Service Flow

The intended integration flow is:

```text
commands/lidarr-presets.ts
  -> actions/lidarr/profile-presets.ts
     -> loaded validated lidarr.profilePresets
     -> resolveRequiredLidarrOrigin / execution context / scheduler
     -> profile-preset-persistence origin lock + journal
     -> lib/lidarr/profile-presets.ts pure resolution, validation, bodies, semantic diff
     -> lib/lidarr/client.ts rich facade
     -> generated SDK
     -> hardened transport
     -> Lidarr
```

`packages/rfmedia-cli/src/commands/lidarr.ts` should only register the new subtree and pass shared
global callbacks/options. The new action must not extend
`packages/rfmedia-cli/src/types/lidarr-plan.ts`, plan history, or deferred replay: preset state is
name-resolved global configuration, not a sealed numeric artist/album target.

## Integration Tests and Contract Gates

Critical integration coverage should prove:

1. Facade/generated-contract tests call the exact endpoints, keep string PUT-ID conversion private,
   reject malformed/oversized wire data, and never expose generated types.
2. Resilience tests retry only new GETs and never POST/PUT; scheduler tests/action tests prove
   serial dependency order and zero hot mutation retry.
3. Action tests prove fresh complete preflight, preservation of every unmanaged format score,
   custom-format refresh before profile bodies, drift checks before every write, fresh read-back,
   second-run zero writes, and stop-on-partial/uncertain behavior.
4. Filesystem tests prove canonical-origin mutual exclusion across different pack refs, same-host
   stale-lock recovery, owner-checked release, private permissions, symlink/path-swap rejection,
   bounded journals, atomic durability, and dry-run/no-op zero filesystem writes.
5. Config tests prove strict nested keys and all structural bounds while retaining compatibility
   when `lidarr.profilePresets` is absent.
6. `npm run codegen:lidarr:check`, `npm run check:architecture`, and
   `npm run test:architecture` remain green, confirming generated-client privacy and sole Fetch
   ownership.

## Implementation Constraints

- Do not refresh the generated SDK unless a contract test demonstrates a missing operation.
- Do not use bulk or delete endpoints in v1.
- Do not use cached/stale values to authorize a diff or write.
- Do not log or persist the API key, raw response bodies, or unsanitized server/config text.
- Do not treat scheduler serialization as cross-process locking.
- Do not make SQLite availability a prerequisite for diff, apply, verification, or recovery.
- Do not release the origin lock before every terminal outcome is durably classified.
