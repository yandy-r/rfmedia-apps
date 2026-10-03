<!-- markdownlint-disable MD026 -->

# Pattern & Code Analysis:

<!-- markdownlint-enable MD026 -->

## Executive Summary

Issue #200 should be implemented as one additive `artist-delete` member of the existing strict
`rfmedia.lidarr-plan.v2` registry, not as a direct delete command or a second executor. The current
architecture already supplies deterministic artist selection, canonical plan sealing, secure
artifact I/O, origin pinning, whole-plan preflight, per-entry claims/history, sequential mutation,
bounded reconciliation, human/machine presentation, and completion templates.

Deletion differs from every current artist operation in one important way: absence is its verified
postcondition. The current operation and apply contracts assume `getArtist()` returns a live
`LidarrArtist`, and current HTTP 404 classification does not emit the `"not-found"` code that apply
checks for. Implementation therefore needs an explicit present/absent state and operation-aware
missing-target behavior; merely adding a generated client method and registry switch case would
make safe preflight, verification, and resume impossible.

## Implementation Patterns

- **Stable facade over private generated code**: Add `deleteArtist(artistId, deleteFiles, signal?)`
  to `LidarrClientApi` and `LidarrClient` in
  `packages/rfmedia-cli/src/lib/lidarr/client.ts`. Import and call only generated
  `deleteApiV1ArtistById`; pass `{ path: { id }, query: { deleteFiles,
addImportListExclusion: false }, parseAs: "stream", signal }` through `#executeVoid`. This
  preserves generated ownership of the method, route, and query serialization and transport
  ownership of credentials, origin, redirects, timeout, and response limits.
- **Validate before transport**: Follow `validatePositiveId()` and the existing mutation methods in
  `packages/rfmedia-cli/src/lib/lidarr/client.ts`. Validate a positive safe-integer artist ID and an
  actual boolean before invoking the SDK. The facade accepts one ID, not an array; do not reuse
  `putApiV1ArtistEditor` or generated `deleteApiV1ArtistEditor`.
- **Void mutation response**: Existing editor mutations use `parseAs: "stream"` and
  `#executeVoid`, intentionally ignoring response payloads. The pinned generated contract in
  `packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts` declares the single-artist delete
  response as `200: unknown`, so completion must be established by the later targeted read, not by
  parsing the response.
- **One registry-owned vertical slice**: Extend the discriminated unions in
  `packages/rfmedia-cli/src/types/lidarr-plan.ts`, then add a definition factory and switch case in
  `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`. A definition owns
  canonicalization, risk, entry construction, change detection, summary, payload,
  idempotency-key material, live classification, execution, and verification.
- **Strict additive v2 schema**: Add exact `artist-delete` operation, source, entry, summary, and
  observed-state shapes. Preserve v1 and all existing v2 shapes. Update every operation switch in
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: operation parsing, entry parsing,
  canonicalization, summary canonicalization/validation, risk correlation, and checksum input.
  Existing validators use closed allowlists and reject unknown keys.
- **Deterministic construction**: `buildLidarrMutationPlanV2()` canonicalizes the origin and
  selection, sorts sources by `artistId`, rejects duplicate IDs, enforces `maxBatch`, builds
  definition-owned entries, derives review/summary/risk, computes SHA-256 over canonical JSON, and
  re-validates the result. Preserve `id: "artist:<id>"` and include at least origin, operation kind,
  artist ID, and `deleteFiles` in the idempotency material.
- **Evidence is part of the destructive contract**: Each deletion entry should seal a non-empty,
  terminal-safe `path` and non-negative safe integers for `albumCount`, `trackFileCount`, and
  `sizeOnDisk`. Zero is valid; absent, fractional, negative, unsafe, or malformed values fail
  planning. The operation summary must exactly equal entry totals. This is Lidarr-reported impact,
  not a local filesystem inventory.
- **Reuse the pure selector**: Planning should reuse `selectLidarrArtists()` from
  `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`. It already enforces exactly one of IDs,
  filters, or explicit `all`; ID validity/uniqueness; AND-combined filters; zero-match rejection;
  ascending ID order; and cap rejection without truncation.
