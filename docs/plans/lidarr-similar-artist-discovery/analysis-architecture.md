# Architecture Analysis: lidarr-similar-artist-discovery

## Executive Summary

Issue #203 is two deliberately separated vertical slices. Read-only discovery fits the existing
Commander sibling-command → lazy action → process-wide scheduler pattern, but it must introduce an
independent Last.fm transport and must never resolve a Lidarr client. The optional add handoff is
substantially deeper: the current v2 plan/apply system assumes present, numeric Lidarr targets, while
`artist-add` starts from expected absence and a MusicBrainz ID. Implement it as an explicit
foreign-ID plan/apply branch with pre-dispatch history and MBID read-back reconciliation, not as a
special case of an existing artist editor operation.

## Architecture Context

### Read-only discovery data flow

```text
cli.ts preAction (load/template-resolve config)
  -> commands/lidarr.ts registers commands/lidarr-discover.ts
    -> validate artist/limit/add option grammar before lazy action import
      -> actions/lidarr/discover.ts
        -> resolveLidarrScheduler().runSingle("discovery", idempotent task)
          -> lib/discovery/lastfm.ts (sole Last.fm fetch owner)
            -> fixed GET https://ws.audioscrobbler.com/2.0/
          -> validate complete bounded response
          -> remove seed, deduplicate, preserve provider order, assign visible ranks
        -> immutable LidarrDiscoverResult
      -> text table/footer or stable JSON/YAML/CSV projection
```

`resolveLidarrScheduler()` reads only optional `lidarr.scheduler` policy and is safe with an empty
Lidarr configuration. Discovery must use that scheduler directly; calling
`resolveRequiredLidarrExecutionContext()` would incorrectly require Lidarr credentials and attach
Lidarr health, circuit, and cache behavior. The new Last.fm client should accept the already
resolved `discovery.lastfm` configuration, combine caller cancellation with its own timeout, reject
redirects, bound bytes before JSON parsing, and expose only strict provider-independent values.

The closest command pattern is `commands/lidarr-search.ts`: a sibling factory avoids an ESM cycle,
validates before the dynamic action import, injects parent-owned output/failure helpers, emits one
CSV summary row before result rows, and keeps human output on stderr. The discovery failure path
must widen the parent command's structural error reader rather than import a provider error class.

### Add-plan and apply data flow

```text
validated discovery result
  -> select exactly one visible rank
  -> require canonical MBID
  -> actions/lidarr/plan-artist-add.ts
    -> resolve canonical Lidarr origin
    -> metadata-dependent scheduled fresh reads:
       exact artist lookup + complete artist list + root/profile catalogs
    -> already present by MBID => satisfied handoff, no artifact
    -> resolve unique root/profile references
    -> build one strict v2 artist-add entry keyed by MBID
    -> writeLidarrPlanArtifact() (private, sealed, atomic, no overwrite)

later: lidarr apply
  -> validate checksum/version/origin and acquire exclusive plan claim
  -> re-read library/resources and classify expected absence
  -> persist possible-dispatch evidence before POST
  -> metadata-dependent, non-idempotent, non-deferable addArtist()
  -> read back complete artist state by MBID
  -> succeeded / satisfied / uncertain history and machine result
```

The generated snapshot already contains `getApiV1Rootfolder` and `postApiV1Artist`; generated files
must remain untouched. `lib/lidarr/client.ts` is the only permitted importer and must construct the
writable artist body from an authoritative exact Lidarr lookup plus the sealed root/profile policy.
The public facade needs narrow `listRootFolders` and `addArtist` methods plus strict domain
projectors. The resilience wrapper must forward both methods, with `addArtist` excluded from every
in-place retry allowlist.

The existing apply pipeline cannot consume this operation unchanged. Its core types, history,
failure `targetIds`, sorting, preflight, and dispatch paths assume `artistId: number` and an already
present artist. Add a parallel artist-add variant keyed by `foreignArtistId`, then route on
`plan.operation.kind` before structural/numeric narrowing, following the repository's existing
kind-first routing for album variants. Reuse the artist-delete possible-dispatch pattern, but do not
reuse deletion's absence semantics: after a possibly dispatched create, presence of the exact MBID
proves success; absence remains inconclusive and must not trigger an automatic resend.

## Critical Files Reference

- `packages/rfmedia-cli/src/commands/lidarr.ts`: Parent namespace, shared output/failure redaction,
  lazy action boundary, and subcommand registration.
- `packages/rfmedia-cli/src/commands/lidarr-search.ts`: Best sibling-factory model for validation,
  text/machine presentation, CSV summary rows, and cycle avoidance.
