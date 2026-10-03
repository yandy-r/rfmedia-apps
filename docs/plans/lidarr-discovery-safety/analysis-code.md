# Code Analysis: lidarr-discovery-safety

## Executive Summary

The shipped discovery path is cleanly separated into Commander parsing and presentation, a
framework-independent action, a fixed-origin Last.fm transport, and an optional sealed
`artist-add` plan handoff. That separation is the correct implementation boundary for #205:
public safety contracts belong in `types/discovery.ts`, deterministic decisions in the new pure
`lib/discovery/policy.ts`, breadth-first provider scheduling in the action, and all mutation in the
existing plan/apply family.

The largest change is not traversal but cardinality. Artist-add is hard-coded as single-entry
through its public types, builder, strict artifact validator, checksum canonicalizer, selection
shape, planner action, whole-plan apply orchestrator, dry-run/resume handling, presenter, and
tests. Preserve the existing per-entry possible-dispatch executor; widen the envelope and
whole-plan orchestration around it so reviewed entries run in visible-rank order and later entries
become `not-attempted` after uncertainty.

## Existing Code Structure

- `packages/rfmedia-cli/src/types/discovery.ts`: generated-independent provider and public result
  contracts. It currently defines only `limit` bounds, a recommendation with `rank` and
  `addEligibility`, a one-rank `LidarrDiscoverHandoff`, and one request/result document
  (`L10-L13`, `L42-L85`, `L88-L134`).
- `packages/rfmedia-cli/src/lib/discovery/lastfm.ts`: sole credential-bearing Last.fm `fetch`
  owner. It fixes the endpoint/method, validates a 1–100 request, bounds response bodies, strictly
  projects name/similarity/MBID/catalogue URL, sanitizes provider errors, and performs one request
  per `getSimilarArtists` call; scheduler retry remains outside this module
  (`L19-L35`, `L39-L107`, `L117-L135`, `L263-L352`).
- `packages/rfmedia-cli/src/actions/lidarr/discover.ts`: current orchestration and runtime
  validation. It validates artist/limit/autocorrect before dependency resolution, schedules one
  `discovery`-lane task, deduplicates/ranks in provider order, and lazily imports planning only
  when one rank was selected (`L24-L47`, `L53-L128`, `L155-L265`).
- `packages/rfmedia-cli/src/commands/lidarr-discover.ts`: Commander leaf plus text and machine
  presentation. It owns integer parsers, conditional handoff grammar, a fixed CSV column list and
  mandatory summary row, and lazy action loading (`L39-L170`, `L172-L238`, `L240-L342`).
- `packages/rfmedia-cli/src/commands/lidarr.ts`: creates the discovery leaf with injected output
  helpers and attaches it to the `lidarr` parent (`L443-L453`, `L1478-L1483`).
- `packages/rfmedia-cli/src/actions/lidarr/index.ts`: lazy-import facade re-export for
  `executeLidarrDiscover`, its bounds, tier, and option type (`L47-L53`).
- `packages/rfmedia-cli/src/actions/lidarr/plan-artist-add.ts`: performs exact-MBID validation
  before I/O, resolves one execution context, reads exact lookup/current presence and all three
  resources in parallel, returns an already-present no-op, or builds and writes one plan
  (`L32-L52`, `L77-L174`).
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: artist-add is a parallel v2 family because its
  target is an expected-absent MBID rather than a present numeric Lidarr ID. It currently seals a
  single `foreign-artist-id` selection, `maxBatch: 1`, a one-entry tuple, literal review counts,
  and `artists: 1` (`L301-L381`).
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts`: artifact construction, exact-key
  validation, canonical checksum projection, history, resume selection, and possible-dispatch
  matching. Artist-add cardinality-one assumptions occur in the builder (`L1322-L1379`),
  canonical selection/summary (`L841-L871`, `L991-L997`), untrusted selection parsing
  (`L1636-L1652`), entry validation (`L2011-L2094`), summary validation (`L2231-L2243`), envelope
  validation (`L2420-L2528`), and history/resume helpers (`L3208-L3271`, `L3330-L3356`).
- `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: owns immutable add policy,
  common resource references, medium/non-destructive risk, non-deferability, and the per-entry
  idempotency key over origin, MBID, resources, and fixed policy (`L460-L536`).
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`: kind-first router. It detects `artist-add`
  before numeric-ID plans and delegates the whole plan to `executeLidarrArtistAddApply`, while
  retaining the shared approval, claim, cancellation, artifact, and result boundary
  (`L133-L135`, `L1020-L1029`, `L1132-L1169`).
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add.ts`: whole-plan add orchestration is
  currently single-entry. `readArtistTarget`, preflight, dry-run, possible-dispatch detection, and
  real execution all read `plan.entries[0]`; real apply calls the per-entry executor once
  (`L48-L114`, `L152-L193`, `L195-L308`).