- **Fresh snapshot planning**: Mirror
  `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.ts`: resolve only filter catalogs that
  are needed, load one complete fresh artist snapshot, resolve references, select the cohort, map
  evidence-complete sources, build the v2 plan, and atomically write it. Use scheduler tier
  `"local-only"` and `retryAttemptsOverride: 0`.
- **Whole-plan plus just-in-time admission**: `preflightPlan()` in
  `packages/rfmedia-cli/src/actions/lidarr/apply.ts` loads the full current artist snapshot and
  rejects any stale pending target before mutation. `classifyLidarrApplyTarget()` in
  `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts` performs the second targeted
  read immediately before each dispatch. Artist delete must compare path and all three sealed
  statistics fields exactly on both checks; a name change is only a display warning.
- **Sequential attributable execution**:
  `executeLidarrApplyMutations()` in
  `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts` processes entries in sealed
  order and stops admitting later targets when an entry reports an uncertain, stale, or
  non-durable boundary. Keep the delete request non-idempotent at scheduler level and make exactly
  one request per admitted artist.
- **Postcondition reconciliation**: The existing artist flow captures dispatch failure, then runs
  up to three targeted reads with 100 ms between reads
  (`LIDARR_APPLY_RECONCILIATION_ATTEMPTS` and
  `LIDARR_APPLY_RECONCILIATION_DELAY_MS`). For delete, a typed targeted not-found after possible
  dispatch is verified success; a still-present artist is not success; authentication, timeout,
  malformed response, cancellation, or an unclassified transport failure remains inconclusive or
  failed. A lost response followed by authoritative absence can still be recorded as succeeded.
- **Durable result boundary**: Continue using per-entry history in
  `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` and exclusive claims in
  `packages/rfmedia-cli/src/actions/lidarr/apply.ts`. If remote success is verified but claim or
  history persistence fails, return `uncertain`, stop later admission, and require resume.
- **Layered authorization**: Extend the tag-replacement pattern in
  `packages/rfmedia-cli/src/commands/lidarr.ts`,
  `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`, and
  `packages/rfmedia-cli/src/actions/lidarr/apply.ts`. Real artist deletion requires
  `--allow-artist-delete`; `deleteFiles: true` additionally requires `--allow-file-delete`.
  Neither flag implies `--yes`, and interactive confirmation must not bypass either action-layer
  check. Dry-run validates without requiring destructive authority and creates no claim/history.
- **Apply-time Plex follow-up**: Add `--plex-scan` only to `lidarr apply`. After entry work and
  durable history finish, use `resolveOptionalScanAdapter()` from
  `packages/rfmedia-cli/src/lib/adapters/action-helpers.ts` and call one full
  `adapter.scan.trigger()` only when a non-dry-run file-deleting plan has at least one newly
  durable `succeeded` entry with non-zero reviewed file impact. Keep scan status outside the
  sealed plan/checksum/history, and never reclassify or replay a verified deletion because a scan
  is unavailable or fails.
- **Presenter-owned output**: Extend
  `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`, not the action layer. Human
  output goes to stderr and is bounded to 20 rows unless verbose; machine output goes through the
  shared formatter. Preserve exact byte integers in JSON/YAML/CSV and add formatted size only for
  humans.

## Existing Code Structure

- `packages/rfmedia-cli/src/types/lidarr.ts`: Stable command-facing `LidarrArtist` projection.
  `path` and `statistics` are currently optional; statistics contains the four required numeric
  fields plus optional totals/percentages.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts`: Wire guards and frozen domain projections.
  Current statistics guards require finite numbers, but do not require non-negative safe integers;
  destructive evidence needs stricter plan-time validation.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Narrow `LidarrClientApi`, generated SDK imports,
  strict input guards, `#execute` projection path, and `#executeVoid` mutation path.
- `packages/rfmedia-cli/src/lib/lidarr/generated/sdk.gen.ts`: Already contains
  `deleteApiV1ArtistById`; generated files must not be hand-edited.