- `packages/rfmedia-cli/src/actions/lidarr/search.ts`: Best scheduled read-action model; do not copy
  its Lidarr execution-context or cache resolution into provider discovery.
- `packages/rfmedia-cli/src/lib/lidarr/scheduler.ts`: Discovery bulkhead, cancellation/backoff, and
  currently `LidarrError`-only classification/retry logic that must accept a narrow structural
  scheduled error contract.
- `packages/rfmedia-cli/src/lib/lidarr/index.ts`: Process-wide scheduler resolver and the boundary
  proving scheduler use does not require a Lidarr client.
- `packages/rfmedia-cli/src/types/config.ts`, `packages/rfmedia-cli/src/lib/config.ts`, and
  `packages/rfmedia-cli/src/lib/loaded-config.ts`: Top-level discovery configuration, validation,
  eager template resolution, recursive secret redaction, and loaded-config access.
- `packages/rfmedia-cli/src/lib/discovery/lastfm.ts` (new): Sole fixed-origin Last.fm fetch owner,
  bounded decoder/projector, and provider failure mapper.
- `packages/rfmedia-cli/src/types/discovery.ts` (new): Generated-independent public result,
  attribution, recommendation, and handoff contracts.
- `packages/rfmedia-cli/src/lib/lidarr/client.ts`: Sole generated-client importer; add root-folder
  projection and artist-create body/response boundary here.
- `packages/rfmedia-cli/src/lib/lidarr/types.ts` and
  `packages/rfmedia-cli/src/types/lidarr.ts`: Strict domain projections for root folders and exact
  artist-add input/output.
- `packages/rfmedia-cli/src/lib/lidarr/resilience.ts`: Exhaustive `LidarrClientApi` wrapper; new
  methods must be forwarded and create must remain non-retried.
- `packages/rfmedia-cli/src/lib/lidarr/artist-selection.ts`: Existing exact ID/name resolution and
  ambiguity behavior to reuse or generalize for root/profile references.
- `packages/rfmedia-cli/src/types/lidarr-plan.ts`: v2 operation/entry/selection, observed state,
  history, apply failure, and result unions; numeric-target assumptions are concentrated here.
- `packages/rfmedia-cli/src/lib/lidarr/plan-engine.ts` and
  `packages/rfmedia-cli/src/lib/lidarr/plan-operation-definitions.ts`: Exact-key validation,
  canonicalization, checksums, idempotency keys, operation registry, strict artifact I/O, and
  exhaustive operation switches.
- `packages/rfmedia-cli/src/actions/lidarr/apply.ts`,
  `apply-target-types.ts`, and `apply-artist-entry-execution.ts`: Origin/approval/claim gates,
  live-state classification, dispatch, reconciliation, history, resume, and uncertainty handling.
- `packages/rfmedia-cli/src/actions/lidarr/apply-resources.ts`: Apply-time stable resource
  revalidation; must include root-folder references for artist-add.
- `packages/rfmedia-cli/src/commands/lidarr-mutation-presenter.ts`: Exhaustive human/CSV plan and
  apply rendering for the new operation and foreign target.
- `packages/rfmedia-cli/src/lib/shell-completions/{bash,zsh,fish}.ts` and
  `templates.spec.ts`: Static completion surfaces and exact cross-shell parity contract.
- `packages/rfmedia-cli/scripts/check-direct-plex-imports.mjs`: Architecture scanner enforcing
  generated imports, fetch ownership, handwritten paths, and mutation ownership.
- `packages/rfmedia-cli/src/lib/lidarr/generated-contract.test.ts`: Assert the already-generated
  artist-create and root-folder operations; do not regenerate or edit generated source.

## Cross-Cutting Concerns

- **Secret lifecycle**: Last.fm requires a query parameter, so errors, causes, request objects,
  debug output, URLs, plans, histories, and cache identities must never retain the key. Extend
  command-boundary redaction tests for `api_key`, not just `apiKey`/`token`.
- **Eager configuration gotcha**: `loadConfig()` injects every `{{ VAR }}` before parsing and before
  leaf execution. An unresolved Last.fm template can therefore fail unrelated commands even though
  discovery is optional. Preserve existing behavior consciously or add a narrowly designed lazy
  credential seam; do not claim invocation-only requirement without testing this interaction.
- **Trust boundaries**: Validate the complete Last.fm body atomically before ranking. Candidate
  names, MBIDs, similarities, resolved seed metadata, and catalogue URLs all cross an untrusted
  boundary; one malformed member invalidates the response.
- **Retry ownership**: The scheduler is the only retry loop. Provider errors are structurally
  classified and retryable only for idempotent discovery-lane tasks. Artist creation is
  metadata-dependent, non-idempotent, non-deferable, and never automatically retried.