- `packages/rfmedia-cli/src/actions/lidarr/apply-artist-add-entry-execution.ts`: reusable per-entry
  safety boundary. It rechecks exact MBID, prepares authoritative create input, verifies claim
  ownership, persists `possibly-dispatched`, sends one non-idempotent POST with no retry, and
  reconciles exact MBID; `stopAdmissions` is already returned for uncertain or unsafe outcomes
  (`L79-L124`, `L126-L267`, `L269-L341`, `L344-L510`).
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: kind-first review and apply
  summary presentation; artist-add branches assume the current single target and must be audited
  when the envelope widens.

## Implementation Patterns

- **Command/action separation**: Commander owns lexical parsing, option conflicts, missing
  relationships, and rendering. The action repeats semantic validation on plain runtime inputs
  before config/provider/Lidarr/filesystem access.
- **Pure policy, impure traversal**: put constants, policy resolution, MBID/name identity,
  threshold decisions, exposure scoring, status/reason assignment, stable comparison, and
  selection validation in `lib/discovery/policy.ts`. Keep scheduler calls, breadth-first waves,
  cancellation, and plan handoff in `actions/lidarr/discover.ts`.
- **Immutable generated-independent values**: public types use `readonly` fields and successful
  action results freeze nested objects/arrays. No discovery or plan layer imports private
  generated SDK types.
- **One retry owner**: each Last.fm request must remain one idempotent scheduler task in the
  `discovery` lane. Do not add provider retries. Scheduler operation budgets apply per submitted
  batch/call, so invocation-wide depth/request/visited/visible budgets must be action/policy state
  checked before scheduling each wave.
- **Strict input and artifact allowlists**: CLI parsers reject malformed strings rather than
  coercing them; plan JSON uses exact-key validation, bounded arrays, canonical values,
  recomputed idempotency keys, internally consistent review/summary/selection, and a checksum over
  canonical field order.
- **Preview → sealed intent → apply**: discovery without `--add` never resolves Lidarr. Selected
  ranks may only produce a plan. Only later `lidarr apply` with explicit approval can POST.
- **Kind-first routing**: artist-add is distinguished by `operation.kind`, not structural guesses
  or the shared v2 version. Preserve this rule when its selection/entries widen.
- **Possible-dispatch before non-idempotent I/O**: the entry executor is load-bearing. It persists
  a claim-bound marker before POST and refuses blind replay. Multi-entry orchestration should call
  it unchanged for each admitted entry and honor `stopAdmissions`.
- **Stable machine output**: JSON/YAML use one `{ command, result }` document. CSV always emits a
  summary row, even with zero visible candidates, followed by fixed-column candidate rows. Text
  writes to stderr and machine formats to stdout.

## Integration Points

### Discovery policy and traversal

- Add all public defaults and hard maxima to
  `packages/rfmedia-cli/src/types/discovery.ts`: threshold `0`, per-seed `10/100`, depth `1/2`,
  visited/request budget `25`, visible budget `100`, weights `0..1`, and approved-add `1/25`.
  Command parsing, action validation, result types, docs, and completion hints must import these
  constants rather than repeat numbers.
- Replace `rankRecommendations` in `actions/lidarr/discover.ts`. Its current identity is NFC but
  case-sensitive (`L92-L100`), seed comparison is name-only, and duplicate suppression discards
  path evidence (`L102-L128`). The new policy needs canonical lowercase MBID first, then a
  provider-scoped NFC/case-normalized name fallback, first-seen provenance, exposure increments,
  and deterministic final sorting.