- `packages/rfmedia-cli/src/lib/lidarr/generated/types.gen.ts`: Declares required numeric path ID,
  optional `deleteFiles`/`addImportListExclusion` booleans, and unknown HTTP 200 response.
- `packages/rfmedia-cli/src/lib/lidarr/transport.ts`: Sole authenticated fetch owner; injects the
  API key, binds the origin, rejects redirects/sensitive query data, composes cancellation and
  timeout, and normalizes failures.
- `packages/rfmedia-cli/src/lib/lidarr/errors.ts`: Lidarr error taxonomy and HTTP status mapping.
  This is a required integration point because targeted deletion verification depends on typed
  not-found.
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`: Pure exact-ID/filter/all selection and
  resource reference resolution.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: Versioned plan, entry, summary, observed state,
  history, failure, apply-result, and outcome contracts.
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: Strict v2 operation registry
  and behavior owner. Current definitions are monitoring, profile assignment, and tag mutation.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: Canonicalization, SHA-256 sealing, exact-key
  parsing, risk/summary/idempotency correlation, private atomic artifacts, history, resume
  selection, and exclusive claims. V1 compatibility remains live alongside v2.
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-profiles.ts` and
  `packages/rfmedia-cli/src/actions/lidarr/plan-artist-tags.ts`: Closest planning-action patterns.
  Both resolve fresh resources and artists, build a strict v2 plan, and write it only after
  validation.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: Apply orchestration: approval, plan/checksum
  pins, origin match, whole-plan preflight, dry-run result, claim acquisition, resume, history,
  summary, and final status.
- `packages/rfmedia-cli/src/actions/lidarr/apply-entry-execution.ts`: Just-in-time target read,
  classification, dispatch/reconciliation entry point, deferred admission behavior, and satisfied
  result persistence.
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-entry-execution.ts`: Captures ambiguous
  artist dispatch results and maps verified/failed/inconclusive reconciliation to durable outcomes.
- `packages/rfmedia-cli/src/actions/lidarr/apply-target-execution.ts`: Sequential loop and
  stop-admission behavior.
- `packages/rfmedia-cli/src/actions/lidarr/apply-deferred-replay*.ts`: Generic deferred-intent
  reconciliation. Artist deletion must not enter or register with this queue.
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`: Public action exports and type exports; add
  the new planning action here.
- `packages/rfmedia-cli/src/commands/lidarr.ts`: Commander hierarchy, reusable artist-selection and
  plan safety options, lazy action imports, output gate, apply review/prompt flow, and process exit
  status.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Human plan/apply tables,
  selection/operation labels, CSV projections, prompt language, and pinned recovery commands.
- `packages/rfmedia-cli/src/lib/shell-completions/bash.ts`,
  `packages/rfmedia-cli/src/lib/shell-completions/zsh.ts`, and
  `packages/rfmedia-cli/src/lib/shell-completions/fish.ts`: Hand-maintained completion templates;
  all three must add `artist-delete`, planning flags, and apply flags.

## Code Conventions

- TypeScript is strict ESM with `.js` extensions in local imports.
- Commands parse Commander values, enforce option conflicts, lazily import actions, and render;
  actions remain Commander-independent and return typed results.
- Use `readonly` interfaces, discriminated unions, `Object.freeze`, and explicit switch
  exhaustiveness. Do not use generated SDK types above the private client boundary.
- Use positive safe integers for stable IDs and non-negative safe integers for counts/bytes. Do
  not coerce missing evidence to zero.
- Canonical arrays are sorted and unique. Plan entries are sorted by stable numeric ID before
  checksum calculation and execution.
- Strict plan objects use `requireRecord`, `requireExactKeys`, `requireBoolean`,
  `requirePositiveInteger`, `requireString`, and `assertNoSensitiveKeys`; unknown keys are rejected
  rather than ignored.
- Plan changes must update both construction and untrusted JSON validation. A value being
  TypeScript-valid is insufficient unless canonicalization, checksum, exact parsing, summary/risk
  correlation, and idempotency validation also accept it.
- Scheduler reads are `idempotent: true`; artist mutations are dispatched `idempotent: false` with
  retry attempts overridden to zero at client resolution.