- **Cancellation**: One signal must cover queue admission, retry delay, fetch, bounded body read,
  add planning reads, apply dispatch, and reconciliation. Abort is not a provider failure and must
  not start add planning.
- **Plan integrity**: Keep v2's exact-key validation, canonical checksum, origin binding, immutable
  policy, private atomic no-overwrite write, and old-binary fail-closed behavior. No API key or raw
  provider payload belongs in the artifact.
- **Attribution/output**: Text, JSON, YAML, and CSV must all preserve Last.fm provider, method,
  attribution, source URL, fetch time, seed resolution, execution metadata, and handoff state.
  Empty discovery still emits a CSV summary row; optional fields are omitted rather than `null`.
- **Architecture enforcement**: Extend the scanner with a distinct Last.fm fetch owner and an
  `addArtist` mutation-owner rule without weakening the existing single Lidarr transport/generated
  importer rules.
- **Compatibility surface**: `LidarrClientApi`, resilience mocks, action barrels, public type
  barrels, all exhaustive operation switches, command tests, and completion parity tests must move
  together.

## Parallelization Opportunities

1. **Provider foundation**: Implement discovery config/types, Last.fm transport/projection, and
   scheduler structural error support. This stream owns no plan/apply files.
2. **Lidarr facade foundation**: Add root-folder and artist-create domain projections, facade
   methods, resilience forwarding, generated contract assertions, and scanner rules. It can proceed
   in parallel with provider work.
3. **Plan/apply operation**: After facade contracts settle, add the dedicated v2 artist-add plan
   variant, producer, apply preflight/dispatch/reconciliation/history, and presenter support. Keep
   one owner for `types/lidarr-plan.ts`, `plan-engine.ts`, and `apply.ts` because their exhaustive
   unions are tightly coupled.
4. **CLI and presentation**: Once `LidarrDiscoverResult` is stable, implement the sibling command,
   CSV projection, human rendering, parent registration, Bash/Zsh/Fish templates, and parity tests.
5. **Release hardening**: Documentation, examples, changelog, ROADMAP/archive, architecture/codegen
   checks, and full-suite validation can follow the merged behavioral contracts.

Avoid parallel edits to `commands/lidarr.ts`, `types/lidarr-plan.ts`, `plan-engine.ts`,
`apply.ts`, and `templates.spec.ts`; each is a high-conflict aggregation point.

## Implementation Constraints

- Ordinary discovery must perform zero Lidarr resolution/calls and must not use Lidarr resilience,
  metadata cache, health gates, breakers, or deferred queues.
- Keep Last.fm production origin, method, redirect policy, and HTTPS scheme constant; no endpoint
  or provider selector enters configuration.
- Validate artist input, limit, add rank, and add-option grammar before lazy action import and
  scheduler/provider/Lidarr work. Commander still runs the repository-wide config preAction hook.
- The normal path is exactly one `artist.getSimilar` request; no seed search/info preflight and no
  provider cache are in #203.
- Rank is computed only after full validation, seed removal, MBID-first/conservative dedupe, and
  provider-order preservation. `--add` selects that visible rank, not an unfiltered index.
- A selected MBID-less candidate remains a successful discovery result but must fail the handoff
  before any Lidarr I/O.
- Planning must read exact lookup, complete library, root folders, quality profiles, and metadata
  profiles fresh, resolve references uniquely, and write no artifact when already present or when
  any reference is missing/ambiguous.
- Construct the artist-create DTO only in `client.ts` from authoritative Lidarr lookup data plus
  sealed `monitored=false`, `monitorNewItems="none"`, and
  `searchForMissingAlbums=false` policy. Never cast a Last.fm object to a generated DTO.
- Route `artist-add` before current numeric artist narrowing. Existing history/results/failure
  shapes require a parallel foreign-ID variant; do not invent a fake Lidarr ID or overload `0`.
- Persist possible-dispatch evidence while the apply claim is owned and before POST. After an
  ambiguous dispatch, exact MBID read-back may prove success; otherwise emit uncertainty and stop
  admissions. Never enqueue or automatically resend artist creation.
- Preserve the existing v2 discriminator. Unknown `artist-add` operations must remain rejected by
  older validators, while existing v1/v2 artifacts continue to validate byte-for-byte.
- Do not edit the committed generated client. Extend only requirement/contract assertions for the
  endpoints already present.
- Audit Bash, Zsh, and Fish together. The exact discovery options are `--artist`, `--limit`,
  `--no-autocorrect`, and the conditional add-plan options; there is no `--lastfm-api-key`,
  `--yes`, `--dry-run`, stale flag, or future-provider option.