- Use explicit breadth-first wave queues. Insert the initial seed identity before its request;
  admit a candidate identity to the invocation-wide visited set before enqueueing it so two
  parents in the same wave cannot schedule it twice. One-hop mode never enqueues candidates.
- Apply raw-similarity threshold before `maxPerSeed`. Enforce per-seed, visible, visited/request,
  fixed-depth, and cancellation bounds before enqueuing or scheduling new work. Exposure updates
  for duplicate paths must not consume another visible row or request.
- Preserve `similarity`; add a separate clamped `adjustedScore` and stable ordering:
  adjusted descending, raw descending, depth ascending, first-seen sequence ascending, normalized
  name ascending. “Popularity” output must say `graph-exposure`, never imply listeners/play count.
- Decide and document how multiple provider-call timestamps/execution attempts collapse into the
  existing singular `source` and `execution` fields. The current action exposes only the initial
  request's source and one scheduler execution object. Per-entry plan provenance must use the
  timestamp/path belonging to that candidate, not blindly the initial seed timestamp.

### CLI grammar and presentation

- Extend `createLidarrDiscoverCommand` in design order with
  `--min-similarity`, `--max-per-seed`, `--deep`, `--no-cascade`,
  `--diversity-boost`, `--popularity-dampening`, `--max-add`, then widened
  `--add <ranks>`, followed by the existing conditional resource options.
- Add strict parsers for bounded finite decimals, positive safe integers, and comma-separated
  positive ranks. Reject whitespace/empty elements, signs, non-canonical numeric spellings as
  appropriate, duplicate ranks, more than `maxAdd`, and conflicts before the dynamic action
  import. Commander negated options surface as `cascade === false`; explicitly conflict that with
  `deep`.
- `--max-add` is legal without `--add`. Resource/connection/plan-file options remain illegal
  without `--add`, and the first four resource fields remain required when `--add` is present.
  Machine formats do not prompt; ranks are the only discovery approval.
- Widen `LidarrDiscoverResult` and `LidarrDiscoverHandoff` to report resolved policy, hard bounds,
  traversal counts, candidate status/reason/eligibility/provenance/exposure/raw/adjusted score,
  and aggregate approved/already-present/planned/failed counts.
- Update `LIDARR_DISCOVER_CSV_COLUMNS`, `handoffCsvFields`,
  `recommendationCsvFields`, `projectDiscoverCsv`, and `renderDiscover` together. Retain the
  mandatory attributed CSV summary row and fixed column order.

### Multi-entry plan construction

- Change `LidarrArtistAddPlanActionOptions` from one recommendation to selected recommendations in
  visible-rank order. Validate every rank/MBID before resolving origin/context or performing any
  I/O.
- Resolve root folder, quality profile, and metadata profile once. For each selected candidate,
  perform fresh exact `lidarr:<mbid>` lookup and current-library lookup. Do not write until every
  selected candidate is either exactly resolved or classified already present; one invalid or
  ambiguous target must produce no partial plan.
- Return aggregate classification rather than the current mutually exclusive single
  `plan-created | already-present`. If all selected artists already exist, write no plan. Otherwise
  build one plan containing only still-addable entries and set `maxBatch` to that count, bounded
  by resolved `maxAdd`.
- Preserve provenance independently per entry, including original seed/path, depth, raw
  similarity, source URL, and discovery timestamp. The existing provenance type has only
  `seedArtist`, `similarity`, URL, and timestamp (`types/lidarr-plan.ts:L320-L328`) and must widen
  compatibly.
- To keep previously written one-entry v2 artifacts and checksums valid, retain the existing
  `foreign-artist-id` selection as a legacy accepted variant and add a deterministic multi-ID
  selection variant for new multi-entry artifacts. Exact-key validation and canonicalization must
  support both. Reinterpreting the old selection shape would invalidate historical checksum
  fixtures.
- Generalize `BuildLidarrArtistAddPlanV2Input.entry` to a bounded non-empty `entries` array (or add
  a new multi builder and keep the old wrapper). Remove literal-one assumptions:
  `maxBatch`, tuple entry type, review counts, summary count, selection match, `index !== 0`, and
  validation at `plan-engine.ts:L1322-L1379`, `L2019-L2021`, `L2238-L2242`,
  `L2483-L2492`, and `L2517-L2527`.