- Human diagnostics/tables use stderr; structured output uses the shared formatter on stdout.
  Untrusted labels and paths must remain terminal-safe and bounded.
- Tests use Vitest and nearby focused suites. Command tests use hoisted action mocks and
  `vi.clearAllMocks()` rather than `vi.resetAllMocks()`.
- Generated modules remain private and are never hand-edited. Architecture tests enforce no
  upper-layer generated imports, no handwritten `/api/v1/` paths, and one authenticated fetch
  owner.

## Integration Points

1. **Facade contract and tests**
   - Modify `packages/rfmedia-cli/src/lib/lidarr/client.ts`.
   - Extend `packages/rfmedia-cli/src/lib/lidarr/client.test.ts` for exact DELETE method/path/query,
     explicit false/true serialization, empty 200 handling, invalid input before transport, abort,
     and typed failures.
   - Update shared client mocks in
     `packages/rfmedia-cli/src/actions/test-helpers/lidarr-client-mocks.ts` and any structural
     `LidarrClientApi` fixtures.
2. **Not-found contract**
   - Modify `packages/rfmedia-cli/src/lib/lidarr/errors.ts` so authoritative 404 can be recognized as
     `"not-found"` without weakening authentication/authorization/transport classification.
   - Update transport/client/error tests and deletion apply tests. Do not detect absence by message
     text or raw status outside the typed boundary.
3. **Plan domain and registry**
   - Modify `packages/rfmedia-cli/src/types/lidarr-plan.ts`.
   - Modify `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`.
   - Modify `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`.
   - Extend `packages/rfmedia-cli/src/lib/lidarr/plan-engine.test.ts` for strict round trip,
     exact-key rejection, deterministic ordering/checksum, evidence and summary tampering, high-risk
     cascade equality, and unchanged existing operation fixtures.
4. **Planning action**
   - Create `packages/rfmedia-cli/src/actions/lidarr/plan-artist-delete.ts` and its focused test.
   - Export it from `packages/rfmedia-cli/src/actions/lidarr/index.ts`.
   - Reuse the profile/tag selection options and selector logic; reject incomplete path/statistics
     before artifact creation.
   - Add explicit plan dry-run handling so preview creates no artifact. Existing artist profile/tag
     actions always write, while album monitoring already demonstrates a plan-level `--dry-run`
     surface.
5. **Apply state machine**
   - Modify `packages/rfmedia-cli/src/actions/lidarr/apply.ts`,
     `apply-target-types.ts`, `apply-entry-execution.ts`,
     `apply-artist-entry-execution.ts`, and possibly `apply-target-execution.ts`.
   - Add present/absent observed state, operation-aware initial-missing classification, exact
     evidence drift, absence verification, authorization fields, no-deferred behavior, and scan
     result plumbing.
   - Extend `packages/rfmedia-cli/src/actions/lidarr/apply.test.ts` with whole-plan and per-target
     drift, authorization, dry-run side effects, sequential stop, lost response reconciliation,
     missing-target/resume behavior, history/claim failure, and scan eligibility.
6. **Command and presentation**
   - Modify `packages/rfmedia-cli/src/commands/lidarr.ts` to register `artist-delete` in the pinned
     child order, reuse selection/safety options, and add `--delete-files`; add the three apply
     flags.
   - Modify `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts` for operation labels,
     evidence/summary tables, authorization-aware prompt/recovery command, separate scan status, and
     CSV fields.
   - Extend `packages/rfmedia-cli/src/commands/lidarr.test.ts` for hierarchy, conflicts, forwarding,
     layered authority in interactive and non-interactive modes, dry-run, output, and exit status.
7. **Completions and public documentation**
   - Update Bash, Zsh, and Fish templates and their parity/snapshot tests with identical command and
     option coverage.
   - Update `packages/rfmedia-cli/README.md`,
     `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`, and `ROADMAP.md`.
   - Album deletion remains issue #223; do not add album selectors or deletion behavior here.

## Gotchas and Warnings