- Do not sort add entries by MBID if the design requires visible-rank order. Validate uniqueness
  with a `Set` while retaining input order; canonical selection IDs must match entry order.

### Multi-entry apply

- Refactor `apply-artist-add.ts` around `pending`, not `entries[0]`. Preserve
  `selectLidarrResumeEntries`, which already filters each entry by latest durable
  succeeded/satisfied history.
- Run common resource preflight once for newly dispatchable entries. Run exact-MBID target
  classification for every pending entry. Dry-run must emit one result per plan entry, including
  `skipped-resume`, `satisfied`, `would-apply`, and possible-dispatch uncertainty.
- For real apply, iterate in sealed entry order and call `executeLidarrApplyEntry` once per entry.
  Determine `resumePossibleDispatch` separately for each entry. When an entry returns
  `stopAdmissions`, append `not-attempted` results for every later pending entry and stop.
- A mixed resume needs special ordering: possible-dispatch reconciliation must occur before stale
  resource admission for that entry, as the current single-entry behavior guarantees
  (`apply-artist-add.ts:L68-L77`). If reconciliation remains uncertain, stop. If it resolves and
  later fresh dispatches remain, then perform the common resource preflight before those POSTs.
- Sort/finalize results back into sealed plan order and aggregate status/counts. Keep one exclusive
  plan claim for the whole real apply and one per-entry history identity/idempotency key.
- No change is required to generated Lidarr code or the actual per-entry create/reconcile
  algorithm unless its argument type changes.

### Exports, docs, roadmap, and validation

- Re-export new discovery types/constants through
  `packages/rfmedia-cli/src/types/index.ts` and keep action exports in
  `packages/rfmedia-cli/src/actions/lidarr/index.ts`.
- Update all public surfaces together:
  `packages/rfmedia-cli/docs/features/lidarr-discovery.md`,
  `packages/rfmedia-cli/docs/features/lidarr-plan-apply.md`,
  `packages/rfmedia-cli/docs/features/lidarr-execution-lanes.md` if invocation-budget semantics
  change, `packages/rfmedia-cli/README.md`, and `packages/rfmedia-cli/CHANGELOG.md`.
- `ROADMAP.md` currently lists #205 first in Sprint 1 (`L47-L57`) and in remaining Phase C work
  (`L188-L194`). On completion, remove it from live/open sequencing and update the Layer 2 summary.
  Add #205 and its actual merged PR/date to `docs/roadmap-archive.md`; its #203 note currently says
  threshold and multi-add policy remain open (`L72-L77`), which must change.
- Required package gates from `packages/rfmedia-cli/package.json` are focused Vitest, full
  `test:run`, `typecheck`, `build`, architecture tests/check, and offline Lidarr codegen check/test.
  The root delivery workflow may add monorepo lint/build/coverage gates.

## Code Conventions

- TypeScript is strict ESM/NodeNext; internal imports include `.js`.
- Do not use `any`; use discriminated unions, type guards, and exhaustive switches.
- Exported functions need JSDoc and immutable return contracts.
- Validate before side effects and use repository error classes such as
  `LidarrValidationError`/`LidarrPlanValidationError`.
- Secrets must not enter identities, policy state, output, plan artifacts, errors, logs, task IDs,
  or URLs. Preserve `redactErrorMessage` around handoff failures.
- Use `Object.freeze` consistently for resolved policy, decisions, candidate rows, arrays,
  traversal summaries, and handoff results.
- Tests use Vitest, `vi.hoisted()` module seams, and `vi.clearAllMocks()` so mock
  implementations survive. Temporary plan files use `mkdtemp` and `afterEach` cleanup.
- Preserve kind-first routing comments where structural overlap can misroute v2 plan families.

## Dependencies and Services

- No new runtime package is needed. Node 22 supplies `AbortSignal`, Unicode normalization,
  `URL`, `fetch`, and numeric primitives.
- Last.fm remains the only discovery provider and the sole provider credential lives under
  `discovery.lastfm.apiKey`; no CLI key flag, provider cache, stale fallback, or generated client
  change belongs to this feature.
- `resolveLidarrScheduler()` supplies the process-wide `discovery` lane (default concurrency 4,
  operation budget 100, two retries) and the apply/read lanes. Invocation budgets must layer above
  it rather than modifying scheduler global policy.
- Optional planning uses the handwritten Lidarr facade/execution context. Upper layers must not
  import `lib/lidarr/generated/**` or handwrite `/api/v1/` requests.
- Artifact and history persistence remain in `lib/lidarr/plan-engine.ts`; no database migration is
  required because quarantine is invocation-scoped.

## Gotchas and Warnings

- The design says visited-seed/request budget `25`. Treat it as one invocation-wide admission
  budget and define whether the initial seed consumes both counters; do not let per-wave
  `runSingle` calls reset it.
- Current name identity is NFC and case-sensitive. Merely moving it into policy would not satisfy
  MBID-first provider-scoped case-normalized loop prevention.
- Thresholding must use raw similarity. Applying threshold after adjusted ranking would let weights
  admit a candidate the policy rejected.
- `maxPerSeed` is after thresholding but before visible admission/enqueue. Applying it to the raw
  provider prefix changes results when early candidates are filtered.
- Duplicate paths are evidence, not rows. They must increment exposure and potentially change
  adjusted rank without creating another provider request.
- If final ranking happens only after traversal, selected visible ranks must refer to that final
  immutable list. Never select while a later exposure update can reorder it.
- `LastFmSimilarArtistResult.source.fetchedAt` is per request, while the public result currently has
  one source object. Deep traversal needs an explicit aggregation/provenance rule.
- A planning error must preserve the complete attributed preview in the same machine document and
  set exit code only after output. The current command already does this for one handoff failure.
- Multi-target preflight cannot use one global `resumePossibleDispatch` boolean. Doing so can
  either block safe reconciliation on resource drift or skip required resource checks for later
  fresh POSTs.
- Existing single-entry plan bytes/checksums and history files are compatibility contracts. Do not
  change canonical serialization of the legacy selection or single-entry fields.
- `plan.entries` currently enforces numeric target sorting for other families but special-cases
  artist-add entry zero. Multi-add must add foreign-ID duplicate checking without accidentally
  imposing MBID sort over visible-rank order.
- “Already present” selections are not plan entries. Ensure `maxBatch`, plan review, summary, and
  selection describe only addable entries while discovery handoff separately reports all approved
  ranks.
- Do not prompt in JSON/YAML/CSV mode and do not add `--yes` or direct creation to discover.
- Static completions must not execute config, scheduler, client, or fetch work.

## Task-Specific Guidance

1. Define the public policy/decision/traversal/handoff contracts and constants first in
   `types/discovery.ts`; re-export them.
2. Implement and exhaustively unit-test the pure `lib/discovery/policy.ts` before changing the
   action. Cover bounds, MBID/name identity, threshold-before-cap, duplicate exposure, score
   clamping, stable ties, quarantine, eligibility, and multi-rank validation.
3. Refactor discovery into a bounded breadth-first wave loop using the pure module. Prove ordinary
   defaults still make exactly one provider call and zero Lidarr/filesystem calls.
4. Extend Commander grammar and all four renderers/projections. Test invalid combinations before
   lazy action import and verify one coherent text/JSON/YAML/CSV contract.
5. Widen artist-add plan types, builder, strict validator, canonical checksum projection,
   selection matching, summary/review counts, and compatibility tests as one atomic change.
6. Refactor the planner to validate all ranks first, resolve common resources once, classify every
   MBID, and perform one final artifact write only after complete success.
7. Refactor whole-plan artist-add apply around the existing per-entry executor. Add focused tests
   for two successful entries, mixed already-present/addable planning, dry-run/resume, and
   uncertainty on entry one causing entry two to be `not-attempted`; retain the existing
   single-entry reconciliation suite.
8. Update `bash.ts`, `zsh.ts`, and `fish.ts` in the exact same order. Extend
   `templates.spec.ts` option/value arrays and retain file semantics for `--plan-file`, numeric
   value semantics for thresholds/counts/weights/ranks, and no-side-effect assertions.
9. Update docs, changelog, and live/archive roadmap only after behavior is fixed. Use the actual
   merged PR/date and re-check current issue totals rather than copying stale counts.
10. Run focused tests first, then the package's full test/typecheck/build/architecture/codegen
    gates and repository-level validation required by CI.