- **Current 404 handling is incompatible with deletion verification**:
  `classifyLidarrStatus(404)` in `packages/rfmedia-cli/src/lib/lidarr/errors.ts` currently returns a
  `LidarrValidationError` with code `"validation"`, while
  `isNotFound()` in `apply-entry-execution.ts` checks for `"not-found"`. That branch cannot
  currently recognize a normal targeted 404.
- **Current definitions require a live artist**:
  `LidarrMutationOperationDefinition.classifyLive()` and `verify()` accept `LidarrArtist`, not an
  absent state. Do not synthesize a fake artist. Introduce an explicit present/absent observation
  or an operation-owned targeted loader.
- **Initial absence and post-dispatch absence are different**: The authoritative feature spec says
  absence during the initial whole-plan preflight is stale, because this plan cannot prove the
  reviewed file effect. Absence after this plan may have dispatched is success/satisfied only when
  durable attempt evidence supports attribution. Do not globally redefine missing as satisfied.
- **Existing generic reconciliation treats not-found as failure**:
  `reconcileLidarrApplyTarget()` currently returns `failed` when `isNotFound(error)` is true. Make
  this operation-aware; changing it globally would break monitoring/profile/tag expectations.
- **Generic admission failures enqueue retryable work**:
  `persistAdmissionFailure()` currently enqueues every retryable target-read failure. Artist delete
  must never be placed in the deferred queue, and `createLidarrMutationExecutors()` must not
  register a delete executor.
- **Resume currently reconciles generic deferred entries before mutations**: Guard the
  `reconcileLidarrDeferredEntries()` path for `artist-delete`; resume should use sealed plan
  history and targeted reads, never background destructive replay.
- **The apply loop currently rebuilds `executable` from all pending entries before real apply**:
  per-entry classification rechecks satisfied state, but deletion needs explicit history-aware
  missing semantics so an initially absent target is not accidentally treated like an ordinary
  converged mutation.
- **Planning dry-run is not shared by current artist v2 actions**: Profile and tag planning always
  write their artifact after building it. Issue #200 requires a preview that writes no artifact,
  so the result/presenter path must support an in-memory plan without weakening normal no-overwrite
  private artifact creation.
- **Complete statistics require stronger validation than the domain projection**:
  `isLidarrArtistStatistics()` accepts any finite numbers. Destructive evidence must additionally
  require non-negative safe integers, and `path` must be non-empty and terminal-safe.
- **Do not use filesystem paths as local authority**: Lidarr may be remote and its path may not map
  to this host. Do not add `stat`, traversal, manifests, unlink, recursive delete, trash, shell
  commands, realpath checks, or path-scoped Plex deletion verification.
- **Do not infer file deletion from defaults**: Always send `deleteFiles` explicitly and always
  send `addImportListExclusion: false`. Omission of `--delete-files` seals keep-files mode; no
  config or environment default may broaden it.
- **Do not use the bulk editor delete endpoint**: Its unknown batch response cannot attribute
  per-target outcomes or support safe recovery. One artist ID per request is a safety property,
  not merely a performance choice.
- **A successful HTTP response is not completion**: Only the targeted absence read establishes the
  artist postcondition. A timeout/reset after possible dispatch must reconcile before any later
  artist is admitted.
- **Plex intent must not enter the checksum**: `--plex-scan` is runtime follow-up intent. Do not
  store Plex credentials, config, paths, or scan state in the plan or deletion history.
- **Scan failures are isolated**: A missing/failing adapter produces a separate warning/structured
  scan result and must not roll back, reclassify, or make a verified delete eligible for replay.
- **Completion hierarchy is hand-maintained and order-sensitive**: Update command detection,
  operation lists, per-leaf option lists, and apply flags in all three shell generators. The
  command tests also pin child ordering.
- **Research documents contain superseded alternatives**: Early research proposed configurable
  import exclusions, optional missing statistics in keep-files mode, path-scoped Plex scans, and
  differing scan-failure exit semantics. The final `feature-spec.md` is authoritative: exclusion
  is explicitly false, evidence is complete in both modes, scanning is one full-library
  best-effort call, and scan failure stays separate from deletion classification.
